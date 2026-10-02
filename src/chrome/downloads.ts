type DownloadArtifact = { id: number; filename: string; mimeType: string };

/** downloads is required at installation; saving never requests runtime permission. */
export async function downloadArtifact(chromeApi: Pick<typeof chrome, "downloads">, artifact: DownloadArtifact, base64: string, signal?: AbortSignal): Promise<number> {
  try {
    signal?.throwIfAborted();
    return await chromeApi.downloads.download({
      url: `data:${artifact.mimeType};base64,${base64}`,
      filename: artifact.filename,
      saveAs: false,
    });
  } catch (error) {
    throw Object.assign(error instanceof Error || error instanceof DOMException ? error : new Error(String(error)), { artifact });
  }
}
