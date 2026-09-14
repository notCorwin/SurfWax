"use client";

import "@assistant-ui/react-markdown/styles/dot.css";
import "katex/dist/katex.min.css";

import { CheckIcon, CopyIcon } from "lucide-react";
import type { SmoothOptions } from "@assistant-ui/react";
import { MarkdownTextPrimitive, normalizeMathDelimiters, unstable_memoizeMarkdownComponents, type CodeHeaderProps, type SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
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
import { memo, useEffect, useState, type FC } from "react";

export const CodeBlockHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="markdown-code-header">
      <span className="markdown-code-language">{language || "code"}</span>
      <button
        type="button"
        className="markdown-code-copy"
        data-testid="copy-code-button"
        aria-label={copied ? "已复制代码" : "复制代码"}
        title={copied ? "已复制代码" : "复制代码"}
        onClick={() => void copyCode()}
      >
        {copied ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
};

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath];
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex];
const MarkdownSyntaxHighlighter = ({ components: { Pre, Code }, language, code }: SyntaxHighlighterProps) => (
  <PrismLight PreTag={Pre} CodeTag={Code} style={coldarkDark} language={language}>
    {code}
  </PrismLight>
);
PrismLight.registerLanguage("javascript", javascript);
PrismLight.registerLanguage("json", json);
PrismLight.registerLanguage("markdown", markdown);
PrismLight.registerLanguage("python", python);
PrismLight.registerLanguage("typescript", typescript);
const MARKDOWN_COMPONENTS = unstable_memoizeMarkdownComponents({
  CodeHeader: CodeBlockHeader,
  SyntaxHighlighter: MarkdownSyntaxHighlighter,
});
const MARKDOWN_SMOOTH_OPTIONS: SmoothOptions = { minCommitMs: 16 };

const MarkdownTextImpl = () => (
  <MarkdownTextPrimitive
    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
    className="aui-md markdown-body"
    components={MARKDOWN_COMPONENTS}
    preprocess={normalizeMathDelimiters}
    defer
    smooth={MARKDOWN_SMOOTH_OPTIONS}
  />
);

export const MarkdownText = memo(MarkdownTextImpl);
