export function equalityKeyAction(sequenceCount) {
  if (sequenceCount === 3) return "swallow";
  if (sequenceCount === 2) return "replace";
  return "pass";
}

export function normalizeEqualityShorthand(source) {
  return String(source ?? "").replace(/={2,3}/g, String.raw`\equiv `);
}

export function normalizeMathQuillSpacing(source) {
  return String(source)
    .replace(/(?<!\\)\\[ ,;:!]/g, " ")
    .replace(/(?<!\\)\\q?quad(?![A-Za-z])/g, " ");
}

export function assertAssignmentOnlyEquals(source, { allowGeneratedConditionEquality = false } = {}) {
  const text = String(source ?? "");
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "=") continue;
    if ([":", "<", ">", "!"].includes(text[index - 1])) continue;
    if (text[index + 1] === "=") continue;
    if (allowGeneratedConditionEquality) continue;
    throw new SyntaxError("Use \\equiv for equality; = is only for assignment.");
  }
}
