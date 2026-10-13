/** Normalize model math syntax while leaving code spans and fenced examples untouched. */
export function normalizeMathDelimiters(text: string): string {
  const protectedCode = /(^[\t >]*(?:[-*+] |\d+[.)] )?(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[\t >]*\2[\t ]*(?=\n|$)|$(?![\s\S])))|(`+)[^`]*(?:`(?!\3)[^`]*)*?\3/gm;
  const rewrite = (value: string) => value
    .replace(/\\{1,2}\[([\s\S]+?)\\{1,2}\]|\[\/math\]([\s\S]+?)\[\/math\]/g, (match, latex: string | undefined, tag: string | undefined, offset: number, source: string) => {
      const body = (latex ?? tag ?? "").trim();
      if (!body) return match;
      const line = source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);
      const quote = line.match(/^[\t ]*(?:>[\t ]*)+/)?.[0] ?? "";
      return `\n${quote}$$\n${quote}${body.split("\n").map((line) => line.replace(/^[\t ]*>[\t ]?/, "")).join(`\n${quote}`)}\n${quote}$$\n`;
    })
    .replace(/\\{1,2}\(([^\n]+?)\\{1,2}\)|\[\/inline\]([^\n]+?)\[\/inline\]/g, (match, latex: string | undefined, tag: string | undefined) => {
      const body = (latex ?? tag ?? "").trim();
      return body ? `$${body}$` : match;
    });
  let output = "", offset = 0;
  for (const match of text.matchAll(protectedCode)) {
    output += rewrite(text.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  return output + rewrite(text.slice(offset));
}
