import { describe, expect, it, vi } from "vitest";
import { createCodeHighlighter } from "./code-highlighter";
import { highlightCode } from "./highlight-code";

vi.mock("./highlight-code", () => ({
  highlightCode: vi.fn(async (code: string) => ({ tokens: [[{ content: code }]] })),
}));

describe("createCodeHighlighter", () => {
  it("evicts the least recently used completed highlights", async () => {
    const highlighter = createCodeHighlighter(["light", "dark"]);

    for (let index = 0; index < 65; index += 1) {
      highlighter.highlight({ code: `prefix-${index}`, language: "ts" }, vi.fn());
    }
    await vi.waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(65));

    expect(highlighter.highlight({ code: "prefix-64", language: "ts" }, vi.fn())).not.toBeNull();
    expect(highlighter.highlight({ code: "prefix-0", language: "ts" }, vi.fn())).toBeNull();
    await vi.waitFor(() => expect(highlightCode).toHaveBeenCalledTimes(66));
  });
});
