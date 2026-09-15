"use client";

import {
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { ArrowDownIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { LocalComposer } from "./local-composer";
import { MarkdownText } from "./markdown-text";
import { Reasoning } from "./reasoning";
import { ToolFallback } from "./tool-fallback";

export const Thread: FC = () => (
  <ThreadPrimitive.Root data-testid="thread-root" className="flex h-full min-h-0 flex-col bg-background">
    <ThreadPrimitive.Viewport data-testid="thread-viewport" className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth">
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col gap-4 px-1 pt-3 pb-10">
        <ThreadPrimitive.Messages>
          {({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}
        </ThreadPrimitive.Messages>
      </div>
      <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col bg-background px-1 pt-2 pb-2">
        <ThreadPrimitive.ScrollToBottom asChild>
          <Button type="button" variant="outline" size="icon-sm" className="absolute -top-10 self-center rounded-full disabled:invisible" aria-label="滚动到底部" title="滚动到底部">
            <ArrowDownIcon aria-hidden="true" />
          </Button>
        </ThreadPrimitive.ScrollToBottom>
        <LocalComposer />
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root data-role="assistant" className="assistant-message min-w-0 px-2 pb-2 text-sm leading-relaxed">
    <div className="assistant-message-content flex flex-col gap-3 wrap-break-word">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === "text") return <MarkdownText />;
          if (part.type === "reasoning") return <Reasoning {...part} />;
          if (part.type === "tool-call") return part.toolUI ?? <ToolFallback {...part} />;
          return null;
        }}
      </MessagePrimitive.Parts>
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </div>
  </MessagePrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root data-role="user" className="ml-auto max-w-[94%] text-sm leading-relaxed">
    <div className="rounded-xl border border-primary/40 bg-primary/15 px-3 py-2 wrap-break-word">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

export default Thread;
