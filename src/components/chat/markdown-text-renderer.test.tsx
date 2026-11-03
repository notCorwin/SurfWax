import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MarkdownText } from "./markdown-text-renderer";

it("renders GFM links, tables, task lists and formulas without replacing navigation or hiding rows", () => {
  const rows = Array.from({ length: 50 }, (_, index) => `| Row ${index} | Value ${index} |`).join("\n");
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: [
    "[Example](https://example.com) and https://example.org.",
    "| Label | Value |\n| --- | --- |\n" + rows,
    "- [x] checked\n\n~~removed~~ and `code`.",
    "Inline $x^2$ and\n\n$$\ny=x+1\n$$",
  ].join("\n\n") }));
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.querySelector('a[href="https://example.com/"]')?.textContent).toBe("Example");
  expect(container.querySelector('a[href="https://example.org/"]')).not.toBeNull();
  expect(container.querySelector('button[data-streamdown="link"]')).toBeNull();
  expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
  expect(container.querySelector('[data-streamdown="table-wrapper"] button')).toBeNull();
  expect(container.querySelectorAll("[style*='max-height']")).toHaveLength(0);
  expect(container.querySelector('input[type="checkbox"]')).toHaveProperty("checked", true);
  expect(container.querySelector("del")?.textContent).toBe("removed");
  expect(container.querySelectorAll(".katex")).toHaveLength(2);
});
