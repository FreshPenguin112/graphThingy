import { assertAssignmentOnlyEquals } from "./math-equality.js";

export function lowerIdenticallyEqualForGraph(ast) {
  if (!Array.isArray(ast)) return ast;
  if (ast[0] === "Set") return ast;
  const operator = ast[0] === "IdenticallyEqual" ? "Equal" : ast[0];
  return [operator, ...ast.slice(1).map(lowerIdenticallyEqualForGraph)];
}

export function normalizePiecewiseConditionEquivalence(source) {
  const text = String(source ?? "");
  assertAssignmentOnlyEquals(text);
  return text.replace(/\\equiv(?![A-Za-z])/g, "=");
}

export function normalizePiecewiseEquivalenceForDefinition(source) {
  const text = String(source ?? "");
  assertAssignmentOnlyEquals(text);
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const tallOpening = text.indexOf(String.raw`\left\{`, cursor);
    const shortOpening = text.indexOf(String.raw`\{`, cursor);
    const opening = tallOpening < 0
      ? shortOpening
      : shortOpening < 0 ? tallOpening : Math.min(tallOpening, shortOpening);
    if (opening < 0) return result + text.slice(cursor);
    const openingToken = text.startsWith(String.raw`\left\{`, opening)
      ? String.raw`\left\{`
      : String.raw`\{`;
    const tallBrace = openingToken === String.raw`\left\{`;
    result += text.slice(cursor, opening);

    let depth = 1;
    let end = opening + openingToken.length;
    while (end < text.length && depth > 0) {
      if (text.startsWith(String.raw`\left\{`, end)) {
        depth++;
        end += String.raw`\left\{`.length;
      } else if (text.startsWith(String.raw`\right\}`, end)) {
        depth--;
        if (depth === 0) break;
        end += String.raw`\right\}`.length;
      } else if (!tallBrace && text.startsWith(String.raw`\}`, end)) {
        depth--;
        if (depth === 0) break;
        end += String.raw`\}`.length;
      } else {
        end++;
      }
    }

    if (depth !== 0) return result + text.slice(opening);
    const body = text.slice(opening + openingToken.length, end);
    const hasBranchColon = /:(?=[^}]*(?:,|$))/.test(body);
    const normalizedBody = hasBranchColon
      ? body.replace(/\\equiv(?![A-Za-z])/g, "=")
      : body;
    const closing = tallBrace ? String.raw`\right\}` : String.raw`\}`;
    result += `${openingToken}${normalizedBody}${closing}`;
    cursor = end + closing.length;
  }

  return result;
}