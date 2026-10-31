// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MarkdownText } from "./markdown-text";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./markdown-text-renderer", () => {
  loaded();
  return { MarkdownText: ({ text }: { text: string }) => createElement("strong", null, text) };
});

it("loads the renderer only for nonempty text and reuses it", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(() => root.render(createElement(MarkdownText, { text: " \n" })));
    expect(loaded).not.toHaveBeenCalled();
    await act(async () => {
      root.render(createElement(MarkdownText, { text: "First reply" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("strong")?.textContent).toBe("First reply");
    expect(loaded).toHaveBeenCalledTimes(1);
    await act(() => root.render(createElement(MarkdownText, { text: "Second reply" })));
    expect(container.querySelector("strong")?.textContent).toBe("Second reply");
    expect(loaded).toHaveBeenCalledTimes(1);
  } finally { await act(() => root.unmount()); }
});
