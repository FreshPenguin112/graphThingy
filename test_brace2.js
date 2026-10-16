function compactLatex_source(source) {
  return source
    .replace(/\\left|\\right/g, '')
    .replace(/\s+/g, '')
    .trim();
}

// Simplified normalizeCondition - just the part that matters
function normalizeCondition(condition) {
  let result = String(condition ?? "").trim();
  
  // Skip the full normalization for now, just lowercase
  result = result.toLowerCase();
  
  if (["false", "\\text{false}", "\\mathrm{false}", "\\bot", "bot", "⊥"].includes(result)) return "\\bot";
  if (["true", "\\text{true}", "\\mathrm{true}", "\\top", "top", "⊤"].includes(result)) return "\\top";
  return result;
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
        const normCond = normalizeCondition(condition);
        branches.push({ condition: normCond, output });
        continue;
      }
    }
    // Simplified parseBranchEntry - just return null
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

// Test cases
console.log("False:1,0:", JSON.stringify(parseBraceBranches_full("False:1,0"), null, 2));
console.log("");
console.log("True:1,0:", JSON.stringify(parseBraceBranches_full("True:1,0"), null, 2));
console.log("");
console.log("x>0:1,0:", JSON.stringify(parseBraceBranches_full("x>0:1,0"), null, 2));
console.log("");
console.log("otherwise:1,0:", JSON.stringify(parseBraceBranches_full("otherwise:1,0"), null, 2));
