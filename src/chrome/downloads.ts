type DownloadArtifact = { id: number; filename: string; mimeType: string };

/** downloads is required at installation; cancellation never rolls back a dispatched download. */
export async function downloadArtifact(chromeApi: Pick<typeof chrome, "downloads">, artifact: DownloadArtifact, base64: string, signal?: AbortSignal): Promise<number> {
  let abort: (() => void) | undefined;
  let dispatched = false;
  try {
    signal?.throwIfAborted();
    dispatched = true;
    const pending = chromeApi.downloads.download({ url: `data:${artifact.mimeType};base64,${base64}`, filename: artifact.filename, saveAs: false });
    const interrupted = signal && new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason instanceof Error || signal.reason instanceof DOMException ? signal.reason : new DOMException(String(signal.reason ?? "Operation aborted"), "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return await (interrupted ? Promise.race([pending, interrupted]) : pending);
  } catch (error) {
    throw Object.assign(error instanceof Error || error instanceof DOMException ? error : new Error(String(error)), { artifact, ...(dispatched && signal?.aborted ? { effectUnknown: true } : {}) });
  } finally {
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}
