import { describe, expect, it, vi } from "vitest";
import { createCodeHighlighter } from "./code-highlighter";
import type { highlightCode as HighlightCode } from "./highlight-code";

describe("createCodeHighlighter", () => {
  it("evicts the least recently used completed highlights", async () => {
    const highlightCode = vi.fn(async (code: string) => ({ tokens: [[{ content: code }]] })) as unknown as typeof HighlightCode;
    const highlighter = createCodeHighlighter(["light", "dark"], async () => highlightCode);
    const options = (code: string) => ({ code, language: "ts", themes: ["light", "dark"] as [string, string] });

    for (let index = 0; index < 65; index += 1) {
      highlighter.highlight(options(`prefix-${index}`), vi.fn());
    }
    await vi.waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(65));

    expect(highlighter.highlight(options("prefix-64"), vi.fn())).not.toBeNull();
    expect(highlighter.highlight(options("prefix-0"), vi.fn())).toBeNull();
    await vi.waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(66));
  });
});
