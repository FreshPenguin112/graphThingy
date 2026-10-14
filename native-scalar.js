/**
 * Ahead-of-time compilation of simple scalar MathJSON to plain JavaScript.
 *
 * Compute Engine's compiled functions are fast, but a native arrow function is
 * roughly 20x faster per point, which matters on a 250k-point grid. Only a small,
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

/** Returns a JS expression string for `node`, or null if it is outside the subset. */
function emit(node) {
  if (typeof node === "number") return Number.isFinite(node) ? `(${String(node)})` : null;
  if (typeof node === "string") return Object.hasOwn(SYMBOLS, node) ? SYMBOLS[node] : null;
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
export function compileNativeScalar(ast) {
  const body = emit(ast);
  if (body === null) return null;
  try {
    return new Function("x", "y", `"use strict"; return ${body};`);
  } catch {
    return null;
  }
}
