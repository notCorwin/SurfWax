"use client";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "@assistant-ui/react-streamdown";
import { createCodePlugin } from "@streamdown/code";
import { math } from "@streamdown/math";
import { memo, useMemo, useRef, type ReactElement } from "react";
import { Block, Streamdown, type BlockProps } from "streamdown";
import { createMarkdownBlockParser } from "./markdown-blocks";

const CachedBlock = memo(function CachedBlock(props: BlockProps) {
  return <div className="markdown-block"><Block {...props} /></div>;
});

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
const REMEND = { katex: false };
const PLUGINS = { code: createCodePlugin({ themes: [syntaxTheme, { ...syntaxTheme, name: "surf-wax-dark", type: "dark" }] }), math };

const CompletedBlock = memo(function CompletedBlock({ text }: { text: string }) {
  return <Streamdown className="markdown-block" mode="static" plugins={PLUGINS} controls>{text}</Streamdown>;
});

export const MarkdownText = memo(function MarkdownText({ text, running = false }: { text: string; running?: boolean }) {
  const parseBlocks = useMemo(createMarkdownBlockParser, []);
  const normalized = useMemo(() => normalizeMathDelimiters(text), [text]);
  const cache = useRef(new Map<number, { text: string; element: ReactElement }>());
  const document = useMemo(() => {
    const blocks = parseBlocks(normalized);
    const closed = running ? parseBlocks.closedCount() : blocks.length;
    const next = new Map<number, { text: string; element: ReactElement }>();
    const completed: ReactElement[] = [];
    for (let index = 0; index < closed; index++) {
      const text = blocks[index]!;
      if (!text.trim()) continue;
      const previous = cache.current.get(index);
      const entry = previous?.text === text ? previous : { text, element: <CompletedBlock key={index} text={text} /> };
      next.set(index, entry); completed.push(entry.element);
    }
    cache.current = next;
    return { completed, tail: blocks.slice(closed).join("") };
  }, [normalized, running, parseBlocks]);
  // Completed blocks retain their React elements, parsed Markdown and highlight
  // state. Only the unfinished suffix goes through streaming repair/parsing.
  // Cross-block GFM references/footnotes stay in one shared block in the parser.
  return <div className="markdown-body" data-status={running ? "running" : "complete"}><div className="markdown-flow">
    {document.completed}
    {document.tail && <Streamdown className="markdown-tail" plugins={PLUGINS} remend={REMEND}
      BlockComponent={CachedBlock} isAnimating={running} controls>{document.tail}</Streamdown>}
  </div></div>;
});
