// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MarkdownText } from "./markdown-text";

vi.mock("./markdown-text-renderer", () => { throw new Error("renderer unavailable"); });

it("preserves readable message text when the renderer cannot load", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(MarkdownText, { text: "第一行\n**第二行**" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法加载格式化内容");
    expect(container.querySelector(".markdown-body")?.textContent).toBe("第一行\n**第二行**");
    await act(() => root.render(createElement(MarkdownText, { text: "后续文本" })));
    expect(container.querySelector(".markdown-body")?.textContent).toBe("后续文本");
  } finally {
    await act(() => root.unmount());
    errors.mockRestore();
  }
});
