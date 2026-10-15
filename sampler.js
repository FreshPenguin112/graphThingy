/**
 * Pure (DOM-free) expression parsing and plotting sampler.
 *
 * This module is shared by the main thread (for previews and definitions) and by
 * the sampler Web Worker (sampler-worker.js), so it must not touch `window`,
 * `document` or any state owned by the page.
 */
import { ComputeEngine, compile } from "@cortex-js/compute-engine";
import {
  lowerIdenticallyEqualForGraph,
  normalizePiecewiseConditionEquivalence,
  normalizePiecewiseEquivalenceForDefinition,
} from "./plot-ast.js";
import {
  assertAssignmentOnlyEquals,
  normalizeEqualityShorthand,
} from "./math-equality.js";
import { compileNativeScalar } from "./native-scalar.js";

/**
 * Yield to the event loop so queued messages (cancellations, input) run between
 * chunks of work. setTimeout(0) is clamped to >= 4 ms after a few nested calls,
 * which made a 250k-point grid spend most of its time sleeping; a MessageChannel
 * round-trip costs microseconds.
 */
const yieldPort = typeof MessageChannel === "function" ? new MessageChannel() : null;
const yieldWaiters = [];
if (yieldPort) yieldPort.port1.onmessage = () => yieldWaiters.shift()?.();
yieldPort?.port1.unref?.();
yieldPort?.port2.unref?.();
function yieldToEventLoop() {
  if (!yieldPort) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    yieldWaiters.push(resolve);
    yieldPort.port2.postMessage(null);
  });
}

  // Canonical MathJSON names for the most common lowercase function aliases.
  // MathQuill keeps the function text looking like Desmos while the parser maps
  // it to the Compute Engine's standard-library spelling.
export const LOWERCASE_FUNCTION_ALIASES = new Map(Object.entries({
    ln: "Ln", product: "Product", log2: "Log2", log10: "Log10", logbase: "Log", ceil: "Ceiling",
    stddev: "StandardDeviation", stdev: "StandardDeviation",
    standarddeviation: "StandardDeviation", populationstandarddeviation: "PopulationStandardDeviation",
    samplevariance: "SampleVariance", populationvariance: "PopulationVariance",
    stringjoin: "StringJoin", stringlength: "StringLength", tolowercase: "ToLowerCase",
    touppercase: "ToUpperCase", indexof: "IndexOf", loggamma: "LogGamma",
    logfactorial: "LogFactorial", sumofdigits: "SumOfDigits", productofsum: "ProductOfSum",
    eigenvalues: "Eigenvalues", eigenvectors: "Eigenvectors", matrixrank: "MatrixRank",
  }));

export const MATHQUILL_AUTO_OPERATOR_NAMES = [
    "abs acos acosh acot acoth acsc acsch asin asinh atan atanh arcsec arcsech",
    "ceil ceiling clamp conjugate cos cosh cot coth csc csch erf erfc exp",
    "factorial floor gcd hypot im imag inverse inversefunction lcm length ln log",
    "max mean median min mod norm phase real re round sign sin sinc sinh sqrt stddev",
    "stdev sumofdigits tan tanh variance arg gamma lgamma beta zeta eta digamma",
    "det determinant trace transpose inverse matrixrank eigenvalues eigenvectors",
    "list range reverse sort unique flatten count contains indexof join split replace product",
    "touppercase tolowercase trim substring characters stringjoin stringlength",
    "standarddeviation populationstandarddeviation samplevariance populationvariance",
    "and or not xor implies iff forall exists union intersection difference complement",
    "derivative integrate limit simplify expand factor numerator denominator gcd lcm for",
    "roundto floorlog logbase loggamma logfactorial productofsum",
  ].join(" ");

export const SET_ALIASES = [
    [/\\Reals\b/g, "\\mathbb{R}"], [/\\RealNumbers\b/g, "\\mathbb{R}"],
    [/\\Integers\b/g, "\\mathbb{Z}"], [/\\Naturals\b/g, "\\mathbb{N}"],
    [/\\Rationals\b/g, "\\mathbb{Q}"], [/\\Complexes\b/g, "\\mathbb{C}"],
  ];

  /**
   * Canonicalize an ellipsis before parsing. In smart mode, MathQuill may serialize
   * three typed period keys as `\text{.}⋅.` instead of `...` (text punctuation,
   * centered-dot operator, punctuation). Treat that exact three-dot sequence as
   * the spread token, while leaving normal multiplication dots untouched.
   */
export function repairMalformedFunctionNotation(source) {
    let result = String(source);
    // MathQuill can leave a text wrapper open when a PascalCase function name is
    // typed immediately before `(`. Repair that partial wrapper before parsing.
    result = result.replace(/\\text\s*\{\s*([A-Z][A-Za-z0-9]*)\s*\(/g,
      (_match, name) => `\\operatorname{${name}}(`);
    // Smart-mode edits can split a function name across math/text tokens, e.g.
    // `Fl\text{oor(x}`. Join the pieces back into one operator call.
    result = result.replace(/([A-Z][A-Za-z0-9]*)\\text\s*\{([a-z][A-Za-z0-9]*)\s*\(([^{}]*)\}/g,
      (_match, first, rest, args) => `\\operatorname{${first}${rest}}(${args})`);
    // Recover malformed operator names that contain a nested text/MathQuill
    // formatting wrapper, e.g. `\operatorname{$ \mathrm{Floor} $}`.
    result = result.replace(/\\operatorname\s*\{\s*\$?\s*\\(?:mathrm|text)\s*\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\s*\$?\s*\}/g,
      (_match, name) => `\\operatorname{${name}}`);
    return result;
  }

export function normalizeSpreadNotation(source) {
    // MathQuill can tokenize three typed periods inconsistently depending on the
    // caret's position. Seen serializations include `\\text{.}⋅.a`, `⋅.⋅b`,
    // and the usual `\\ldots a`. Treat any run of three dot-shaped tokens as an
    // ellipsis, but don't rewrite a single centered dot (ordinary multiplication).
    const dotToken = String.raw`(?:\\text\s*\{\s*\.\s*\}|\\cdot\b|⋅|·|\.)`;
    const threeDots = new RegExp(`${dotToken}(?:\\s*${dotToken}){2}`, "g");
    return String(source)
      .replace(threeDots, "...")
      // Recover a malformed LaTeX backslash that an editor/paste path may have
      // serialized as a literal \backslash followed by the command name.
      .replace(/\\backslash\s*(?:\\text\s*\{\s*)?(?:ldots|dots|cdots)(?:\s*\})?/g, "...")
      .replace(/\\(?:ldots|dots|cdots)\s*/g, "...");
  }

  // Spacing is purely visual. MathQuill serializes typed spaces as `\ ` (also
  // `\,` `\;` `\:` `\!` and \quad/\qquad), which must never reach a parser:
  // turn them all into one plain space so every grammar sees ordinary whitespace.
  // An escaped backslash (`\\ `, an array row separator) is left alone.
  //
  // NOTE: this normalizer is deliberately NOT applied when persisting
  // `equation.latex` or exporting a project. MathQuill's `\ ` must survive
  // in the stored LaTeX so that, e.g. `for x of [1..10]` round-trips with
  // its spaces intact. Spacing is folded only here, on parser input.
export function normalizeLatexSpacing(source) {
    return String(source)
      .replace(/(?<!\\)\\[ ,;:!]/g, " ")
      .replace(/(?<!\\)\\q?quad(?![A-Za-z])/g, " ");
  }

  // Strips ONLY MathQuill's presentation wrappers around colored brackets.
  // It intentionally does NOT fold spacing: `\ ` in the serialized LaTeX is
  // meaningful to MathQuill (a real space the user typed) and must be kept
  // in `equation.latex` and in exported JSON so it round-trips.
export function stripDelimiterDecoration(source) {
    return String(source)
      .replace(/\\mathopen\{\\textcolor\{#[0-9a-fA-F]{3,8}\}\{\\(?:big|Big|bigg|Bigg)l(\\\{|\[|\()\}\}/g,
        (_m, glyph) => glyph === "\\{" ? "\\{" : glyph)
      .replace(/\\mathclose\{\\textcolor\{#[0-9a-fA-F]{3,8}\}\{\\(?:big|Big|bigg|Bigg)r(\\\}|\]|\))\}\}/g,
        (_m, glyph) => glyph === "\\}" ? "\\}" : glyph);
  }

export function normalizeLatex(source, knownNames = [], allowGeneratedConditionEquality = false) {
    const equalityNormalizedSource = normalizeEqualityShorthand(source);
    assertAssignmentOnlyEquals(equalityNormalizedSource, { allowGeneratedConditionEquality });
    // Spacing is folded to a plain space only here, on parser input.
    let result = repairMalformedFunctionNotation(
      normalizeSpreadNotation(normalizeLatexSpacing(stripDelimiterDecoration(equalityNormalizedSource))),
    );
    // Treat logical words as operators, regardless of whether MathQuill serialized
    // them as plain text, operator names, or ordinary words. Word boundaries keep
    // identifiers such as `candy` and `order` intact.
    result = result
      .replace(/\\(?:text|mathrm|operatorname)\s*\{\s*and\s*\}/gi, "\\land")
      .replace(/\\(?:text|mathrm|operatorname)\s*\{\s*or\s*\}/gi, "\\lor")
      .replace(/(?<![A-Za-z0-9_])and(?![A-Za-z0-9_])/gi, "\\land")
      .replace(/(?<![A-Za-z0-9_])or(?![A-Za-z0-9_])/gi, "\\lor");
    // Some input methods can serialize `mod(...)` as \bmod followed by a
    // parenthesized argument list. That is infix LaTeX, not a function call;
    // turn only this call-shaped form into the Compute Engine's Mod function.
    result = result.replace(/\\bmod\s*(?:\\left\s*)?\(/g, "\\operatorname{Mod}(");
    result = result.replace(/\\operatorname\{([A-Za-z][A-Za-z0-9]*)\}(?=\s*(?:\\left\s*)?\()/g,
      (_match, name) => `\\operatorname{${LOWERCASE_FUNCTION_ALIASES.get(name.toLowerCase()) || (name[0].toUpperCase() + name.slice(1))}}`);
    for (const [pattern, replacement] of SET_ALIASES) result = result.replace(pattern, replacement);
    result = result
      .replace(/\\text\{\s*True\s*\}|\\mathrm\{\s*True\s*\}/gi, "\\top")
      .replace(/\\text\{\s*False\s*\}|\\mathrm\{\s*False\s*\}/gi, "\\bot");
    // Method-call syntax is sugar for a global PascalCase standard-library call:
    // a.Length() -> Length(a), a.map(f) -> map(a,f). Keep the normalized form
    // explicit so MathQuill's visual spelling does not leak into the Compute Engine.
    // First handle calls with a flat argument list (including the empty-list form),
    // then handle nested-argument calls by rewriting only the receiver/method prefix.
    result = result.replace(/([A-Za-z][A-Za-z0-9]*|\\operatorname\{[^{}]+\}|\([^()]*\))\.([A-Za-z][A-Za-z0-9]*)\(([^()]*)\)/g,
      (_match, receiver, method, args) => `\\operatorname{${method}}(${receiver}${args.trim() ? `,${args}` : ""})`);
    result = result.replace(/([A-Za-z][A-Za-z0-9]*|\\operatorname\{[^{}]+\}|\([^()]*\))\.([A-Za-z][A-Za-z0-9]*)\s*\(/g,
      (_match, receiver, method) => `\\operatorname{${method}}(${receiver},`);
    // MathQuill may serialize a typed function name as text mode, e.g.
    // `\text{Mod}(1.1,1)`. Convert those call heads to operator names too.
    result = result.replace(/\\text\s*\{\s*([A-Z][A-Za-z0-9]*)\s*\}(?=\s*(?:\\left\s*)?\()/g,
      (_match, name) => `\\operatorname{${name}}`);
    // Bare PascalCase calls are standard-library functions (Factorial(5),
    // Length(a), etc.). Existing operatorname/mathrm calls are left alone.
    result = result.replace(/(?<![A-Za-z0-9_])([A-Z][A-Za-z0-9]*)\s*(?:\\left\s*)?\(/g,
      (match, name, offset, whole) => {
        const prefix = whole.slice(Math.max(0, offset - 20), offset);
        return prefix.endsWith("\\operatorname{") || prefix.endsWith("\\mathrm{")
          ? match : `\\operatorname{${name}}(`;
      });
    // Compute Engine's MathJSON standard library already supports Spread in list
    // literals. Translate the user-friendly ellipsis to that native operator.
    result = result.replace(/\.\.\.\s*([A-Za-z][A-Za-z0-9]*|\\operatorname\{[^{}]+\}|\[[^\[\]]*\])/g,
      (_match, operand) => `\\operatorname{Spread}(${operand})`);
    for (const name of [...knownNames].filter((name) => name.length > 1).sort((a, b) => b.length - a.length)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![A-Za-z0-9_{}])${escaped}(?![A-Za-z0-9_])`, "g");
      result = result.replace(pattern, (match, offset, whole) => {
        const prefix = whole.slice(Math.max(0, offset - 14), offset);
        return prefix.endsWith("\\operatorname{") || prefix.endsWith("\\mathrm{") ? match : `\\operatorname{${match}}`;
      });
    }
    // Remove MathQuill's presentation-only wrappers, including its escaped square
    // brackets, before parsing. The AST helpers below handle either resulting
    // List JSON or a Delimiter wrapper around that List.
    result = result.replace(/\\left|\\right/g, "");
    // Strip trailing \) that may remain from stripped \right) in comprehensions
    result = result.replace(/\)+$/, ")");
    result = result.replace(/\\lbrack/g, "[");
    result = result.replace(/\\rbrack/g, "]");
    return result;
  }

  /**
   * All plotting evaluation lives on the main thread. Sampling yields regularly so
   * edits, panning, and page controls stay responsive; obsolete jobs self-cancel.
   */
export function createInlineSampler() {


    function compactLatex(source) {
      // Fold MathQuill's typed-space spellings (notably `\ `) before compacting.
      return normalizeSpreadNotation(normalizeLatexSpacing(source))
        .replace(/\\left|\\right/g, "")
        .replace(/\s+/g, "")
        .trim();
    }

    function findMatchingParen(source, openIndex) {
      let depth = 0;
      for (let i = openIndex; i < source.length; i++) {
        if (source[i] === "\\") { i++; continue; }
        if (source[i] === "(") depth++;
        else if (source[i] === ")" && --depth === 0) return i;
      }
      return -1;
    }


    function latexIdentifier(name) {
      return /^[A-Za-z]$/.test(name) ? name : `\\operatorname{${name}}`;
    }

    function findTopLevelRelation(source) {
      let depth = 0;
      for (let i = 0; i < source.length; i++) {
        // Count escaped tall-brace delimiters as grouping too, so an
        // equality inside a piecewise condition (floor(x)=x) is not mistaken for
        // the main equation's equality.
        if (source.startsWith("\\left\\{", i)) { depth++; i += 6; continue; }
        if (source.startsWith("\\right.", i)) { depth = Math.max(0, depth - 1); i += 6; continue; }
        if (source.startsWith("\\right\\}", i)) { depth = Math.max(0, depth - 1); i += 7; continue; }
        const environment = source.slice(i).match(/^\\begin\{(cases|dcases|rcases|array|matrix|aligned)\}/);
        if (environment) {
          const endToken = `\\end{${environment[1]}}`;
          const end = source.indexOf(endToken, i + environment[0].length);
          if (end >= 0) { i = end + endToken.length - 1; continue; }
        }
        const ch = source[i];
        if (ch === "\\" && i + 1 < source.length) {
          // Not `\b`: after MathQuill re-renders `\le 9` it is serialized as `\le9`, and there is no
          // word boundary between `e` and `9`, so the relation was silently missed.
          // `(?![A-Za-z])` still rejects `\left`, `\lt` is handled by its own alternative.
          const command = source.slice(i).match(/^\\(?:leq?|geq?|neq|lt|gt)(?![A-Za-z])/);
          if (command && depth === 0) {
            const token = command[0];
            const relation = token.startsWith("\\le") ? "<=" : token.startsWith("\\ge") ? ">=" : token === "\\neq" ? "!=" : token === "\\lt" ? "<" : ">";
            return { left: source.slice(0, i).trim(), right: source.slice(i + token.length).trim(), relation };
          }
          i++;
          continue;
        }
        if ("{([".includes(ch) && source[i - 1] !== "\\") depth++;
        else if ("})]".includes(ch) && source[i - 1] !== "\\") depth = Math.max(0, depth - 1);
        else if (depth === 0 && (ch === "=" || ch === "<" || ch === ">")) {
          if ((ch === "<" || ch === ">") && source[i + 1] === "=") return { left: source.slice(0, i).trim(), right: source.slice(i + 2).trim(), relation: ch + "=" };
          if (ch === "=" && (source[i + 1] === "=" || source[i - 1] === "=")) continue;
          return { left: source.slice(0, i).trim(), right: source.slice(i + 1).trim(), relation: ch };
        }
      }
      return { left: source.trim(), right: "", relation: "=" };
    }

    function splitTopLevel(source, separator) {
      const parts = [];
      let depth = 0, start = 0;
      for (let i = 0; i < source.length; i++) {
        if (source[i] === "\\" && i + 1 < source.length) { i++; continue; }
        if (source[i] === "{" || source[i] === "(" || source[i] === "[") depth++;
        else if (source[i] === "}" || source[i] === ")" || source[i] === "]") depth = Math.max(0, depth - 1);
        else if (depth === 0 && source.startsWith(separator, i)) {
          parts.push(source.slice(start, i).trim());
          i += separator.length - 1;
          start = i + 1;
        }
      }
      parts.push(source.slice(start).trim());
      return parts;
    }

    /**
     * If `text` is exactly one parenthesized group — `( … )` or `\left( … \right)` —
     * return its inner text; otherwise null.
     */
    function stripOuterParens(text) {
      const trimmed = String(text).trim();
      const open = trimmed.match(/^(\\left\s*)?\(/);
      if (!open) return null;
      const openEnd = open[0].length;
      let depth = 1;
      for (let i = openEnd; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === "\\") { i++; continue; }
        if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) {
          if (trimmed.slice(i + 1).trim() !== "") return null;
          return { inner: trimmed.slice(openEnd, i).replace(/\\right\s*$/, "") };
        }
      }
      return null;
    }

    function findTopLevelIf(source) {
      let depth = 0;
      for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (depth === 0) {
          const match = source.slice(i).match(/^(?:\\text\s*\{\s*if\s*\}|\\mathrm\s*\{\s*if\s*\}|\s+if\s+)/i);
          if (match) return { index: i, length: match[0].length };
        }
        if (ch === "\\" && i + 1 < source.length) { i++; continue; }
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      }
      return null;
    }

    function normalizeCondition(condition) {
      let result = String(condition ?? "").trim();

      // MathQuill may serialize the label and value together as `\text{if True}`
      // instead of `\text{if } True`. Extract the condition from either form.
      const textIf = result.match(/^\\text\s*\{\s*if\b([^}]*)\}\s*(.*)$/i);
      if (textIf) result = textIf[1].trim() || textIf[2].trim();
      result = result.replace(/^\\mathrm\s*\{\s*if\b([^}]*)\}\s*(.*)$/i, (_all, inline, tail) => String(inline).trim() || String(tail).trim());
      result = result.replace(/^\\text\s*\{\s*if\s*\}\s*/i, "").replace(/^\\mathrm\s*\{\s*if\s*\}\s*/i, "");
      result = result.replace(/^if\s+/i, "").trim();
      // Treat these as logical operators in conditional labels even when
      // MathQuill serializes them as text/operator-name tokens.
      result = result
        .replace(/\\(?:text|mathrm|operatorname)\s*\{\s*and\s*\}/gi, "\\land")
        .replace(/\\(?:text|mathrm|operatorname)\s*\{\s*or\s*\}/gi, "\\lor")
        .replace(/(?<![A-Za-z0-9_])and(?![A-Za-z0-9_])/gi, "\\land")
        .replace(/(?<![A-Za-z0-9_])or(?![A-Za-z0-9_])/gi, "\\lor");


      result = normalizePiecewiseConditionEquivalence(result);

      const simple = compactLatex(result).toLowerCase();
      if (["true", "\\text{true}", "\\mathrm{true}", "\\top", "top", "⊤"].includes(simple)) return "\\top";
      if (["false", "\\text{false}", "\\mathrm{false}", "\\bot", "bot", "⊥"].includes(simple)) return "\\bot";
      if (["otherwise", "else"].includes(simple)) return "\\top";
      return result || "\\top";
    }

    /** Parse one branch, accepting plain `output if condition` and MathQuill's text form. */
    function parseBranchEntry(entry) {
      const source = String(entry).trim();
      if (!source) return null;

      // If the entire condition was accidentally absorbed by a text-mode token,
      // e.g. `5\\text{if True}`, recover it before asking Compute Engine to parse it.
      const textIf = source.match(/^([\s\S]*?)\\text\s*\{\s*if\b([^}]*)\}\s*(.*)$/i);
      if (textIf && textIf[1].trim()) {
        const condition = String(textIf[2]).trim() || String(textIf[3]).trim();
        if (condition) return { output: textIf[1].trim(), condition: normalizeCondition(condition) };
      }
      const romanIf = source.match(/^([\s\S]*?)\\mathrm\s*\{\s*if\b([^}]*)\}\s*(.*)$/i);
      if (romanIf && romanIf[1].trim()) {
        const condition = String(romanIf[2]).trim() || String(romanIf[3]).trim();
        if (condition) return { output: romanIf[1].trim(), condition: normalizeCondition(condition) };
      }

      const ifAt = findTopLevelIf(source);
      if (!ifAt) return null;
      const output = source.slice(0, ifAt.index).trim();
      const condition = source.slice(ifAt.index + ifAt.length).trim();
      if (!output || !condition) return null;
      return { output, condition: normalizeCondition(condition) };
    }

    function parseBraceBranches(body) {
      const entries = splitTopLevel(body, ",");
      if (!entries.length || entries.some((entry) => !entry)) return null;
      const branches = [];
      let sawColonStyle = false;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        // New format: `condition:trueValue,falseValue` (two colons)
        // e.g. `True:1:0` means if True output 1, else output 0
        // False value is optional: `True:1` or `True:1,,`
        const colonParts = splitTopLevel(entry, ":");
        if (colonParts.length >= 2) {
          const condition = colonParts[0];
          // If there are exactly 3 parts (condition:trueValue:falseValue)
          if (colonParts.length === 3) {
            const trueOutput = colonParts[1].trim();
            const falseOutput = colonParts[2].trim();
            if (condition && trueOutput) {
              sawColonStyle = true;
              branches.push({ condition: normalizeCondition(condition), output: trueOutput, falseOutput });
              continue;
            }
          } else if (colonParts.length === 2) {
            const trueOutput = colonParts[1].trim();
            if (condition && trueOutput) {
              sawColonStyle = true;
              branches.push({ condition: normalizeCondition(condition), output: trueOutput, falseOutput: null });
              continue;
            }
          }
        }
        // Desmos-style branches are `condition: output, condition: output, default`.
        // The final bare expression is the fallback only when at least one colon
        // branch was seen; ordinary braces such as `{1,2,3}` remain sets.
        const colonParts2 = splitTopLevel(entry, ":");
        if (colonParts2.length >= 2) {
          const condition = colonParts2.shift();
          const output = colonParts2.join(":").trim();
          if (condition && output) {
            sawColonStyle = true;
            branches.push({ condition: normalizeCondition(condition), output });
            continue;
          }
        }
        const branch = parseBranchEntry(entry);
        if (branch) {
          branches.push(branch);
          continue;
        }
        if (sawColonStyle && index === entries.length - 1 && entry.trim()) {
          // Our evaluator intentionally collects every matching branch. Make the
          // fallback mutually exclusive by negating all preceding colon conditions.
          const conditions = branches.map((item) => item.condition);
          const anyPrevious = conditions.map((condition) => `\\left(${condition}\\right)`).join("\\lor");
          branches.push({ condition: `\\neg\\left(${anyPrevious}\\right)`, output: entry.trim() });
          continue;
        }
        return null;
      }
      return branches.length ? branches : null;
    }

    function parseEnvironmentBranches(body) {
      const rows = body.split(/\\\\(?:\[[^\]]*\])?/g).map((row) => row.trim()).filter(Boolean);
      const branches = [];
      for (const row of rows) {
        const cells = splitTopLevel(row, "&");
        const output = cells.shift()?.trim() || "";
        const conditionText = cells.join("&").trim();
        if (!output) continue;

        if (conditionText) {
          // Handles `& \\text{if } x<0` and `& \\text{if x<0}` alike.
          branches.push({ output, condition: normalizeCondition(conditionText) });
          continue;
        }

        // Some hand-written / older templates serialize a whole branch in one cell.
        const branch = parseBranchEntry(row);
        if (!branch) return null;
        branches.push(branch);
      }
      return branches.length ? branches : null;
    }

    function findEnvironmentEnd(source, start, envName, tokenLength) {
      const open = new RegExp(`\\\\begin\\{${envName}\\}`, "g");
      const close = new RegExp(`\\\\end\\{${envName}\\}`, "g");
      open.lastIndex = start + tokenLength;
      close.lastIndex = start + tokenLength;
      let depth = 1;
      while (depth > 0) {
        const nextOpen = open.exec(source);
        const nextClose = close.exec(source);
        if (!nextClose) return null;
        if (nextOpen && nextOpen.index < nextClose.index) {
          depth++;
          open.lastIndex = nextOpen.index + nextOpen[0].length;
          close.lastIndex = nextOpen.index + nextOpen[0].length;
        } else {
          depth--;
          if (depth === 0) return { bodyStart: start + tokenLength, bodyEnd: nextClose.index, end: nextClose.index + nextClose[0].length };
          open.lastIndex = nextClose.index + nextClose[0].length;
          close.lastIndex = nextClose.index + nextClose[0].length;
        }
      }
      return null;
    }

    // Compute Engine MathJSON usually represents a symbol as the plain string "x",
    // not only as the older ["Symbol", "x"] form. Treat both forms consistently.
    function astSymbolName(ast) {
      if (typeof ast === "string") return ast;
      if (Array.isArray(ast) && ast[0] === "Symbol" && ast.length > 1) return String(ast[1]);
      return null;
    }

    function isListAst(ast) {
      return Array.isArray(ast) && ["List", "Tuple", "Vector", "Sequence"].includes(String(ast[0]));
    }

    function astNumericValue(ast) {
      if (typeof ast === "number" && Number.isFinite(ast)) return ast;
      if (!Array.isArray(ast)) return null;
      if (ast[0] === "Rational" && Number.isFinite(Number(ast[1])) && Number.isFinite(Number(ast[2])) && Number(ast[2]) !== 0) return Number(ast[1]) / Number(ast[2]);
      if (ast[0] === "Negate") { const n = astNumericValue(ast[1]); return n === null ? null : -n; }
      if (ast[0] === "Add" || ast[0] === "Subtract" || ast[0] === "Multiply" || ast[0] === "Divide") {
        const a = astNumericValue(ast[1]), b = astNumericValue(ast[2]);
        if (a === null || b === null) return null;
        if (ast[0] === "Add") return a + b;
        if (ast[0] === "Subtract") return a - b;
        if (ast[0] === "Multiply") return a * b;
        return b === 0 ? null : a / b;
      }
      return null;
    }

    function numericRangeSpec(values) {
      if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
      let start, end, step;
      // MathJSON Range operands are [start, end] or [start, end, step].
      // In `1,3..1000`, the parser stores [1, 1000, 2], not [1, 2, 1000].
      if (values.length === 2) {
        [start, end] = values;
        step = start <= end ? 1 : -1;
      } else if (values.length === 3) {
        [start, end, step] = values;
      } else {
        return null;
      }
      if (!step || !Number.isFinite(step) || (end - start) * step < 0) {
        return { start, end, step, count: 0 };
      }
      const count = Math.min(10000, Math.floor((end - start) / step + 1e-10) + 1);
      return { start, end, step, count: Math.max(0, count) };
    }

    function numericRange(values) {
      const spec = numericRangeSpec(values);
      if (!spec) return null;
      return Array.from({ length: spec.count }, (_, i) => spec.start + spec.step * i);
    }

    function numericRangeValue(values, index) {
      const spec = numericRangeSpec(values);
      if (!spec || index < 0 || index >= spec.count) return null;
      return spec.start + spec.step * index;
    }

    function flattenList(value) {
      return Array.isArray(value) ? value.flatMap(flattenList) : [value];
    }

    function asNumber(value) {
      try {
        if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
        if (typeof value === "boolean") return value ? 1 : 0;
        if (typeof value === "string") {
          const number = Number(value);
          return Number.isFinite(number) ? number : NaN;
        }
        if (value && typeof value.valueOf === "function") {
          const primitive = value.valueOf();
          if (typeof primitive === "number") return Number.isFinite(primitive) ? primitive : NaN;
          if (typeof primitive === "boolean") return primitive ? 1 : 0;
        }
        if (value && typeof value.N === "function") return asNumber(value.N().valueOf());
      } catch { /* non-real or symbolic result */ }
      return NaN;
    }

    function asBoolean(value) {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0 && Number.isFinite(value);
      const raw = String(value ?? "").trim().toLowerCase();
      if (["true", "top", "⊤", "\\top"].includes(raw)) return true;
      if (["false", "bot", "⊥", "\\bot"].includes(raw)) return false;
      try {
        const primitive = value?.valueOf?.();
        if (typeof primitive === "boolean") return primitive;
      } catch { /* not a primitive boolean */ }
      return false;
    }

    /**
     * User definitions deliberately accept arbitrary MathJSON values. Declare user
     * variables with type "any" first, then use the public assign API so lists,
     * tuples, booleans and scalars all go through Compute Engine's normal assignment
     * path without inheriting a built-in symbol's narrower domain.
     * @param {ComputeEngineInstance} engine
     * @param {string} name
     * @param {BoxedExpression|number|undefined} value
     */
    function assignAnyDefinitionValue(engine, name, value) {
      engine.assign(name, value);
    }

    function createEngine(definitions) {
      const ce = new ComputeEngine();
      const names = definitions.map((def) => def.name).filter(Boolean);
      for (const def of definitions) {
        try {
          // User variables may hold numbers, vectors, tuples, booleans, sets, etc.
          // A user function likewise has an unconstrained input/output contract;
          // do not silently impose a scalar-number return type on its body.
          const declaration = def.kind === "function"
            ? { signature: `(${(def.args || []).map(() => "any").join(", ")}) -> any` }
            : { type: "any" };
          ce.declare(def.name, declaration);
        } catch { /* Builtins may already exist. */ }
      }
      const order = [], done = new Set(), active = new Set();
      function visit(def) {
        if (!def?.name || done.has(def.name) || active.has(def.name)) return;
        active.add(def.name);
        for (const other of definitions) {
          if (other.name === def.name || (def.kind === "function" && def.args?.includes(other.name))) continue;
          const re = new RegExp(`(?<![A-Za-z0-9_])${other.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
          if (re.test(def.rhs || "")) visit(other);
        }
        active.delete(def.name); done.add(def.name); order.push(def);
      }
      for (const def of definitions) visit(def);
      for (const def of order) {
        try {
          // Expand finite collection syntax before assigning definitions too. This
          // lets a variable contain a comprehension and lets downstream graph rows
          // iterate over lists produced by either variables or functions.
          const collectionRhs = transformCollectionSyntax(def.rhs || "", ce, names);
          const normalizedRhs = normalizePiecewiseEquivalenceForDefinition(collectionRhs);
          const rhs = normalizeLatex(normalizedRhs, names, true);
          if (def.kind === "variable") {
            const expression = ce.parse(rhs);
            if (expression?.isValid) assignAnyDefinitionValue(ce, def.name, expression);
          } else if (def.kind === "function") {
            const args = (def.args || []).map(latexIdentifier).join(",");
            ce.parse(`${latexIdentifier(def.name)}(${args}) := ${rhs}`).evaluate();
          }
        } catch { /* unresolved definitions remain symbolic */ }
      }
      return ce;
    }

    function resolveRealMembership(ce, source, knownNames) {
      const match = String(source).match(/^(.+?)\s*\\in\s*(?:\\Reals|\\RealNumbers|\\mathbb\{R\})$/);
      if (!match) return null;
      try {
        const expression = ce.parse(normalizeLatex(match[1], knownNames));
        const numeric = expression.N();
        const primitive = numeric.valueOf();
        if (typeof primitive === "number" && Number.isFinite(primitive)) return "\\top";
        const real = Number(numeric.re), imaginary = Number(numeric.im);
        if (Number.isFinite(real) && Number.isFinite(imaginary)) return Math.abs(imaginary) < 1e-10 ? "\\top" : "\\bot";
      } catch { /* symbolic membership */ }
      return null;
    }

    /**
     * Replace each piecewise expression with a harmless symbol, while storing all of
     * its branches separately. Unlike native Piecewise, the evaluator below collects
     * EVERY branch whose condition is true rather than stopping at the first match.
     */
    function transformPiecewise(source, context) {
      let output = "";
      for (let i = 0; i < source.length;) {
        const env = source.slice(i).match(/^\\begin\{(cases|dcases|rcases|array)\}(?:\s*\{[^{}]*\})?/);
        if (env) {
          const ending = findEnvironmentEnd(source, i, env[1], env[0].length);
          if (ending) {
            const body = source.slice(ending.bodyStart, ending.bodyEnd);
            const branches = parseEnvironmentBranches(body);
            if (branches) {
              const marker = registerPiecewise(branches, context);
              output += `\\operatorname{${marker}}`;
              i = ending.end;
              continue;
            }
          }
        }

        // `\\left\\{ ... \\right.` is our tall brace template. Also accept
        // the short escaped delimiters `\\{ ... \\}` that MathQuill can emit.
        const tallBrace = source.startsWith("\\left\\{", i);
        const escapedBrace = !tallBrace && source.startsWith("\\{", i);
        if (tallBrace || escapedBrace) {
          const opening = tallBrace ? "\\left\\{" : "\\{";
          const bodyStart = i + opening.length;
          const rightMatch = tallBrace
            ? /\\right\s*(?:\\\}|\.)/.exec(source.slice(bodyStart))
            : /\\\}/.exec(source.slice(bodyStart));
          if (rightMatch) {
            const bodyEnd = bodyStart + rightMatch.index;
            const body = source.slice(bodyStart, bodyEnd);
            // Our editor represents piecewise input as a tall brace around a two-column
            // array. Parse that wrapper BEFORE Compute Engine sees the brace: otherwise
            // it interprets the contents as a Set (and text labels as string values).
            const arrayAt = body.search(/\\begin\{(?:array|cases|dcases|rcases)\}/);
            let branches = null;
            if (arrayAt >= 0) {
              const envMatch = body.slice(arrayAt).match(/^\\begin\{(array|cases|dcases|rcases)\}(?:\s*\{[^{}]*\})?/);
              if (envMatch) {
                const ending = findEnvironmentEnd(body, arrayAt, envMatch[1], envMatch[0].length);
                if (ending) branches = parseEnvironmentBranches(body.slice(ending.bodyStart, ending.bodyEnd));
              }
            } else {
              branches = parseBraceBranches(body);
            }
            if (branches) {
              const marker = registerPiecewise(branches, context);
              output += `\\operatorname{${marker}}`;
              i = bodyStart + rightMatch.index + rightMatch[0].length;
              continue;
            }
            const transformedBody = transformPiecewise(body, context);
            if (transformedBody !== body) {
              output += transformedBody;
              i = bodyStart + rightMatch.index + rightMatch[0].length;
              continue;
            }
          }
        }

        // Plain braces support compact input such as {5 if True, 6 if True}.
        if (source[i] === "{" && source[i - 1] !== "\\") {
          let depth = 1, end = i + 1;
          while (end < source.length && depth > 0) {
            if (source[end] === "\\" && end + 1 < source.length) { end += 2; continue; }
            if (source[end] === "{") depth++;
            else if (source[end] === "}") depth--;
            end++;
          }
          if (depth === 0) {
            const branches = parseBraceBranches(source.slice(i + 1, end - 1));
            if (branches) {
              const marker = registerPiecewise(branches, context);
              output += `\\operatorname{${marker}}`;
              i = end;
              continue;
            }
          }
        }
        output += source[i];
        i++;
      }
      return output;
    }

    function registerPiecewise(branches, context) {
      const name = `__pw_${context.nextPiecewiseIndex ??= context.piecewise.size}`;
      context.nextPiecewiseIndex++;
      const prepared = branches.map((branch) => {
        const outputSource = transformPiecewise(branch.output, context);
        const conditionSource = transformPiecewise(branch.condition, context);
        const outputExpr = context.ce.parse(normalizeLatex(outputSource, context.knownNames));
        const conditionExpr = context.ce.parse(normalizeLatex(conditionSource, context.knownNames, true));
        if (!outputExpr?.isValid || !conditionExpr?.isValid) {
          const invalid = !outputExpr?.isValid ? outputExpr : conditionExpr;
          const details = invalid?.errors?.map(String).join("; ");
          throw new Error(details || `Could not parse piecewise branch: ${branch.output} if ${branch.condition}`);
        }
        let falseOutputAst = null;
        if (branch.falseOutput) {
          const falseOutputSource = transformPiecewise(branch.falseOutput, context);
          const falseOutputExpr = context.ce.parse(normalizeLatex(falseOutputSource, context.knownNames));
          if (falseOutputExpr?.isValid) {
            falseOutputAst = falseOutputExpr.json;
          }
        }
        return { outputAst: outputExpr.json, conditionAst: conditionExpr.json, falseOutputAst };
      });
      context.piecewise.set(name, prepared);
      return name;
    }

    /** Engines are expensive to build (~30 ms each), so one is kept per set of definitions. */
    const engineCache = new Map();
    const MAX_CACHED_ENGINES = 8;
    /** Compiled scalar functions, per engine (see createAstEvaluator). */
    const compiledByEngine = new WeakMap();
    const nativeFunctionsByEngine = new WeakMap();
    function compiledCacheFor(ce) {
      let cache = compiledByEngine.get(ce);
      if (!cache) { cache = new Map(); compiledByEngine.set(ce, cache); }
      return cache;
    }
    /** AST nodes that contain a list-producing operator (memoized: the AST is immutable). */
    const listCache = new WeakMap();

    function declareAxisSymbols(ce) {
      for (const name of ["x", "y"]) {
        try { ce.declare(name, "number"); } catch { /* already declared on a reused engine */ }
      }
    }

    function acquireEngine(definitions) {
      const key = JSON.stringify(definitions.map((def) => [def.kind, def.name, def.args || [], def.rhs || ""]));
      const cached = engineCache.get(key);
      if (cached) {
        // Reset the axis values a previous sample may have left behind, so nothing
        // from an earlier camera leaks into this evaluation.
        for (const name of ["x", "y"]) { try { cached.assign(name, undefined); } catch { /* unassignable */ } }
        engineCache.delete(key);
        engineCache.set(key, cached);
        return cached;
      }
      const ce = createEngine(definitions);
      engineCache.set(key, ce);
      if (engineCache.size > MAX_CACHED_ENGINES) engineCache.delete(engineCache.keys().next().value);
      return ce;
    }

    function nativeFunctionsFor(ce, definitions, knownNames) {
      const cached = nativeFunctionsByEngine.get(ce);
      if (cached) return cached;
      const functions = new Map();
      for (const definition of definitions) {
        if (definition.kind !== "function" || !definition.name || !definition.rhs) continue;
        try {
          const collectionRhs = transformCollectionSyntax(definition.rhs, ce, knownNames);
          const normalized = normalizeLatex(
            normalizePiecewiseEquivalenceForDefinition(collectionRhs),
            knownNames,
            true,
          );
          const expression = ce.parse(normalized);
          if (expression?.isValid) {
            functions.set(definition.name, { args: definition.args || [], body: expression.json });
          }
        } catch { /* unsupported definitions remain on the Compute Engine path */ }
      }
      nativeFunctionsByEngine.set(ce, functions);
      return functions;
    }

    function createAstEvaluator(ce, piecewise, nativeFunctions = new Map(), compilation = null, nativeConstants = new Map()) {
      // Compiled functions depend only on the engine and the AST, so they are shared by
      // every evaluator built on the same engine (pan/zoom re-samples reuse them).
      const compiledCache = compiledCacheFor(ce);
      const noPiecewiseCache = new Map();
      function noteSymbolicFallback(report, reason) {
        if (!report) return;
        report.symbolicEvaluationCount++;
        if (!report.fallbackReason) report.fallbackReason = reason;
      }

      function containsPiecewise(ast) {
        const symbol = astSymbolName(ast);
        if (symbol !== null && piecewise.has(symbol)) return true;
        if (!Array.isArray(ast)) return false;
        return ast.some((child, index) => index > 0 && containsPiecewise(child));
      }

      // Set membership such as x\in\mathbb{Z} is evaluated directly in JS. Sending it
      // through the symbolic engine once per sample made graphs take forever.
      const FAST_SETS = {
        Integers: Number.isInteger,
        RealNumbers: Number.isFinite,
        NonNegativeIntegers: (v) => Number.isInteger(v) && v >= 0,
        PositiveIntegers: (v) => Number.isInteger(v) && v > 0,
      };
      const membershipCache = new WeakMap();
      function usesMembership(ast) {
        if (!Array.isArray(ast)) return false;
        if (membershipCache.has(ast)) return membershipCache.get(ast);
        const op = String(ast[0]);
        const result = op === "Element" || op === "NotElement" || ast.some((child, index) => index > 0 && usesMembership(child));
        membershipCache.set(ast, result);
        return result;
      }

      function containsList(ast) {
        if (!Array.isArray(ast)) return false;
        if (listCache.has(ast)) return listCache.get(ast);
        const result = isListAst(ast) || ["Range", "RangeList", "SequenceRange"].includes(String(ast[0]))
          || ast.some((child, index) => index > 0 && containsList(child));
        listCache.set(ast, result);
        return result;
      }

      function runtimeValue(value) {
        if (Array.isArray(value)) return value.flatMap((item) => flattenList(runtimeValue(item)));
        if (value && typeof value.valueOf === "function") {
          try {
            const primitive = value.valueOf();
            if (primitive !== value) return runtimeValue(primitive);
          } catch { /* keep trying supported representations */ }
        }
        // Compute Engine list values are not guaranteed to arrive as native arrays
        // from compiled functions. Convert their boxed JSON representation as well.
        if (value && typeof value.json === "object" && Array.isArray(value.json)) {
          const json = value.json;
          if (isListAst(json)) return json.slice(1).map((item) => runtimeValue(ce.box(item)));
        }
        return value;
      }

      // Cache by AST object identity: stringifying the AST for every sample was a
      // large share of the per-pixel cost.
      const evaluatorByNode = new WeakMap();
      function replaceNativeConstants(node) {
        if (typeof node === "string" && nativeConstants.has(node)) return nativeConstants.get(node);
        if (!Array.isArray(node)) return node;
        return [node[0], ...node.slice(1).map(replaceNativeConstants)];
      }
      function scalarEvaluator(ast) {
        if (ast !== null && typeof ast === "object" && evaluatorByNode.has(ast)) return evaluatorByNode.get(ast);
        const key = JSON.stringify(replaceNativeConstants(ast));
        if (compiledCache.has(key)) {
          const cached = compiledCache.get(key);
          if (ast !== null && typeof ast === "object") evaluatorByNode.set(ast, cached);
          return cached;
        }
        const boxed = ce.box(ast);
        // The engine's compiler mishandles set membership (it can return `true` for
        // every input). Rewrite the common cases into plain comparisons that compile
        // to fast JS: x in Z  ->  floor(x)==x, x in N -> floor(x)==x and x>=0.
        // Anything still containing a set operator after that uses the engine.
        const rewriteMembership = (node) => {
          if (!Array.isArray(node)) return node;
          const args = node.slice(1).map(rewriteMembership);
          const op = String(node[0]);
          if ((op === "Element" || op === "NotElement") && args.length === 2) {
            const set = astSymbolName(args[1]);
            const a = args[0];
            let test = null;
            if (set === "Integers") test = ["Equal", ["Floor", a], a];
            else if (set === "NonNegativeIntegers") test = ["And", ["Equal", ["Floor", a], a], ["GreaterEqual", a, 0]];
            else if (set === "PositiveIntegers") test = ["And", ["Equal", ["Floor", a], a], ["Greater", a, 0]];
            else if (set === "RealNumbers") test = ["Equal", a, a];
            if (test) return op === "Element" ? test : ["Not", test];
          }
          return [node[0], ...args];
        };
        const usesMembership = (node) => Array.isArray(node)
          && (["Element", "NotElement", "Subset", "Superset", "SubsetEqual", "SupersetEqual"].includes(String(node[0]))
            || node.slice(1).some(usesMembership));
        const usesSet = (node) => Array.isArray(node)
          && (String(node[0]) === "Set" || node.slice(1).some(usesSet));
        const compileAst = lowerIdenticallyEqualForGraph(rewriteMembership(ast));
        const boxedForCompile = ce.box(compileAst);
        if (compilation) compilation.nativeScalarCompileAttempts++;
        const nativeCompilation = compileNativeScalar(compileAst, nativeFunctions, nativeConstants);
        if (compilation && nativeCompilation.compiled) compilation.nativeScalarCompileSuccesses++;
        let compiled = null;
        let engineCompileReason = "";
        if (!nativeCompilation.compiled && !usesMembership(compileAst) && !usesSet(compileAst)) {
          try {
            compiled = compile(boxedForCompile);
            if (!compiled.success) engineCompileReason = `Compute Engine could not compile operator "${String(compileAst?.[0] ?? "expression")}".`;
          } catch (error) {
            engineCompileReason = `Compute Engine compilation failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        const run = (vars, report = compilation) => {
          try {
            if (nativeCompilation.compiled) {
              const native = nativeCompilation.compiled(vars.x, vars.y);
              if ((typeof native === "number" && Number.isFinite(native)) || typeof native === "boolean") return native;
            }
            if (compiled?.success && typeof compiled.run === "function") {
              const raw = compiled.run(vars);
              if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
              const result = runtimeValue(raw);
              // A compiled symbol/custom call can yield NaN when its dependencies are
              // held by Compute Engine rather than passed as explicit compile variables.
              // Treat that as a failed fast path and retry against the assigned engine.
              const containsNaN = (value) => Array.isArray(value)
                ? value.some(containsNaN)
                : typeof value === "number" && Number.isNaN(value);
              if (result !== undefined && result !== null && !containsNaN(result)) return result;
            }
            if (Object.hasOwn(vars, "x")) ce.assign("x", vars.x);
            if (Object.hasOwn(vars, "y")) ce.assign("y", vars.y);
            noteSymbolicFallback(report, nativeCompilation.reason || engineCompileReason || "Compiled evaluation returned no usable scalar value.");
            return runtimeValue(boxed.evaluate().N().valueOf());
          } catch { return NaN; }
        };
        compiledCache.set(key, run);
        if (ast !== null && typeof ast === "object") evaluatorByNode.set(ast, run);
        return run;
      }

      function applyScalarOperator(op, args) {
        // Logical expressions also occur in piecewise predicates after list and
        // symbol evaluation, so handle them before the numeric-only fast path.
        switch (op) {
          case "And": return args.every(asBoolean);
          case "Or": return args.some(asBoolean);
          case "Not": return !asBoolean(args[0]);
          case "Implies": return !asBoolean(args[0]) || asBoolean(args[1]);
          case "Equivalent":
          case "Iff": return args.length < 2 || args.every((value) => asBoolean(value) === asBoolean(args[0]));
          case "Xor": return args.reduce((result, value) => result !== asBoolean(value), false);
        }
        // Most broadcasted graph operations are numeric arithmetic. Handle these
        // directly: compiling a fresh constant expression for every pixel both
        // stalls the plot and grows an unbounded cache as x/y change at every pixel.
        if (args.every((arg) => typeof arg === "number" && Number.isFinite(arg))) {
          switch (op) {
            case "Add": return args.reduce((sum, value) => sum + value, 0);
            case "Subtract": return args.length === 1 ? -args[0] : args.slice(1).reduce((value, next) => value - next, args[0]);
            case "Multiply": return args.reduce((product, value) => product * value, 1);
            case "Divide": return args.slice(1).reduce((value, next) => value / next, args[0]);
            // Keep modulo usable even when the Compute Engine leaves Mod symbolic.
            // Unlike JavaScript's remainder, mathematical mod is non-negative for
            // a positive modulus (e.g. mod(-0.5, 1) = 0.5).
            case "Mod":
            case "Modulo": {
              const [dividend, divisor] = args;
              if (args.length < 2 || !Number.isFinite(dividend) || !Number.isFinite(divisor) || divisor === 0) return NaN;
              return ((dividend % divisor) + divisor) % divisor;
            }
            case "Remainder": return args.length < 2 || !Number.isFinite(args[0]) || !Number.isFinite(args[1]) || args[1] === 0 ? NaN : args[0] % args[1];
            case "Power": return Math.pow(args[0], args[1]);
            case "Negate": return -args[0];
            case "Positive": return +args[0];
            case "Abs": return Math.abs(args[0]);
            case "Square": return args[0] * args[0];
            case "Sqrt": return Math.sqrt(args[0]);
            case "Exp": return Math.exp(args[0]);
            case "Sin": return Math.sin(args[0]);
            case "Cos": return Math.cos(args[0]);
            case "Tan": return Math.tan(args[0]);
            case "Arcsin": return Math.asin(args[0]);
            case "Arccos": return Math.acos(args[0]);
            case "Arctan": return Math.atan(args[0]);
            case "Sinh": return Math.sinh(args[0]);
            case "Cosh": return Math.cosh(args[0]);
            case "Tanh": return Math.tanh(args[0]);
            case "Floor": return Math.floor(args[0]);
            case "Ceiling": return Math.ceil(args[0]);
            case "Round": return Math.round(args[0]);
            case "Sign": return Math.sign(args[0]);
            case "Min": return Math.min(...args);
            case "Max": return Math.max(...args);
            case "Equal": return args.length < 2 ? false : args.every((value) => value === args[0]);
            case "NotEqual": return args.length < 2 ? true : args.some((value) => value !== args[0]);
            case "Less": return args[0] < args[1];
            case "LessEqual": return args[0] <= args[1];
            case "Greater": return args[0] > args[1];
            case "GreaterEqual": return args[0] >= args[1];
          }
        }
        try {
          // This slower fallback is for less common/custom operators only. Do not
          // cache by argument values: on a graph those values change for every pixel.
          noteSymbolicFallback(compilation, `Operator "${op}" is not supported by the scalar evaluator.`);
          const boxed = ce.box([op, ...args]);
          return runtimeValue(boxed.evaluate().N().valueOf());
        } catch { return NaN; }
      }

      function evaluate(ast, vars) {
        const symbol = astSymbolName(ast);
        if (symbol !== null && piecewise.has(symbol)) {
          const values = [];
          for (const branch of piecewise.get(symbol)) {
            const condition = evaluate(branch.conditionAst, vars);
            if (asBoolean(condition)) {
              const value = evaluate(branch.outputAst, vars);
              values.push(...flattenList(value));
            } else if (branch.falseOutputAst !== null && branch.falseOutputAst !== undefined) {
              const value = evaluate(branch.falseOutputAst, vars);
              values.push(...flattenList(value));
            }
          }
          return values;
        }
        if (!Array.isArray(ast)) {
          // Raw MathJSON symbol leaves must be resolved through the engine. Returning
          // the string "y" as a value makes broadcasted arithmetic produce NaN.
          return typeof ast === "string" ? scalarEvaluator(ast)(vars, compilation) : ast;
        }

        const opName = String(ast[0]);
        // Compute Engine represents some bracketed list literals as a Delimiter
        // wrapper around the actual List/Range AST, e.g. `\left\lbrack1,2\right\rbrack`.
        // Unwrap presentation delimiters before vectorization; treating Delimiter as
        // an ordinary scalar operation made `x=[1,2]` evaluate to NaN everywhere.
        if (opName === "Delimiter" && ast.length >= 2) {
          return evaluate(ast[1], vars);
        }
        if ((opName === "Element" || opName === "NotElement") && ast.length === 3 && FAST_SETS[astSymbolName(ast[2])]) {
          const test = FAST_SETS[astSymbolName(ast[2])];
          const negate = opName === "NotElement";
          const value = evaluate(ast[1], vars);
          const check = (v) => typeof v === "number" && Number.isFinite(v) ? test(v) !== negate : false;
          return Array.isArray(value) ? value.map(check) : check(value);
        }
        if (["Range", "RangeList", "SequenceRange"].includes(opName)) {
          const rangeArgs = ast.slice(1).map((arg) => evaluate(arg, vars));
          const range = numericRange(rangeArgs);
          if (range) return range;
        }
        if (isListAst(ast)) return ast.slice(1).flatMap((item) => flattenList(evaluate(item, vars)));
        if (!containsPiecewise(ast) && !containsList(ast) && !usesMembership(ast) && !["Range", "RangeList", "SequenceRange"].includes(opName)) {
          const evaluator = scalarEvaluator(ast);
          const value = evaluator(vars, compilation);
          // A function may yield an array dynamically despite there being no literal
          // List node in its AST. Keep it intact; if compiled evaluation failed, fall
          // through and evaluate the children so list broadcasting can still happen.
          if (Array.isArray(value) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
            return value;
          }
        }

        const op = String(ast[0]);
        const args = ast.slice(1).map((arg) => evaluate(arg, vars));
        if (["Range", "RangeList", "SequenceRange"].includes(op)) return numericRange(args) ?? [];
        if (["At", "Index", "Subscript", "Delimiter", "Hold"].includes(op)) {
          return scalarEvaluator(ast)(vars, compilation);
        }
        const vectorArgs = args.filter(Array.isArray);
        if (!vectorArgs.length) return applyScalarOperator(op, args.map((arg) => (typeof arg === "number" && !Number.isFinite(arg)) ? NaN : arg));

        const length = Math.max(...vectorArgs.map((list) => list.length));
        if (vectorArgs.some((list) => list.length !== length && list.length !== 1)) {
          return Array.from({ length }, () => NaN);
        }
        const result = [];
        for (let index = 0; index < length; index++) {
          const scalarArgs = args.map((arg) => Array.isArray(arg) ? arg[arg.length === 1 ? 0 : index] : arg);
          result.push(applyScalarOperator(op, scalarArgs));
        }
        return result;
      }

      /** Evaluate only one flattened output of a possibly vector-valued expression. */
      function evaluateAt(ast, vars, index) {
        const symbol = astSymbolName(ast);
        if (symbol !== null && piecewise.has(symbol)) {
          let offset = 0;
          for (const branch of piecewise.get(symbol)) {
            const width = maxOutputWidth(branch.outputAst, piecewise);
            if (index < offset + width) {
              // Ensure the branch condition is true before returning its output
              if (!asBoolean(evaluate(branch.conditionAst, vars))) return NaN;
              return evaluateAt(branch.outputAst, vars, index - offset);
            }
            offset += width;
          }
          return NaN;
        }
        if (!Array.isArray(ast)) {
          return typeof ast === "string" ? scalarEvaluator(ast)(vars, compilation) : ast;
        }

        const op = String(ast[0]);
        if (op === "Delimiter" && ast.length >= 2) return evaluateAt(ast[1], vars, index);
        if (["Range", "RangeList", "SequenceRange"].includes(op)) {
          const values = ast.slice(1).map((arg) => asNumber(evaluate(arg, vars)));
          const value = numericRangeValue(values, index);
          return value === null ? NaN : value;
        }
        if (isListAst(ast)) {
          let offset = 0;
          for (const child of ast.slice(1)) {
            const width = maxOutputWidth(child, piecewise);
            if (index < offset + width) return evaluateAt(child, vars, index - offset);
            offset += width;
          }
          return NaN;
        }
        if (!containsPiecewise(ast) && !containsList(ast)) {
          const value = scalarEvaluator(ast)(vars, compilation);
          if (Array.isArray(value)) return asNumber(value[index]);
          if (typeof value !== "number" || Number.isFinite(value)) return value;
          // If the compiled whole-expression result is non-finite, recurse below.
          // A nested custom function may return a list and need element-wise math.
        }

        const children = ast.slice(1);
        const widths = children.map((child) => maxOutputWidth(child, piecewise));
        const outputWidth = Math.max(1, ...widths);
        if (index < 0 || index >= outputWidth) return NaN;
        const scalarArgs = children.map((child, childIndex) => {
          if (containsPiecewise(child) || containsList(child)) {
            return evaluateAt(child, vars, widths[childIndex] === 1 ? 0 : index);
          }
          return evaluate(child, vars);
        });
        return applyScalarOperator(op, scalarArgs);
      }

      return { evaluate, evaluateAt, containsPiecewise, containsList, scalar: scalarEvaluator };
    }

    const widthCache = new WeakMap();
    function maxOutputWidth(ast, piecewise) {
      if (ast !== null && typeof ast === "object") {
        let perMap = widthCache.get(piecewise);
        if (!perMap) { perMap = new WeakMap(); widthCache.set(piecewise, perMap); }
        const hit = perMap.get(ast);
        if (hit !== undefined) return hit;
        const width = computeOutputWidth(ast, piecewise);
        perMap.set(ast, width);
        return width;
      }
      return computeOutputWidth(ast, piecewise);
    }
    function computeOutputWidth(ast, piecewise) {
      const symbol = astSymbolName(ast);
      if (symbol !== null && piecewise.has(symbol)) {
        const branches = piecewise.get(symbol);
        return Math.max(1, branches.reduce((sum, branch) => sum + maxOutputWidth(branch.outputAst, piecewise), 0));
      }
      if (!Array.isArray(ast)) return 1;
      if (["Range", "RangeList", "SequenceRange"].includes(String(ast[0]))) {
        const args = ast.slice(1).map(astNumericValue);
        const range = numericRangeSpec(args);
        if (range) return Math.max(1, range.count);
      }
      if (isListAst(ast)) return ast.slice(1).reduce((sum, child) => sum + maxOutputWidth(child, piecewise), 0);
      const childWidths = ast.slice(1).map((child) => maxOutputWidth(child, piecewise));
      return childWidths.length ? Math.max(...childWidths) : 1;
    }

    function finiteAstNumber(ce, ast) {
      const simple = astNumericValue(ast);
      if (simple !== null && Number.isFinite(simple)) return simple;
      try {
        const value = ce.box(ast).N().valueOf();
        if (typeof value === "number" && Number.isFinite(value)) return value;
      } catch { /* expression is not a numeric constant */ }
      return null;
    }

    /** Return a flattened list only when every value is a finite, compile-time constant. */
    function staticNumericOutputs(ast, ce) {
      if (!Array.isArray(ast)) {
        const value = finiteAstNumber(ce, ast);
        return value === null ? null : [value];
      }
      const op = String(ast[0]);
      if (op === "Delimiter" && ast.length >= 2) return staticNumericOutputs(ast[1], ce);
      if (["Range", "RangeList", "SequenceRange"].includes(op)) {
        const args = ast.slice(1).map((arg) => finiteAstNumber(ce, arg));
        if (args.some((value) => value === null)) return null;
        return numericRange(args);
      }
      if (isListAst(ast)) {
        const result = [];
        for (const child of ast.slice(1)) {
          const values = staticNumericOutputs(child, ce);
          if (values === null) return null;
          result.push(...values);
        }
        return result;
      }
      const value = finiteAstNumber(ce, ast);
      return value === null ? null : [value];
    }

    let generatedSyntaxId = 0;

    function expressionListItems(ce, source, knownNames) {
      try {
        const expr = ce.parse(normalizeLatex(source, knownNames));
        if (!expr?.isValid) return null;
        const evaluated = expr.evaluate();
        const json = evaluated?.json;
        if (Array.isArray(json) && ["List", "Sequence", "Tuple", "Vector"].includes(String(json[0]))) return json.slice(1);
        return null;
      } catch { return null; }
    }

    function replaceIdentifier(source, name, replacement) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Multi-letter identifiers can be stored by MathQuill as a wrapper. Replace
      // the complete wrapper first so we don't create nested \operatorname{...} calls.
      const wrappedPattern = new RegExp(`\\\\(?:text|operatorname|mathrm)\\s*\\{\\s*${escaped}\\s*\\}`, "g");
      let result = source.replace(wrappedPattern, () => replacement);
      const pattern = new RegExp(`(?<![A-Za-z0-9_{}\\\\])${escaped}(?![A-Za-z0-9_])`, "g");
      return result.replace(pattern, () => replacement);
    }
    /**
     * Rewrite every finite numeric range of the form
     *   [start..end]        or        [start..end..step]
     * into an explicit comma-separated list, using the current engine to resolve
     * symbolic endpoints (so [1..d-1] works once `d` is assigned).
     *
     * Ranges whose endpoints cannot be resolved to finite numbers, or whose
     * expansion would exceed 10 000 items, are left as `Range` and fall back to
     * the engine's native lazy handling.
     */
    function expandFiniteRanges(source, ce, knownNames) {
      let result = String(source)
        .replace(/\\left\s*\[/g, "[")
        .replace(/\\right\\s*\)/g, ")")
        .replace(/\\right\s*\]/g, "]")
        .replace(/\\lbrack/g, "[")
        .replace(/\\rbrack/g, "]");

      // Each pass expands one innermost range; nested lists are handled by rescanning.
      for (let guard = 0; guard < 200; guard++) {
        let changed = false;
        for (let i = 0; i < result.length; i++) {
          if (result[i] !== "[" || result[i - 1] === "\\") continue;

          let depth = 1, j = i + 1;
          while (j < result.length && depth > 0) {
            const ch = result[j];
            if (ch === "\\" && j + 1 < result.length) { j += 2; continue; }
            if (ch === "[") depth++;
            else if (ch === "]") depth--;
            j++;
          }
          if (depth !== 0) continue;

          const inner = result.slice(i + 1, j - 1);
          const expanded = expandRangeBody(inner, ce, knownNames);
          if (expanded === null) continue;

          result = result.slice(0, i) + expanded + result.slice(j);
          changed = true;
          break;
        }
        if (!changed) break;
      }
      return result;
    }

    function expandRangeBody(inner, ce, knownNames) {
      // Split on top-level `..`, but leave `...` (spread) untouched.
      const parts = [];
      let start = 0, depth = 0;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === "\\" && i + 1 < inner.length) { i++; continue; }
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
        else if (depth === 0 && ch === "." && inner[i + 1] === "."
          && inner[i + 2] !== "." && inner[i - 1] !== ".") {
          parts.push(inner.slice(start, i));
          i++;               // consume the second dot
          start = i + 1;
        }
      }
      if (parts.length === 0) return null;
      parts.push(inner.slice(start));
      if (parts.length < 2 || parts.length > 3) return null;

      // Evaluate every endpoint against the current engine.
      const values = parts.map((part) => {
        const text = part.trim();
        if (!text) return null;
        try {
          const expr = ce.parse(normalizeLatex(text, knownNames));
          if (!expr?.isValid) return null;
          const n = expr.evaluate().N().valueOf();
          return typeof n === "number" && Number.isFinite(n) ? n : null;
        } catch { return null; }
      });
      if (values.some((v) => v === null)) return null;

      let [startValue, endValue, stepValue] = values;
      if (values.length === 2) stepValue = startValue <= endValue ? 1 : -1;
      if (!Number.isFinite(stepValue) || stepValue === 0) return null;
      if ((endValue - startValue) * stepValue < 0) return String.raw`\left[\right]`;

      const count = Math.floor((endValue - startValue) / stepValue + 1e-10) + 1;
      if (count <= 0) return String.raw`\left[\right]`;
      if (count > 10000) return null;      // too large: keep lazy Range handling

      const items = new Array(count);
      for (let k = 0; k < count; k++) {
        const v = startValue + stepValue * k;
        items[k] = String(Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v);
      }
      return `\\left[${items.join(",")}\\right]`;
    }

    /**
     * Expand finite list comprehensions and tuple spreads into ordinary tuple lists.
     * Iterables are evaluated from current definitions, so work is finite and list
     * length—not the camera extent—controls the expansion. Comma-separated clauses
     * form a Cartesian product, with a 20k expansion cap to keep the UI responsive.
     */
    function transformCollectionSyntax(source, ce, knownNames) {
      let result = String(source)
        .replace(/(?<!\\)\\[ ,;:!]/g, " ")
        .replace(/\\(?:text|operatorname|mathrm)\s*\{\s*for\s*\}/gi, " for ");

      // Expand [a..b] / [a..b..c] to explicit lists before anything tries to
      // iterate or broadcast them. Symbolic bounds are resolved against the
      // currently assigned definitions, so [1..d-1] works if `d` is defined.
      result = expandFiniteRanges(result, ce, knownNames);

      // A comprehension may be wrapped in one pair of parentheses, e.g.
      // `(x, f(i) for i of [0..31])`. Parse the loop inside the wrapper so the
      // closing paren is not mistaken for part of the iterable.
      const wrapper = stripOuterParens(result);
      const loopMatch = (wrapper ? wrapper.inner : result).match(/^(.*?)(?<![A-Za-z0-9_])for\s+(.+)$/is);
      if (loopMatch) {
        const rawBody = loopMatch[1].trim();
        // A tuple body keeps its grouping, so each output item is one tuple.
        const body = wrapper && splitTopLevel(rawBody, ",").length > 1 ? `(${rawBody})` : rawBody;
        const clauseText = loopMatch[2].trim()
          .replace(/\\(?:text|operatorname|mathrm)\s*\{\s*of\s*\}/gi, " of ");
        // Names may arrive either as plain identifiers or in MathQuill's text/operator
        // wrappers. `_` is accepted as the conventional ignored loop variable.
        const loopIdentifier = String.raw`(?:\\(?:text|operatorname|mathrm)\s*\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}|\\_|[A-Za-z_][A-Za-z0-9_]*)`;
        const clauseStartPattern = new RegExp(`^\\s*${loopIdentifier}(?:\\s*,\\s*${loopIdentifier})?\\s+of\\b`, "i");

        // Split only commas that begin another `name[,index] of iterable` clause;
        // commas inside list/tuple/function arguments remain part of the iterable.
        const clauseParts = [];
        let clauseStart = 0;
        let depth = 0;
        for (let i = 0; i < clauseText.length; i++) {
          const ch = clauseText[i];
          if (ch === "\\" && i + 1 < clauseText.length) {
            i++;
            continue;
          }
          if (ch === "(" || ch === "[" || (ch === "{" && clauseText[i - 1] !== "\\")) depth++;
          else if (ch === ")" || ch === "]" || (ch === "}" && clauseText[i - 1] !== "\\")) depth = Math.max(0, depth - 1);
          else if (ch === "," && depth === 0
            && /\s+of\b/i.test(clauseText.slice(clauseStart, i))
            && clauseStartPattern.test(clauseText.slice(i + 1))) {
            clauseParts.push(clauseText.slice(clauseStart, i).trim());
            clauseStart = i + 1;
          }
        }
        clauseParts.push(clauseText.slice(clauseStart).trim());

        const unwrapLoopName = (sourceName) => {
          const name = String(sourceName || "").trim();
          if (name === "\\_") return "_";
          const wrapped = name.match(/^\\(?:text|operatorname|mathrm)\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$/i);
          return wrapped ? wrapped[1] : name;
        };
        const parsedClauses = clauseParts.map((clause) => {
          const match = clause.match(new RegExp(`^\\s*(${loopIdentifier}(?:\\s*,\\s*${loopIdentifier})?)\\s+of\\s+([\\s\\S]+?)\\s*$`, "i"));
          if (!match) return null;
          const names = splitTopLevel(match[1], ",").map(unwrapLoopName);
          if (names.length < 1 || names.length > 2
            || names.some((name) => !/^(?:[A-Za-z][A-Za-z0-9]*|_)$/.test(name))) return null;
          return { names, iterable: match[2].trim() };
        });

        if (parsedClauses.every(Boolean)) {
          let expansions = [{ body, replacements: [] }];
          for (const clause of parsedClauses) {
            const next = [];
            for (const expansion of expansions) {
              let iterableSource = clause.iterable;
              for (const prior of expansion.replacements) {
                iterableSource = replaceIdentifier(iterableSource, prior.name, prior.symbol);
              }
              const items = expressionListItems(ce, iterableSource, knownNames);
              if (!items) {
                throw new Error(`Comprehension source “${clause.iterable}” must evaluate to a finite list.`);
              }
              for (let index = 0; index < items.length && next.length < 20000; index++) {
                const symbol = `\\operatorname{__loopvalue_${generatedSyntaxId++}}`;
                ce.assign(symbol.replace(/^\\operatorname\{|\}$/g, ""), ce.box(items[index]));
                const replacements = [...expansion.replacements];
                if (clause.names[0] !== "_") replacements.push({ name: clause.names[0], symbol });
                if (clause.names[1] && clause.names[1] !== "_") {
                  const indexSymbol = `\\operatorname{__loopindex_${generatedSyntaxId++}}`;
                  ce.assign(indexSymbol.replace(/^\\operatorname\{|\}$/g, ""), index);
                  replacements.push({ name: clause.names[1], symbol: indexSymbol });
                }
                next.push({ body: expansion.body, replacements });
              }
            }
            expansions = next;
            if (expansions.length >= 20000) break;
          }
          const expanded = expansions.map((expansion) => {
            let bodyText = expansion.body;
            for (const entry of expansion.replacements) {
              bodyText = replaceIdentifier(bodyText, entry.name, entry.symbol);
            }
            return bodyText;
          });
          return `\\left[${expanded.join(",")}\\right]`;
        }

        throw new Error("Invalid for-loop syntax. Use `expression for item of list` or `expression for item,index of list`, with comma-separated clauses when needed.");
      }

      // Expand explicit tuple spreads before parsing. MathQuill represents the
      // ellipsis glyph as `\ldots`, not literal dots, so compactLatex normalizes
      // that spelling first. Multiple spread coordinates broadcast element-wise:
      // `(...a,...b)` with equal-length lists becomes [(a[0],b[0]), ...]. Singleton
      // lists broadcast to every item. This is finite and independent of camera size.
      const compact = compactLatex(result);
      let tupleFields = null;
      if (compact.startsWith("(") && compact.endsWith(")")) {
        let depth = 0, closesAtEnd = false;
        for (let i = 0; i < compact.length; i++) {
          if (compact[i] === "\\" && i + 1 < compact.length) { i++; continue; }
          if (compact[i] === "(") depth++;
          else if (compact[i] === ")") {
            depth--;
            if (depth === 0) { closesAtEnd = i === compact.length - 1; break; }
          }
        }
        if (closesAtEnd) tupleFields = splitTopLevel(compact.slice(1, -1), ",");
      }
      if (tupleFields?.length === 2) {
        const spreadSpecs = tupleFields.map((field) => {
          const match = field.match(/^\.\.\.([\s\S]+)$/);
          return match ? { operand: match[1].trim() } : null;
        });
        if (spreadSpecs.some(Boolean)) {
          const itemLists = spreadSpecs.map((spec) => spec
            ? expressionListItems(ce, spec.operand, knownNames)
            : null);
          for (let i = 0; i < spreadSpecs.length; i++) {
            if (spreadSpecs[i] && !itemLists[i]) {
              throw new Error(`Spread expression \"${spreadSpecs[i].operand}\" must evaluate to a finite list.`);
            }
          }
          const listLengths = itemLists.filter((items) => items !== null).map((items) => items.length);
          const expansionCount = Math.max(0, ...listLengths);
          if (expansionCount > 20000) {
            throw new Error(`Tuple spread has ${expansionCount} items; the limit is 20,000 to keep plotting responsive.`);
          }
          const incompatible = listLengths.some((length) => length !== 1 && length !== expansionCount);
          if (incompatible) {
            throw new Error(`Spread lists must have equal lengths (or length 1 for broadcasting); received ${listLengths.join(", ")}.`);
          }
          if (expansionCount === 0) return `\\left[\\right]`;
          const tuples = [];
          for (let index = 0; index < expansionCount; index++) {
            const fields = tupleFields.map((field, fieldIndex) => {
              const spec = spreadSpecs[fieldIndex];
              if (!spec) return field;
              const items = itemLists[fieldIndex];
              const item = items[items.length === 1 ? 0 : index];
              const symbol = `__spreadvalue_${generatedSyntaxId++}`;
              ce.assign(symbol, ce.box(item));
              return `\\operatorname{${symbol}}`;
            });
            tuples.push(`(${fields.join(",")})`);
          }
          console.log("[plotter:spread] tuple spread expanded", {
            source: result,
            listLengths,
            expansionCount,
            broadcast: listLengths.some((length) => length === 1 && expansionCount > 1),
          });
          return `\\left[${tuples.join(",")}\\right]`;
        }
      }
      return result;
    }

    function getCompiledComponents(ce, source, knownNames, visibleCamera = null, definitions = [], compilation = null) {
      const relationParts = findTopLevelRelation(source);
      const hadTopLevelRelation = Boolean(relationParts.right);
      let leftSource = relationParts.left, rightSource = relationParts.right;
      const relation = relationParts.relation;
      if (!rightSource) {
        // Bare expressions are interpreted as y=f(x), unless they already depend on y.
        const context = { ce, knownNames, piecewise: new Map(), nextPiecewiseIndex: 0 };
        leftSource = transformCollectionSyntax(leftSource, ce, knownNames);
        const transformed = transformPiecewise(leftSource, context);
        const parsed = ce.parse(normalizeLatex(transformed, knownNames));
        const unknowns = parsed?.unknowns ? [...parsed.unknowns].map(String) : [];
        if (unknowns.includes("y")) rightSource = "0";
        else { rightSource = leftSource; leftSource = "y"; }
      }
      if (!leftSource || !rightSource) throw new Error("The relation needs an expression on both sides.");

      const context = { ce, knownNames, piecewise: new Map(), nextPiecewiseIndex: 0 };
      leftSource = transformCollectionSyntax(leftSource, ce, knownNames);
      rightSource = transformCollectionSyntax(rightSource, ce, knownNames);
      const leftLatex = transformPiecewise(leftSource, context);
      const rightLatex = transformPiecewise(rightSource, context);
      const leftExpr = ce.parse(normalizeLatex(leftLatex, knownNames));
      const rightExpr = ce.parse(normalizeLatex(rightLatex, knownNames));
      if (!leftExpr?.isValid || !rightExpr?.isValid) {
        const invalid = !leftExpr?.isValid ? leftExpr : rightExpr;
        const details = invalid?.errors?.map(String).join("; ");
        throw new Error(details || "Compute Engine could not parse the equation.");
      }
      const ast = ["Subtract", leftExpr.json, rightExpr.json];
      const nativeFunctions = nativeFunctionsFor(ce, definitions, knownNames);
      const nativeConstants = new Map();
      const loopSymbols = new Set();
      const collectLoopSymbols = (node) => {
        if (typeof node === "string" && /^__loop(?:value|index)_\d+$/.test(node)) loopSymbols.add(node);
        if (Array.isArray(node)) node.slice(1).forEach(collectLoopSymbols);
      };
      collectLoopSymbols(ast);
      for (const branches of context.piecewise.values()) {
        for (const branch of branches) {
          collectLoopSymbols(branch.conditionAst);
          collectLoopSymbols(branch.outputAst);
        }
      }
      for (const name of loopSymbols) {
        try {
          const value = ce.box(name).evaluate().N().valueOf();
          if (typeof value === "number" && Number.isFinite(value)) nativeConstants.set(name, value);
        } catch { /* unresolved loop values remain on the Compute Engine path */ }
      }
      const evaluator = createAstEvaluator(ce, context.piecewise, nativeFunctions, compilation, nativeConstants);

      // Coordinate-tuple equalities can describe discrete point sets. Discover them
      // from the actual piecewise AST and its variables instead of hard-coding a
      // particular `floor(x)=x` expression. Candidate coordinates are generated
      // only over the visible camera; the piecewise conditions decide which points
      // exist. Integer candidates preserve exact lattice conditions such as
      // floor(x)=x, even when no screen sample lands exactly on an integer.
      const unwrapList = (node) => {
        while (Array.isArray(node) && String(node[0]) === "Delimiter" && node.length >= 2) node = node[1];
        return node;
      };
      const leftTuple = unwrapList(leftExpr.json);
      const rightTuple = unwrapList(rightExpr.json);
      const tupleHasXY = isListAst(leftTuple) && leftTuple.length === 3
        && astSymbolName(leftTuple[1]) === "x" && astSymbolName(leftTuple[2]) === "y";
      const isPairSyntax = (text) => {
        const normalized = compactLatex(text);
        if (!normalized.startsWith("(") || !normalized.endsWith(")")) return false;
        let depth = 0, matchingOuterEnd = -1;
        for (let i = 0; i < normalized.length; i++) {
          if (normalized[i] === "(" && normalized[i - 1] !== "\\") depth++;
          else if (normalized[i] === ")" && normalized[i - 1] !== "\\") {
            depth--;
            if (depth === 0) { matchingOuterEnd = i; break; }
          }
        }
        if (matchingOuterEnd !== normalized.length - 1) return false;
        const inner = normalized.slice(1, -1);
        let nested = 0, commas = 0;
        for (let i = 0; i < inner.length; i++) {
          const ch = inner[i];
          if (ch === "\\" && i + 1 < inner.length) { i++; continue; }
          if ("([{ ".includes(ch) && ch !== " ") nested++;
          else if (")] }".includes(ch) && ch !== " ") nested = Math.max(0, nested - 1);
          else if (ch === "," && nested === 0) commas++;
        }
        return commas === 1;
      };
      const evalFiniteScalar = (node, variables = { x: 0, y: 0 }) => {
        try {
          const values = flattenList(evaluator.evaluate(node, variables)).map(asNumber).filter(Number.isFinite);
          if (values.length === 1) return values[0];
        } catch { /* use the engine's assigned definition values as a fallback */ }
        try {
          if (Object.hasOwn(variables, "x")) ce.assign("x", variables.x);
          if (Object.hasOwn(variables, "y")) ce.assign("y", variables.y);
          const value = asNumber(ce.box(node).evaluate().N().valueOf());
          return Number.isFinite(value) ? value : null;
        } catch { return null; }
      };
      // A spread or comprehension expands into a list of tuples. Treat those tuples
      // as points, not as a flattened list of y-values. Tuple elements remain intact
      // in MathJSON, so each coordinate can be evaluated independently.
      const tupleItems = (node) => Array.isArray(node) && ["Tuple", "Vector"].includes(String(node[0])) && node.length === 3
        ? [node[1], node[2]] : null;
      if (!hadTopLevelRelation && visibleCamera && Array.isArray(rightTuple) && String(rightTuple[0]) === "List") {
        const children = rightTuple.slice(1);
        if (children.length && children.every((child) => tupleItems(child))) {
          const points = [];
          for (const child of children) {
            const pair = tupleItems(child);
            const x = evalFiniteScalar(pair[0]), y = evalFiniteScalar(pair[1]);
            if (x !== null && y !== null && x >= visibleCamera.xMin && x <= visibleCamera.xMax
              && y >= visibleCamera.yMin && y <= visibleCamera.yMax) points.push({ x, y });
          }
          console.log("[plotter:point-set] expanded spread/comprehension points", { source, tupleCount: children.length, pointsFound: points.length });
          return [{ relation: "=", pointSet: true, points }];
        }
      }

      const containsGraphVariable = (node, name) => {
        if (astSymbolName(node) === name) return true;
        return Array.isArray(node) && node.slice(1).some((child) => containsGraphVariable(child, name));
      };
      const referencedPiecewiseNames = (node, found = new Set()) => {
        const symbol = astSymbolName(node);
        if (symbol !== null && context.piecewise.has(symbol)) found.add(symbol);
        if (Array.isArray(node)) node.slice(1).forEach((child) => referencedPiecewiseNames(child, found));
        return found;
      };
      const dependsOnGraphAxes = (node) => {
        if (containsGraphVariable(node, "x") || containsGraphVariable(node, "y")) return true;
        for (const name of referencedPiecewiseNames(node)) {
          for (const branch of context.piecewise.get(name) || []) {
            if (containsGraphVariable(branch.outputAst, "x") || containsGraphVariable(branch.outputAst, "y")
              || containsGraphVariable(branch.conditionAst, "x") || containsGraphVariable(branch.conditionAst, "y")) return true;
          }
        }
        return false;
      };
      // A bare parenthesized pair is a point, not a two-item list of y-values.
      // Constant coordinates are evaluated directly. Piecewise coordinates that
      // depend on x/y are handled by the camera-bounded enumeration below.
      if (!hadTopLevelRelation && visibleCamera && isPairSyntax(source)
        && isListAst(rightTuple) && rightTuple.length === 3) {
        const pointUsesGraphAxes = dependsOnGraphAxes(rightTuple[1]) || dependsOnGraphAxes(rightTuple[2]);
        if (!pointUsesGraphAxes) {
          const pointX = evalFiniteScalar(rightTuple[1]);
          const pointY = evalFiniteScalar(rightTuple[2]);
          const points = pointX !== null && pointY !== null
            && pointX >= visibleCamera.xMin && pointX <= visibleCamera.xMax
            && pointY >= visibleCamera.yMin && pointY <= visibleCamera.yMax
            ? [{ x: pointX, y: pointY }] : [];
          console.log("[plotter:point] evaluated coordinate tuple", {
            source, point: pointX !== null && pointY !== null ? { x: pointX, y: pointY } : null,
            visible: points.length > 0, camera: visibleCamera,
          });
          return [{ relation: "=", pointSet: true, points }];
        }
        console.log("[plotter:point] dynamic tuple; enumerating only current camera", { source });
      }

      // Coordinate assignment (x,y)=(a,b) represents the two constraints x=a and y=b;
      // in a 2-D graph their intersection is drawn as a crosshair.
      if (relation === "=" && visibleCamera && tupleHasXY && isPairSyntax(rightSource)
        && isListAst(rightTuple) && rightTuple.length === 3
        && !dependsOnGraphAxes(rightTuple[1]) && !dependsOnGraphAxes(rightTuple[2])) {
        const crossX = evalFiniteScalar(rightTuple[1]);
        const crossY = evalFiniteScalar(rightTuple[2]);
        if (crossX !== null && crossY !== null) {
          console.log("[plotter:cross] coordinate assignment", { source, x: crossX, y: crossY });
          return [
            { relation: "=", axis: "x", constant: crossX },
            { relation: "=", axis: "y", constant: crossY },
          ];
        }
        console.log("[plotter:cross] could not evaluate coordinate assignment", { source, rightTuple });
      }

      const isCoordinateAssignment = relation === "=" && visibleCamera && tupleHasXY
        && isPairSyntax(rightSource) && isListAst(rightTuple) && rightTuple.length === 3;
      const isBareDynamicPoint = !hadTopLevelRelation && visibleCamera && isPairSyntax(source)
        && isListAst(rightTuple) && rightTuple.length === 3;
      if (visibleCamera && isListAst(rightTuple) && rightTuple.length === 3
        && (isCoordinateAssignment || isBareDynamicPoint)) {
        console.log("[plotter:point-set] tuple equation inspected", {
          source,
          camera: { xMin: visibleCamera.xMin, xMax: visibleCamera.xMax, yMin: visibleCamera.yMin, yMax: visibleCamera.yMax },
          leftTuple,
          rightTuple,
        });
        const markers = new Set([
          ...referencedPiecewiseNames(rightTuple[1]),
          ...referencedPiecewiseNames(rightTuple[2]),
        ]);
        const activeBranches = [...markers].flatMap((name) => context.piecewise.get(name) || []);
        const activeConditions = activeBranches.map((branch) => branch.conditionAst);
        // Both a branch predicate and its output can depend on a graph variable.
        // Include both when choosing the camera-limited candidate dimensions.
        const usesX = activeBranches.some((branch) =>
          containsGraphVariable(branch.conditionAst, "x") || containsGraphVariable(branch.outputAst, "x"));
        const usesY = activeBranches.some((branch) =>
          containsGraphVariable(branch.conditionAst, "y") || containsGraphVariable(branch.outputAst, "y"));
        console.log("[plotter:point-set] piecewise conditions analyzed", {
          referencedPiecewiseNames: [...markers], conditionCount: activeConditions.length, usesX, usesY,
          conditionAst: activeConditions,
          outputAst: activeBranches.map((branch) => branch.outputAst),
          coordinateAssignment: isCoordinateAssignment,
        });
        if (markers.size && (usesX || usesY)) {
          const minX = Math.ceil(visibleCamera.xMin - 1e-10);
          const maxX = Math.floor(visibleCamera.xMax + 1e-10);
          const minY = Math.ceil(visibleCamera.yMin - 1e-10);
          const maxY = Math.floor(visibleCamera.yMax + 1e-10);
          const spanX = usesX ? Math.max(0, maxX - minX + 1) : 1;
          const spanY = usesY ? Math.max(0, maxY - minY + 1) : 1;
          const screenW = Math.max(1, Math.ceil(visibleCamera.width || 800));
          const screenH = Math.max(1, Math.ceil(visibleCamera.height || 600));
          const budget = Math.min(24000, Math.max(1200, screenW * screenH * 0.04));
          const pointSetStartedAt = performance.now();
          console.log("[plotter:point-set] camera-limited search starting", {
            integerBounds: { minX, maxX, minY, maxY }, candidateSpans: { spanX, spanY },
            canvasPixels: { width: screenW, height: screenH }, candidateBudget: budget,
          });
          const probeXs = [...new Set([minX, 0, maxX].filter((value) => value >= minX && value <= maxX))];
          console.log("[plotter:point-set] condition probes", probeXs.map((probeX) => ({
            x: probeX, y: 0,
            conditions: activeConditions.map((condition) => {
              let value;
              try { value = evaluator.evaluate(condition, { x: probeX, y: 0 }); }
              catch (error) { value = `ERROR: ${String(error)}`; }
              return { ast: condition, value, accepted: asBoolean(value) };
            }),
          })));

          // If integer x-points are much closer than a screen pixel and all share
          // one constant y, represent the dense row directly instead of generating
          // a gigantic array of off-screen-resolution points.
          const astUsesXY = (node) => containsGraphVariable(node, "x") || containsGraphVariable(node, "y");
          if (usesX && !usesY && spanX > screenW * 2 && !astUsesXY(rightTuple[2])) {
            try {
              const yValues = flattenList(evaluator.evaluate(rightTuple[2], { x: 0, y: 0 })).map(asNumber).filter(Number.isFinite);
              if (yValues.length === 1 && yValues[0] >= visibleCamera.yMin && yValues[0] <= visibleCamera.yMax) {
                console.log("[plotter:point-set] using dense-row shortcut", {
                  y: yValues[0], visibleIntegerXCount: spanX, canvasWidth: screenW,
                  elapsedMs: +(performance.now() - pointSetStartedAt).toFixed(2),
                });
                return [{ relation, pointSet: true, points: [], denseY: yValues[0] }];
              }
            } catch { /* fall through to bounded point sampling */ }
          }

          // Candidate enumeration is tied to the visible camera and has a strict
          // pixel-derived work budget. For very wide views, stride both axes rather
          // than accidentally spending forever evaluating a huge integer lattice.
          const stride = Math.max(1, Math.ceil(Math.sqrt((spanX * spanY) / budget)));
          const makeCandidates = (min, max, active) => {
            if (!active) return [0];
            const values = [];
            for (let value = min; value <= max && values.length < budget; value += stride) values.push(value);
            if (values.length && values[values.length - 1] !== max && values.length < budget) values.push(max);
            return values;
          };
          const xs = makeCandidates(minX, maxX, usesX);
          const ys = makeCandidates(minY, maxY, usesY);
          const totalCandidatePairs = xs.length * ys.length;
          console.log("[plotter:point-set] candidate grid prepared", {
            stride, xCandidates: xs.length, yCandidates: ys.length, totalCandidatePairs,
            withinBudget: totalCandidatePairs <= budget,
          });
          const points = [];
          const seen = new Set();
          const xCoordinates = new Set();
          const yCoordinates = new Set();
          let candidatePairsEvaluated = 0;
          let nextProgressLog = 5000;
          for (const x of xs) {
            for (const y of ys) {
              candidatePairsEvaluated++;
              const vars = { x, y };
              let xValues, yValues;
              try {
                xValues = flattenList(evaluator.evaluate(rightTuple[1], vars)).map(asNumber).filter(Number.isFinite);
                yValues = flattenList(evaluator.evaluate(rightTuple[2], vars)).map(asNumber).filter(Number.isFinite);
              } catch { continue; }
              for (const px of xValues) {
                if (px < visibleCamera.xMin || px > visibleCamera.xMax) continue;
                if (isCoordinateAssignment) xCoordinates.add(px);
                for (const py of yValues) {
                  if (py < visibleCamera.yMin || py > visibleCamera.yMax) continue;
                  if (isCoordinateAssignment) yCoordinates.add(py);
                  else {
                    const key = `${px}\u0000${py}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    points.push({ x: px, y: py });
                  }
                }
              }
              if (candidatePairsEvaluated >= nextProgressLog) {
                console.log("[plotter:point-set] evaluation progress", {
                  evaluated: candidatePairsEvaluated, total: totalCandidatePairs,
                  pointsFound: points.length, elapsedMs: +(performance.now() - pointSetStartedAt).toFixed(2),
                });
                nextProgressLog += 5000;
              }
            }
          }
          console.log("[plotter:point-set] search completed", {
            candidatePairsEvaluated, totalCandidatePairs,
            pointsFound: points.length,
            xCoordinatesFound: xCoordinates.size,
            yCoordinatesFound: yCoordinates.size,
            elapsedMs: +(performance.now() - pointSetStartedAt).toFixed(2),
          });
          if (isCoordinateAssignment) {
            // A coordinate assignment means x=a AND y=b: render both constraints
            // as axis-aligned lines, so their intersections are visible crosses.
            const crossComponents = [
              ...[...xCoordinates].sort((a, b) => a - b).map((constant) => ({ relation: "=", axis: "x", constant })),
              ...[...yCoordinates].sort((a, b) => a - b).map((constant) => ({ relation: "=", axis: "y", constant })),
            ];
            console.log("[plotter:cross] dynamic coordinate assignment converted to crosshairs", {
              verticalLines: xCoordinates.size,
              horizontalLines: yCoordinates.size,
              source,
            });
            return crossComponents;
          }
          return [{ relation, pointSet: true, points }];
        }
      }

      // List-valued axis expressions are drawn as direct lines, not pixel grids.
      // Resolve literal lists and list-returning variables/functions once here.
      if (relation === "=" && visibleCamera) {
        const isAxis = (expression, name) => astSymbolName(expression) === name;
        // Must look inside piecewise branches too: a `__pw_N` marker hides
        // x/y dependence in its conditions and outputs, so `y={x>5:x,0}` is
        // NOT a constant list and must be sampled over the grid.
        const dependsOnGraphVariable = (node) => dependsOnGraphAxes(node);
        let axis = null, valueAst = null;
        const leftAxis = ["x", "y"].find((name) => isAxis(leftExpr.json, name));
        const rightAxis = ["x", "y"].find((name) => isAxis(rightExpr.json, name));
        if (leftAxis) {
          axis = leftAxis; valueAst = rightExpr.json;
        } else if (rightAxis) {
          axis = rightAxis; valueAst = leftExpr.json;
        }
        if (axis && valueAst && !dependsOnGraphVariable(valueAst)) {
          let values = staticNumericOutputs(valueAst, ce);
          if (values === null) {
            try {
              const evaluated = evaluator.evaluate(valueAst, { x: 0, y: 0 });
              const flattened = flattenList(evaluated).map(asNumber);
              if (flattened.length && flattened.every(Number.isFinite)) values = flattened;
            } catch { /* keep normal plotting as fallback */ }
          }
          if (values && values.length) {
            const min = axis === "x" ? visibleCamera.xMin : visibleCamera.yMin;
            const max = axis === "x" ? visibleCamera.xMax : visibleCamera.yMax;
            return values.filter((value) => Number.isFinite(value) && value >= min && value <= max)
              .map((constant) => ({ relation, condition: null, axis, constant, run: () => 0 }));
          }
        }
      }

      // Integer-lattice relations (x in Z, y in Z, floor(x)=x ...) describe isolated
      // points that a pixel grid can almost never hit. Enumerate the integer
      // candidates inside the camera instead: O(points on screen), compiled
      // predicates only, no grid sampling at all.
      if (relation === "=" && visibleCamera) {
        const latticeAxes = new Set();
        const scanLattice = (node) => {
          if (!Array.isArray(node)) return;
          const op = String(node[0]);
          if (op === "Element" || op === "NotElement") {
            const name = astSymbolName(node[1]), set = astSymbolName(node[2]);
            if ((name === "x" || name === "y") && ["Integers", "NonNegativeIntegers", "PositiveIntegers"].includes(set)) latticeAxes.add(name);
          } else if (op === "Equal" && Array.isArray(node[1]) && String(node[1][0]) === "Floor") {
            const name = astSymbolName(node[2]);
            if ((name === "x" || name === "y") && astSymbolName(node[1][1]) === name) latticeAxes.add(name);
          }
          node.slice(1).forEach(scanLattice);
        };
        scanLattice(ast);
        for (const branches of context.piecewise.values()) {
          for (const branch of branches) { scanLattice(branch.conditionAst); scanLattice(branch.outputAst); }
        }
        if (latticeAxes.size) {
          const budget = 20000;
          const intRange = (lo, hi, count) => {
            const first = Math.ceil(lo - 1e-9), last = Math.floor(hi + 1e-9);
            const span = Math.max(0, last - first + 1);
            const stride = Math.max(1, Math.ceil(span / count));
            const out = [];
            for (let v = first; v <= last && out.length < count; v += stride) out.push(v);
            return out;
          };
          const inView = (px, py) => px >= visibleCamera.xMin && px <= visibleCamera.xMax
            && py >= visibleCamera.yMin && py <= visibleCamera.yMax;
          const explicitAxis = ["x", "y"].find((name) => astSymbolName(leftExpr.json) === name || astSymbolName(rightExpr.json) === name);
          const valueNode = explicitAxis ? (astSymbolName(leftExpr.json) === explicitAxis ? rightExpr.json : leftExpr.json) : null;
          const otherAxis = explicitAxis === "y" ? "x" : "y";
          const points = [];
          const started = performance.now();
          if (explicitAxis && !containsGraphVariable(valueNode, explicitAxis)
            && latticeAxes.size === 1 && latticeAxes.has(otherAxis)) {
            // y = f(x) (or x = f(y)) where the free variable must be an integer.
            const range = visibleCamera[otherAxis === "x" ? "xMin" : "yMin"];
            const candidates = intRange(range, visibleCamera[otherAxis === "x" ? "xMax" : "yMax"], budget);
            for (const t of candidates) {
              const vars = otherAxis === "x" ? { x: t, y: 0 } : { x: 0, y: t };
              let values;
              try { values = flattenList(evaluator.evaluate(valueNode, vars)).map(asNumber); } catch { continue; }
              for (const v of values) {
                if (!Number.isFinite(v)) continue;
                const px = explicitAxis === "x" ? v : t, py = explicitAxis === "y" ? v : t;
                if (inView(px, py)) points.push({ x: px, y: py });
              }
            }
          } else if (latticeAxes.size === 2) {
            // Both coordinates are integers: test each lattice point exactly.
            const spanX = Math.max(1, Math.floor(visibleCamera.xMax) - Math.ceil(visibleCamera.xMin) + 1);
            const spanY = Math.max(1, Math.floor(visibleCamera.yMax) - Math.ceil(visibleCamera.yMin) + 1);
            const per = Math.max(1, Math.floor(Math.sqrt(budget)));
            const xs = intRange(visibleCamera.xMin, visibleCamera.xMax, Math.min(spanX, Math.max(per, Math.floor(budget / Math.min(spanY, per)))));
            const ys = intRange(visibleCamera.yMin, visibleCamera.yMax, Math.min(spanY, Math.max(per, Math.floor(budget / Math.min(spanX, per)))));
            const width = Math.min(8, maxOutputWidth(ast, context.piecewise));
            for (const x of xs) for (const y of ys) {
              const vars = { x, y };
              for (let i = 0; i < width; i++) {
                const f = asNumber(evaluator.evaluateAt(ast, vars, i));
                if (Number.isFinite(f) && Math.abs(f) < 1e-9) { points.push({ x, y }); break; }
              }
            }
          } else {
            latticeAxes.clear();
          }
          if (latticeAxes.size) {
            console.log("[plotter:lattice] enumerated integer lattice", {
              source, axes: [...latticeAxes], points: points.length,
              elapsedMs: +(performance.now() - started).toFixed(2),
            });
            return [{ relation: "=", pointSet: true, points }];
          }
        }
      }

      // Probe once for functions whose output is a list but whose call AST doesn't
      // contain a literal List node. Structural width remains the fallback.
      let outputCount = maxOutputWidth(ast, context.piecewise);
      try {
        const probe = flattenList(evaluator.evaluate(ast, { x: 0, y: 0 }));
        if (probe.length > outputCount && probe.every((value) => Number.isFinite(asNumber(value)))) outputCount = probe.length;
      } catch { /* use structural width */ }

      // y = f(x) (or x = g(y)) only needs ONE evaluation per column (or row), not
      // one per pixel. Mark such components so the sampler can fill the grid from
      // a 1-D table: roughly cols*rows / cols = `rows` times fewer evaluations.
      const dependsOnVar = (node, name) => {
        if (containsGraphVariable(node, name)) return true;
        for (const marker of referencedPiecewiseNames(node)) {
          for (const branch of context.piecewise.get(marker) || []) {
            if (containsGraphVariable(branch.outputAst, name) || containsGraphVariable(branch.conditionAst, name)) return true;
          }
        }
        return false;
      };
      let explicitInfo = null;
      for (const axisName of ["y", "x"]) {
        const freeName = axisName === "y" ? "x" : "y";
        const leftIs = astSymbolName(leftExpr.json) === axisName;
        const rightIs = astSymbolName(rightExpr.json) === axisName;
        if (leftIs === rightIs) continue;
        const valueNode = leftIs ? rightExpr.json : leftExpr.json;
        if (dependsOnVar(valueNode, axisName)) continue;
        explicitInfo = { axis: axisName, free: freeName, sign: leftIs ? 1 : -1, valueNode };
        break;
      }

      const directScalar = outputCount === 1 && !evaluator.containsPiecewise(ast) && !evaluator.containsList(ast)
        ? evaluator.scalar(ast) : null;
      // Plain-JS version of the same scalar when the expression is simple enough. It is
      // only used for finite results; everything else falls through to Compute Engine.
      const nativeCompilation = directScalar ? compileNativeScalar(ast) : null;
      const nativeScalar = nativeCompilation?.compiled || null;

      return Array.from({ length: outputCount }, (_, index) => ({
        relation, condition: null,
        explicit: explicitInfo ? {
          axis: explicitInfo.axis, sign: explicitInfo.sign,
          value: (t) => {
            const vars = explicitInfo.free === "x" ? { x: t, y: 0 } : { x: 0, y: t };
            const v = asNumber(evaluator.evaluateAt(explicitInfo.valueNode, vars, index));
            return Number.isFinite(v) ? v : NaN;
          },
        } : null,
        run: directScalar ? (vars) => {
          if (nativeScalar) {
            const native = nativeScalar(vars.x, vars.y);
            if (typeof native === "number" && Number.isFinite(native)) return native;
          }
          const value = directScalar(vars, compilation);
          if (typeof value === "number" && Number.isFinite(value)) return value;
          const slow = asNumber(evaluator.evaluateAt(ast, vars, index));
          return Number.isFinite(slow) ? slow : NaN;
        } : (vars) => {
          const value = asNumber(evaluator.evaluateAt(ast, vars, index));
          return Number.isFinite(value) ? value : NaN;
        },
      }));
    }

    const sampleInline = async function sampleInline(message, isCancelled) {
      const { id, key, source, definitions = [], width, height, camera, step = 2 } = message;
      const sampleStartedAt = performance.now();
      const compilation = {
        symbolicEvaluationCount: 0,
        fallbackReason: "",
        nativeScalarCompileAttempts: 0,
        nativeScalarCompileSuccesses: 0,
      };
      console.log("[plotter:sample] started", { equationId: id, source, canvas: { width, height }, camera, step });
      try {
        if (isCancelled()) {
          console.log("[plotter:sample] cancelled before parsing", { equationId: id });
          return null;
        }
        const ce = acquireEngine(definitions);
        const knownNames = definitions.map((def) => def.name).filter(Boolean);
        declareAxisSymbols(ce);
        const components = getCompiledComponents(ce, source, knownNames, { ...camera, width, height }, definitions, compilation);
        console.log("[plotter:sample] components prepared", {
          equationId: id, componentCount: components.length,
          pointSetComponents: components.filter((component) => component.pointSet).length,
          pointCounts: components.filter((component) => component.pointSet).map((component) => component.points?.length ?? 0),
          denseRows: components.filter((component) => Number.isFinite(component.denseY)).length,
          elapsedMs: +(performance.now() - sampleStartedAt).toFixed(2),
        });
        const cols = Math.ceil(width / step) + 1;
        const rows = Math.ceil(height / step) + 1;
        const xs = new Float64Array(cols);
        const ys = new Float64Array(rows);
        for (let c = 0; c < cols; c++) xs[c] = Math.min(c * step, width);
        for (let r = 0; r < rows; r++) ys[r] = Math.min(r * step, height);
        const buffers = components.map((component) => ({
          relation: component.relation,
          axis: component.axis || null,
          constant: Number.isFinite(component.constant) ? component.constant : null,
          pointSet: Boolean(component.pointSet),
          points: component.points || [],
          denseY: Number.isFinite(component.denseY) ? component.denseY : null,
          values: (component.axis || component.pointSet) ? new Float64Array(0) : new Float64Array(cols * rows),
        }));
        let evaluationsSinceYield = 0;
        let totalGridEvaluations = 0;
        let nextGridProgressLog = 30000;

        for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
          const component = components[componentIndex];
          if (component.axis === "x" || component.axis === "y" || component.pointSet) continue;
          const values = buffers[componentIndex].values;
          if (component.explicit) {
            // One evaluation per column (y=f(x)) or per row (x=g(y)).
            const { axis, sign, value: evaluateValue } = component.explicit;
            const count = axis === "y" ? cols : rows;
            const table = new Float64Array(count);
            for (let i = 0; i < count; i++) {
              const t = axis === "y"
                ? camera.xMin + (xs[i] / Math.max(1, width)) * (camera.xMax - camera.xMin)
                : camera.yMax - (ys[i] / Math.max(1, height)) * (camera.yMax - camera.yMin);
              table[i] = evaluateValue(t);
              if ((i & 63) === 63) {
                await yieldToEventLoop();
                if (isCancelled()) return null;
              }
            }
            for (let r = 0; r < rows; r++) {
              const y = camera.yMax - (ys[r] / Math.max(1, height)) * (camera.yMax - camera.yMin);
              const rowStart = r * cols;
              for (let c = 0; c < cols; c++) {
                const x = camera.xMin + (xs[c] / Math.max(1, width)) * (camera.xMax - camera.xMin);
                const fv = axis === "y" ? table[c] : table[r];
                values[rowStart + c] = axis === "y" ? sign * (y - fv) : sign * (x - fv);
              }
            }
            totalGridEvaluations += count;
            continue;
          }
          for (let r = 0; r < rows; r++) {
            if (isCancelled()) return null;
            const y = camera.yMax - (ys[r] / Math.max(1, height)) * (camera.yMax - camera.yMin);
            const rowStart = r * cols;
            for (let c = 0; c < cols; c++) {
              const x = camera.xMin + (xs[c] / Math.max(1, width)) * (camera.xMax - camera.xMin);
              values[rowStart + c] = component.run({ x, y });
              evaluationsSinceYield++;
              totalGridEvaluations++;
              // Bound uninterrupted work rather than yielding only between rows;
              // this also behaves well on unusually wide/short graph canvases.
              if (evaluationsSinceYield >= 3000) {
                evaluationsSinceYield = 0;
                await yieldToEventLoop();
                if (totalGridEvaluations >= nextGridProgressLog) {
                  console.log("[plotter:sample] grid evaluation progress", {
                    equationId: id, evaluated: totalGridEvaluations,
                    estimatedTotal: cols * rows * components.filter((item) => !item.axis && !item.pointSet).length,
                    elapsedMs: +(performance.now() - sampleStartedAt).toFixed(2),
                  });
                  nextGridProgressLog += 30000;
                }
                if (isCancelled()) {
                  console.log("[plotter:sample] cancelled during grid evaluation", {
                    equationId: id, evaluated: totalGridEvaluations,
                    elapsedMs: +(performance.now() - sampleStartedAt).toFixed(2),
                  });
                  return null;
                }
              }
            }
          }
        }
        if (isCancelled()) {
          console.log("[plotter:sample] cancelled before result", {
            equationId: id, evaluated: totalGridEvaluations,
            elapsedMs: +(performance.now() - sampleStartedAt).toFixed(2),
          });
          return null;
        }
        console.log("[plotter:sample] completed", {
          equationId: id, gridEvaluations: totalGridEvaluations,
          pointSetCounts: buffers.filter((component) => component.pointSet).map((component) => component.points.length),
          denseRows: buffers.filter((component) => Number.isFinite(component.denseY)).length,
          elapsedMs: +(performance.now() - sampleStartedAt).toFixed(2),
        });
        return {
          type: "sampled", id, key, cols, rows, step,
          components: buffers,
          compilation,
          error: "",
        };
      } catch (error) {
        console.error("[plotter:sample] failed", {
          equationId: id, elapsedMs: +(performance.now() - sampleStartedAt).toFixed(2), error,
        });
        if (isCancelled()) return null;
        return {
          type: "sampled", id, key,
          error: error instanceof Error ? error.message : String(error),
          components: [],
          compilation,
        };
      }
    };
    // The sampler's parser/evaluator helpers are also needed by expression previews,
    // definitions, and the structured piecewise editor. Export the shared helpers on
    // the returned sampler so both paths use the exact same parsing implementation.
    /** Build the engine for the common no-definitions case before the first request. */
    sampleInline.warmUp = () => { acquireEngine([]); };
    sampleInline.helpers = {
      findEnvironmentEnd,
      splitTopLevel,
      parseEnvironmentBranches,
      astSymbolName,
      transformPiecewise,
      createAstEvaluator,
      transformCollectionSyntax,
    };
    return sampleInline;
  }
