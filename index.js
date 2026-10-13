import { ComputeEngine, compile } from "@cortex-js/compute-engine";
import { prepareMathQuillLatex } from "./mathquill-latex.js";
import { centerCameraOn } from "./camera-geometry.js";
import {
  lowerIdenticallyEqualForGraph,
  normalizePiecewiseConditionEquivalence,
  normalizePiecewiseEquivalenceForDefinition,
} from "./plot-ast.js";
import {
  assertAssignmentOnlyEquals,
  equalityKeyAction,
  normalizeEqualityShorthand,
  normalizeMathQuillSpacing,
} from "./math-equality.js";

/** @typedef {import('@cortex-js/compute-engine').ComputeEngine} ComputeEngineInstance */
/** @typedef {import('@cortex-js/compute-engine').Expression} BoxedExpression */
/** @typedef {(variables?: Record<string, number>) => unknown} CompiledExpression */
/** @typedef {HTMLElement & {value: string, mathField: any, executeCommand: (command: any) => boolean}} MathFieldLike */

/**
 * @typedef {'graph' | 'variable' | 'function' | 'expression'} EquationKind
 * @typedef {Object} Equation
 * @property {number} id
 * @property {string} latex
 * @property {string} color
 * @property {boolean} enabled
 * @property {EquationKind} kind
 * @property {number|null} definitionValue
 * @property {string} [definitionPreview]
 * @property {{x:number,y:number}|null} [pointValue]
 * @property {string} [expressionValue]
 * @property {string} error
 * @property {boolean} fallback
 * @property {(x:number, y:number) => number} evaluate
 * @property {string} [name]
 * @property {string[]} [args]
 * @property {string} [rhs]
 * @property {string} [relation]
 * @property {{sampleKey:string,cols:number,rows:number,step:number,components:{relation:string,values:Float64Array}[]}} [sampleData]
 * @property {string} [sampleRequestedKey]
 * @property {string} [preparedKey]
 * @property {boolean} [preparedOk]
 * @property {HTMLCanvasElement} [renderLayer]
 * @property {string} [renderKey]
 */

window.addEventListener("DOMContentLoaded", async () => {
  /** @type {HTMLCanvasElement} */
  const canvas = document.querySelector("#graph");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D rendering is unavailable.");
  const hoverTooltip = document.createElement("div");
  hoverTooltip.setAttribute("role", "status");
  hoverTooltip.setAttribute("aria-live", "off");
  Object.assign(hoverTooltip.style, {
    position: "fixed", zIndex: "10", display: "none", pointerEvents: "none",
    padding: "6px 8px", border: "1px solid #d4d4d4", borderRadius: "5px",
    background: "rgba(255, 255, 255, 0.98)", color: "#333333",
    boxShadow: "0 3px 14px rgba(0,0,0,.16)",
    font: "12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "nowrap", backdropFilter: "blur(5px)",
  });
  document.body.append(hoverTooltip);
  const equationList = /** @type {HTMLDivElement} */ (document.querySelector("#equations"));
  const status = /** @type {HTMLDivElement} */ (document.querySelector("#status"));
  const autoCalculateToggle = /** @type {HTMLButtonElement} */ (document.querySelector("#autoCalculateToggle"));
  const calculateButton = /** @type {HTMLButtonElement} */ (document.querySelector("#calculateButton"));
  const addExpressionButton = /** @type {HTMLButtonElement} */ (document.querySelector("#addExpressionButton"));
  const cameraControlButton = /** @type {HTMLButtonElement} */ (document.querySelector("#cameraControlButton"));
  const cameraControlWindow = /** @type {HTMLElement} */ (document.querySelector("#cameraControlWindow"));
  const cameraControlClose = /** @type {HTMLButtonElement} */ (document.querySelector("#cameraControlClose"));
  const cameraCoordinateField = /** @type {HTMLElement} */ (document.querySelector("#cameraCoordinateField"));
  const cameraJumpButton = /** @type {HTMLButtonElement} */ (document.querySelector("#cameraJumpButton"));
  const cameraControlStatus = /** @type {HTMLDivElement} */ (document.querySelector("#cameraControlStatus"));

  // Keep the color picker outside the scrolling expression list so it is never
  // clipped by the list's overflow when it opens near the bottom of the panel.
  const colorPalette = document.createElement("div");
  colorPalette.className = "color-palette";
  colorPalette.setAttribute("role", "menu");
  colorPalette.setAttribute("aria-label", "Expression colors");
  colorPalette.hidden = true;
  document.body.append(colorPalette);
  /** @type {HTMLButtonElement|null} */
  let activeColorAnchor = null;
  function closeColorPalette() {
    colorPalette.hidden = true;
    activeColorAnchor = null;
  }
  function openColorPalette(anchor, equation, row) {
    colorPalette.replaceChildren();
    const title = document.createElement("div");
    title.className = "color-palette-title";
    title.textContent = "Expression color";
    colorPalette.append(title);
    COLORS.forEach((color, index) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "color-swatch";
      swatch.setAttribute("role", "menuitemradio");
      swatch.setAttribute("aria-checked", String(equation.color.toLowerCase() === color.toLowerCase()));
      swatch.setAttribute("aria-label", `Set expression color ${index + 1}`);
      swatch.title = `Color ${index + 1}`;
      if (equation.color.toLowerCase() === color.toLowerCase()) swatch.classList.add("selected");
      const dot = document.createElement("span");
      dot.style.setProperty("--swatch-color", color);
      swatch.append(dot);
      swatch.addEventListener("click", () => {
        equation.color = color;
        equation.renderKey = "";
        row.style.setProperty("--expression-color", color);
        const colorButton = row.querySelector(".equation-color");
        if (colorButton) {
          colorButton.style.setProperty("--expression-color", color);
          colorButton.style.backgroundColor = "#fff";
        }
        closeColorPalette();
        draw();
      });
      colorPalette.append(swatch);
    });
    activeColorAnchor = anchor;
    colorPalette.hidden = false;
    const anchorRect = anchor.getBoundingClientRect();
    const paletteRect = colorPalette.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - paletteRect.width - 8));
    let top = anchorRect.bottom + 5;
    if (top + paletteRect.height > window.innerHeight - 8) top = anchorRect.top - paletteRect.height - 5;
    colorPalette.style.left = `${left}px`;
    colorPalette.style.top = `${Math.max(8, top)}px`;
  }
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (colorPalette.hidden || colorPalette.contains(target)) return;
    if (activeColorAnchor && activeColorAnchor.contains(target)) return;
    closeColorPalette();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !colorPalette.hidden) {
      const returnFocus = activeColorAnchor;
      closeColorPalette();
      returnFocus?.focus();
    }
  });

  // MathQuill is loaded before this module by adaptive_plotter.html.
  const mathQuillGlobal = /** @type {any} */ (window).MathQuill;
  if (!mathQuillGlobal || typeof mathQuillGlobal.getInterface !== "function") {
    setStatus("MathQuill failed to load. Check the network connection and reload.", true);
    return;
  }
  const MQ = mathQuillGlobal.getInterface(2);
  let cameraMathField = null;

  // MathQuill can route keyboard and clipboard events through a hidden textarea
  // instead of the visible expression span. Remember the last field the user
  // interacted with, then resolve the field from focus state or the event target.
  let lastFocusedMathFieldElement = null;
  function isMathQuillHiddenInput(node) {
    return Boolean(node && (
      node.classList?.contains("mq-textarea")
      || node.closest?.(".mq-textarea")
      || (node.tagName === "TEXTAREA" && node.getAttribute("aria-hidden") === "true")
    ));
  }
  function getFocusedMathFieldElement(event = null) {
    const target = event?.target;
    const activeElement = document.activeElement;
    if (lastFocusedMathFieldElement?.isConnected
      && (isMathQuillHiddenInput(target) || isMathQuillHiddenInput(activeElement))) {
      return lastFocusedMathFieldElement;
    }
    const visiblyFocused = document.querySelector(".equation-preview.mq-focused");
    if (visiblyFocused?.mathField) {
      lastFocusedMathFieldElement = visiblyFocused;
      return visiblyFocused;
    }
    const targetInsideField = target?.closest?.(".equation-preview");
    if (targetInsideField?.mathField) {
      lastFocusedMathFieldElement = targetInsideField;
      return targetInsideField;
    }
    const activeInsideField = activeElement?.closest?.(".equation-preview");
    if (activeInsideField?.mathField) {
      lastFocusedMathFieldElement = activeInsideField;
      return activeInsideField;
    }
    // Some MathQuill builds park their hidden textarea outside the row.
    return null;
  }

  // Pointer focus is the most reliable signal for context-menu paste and for
  // browser/IME keyboard events that do not originate inside the visible span.
  document.addEventListener("pointerdown", (event) => {
    const field = event.target?.closest?.(".equation-row")?.querySelector?.(".equation-preview");
    if (field?.mathField) lastFocusedMathFieldElement = field;
    else if (!event.target?.closest?.(".color-palette")) lastFocusedMathFieldElement = null;
  }, true);
  document.addEventListener("focusin", (event) => {
    const field = event.target?.closest?.(".equation-preview");
    if (field?.mathField) lastFocusedMathFieldElement = field;
    else if (!isMathQuillHiddenInput(event.target)) lastFocusedMathFieldElement = null;
  }, true);

  // Turn standard LaTeX cases into the editor's supported brace + two-column
  // array notation. The plotter parser already understands this representation,
  // and using one form means multi-branch expressions remain visible and editable.
  function convertCasesForMathQuill(source) {
    let result = String(source ?? "");
    // Convert the innermost environment first so nested piecewise expressions
    // are also normalized instead of being skipped inside an already-converted
    // outer cases block.
    while (true) {
      const matches = [...result.matchAll(/\\begin\{(cases|dcases|rcases)\}/g)];
      const next = matches.at(-1);
      if (!next) break;
      const start = next.index;
      const token = next[0];
      const environment = next[1];
      const ending = findEnvironmentEnd(result, start, environment, token.length);
      if (!ending) break;
      const body = result.slice(ending.bodyStart, ending.bodyEnd);
      const replacement = String.raw`\left\{\begin{array}{ll}` + body + String.raw`\end{array}\right.`;
      result = result.slice(0, start) + replacement + result.slice(ending.end);
    }
    return result;
  }

  function stripClipboardMathDelimiters(source) {
    return String(source ?? "").trim()
      .replace(/^\$\$?\s*/, "")
      .replace(/\s*\$\$?$/, "")
      .replace(/^\s*\\\(\s*/, "")
      .replace(/\s*\\\)\s*$/, "")
      .replace(/^\s*\\\[\s*/, "")
      .replace(/\s*\\\]\s*$/, "")
      .trim();
  }

  // <paste-helpers>
  const SUPERSCRIPT_DIGITS = {
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+"
  };
  const UNICODE_MATH = {
    "−": "-", "‒": "-", "–": "-", "×": "\\cdot ", "⋅": "\\cdot ", "·": "\\cdot ",
    "∙": "\\cdot ", "÷": "\\div ", "≤": "\\le ", "≥": "\\ge ", "≠": "\\ne ",
    "≈": "\\approx ", "π": "\\pi ", "θ": "\\theta ", "φ": "\\phi ", "α": "\\alpha ",
    "β": "\\beta ", "γ": "\\gamma ", "δ": "\\delta ", "λ": "\\lambda ", "μ": "\\mu ",
    "σ": "\\sigma ", "ω": "\\omega ", "∞": "\\infty ", "∈": "\\in ", "∉": "\\notin ",
    "∧": "\\land ", "∨": "\\lor ", "¬": "\\neg ", "‘": "'", "’": "'",
    "“": "\"", "”": "\"", " ": " ", " ": " ", "​": "",
  };
  const NATIVE_LATEX_FUNCTIONS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh",
    "arcsin", "arccos", "arctan", "ln", "log", "exp", "min", "max", "arg", "det", "gcd", "lim"]);

  /** Index of the `)` that closes the `(` at openIndex, or -1. */
  function matchingParenIndex(text, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return i;
    }
    return -1;
  }

  /**
   * Plain text such as `x^10`, `sqrt(x)`, `sin(x)`, `a<=b`, `3*x`, `x²`, `π` has
   * no LaTeX in it, so MathQuill would show it as raw italic letters. Convert the
   * common forms to LaTeX first. Text that already contains a backslash is LaTeX
   * and is left exactly as copied.
   */
  function convertPlainMathText(source) {
    const isLatex = String(source).includes("\\");
    let text = normalizeEqualityShorthand(source);
    // Unicode symbols and ASCII comparison operators are never valid LaTeX, so
    // they are converted even inside a LaTeX paste (e.g. `x>=0` in a cases block).
    text = text.replace(/[⁰¹²³⁴-⁹⁺⁻]+/g,
      (run) => `^{${[...run].map((ch) => SUPERSCRIPT_DIGITS[ch]).join("")}}`);
    text = text.replace(/√\s*\(/g, "sqrt(")
      .replace(/√\s*([A-Za-z0-9.]+)/g, "\\sqrt{$1}");
    text = [...text].map((ch) => (Object.hasOwn(UNICODE_MATH, ch) ? UNICODE_MATH[ch] : ch)).join("");
    text = text.replace(/<=/g, "\\le ").replace(/>=/g, "\\ge ").replace(/!=/g, "\\ne ");
    // Everything below guesses what plain text means, so real LaTeX is left alone.
    if (isLatex) return text;
    text = text.replace(/\*\*/g, "^").replace(/\*/g, "\\cdot ");
    // x^10 -> x^{10},  x^-1 -> x^{-1},  x^(n+1) -> x^{n+1}
    text = text.replace(/\^\s*(-?\d+(?:\.\d+)?)/g, "^{$1}")
      .replace(/\^\s*\(([^()]*)\)/g, "^{$1}");
    // sqrt(...) with balanced (possibly nested) parentheses -> \sqrt{...}
    for (let guard = 0; guard < 200; guard++) {
      const match = /(?<![A-Za-z\\])sqrt\s*\(/.exec(text);
      if (!match) break;
      const open = match.index + match[0].length - 1;
      const close = matchingParenIndex(text, open);
      if (close < 0) break;
      text = `${text.slice(0, match.index)}\\sqrt{${text.slice(open + 1, close)}}${text.slice(close + 1)}`;
    }
    const functionNames = MATHQUILL_AUTO_OPERATOR_NAMES.split(/\s+/)
      .filter((name) => name.length > 1 && name !== "for" && name !== "sqrt")
      .sort((a, b) => b.length - a.length);
    const functionPattern = new RegExp(`(?<![A-Za-z\\\\{_])(${functionNames.join("|")})(?=\\s*\\()`, "gi");
    text = text.replace(functionPattern, (_m, name) => {
      const lower = name.toLowerCase();
      return NATIVE_LATEX_FUNCTIONS.has(lower) ? `\\${lower}` : `\\operatorname{${lower}}`;
    });
    text = text.replace(/(?<![A-Za-z\\])(pi|theta)(?![A-Za-z])/g, "\\$1 ");
    return text;
  }

  /** Square/round/curly balance and \begin/\end balance of a chunk of LaTeX. */
  function latexIsBalanced(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if ("({[".includes(text[i])) depth++;
      else if (")}]".includes(text[i])) depth--;
    }
    const begins = (text.match(/\\begin\s*\{/g) || []).length;
    const ends = (text.match(/\\end\s*\{/g) || []).length;
    return depth <= 0 && begins <= ends;
  }

  /**
   * One clipboard may hold several expressions, one per line (as copied from a
   * Desmos list, a notebook or a text file). Keep a multi-line construct such as
   * a cases/array block or an open parenthesis together as one expression.
   */
  function splitClipboardExpressions(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
    const grouped = [];
    let pending = "";
    for (const line of lines) {
      pending = pending ? `${pending} ${line}` : line;
      if (latexIsBalanced(pending)) { grouped.push(pending); pending = ""; }
    }
    if (pending) return lines; // never balanced: fall back to one expression per line
    return grouped;
  }

  /** Clipboard text -> list of LaTeX expressions ready for MathQuill. */
  function prepareClipboardExpressions(rawText) {
    const text = String(rawText ?? "").replace(/\t/g, " ");
    return splitClipboardExpressions(text)
      .map((chunk) => stripClipboardMathDelimiters(chunk))
      .filter(Boolean)
      .slice(0, 300)
      .map((chunk) => {
        const isLatex = chunk.includes("\\");
        const converted = convertPlainMathText(chunk);
        return isLatex ? converted : normalizeLatexSpacing(converted);
      })
      .map((chunk) => chunk.replace(/\\displaystyle\b/g, "").replace(/\\[dt]frac\b/g, "\\frac")
        .replace(/\s+/g, " ").trim())
      .map((chunk) => convertCasesForMathQuill(chunk))
      .filter(Boolean);
  }
  // </paste-helpers>

  document.addEventListener("copy", (event) => {
    const input = getFocusedMathFieldElement(event);
    const clipboard = event.clipboardData;
    if (!input || !clipboard || input.classList.contains("piecewise-editor")) return;
    const selection = input.querySelector(".mq-root-block > .mq-selection");
    if (!selection || selection.parentElement?.children.length !== 1) return;

    clipboard.setData("text/plain", input.value);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("paste", (event) => {
    const input = getFocusedMathFieldElement(event);
    const mathField = input?.mathField;
    const clipboard = event.clipboardData;
    if (!input || !mathField || !clipboard) return;

    // Plain text is the reliable clipboard format across browsers, and it is what
    // spreadsheets, notes and Desmos copy. Treat the field as a math editor and
    // insert through MathQuill so the caret and any selection are respected.
    const plain = clipboard.getData("text/plain");
    if (!plain?.trim()) return;
    const expressions = prepareClipboardExpressions(plain);
    if (!expressions.length) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const [first, ...rest] = expressions;
      // A pasted cases/array expression belongs in the multi-cell piecewise editor;
      // ordinary pasted LaTeX goes through MathQuill's caret-aware insertion API.
      if (/\\left\s*\\\{/.test(first) && /\\begin\{array\}/.test(first)) {
        input.value = first;
        input.focus();
      } else {
        const before = mathField.rawLatex();
        const prepared = prepareMathQuillLatex(first);
        mathField.write(prepared.latex);
        mathField.recordInsertion(before, mathField.rawLatex(), first);
        mathField.focus();
      }
      if (rest.length) insertPastedExpressionRows(input, rest);
    } catch (error) {
      console.warn("Could not insert pasted math:", error);
      setStatus(`Could not paste math: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }, true);
  let periodSequenceField = null;
  let periodSequenceCount = 0;
  let periodSequenceAt = 0;
  let equalitySequenceField = null;
  let equalitySequenceCount = 0;
  let equalitySequenceAt = 0;
  function resetPeriodSequence() {
    periodSequenceField = null;
    periodSequenceCount = 0;
    periodSequenceAt = 0;
  }
  function resetEqualitySequence() {
    equalitySequenceField = null;
    equalitySequenceCount = 0;
    equalitySequenceAt = 0;
  }
  document.addEventListener("pointerdown", resetPeriodSequence, true);
  document.addEventListener("click", resetPeriodSequence, true);
  document.addEventListener("pointerdown", resetEqualitySequence, true);
  document.addEventListener("click", resetEqualitySequence, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !cameraControlWindow.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeCameraControlWindow();
      return;
    }
    if (event.key === "Enter" && cameraCoordinateField.classList.contains("mq-focused")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      jumpToCameraTarget();
      return;
    }

    const input = getFocusedMathFieldElement(event);
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key) && event.key !== "=") {
      resetEqualitySequence();
    }
    if (event.key === "=" && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && input?.mathField) {
      const now = performance.now();
      equalitySequenceCount = equalitySequenceField === input && now - equalitySequenceAt < 900
        ? equalitySequenceCount + 1 : 1;
      equalitySequenceField = input;
      equalitySequenceAt = now;
      const action = equalityKeyAction(equalitySequenceCount);
      if (action !== "pass") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (action === "swallow") {
          resetEqualitySequence();
        } else {
          try {
            input.mathField.keystroke("Backspace");
            input.mathField.write(String.raw`\equiv`);
          } catch (error) {
            resetEqualitySequence();
            console.warn("Could not replace typed equality shorthand:", error);
          }
        }
        return;
      }
    }

    // Keep the old `product(` shorthand: a completed lowercase word becomes the
    // large product operator only when followed by a delimiter at the field end.
    // This intentionally does not rewrite names such as `productivity`.
    if (input?.mathField && ["(", " ", ")"].includes(event.key)) {
      const current = input.value;
      const productPattern = /(?:\\operatorname\{product\}|\\(?:text|mathrm)\{product\}|(?<![A-Za-z0-9_])product)$/;
      if (productPattern.test(current)) {
        try {
          input.value = current.replace(productPattern, String.raw`\prod`);
          input.mathField.moveToRightEnd();
        } catch (error) {
          console.warn("Could not convert product shorthand to \prod:", error);
        }
      }
    }

    // Replace three typed periods with MathQuill's actual ellipsis token before
    // the hidden textarea inserts a literal third dot. This also keeps the
    // serialized LaTeX as \ldots instead of a stray literal backslash.
    if (event.key === "." && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && input?.mathField) {
      const now = performance.now();
      periodSequenceCount = periodSequenceField === input && now - periodSequenceAt < 900
        ? periodSequenceCount + 1 : 1;
      periodSequenceField = input;
      periodSequenceAt = now;
      if (periodSequenceCount >= 3) {
        event.preventDefault();
        event.stopImmediatePropagation();
        resetPeriodSequence();
        try {
          input.mathField.keystroke("Backspace");
          input.mathField.keystroke("Backspace");
          input.mathField.write(String.raw`\ldots`);
        } catch (error) {
          console.warn("Could not replace three periods with an ellipsis:", error);
        }
        return;
      }
      return;
    }
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) resetPeriodSequence();

    if (event.key !== "Enter") return;
    const actions = input?.mathQuillActions;
    if (!actions) return;
    const action = event.shiftKey ? actions.shiftEnter : actions.enter;
    if (typeof action !== "function") return;

    // Intercept before MathQuill's internal key handling, since its hidden
    // textarea does not reliably bubble key events through the visible field.
    event.preventDefault();
    event.stopImmediatePropagation();
    action();
  }, true);

  /**
   * Assign arbitrary MathJSON values to user-defined variables. This helper is
   * intentionally in the outer DOMContentLoaded scope because both the sampler
   * and the expression editor's definition-preparation pass need to call it.
   * @param {ComputeEngineInstance} engine
   * @param {string} name
   * @param {BoxedExpression|number|undefined} value
   */
  function assignAnyDefinitionValue(engine, name, value) {
    engine.assign(name, value);
  }

  // Canonical MathJSON names for the most common lowercase function aliases.
  // MathQuill keeps the function text looking like Desmos while the parser maps
  // it to the Compute Engine's standard-library spelling.
  const LOWERCASE_FUNCTION_ALIASES = new Map(Object.entries({
    ln: "Ln", product: "Product", log2: "Log2", log10: "Log10", logbase: "Log", ceil: "Ceiling",
    stddev: "StandardDeviation", stdev: "StandardDeviation",
    standarddeviation: "StandardDeviation", populationstandarddeviation: "PopulationStandardDeviation",
    samplevariance: "SampleVariance", populationvariance: "PopulationVariance",
    stringjoin: "StringJoin", stringlength: "StringLength", tolowercase: "ToLowerCase",
    touppercase: "ToUpperCase", indexof: "IndexOf", loggamma: "LogGamma",
    logfactorial: "LogFactorial", sumofdigits: "SumOfDigits", productofsum: "ProductOfSum",
    eigenvalues: "Eigenvalues", eigenvectors: "Eigenvectors", matrixrank: "MatrixRank",
  }));

  const MATHQUILL_AUTO_OPERATOR_NAMES = [
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

  const SET_ALIASES = [
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
  function repairMalformedFunctionNotation(source) {
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

  function normalizeSpreadNotation(source) {
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
  function normalizeLatexSpacing(source) {
    return String(source)
      .replace(/(?<!\\)\\[ ,;:!]/g, " ")
      .replace(/(?<!\\)\\q?quad(?![A-Za-z])/g, " ");
  }

  // Strips ONLY MathQuill's presentation wrappers around colored brackets.
  // It intentionally does NOT fold spacing: `\ ` in the serialized LaTeX is
  // meaningful to MathQuill (a real space the user typed) and must be kept
  // in `equation.latex` and in exported JSON so it round-trips.
  function stripDelimiterDecoration(source) {
    return String(source)
      .replace(/\\mathopen\{\\textcolor\{#[0-9a-fA-F]{3,8}\}\{\\(?:big|Big|bigg|Bigg)l(\\\{|\[|\()\}\}/g,
        (_m, glyph) => glyph === "\\{" ? "\\{" : glyph)
      .replace(/\\mathclose\{\\textcolor\{#[0-9a-fA-F]{3,8}\}\{\\(?:big|Big|bigg|Bigg)r(\\\}|\]|\))\}\}/g,
        (_m, glyph) => glyph === "\\}" ? "\\}" : glyph);
  }

  function normalizeLatex(source, knownNames = [], allowGeneratedConditionEquality = false) {
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
    result = result.replace(/\\lbrack/g, "[");
    result = result.replace(/\\rbrack/g, "]");
    return result;
  }

  /**
   * All plotting evaluation lives on the main thread. Sampling yields regularly so
   * edits, panning, and page controls stay responsive; obsolete jobs self-cancel.
   */
  function createInlineSampler() {


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
          const command = source.slice(i).match(/^\\(?:leq?|geq?|neq|lt|gt)\b/);
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
        // Desmos-style branches are `condition: output, condition: output, default`.
        // The final bare expression is the fallback only when at least one colon
        // branch was seen; ordinary braces such as `{1,2,3}` remain sets.
        const colonParts = splitTopLevel(entry, ":");
        if (colonParts.length >= 2) {
          const condition = colonParts.shift();
          const output = colonParts.join(":").trim();
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
        return { outputAst: outputExpr.json, conditionAst: conditionExpr.json };
      });
      context.piecewise.set(name, prepared);
      return name;
    }

    function createAstEvaluator(ce, piecewise) {
      const compiledCache = new Map();
      const noPiecewiseCache = new Map();

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
        if (isListAst(ast) || ["Range", "RangeList", "SequenceRange"].includes(String(ast[0]))) return true;
        return ast.some((child, index) => index > 0 && containsList(child));
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
      function scalarEvaluator(ast) {
        if (ast !== null && typeof ast === "object" && evaluatorByNode.has(ast)) return evaluatorByNode.get(ast);
        const key = JSON.stringify(ast);
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
        let compiled = null;
        if (!usesMembership(compileAst) && !usesSet(compileAst)) {
          try { compiled = compile(boxedForCompile); } catch { /* use engine fallback */ }
        }
        const run = (vars) => {
          try {
            if (compiled?.success && typeof compiled.run === "function") {
              const result = runtimeValue(compiled.run(vars));
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
              const modulus = Math.abs(divisor);
              return ((dividend % modulus) + modulus) % modulus;
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
            }
          }
          return values;
        }
        if (!Array.isArray(ast)) {
          // Raw MathJSON symbol leaves must be resolved through the engine. Returning
          // the string "y" as a value makes broadcasted arithmetic produce NaN.
          return typeof ast === "string" ? scalarEvaluator(ast)(vars) : ast;
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
          const value = evaluator(vars);
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
          return scalarEvaluator(ast)(vars);
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
          return typeof ast === "string" ? scalarEvaluator(ast)(vars) : ast;
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
          const value = scalarEvaluator(ast)(vars);
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

      return { evaluate, evaluateAt, containsPiecewise };
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

      const loopMatch = result.match(/^(.*?)(?<![A-Za-z0-9_])for\s+(.+)$/is);
      if (loopMatch) {
        const body = loopMatch[1].trim();
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

    function getCompiledComponents(ce, source, knownNames, visibleCamera = null) {
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
      const evaluator = createAstEvaluator(ce, context.piecewise);

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
          const screenW = Math.max(1, Math.ceil(visibleCamera.width || canvasWidth || 800));
          const screenH = Math.max(1, Math.ceil(visibleCamera.height || canvasHeight || 600));
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
        run: (vars) => {
          const value = asNumber(evaluator.evaluateAt(ast, vars, index));
          return Number.isFinite(value) ? value : NaN;
        },
      }));
    }

    const sampleInline = async function sampleInline(message, isCancelled) {
      const { id, key, source, definitions = [], width, height, camera, step = 2 } = message;
      const sampleStartedAt = performance.now();
      console.log("[plotter:sample] started", { equationId: id, source, canvas: { width, height }, camera, step });
      try {
        if (isCancelled()) {
          console.log("[plotter:sample] cancelled before parsing", { equationId: id });
          return null;
        }
        const ce = createEngine(definitions);
        const knownNames = definitions.map((def) => def.name).filter(Boolean);
        ce.declare("x", "number");
        ce.declare("y", "number");
        const components = getCompiledComponents(ce, source, knownNames, { ...camera, width, height });
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
                await new Promise((resolve) => setTimeout(resolve, 0));
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
                await new Promise((resolve) => setTimeout(resolve, 0));
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
        };
      }
    };
    // The sampler's parser/evaluator helpers are also needed by expression previews,
    // definitions, and the structured piecewise editor. Export the shared helpers on
    // the returned sampler so both paths use the exact same parsing implementation.
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


  /** @type {ComputeEngineInstance} */
  let ce = new ComputeEngine();

  // Keep one world unit the same number of pixels on both axes.
  // The horizontal range stays at 20 units by default; the vertical range is
  // calculated from the graph canvas aspect ratio so circles and curves keep
  // their true shape instead of being stretched to fit the viewport.
  const DEFAULT_X_RANGE = 20;
  const camera = { xMin: -10, xMax: 10, yMin: -5, yMax: 5 };
  let hasInitializedView = false;
  const EXAMPLE = String.raw`\left(x^{2}+y^{2}-1\right)^{3}=x^{2}y^{3}`;
  const COLORS = ["#c74440", "#2d70b3", "#388c46", "#6042a6", "#fa7e19", "#000000", "#d33682", "#0097a7", "#8c6d31", "#666666", "#e07c91", "#4a8f9e", "#f2b134", "#74a4e8", "#7e57c2", "#2b8c64"];
  const SAMPLE_STEP = 2;
  const sampleInline = createInlineSampler();
  const {
    findEnvironmentEnd,
    splitTopLevel,
    parseEnvironmentBranches,
    astSymbolName,
    transformPiecewise,
    createAstEvaluator,
    transformCollectionSyntax,
  } = sampleInline.helpers;
  /** When false, the sampler runs only after the user presses Calculate current view. */
  let autoCalculate = true;
  /** Latest sample token for each expression. Older jobs observe the token change and stop. */
  const activeSamples = new Map();
  /** @type {Equation[]} */
  const equations = [];
  let nextId = 1;
  let canvasWidth = window.innerWidth;
  let canvasHeight = window.innerHeight;
  /** @type {{x:number,y:number,camera: typeof camera}|null} */
  let dragging = null;
  /** @type {number|ReturnType<typeof setTimeout>} */
  let wheelTimer = 0;
  /** @type {typeof camera|null} */
  let wheelBaseCamera = null;
  const renderCache = document.createElement("canvas");
  let renderCacheValid = false;
  let definitionSignature = null;
  let definitionRevision = 0;
  /** @type {Set<string>} */
  let knownDefinitionNames = new Set();
  /** @type {Set<string>} */
  let knownVariableNames = new Set();
  /** @type {{equation: Equation, row: HTMLDivElement, pointerId: number, targetEquation: Equation, insertAfter: boolean}|null} */
  let activeRowDrag = null;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  function updateCalculationControls() {
    autoCalculateToggle.textContent = `Auto: ${autoCalculate ? "On" : "Off"}`;
    autoCalculateToggle.setAttribute("aria-label", `Automatic calculation ${autoCalculate ? "on" : "off"}`);
    autoCalculateToggle.setAttribute("aria-pressed", String(autoCalculate));
    autoCalculateToggle.classList.toggle("primary", autoCalculate);
    calculateButton.hidden = autoCalculate;
  }

  function currentViewKey() {
    return [
      canvas.width, canvas.height,
      camera.xMin, camera.xMax, camera.yMin, camera.yMax,
      definitionRevision,
    ].join("|");
  }

  function sampleKeyFor(equation, viewKey) {
    return `${viewKey}|${equation.preparedKey || equation.latex}|${definitionRevision}|${SAMPLE_STEP}`;
  }

  function isCurrentViewCalculated() {
    const viewKey = currentViewKey();
    return equations
      .filter((item) => item.enabled && item.kind === "graph" && !item.error && item.latex.trim())
      .every((item) => item.sampleData?.sampleKey === sampleKeyFor(item, viewKey));
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const oldYCenter = (camera.yMin + camera.yMax) * 0.5;
    const oldXRange = camera.xMax - camera.xMin;
    canvasWidth = canvas.clientWidth;
    canvasHeight = canvas.clientHeight;

    if (canvasWidth > 0 && canvasHeight > 0) {
      if (!hasInitializedView) {
        // Start centered on the origin, like a typical Desmos view.
        camera.xMin = -DEFAULT_X_RANGE * 0.5;
        camera.xMax = DEFAULT_X_RANGE * 0.5;
        const yRange = DEFAULT_X_RANGE * (canvasHeight / canvasWidth);
        camera.yMin = -yRange * 0.5;
        camera.yMax = yRange * 0.5;
        hasInitializedView = true;
      } else {
        // On viewport resize, preserve the horizontal zoom and vertical center,
        // changing the vertical span to keep x/y units at the same pixel scale.
        const yRange = oldXRange * (canvasHeight / canvasWidth);
        camera.yMin = oldYCenter - yRange * 0.5;
        camera.yMax = oldYCenter + yRange * 0.5;
      }
    }

    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderCacheValid = false;
    draw();
  }

  function toScreen(x, y) {
    return [
      ((x - camera.xMin) / (camera.xMax - camera.xMin)) * canvasWidth,
      canvasHeight - ((y - camera.yMin) / (camera.yMax - camera.yMin)) * canvasHeight,
    ];
  }

  function toWorld(px, py) {
    return [
      camera.xMin + (px / canvasWidth) * (camera.xMax - camera.xMin),
      camera.yMax - (py / canvasHeight) * (camera.yMax - camera.yMin),
    ];
  }

  function formatReadoutCoordinate(value) {
    if (!Number.isFinite(value) || Math.abs(value) < 5e-13) return "0";
    if (Math.abs(value) >= 1e8 || Math.abs(value) < 1e-6) return value.toExponential(6);
    return Number(value.toPrecision(8)).toString();
  }

  function hideHoverTooltip() {
    hoverTooltip.style.display = "none";
  }

  function showHoverTooltip(event, point) {
    hoverTooltip.textContent = `x = ${formatReadoutCoordinate(point.x)}    y = ${formatReadoutCoordinate(point.y)}`;
    hoverTooltip.style.display = "block";
    const gap = 14;
    const maxX = Math.max(8, window.innerWidth - hoverTooltip.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - hoverTooltip.offsetHeight - 8);
    hoverTooltip.style.left = `${Math.max(8, Math.min(maxX, event.clientX + gap))}px`;
    hoverTooltip.style.top = `${Math.max(8, Math.min(maxY, event.clientY + gap))}px`;
  }

  /** Project the cursor to a nearby implicit curve using a few Newton steps. */
  function projectToImplicit(equation, startX, startY) {
    const rangeX = camera.xMax - camera.xMin;
    const rangeY = camera.yMax - camera.yMin;
    const hx = Math.max(rangeX / Math.max(1, canvasWidth), 1e-9);
    const hy = Math.max(rangeY / Math.max(1, canvasHeight), 1e-9);
    let x = startX, y = startY;
    for (let iteration = 0; iteration < 8; iteration++) {
      const f = equation.evaluate(x, y);
      if (!Number.isFinite(f)) return null;
      const dxValue = equation.evaluate(x + hx, y);
      const dxValue2 = equation.evaluate(x - hx, y);
      const dyValue = equation.evaluate(x, y + hy);
      const dyValue2 = equation.evaluate(x, y - hy);
      if (![dxValue, dxValue2, dyValue, dyValue2].every(Number.isFinite)) return null;
      const gx = (dxValue - dxValue2) / (2 * hx);
      const gy = (dyValue - dyValue2) / (2 * hy);
      const norm = gx * gx + gy * gy;
      if (!Number.isFinite(norm) || norm < 1e-24) return null;
      let stepX = f * gx / norm;
      let stepY = f * gy / norm;
      const stepPixels = Math.hypot(stepX * canvasWidth / rangeX, stepY * canvasHeight / rangeY);
      if (stepPixels > 24) {
        const scale = 24 / stepPixels;
        stepX *= scale;
        stepY *= scale;
      }
      x -= stepX;
      y -= stepY;
      if (Math.hypot(stepX * canvasWidth / rangeX, stepY * canvasHeight / rangeY) < 0.025) break;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || x < camera.xMin || x > camera.xMax || y < camera.yMin || y > camera.yMax) return null;
    const [screenX, screenY] = toScreen(x, y);
    return { x, y, distance: Math.hypot(screenX - lastHoverPixel.x, screenY - lastHoverPixel.y) };
  }

  const lastHoverPixel = { x: 0, y: 0 };
  function updateHoverReadout(event) {
    if (dragging || canvasWidth <= 0 || canvasHeight <= 0) {
      hideHoverTooltip();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < 0 || py < 0 || px > canvasWidth || py > canvasHeight) {
      hideHoverTooltip();
      return;
    }
    lastHoverPixel.x = px;
    lastHoverPixel.y = py;
    const [worldX, worldY] = toWorld(px, py);
    const maxDistance = 10;
    let best = null;
    const consider = (x, y, distance) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(distance) || distance > maxDistance) return;
      if (!best || distance < best.distance) best = { x, y, distance };
    };
    const viewKey = currentViewKey();

    for (const equation of equations) {
      if (!equation.enabled || equation.error || !equation.latex.trim()) continue;
      if (equation.pointValue) {
        const [pointX, pointY] = toScreen(equation.pointValue.x, equation.pointValue.y);
        consider(equation.pointValue.x, equation.pointValue.y, Math.hypot(pointX - px, pointY - py));
      }
      if (equation.kind !== "graph") continue;
      const data = equation.sampleData;
      if (!data || data.sampleKey !== sampleKeyFor(equation, viewKey)) continue;
      let hasImplicitCurve = false;
      for (const component of data.components || []) {
        if (component.pointSet) {
          if (Number.isFinite(component.denseY)) {
            const pointY = toScreen(worldX, component.denseY)[1];
            consider(worldX, component.denseY, Math.abs(pointY - py));
          }
          for (const point of component.points || []) {
            const [pointX, pointY] = toScreen(point.x, point.y);
            consider(point.x, point.y, Math.hypot(pointX - px, pointY - py));
          }
          continue;
        }
        if ((component.axis === "x" || component.axis === "y") && Number.isFinite(component.constant)) {
          if (component.axis === "x") {
            const lineX = toScreen(component.constant, worldY)[0];
            consider(component.constant, worldY, Math.abs(lineX - px));
          } else {
            const lineY = toScreen(worldX, component.constant)[1];
            consider(worldX, component.constant, Math.abs(lineY - py));
          }
        } else {
          hasImplicitCurve = true;
        }
      }
      if (hasImplicitCurve && typeof equation.evaluate === "function") {
        const projected = projectToImplicit(equation, worldX, worldY);
        if (projected) consider(projected.x, projected.y, projected.distance);
      }
    }

    if (best) showHoverTooltip(event, best);
    else hideHoverTooltip();
  }

  /** Split a top-level equality/inequality without confusing LaTeX commands with relation tokens. */
  function splitEquation(latex) {
    latex = normalizeMathQuillSpacing(latex);
    let depth = 0;
    for (let i = 0; i < latex.length; i++) {
      // Skip complete environments so comparisons inside a cases condition
      // cannot be mistaken for the outer equation's relation.
      const environment = latex.slice(i).match(/^\\begin\{(cases|dcases|rcases|array|matrix|aligned)\}/);
      if (environment) {
        const endToken = `\\end{${environment[1]}}`;
        const end = latex.indexOf(endToken, i + environment[0].length);
        if (end >= 0) {
          i = end + endToken.length - 1;
          continue;
        }
      }
      const ch = latex[i];
      if (latex.startsWith("\\{", i)) { depth++; i++; continue; }
      if (latex.startsWith("\\}", i)) { depth = Math.max(0, depth - 1); i++; continue; }
      if (ch === "\\" && i + 1 < latex.length) {
        const command = latex.slice(i).match(/^\\(?:leq?|geq?|neq|lt|gt)\b/);
        if (command && depth === 0) {
          const token = command[0];
          const relation = token.startsWith("\\le") ? "<=" : token.startsWith("\\ge") ? ">=" : token === "\\neq" ? "!=" : token === "\\lt" ? "<" : ">";
          return [latex.slice(0, i).trim(), latex.slice(i + token.length).trim(), true, relation];
        }
        i++;
        continue;
      }
      if (ch === "{" && latex[i - 1] !== "\\") depth++;
      else if (ch === "}" && latex[i - 1] !== "\\") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (ch === "=" || ch === "<" || ch === ">")) {
        if ((ch === "<" || ch === ">") && latex[i + 1] === "=") {
          return [latex.slice(0, i).trim(), latex.slice(i + 2).trim(), true, ch + "="];
        }
        if (ch === "=" && (latex[i + 1] === "=" || latex[i - 1] === "=")) continue;
        return [latex.slice(0, i).trim(), latex.slice(i + 1).trim(), true, ch];
      }
    }
    return [latex.trim(), "", false, "="];
  }

  /** @param {string} source */
  function parseExpression(source, allowGeneratedConditionEquality = false) {
    let normalizedSource = String(source)
      .replace(/\\Reals\b/g, "\\mathbb{R}")
      .replace(/\\RealNumbers\b/g, "\\mathbb{R}")
      .replace(/\\Integers\b/g, "\\mathbb{Z}")
      .replace(/\\Naturals\b/g, "\\mathbb{N}")
      .replace(/\\Rationals\b/g, "\\mathbb{Q}")
      .replace(/\\Complexes\b/g, "\\mathbb{C}")
      // MathQuill can serialize vector/list delimiters using these aliases.
      // Normalize them before Compute Engine parsing, including in definitions.
      .replace(/\\left|\\right/g, "")
      .replace(/\\lbrack/g, "[")
      .replace(/\\rbrack/g, "]");
    const expr = ce.parse(normalizeLatex(
      normalizedSource,
      [...knownDefinitionNames],
      allowGeneratedConditionEquality,
    ));
    if (!expr || !expr.isValid) {
      throw new Error(`Could not parse “${source}”. Check the LaTeX syntax.`);
    }
    return expr;
  }

  /** Remove presentation-only LaTeX commands, while leaving meaningful symbols alone. */
  function compactLatex(source) {
    // Fold MathQuill's typed-space spellings (notably `\ `) before compacting.
    return normalizeSpreadNotation(normalizeLatexSpacing(source))
      .replace(/\\left|\\right/g, "")
      .replace(/\s+/g, "")
      .trim();
  }

  /**
   * While a user is typing `...a`, the field briefly contains a dangling ellipsis.
   * Keep that intermediate state quiet instead of surfacing a parser error every
   * time the user pauses after the third period. A following identifier, list,
   * parenthesized expression, or command means an operand has started.
   */
  function isIncompleteSpreadSource(source) {
    const compact = compactLatex(source);
    for (const match of compact.matchAll(/\.\.\./g)) {
      const next = compact[match.index + 3] || "";
      if (!/[A-Za-z_\\[(]/.test(next)) return true;
    }
    return false;
  }

  /**
   * Collection expressions (tuple spreads and list comprehensions) are expanded by
   * the sampler. Don't try to compile them as scalar functions beforehand: doing so
   * rejects their spread syntax before the camera-aware point renderer can process it.
   */
  function isCollectionExpansionSource(source) {
    const raw = String(source);
    if (/\\(?:text|operatorname|mathrm)\s*\{\s*for\s*\}|(?<![A-Za-z0-9_])for(?![A-Za-z0-9_])/i.test(raw)) return true;
    const compact = compactLatex(raw);
    if (!compact.startsWith("(") || !compact.endsWith(")")) return false;
    let depth = 0, start = 1;
    const fields = [];
    for (let i = 1; i < compact.length - 1; i++) {
      const ch = compact[i];
      if (ch === "\\" && i + 1 < compact.length) { i++; continue; }
      if ("([{ ".includes(ch) && ch !== " ") depth++;
      else if (")] }".includes(ch) && ch !== " ") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) {
        fields.push(compact.slice(start, i));
        start = i + 1;
      }
    }
    fields.push(compact.slice(start, -1));
    return fields.length >= 2 && fields.some((field) => field.startsWith("..."));
  }

  /** True for a standalone `(a,b)` coordinate pair, including spread fields. */
  function isPointTupleSource(source) {
    const normalized = compactLatex(String(source));
    if (!normalized.startsWith("(") || !normalized.endsWith(")")) return false;
    let depth = 0, outerClose = -1;
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (ch === "\\" && i + 1 < normalized.length) { i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { outerClose = i; break; }
      }
    }
    if (outerClose !== normalized.length - 1) return false;
    const inside = normalized.slice(1, -1);
    let nested = 0, commas = 0;
    for (let i = 0; i < inside.length; i++) {
      const ch = inside[i];
      if (ch === "\\" && i + 1 < inside.length) { i++; continue; }
      if (ch === "(" || ch === "[" || ch === "{") nested++;
      else if (ch === ")" || ch === "]" || ch === "}") nested = Math.max(0, nested - 1);
      else if (ch === "," && nested === 0) commas++;
    }
    return commas === 1;
  }

  /**
   * Read a function's left-hand side. Accepts f(x), f(x,y), and
   * \operatorname{custom}(x), as serialized by MathQuill.
   * @param {string} source
   * @returns {{name:string,args:string[]}|null}
   */
  function parseFunctionLhs(source) {
    const normalized = compactLatex(source);
    const match = normalized.match(/^(?:\\operatorname\{([A-Za-z][A-Za-z0-9]*)\}|\\mathrm\{([A-Za-z][A-Za-z0-9]*)\}|([A-Za-z][A-Za-z0-9]*))\(([^()]*)\)$/);
    if (!match) return null;
    const name = match[1] || match[2] || match[3];
    const argSource = match[4];
    if (!name || !argSource) return null;
    const args = argSource.split(",");
    if (args.some((arg) => !/^(?:[A-Za-z]|\\operatorname\{[A-Za-z][A-Za-z0-9]*\})$/.test(arg))) return null;
    if (new Set(args).size !== args.length) return null;
    return { name, args: args.map((arg) => arg.startsWith("\\operatorname{") ? arg.slice(14, -1) : arg) };
  }

  /**
   * Return the syntactic definition represented by a line, independent of whether
   * its right-hand side is currently valid or evaluable.
   * @param {string} latex
   * @returns {{kind: "variable", name: string, rhs: string, latex: string} | {kind: "function", name: string, args: string[], rhs: string, latex: string} | null}
   */
  function parseDefinitionSource(latex) {
    const [left, right, hasRelation, relation] = splitEquation(latex);
    if (!hasRelation || relation !== "=") return null;
    const fn = parseFunctionLhs(left);
    if (fn) return { kind: "function", ...fn, rhs: right, latex };
    const name = compactLatex(left);
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(name) && name !== "x" && name !== "y") {
      return { kind: "variable", name, rhs: right, latex };
    }
    return null;
  }

  /** Stable signature for only the rows that define shared names. */
  function getDefinitionSignature() {
    return JSON.stringify(equations.map((item) => {
      return parseDefinitionSource(item.latex) ? [item.id, item.latex] : null;
    }).filter(Boolean));
  }

  /** @param {string} name */
  function latexIdentifier(name) {
    return /^[A-Za-z]$/.test(name) ? name : `\\operatorname{${name}}`;
  }

  /**
   * Rewrite known multi-letter custom identifiers into explicit LaTeX operator
   * names, so a name like `offset` is not parsed as o*f*f*s*e*t.
   * @param {string} source
   * @param {Set<string>} knownNames
   */
  function normalizeKnownIdentifiers(source, knownNames) {
    let result = source;
    const names = [...knownNames].filter((name) => name.length > 1).sort((a, b) => b.length - a.length);
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Avoid replacing an identifier already wrapped in \operatorname{...} or \mathrm{...}.
      const pattern = new RegExp(`(?<![A-Za-z0-9_{}])${escaped}(?![A-Za-z0-9_])`, "g");
      result = result.replace(pattern, (match, offset, whole) => {
        const prefix = whole.slice(Math.max(0, offset - 14), offset);
        if (prefix.endsWith("\\operatorname{") || prefix.endsWith("\\mathrm{")) return match;
        return `\\operatorname{${match}}`;
      });
    }
    return result;
  }

  /**
   * Recognize a function call even when its arguments are numbers or expressions
   * (for example f(5), f(x^2), or f(g(x))). Such calls are value previews, not graphs.
   * @param {string} source
   */
  function isBareCallExpression(source) {
    const normalized = compactLatex(source);
    // Keep ordinary built-ins such as \sin(x) graphable as y=sin(x). Only
    // user-style identifiers and explicitly named custom operators are previews.
    if (normalized.startsWith("\\") && !normalized.startsWith("\\operatorname{") && !normalized.startsWith("\\mathrm{")) {
      return false;
    }
    return /^(?:\\operatorname\{[A-Za-z][A-Za-z0-9]*\}|\\mathrm\{[A-Za-z][A-Za-z0-9]*\}|[A-Za-z][A-Za-z0-9]*)\((.*)\)$/.test(normalized);
  }

  /** Normalize the common set-membership form before handing it to the engine. */
  function resolveRealMembership(source) {
    const match = String(source).match(/^(.+?)\s*\\in\s*(?:\\Reals|\\RealNumbers|\\mathbb\{R\})$/);
    if (!match) return null;
    try {
      const candidate = parseExpression(normalizeKnownIdentifiers(match[1], knownDefinitionNames));
      const value = numericRealValue(candidate);
      if (value !== null) return "\\top";
      const numeric = candidate.N();
      const real = Number(numeric.re), imaginary = Number(numeric.im);
      if (Number.isFinite(real) && Number.isFinite(imaginary)) return Math.abs(imaginary) < 1e-10 ? "\\top" : "\\bot";
    } catch { /* leave symbolic membership to the Compute Engine */ }
    return null;
  }

  /**
   * Classify a line. A bare custom call is a preview; a variable-free expression
   * is also a preview. Bare expressions involving x/y remain graphable.
   * @param {string} latex
   * @param {Set<string>} variableNames
   * @param {Set<string>} definitionNames
   */
  function classifyExpression(latex, variableNames = knownVariableNames, definitionNames = knownDefinitionNames) {
    const [left, right, hasEquals, relation] = splitEquation(latex);
    if (!left) return { kind: /** @type {const} */ ("graph"), latex };

    if (!hasEquals) {
      // Route static piecewise value expressions through our multi-match evaluator.
      // Compute Engine's native Piecewise stops at the first true branch, while the
      // plotter's Desmos-style brace syntax intentionally gathers every true output.
      try {
        const piecewiseContext = { ce, knownNames: definitionNames, piecewise: new Map(), nextPiecewiseIndex: 0 };
        const collectionSource = transformCollectionSyntax(left, ce, definitionNames);
        const piecewiseSource = transformPiecewise(collectionSource, piecewiseContext);
        if (piecewiseContext.piecewise.size) {
          const parsed = ce.parse(normalizeLatex(piecewiseSource, definitionNames));
          if (parsed?.isValid) {
            const unknowns = [...(parsed.unknowns || [])].map(String);
            const onlyKnownNames = unknowns.every((name) => variableNames.has(name)
              || definitionNames.has(name) || /^__pw_\d+$/.test(name));
            const containsGraphAxis = (ast) => {
              const symbol = astSymbolName(ast);
              return symbol === "x" || symbol === "y"
                || (Array.isArray(ast) && ast.slice(1).some(containsGraphAxis));
            };
            const axisDependentBranch = [...piecewiseContext.piecewise.values()].some((branches) => branches.some((branch) =>
              containsGraphAxis(branch.conditionAst) || containsGraphAxis(branch.outputAst)));
            if (!unknowns.includes("x") && !unknowns.includes("y") && onlyKnownNames && !axisDependentBranch) {
              return { kind: /** @type {const} */ ("expression"), latex };
            }
          }
        }
      } catch {
        // Invalid or variable-dependent piecewise input falls through to normal classification.
      }
      // Parenthesized coordinate pairs are graphable points even when their
      // coordinates are constants or named variables with no x/y dependency.
      if (isPointTupleSource(left)) return { kind: /** @type {const} */ ("graph"), latex, pointExpression: true };
      // Let the normal parser decide whether a custom call needs a value preview
      // or graph sampling: f(5) is a value, while f(x) depends on the graph axis.
      if (resolveRealMembership(left) !== null) return { kind: /** @type {const} */ ("expression"), latex };
      try {
        const normalized = normalizeKnownIdentifiers(left, definitionNames);
        const expression = parseExpression(normalized);
        const unknowns = [...(expression.unknowns || [])].map(String);
        const dependsOnGraphAxes = unknowns.includes("x") || unknowns.includes("y");
        // The preview is a symbolic/numeric value display, not a declaration
        // validator. Any valid expression independent of the graph axes can show
        // its evaluated value, including symbolic constants and not-yet-defined
        // names. Only x/y-dependent expressions belong on the graph by default.
        if (!dependsOnGraphAxes) {
          return { kind: /** @type {const} */ ("expression"), latex };
        }
      } catch {
        // Invalid and unresolved expressions still receive a useful graph-row error.
      }
      return { kind: /** @type {const} */ ("graph"), latex };
    }

    const definition = parseDefinitionSource(latex);
    if (definition) return definition;
    // A relation with no graph variables is a boolean/value expression (e.g. 42 in Reals).
    try {
      const whole = parseExpression(normalizeKnownIdentifiers(latex, definitionNames));
      const unknowns = [...(whole.unknowns || [])].map(String);
      // Relations without x/y are values (True/False or a symbolic relation),
      // even when they contain a symbol that has not been assigned yet.
      if (!unknowns.includes("x") && !unknowns.includes("y")) {
        return { kind: /** @type {const} */ ("expression"), latex };
      }
    } catch { /* an x/y relation below is a graph */ }
    return { kind: /** @type {const} */ ("graph"), latex, relation };
  }

  /** @param {string} source */
  function hasExplicitCubePower(source) {
    return /\^\s*(?:\{\s*3\s*\}|3(?![0-9]))/.test(source);
  }

  /** Convert numeric real results to display values, snapping floating-point zero noise. */
  function cleanRealNumber(value) {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) < 1e-12 ? 0 : value;
  }

  /**
   * Read real numerical results, including a complex result whose imaginary part
   * is effectively zero (e.g. e^(iπ)+1).
   * @param {BoxedExpression} expression
   * @returns {number|null}
   */
  function numericRealValue(expression) {
    // Some boxed symbols/assigned values remain unevaluated until evaluate() is
    // called explicitly. N() alone can therefore return the symbolic name, which
    // caused valid constant previews to fall back to the generic word "expression".
    const candidates = [];
    try { candidates.push(expression.evaluate().N()); } catch { /* try direct numeric evaluation */ }
    try { candidates.push(expression.N()); } catch { /* keep checking other representations */ }
    for (const numeric of candidates) {
      try {
        const primitive = numeric.valueOf();
        if (typeof primitive === "number") {
          const value = cleanRealNumber(primitive);
          if (value !== null) return value;
        }
        const real = Number(numeric.re);
        const imaginary = Number(numeric.im);
        if (Number.isFinite(real) && Number.isFinite(imaginary) && Math.abs(imaginary) < 1e-10) {
          const value = cleanRealNumber(real);
          if (value !== null) return value;
        }
      } catch { /* this candidate is symbolic or non-real */ }
    }
    return null;
  }

  function isTupleLikeAst(ast) {
    return Array.isArray(ast) && ["Tuple", "Pair", "List", "Vector", "Sequence"].includes(String(ast[0]));
  }

  /** Resolve a computed coordinate-pair value such as `(1,2)` or `point(3)`. */
  function pointValueFromExpression(expression, acceptEvaluatedList = false) {
    const candidates = [];
    try { candidates.push(expression.json); } catch { /* no raw AST */ }
    try { candidates.push(expression.evaluate().json); } catch { /* may be unevaluable */ }
    try { candidates.push(expression.N().json); } catch { /* may be symbolic */ }
    for (let ast of candidates) {
      while (Array.isArray(ast) && String(ast[0]) === "Delimiter" && ast.length >= 2) ast = ast[1];
      if (!isTupleLikeAst(ast) || ast.length !== 3) continue;
      const op = String(ast[0]);
      if (!(op === "Tuple" || op === "Pair" || acceptEvaluatedList)) continue;
      try {
        const x = numericRealValue(ce.box(ast[1]));
        const y = numericRealValue(ce.box(ast[2]));
        if (x !== null && y !== null) return { x, y };
      } catch { /* try the next representation */ }
    }
    return null;
  }

  function booleanValue(expression) {
    try {
      const value = expression.evaluate();
      const primitive = value.valueOf?.();
      if (typeof primitive === "boolean") return primitive;
      const text = String(value).trim().toLowerCase();
      if (["true", "\\top", "⊤"].includes(text)) return true;
      if (["false", "\\bot", "⊥"].includes(text)) return false;
    } catch { /* not a determinate boolean */ }
    return null;
  }

  /** Render Compute Engine MathJSON values in compact Desmos-like list notation. */
  function formatMathJsonPreview(ast, depth = 0) {
    if (depth >= 4) return "…";
    if (typeof ast === "boolean") return ast ? "True" : "False";
    if (typeof ast === "number") return Number.isFinite(ast) ? formatPreviewValue(ast) : "undefined";
    if (typeof ast === "string") {
      if (["True", "\\top", "true"].includes(ast)) return "True";
      if (["False", "\\bot", "false"].includes(ast)) return "False";
      return ast;
    }
    if (!Array.isArray(ast)) return String(ast ?? "undefined");
    const op = String(ast[0]);
    if (op === "Delimiter" && ast.length > 1) return formatMathJsonPreview(ast[1], depth + 1);
    if (["List", "Vector", "Sequence"].includes(op)) {
      return `[${ast.slice(1, 13).map((item) => formatMathJsonPreview(item, depth + 1)).join(",")}${ast.length > 13 ? ",…" : ""}]`;
    }
    if (["Tuple", "Pair"].includes(op)) {
      return `(${ast.slice(1, 9).map((item) => formatMathJsonPreview(item, depth + 1)).join(",")}${ast.length > 9 ? ",…" : ""})`;
    }
    if (op === "Rational" && Number.isFinite(Number(ast[1])) && Number.isFinite(Number(ast[2])) && Number(ast[2]) !== 0) {
      return formatPreviewValue(Number(ast[1]) / Number(ast[2]));
    }
    try {
      const rendered = ce.box(ast).N().toString();
      return rendered || "expression";
    } catch { return String(ast); }
  }

  /** Format a calculated value compactly, including finite lists returned by piecewise expressions. */
  function formatPreviewValue(value, depth = 0) {
    if (Array.isArray(value)) {
      if (depth >= 3) return "[…]";
      return `[${value.slice(0, 12).map((item) => formatPreviewValue(item, depth + 1)).join(",")}${value.length > 12 ? ",…" : ""}]`;
    }
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "number") return Number.isFinite(value) ? String(Number((Math.abs(value) < 1e-12 ? 0 : value).toPrecision(7))) : "undefined";
    if (value === null || value === undefined) return "undefined";
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.toLowerCase() === "true" || trimmed === "\\top") return "True";
      if (trimmed.toLowerCase() === "false" || trimmed === "\\bot") return "False";
      return trimmed;
    }
    try {
      if (typeof value.valueOf === "function") {
        const primitive = value.valueOf();
        if (primitive !== value) return formatPreviewValue(primitive, depth + 1);
      }
    } catch { /* use the normal string representation */ }
    return String(value);
  }

  /** Refresh the value shown on a non-graph expression row. */
  function updateExpressionPreview(item) {
    item.pointValue = null;
    try {
      const membership = resolveRealMembership(item.latex);
      if (membership !== null) {
        item.expressionValue = membership === "\\top" ? "True" : "False";
        return;
      }
      const knownNames = knownDefinitionNames;
      const piecewiseContext = { ce, knownNames, piecewise: new Map(), nextPiecewiseIndex: 0 };
      const collectionSource = transformCollectionSyntax(item.latex, ce, knownNames);
      const transformedSource = transformPiecewise(collectionSource, piecewiseContext);
      const normalized = normalizeLatex(transformedSource, knownNames);
      const expression = ce.parse(normalized);
      if (!expression?.isValid) throw new Error("Could not evaluate expression preview");

      item.pointValue = pointValueFromExpression(expression, isBareCallExpression(item.latex));
      if (item.pointValue) {
        item.expressionValue = `(${formatReadoutCoordinate(item.pointValue.x)}, ${formatReadoutCoordinate(item.pointValue.y)})`;
        return;
      }

      // This evaluator preserves list/vector results and gathers every true branch
      // of `{condition: output, ...}` piecewise expressions. Restrict previews to
      // values without graph-axis dependencies so x/y expressions remain plotted.
      const unknowns = [...(expression.unknowns || [])].map(String);
      if (!unknowns.includes("x") && !unknowns.includes("y")) {
        // Run the same AST evaluator used by plotting, but without x/y bindings.
        // This handles normal arithmetic, aliases such as mod(), lists/ranges,
        // piecewise values, and user-defined functions consistently. Keep useful
        // symbolic strings too (e.g. an unresolved `a`), rather than replacing
        // every non-number with the generic word "expression".
        const calculated = createAstEvaluator(ce, piecewiseContext.piecewise).evaluate(expression.json, {});
        if (Array.isArray(calculated) || typeof calculated === "boolean"
          || typeof calculated === "number") {
          item.expressionValue = formatPreviewValue(calculated);
          return;
        }
        if (typeof calculated === "string") {
          const symbolic = calculated.trim();
          if (symbolic && !/^(?:NaN|undefined|\[object Object\])$/i.test(symbolic)) {
            item.expressionValue = formatPreviewValue(symbolic);
            return;
          }
        }
      }

      const boolean = booleanValue(expression);
      if (boolean !== null) {
        item.expressionValue = boolean ? "True" : "False";
      } else {
        const number = numericRealValue(expression);
        if (number !== null) {
          item.expressionValue = String(Number(number.toPrecision(7)));
        } else {
          // Prefer a fully evaluated result (including lists, tuples, symbolic
          // constants, and user-defined values) before showing a generic fallback.
          let display = "";
          try { display = expression.evaluate().N().toString(); } catch { /* try N() directly */ }
          if (!display || display === normalized || display === "NaN") {
            try { display = expression.N().toString(); } catch { /* formatted AST fallback below */ }
          }
          if (!display || display === normalized || display === "NaN" || display.includes("Error")) {
            try { display = formatMathJsonPreview(expression.evaluate().N().json); } catch { /* use the unevaluated AST */ }
          }
          if (!display || display === normalized || display === "NaN" || display.includes("Error")) {
            try { display = formatMathJsonPreview(expression.json); } catch { /* remain generic */ }
          }
          // Never replace a valid, axis-independent expression with the generic
          // word "expression" just because its symbolic form equals the normalized
          // source. Keep a readable symbolic value as the final fallback.
          const candidates = [display, expression.toString(), formatMathJsonPreview(expression.json), normalized];
          const readable = candidates
            .map((candidate) => String(candidate || "").trim())
            .find((candidate) => candidate
              && !/^(?:expression|NaN|\[object Object\])$/i.test(candidate)
              && !candidate.includes("Error"));
          item.expressionValue = readable || "undefined";
        }
      }
    } catch (error) {
      // Preserve the reason for debugging without letting a bad preview break plotting.
      console.debug("Expression preview could not be evaluated", item.latex, error);
      item.expressionValue = String(item.latex || "").trim() || "undefined";
    }
  }

  /**
   * Recreate the engine when shared definitions change. Candidate names are collected
   * first so constant expressions can refer to variables defined later in the list.
   * @returns {Set<string>} names declared by valid candidate definitions
   */
  function rebuildDefinitions() {
    ce = new ComputeEngine();
    /** @type {Equation[]} */
    const candidates = [];
    /** @type {Set<string>} */
    const potentialDefinitionNames = new Set();
    /** @type {Set<string>} */
    const potentialVariableNames = new Set();
    for (const item of equations) {
      const definition = parseDefinitionSource(item.latex);
      if (!definition) continue;
      potentialDefinitionNames.add(definition.name);
      if (definition.kind === "variable") potentialVariableNames.add(definition.name);
    }

    for (const item of equations) {
      item.kind = "graph";
      item.definitionValue = null;
      item.definitionPreview = "";
      item.pointValue = null;
      item.expressionValue = undefined;
      item.error = "";
      delete item.name;
      delete item.args;
      delete item.rhs;
      if (!item.latex.trim()) continue;
      try {
        const definition = parseDefinitionSource(item.latex);
        const parsed = definition || classifyExpression(item.latex, potentialVariableNames, potentialDefinitionNames);
        Object.assign(item, parsed);
        if (item.kind === "variable" || item.kind === "function") {
          if (!item.rhs) throw new Error("The definition has an empty right side.");
          if (item.kind === "function" && (!item.args || item.args.length === 0)) {
            throw new Error("Give the function at least one argument, e.g. f(x)=x^2.");
          }
          candidates.push(item);
        }
      } catch (error) {
        item.error = error instanceof Error ? error.message : "Invalid expression";
      }
    }

    // Keep the first definition of each name; mark duplicate definitions clearly.
    /** @type {Map<string, Equation>} */
    const firstByName = new Map();
    for (const item of candidates) {
      if (!item.name) continue;
      const previous = firstByName.get(item.name);
      if (previous) {
        item.error = `“${item.name}” is already defined on an earlier line.`;
      } else {
        firstByName.set(item.name, item);
      }
    }

    const activeCandidates = [...firstByName.values()].filter((item) => !item.error);
    /** @type {Set<string>} */
    const validNames = new Set();
    /** @type {Map<string, EquationKind>} */
    const typeByName = new Map();
    for (const item of activeCandidates) {
      if (!item.name) continue;
      const kind = item.kind;
      const alreadyType = typeByName.get(item.name);
      const nextType = kind === "function" ? "function" : "variable";
      if (alreadyType && alreadyType !== nextType) {
        item.error = `“${item.name}” cannot be both a variable and a function.`;
        continue;
      }
      typeByName.set(item.name, nextType);
    }

    // Declaration pass: functions and variables are known before any RHS parses.
    for (const item of activeCandidates) {
      if (item.error || !item.name) continue;
      try {
        const declaration = item.kind === "function"
          ? { signature: `(${(item.args || []).map(() => "any").join(", ")}) -> any` }
          : { type: "any" };
        ce.declare(item.name, declaration);
        validNames.add(item.name);
      } catch (error) {
        item.error = error instanceof Error ? error.message : `Could not declare ${item.name}`;
      }
    }

    // Assignment pass. Compute a dependency order instead of using visual row
    // order: Compute Engine function definitions can capture values from their
    // defining scope, so dependencies must be installed before their dependents.
    /** @type {Map<string, Equation>} */
    const assignableByName = new Map(
      activeCandidates
        .filter((item) => !item.error && item.name && validNames.has(item.name) && item.rhs)
        .map((item) => [/** @type {string} */ (item.name), item]),
    );
    /** @type {Equation[]} */
    const definitionOrder = [];
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {Set<string>} */
    const visiting = new Set();
    function visitDefinition(item) {
      if (!item.name || visited.has(item.name) || visiting.has(item.name)) return;
      visiting.add(item.name);
      const rhs = item.rhs || "";
      for (const [dependencyName, dependency] of assignableByName) {
        if (item.kind === "function" && item.args?.includes(dependencyName)) continue;
        const escaped = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const referencePattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
        if (referencePattern.test(rhs)) visitDefinition(dependency);
      }
      visiting.delete(item.name);
      visited.add(item.name);
      definitionOrder.push(item);
    }
    for (const item of activeCandidates) visitDefinition(item);

    for (const item of definitionOrder) {
      if (item.error || !item.name || !validNames.has(item.name) || !item.rhs) continue;
      try {
        const collectionRhs = transformCollectionSyntax(item.rhs, ce, validNames);
        const rhs = normalizeKnownIdentifiers(
          normalizePiecewiseEquivalenceForDefinition(collectionRhs),
          validNames,
        );
        if (item.kind === "function") {
          const args = item.args || [];
          const lhs = `${latexIdentifier(item.name)}(${args.map(latexIdentifier).join(",")})`;
          const assignment = parseExpression(`${lhs} := ${rhs}`, true);
          assignment.evaluate();
        } else {
          /** @type {BoxedExpression} */
          const rhsExpression = parseExpression(rhs, true);
          assignAnyDefinitionValue(ce, item.name, rhsExpression);
        }
      } catch (error) {
        item.error = error instanceof Error ? error.message : "Could not assign definition";
      }
    }

    knownDefinitionNames = new Set(validNames);
    knownVariableNames = new Set(activeCandidates
      .filter((item) => item.kind === "variable" && item.name && validNames.has(item.name))
      .map((item) => /** @type {string} */(item.name)));

    // Previews are computed after every definition has been assigned.
    for (const item of equations) {
      if (item.error || !item.latex.trim()) continue;
      if (item.kind === "variable" && item.name) {
        try {
          const rhsSource = item.rhs || "";
          // Use the same normalizers as ordinary expression previews so list and
          // piecewise definitions can be evaluated rather than displayed as raw
          // source text. The original definition remains assigned to the engine.
          const rhsContext = { ce, knownNames: validNames, piecewise: new Map(), nextPiecewiseIndex: 0 };
          const rhsCollectionSource = transformCollectionSyntax(rhsSource, ce, validNames);
          const rhsTransformed = transformPiecewise(rhsCollectionSource, rhsContext);
          const rhsExpression = ce.parse(normalizeLatex(rhsTransformed, validNames));
          const rhsUnknowns = [...(rhsExpression.unknowns || [])].map(String);
          const rhsIsConstant = !rhsUnknowns.includes("x") && !rhsUnknowns.includes("y");
          if (rhsIsConstant) {
            item.pointValue = pointValueFromExpression(
              rhsExpression,
              isPointTupleSource(rhsSource) || isBareCallExpression(rhsSource),
            );
          }
          const boundValue = ce.parse(latexIdentifier(item.name));
          let computed = null;
          if (rhsIsConstant) {
            try { computed = createAstEvaluator(ce, rhsContext.piecewise).evaluate(rhsExpression.json, {}); }
            catch { /* use the engine's standard evaluation fallback */ }
          }
          const evaluatedNumber = typeof computed === "number" && Number.isFinite(computed)
            ? cleanRealNumber(computed) : numericRealValue(boundValue);
          if (evaluatedNumber !== null) {
            item.definitionValue = evaluatedNumber;
          } else if (!item.pointValue) {
            // Preserve arbitrary values (lists, booleans, and unresolved symbolic
            // expressions) in the row's value preview as well as in the engine.
            let rendered = "";
            if (computed !== null && computed !== undefined
              && (Array.isArray(computed) || typeof computed === "boolean" || typeof computed === "string")) {
              rendered = formatPreviewValue(computed);
            }
            if (!rendered || rendered === "undefined" || rendered === "NaN") {
              try {
                const evaluated = boundValue.evaluate().N();
                rendered = formatMathJsonPreview(evaluated.json);
              } catch { /* symbolic or non-displayable value */ }
            }
            if (rendered && rendered !== latexIdentifier(item.name) && !rendered.includes("Error")) {
              item.definitionPreview = rendered.length > 100 ? `${rendered.slice(0, 97)}…` : rendered;
            }
          }
        } catch (error) {
          item.error = error instanceof Error ? error.message : "Could not evaluate variable";
        }
      } else if (item.kind === "expression") {
        updateExpressionPreview(item);
      }
    }
    return validNames;
  }

  /**
   * Build numeric evaluators for every graph row, after all definitions exist.
   * A 2D equation is drawn as its zero contour; a bare expression without y is
   * interpreted as y=expression, except a bare function call which is a preview.
   */
  function prepareGraphEvaluators() {
    const nextSignature = getDefinitionSignature();
    const definitionsChanged = definitionSignature !== nextSignature;
    if (definitionsChanged) {
      rebuildDefinitions();
      definitionSignature = nextSignature;
      definitionRevision++;
    } else {
      // Editing an ordinary expression must not tear down the engine or recompile
      // unrelated rows. Reclassify previews and only compile graph rows whose source
      // (or shared definition revision) actually changed.
      for (const item of equations) {
        if (parseDefinitionSource(item.latex)) continue;
        item.error = "";
        item.definitionValue = null;
        item.definitionPreview = "";
        item.pointValue = null;
        item.expressionValue = undefined;
        delete item.name;
        delete item.args;
        delete item.rhs;
        const parsed = classifyExpression(item.latex, knownVariableNames, knownDefinitionNames);
        Object.assign(item, parsed);
        if (item.kind === "expression" && item.latex.trim()) updateExpressionPreview(item);
      }
    }

    for (const item of equations) {
      if (item.kind !== "graph" || !item.latex.trim()) continue;
      if (isIncompleteSpreadSource(item.latex)) {
        // A partial spread token is an editing state, not a bad equation. Drop any
        // stale sampled picture/evaluator and wait until an operand is entered.
        item.error = "";
        item.sampleData = undefined;
        item.sampleRequestedKey = "";
        item.renderKey = "";
        item.evaluate = () => NaN;
        item.preparedKey = `${definitionRevision}\u0000${item.latex}`;
        item.preparedOk = false;
        activeSamples.delete(item.id);
        continue;
      }
      if (isCollectionExpansionSource(item.latex)) {
        // Keep spread/comprehension expressions out of the scalar evaluator. The
        // inline sampler expands them to finite point lists using the current engine.
        const collectionKey = `${definitionRevision}\u0000${item.latex}`;
        if (item.preparedKey !== collectionKey || !item.preparedOk) {
          console.log("[plotter:collection] routing to finite collection expansion", {
            equationId: item.id, source: item.latex,
          });
          item.error = "";
          item.sampleData = undefined;
          item.sampleRequestedKey = "";
          item.renderKey = "";
          item.evaluate = () => NaN;
          item.preparedKey = collectionKey;
          item.preparedOk = true;
          activeSamples.delete(item.id);
        }
        continue;
      }
      if (item.error) continue;
      const preparedKey = `${definitionRevision}\u0000${item.latex}`;
      if (item.preparedKey === preparedKey && item.preparedOk) continue;
      try {
        const [leftText0, rightText0, hasRelation, relation] = splitEquation(item.latex);
        item.relation = relation;
        let leftText = leftText0;
        let rightText = rightText0;
        const normalizeSide = (source) => normalizeKnownIdentifiers(source, knownDefinitionNames);

        if (!hasRelation) {
          const parsedExpression = parseExpression(normalizeSide(leftText));
          const unknowns = parsedExpression.unknowns || [];
          if (unknowns.includes("y")) {
            rightText = "0";
          } else {
            rightText = leftText;
            leftText = "y";
          }
        }
        if (!rightText) throw new Error("The right side of the equation is empty.");
        leftText = normalizeSide(leftText);
        rightText = normalizeSide(rightText);

        const lhs = parseExpression(leftText);
        const rhs = parseExpression(rightText);
        const normalize = relation === "=" && hasExplicitCubePower(leftText) && hasExplicitCubePower(rightText);
        /** @type {Record<string, number>} */
        const vars = { x: 0, y: 0 };
        for (const def of equations) {
          if (def.kind === "variable" && def.name && Number.isFinite(def.definitionValue)) {
            vars[def.name] = /** @type {number} */ (def.definitionValue);
          }
        }

        const evaluateWithEngine = (x, y) => {
          try {
            ce.assign("x", x);
            ce.assign("y", y);
            const a = Number(lhs.N().valueOf());
            const b = Number(rhs.N().valueOf());
            const value = normalize ? Math.cbrt(a) - Math.cbrt(b) : a - b;
            return Number.isFinite(value) ? value : NaN;
          } catch {
            return NaN;
          }
        };

        /** @type {CompiledExpression|null} */
        let lhsFn = null;
        /** @type {CompiledExpression|null} */
        let rhsFn = null;
        let compilationsSucceeded = false;
        try {
          const lhsCompilation = compile(lhs);
          const rhsCompilation = compile(rhs);
          if (typeof lhsCompilation.run === "function" && typeof rhsCompilation.run === "function") {
            lhsFn = (variables) => lhsCompilation.run(variables);
            rhsFn = (variables) => rhsCompilation.run(variables);
            compilationsSucceeded = lhsCompilation.success && rhsCompilation.success;
          }
        } catch {
          // Expressions with unsupported custom definitions use the engine fallback.
        }

        if (lhsFn && rhsFn) {
          item.evaluate = (x, y) => {
            try {
              vars.x = x;
              vars.y = y;
              const a = Number(lhsFn(/** @type {Record<string, number>} */(vars)));
              const b = Number(rhsFn(/** @type {Record<string, number>} */(vars)));
              const value = normalize ? Math.cbrt(a) - Math.cbrt(b) : a - b;
              return Number.isFinite(value) ? value : NaN;
            } catch {
              return evaluateWithEngine(x, y);
            }
          };
          item.fallback = !compilationsSucceeded;
        } else {
          item.evaluate = evaluateWithEngine;
          item.fallback = true;
        }
        item.error = "";
        item.preparedKey = preparedKey;
        item.preparedOk = true;
      } catch (error) {
        item.error = error instanceof Error ? error.message : "Could not compile expression";
        item.preparedKey = preparedKey;
        item.preparedOk = false;
      }
    }
  }

  function updateEquationRowPresentation(equation, row) {
    if (!row) return;
    row.classList.toggle("definition", ["variable", "function", "expression"].includes(equation.kind));
    row.classList.toggle("invalid", Boolean(equation.error));
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.style.visibility = equation.kind === "graph" ? "visible" : "hidden";
    const value = row.querySelector(".value-preview");
    if (!value) return;
    if (equation.error && equation.latex) {
      value.textContent = "⚠";
    } else if (equation.kind === "variable" && Number.isFinite(equation.definitionValue)) {
      value.textContent = `= ${Number(/** @type {number} */(equation.definitionValue).toPrecision(7))}`;
    } else if (equation.kind === "variable" && equation.pointValue) {
      value.textContent = `= (${formatReadoutCoordinate(equation.pointValue.x)}, ${formatReadoutCoordinate(equation.pointValue.y)})`;
    } else if (equation.kind === "variable" && equation.definitionPreview) {
      value.textContent = `= ${equation.definitionPreview}`;
    } else if (equation.kind === "function") {
      value.textContent = "function";
    } else if (equation.kind === "expression") {
      value.textContent = equation.expressionValue ? `= ${equation.expressionValue}` : "expression";
    } else {
      value.textContent = "";
    }
    value.title = equation.error || value.textContent || "";
  }

  function updateAllEquationRowPresentations() {
    const rows = equationList.querySelectorAll(".equation-row");
    equations.forEach((equation, index) => updateEquationRowPresentation(equation, rows[index]));
  }

  function makeEquation(latex = "") {
    return {
      id: nextId++, latex: stripDelimiterDecoration(String(latex || "")), color: COLORS[equations.length % COLORS.length],
      enabled: true, kind: "graph", definitionValue: null, error: "", fallback: false,
      evaluate: () => NaN,
    };
  }

  function ensureTrailingEmptyEquation() {
    // Empty rows are real, reorderable items. Keep every one the user created;
    // only guarantee that a fresh project has at least one editable row.
    if (!equations.length || equations[equations.length - 1].latex.trim()) {
      equations.push(makeEquation());
    }
  }

  function addEquation(latex = "") {
    // Add Item always creates a new row, even when one or more blank rows already exist.
    equations.push(makeEquation(latex));
    ensureTrailingEmptyEquation();
    prepareGraphEvaluators();
    renderEquationList();
    draw();
    setStatus(latex ? "Expression added" : "Type in the empty row to add an expression");
    equationList.querySelectorAll(".equation-preview")[Math.max(0, equations.length - (latex ? 2 : 1))]?.focus();
  }

  function updateEquationRowIndices() {
    for (const row of equationList.querySelectorAll(".equation-row")) {
      const equation = equations.find((item) => String(item.id) === row.dataset.equationId);
      if (!equation) continue;
      const index = equations.indexOf(equation);
      const number = row.querySelector(".expression-number");
      const checkbox = row.querySelector('input[type="checkbox"]');
      const stripe = row.querySelector(".equation-color");
      const input = row.querySelector(".equation-preview");
      const handle = row.querySelector(".equation-drag-handle");
      if (number) number.textContent = String(index + 1);
      if (checkbox) checkbox.setAttribute("aria-label", `Show graph for expression ${index + 1}`);
      if (stripe) stripe.setAttribute("aria-label", `Change color for expression ${index + 1}`);
      if (input) input.setAttribute("aria-label", `Expression ${index + 1}`);
      if (handle) handle.setAttribute("aria-label", `Drag to reorder expression ${index + 1}`);
    }
  }

  function finishEquationRowDrag(event, cancelled = false) {
    const drag = activeRowDrag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    activeRowDrag = null;
    for (const row of equationList.querySelectorAll(".equation-row")) {
      row.classList.remove("dragging", "drag-before", "drag-after");
    }
    if (cancelled || !drag.targetEquation || drag.targetEquation === drag.equation) return;

    // Capture any text that is still inside a MathQuill field before reordering.
    // The DOM nodes themselves are moved below, so the active caret stays intact.
    for (const row of equationList.querySelectorAll(".equation-row")) {
      const equation = equations.find((item) => String(item.id) === row.dataset.equationId);
      const input = row.querySelector(".equation-preview");
      if (!equation || !input) continue;
      const liveLatex = stripDelimiterDecoration(input.value).trim();
      if (equation.latex !== liveLatex) {
        equation.latex = liveLatex;
        equation.sampleRequestedKey = "";
        equation.sampleData = undefined;
        equation.renderKey = "";
      }
    }

    const from = equations.indexOf(drag.equation);
    const target = equations.indexOf(drag.targetEquation);
    if (from < 0 || target < 0) return;
    let insertAt = target + (drag.insertAfter ? 1 : 0);
    if (from < insertAt) insertAt--;
    if (from === insertAt) return;

    const [moving] = equations.splice(from, 1);
    equations.splice(insertAt, 0, moving);
    const targetRow = [...equationList.querySelectorAll(".equation-row")]
      .find((row) => row.dataset.equationId === String(drag.targetEquation.id));
    if (targetRow) {
      if (drag.insertAfter) targetRow.after(drag.row);
      else targetRow.before(drag.row);
    }
    const countBeforeTrailingCheck = equations.length;
    ensureTrailingEmptyEquation();
    if (equations.length > countBeforeTrailingCheck) {
      equationList.append(createEquationRow(equations[equations.length - 1], equations.length - 1));
    }
    updateEquationRowIndices();
    prepareGraphEvaluators();
    updateAllEquationRowPresentations();
    draw();
    updateStatusFromDefinitions();
  }

  /**
   * Pasting several lines creates one row per line directly below the row that
   * received the first line. Live field contents are synced first because the list
   * is rebuilt from the equation objects.
   */
  function insertPastedExpressionRows(sourceInput, expressions) {
    for (const row of equationList.querySelectorAll(".equation-row")) {
      const equation = equations.find((item) => String(item.id) === row.dataset.equationId);
      const field = row.querySelector(".equation-preview");
      if (!equation || !field) continue;
      const live = stripDelimiterDecoration(field.value).trim();
      if (equation.latex !== live) {
        equation.latex = live;
        equation.sampleRequestedKey = "";
        equation.sampleData = undefined;
        equation.renderKey = "";
      }
    }
    const sourceRow = sourceInput.closest(".equation-row");
    const at = equations.findIndex((item) => String(item.id) === sourceRow?.dataset.equationId);
    const insertAt = at < 0 ? equations.length : at + 1;
    const created = expressions.map((latex) => makeEquation(latex));
    equations.splice(insertAt, 0, ...created);
    ensureTrailingEmptyEquation();
    prepareGraphEvaluators();
    renderEquationList();
    draw();
    updateStatusFromDefinitions();
    equationList.querySelectorAll(".equation-preview")[insertAt + created.length - 1]?.focus();
    setStatus(`Pasted ${created.length + 1} expressions`);
  }

  function createEquationRow(equation, index) {
    let liveEditTimer = null;
    const row = document.createElement("div");
    row.className = "equation-row";
    row.dataset.equationId = String(equation.id);
    row.style.setProperty("--expression-color", equation.color);
    if (["variable", "function", "expression"].includes(equation.kind)) row.classList.add("definition");
    if (equation.error) row.classList.add("invalid");

    const number = document.createElement("span");
    number.className = "expression-number";
    number.textContent = String(index + 1);

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "equation-drag-handle";
    dragHandle.title = "Drag to reorder expression";
    dragHandle.setAttribute("aria-label", `Drag to reorder expression ${index + 1}`);
    dragHandle.setAttribute("aria-grabbed", "false");
    dragHandle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || activeRowDrag) return;
      event.preventDefault();
      activeRowDrag = {
        equation, row, pointerId: event.pointerId,
        targetEquation: equation, insertAfter: false,
      };
      row.classList.add("dragging");
      dragHandle.setAttribute("aria-grabbed", "true");
      try { dragHandle.setPointerCapture(event.pointerId); } catch { /* capture can fail if detached */ }
    });
    dragHandle.addEventListener("pointermove", (event) => {
      const drag = activeRowDrag;
      if (!drag || drag.row !== row || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const targetRow = element?.closest?.(".equation-row");
      for (const item of equationList.querySelectorAll(".equation-row")) {
        item.classList.remove("drag-before", "drag-after");
      }
      if (!targetRow || !equationList.contains(targetRow)) {
        drag.targetEquation = drag.equation;
        drag.insertAfter = false;
        return;
      }
      const targetEquation = equations.find((item) => String(item.id) === targetRow.dataset.equationId);
      if (!targetEquation) return;
      const rect = targetRow.getBoundingClientRect();
      drag.targetEquation = targetEquation;
      drag.insertAfter = event.clientY >= rect.top + rect.height / 2;
      targetRow.classList.add(drag.insertAfter ? "drag-after" : "drag-before");
    });
    dragHandle.addEventListener("pointerup", (event) => {
      if (!activeRowDrag || activeRowDrag.row !== row) return;
      finishEquationRowDrag(event, false);
      dragHandle.setAttribute("aria-grabbed", "false");
    });
    dragHandle.addEventListener("pointercancel", (event) => {
      if (!activeRowDrag || activeRowDrag.row !== row) return;
      finishEquationRowDrag(event, true);
      dragHandle.setAttribute("aria-grabbed", "false");
    });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = equation.enabled;
    checkbox.title = "Show or hide graph";
    checkbox.setAttribute("aria-label", `Show graph for expression ${index + 1}`);
    checkbox.style.visibility = equation.kind === "graph" ? "visible" : "hidden";
    checkbox.addEventListener("change", () => { equation.enabled = checkbox.checked; draw(); });

    const stripe = document.createElement("button");
    stripe.type = "button";
    stripe.className = "equation-color";
    stripe.style.setProperty("--expression-color", equation.color);
    stripe.setAttribute("aria-label", `Change color for expression ${index + 1}`);
    stripe.title = "Change expression color";
    stripe.addEventListener("mousedown", (event) => event.preventDefault());
    stripe.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!colorPalette.hidden && activeColorAnchor === stripe) closeColorPalette();
      else openColorPalette(stripe, equation, row);
    });

    const input = /** @type {MathFieldLike} */ (document.createElement("span"));
    input.className = "equation-preview";
    input.setAttribute("role", "textbox");
    input.setAttribute("aria-label", `Expression ${index + 1}`);
    input.setAttribute("aria-multiline", "false");

    // Full MathQuill handles interactive backslash commands. For piecewise input,
    // the outer row becomes a small editor composed of one MathQuill field per cell;
    // MathQuill itself does not implement LaTeX array/cases environments.
    let mathField = null;
    let piecewiseModel = null;
    let activePiecewiseField = null;
    let mathQuillLatex = prepareMathQuillLatex("");

    const mathFieldConfig = {
      restrictMismatchedBrackets: true,
      autoOperatorNames: MATHQUILL_AUTO_OPERATOR_NAMES,
      autoCommands: "pi theta sqrt sum prod coprod",
      handlers: { edit: () => input.dispatchEvent(new Event("input", { bubbles: true })) },
    };

    const makeMathField = (host, latex = "") => {
      const field = MQ.MathField(host, mathFieldConfig);
      if (latex) field.latex(latex);
      host.piecewiseMathField = field;
      host.addEventListener("focusin", () => {
        activePiecewiseField = field;
        input.classList.add("mq-focused");
      });
      return field;
    };

    const serializePiecewise = () => {
      const branches = piecewiseModel?.rows || [];
      const body = branches.map(({ outputField, conditionField }) =>
        `${outputField.latex()} & \\text{if }${conditionField.latex()}`
      ).join(String.raw` \\ `);
      const prefix = piecewiseModel?.prefixField?.latex() || "";
      return prefix + String.raw`\left\{\begin{array}{ll}` + body + String.raw`\end{array}\right.`;
    };
    const currentMathQuillLatex = () => {
      const latex = piecewiseModel ? serializePiecewise() : mathField?.latex() || "";
      return mathQuillLatex.restore(latex);
    };

    const extractPiecewiseBranches = (latex) => {
      const source = convertCasesForMathQuill(String(latex ?? ""));
      const arrayAt = source.search(/\\begin\{array\}(?:\s*\{[^{}]*\})?/);
      if (arrayAt < 0) return null;
      const open = /\\begin\{array\}(?:\s*\{[^{}]*\})?/.exec(source.slice(arrayAt));
      if (!open) return null;
      const ending = findEnvironmentEnd(source, arrayAt, "array", open[0].length);
      if (!ending) return null;
      const branches = parseEnvironmentBranches(source.slice(ending.bodyStart, ending.bodyEnd));
      if (!branches) return null;
      const braceAt = source.lastIndexOf(String.raw`\left\{`, arrayAt);
      const prefix = braceAt >= 0 ? source.slice(0, braceAt) : "";
      return {
        prefix: prefix.trim(),
        branches: branches.map((branch) => ({ output: branch.output, condition: branch.condition })),
      };
    };

    const clearPiecewiseEditor = () => {
      if (!piecewiseModel) return;
      for (const branch of piecewiseModel.rows) {
        try { branch.outputField.revert?.(); } catch { }
        try { branch.conditionField.revert?.(); } catch { }
      }
      try { piecewiseModel.prefixField?.revert?.(); } catch { }
      piecewiseModel = null;
      activePiecewiseField = null;
      input.classList.remove("piecewise-editor", "mq-focused");
      input.replaceChildren();
    };

    const renderPiecewiseEditor = (branches, prefixLatex = "") => {
      if (mathField) {
        try { mathField.revert?.(); } catch { }
        mathField = null;
      }
      input.replaceChildren();
      input.className = "equation-preview piecewise-editor";
      input.setAttribute("role", "textbox");
      input.setAttribute("aria-label", `Expression ${index + 1}`);
      input.setAttribute("aria-multiline", "true");
      const layout = document.createElement("span");
      layout.className = "piecewise-layout";
      let prefixField = null;
      if (prefixLatex.trim()) {
        const prefixHost = document.createElement("span");
        prefixHost.className = "piecewise-cell piecewise-prefix-cell mq-editable-field";
        prefixHost.setAttribute("aria-label", "Equation prefix");
        layout.append(prefixHost);
        prefixField = makeMathField(prefixHost, prefixLatex);
      }
      const brace = document.createElement("span");
      brace.className = "piecewise-brace";
      brace.textContent = "{";
      brace.setAttribute("aria-hidden", "true");
      const rows = document.createElement("span");
      rows.className = "piecewise-branches";
      layout.append(brace, rows);
      input.append(layout);
      piecewiseModel = { rows: [], layout, rowsHost: rows, prefixField };

      const addRow = (branch = {}, focusWhich = null) => {
        const line = document.createElement("span");
        line.className = "piecewise-branch";
        const outputHost = document.createElement("span");
        outputHost.className = "piecewise-cell piecewise-output mq-editable-field";
        outputHost.setAttribute("aria-label", "Piecewise output");
        const ifLabel = document.createElement("span");
        ifLabel.className = "piecewise-if-label";
        ifLabel.textContent = "if";
        const conditionHost = document.createElement("span");
        conditionHost.className = "piecewise-cell piecewise-condition mq-editable-field";
        conditionHost.setAttribute("aria-label", "Piecewise condition");
        line.append(outputHost, ifLabel, conditionHost);
        rows.append(line);
        const outputField = makeMathField(outputHost, branch.output || "");
        const conditionField = makeMathField(conditionHost, branch.condition || "");
        piecewiseModel.rows.push({ line, outputHost, conditionHost, outputField, conditionField });
        if (focusWhich) {
          const target = focusWhich === "condition" ? conditionField : outputField;
          activePiecewiseField = target;
          target.focus();
        }
        return { outputField, conditionField };
      };
      piecewiseModel.addRow = addRow;
      (branches.length ? branches : [{}, {}]).forEach((branch) => addRow(branch));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    input.addEventListener("focusout", (event) => {
      if (piecewiseModel && !event.relatedTarget?.closest?.(".piecewise-editor")) {
        input.classList.remove("mq-focused");
      }
    });

    const restoreNormalEditor = (latex = "") => {
      clearPiecewiseEditor();
      input.className = "equation-preview";
      input.setAttribute("role", "textbox");
      input.setAttribute("aria-label", `Expression ${index + 1}`);
      input.setAttribute("aria-multiline", "false");
      mathField = MQ.MathField(input, mathFieldConfig);
      if (latex) mathField.latex(latex);
    };

    mathField = MQ.MathField(input, mathFieldConfig);

    const adapter = {
      // MathQuill sizes ( ) [ ] { } by measuring their content. A detached row
      // measures as 0 tall, so brackets come out tiny until something edits the
      // field. Re-measure once the row is on the page (and again after fonts load).
      reflow: () => {
        try {
          if (piecewiseModel) {
            piecewiseModel.prefixField?.reflow?.();
            for (const branch of piecewiseModel.rows) {
              branch.outputField.reflow?.();
              branch.conditionField.reflow?.();
            }
          } else mathField?.reflow?.();
        } catch (error) { console.debug("MathQuill reflow failed", error); }
      },
      latex(value) {
        if (arguments.length) {
          input.value = String(value ?? "");
          return this;
        }
        return currentMathQuillLatex();
      },
      rawLatex: () => piecewiseModel ? serializePiecewise() : mathField?.latex() || "",
      recordInsertion: (before, after, source) => mathQuillLatex.recordInsertion(before, after, source),
      write: (latex) => {
        if (piecewiseModel) (activePiecewiseField || piecewiseModel.rows.at(-1)?.outputField || piecewiseModel.prefixField)?.write(latex);
        else mathField?.write(latex);
      },
      focus: () => {
        if (piecewiseModel) (activePiecewiseField || piecewiseModel.rows.at(-1)?.outputField || piecewiseModel.prefixField)?.focus();
        else mathField?.focus();
      },
      keystroke: (keys) => {
        if (piecewiseModel) (activePiecewiseField || piecewiseModel.rows.at(-1)?.outputField || piecewiseModel.prefixField)?.keystroke(keys);
        else mathField?.keystroke(keys);
      },
      moveToRightEnd: () => {
        if (piecewiseModel) (activePiecewiseField || piecewiseModel.rows.at(-1)?.outputField || piecewiseModel.prefixField)?.moveToRightEnd();
        else mathField?.moveToRightEnd();
      },
    };
    input.mathField = adapter;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => currentMathQuillLatex(),
      set: (value) => {
        const latex = String(value ?? "").replace(/\\placeholder\s*\{\s*\}/g, "");
        mathQuillLatex = prepareMathQuillLatex(latex);
        const editorLatex = mathQuillLatex.latex;
        const branches = extractPiecewiseBranches(editorLatex);
        if (branches && /\\left\s*\\\{/.test(editorLatex)) {
          renderPiecewiseEditor(branches.branches, branches.prefix);
        } else if (piecewiseModel) {
          restoreNormalEditor(convertCasesForMathQuill(editorLatex));
        } else {
          mathField?.latex(convertCasesForMathQuill(editorLatex));
        }
      },
    });
    input.focus = () => adapter.focus();
    input.executeCommand = (command) => {
      if (command === "delete-backward") { adapter.keystroke("Backspace"); return true; }
      if (typeof command === "string") return false;
      if (!Array.isArray(command) || command[0] !== "insert") return false;
      const latex = String(command[1] ?? "").replace(/\\placeholder\s*\{\s*\}/g, "");
      const options = command[2] || {};
      if (options.insertionMode === "replaceAll") {
        input.value = latex;
        adapter.focus();
        adapter.moveToRightEnd();
      } else adapter.write(latex);
      return true;
    };
    input.value = equation.latex;
    const addBranch = document.createElement("button");
    addBranch.className = "icon-button piecewise-add-button";
    addBranch.type = "button";
    addBranch.textContent = "+";
    addBranch.title = "Add a piecewise branch (also available with Shift+Enter)";
    addBranch.setAttribute("aria-label", "Insert piecewise branch");
    addBranch.style.display = "none";

    const updatePiecewiseRowStyle = () => {
      const source = input.value;
      const isStructuredPiecewise = Boolean(piecewiseModel)
        || /\\begin\s*\{(?:cases|dcases|rcases)\}/.test(source)
        || (/\\left\s*\\\{/.test(source) && /\\begin\{array\}/.test(source));
      const isPiecewise = isStructuredPiecewise || /\{[^{}]*\bif\b/i.test(source);
      row.classList.toggle("piecewise-row", isPiecewise);
      addBranch.style.display = isStructuredPiecewise ? "inline-flex" : "none";
    };
    updatePiecewiseRowStyle();

    const appendPiecewiseBranch = () => {
      if (!piecewiseModel) {
        const current = input.value.trim();
        const equalityParts = splitTopLevel(current, "=");
        let prefix = "";
        let firstOutput = current;
        if (equalityParts.length > 1 && equalityParts[0].trim()) {
          prefix = equalityParts.shift().trim() + "=";
          firstOutput = equalityParts.join("=").trim();
        }
        renderPiecewiseEditor([
          { output: firstOutput, condition: "" },
          { output: "", condition: "" },
        ], prefix);
        updatePiecewiseRowStyle();
        const firstCondition = piecewiseModel?.rows[0]?.conditionField;
        if (firstCondition) { activePiecewiseField = firstCondition; firstCondition.focus(); }
        return;
      }
      const branch = piecewiseModel.addRow({}, "output");
      branch.outputField.focus();
      updatePiecewiseRowStyle();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const value = document.createElement("span");
    value.className = "value-preview";
    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove expression";
    remove.setAttribute("aria-label", "Remove expression");

    const commit = () => {
      equation.latex = stripDelimiterDecoration(input.value).trim();
      equation.sampleRequestedKey = "";
      equation.sampleData = undefined;
      equation.renderKey = "";
      prepareGraphEvaluators();
      updateAllEquationRowPresentations();
      draw();
      updateStatusFromDefinitions();
    };

    input.addEventListener("change", () => {
      if (liveEditTimer !== null) clearTimeout(liveEditTimer);
      liveEditTimer = null;
      commit();
      if (equation.latex && equations.indexOf(equation) === equations.length - 1) {
        const blank = makeEquation();
        equations.push(blank);
        equationList.append(createEquationRow(blank, equations.length - 1));
      }
    });

    // Do not rewrite the expression while the user is typing. MathQuill owns the
    // live field model and caret; normalizeLatex() converts call/method sugar only
    // in the parser input, so input edits never jump the cursor or split a name.

    // Ellipsis and Enter shortcuts are handled in document capture phase because
    // key events can originate from MathQuill's hidden textarea.

    input.addEventListener("input", () => {
      // Keep edits local to MathQuill; function and method-call sugar is normalized
      // only in normalizeLatex() before the expression reaches the compute engine.
      updatePiecewiseRowStyle();
      // Append the next empty row without rebuilding the active MathQuill field,
      // so typing in the middle of a formula never loses the caret.
      if (equations.indexOf(equation) === equations.length - 1 && input.value.trim()) {
        const blank = makeEquation();
        equations.push(blank);
        equationList.append(createEquationRow(blank, equations.length - 1));
      }
      if (liveEditTimer !== null) clearTimeout(liveEditTimer);
      liveEditTimer = setTimeout(() => {
        liveEditTimer = null;
        if (!input.isConnected) return;
        commit();
        if (equation.latex && equations.indexOf(equation) === equations.length - 1) {
          const blank = makeEquation();
          equations.push(blank);
          equationList.append(createEquationRow(blank, equations.length - 1));
        }
      }, 160);
    });

    // A visible + control complements Shift+Enter and always appends the branch.
    addBranch.addEventListener("mousedown", (event) => event.preventDefault());
    addBranch.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        input.focus();
        appendPiecewiseBranch();
      } catch (error) {
        console.error("Could not add piecewise branch:", error);
        setStatus(error instanceof Error ? `Could not add piecewise branch: ${error.message}` : "Could not add piecewise branch", true);
      }
    });

    input.mathQuillActions = {
      shiftEnter: () => {
        appendPiecewiseBranch();
        updatePiecewiseRowStyle();
      },
      enter: () => {
        if (liveEditTimer !== null) clearTimeout(liveEditTimer);
        liveEditTimer = null;
        commit();
        let currentIndex = equations.indexOf(equation);
        if (currentIndex === equations.length - 1) {
          const blank = makeEquation();
          equations.push(blank);
          equationList.append(createEquationRow(blank, equations.length - 1));
          currentIndex = equations.length - 2;
        }
        const fields = equationList.querySelectorAll(".equation-preview");
        fields[Math.min(currentIndex + 1, fields.length - 1)]?.focus();
      },
    };

    remove.addEventListener("click", () => {
      if (liveEditTimer !== null) clearTimeout(liveEditTimer);
      const currentIndex = equations.indexOf(equation);
      if (currentIndex >= 0) equations.splice(currentIndex, 1);
      ensureTrailingEmptyEquation();
      prepareGraphEvaluators();
      renderEquationList();
      draw();
      updateStatusFromDefinitions();
    });
    row.append(dragHandle, number, checkbox, stripe, input, value, addBranch, remove);
    const reflowWhenAttached = () => { if (row.isConnected) adapter.reflow(); };
    requestAnimationFrame(() => { reflowWhenAttached(); requestAnimationFrame(reflowWhenAttached); });
    document.fonts?.ready?.then(reflowWhenAttached);
    updateEquationRowPresentation(equation, row);
    return row;
  }

  function renderEquationList() {
    ensureTrailingEmptyEquation();
    equationList.replaceChildren();
    equations.forEach((equation, index) => equationList.append(createEquationRow(equation, index)));
  }

  function updateStatusFromDefinitions() {
    const firstError = equations.find((item) => item.error && item.latex.trim());
    if (firstError) {
      setStatus(firstError.error, true);
    } else if (!autoCalculate) {
      setStatus("Auto calculation is off · click Calculate current view to update graphs");
    } else {
      setStatus("Ready · variables and functions are available across all rows");
    }
  }

  function ensureSampled(equation, viewKey, forceSampling = false) {
    const sampleKey = sampleKeyFor(equation, viewKey);
    if (equation.sampleData?.sampleKey === sampleKey) return true;
    // In manual mode, only an explicit Calculate click can start sampling for a
    // camera/expression key that has not already been sampled. Also invalidate a
    // queued job for an older camera so it does not keep consuming CPU in the
    // background after the user pans or zooms.
    if (!autoCalculate && !forceSampling) {
      if (equation.sampleRequestedKey && equation.sampleRequestedKey !== sampleKey) {
        activeSamples.delete(equation.id);
        equation.sampleRequestedKey = "";
      }
      return false;
    }
    if (equation.sampleRequestedKey !== sampleKey) {
      equation.sampleRequestedKey = sampleKey;
      const token = {};
      activeSamples.set(equation.id, token);
      const definitions = equations
        .filter((item) => !item.error && item.name && (item.kind === "variable" || item.kind === "function") && item.rhs)
        .map((item) => ({ kind: item.kind, name: item.name, args: item.args || [], rhs: item.rhs }));
      const message = {
        type: "sample", id: equation.id, key: sampleKey, source: equation.latex,
        definitions, width: canvasWidth, height: canvasHeight,
        camera: { xMin: camera.xMin, xMax: camera.xMax, yMin: camera.yMin, yMax: camera.yMax },
        step: SAMPLE_STEP,
      };
      const cancelled = () => activeSamples.get(equation.id) !== token
        || !equations.includes(equation)
        || equation.sampleRequestedKey !== sampleKey;

      sampleInline(message, cancelled).then((result) => {
        if (!result || cancelled()) {
          // Do not let an abandoned request remain marked as pending forever.
          if (activeSamples.get(equation.id) === token) {
            activeSamples.delete(equation.id);
            if (equation.sampleRequestedKey === sampleKey) equation.sampleRequestedKey = "";
          }
          return;
        }
        activeSamples.delete(equation.id);
        equation.sampleRequestedKey = "";
        if (result.error) {
          equation.error = result.error;
          updateAllEquationRowPresentations();
          setStatus(result.error, true);
          draw();
          return;
        }
        equation.sampleData = {
          sampleKey: result.key,
          cols: result.cols,
          rows: result.rows,
          step: result.step,
          components: (result.components || []).map((component) => ({
            relation: component.relation,
            axis: component.axis || null,
            constant: Number.isFinite(component.constant) ? component.constant : null,
            pointSet: Boolean(component.pointSet),
            points: component.points || [],
            denseY: Number.isFinite(component.denseY) ? component.denseY : null,
            values: component.values instanceof Float64Array
              ? component.values
              : new Float64Array(component.values),
          })),
        };
        equation.renderKey = "";
        draw();
        if (!autoCalculate && isCurrentViewCalculated()) {
          setStatus("Graph calculated for the current view · auto calculation is off");
        }
      }).catch((error) => {
        if (cancelled()) {
          if (activeSamples.get(equation.id) === token) {
            activeSamples.delete(equation.id);
            if (equation.sampleRequestedKey === sampleKey) equation.sampleRequestedKey = "";
          }
          return;
        }
        activeSamples.delete(equation.id);
        equation.sampleRequestedKey = "";
        equation.error = error instanceof Error ? error.message : String(error);
        updateAllEquationRowPresentations();
        setStatus(equation.error, true);
        draw();
      });
    }
    return false;
  }

  function niceStep(range, pixels) {
    const raw = range / Math.max(1, pixels / 90);
    const power = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const scaled = raw / power;
    const nice = scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10;
    return nice * power;
  }

  function formatAxisNumber(value, step = 1) {
    if (!Number.isFinite(value)) return "";
    if (Math.abs(value) < 1e-12) return "0";
    if (Math.abs(value) >= 1e7 || Math.abs(value) < 1e-5) return value.toExponential(3).replace(/\.?0+e/, "e");
    const decimals = Math.min(8, Math.max(0, -Math.floor(Math.log10(Math.abs(step)))));
    return value.toFixed(decimals).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  }

  function drawGrid() {
    const width = canvasWidth;
    const height = canvasHeight;
    const xStep = niceStep(camera.xMax - camera.xMin, width);
    const yStep = niceStep(camera.yMax - camera.yMin, height);
    const xAxisVisible = camera.yMin <= 0 && camera.yMax >= 0;
    const yAxisVisible = camera.xMin <= 0 && camera.xMax >= 0;
    const origin = toScreen(0, 0);

    ctx.lineWidth = 1;
    ctx.strokeStyle = "#e6e6e6";
    ctx.beginPath();
    const verticalValues = [];
    const horizontalValues = [];
    const firstX = Math.ceil(camera.xMin / xStep - 1e-10) * xStep;
    const firstY = Math.ceil(camera.yMin / yStep - 1e-10) * yStep;
    for (let i = 0; i < 5000; i++) {
      const x = firstX + i * xStep;
      if (x > camera.xMax + xStep * 1e-9) break;
      const px = toScreen(x, 0)[0];
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      verticalValues.push({ value: Math.abs(x) < xStep * 1e-9 ? 0 : x, pixel: px });
    }
    for (let i = 0; i < 5000; i++) {
      const y = firstY + i * yStep;
      if (y > camera.yMax + yStep * 1e-9) break;
      const py = toScreen(0, y)[1];
      ctx.moveTo(0, py);
      ctx.lineTo(width, py);
      horizontalValues.push({ value: Math.abs(y) < yStep * 1e-9 ? 0 : y, pixel: py });
    }
    ctx.stroke();

    ctx.strokeStyle = "#676767";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (yAxisVisible) {
      ctx.moveTo(origin[0], 0);
      ctx.lineTo(origin[0], height);
    }
    if (xAxisVisible) {
      ctx.moveTo(0, origin[1]);
      ctx.lineTo(width, origin[1]);
    }
    ctx.stroke();

    // Label each grid line near the corresponding axis; when an axis is out of
    // view, keep labels anchored to the closest canvas edge instead.
    ctx.save();
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,.98)";
    ctx.fillStyle = "#777777";
    const xLabelY = xAxisVisible
      ? Math.max(10, Math.min(height - 10, origin[1] < height * 0.55 ? origin[1] + 13 : origin[1] - 13))
      : height - 10;
    for (const tick of verticalValues) {
      if (tick.pixel < -2 || tick.pixel > width + 2) continue;
      const label = formatAxisNumber(tick.value, xStep);
      let labelX = tick.pixel + 4;
      if (labelX > width - 26) labelX = tick.pixel - ctx.measureText(label).width - 4;
      labelX = Math.max(2, Math.min(width - ctx.measureText(label).width - 2, labelX));
      ctx.strokeText(label, labelX, xLabelY);
      ctx.fillText(label, labelX, xLabelY);
    }

    ctx.textAlign = "left";
    const yLabelX = yAxisVisible
      ? Math.max(3, Math.min(width - 32, origin[0] < width * 0.72 ? origin[0] + 5 : origin[0] - 28))
      : 5;
    for (const tick of horizontalValues) {
      if (tick.pixel < -2 || tick.pixel > height + 2) continue;
      // Avoid printing two overlapping zero labels at the axis intersection.
      if (yAxisVisible && Math.abs(tick.value) < yStep * 1e-9) continue;
      const label = formatAxisNumber(tick.value, yStep);
      const labelY = Math.max(8, Math.min(height - 8, tick.pixel - 8));
      ctx.strokeText(label, yLabelX, labelY);
      ctx.fillText(label, yLabelX, labelY);
    }
    ctx.restore();
  }

  /** Shade inequalities, then draw each sampled output with stitched marching squares. */
  function drawImplicit(equation, targetCtx = ctx) {
    const data = equation.sampleData;
    if (!data?.components?.length) return;
    const { cols, rows, step } = data;
    const width = canvasWidth;
    const height = canvasHeight;
    const xs = new Float64Array(cols);
    const ys = new Float64Array(rows);
    for (let c = 0; c < cols; c++) xs[c] = Math.min(c * step, width);
    for (let r = 0; r < rows; r++) ys[r] = Math.min(r * step, height);

    const shadeRelation = (v, relation) => {
      if (!Number.isFinite(v)) return false;
      if (relation === "<") return v < 0;
      if (relation === "<=") return v <= 0;
      if (relation === ">") return v > 0;
      if (relation === ">=") return v >= 0;
      if (relation === "!=") return v !== 0;
      return false;
    };

    for (const component of data.components) {
      const relation = component.relation || equation.relation || "=";
      if (component.pointSet) {
        targetCtx.fillStyle = equation.color;
        const radius = 5.0;
        if (Number.isFinite(component.denseY) && component.points.length === 0) {
          if (component.denseY >= camera.yMin && component.denseY <= camera.yMax) {
            const py = height - ((component.denseY - camera.yMin) / (camera.yMax - camera.yMin)) * height;
            targetCtx.fillRect(0, py - 0.7, width, 1.4);
          }
        } else {
          for (const point of component.points || []) {
            const px = ((point.x - camera.xMin) / (camera.xMax - camera.xMin)) * width;
            const py = height - ((point.y - camera.yMin) / (camera.yMax - camera.yMin)) * height;
            targetCtx.beginPath();
            targetCtx.arc(px, py, radius, 0, Math.PI * 2);
            targetCtx.fill();
            targetCtx.strokeStyle = "rgba(255,255,255,.92)";
            targetCtx.lineWidth = 1.15;
            targetCtx.stroke();
          }
        }
        continue;
      }
      if (relation === "=" && (component.axis === "x" || component.axis === "y")
        && Number.isFinite(component.constant)) {
        const value = component.constant;
        targetCtx.strokeStyle = equation.color;
        targetCtx.lineWidth = 1.65;
        targetCtx.lineCap = "round";
        targetCtx.beginPath();
        if (component.axis === "x") {
          if (value < camera.xMin || value > camera.xMax) continue;
          const px = ((value - camera.xMin) / (camera.xMax - camera.xMin)) * width;
          targetCtx.moveTo(px, 0); targetCtx.lineTo(px, height);
        } else {
          if (value < camera.yMin || value > camera.yMax) continue;
          const py = height - ((value - camera.yMin) / (camera.yMax - camera.yMin)) * height;
          targetCtx.moveTo(0, py); targetCtx.lineTo(width, py);
        }
        targetCtx.stroke();
        continue;
      }
      const values = component.values;

      // Region fill is batched into horizontal runs to keep dense inequalities cheap.
      if (["<", "<=", ">", ">=", "!="].includes(relation)) {
        targetCtx.save();
        targetCtx.globalAlpha = 0.16;
        targetCtx.fillStyle = equation.color;
        for (let r = 0; r < rows - 1; r++) {
          const top = r * cols;
          let runStart = -1;
          for (let c = 0; c < cols - 1; c++) {
            const a = values[top + c];
            const b = values[top + c + 1];
            const d = values[top + cols + c];
            const e = values[top + cols + c + 1];
            const center = (a + b + d + e) * 0.25;
            const inside = Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(d) && Number.isFinite(e)
              && shadeRelation(center, relation);
            if (inside && runStart < 0) runStart = c;
            if ((!inside || c === cols - 2) && runStart >= 0) {
              const last = inside && c === cols - 2 ? c + 1 : c;
              targetCtx.fillRect(xs[runStart], ys[r], xs[last] - xs[runStart], ys[r + 1] - ys[r]);
              runStart = -1;
            }
          }
        }
        targetCtx.restore();
      }

      const vertexCount = rows * cols;
      const horizontalCount = rows * (cols - 1);
      const pointByEdge = new Map();
      const linksByEdge = new Map();
      const segments = [];
      const hEdge = (r, c) => vertexCount + r * (cols - 1) + c;
      const vEdge = (r, c) => vertexCount + horizontalCount + r * cols + c;

      function crossing(edgeId, vertexA, vertexB, px1, py1, v1, px2, py2, v2) {
        let nodeId = edgeId;
        let point;
        if (v1 === 0) { nodeId = vertexA; point = [px1, py1]; }
        else if (v2 === 0) { nodeId = vertexB; point = [px2, py2]; }
        const cached = pointByEdge.get(nodeId);
        if (cached) return { id: nodeId, point: cached };
        if (!point) {
          const t = v1 === v2 ? 0.5 : Math.max(0, Math.min(1, v1 / (v1 - v2)));
          point = [px1 + (px2 - px1) * t, py1 + (py2 - py1) * t];
        }
        pointByEdge.set(nodeId, point);
        return { id: nodeId, point };
      }
      function addSegment(edgeA, edgeB) {
        if (edgeA === edgeB) return;
        const index = segments.length;
        segments.push([edgeA, edgeB]);
        if (!linksByEdge.has(edgeA)) linksByEdge.set(edgeA, []);
        if (!linksByEdge.has(edgeB)) linksByEdge.set(edgeB, []);
        linksByEdge.get(edgeA).push(index);
        linksByEdge.get(edgeB).push(index);
      }

      for (let r = 0; r < rows - 1; r++) {
        const y0 = ys[r], y1 = ys[r + 1];
        const topOffset = r * cols, bottomOffset = (r + 1) * cols;
        for (let c = 0; c < cols - 1; c++) {
          const x0 = xs[c], x1 = xs[c + 1];
          const vTL = values[topOffset + c], vTR = values[topOffset + c + 1];
          const vBR = values[bottomOffset + c + 1], vBL = values[bottomOffset + c];
          if (!Number.isFinite(vTL) || !Number.isFinite(vTR) || !Number.isFinite(vBR) || !Number.isFinite(vBL)) continue;
          const tl = vTL < 0, tr = vTR < 0, br = vBR < 0, bl = vBL < 0;
          const mask = (tl ? 1 : 0) | (tr ? 2 : 0) | (br ? 4 : 0) | (bl ? 8 : 0);
          if (mask === 0 || mask === 15) continue;
          const edgeIds = [hEdge(r, c), vEdge(r, c + 1), hEdge(r + 1, c), vEdge(r, c)];
          const nodeIds = edgeIds.slice();
          const points = [null, null, null, null];
          const vertexTL = topOffset + c, vertexTR = topOffset + c + 1;
          const vertexBR = bottomOffset + c + 1, vertexBL = bottomOffset + c;
          if (tl !== tr) { const hit = crossing(edgeIds[0], vertexTL, vertexTR, x0, y0, vTL, x1, y0, vTR); points[0] = hit.point; nodeIds[0] = hit.id; }
          if (tr !== br) { const hit = crossing(edgeIds[1], vertexTR, vertexBR, x1, y0, vTR, x1, y1, vBR); points[1] = hit.point; nodeIds[1] = hit.id; }
          if (br !== bl) { const hit = crossing(edgeIds[2], vertexBR, vertexBL, x1, y1, vBR, x0, y1, vBL); points[2] = hit.point; nodeIds[2] = hit.id; }
          if (bl !== tl) { const hit = crossing(edgeIds[3], vertexBL, vertexTL, x0, y1, vBL, x0, y0, vTL); points[3] = hit.point; nodeIds[3] = hit.id; }
          const active = [];
          for (let edge = 0; edge < 4; edge++) if (points[edge]) active.push(edge);
          if (active.length === 2) addSegment(nodeIds[active[0]], nodeIds[active[1]]);
          else if (active.length === 4) {
            const centerNegative = (vTL + vTR + vBR + vBL) * 0.25 < 0;
            if ((mask === 5 && centerNegative) || (mask === 10 && !centerNegative)) {
              addSegment(nodeIds[0], nodeIds[1]); addSegment(nodeIds[2], nodeIds[3]);
            } else {
              addSegment(nodeIds[0], nodeIds[3]); addSegment(nodeIds[1], nodeIds[2]);
            }
          }
        }
      }

      const used = new Uint8Array(segments.length);
      function tracePath(startEdge, firstSegment) {
        const start = pointByEdge.get(startEdge);
        if (!start) return;
        targetCtx.moveTo(start[0], start[1]);
        let currentEdge = startEdge, segmentIndex = firstSegment, guard = 0;
        while (segmentIndex !== undefined && !used[segmentIndex] && guard++ <= segments.length + 1) {
          used[segmentIndex] = 1;
          const segment = segments[segmentIndex];
          const nextEdge = segment[0] === currentEdge ? segment[1] : segment[0];
          const point = pointByEdge.get(nextEdge);
          if (!point) break;
          targetCtx.lineTo(point[0], point[1]);
          currentEdge = nextEdge;
          const adjacent = linksByEdge.get(currentEdge) || [];
          if (currentEdge !== startEdge && adjacent.length !== 2) break;
          segmentIndex = undefined;
          for (const candidate of adjacent) if (!used[candidate]) { segmentIndex = candidate; break; }
          if (currentEdge === startEdge) break;
        }
      }
      targetCtx.beginPath();
      for (const [edgeId, adjacent] of linksByEdge) {
        if (adjacent.length !== 2) for (const segmentIndex of adjacent) if (!used[segmentIndex]) tracePath(edgeId, segmentIndex);
      }
      for (let i = 0; i < segments.length; i++) if (!used[i]) tracePath(segments[i][0], i);
      targetCtx.strokeStyle = equation.color;
      targetCtx.lineWidth = 1.65;
      targetCtx.lineJoin = "round";
      targetCtx.lineCap = "round";
      targetCtx.stroke();
    }
  }

  function updateRenderCache() {
    if (renderCache.width !== canvas.width || renderCache.height !== canvas.height) {
      renderCache.width = canvas.width;
      renderCache.height = canvas.height;
    }
    const cacheCtx = renderCache.getContext("2d");
    if (!cacheCtx) return;
    cacheCtx.clearRect(0, 0, renderCache.width, renderCache.height);
    cacheCtx.drawImage(canvas, 0, 0);
    renderCacheValid = true;
  }

  function drawEquationLayer(equation, viewKey, forceSampling = false) {
    const key = `${viewKey}|${equation.preparedKey || equation.latex}`;
    let layer = equation.renderLayer;
    if (!layer) {
      layer = document.createElement("canvas");
      equation.renderLayer = layer;
    }
    const ready = ensureSampled(equation, viewKey, forceSampling);
    if (!ready) return;
    if (equation.renderKey !== key || layer.width !== canvas.width || layer.height !== canvas.height) {
      if (layer.width !== canvas.width) layer.width = canvas.width;
      if (layer.height !== canvas.height) layer.height = canvas.height;
      const layerCtx = layer.getContext("2d");
      if (!layerCtx) return;
      const dpr = window.devicePixelRatio || 1;
      layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layerCtx.clearRect(0, 0, canvasWidth, canvasHeight);
      drawImplicit(equation, layerCtx);
      equation.renderKey = key;
    }
    ctx.drawImage(layer, 0, 0, canvasWidth, canvasHeight);
  }

  function draw(forceSampling = false) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvasWidth, canvasHeight);
    ctx.clip();
    drawGrid();
    const viewKey = currentViewKey();
    for (const equation of equations) {
      if (equation.enabled && equation.kind === "graph" && !equation.error && equation.latex.trim()) {
        drawEquationLayer(equation, viewKey, forceSampling);
      }
    }
    // A named value like `p=(1,2)` is still a usable variable definition, but
    // its tuple value is also rendered as a point on the graph.
    for (const equation of equations) {
      const point = equation.pointValue;
      if (!point || equation.error || point.x < camera.xMin || point.x > camera.xMax
        || point.y < camera.yMin || point.y > camera.yMax) continue;
      const [px, py] = toScreen(point.x, point.y);
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = equation.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.92)";
      ctx.lineWidth = 1.15;
      ctx.stroke();
    }
    ctx.restore();
    updateRenderCache();
  }

  function drawPanPreview(dx, dy) {
    if (!renderCacheValid) return;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.drawImage(renderCache, dx, dy, canvasWidth, canvasHeight);
  }

  function drawZoomPreview(baseCamera) {
    if (!renderCacheValid) return;
    const sx = (baseCamera.xMax - baseCamera.xMin) / (camera.xMax - camera.xMin);
    const sy = (baseCamera.yMax - baseCamera.yMin) / (camera.yMax - camera.yMin);
    const tx = ((baseCamera.xMin - camera.xMin) / (camera.xMax - camera.xMin)) * canvasWidth;
    const ty = ((camera.yMax - baseCamera.yMax) / (camera.yMax - camera.yMin)) * canvasHeight;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.drawImage(renderCache, tx, ty, canvasWidth * sx, canvasHeight * sy);
  }

  function resetView() {
    camera.xMin = -DEFAULT_X_RANGE * 0.5;
    camera.xMax = DEFAULT_X_RANGE * 0.5;
    const yRange = DEFAULT_X_RANGE * (canvasHeight / Math.max(1, canvasWidth));
    camera.yMin = -yRange * 0.5;
    camera.yMax = yRange * 0.5;
    draw();
  }

  function cameraCoordinateLatex(value) {
    const text = String(Number(value.toPrecision(10)));
    const scientific = text.match(/^(-?\d+(?:\.\d+)?)e([+-]?\d+)$/i);
    return scientific ? `${scientific[1]}\\times10^{${Number(scientific[2])}}` : text;
  }

  function setCameraControlStatus(message, isError = false) {
    cameraControlStatus.textContent = message;
    cameraControlStatus.classList.toggle("error", isError);
  }

  function openCameraControlWindow() {
    const centerX = camera.xMin + (camera.xMax - camera.xMin) / 2;
    const centerY = camera.yMin + (camera.yMax - camera.yMin) / 2;
    cameraControlWindow.hidden = false;
    cameraControlButton.setAttribute("aria-expanded", "true");
    setCameraControlStatus("");
    cameraMathField.latex(String.raw`\left(${cameraCoordinateLatex(centerX)},${cameraCoordinateLatex(centerY)}\right)`);
    cameraMathField.focus();
    cameraMathField.moveToRightEnd();
    requestAnimationFrame(() => cameraMathField.reflow?.());
  }

  function closeCameraControlWindow() {
    cameraControlWindow.hidden = true;
    cameraControlButton.setAttribute("aria-expanded", "false");
    cameraControlButton.focus();
  }

  function evaluateCameraTarget(source) {
    const latex = String(source ?? "").trim();
    if (!latex) throw new Error("Enter an ordered pair.");
    const piecewiseContext = { ce, knownNames: knownDefinitionNames, piecewise: new Map(), nextPiecewiseIndex: 0 };
    const collectionSource = transformCollectionSyntax(latex, ce, knownDefinitionNames);
    const transformedSource = transformPiecewise(collectionSource, piecewiseContext);
    const expression = ce.parse(normalizeLatex(transformedSource, knownDefinitionNames));
    if (!expression?.isValid) {
      const details = expression?.errors?.map(String).join("; ");
      throw new Error(details || "Could not parse this expression.");
    }

    const unknowns = [...(expression.unknowns || [])].map(String);
    if (unknowns.includes("x") || unknowns.includes("y")) {
      throw new Error("The target pair must be constant and cannot depend on x or y.");
    }
    const point = pointValueFromExpression(expression, true);
    if (point) return point;

    const evaluated = createAstEvaluator(ce, piecewiseContext.piecewise).evaluate(expression.json, {});
    if (Array.isArray(evaluated) && evaluated.length === 2) {
      const coordinates = evaluated.map((value) => {
        if (typeof value === "number") return cleanRealNumber(value);
        if (typeof value === "boolean" || Array.isArray(value) || typeof value === "string") return null;
        try { return numericRealValue(ce.box(value)); } catch { return null; }
      });
      if (coordinates[0] !== null && coordinates[1] !== null) {
        return { x: coordinates[0], y: coordinates[1] };
      }
    }
    throw new Error("Enter one constant ordered pair with two finite real coordinates.");
  }

  function jumpToCameraTarget() {
    try {
      const point = evaluateCameraTarget(cameraMathField.latex());
      if (wheelTimer) {
        clearTimeout(wheelTimer);
        wheelTimer = 0;
        wheelBaseCamera = null;
      }
      hideHoverTooltip();
      centerCameraOn(camera, point);
      draw();
      setCameraControlStatus(`Centered at (${formatReadoutCoordinate(point.x)}, ${formatReadoutCoordinate(point.y)})`);
      cameraMathField.focus();
    } catch (error) {
      setCameraControlStatus(error instanceof Error ? error.message : String(error), true);
      cameraMathField.focus();
    }
  }

  autoCalculateToggle.addEventListener("click", () => {
    autoCalculate = !autoCalculate;
    updateCalculationControls();
    if (autoCalculate) {
      setStatus("Auto calculation enabled · graphs update after edits, pan, and zoom");
      draw();
    } else {
      setStatus("Auto calculation is off · click Calculate current view to update graphs");
      draw();
    }
  });

  calculateButton.addEventListener("click", () => {
    // Read live MathQuill values before sampling, even if the input debounce has
    // not fired yet. This avoids calculating the previous expression by accident.
    let definitionsNeedRefresh = false;
    const fields = equationList.querySelectorAll(".equation-preview");
    fields.forEach((field, index) => {
      const equation = equations[index];
      if (!equation) return;
      const latex = stripDelimiterDecoration(/** @type {MathFieldLike} */(field).value).trim();
      if (equation.latex === latex) return;
      equation.latex = latex;
      equation.sampleRequestedKey = "";
      equation.sampleData = undefined;
      equation.renderKey = "";
      definitionsNeedRefresh = true;
    });
    if (definitionsNeedRefresh) {
      prepareGraphEvaluators();
      updateAllEquationRowPresentations();
    }

    const graphCount = equations.filter((item) => item.enabled && item.kind === "graph" && !item.error && item.latex.trim()).length;
    if (graphCount === 0) {
      draw();
      setStatus("There are no enabled, valid graph expressions to calculate.");
      return;
    }
    setStatus("Calculating graphs for the current camera…");
    draw(true);
  });

  function makeProjectJSON() {
    const expressionRows = equations.map((equation) => ({
      // `equation.latex` retains MathQuill's `\ ` spacing and is free of
      // its colored-bracket wrappers, so the stored source round-trips
      // through MathQuill without losing spaces (e.g. in `for x of ...`).
      latex: equation.latex,
      color: equation.color,
      enabled: equation.enabled,
      // Informational hint only. On load, each row is reclassified from
      // its LaTeX; a stale or wrong `kind` cannot break anything.
      kind: equation.kind,
    }));
    const variables = [];
    const functions = [];
    for (const equation of equations) {
      const definition = parseDefinitionSource(equation.latex);
      if (!definition) continue;
      if (definition.kind === "variable") {
        variables.push({
          name: definition.name, valueExpression: definition.rhs,
          preview: equation.definitionPreview || (Number.isFinite(equation.definitionValue) ? equation.definitionValue : null)
        });
      } else {
        functions.push({ name: definition.name, args: definition.args, body: definition.rhs });
      }
    }
    return {
      format: "adaptive-latex-plotter",
      version: 2,
      camera: { xMin: camera.xMin, xMax: camera.xMax, yMin: camera.yMin, yMax: camera.yMax },
      expressions: expressionRows,
      variables,
      functions,
      autoCalculate,
    };
  }

  function downloadProjectJSON() {
    const json = JSON.stringify(makeProjectJSON(), null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "adaptive-plotter.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported ${equations.filter((item) => item.latex.trim()).length} expressions to JSON.`);
  }

  async function importProjectJSON(file) {
    let project;
    try {
      project = JSON.parse(await file.text());
    } catch (error) {
      setStatus(`Could not read JSON: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    if (!project || project.format !== "adaptive-latex-plotter" || !Array.isArray(project.expressions)) {
      setStatus("This file is not a supported Adaptive LaTeX Plotter project.", true);
      return;
    }
    // v2 only adds fields on top of v1. Loading a file with a higher
    // version is still attempted; the `latex` field is parsed identically
    // across versions, so v1 and v2 remain interchangeable.
    const version = Number(project.version) || 1;
    if (version > 2) {
      setStatus(`This project was written by a newer version (${version}); loading what we can.`, true);
    }
    const nextCamera = project.camera;
    if (nextCamera && ![nextCamera.xMin, nextCamera.xMax, nextCamera.yMin, nextCamera.yMax].every(Number.isFinite)) {
      setStatus("The project has invalid camera bounds.", true);
      return;
    }
    const imported = [];
    for (const row of project.expressions) {
      if (!row || typeof row.latex !== "string") continue;
      const equation = makeEquation(row.latex);
      if (typeof row.color === "string" && /^#[0-9a-f]{6}$/i.test(row.color)) equation.color = row.color;
      equation.enabled = row.enabled !== false;
      // Optional v2 hint. prepareGraphEvaluators reclassifies and overwrites
      // this anyway, so a stale hint is harmless.
      if (version >= 2 && typeof row.kind === "string") {
        equation.kind = /** @type {EquationKind} */ (row.kind);
      }
      imported.push(equation);
    }
    equations.splice(0, equations.length, ...imported);
    ensureTrailingEmptyEquation();
    if (nextCamera && nextCamera.xMax > nextCamera.xMin && nextCamera.yMax > nextCamera.yMin) {
      camera.xMin = nextCamera.xMin;
      camera.xMax = nextCamera.xMax;
      camera.yMin = nextCamera.yMin;
      camera.yMax = nextCamera.yMax;
      hasInitializedView = true;
    }
    if (typeof project.autoCalculate === "boolean") autoCalculate = project.autoCalculate;
    definitionSignature = null;
    for (const equation of equations) {
      equation.sampleData = undefined;
      equation.sampleRequestedKey = "";
      equation.renderKey = "";
      equation.renderLayer = undefined;
    }
    prepareGraphEvaluators();
    updateAllEquationRowPresentations();
    renderEquationList();
    updateCalculationControls();
    draw();
    setStatus(`Imported ${imported.filter((item) => item.latex.trim()).length} expressions, definitions, and camera state.`);
  }

  addExpressionButton.addEventListener("click", () => addEquation());
  document.querySelector("#exportButton").addEventListener("click", downloadProjectJSON);
  const importButton = document.querySelector("#importButton");
  const importFileInput = /** @type {HTMLInputElement} */ (document.querySelector("#importFileInput"));
  importButton.addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files?.[0];
    if (file) await importProjectJSON(file);
    importFileInput.value = "";
  });

  document.querySelector("#exampleButton").addEventListener("click", () => {
    // Replace the trailing empty row when possible, otherwise append a new graph.
    if (equations.length && !equations[equations.length - 1].latex.trim()) equations[equations.length - 1].latex = EXAMPLE;
    else equations.push(makeEquation(EXAMPLE));
    ensureTrailingEmptyEquation();
    prepareGraphEvaluators();
    renderEquationList();
    draw();
    setStatus("Heart equation added");
  });
  document.querySelector("#resetViewButton").addEventListener("click", resetView);
  document.querySelector("#clearButton").addEventListener("click", () => {
    equations.length = 0;
    definitionSignature = null;
    prepareGraphEvaluators();
    renderEquationList();
    draw();
    setStatus("All expressions cleared.");
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    hideHoverTooltip();
    if (wheelTimer) {
      clearTimeout(wheelTimer);
      wheelTimer = 0;
      wheelBaseCamera = null;
      draw();
    }
    const rect = canvas.getBoundingClientRect();
    dragging = { x: event.clientX - rect.left, y: event.clientY - rect.top, camera: { ...camera } };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (dragging) {
      hideHoverTooltip();
      const rect = canvas.getBoundingClientRect();
      drawPanPreview(event.clientX - rect.left - dragging.x, event.clientY - rect.top - dragging.y);
      return;
    }
    updateHoverReadout(event);
  });
  canvas.addEventListener("pointerleave", hideHoverTooltip);
  function stopDragging(event) {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const dx = event.clientX - rect.left - dragging.x;
    const dy = event.clientY - rect.top - dragging.y;
    const base = dragging.camera;
    const xRange = base.xMax - base.xMin;
    const yRange = base.yMax - base.yMin;
    camera.xMin = base.xMin - (dx / canvasWidth) * xRange;
    camera.xMax = base.xMax - (dx / canvasWidth) * xRange;
    camera.yMin = base.yMin + (dy / canvasHeight) * yRange;
    camera.yMax = base.yMax + (dy / canvasHeight) * yRange;
    dragging = null;
    draw();
  }
  canvas.addEventListener("pointerup", stopDragging);
  canvas.addEventListener("pointercancel", stopDragging);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    hideHoverTooltip();
    if (dragging) return;
    if (!wheelBaseCamera) wheelBaseCamera = { ...camera };
    const factor = Math.exp(event.deltaY * 0.001);
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const [anchorX, anchorY] = toWorld(pointerX, pointerY);
    const oldXRange = camera.xMax - camera.xMin;
    const oldYRange = camera.yMax - camera.yMin;
    const newXRange = Math.max(1e-5, Math.min(1e8, oldXRange * factor));
    const newYRange = Math.max(1e-5, Math.min(1e8, oldYRange * factor));
    const xRatio = pointerX / canvasWidth;
    const yRatio = pointerY / canvasHeight;
    camera.xMin = anchorX - xRatio * newXRange;
    camera.xMax = camera.xMin + newXRange;
    camera.yMax = anchorY + yRatio * newYRange;
    camera.yMin = camera.yMax - newYRange;
    drawZoomPreview(wheelBaseCamera);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = 0;
      wheelBaseCamera = null;
      draw();
    }, 120);
  }, { passive: false });

  window.addEventListener("resize", resize);
  cameraMathField = MQ.MathField(cameraCoordinateField, {
    restrictMismatchedBrackets: true,
    autoOperatorNames: MATHQUILL_AUTO_OPERATOR_NAMES,
    autoCommands: "pi theta sqrt sum prod coprod",
  });
  cameraControlButton.addEventListener("click", () => {
    if (cameraControlWindow.hidden) openCameraControlWindow();
    else closeCameraControlWindow();
  });
  cameraControlClose.addEventListener("click", closeCameraControlWindow);
  cameraJumpButton.addEventListener("click", jumpToCameraTarget);
  updateCalculationControls();
  resize();
  addEquation(String.raw`y=x^{2}`);
  setStatus("Ready · type in the empty row to add an expression");
});
