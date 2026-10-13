import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

/** Keep transport failures out of the SDK's detached parsing pipe; the caller owns the error. */
export function readMessageSnapshots<T extends UIMessage>(stream: ReadableStream<UIMessageChunk>, onError: (error: unknown) => void) {
  const reader = stream.getReader();
  const input = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { reader.releaseLock(); onError(error); controller.close(); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } catch {} finally { reader.releaseLock(); } },
  });
  return readUIMessageStream<T>({ stream: input, onError });
}
