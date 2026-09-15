"use client";

import "katex/dist/katex.min.css";

import type { SmoothOptions } from "@assistant-ui/react";
import { normalizeMathDelimiters, StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { memo } from "react";

const PLUGINS = { code, math };
const SMOOTH: SmoothOptions = { minCommitMs: 16 };

const MarkdownTextImpl = () => (
  <StreamdownTextPrimitive
    containerClassName="markdown-body"
    plugins={PLUGINS}
    preprocess={normalizeMathDelimiters}
    controls
    defer
    smooth={SMOOTH}
  />
);

export const MarkdownText = memo(MarkdownTextImpl);
