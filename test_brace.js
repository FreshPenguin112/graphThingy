function compactLatex_source(source) {
  return source
    .replace(/\\left|\\right/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeCondition(condition) {
  let result = String(condition ?? "").trim();

  const textIf = result.match(/^\\text\s*\{\s*if\b([^}]*)\}\s*(.*)$/i);
  if (textIf) result = textIf[1].trim() || textIf[2].trim();
  result = result.replace(/^\\mathrm\s*\{\s*if\b([^}]*)\}\s*(.*)$/i, (_all, inline, tail) => String(inline).trim() || String(tail).trim());
  result = result.replace(/^\\text\s*\{\s*if\s*\}\s*/i, "").replace(/^\\mathrm\s*\{\s*if\s*\}\s*/i, "");
  result = result.replace(/^if\s+/i, "").trim();
  result = result
    .replace(/\\(?:text|mathrm|operatorname)\s*\{\s*and\s*\}/gi, "\\land")
    .replace(/\\(?:text|mathrm|operatorname)\s*\{\s*or\s*\}/gi, "\\lor")
    .replace(/(?<![A-Za-z0-9_])and(?![A-Za-z0-9_])/gi, "\\land")
    .replace(/(?<![A-Za-z0-9_])or(?![A-Za-z0-9_])/gi, "\\lor");

  // dummy normalizePiecewiseConditionEquivalence
  result = result; // no-op

  const simple = compactLatex_source(result).toLowerCase();
  if (["true", "\\text{true}", "\\mathrm{true}", "\\top", "top", "⊤"].includes(simple)) return "\\top";
  if (["false", "\\text{false}", "\\mathrm{false}", "\\bot", "bot", "⊥"].includes(simple)) return "\\bot";
  if (["otherwise", "else"].includes(simple)) return "\\top";
  return result || "\\top";
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

function parseBraceBranches(body) {
  const entries = splitTopLevel(body, ",");
  if (!entries.length || entries.some((entry) => !entry)) return null;
  const branches = [];
  let sawColonStyle = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const colonParts = splitTopLevel(entry, ":");
    if (colonParts.length >= 2) {
      const condition = colonParts.shift();
      const output = colonParts.join(":").trim();
      if (condition && output) {
        sawColonStyle = true;
        const normCond = normalizeCondition(condition);
        branches.push({ condition: normCond, output });
        continue;
      }
    }
    if (sawColonStyle && index === entries.length - 1 && entry.trim()) {
      const conditions = branches.map((item) => item.condition);
      const anyPrevious = conditions.map((condition) => `\\left(${condition}\\right)`).join("\\lor");
      branches.push({ condition: `\\neg\\left(${anyPrevious}\\right)`, output: entry.trim() });
      continue;
    }
    return null;
  }
  return branches.length ? branches : null;
}

const result = parseBraceBranches("False:1,0");
console.log("parseBraceBranches('False:1,0'):", JSON.stringify(result, null, 2));

// Also test just False alone
const result2 = parseBraceBranches("False");
console.log("parseBraceBranches('False'):", JSON.stringify(result2, null, 2));

// Test true:1,0
const result3 = parseBraceBranches("True:1,0");
console.log("parseBraceBranches('True:1,0'):", JSON.stringify(result3, null, 2));
