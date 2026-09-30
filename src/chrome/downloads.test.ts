import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeDownload, cancelDownload, downloadRequests, ensureDownloadPermission } from "./downloads";
afterEach(() => { for (const request of downloadRequests()) cancelDownload(request.id); vi.unstubAllGlobals(); });
function permissions(granted = false) {
  const api = { contains: vi.fn(async () => granted), request: vi.fn(async () => { granted = true; return true; }) };
  vi.stubGlobal("chrome", { permissions: api });
  return api;
}
async function pending() { await Promise.resolve(); await Promise.resolve(); return downloadRequests()[0]!; }
describe("optional downloads", () => {
  it("only suspends the operation deadline when a live request needs human authorization", async () => {
    const onWaiting = vi.fn();
    permissions(true);
    await ensureDownloadPermission(undefined, undefined, onWaiting);
    expect(onWaiting).not.toHaveBeenCalled();
    permissions();
    const controller = new AbortController();
    controller.abort("sidepanel-closed");
    await expect(ensureDownloadPermission(controller.signal, undefined, onWaiting)).rejects.toBe("sidepanel-closed");
    expect(onWaiting).not.toHaveBeenCalled();
    const request = ensureDownloadPermission(undefined, undefined, onWaiting);
    const rejection = expect(request).rejects.toMatchObject({ code: "download-cancelled" });
    await pending();
    expect(onWaiting).toHaveBeenCalledTimes(1);
    cancelDownload(downloadRequests()[0]!.id);
    await rejection;
    expect(downloadRequests()).toEqual([]);
  });
  it("waits for a real grant and saves the existing artifact", async () => {
    const api = permissions();
    const promise = ensureDownloadPermission(undefined, { id: 7, filename: "page.pdf" });
    const request = await pending();
    expect(request.artifact).toEqual({ id: 7, filename: "page.pdf" });
    expect(api.request).not.toHaveBeenCalled();
    await authorizeDownload(request.id);
    await promise;
    await ensureDownloadPermission();
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  it("reports denial and allows a fresh request after revocation", async () => {
    const api = permissions(); api.request.mockResolvedValueOnce(false);
    const denied = ensureDownloadPermission();
    const rejection = expect(denied).rejects.toThrow("产物仍保留");
    await authorizeDownload((await pending()).id); await rejection;
    const retry = ensureDownloadPermission();
    await authorizeDownload((await pending()).id); await retry;
  });
  it("removes the prompt when its owner is aborted", async () => {
    permissions(); const controller = new AbortController();
    const promise = ensureDownloadPermission(controller.signal);
    const rejection = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await pending(); controller.abort(); await rejection;
    expect(downloadRequests()).toEqual([]);
  });
});
