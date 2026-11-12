import { createHash } from "node:crypto";

export type FrozenSource = { url: string; finalUrl: string; status: number; fetchedAt: string; sha256: string; body: string };

/** Read each source once per preflight; failures are not cached across preflights. */
export function sourceReader() {
  const reads = new Map<string, Promise<FrozenSource>>();
  return (url: string): Promise<FrozenSource> => {
    const existing = reads.get(url);
    if (existing) return existing;
    const read = (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Source unavailable: ${url} (HTTP ${response.status})`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) throw new Error(`Source exceeds size limit: ${url}`);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(chunks);
      return { url, finalUrl: response.url, status: response.status, fetchedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(bytes).digest("hex"), body: bytes.toString("utf8") };
    })();
    reads.set(url, read);
    return read;
  };
}

export function canonicalUrl(url: string): string {
  try { const value = new URL(url); if (value.hostname === "developer.chrome.com") value.searchParams.delete("hl"); return `${value.origin}${value.pathname.replace(/\/$/, "")}${value.search}`; }
  catch { return ""; }
}
