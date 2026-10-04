import { expect, it } from "vitest";
import { parseMarkdownIntoBlocks } from "streamdown";
import { createMarkdownBlockParser } from "./markdown-blocks";

it("preserves complete GFM and math semantics while extending only the unfinished suffix", () => {
  for (const text of [
    '# Heading\n\nparagraph\n\n```ts\nconst x = 1;\n```\n\n$$x^2$$\n\nend',
    '- a\n\n- b\n\n  continuation\n\nnext\n\nlast',
    'a\n\nb\n\nTitle\n=====\n\n| A | B |\n| - | - |\n| 1 | 2 |',
    '[link][ref]\n\npara\n\nend\n\n[ref]: https://example.com',
    'first\n\nfootnote[^1]\n\nlast\n\n[^1]: definition',
  ]) {
    const parse = createMarkdownBlockParser();
    for (let index = 1; index <= text.length; index++) expect(parse(text.slice(0, index))).toEqual(parseMarkdownIntoBlocks(text.slice(0, index)));
    expect(parse('replacement')).toEqual(parseMarkdownIntoBlocks('replacement'));
  }
});
