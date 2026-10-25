"use client";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "./math-delimiters";
import { math } from "@streamdown/math";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { createCodeHighlighter } from "./code-highlighter";

// Shiki emits token references; actual colors are owned by styles.css.
const syntaxTheme = {
  name: "surf-wax", type: "light" as const,
  colors: { "editor.background": "var(--code-background)", "editor.foreground": "var(--foreground)" },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--syntax-comment)" } },
    { scope: ["keyword", "storage", "entity.name.tag"], settings: { foreground: "var(--syntax-keyword)" } },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "var(--syntax-string)" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "var(--syntax-number)" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "var(--syntax-function)" } },
    { scope: ["entity.name.type", "support.type"], settings: { foreground: "var(--syntax-type)" } },
  ],
};
const PLUGINS = { code: createCodeHighlighter([syntaxTheme, { ...syntaxTheme, name: "surf-wax-dark", type: "dark" }]), math };

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  const normalized = normalizeMathDelimiters(text);
  if (!normalized.trim()) return null;
  return <Streamdown className="markdown-body" mode="static" plugins={PLUGINS} controls>{normalized}</Streamdown>;
});
