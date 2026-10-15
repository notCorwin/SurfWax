import { lazy, Suspense } from "react";

const MarkdownText = lazy(() => import("./markdown-text").then((module) => ({ default: module.MarkdownText })));

export function LazyMarkdownText({ text, running = false }: { text: string; running?: boolean }) {
  return <Suspense fallback={<p className="whitespace-pre-wrap wrap-break-word">{text}</p>}>
    <MarkdownText text={text} running={running} />
  </Suspense>;
}
