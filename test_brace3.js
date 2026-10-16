// Test the asBoolean logic
function asBoolean(value) {
  if (["true", "top", "⊤", "\\top"].includes(value)) return true;
  if (["false", "bot", "⊥", "\\bot"].includes(value)) return false;
  // For strings, try to evaluate
  if (typeof value === "string") {
    const lower = value.toLowerCase().replace(/\s+/g, "");
    if (["true", "top", "⊤", "\\top"].includes(lower)) return true;
    if (["false", "bot", "⊥", "\\bot"].includes(lower)) return false;
  }
  return !!value;
}

console.log("asBoolean(\"\\\\bot\"):", asBoolean("\\bot"));
console.log("asBoolean(\"\\\\top\"):", asBoolean("\\top"));
console.log("asBoolean(\"False\"):", asBoolean("False"));
console.log("asBoolean(\"false\"):", asBoolean("false"));

// Now test the full piecewise condition with negation
function normalizeCondition_simple(condition) {
  let result = String(condition ?? "").trim();
  // Simplified - just check for false patterns
  const simple = result.toLowerCase().replace(/\s+/g, "");
  if (["false", "\\text{false}", "\\mathrm{false}", "\\bot", "bot", "⊥"].includes(simple)) return "\\bot";
  if (["true", "\\text{true}", "\\mathrm{true}", "\\top", "top", "⊤"].includes(simple)) return "\\top";
  return result;
}

function normalizePiecewiseConditionEquivalence(result) {
  return result; // dummy
}

function compactLatex_source(source) {
  return source
    .replace(/\\left|\\right/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeCondition_full(condition) {
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

  result = normalizePiecewiseConditionEquivalence(result);

  const simple = compactLatex_source(result).toLowerCase();
  if (["true", "\\text{true}", "\\mathrm{true}", "\\top", "top", "⊤"].includes(simple)) return "\\top";
  if (["false", "\\text{false}", "\\mathrm{false}", "\\bot", "bot", "⊥"].includes(simple)) return "\\bot";
  if (["otherwise", "else"].includes(simple)) return "\\top";
  return result || "\\top";
}

function splitTopLevel_source(source, separator) {
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

function parseBraceBranches_full(body) {
  const entries = splitTopLevel_source(body, ",");
  if (!entries.length || entries.some((entry) => !entry)) return null;
  const branches = [];
  let sawColonStyle = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const colonParts = splitTopLevel_source(entry, ":");
    if (colonParts.length >= 2) {
      const condition = colonParts.shift();
      const output = colonParts.join(":").trim();
      if (condition && output) {
        sawColonStyle = true;
        const normCond = normalizeCondition_full(condition);
        branches.push({ condition: normCond, output });
        continue;
      }
    }
    // Simplified parseBranchEntry
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

// Test
console.log("\n=== parseBraceBranches_full('False:1,0') ===");
const r1 = parseBraceBranches_full("False:1,0");
console.log(JSON.stringify(r1, null, 2));

console.log("\n=== parseBraceBranches_full('True:1,0') ===");
const r2 = parseBraceBranches_full("True:1,0");
console.log(JSON.stringify(r2, null, 2));

console.log("\n=== parseBraceBranches_full('x>0:1,0') ===");
const r3 = parseBraceBranches_full("x>0:1,0");
console.log(JSON.stringify(r3, null, 2));

// Now let's see what happens when we evaluate the conditions
console.log("\n=== Evaluation test ===");
const branches = parseBraceBranches_full("False:1,0");
console.log("Branches:", JSON.stringify(branches, null, 2));

// Simulate evaluation with no variables (x=0, y=0)
function evalCondition(conditionAst) {
  // Simplified: just check if it's \\bot or \\top
  if (conditionAst === "\\bot") return false;  // asBoolean("\\bot") = false
  if (conditionAst === "\\top") return true;   // asBoolean("\\top") = true
  if (conditionAst.includes("\\neg")) {
    // Negation: !asBoolean(inner)
    const inner = conditionAst.match(/\\\\neg\\\\left\\((.+)\\)\\\\right\)/);
    if (inner) {
      const innerCond = inner[1];
      const innerEval = evalCondition(innerCond);
      return !innerEval;
    }
  }
  return false; // default
}

for (const branch of branches) {
  const condTruthy = evalCondition(branch.condition);
  console.log(`Branch condition "${branch.condition}" evaluates to ${condTruthy}, output: "${branch.output}"`);
}
