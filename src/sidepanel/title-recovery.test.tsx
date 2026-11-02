import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { EventLogger, LogEvent } from "../logging";
import type { ModelConfig } from "../types";
import { RecoverConversationTitles } from "./App";

it("records the conversation and original error when title recovery cannot read its summary", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let listener!: (event: LogEvent) => void;
  const error = new Error("summary store failed");
  const telemetry = vi.fn();
  const logger = { summaryEvents: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(error), telemetry,
    subscribe: (callback: (event: LogEvent) => void) => { listener = callback; return () => undefined; } } as unknown as EventLogger;
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<RecoverConversationTitles logger={logger} config={{ model: "model" } as ModelConfig} />));
  await act(async () => listener({ type: "conversation.finished", conversationId: "conversation" } as LogEvent));
  expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ type: "model.title.recovery-failed", conversationId: "conversation", error: expect.objectContaining({ message: error.message }) }));
  await act(async () => root.unmount());
});
