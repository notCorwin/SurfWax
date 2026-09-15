"use client";

import "@assistant-ui/react-markdown/styles/dot.css";
import "katex/dist/katex.min.css";

import type { SmoothOptions } from "@assistant-ui/react";
import { MarkdownTextPrimitive, normalizeMathDelimiters, unstable_memoizeMarkdownComponents, type SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import { coldarkDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { memo } from "react";

for (const language of ["javascript", "js", "jsx"]) PrismLight.registerLanguage(language, javascript);
for (const language of ["typescript", "ts", "tsx"]) PrismLight.registerLanguage(language, typescript);
PrismLight.registerLanguage("json", json);
PrismLight.registerLanguage("markdown", markdown);
PrismLight.registerLanguage("md", markdown);
PrismLight.registerLanguage("python", python);
PrismLight.registerLanguage("py", python);

const SyntaxHighlighter = ({ components: { Pre, Code }, language, code }: SyntaxHighlighterProps) => (
  <PrismLight PreTag={Pre} CodeTag={Code} style={coldarkDark} language={language}>{code}</PrismLight>
);
const COMPONENTS = unstable_memoizeMarkdownComponents({ SyntaxHighlighter });
const SMOOTH: SmoothOptions = { minCommitMs: 16 };

const MarkdownTextImpl = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    className="aui-md markdown-body"
    components={COMPONENTS}
    preprocess={normalizeMathDelimiters}
    defer
    smooth={SMOOTH}
  />
);

export const MarkdownText = memo(MarkdownTextImpl);
