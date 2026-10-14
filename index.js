import { ComputeEngine, compile } from "@cortex-js/compute-engine";
import SamplerWorker from "./sampler-worker.js?worker&inline";
import {
  LOWERCASE_FUNCTION_ALIASES,
  MATHQUILL_AUTO_OPERATOR_NAMES,
  SET_ALIASES,
  createInlineSampler,
  normalizeLatex,
  normalizeLatexSpacing,
  normalizeSpreadNotation,
  stripDelimiterDecoration,
  repairMalformedFunctionNotation,
} from "./sampler.js";
import { normalizeTouchGesture } from "./mobile-gesture.js";
import {
  filterMobileSymbols,
  MOBILE_KEYBOARD_CATEGORIES,
  MOBILE_KEYBOARD_SYMBOLS,
  mobileKeyboardLetter,
  mobileKeyboardPower,
} from "./mobile-keyboard-symbols.js";
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
 * @property {string} [fallbackReason]
 * @property {(x:number, y:number) => number} evaluate
 * @property {string} [name]
 * @property {string[]} [args]
 * @property {string} [rhs]
 * @property {string} [relation]
 * @property {{sampleKey:string,cols:number,rows:number,step:number,components:{relation:string,values:Float64Array}[]}} [sampleData]
 * @property {string} [sampleRequestedKey]
 * @property {number} [sampleReqId]
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
  const drawer = /** @type {HTMLElement} */ (document.querySelector("#expressionDrawer"));
  const drawerCloseButton = /** @type {HTMLButtonElement} */ (document.querySelector("#drawerCloseButton"));
  const mobileAddExpressionButton = /** @type {HTMLButtonElement} */ (document.querySelector("#mobileAddExpressionButton"));
  const mobileResetButton = /** @type {HTMLButtonElement} */ (document.querySelector("#mobileResetButton"));
  const mobileKeyboardToggle = /** @type {HTMLButtonElement} */ (document.querySelector("#mobileKeyboardToggle"));
  const mobileKeyboard = /** @type {HTMLElement} */ (document.querySelector("#mobileKeyboard"));
  const mobileLatexInput = /** @type {HTMLInputElement} */ (document.querySelector("#mobileLatexInput"));
  const mobileLatexInsertButton = /** @type {HTMLButtonElement} */ (document.querySelector("#mobileLatexInsertButton"));
  const mobileSymbolSearch = /** @type {HTMLInputElement} */ (document.querySelector("#mobileSymbolSearch"));
  const mobileSymbolCategories = /** @type {HTMLDivElement} */ (document.querySelector("#mobileSymbolCategories"));
  const mobileSymbolResults = /** @type {HTMLDivElement} */ (document.querySelector("#mobileSymbolResults"));
  const isTouchInterface = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  let mobileShiftActive = false;
  let mobileCapsLockActive = false;
  let activeMobileSymbolCategory = "All";
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
  function getActiveMathField() {
    const activeElement = document.activeElement;
    const activeField = activeElement?.closest?.(".equation-preview") || lastFocusedMathFieldElement;
    const candidate = activeField?.mathField || activeField?.piecewiseMathField || null;
    return candidate;
  }

  function ensureFocusedEquationField(row = null) {
    const focused = document.activeElement?.closest?.(".equation-preview") || lastFocusedMathFieldElement;
    const target = row || focused || document.querySelector(".equation-row:last-of-type .equation-preview");
    const field = target?.mathField ? target : target?.querySelector?.(".equation-preview") || target;
    if (!field) return null;
    lastFocusedMathFieldElement = field;
    const mathField = field.mathField || field.piecewiseMathField || null;
    if (mathField && typeof mathField.focus === "function") {
      mathField.focus();
      return mathField;
    }
    if (typeof field.focus === "function") {
      field.focus();
    }
    return mathField;
  }

  function insertIntoActiveMathField(latex) {
    const field = getActiveMathField() || ensureFocusedEquationField();
    if (!field) return;
    field.write(String(latex ?? ""));
  }

  function openMobileKeyboard() {
    if (!mobileKeyboard) return;
    mobileKeyboard.hidden = false;
    drawer?.classList.add("mobile-open");
  }

  function closeMobileKeyboard() {
    if (!mobileKeyboard) return;
    mobileKeyboard.hidden = true;
  }

  function setMobileKeyboardMode(mode) {
    if (!mobileKeyboard) return;
    const nextMode = ["math", "text", "symbols"].includes(mode) ? mode : "math";
    mobileKeyboard.dataset.mode = nextMode;
    mobileKeyboard.querySelectorAll("[data-keyboard-mode]").forEach((button) => {
      const selected = button.getAttribute("data-keyboard-mode") === nextMode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    for (const [key, modeName] of [["math", "math"], ["text", "text"], ["symbols", "symbols"]]) {
      const group = mobileKeyboard.querySelector(`.keyboard-mode-${key}`);
      if (group) group.hidden = nextMode !== modeName;
    }
    const advancedInput = mobileLatexInput?.closest(".keyboard-advanced");
    if (advancedInput) advancedInput.hidden = nextMode !== "text";
    if (mobileSymbolSearch) mobileSymbolSearch.closest(".keyboard-symbol-search").hidden = nextMode === "math";
    renderMobileSymbolCategories();
    renderMobileSymbolResults();
  }

  function renderMobileSymbolCategories() {
    if (!mobileSymbolCategories) return;
    const categories = ["All", ...MOBILE_KEYBOARD_CATEGORIES];
    mobileSymbolCategories.replaceChildren();
    for (const category of categories) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "keyboard-category-button";
      button.dataset.symbolCategory = category;
      button.textContent = category;
      button.setAttribute("aria-pressed", String(category === activeMobileSymbolCategory));
      mobileSymbolCategories.append(button);
    }
  }

  function renderMobileSymbolResults() {
    if (!mobileSymbolResults) return;
    const matches = filterMobileSymbols(MOBILE_KEYBOARD_SYMBOLS, {
      category: activeMobileSymbolCategory,
      query: mobileSymbolSearch?.value || "",
    });
    mobileSymbolResults.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "keyboard-symbol-empty";
      empty.textContent = "No matching symbols";
      mobileSymbolResults.append(empty);
      return;
    }
    for (const symbol of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.symbolId = String(symbol.id);
      button.title = `${symbol.label} (${symbol.latex})`;
      button.setAttribute("role", "listitem");
      button.setAttribute("aria-label", `Insert ${symbol.label}, ${symbol.latex}`);
      const glyph = document.createElement("span");
      glyph.className = "keyboard-symbol-glyph";
      glyph.textContent = symbol.glyph;
      const label = document.createElement("span");
      label.className = "keyboard-symbol-label";
      label.textContent = symbol.label;
      button.append(glyph, label);
      mobileSymbolResults.append(button);
    }
  }

  function getFocusedMobileTextInput() {
    const activeElement = document.activeElement;
    return activeElement === mobileLatexInput || activeElement === mobileSymbolSearch ? activeElement : null;
  }

  function insertTextAtSelection(input, value) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(value, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function updateMobileCaseControls() {
    mobileKeyboard?.querySelectorAll("[data-case]").forEach((button) => {
      const keyCase = button.getAttribute("data-case");
      const pressed = keyCase === "shift" ? mobileShiftActive : mobileCapsLockActive;
      button.classList.toggle("active", pressed);
      button.setAttribute("aria-pressed", String(pressed));
    });
    mobileKeyboard?.querySelectorAll(".keyboard-mode-text [data-insert]").forEach((button) => {
      const value = button.getAttribute("data-insert") || "";
      if (/^[a-z]$/i.test(value)) {
        button.textContent = mobileKeyboardLetter(value, {
          shifted: mobileShiftActive,
          capsLock: mobileCapsLockActive,
        });
      }
    });
  }

  function closeMobileDrawer() {
    drawer?.classList.remove("mobile-open");
    if (isTouchInterface) {
      closeMobileKeyboard();
      return;
    }
    const field = getActiveMathField();
    field?.focus?.();
  }

  function toggleMobileDrawer() {
    if (!drawer) return;
    drawer.classList.toggle("mobile-open");
    if (drawer.classList.contains("mobile-open")) {
      if (isTouchInterface) {
        openMobileKeyboard();
        return;
      }
      const field = getActiveMathField();
      field?.focus?.();
    }
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !colorPalette.hidden) {
      const returnFocus = activeColorAnchor;
      closeColorPalette();
      returnFocus?.focus();
    }
    if (event.key === "Escape" && mobileKeyboard && !mobileKeyboard.hidden) {
      closeMobileKeyboard();
      getActiveMathField()?.focus?.();
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
    if (event.target?.closest?.("#mobileKeyboard")) return;
    const field = event.target?.closest?.(".equation-row")?.querySelector?.(".equation-preview");
    if (field?.mathField) lastFocusedMathFieldElement = field;
    else if (!event.target?.closest?.(".color-palette")) lastFocusedMathFieldElement = null;
  }, true);
  document.addEventListener("focusin", (event) => {
    if (event.target === mobileLatexInput || event.target === mobileSymbolSearch) return;
    const field = event.target?.closest?.(".equation-preview");
    if (field?.mathField) lastFocusedMathFieldElement = field;
    else if (!isMathQuillHiddenInput(event.target)) lastFocusedMathFieldElement = null;
  }, true);

  function suppressMathQuillNativeKeyboard(host) {
    if (!isTouchInterface) return;
    for (const textarea of host.querySelectorAll("textarea")) {
      textarea.setAttribute("inputmode", "none");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("spellcheck", "false");
    }
  }

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
  // The sampler runs in a Web Worker (sampler-worker.js). The same code is kept here
  // as a fallback for browsers that cannot start workers, and for the parser helpers.
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
  /** Worker requests waiting for a result, keyed by request id. */
  const pendingSampleRequests = new Map();
  let nextSampleRequestId = 1;
  /** @type {Worker|null} */
  let samplerWorker = null;
  let samplerWorkerUnavailable = false;
  // Start the worker now so its startup (loading the engine) overlaps with page setup.
  getSamplerWorker()?.postMessage({ type: "warmup" });

  function getSamplerWorker() {
    if (samplerWorker || samplerWorkerUnavailable) return samplerWorker;
    try {
      const worker = new SamplerWorker();
      worker.addEventListener("message", (event) => {
        const { reqId, result } = event.data;
        const resolve = pendingSampleRequests.get(reqId);
        if (!resolve) return;
        pendingSampleRequests.delete(reqId);
        resolve(result ?? null);
      });
      worker.addEventListener("error", (event) => {
        console.error("[plotter:sample] worker failed; sampling on the main thread from now on", event);
        worker.terminate();
        samplerWorker = null;
        samplerWorkerUnavailable = true;
        // Anything in flight is re-run on the main thread by its caller.
        const waiting = [...pendingSampleRequests.values()];
        pendingSampleRequests.clear();
        for (const resolve of waiting) resolve({ retryOnMainThread: true });
      });
      samplerWorker = worker;
    } catch (error) {
      console.warn("[plotter] Web Workers are unavailable; sampling on the main thread.", error);
      samplerWorkerUnavailable = true;
    }
    return samplerWorker;
  }

  /**
   * Start one sample job. Returns the request id (used to cancel it) and a promise
   * that resolves to the result, or null when the job was cancelled.
   */
  function startSampleRequest(message, cancelled) {
    const reqId = nextSampleRequestId++;
    const worker = getSamplerWorker();
    const promise = new Promise((resolve) => {
      if (worker) {
        pendingSampleRequests.set(reqId, resolve);
        worker.postMessage({ ...message, type: "sample", reqId });
      } else {
        sampleInline(message, cancelled).then(resolve);
      }
    }).then((result) => (result?.retryOnMainThread ? sampleInline(message, cancelled) : result));
    return { reqId, promise };
  }

  /** Stop the sample job for an equation whose result is no longer wanted. */
  function cancelSampleRequest(equation) {
    const reqId = equation.sampleReqId;
    if (!reqId) return;
    equation.sampleReqId = 0;
    const resolve = pendingSampleRequests.get(reqId);
    if (!resolve) return;
    pendingSampleRequests.delete(reqId);
    samplerWorker?.postMessage({ type: "cancel", reqId });
    resolve(null);
  }
  /** @type {Equation[]} */
  const equations = [];
  let nextId = 1;
  let canvasWidth = window.innerWidth;
  let canvasHeight = window.innerHeight;
  /** @type {{x:number,y:number,camera: typeof camera}|null} */
  let dragging = null;
  /** @type {Map<number, {x:number, y:number}>} */
  const activeTouches = new Map();
  /** @type {{startDistance:number,startCamera: typeof camera}|null} */
  let pinchGesture = null;
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
    const showCompileWarning = equation.kind === "graph" && Boolean(equation.fallbackReason) && !equation.error;
    row.classList.toggle("not-compiled", showCompileWarning);
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.style.visibility = equation.kind === "graph" ? "visible" : "hidden";
    const value = row.querySelector(".value-preview");
    if (!value) return;
    value.classList.toggle("not-compiled", showCompileWarning);
    value.tabIndex = showCompileWarning ? 0 : -1;
    if (showCompileWarning) {
      value.textContent = "Not compiled";
      value.title = `Not compiled: ${equation.fallbackReason}`;
      value.setAttribute("role", "status");
      value.setAttribute("aria-live", "polite");
      value.setAttribute("aria-label", value.title);
      return;
    }
    value.removeAttribute("role");
    value.removeAttribute("aria-live");
    value.removeAttribute("aria-label");
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
      enabled: true, kind: "graph", definitionValue: null, error: "", fallback: false, fallbackReason: "",
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
    input.tabIndex = 0;
    input.addEventListener("pointerdown", (event) => {
      if (!isTouchInterface || event.pointerType === "mouse") return;
      event.preventDefault();
      event.stopPropagation();
      lastFocusedMathFieldElement = input;
      openMobileKeyboard();
      drawer?.classList.add("mobile-open");
      queueMicrotask(() => ensureFocusedEquationField(input));
    });
    row.addEventListener("pointerdown", (event) => {
      if (!isTouchInterface || event.pointerType === "mouse") return;
      if (event.target.closest("button, input, textarea, select")) return;
      event.preventDefault();
      event.stopPropagation();
      lastFocusedMathFieldElement = input;
      openMobileKeyboard();
      drawer?.classList.add("mobile-open");
      queueMicrotask(() => ensureFocusedEquationField(input));
    });

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
      suppressMathQuillNativeKeyboard(host);
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
      suppressMathQuillNativeKeyboard(input);
      if (latex) mathField.latex(latex);
    };

    mathField = MQ.MathField(input, mathFieldConfig);
    suppressMathQuillNativeKeyboard(input);

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
      equation.fallback = false;
      equation.fallbackReason = "";
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
      cancelSampleRequest(equation);
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
        cancelSampleRequest(equation);
      }
      return false;
    }
    if (equation.sampleRequestedKey !== sampleKey) {
      equation.sampleRequestedKey = sampleKey;
      cancelSampleRequest(equation);
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

      const request = startSampleRequest(message, cancelled);
      equation.sampleReqId = request.reqId;
      request.promise.then((result) => {
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
          equation.fallback = false;
          equation.fallbackReason = "";
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
        equation.fallbackReason = result.compilation?.fallbackReason || "";
        equation.fallback = Boolean(equation.fallbackReason);
        equation.renderKey = "";
        updateAllEquationRowPresentations();
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
        equation.fallback = false;
        equation.fallbackReason = "";
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
  mobileAddExpressionButton?.addEventListener("click", () => {
    drawer?.classList.add("mobile-open");
    addEquation();
    if (isTouchInterface) openMobileKeyboard();
    else mobileKeyboard?.removeAttribute("hidden");
  });
  mobileResetButton?.addEventListener("click", () => {
    resetView();
    closeMobileDrawer();
  });
  drawerCloseButton?.addEventListener("click", closeMobileDrawer);
  mobileKeyboard?.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  mobileKeyboard?.querySelectorAll("[data-keyboard-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setMobileKeyboardMode(button.getAttribute("data-keyboard-mode"));
    });
  });
  mobileKeyboard?.querySelectorAll("[data-case]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.getAttribute("data-case") === "shift") mobileShiftActive = !mobileShiftActive;
      else mobileCapsLockActive = !mobileCapsLockActive;
      updateMobileCaseControls();
    });
  });
  mobileSymbolSearch?.addEventListener("input", renderMobileSymbolResults);
  mobileSymbolCategories?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-symbol-category]");
    if (!button) return;
    activeMobileSymbolCategory = button.getAttribute("data-symbol-category") || "All";
    renderMobileSymbolCategories();
    renderMobileSymbolResults();
  });
  mobileSymbolResults?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-symbol-id]");
    if (!button) return;
    const symbol = MOBILE_KEYBOARD_SYMBOLS.find((item) => String(item.id) === button.dataset.symbolId);
    if (symbol) insertIntoActiveMathField(symbol.latex);
  });
  mobileKeyboardToggle?.addEventListener("click", () => {
    if (!mobileKeyboard) return;
    if (mobileKeyboard.hidden) {
      openMobileKeyboard();
      drawer?.classList.add("mobile-open");
      const field = getActiveMathField();
      if (field) field.focus?.();
    } else {
      closeMobileKeyboard();
      closeMobileDrawer();
    }
  });
  mobileKeyboard?.querySelectorAll("[data-insert]").forEach((button) => {
    button.addEventListener("click", () => {
      const rawValue = button.getAttribute("data-insert");
      if (!rawValue) return;
      const isQwertyLetter = Boolean(button.closest(".keyboard-mode-text")) && /^[a-z]$/i.test(rawValue);
      const value = isQwertyLetter
        ? mobileKeyboardLetter(rawValue, { shifted: mobileShiftActive, capsLock: mobileCapsLockActive })
        : rawValue;
      const textInput = getFocusedMobileTextInput();
      if (isQwertyLetter && mobileShiftActive) mobileShiftActive = false;
      updateMobileCaseControls();
      if (textInput) {
        insertTextAtSelection(textInput, value);
        return;
      }
      insertIntoActiveMathField(value);
    });
  });
  mobileKeyboard?.querySelectorAll("[data-power]").forEach((button) => {
    button.addEventListener("click", () => {
      const rawExponent = button.getAttribute("data-power");
      const exponent = rawExponent === "" ? null : Number(rawExponent);
      insertIntoActiveMathField(mobileKeyboardPower(exponent));
    });
  });
  mobileKeyboard?.querySelectorAll("[data-keystroke]").forEach((button) => {
    button.addEventListener("click", () => {
      const keystroke = button.getAttribute("data-keystroke");
      if (!keystroke) return;
      const textInput = getFocusedMobileTextInput();
      if (textInput) {
        const start = textInput.selectionStart ?? textInput.value.length;
        const end = textInput.selectionEnd ?? start;
        if (keystroke === "Backspace") {
          if (start !== end) textInput.setRangeText("", start, end, "start");
          else if (start > 0) textInput.setRangeText("", start - 1, start, "start");
          textInput.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (keystroke === "Left") {
          textInput.setSelectionRange(Math.max(0, start - 1), Math.max(0, start - 1));
        } else if (keystroke === "Right") {
          const next = Math.min(textInput.value.length, end + 1);
          textInput.setSelectionRange(next, next);
        } else if (keystroke === "Up") {
          textInput.setSelectionRange(0, 0);
        } else if (keystroke === "Down") {
          const endOfInput = textInput.value.length;
          textInput.setSelectionRange(endOfInput, endOfInput);
        }
        return;
      }
      (getActiveMathField() || ensureFocusedEquationField())?.keystroke?.(keystroke);
    });
  });
  mobileKeyboard?.querySelector('[data-action="complete-command"]')?.addEventListener("click", () => {
    if (document.activeElement === mobileSymbolSearch) return;
    if (document.activeElement !== mobileLatexInput) {
      (getActiveMathField() || ensureFocusedEquationField())?.keystroke?.("Tab");
      return;
    }
    const prefix = mobileLatexInput.value.trim().replace(/^\\/, "");
    if (!prefix) return;
    const match = MATHQUILL_AUTO_OPERATOR_NAMES.split(/\s+/).find((name) => name.startsWith(prefix));
    if (match) mobileLatexInput.value = `\\${match}`;
  });
  renderMobileSymbolCategories();
  renderMobileSymbolResults();
  updateMobileCaseControls();
  mobileLatexInsertButton?.addEventListener("click", () => {
    const value = mobileLatexInput?.value.trim();
    if (!value) return;
    const field = getActiveMathField() || ensureFocusedEquationField();
    if (!field) return;
    insertIntoActiveMathField(value);
    mobileLatexInput.value = "";
    if (!isTouchInterface) getActiveMathField()?.focus?.();
  });
  mobileLatexInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const prefix = mobileLatexInput.value.trim();
    if (!prefix) return;
    const names = MATHQUILL_AUTO_OPERATOR_NAMES.split(/\s+/)
      .filter((name) => name.startsWith(prefix.replace(/^\\/, "")) || name.startsWith(prefix));
    if (!names.length) return;
    const match = names[0];
    mobileLatexInput.value = match.startsWith("\\") ? match : `\\${match}`;
  });
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
    if (event.pointerType === "mouse" && event.button !== 0) return;
    hideHoverTooltip();
    if (wheelTimer) {
      clearTimeout(wheelTimer);
      wheelTimer = 0;
      wheelBaseCamera = null;
      draw();
    }
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activeTouches.size === 2) {
      const [first, second] = [...activeTouches.values()];
      pinchGesture = {
        startDistance: Math.hypot(second.x - first.x, second.y - first.y),
        startCamera: { ...camera },
      };
      dragging = null;
      return;
    }
    if (activeTouches.size === 1) {
      const rect = canvas.getBoundingClientRect();
      dragging = { x: event.clientX - rect.left, y: event.clientY - rect.top, camera: { ...camera } };
      canvas.setPointerCapture(event.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!activeTouches.has(event.pointerId)) return;
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activeTouches.size >= 2 && pinchGesture) {
      const [first, second] = [...activeTouches.values()];
      const rect = canvas.getBoundingClientRect();
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const center = { x: ((first.x + second.x) / 2) - rect.left, y: ((first.y + second.y) / 2) - rect.top };
      const startCamera = pinchGesture.startCamera;
      const gesture = normalizeTouchGesture({
        mode: "pinch",
        startDistance: pinchGesture.startDistance,
        currentDistance: distance,
        centerX: center.x,
        centerY: center.y,
        viewWidth: canvasWidth,
        viewHeight: canvasHeight,
        camera: startCamera,
      });
      const pointerX = center.x;
      const pointerY = center.y;
      const [anchorX, anchorY] = toWorld(pointerX, pointerY);
      const oldXRange = startCamera.xMax - startCamera.xMin;
      const oldYRange = startCamera.yMax - startCamera.yMin;
      const newXRange = Math.max(1e-5, Math.min(1e8, oldXRange / Math.max(gesture.zoomFactor, 1e-9)));
      const newYRange = Math.max(1e-5, Math.min(1e8, oldYRange / Math.max(gesture.zoomFactor, 1e-9)));
      const xRatio = pointerX / canvasWidth;
      const yRatio = pointerY / canvasHeight;
      camera.xMin = anchorX - xRatio * newXRange;
      camera.xMax = camera.xMin + newXRange;
      camera.yMax = anchorY + yRatio * newYRange;
      camera.yMin = camera.yMax - newYRange;
      drawZoomPreview(startCamera);
      return;
    }

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
  canvas.addEventListener("pointerup", (event) => {
    if (activeTouches.has(event.pointerId)) {
      activeTouches.delete(event.pointerId);
      if (activeTouches.size < 2) {
        pinchGesture = null;
      }
    }
    if (activeTouches.size === 0) {
      stopDragging(event);
    }
  });
  canvas.addEventListener("pointercancel", (event) => {
    activeTouches.delete(event.pointerId);
    if (activeTouches.size < 2) pinchGesture = null;
    stopDragging(event);
  });
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
