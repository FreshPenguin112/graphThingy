export function prepareMathQuillLatex(source) {
  const aliases = [];
  const latex = String(source ?? "").replace(
    /\\(mathbb|mathrm)\s*\{\s*([A-Za-z])\s*\}/g,
    (original, command, symbol) => {
      const display = `\\mathrm{${symbol}}`;
      aliases.push({ display, original });
      return command === "mathbb" ? display : original;
    },
  );

  return {
    latex,
    recordInsertion(before, after, insertedSource) {
      let prefixLength = 0;
      while (prefixLength < before.length && prefixLength < after.length
        && before[prefixLength] === after[prefixLength]) prefixLength++;
      let suffixLength = 0;
      while (suffixLength < before.length - prefixLength && suffixLength < after.length - prefixLength
        && before[before.length - suffixLength - 1] === after[after.length - suffixLength - 1]) suffixLength++;

      const countAliases = (value) => (value.match(/\\mathrm\s*\{\s*[A-Za-z]\s*\}/g) || []).length;
      const removedStart = countAliases(before.slice(0, prefixLength));
      const removedEnd = countAliases(before.slice(0, before.length - suffixLength));
      const insertedAliases = [];
      String(insertedSource ?? "").replace(/\\(mathbb|mathrm)\s*\{\s*([A-Za-z])\s*\}/g,
        (original, command, symbol) => {
          insertedAliases.push({ display: `\\mathrm{${symbol}}`, original });
          return command === "mathbb" ? `\\mathrm{${symbol}}` : original;
        });
      aliases.splice(removedStart, removedEnd - removedStart, ...insertedAliases);
    },
    restore(value) {
      let nextAlias = 0;
      return String(value ?? "").replace(/\\mathrm\s*\{\s*([A-Za-z])\s*\}/g, (display) => {
        const normalizedDisplay = display.replace(/\s+/g, "");
        while (nextAlias < aliases.length && aliases[nextAlias].display !== normalizedDisplay) {
          nextAlias++;
        }
        const alias = aliases[nextAlias++];
        return alias?.original ?? display;
      });
    },
  };
}
