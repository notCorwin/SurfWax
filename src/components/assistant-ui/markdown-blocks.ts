import { parseMarkdownIntoBlocks } from "streamdown";

/** Cache the closed prefix while allowing the unfinished block to keep growing. */
export function createMarkdownBlockParser() {
  let prefix = "";
  let closed: string[] = [];
  const parse = (markdown: string): string[] => {
    // A later GFM reference/footnote definition can change an earlier block.
    // Use the complete document in that case, and whenever the prefix changes.
    if (!markdown.startsWith(prefix) || /^ {0,3}\[[^\]]+\]:/m.test(markdown)) { prefix = ""; closed = []; }
    const tail = parseMarkdownIntoBlocks(markdown.slice(prefix.length));
    const result = [...closed, ...tail];
    // Keep the last two semantic blocks (plus whitespace) open, covering lists,
    // setext headings and table headers that acquire meaning from later lines.
    let keep = tail.length, semantic = 0;
    while (keep > 0 && semantic < 2) { keep--; if (tail[keep]!.trim()) semantic++; }
    const stable = tail.slice(0, keep);
    if (stable.length) { prefix += stable.join(""); closed.push(...stable); }
    return result;
  };
  return Object.assign(parse, { closedCount: () => closed.length });
}
