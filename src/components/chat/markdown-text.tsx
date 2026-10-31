"use client";
import { Component, lazy, memo, Suspense, type ReactNode } from "react";

const Renderer = lazy(() => import("./markdown-text-renderer").then(({ MarkdownText }) => ({ default: MarkdownText })));

function PlainText({ text }: { text: string }) {
  return <div className="markdown-body whitespace-pre-wrap wrap-break-word">{text}</div>;
}

class MarkdownBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <><p role="alert">无法加载格式化内容，以下为原文。</p><PlainText text={this.props.text} /></>
      : this.props.children;
  }
}

/** Load the Markdown and math renderer only when there is text to display. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  if (!text.trim()) return null;
  return <MarkdownBoundary text={text}>
    <Suspense fallback={<PlainText text={text} />}><Renderer text={text} /></Suspense>
  </MarkdownBoundary>;
});
