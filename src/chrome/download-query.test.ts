import { describe, expect, it, vi } from "vitest";
import { listDownloads } from "./download-query";

function item(id: number, state: "complete" | "in_progress" | "interrupted" = "complete") {
  return { id, state, filename: `/downloads/${id}.txt`, url: `https://example.test/${id}`, finalUrl: `https://cdn.example.test/${id}`,
    startTime: "2026-10-29T00:00:00.000Z", exists: true, mime: "text/plain", extraChromeField: "preserved" } as unknown as chrome.downloads.DownloadItem;
}
function eventSource() {
  const listeners = new Set<() => void>();
  return { addListener: (listener: () => void) => listeners.add(listener), removeListener: (listener: () => void) => listeners.delete(listener),
    emit: () => { for (const listener of listeners) listener(); }, count: () => listeners.size };
}

describe("listDownloads", () => {
  it("reads a bounded, live profile listing and retains Chrome metadata", async () => {
    const downloads = [item(3), item(2), item(1)];
    const search = vi.fn(async () => downloads);
    const onCreated = eventSource(); const onChanged = eventSource(); const onErased = eventSource();
    const api = { downloads: { search, onCreated, onChanged, onErased } } as unknown as Pick<typeof chrome, "downloads">;
    const result = await listDownloads(api, { state: "complete", limit: 2 });
    expect(search).toHaveBeenCalledWith({ state: "complete", orderBy: ["-startTime"], limit: 3 });
    expect(result).toEqual({ downloads: downloads.slice(0, 2), hasMore: true, scope: "chrome-profile", consistency: "live", existence: "may-be-stale" });
    expect(result.downloads[0]).toMatchObject({ filename: "/downloads/3.txt", finalUrl: "https://cdn.example.test/3", extraChromeField: "preserved" });
  });

  it("supports an explicit all-records request and reports when a finite listing is complete", async () => {
    const downloads = [item(2), item(1)];
    const search = vi.fn(async () => downloads);
    const api = { downloads: { search } } as unknown as Pick<typeof chrome, "downloads">;
    expect(await listDownloads(api, { limit: 0 })).toMatchObject({ downloads, hasMore: false });
    expect(search).toHaveBeenLastCalledWith({ orderBy: ["-startTime"], limit: 0 });
    expect(await listDownloads(api)).toMatchObject({ downloads, hasMore: false });
    expect(search).toHaveBeenLastCalledWith({ orderBy: ["-startTime"], limit: 101 });
    await listDownloads(api, { limit: 2_147_483_647 });
    expect(search).toHaveBeenLastCalledWith({ orderBy: ["-startTime"], limit: 0 });
  });

  it("uses Chrome's exact-ID query and applies a requested state without a second request", async () => {
    const download = item(7, "interrupted");
    const search = vi.fn(async () => [download]);
    const api = { downloads: { search } } as unknown as Pick<typeof chrome, "downloads">;
    expect(await listDownloads(api, { downloadId: 7, state: "interrupted" })).toMatchObject({ downloads: [download], hasMore: false });
    expect(search).toHaveBeenLastCalledWith({ id: 7 });
    expect(await listDownloads(api, { downloadId: 7, state: "complete" })).toMatchObject({ downloads: [], hasMore: false });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("validates inputs before calling Chrome and propagates browser errors", async () => {
    const search = vi.fn(async () => { throw new Error("Chrome refused the query"); });
    const api = { downloads: { search } } as unknown as Pick<typeof chrome, "downloads">;
    for (const input of [{ limit: -1 }, { limit: 2_147_483_648 }, { downloadId: -1 }, { state: "invalid" }]) {
      await expect(listDownloads(api, input as never)).rejects.toThrow();
    }
    expect(search).not.toHaveBeenCalled();
    await expect(listDownloads(api)).rejects.toThrow("Chrome refused the query");
    expect(search).toHaveBeenCalledOnce();
  });

  it("cancels promptly without interpreting a late browser response as a result", async () => {
    const controller = new AbortController();
    let finish!: (items: chrome.downloads.DownloadItem[]) => void;
    const search = vi.fn(() => new Promise<chrome.downloads.DownloadItem[]>((resolve) => { finish = resolve; }));
    const api = { downloads: { search } } as unknown as Pick<typeof chrome, "downloads">;
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = listDownloads(api, {}, controller.signal);
    controller.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    finish([item(1)]);
    const cancelled = new AbortController();
    cancelled.abort(new Error("caller stopped"));
    await expect(listDownloads(api, {}, cancelled.signal)).rejects.toMatchObject({ name: "AbortError", message: "caller stopped" });
    const timedOut = new AbortController();
    timedOut.abort(new DOMException("deadline", "TimeoutError"));
    await expect(listDownloads(api, {}, timedOut.signal)).rejects.toMatchObject({ name: "TimeoutError", message: "deadline" });
    expect(search).toHaveBeenCalledOnce();
  });

  it("shares an identical in-flight query without coupling caller cancellation or caching the result", async () => {
    let finish!: (items: chrome.downloads.DownloadItem[]) => void;
    const search = vi.fn(() => new Promise<chrome.downloads.DownloadItem[]>((resolve) => { finish = resolve; }));
    const onCreated = eventSource(); const onChanged = eventSource(); const onErased = eventSource();
    const api = { downloads: { search, onCreated, onChanged, onErased } } as unknown as Pick<typeof chrome, "downloads">;
    const firstSignal = new AbortController();
    const first = listDownloads(api, { state: "complete" }, firstSignal.signal);
    const second = listDownloads(api, { state: "complete" });
    expect(search).toHaveBeenCalledOnce();
    firstSignal.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    finish([item(1)]);
    await expect(second).resolves.toMatchObject({ downloads: [item(1)], hasMore: false });
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([0, 0, 0]);
    const third = listDownloads(api, { state: "complete" });
    expect(search).toHaveBeenCalledTimes(2);
    finish([item(2)]);
    await expect(third).resolves.toMatchObject({ downloads: [item(2)] });
  });

  it("invalidates shared work on changes and never coalesces active-download metadata", async () => {
    const pending: Array<(items: chrome.downloads.DownloadItem[]) => void> = [];
    const search = vi.fn(() => new Promise<chrome.downloads.DownloadItem[]>((resolve) => { pending.push(resolve); }));
    const onCreated = eventSource(); const onChanged = eventSource(); const onErased = eventSource();
    const api = { downloads: { search, onCreated, onChanged, onErased } } as unknown as Pick<typeof chrome, "downloads">;
    const first = listDownloads(api, { state: "complete" });
    onChanged.emit();
    const second = listDownloads(api, { state: "complete" });
    expect(search).toHaveBeenCalledTimes(2);
    pending[0]!([item(1)]); pending[1]!([item(2)]);
    expect((await first).downloads[0]!.id).toBe(1);
    expect((await second).downloads[0]!.id).toBe(2);
    const activeOne = listDownloads(api, { state: "in_progress" });
    const activeTwo = listDownloads(api, { state: "in_progress" });
    expect(search).toHaveBeenCalledTimes(4);
    pending[2]!([item(3, "in_progress")]); pending[3]!([item(4, "in_progress")]);
    await Promise.all([activeOne, activeTwo]);
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([0, 0, 0]);
  });

  it("releases the shared request when its last waiter cancels, without letting late completion disturb a new request", async () => {
    const pending: Array<{ resolve: (items: chrome.downloads.DownloadItem[]) => void; reject: (error: Error) => void }> = [];
    const search = vi.fn(() => new Promise<chrome.downloads.DownloadItem[]>((resolve, reject) => { pending.push({ resolve, reject }); }));
    const onCreated = eventSource(); const onChanged = eventSource(); const onErased = eventSource();
    const api = { downloads: { search, onCreated, onChanged, onErased } } as unknown as Pick<typeof chrome, "downloads">;
    const one = new AbortController(); const two = new AbortController();
    const first = listDownloads(api, { state: "complete" }, one.signal);
    const second = listDownloads(api, { state: "complete" }, two.signal);
    expect(search).toHaveBeenCalledOnce();
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([1, 1, 1]);
    one.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([1, 1, 1]);
    two.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([0, 0, 0]);

    const third = listDownloads(api, { state: "complete" });
    expect(search).toHaveBeenCalledTimes(2);
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([1, 1, 1]);
    // This old rejection arrives after its cache entry was removed. It must be
    // consumed and must not remove the newer request or its listeners.
    pending[0]!.reject(new Error("late failure"));
    await Promise.resolve();
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([1, 1, 1]);
    const fourth = listDownloads(api, { state: "complete" });
    expect(search).toHaveBeenCalledTimes(2);
    pending[1]!.resolve([item(9)]);
    await expect(Promise.all([third, fourth])).resolves.toMatchObject([{ downloads: [item(9)] }, { downloads: [item(9)] }]);
    expect([onCreated.count(), onChanged.count(), onErased.count()]).toEqual([0, 0, 0]);
  });
});
