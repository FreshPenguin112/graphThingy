/**
 * Ahead-of-time compilation of simple scalar MathJSON to plain JavaScript.
 *
 * Compute Engine's compiled functions are fast, but a native arrow function is
 * well-understood subset is translated. Anything else returns null and the caller
 * keeps using Compute Engine.
 *
 * Contract: the generated function is only trusted for FINITE results. A NaN or
 * Infinity (complex result, division by zero, sqrt of a negative, ...) is treated
 * as "unknown" by the caller, which then evaluates that point with Compute Engine,
 * so edge-case behaviour is exactly what it was before.
 */

const UNARY = {
  Sin: "Math.sin", Cos: "Math.cos", Tan: "Math.tan",
  Exp: "Math.exp", Ln: "Math.log", Sqrt: "Math.sqrt",
  Abs: "Math.abs", Floor: "Math.floor", Ceiling: "Math.ceil",
  Arctan: "Math.atan", Arcsin: "Math.asin", Arccos: "Math.acos",
  Sinh: "Math.sinh", Cosh: "Math.cosh", Tanh: "Math.tanh",
};
const NARY = { Min: "Math.min", Max: "Math.max" };
const SYMBOLS = { x: "x", y: "y", Pi: "Math.PI", ExponentialE: "Math.E" };
const MAX_EXPANSION_NODES = 512;
const SUPPORTED = new Set([
  "Rational", "Add", "Multiply", "Subtract", "Divide", "Negate", "Delimiter",
  "Power", "Mod", "Equal", "Which",
  ...Object.keys(UNARY), ...Object.keys(NARY),
]);

function expandFunctions(node, functions, constants, stack, budget) {
  budget.remaining--;
  if (budget.remaining < 0) throw new Error(`User-function expansion exceeds ${MAX_EXPANSION_NODES} MathJSON nodes.`);
  if (typeof node === "string" && constants.has(node)) return constants.get(node);
  if (!Array.isArray(node)) return node;
  const operator = node[0];
  const definition = functions.get(String(operator));
  if (!definition) {
    const expanded = [operator];
    for (let index = 1; index < node.length; index++) {
      expanded.push(expandFunctions(node[index], functions, constants, stack, budget));
    }
    return expanded;
  }
  const name = String(operator);
  if (stack.includes(name)) throw new Error(`Recursive user function "${name}" cannot be compiled.`);
  const argumentCount = node.length - 1;
  if (!Array.isArray(definition.args) || definition.args.length !== argumentCount) {
    throw new Error(`User function "${name}" expects ${definition.args?.length ?? "a known number of"} arguments, received ${argumentCount}.`);
  }
  if (definition.body === undefined) throw new Error(`User function "${name}" has no compilable body.`);
  const bindings = new Map();
  for (let index = 0; index < argumentCount; index++) {
    bindings.set(definition.args[index], expandFunctions(node[index + 1], functions, constants, stack, budget));
  }
  const substitute = (part) => {
    budget.cloneRemaining--;
    if (budget.cloneRemaining < 0) throw new Error(`User-function expansion exceeds ${MAX_EXPANSION_NODES} MathJSON nodes.`);
    if (typeof part === "string" && bindings.has(part)) return bindings.get(part);
    if (!Array.isArray(part)) return part;
    const cloned = [part[0]];
    for (let index = 1; index < part.length; index++) cloned.push(substitute(part[index]));
    return cloned;
  };
  return expandFunctions(substitute(definition.body), functions, constants, [...stack, name], budget);
}

function unsupportedReason(node) {
  if (typeof node === "string") {
    if (Object.hasOwn(SYMBOLS, node) || node === "True" || node === "False") return null;
    return `Symbol "${node}" is not supported by the native scalar compiler.`;
  }
  if (!Array.isArray(node)) return null;
  const operator = String(node[0]);
  if (!SUPPORTED.has(operator)) return `Operator "${operator}" is not supported by the native scalar compiler.`;
  for (const child of node.slice(1)) {
    const reason = unsupportedReason(child);
    if (reason) return reason;
  }
  return null;
}

/** Returns a JS expression string for `node`, or null if it is outside the subset. */
function emit(node) {
  if (typeof node === "number") return Number.isFinite(node) ? `(${String(node)})` : null;
  if (typeof node === "string") {
    if (Object.hasOwn(SYMBOLS, node)) return SYMBOLS[node];
    if (node === "True") return "true";
    if (node === "False") return "false";
    return null;
  }
  if (!Array.isArray(node)) return null;
  const [op, ...args] = node;
  const parts = args.map(emit);
  if (parts.some((part) => part === null)) return null;
  switch (op) {
    case "Rational": {
      const [a, b] = args;
      return typeof a === "number" && typeof b === "number" && b !== 0 ? `(${a}/${b})` : null;
    }
    case "Add": return parts.length ? `(${parts.join("+")})` : null;
    case "Multiply": return parts.length ? `(${parts.join("*")})` : null;
    case "Subtract": return parts.length === 2 ? `(${parts[0]}-${parts[1]})` : null;
    case "Divide": return parts.length === 2 ? `(${parts[0]}/${parts[1]})` : null;
    case "Negate": return parts.length === 1 ? `(-${parts[0]})` : null;
    case "Delimiter": return parts.length === 1 ? parts[0] : null;
    case "Mod": {
      if (parts.length !== 2) return null;
      return `((_a,_b)=>((_a%_b)+_b)%_b)(${parts[0]},${parts[1]})`;
    }
    case "Equal": return parts.length >= 2 ? `(${parts.slice(1).map((part) => `${parts[0]}===${part}`).join("&&")})` : null;
    case "Which": {
      if (parts.length < 2 || parts.length % 2 !== 0) return null;
      let result = "NaN";
      for (let index = args.length - 2; index >= 0; index -= 2) {
        result = args[index] === "True" ? parts[index + 1] : `(${parts[index]}?${parts[index + 1]}:${result})`;
      }
      return result;
    }
    case "Power": {
      if (parts.length !== 2) return null;
      return `Math.pow(${parts[0]},${parts[1]})`;
    }
    default:
      if (Object.hasOwn(UNARY, op) && parts.length === 1) return `${UNARY[op]}(${parts[0]})`;
      if (Object.hasOwn(NARY, op) && parts.length >= 1) return `${NARY[op]}(${parts.join(",")})`;
      return null;
  }
}

/**
 * Compile a scalar AST in x and y. Returns `(x, y) => number` or null.
 * Symbols other than x, y and the listed constants make the expression unsupported.
 */
export function compileNativeScalar(ast, functions = new Map(), constants = new Map()) {
  let expanded;
  try {
    expanded = expandFunctions(ast, functions, constants, [], {
      remaining: MAX_EXPANSION_NODES,
      cloneRemaining: MAX_EXPANSION_NODES,
    });
  } catch (error) {
    return { compiled: null, reason: error instanceof Error ? error.message : String(error) };
  }
  const body = emit(expanded);
  if (body === null) {
    return { compiled: null, reason: unsupportedReason(expanded) || "Expression shape is not supported by the native scalar compiler." };
  }
  try {
    return { compiled: new Function("x", "y", `"use strict"; return ${body};`), reason: null };
  } catch (error) {
    return { compiled: null, reason: `Generated JavaScript could not be compiled: ${error instanceof Error ? error.message : String(error)}` };
  }
}
