import { expect, it } from "vitest";
import { normalizeMathDelimiters } from "./math-delimiters";

it("renders bracket and custom math without changing code examples or unfinished expressions", () => {
  expect(normalizeMathDelimiters(String.raw`Inline \(x^2\) and [/inline]y[/inline].`)).toBe("Inline $x^2$ and $y$.");
  expect(normalizeMathDelimiters(String.raw`\[x=1\]`)).toBe("\n$$\nx=1\n$$\n");
  expect(normalizeMathDelimiters("[/math]a\nb[/math]")).toBe("\n$$\na\nb\n$$\n");
  const code = "```tex\n\\(x\\)\n```\n\n`\\(x\\)` and ``\\[y\\]``";
  expect(normalizeMathDelimiters(code)).toBe(code);
  expect(normalizeMathDelimiters("~~~tex\n\\(x\\)\n")).toBe("~~~tex\n\\(x\\)\n");
  expect(normalizeMathDelimiters(String.raw`partial \(x +`)).toBe(String.raw`partial \(x +`);
});
