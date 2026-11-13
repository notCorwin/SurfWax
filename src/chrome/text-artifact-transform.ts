/** Serialized into the disposable ProgramWorker; keep this function self-contained. */
export async function transformTextArtifact(mode: "extract" | "join" | "prefixed-lines", input: any, artifacts: any) {
  const path = (value: any, parts: Array<string | number>, label: string): any => {
    for (const part of parts) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part))
        throw new Error(`${label}: missing own-property path ${JSON.stringify(parts)}`);
      value = value[part];
    }
    return value;
  };
  const fileText = (value: any, label: string, textOnly: boolean): string => {
    if (!value || typeof value.filename !== "string" || typeof value.mimeType !== "string" || typeof value.base64 !== "string")
      throw new Error(`${label}: expected file {filename,mimeType,base64}`);
    if (textOnly && !/^text\//i.test(value.mimeType)) throw new Error(`${label}: expected text MIME type`);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(value.base64), char => char.charCodeAt(0)));
    } catch { throw new Error(`${label}: invalid base64 or UTF-8 file bytes`); }
  };
  const chunks: string[] = [];
  const sources: any[] = [];
  // Reuse reads within this operation only; never cache a side effect.
  const reads = new Map<string, Promise<any>>();
  const load = (source: any) => {
    const key = source.artifactId !== undefined ? `artifact:${source.artifactId}` : `evidence:${source.evidenceId}`;
    if (!reads.has(key)) reads.set(key, source.artifactId !== undefined ? artifacts.read(source.artifactId) : artifacts.evidence(source.evidenceId));
    return reads.get(key)!;
  };
  let lineCounts: { matched: number; skipped: number; inputLineCount: number } | undefined;
  if (mode === "prefixed-lines") {
    if (typeof input.prefix !== "string" || !input.prefix.length || input.prefix.includes("\n"))
      throw new Error("prefix must be a nonempty literal string without LF");
    let value;
    try { value = await load({ artifactId: input.artifactId }); }
    catch { throw new Error("source[0]: source unavailable in this conversation/run"); }
    const text = fileText(value, "source[0]", true);
    let start = 0, inputLineCount = 0;
    // LF is the only delimiter. Empty input and a trailing LF each leave an
    // empty line; CR, BOM and all other characters remain original line data.
    while (true) {
      const lf = text.indexOf("\n", start);
      const end = lf === -1 ? text.length : lf;
      inputLineCount++;
      if (end - start >= input.prefix.length && text.startsWith(input.prefix, start))
        chunks.push(text.slice(start + input.prefix.length, end));
      if (lf === -1) break;
      start = lf + 1;
    }
    lineCounts = { matched: chunks.length, skipped: inputLineCount - chunks.length, inputLineCount };
    sources.push({ artifactId: input.artifactId, count: chunks.length });
  } else {
    const inputs = mode === "join" ? input.artifactIds.map((artifactId: number) => ({ artifactId })) : input.sources;
    for (const [index, source] of inputs.entries()) {
      const label = `source[${index}] path ${JSON.stringify(source.path ?? [])}`;
      let value;
      try { value = await load(source); }
      catch { throw new Error(`${label}: source unavailable in this conversation/run`); }
      const start = chunks.length;
      if (mode === "join") chunks.push(fileText(value, label, true));
      else {
        value = path(value, source.path, label);
        if (source.decode !== "stored-value") {
          if (source.decode === "utf8-json-file") value = fileText(value, label, false);
          if (typeof value !== "string") throw new Error(`${label}: expected JSON string, received ${Array.isArray(value) ? "array" : typeof value}`);
          try { value = JSON.parse(value); }
          catch { throw new Error(`${label}: invalid JSON`); }
        }
        value = path(value, input.selectPath, `${label} selectPath`);
        if ((input.itemPath !== undefined || input.itemFilter !== undefined) && !Array.isArray(value)) throw new Error(`${label} selectPath: itemPath and itemFilter require an array`);
        const items = Array.isArray(value) ? value : [value];
        for (let i = 0; i < items.length; i++) {
          if (input.itemFilter !== undefined) {
            let candidate = items[i], found = true;
            for (const part of input.itemFilter.path) {
              if (candidate === null || typeof candidate !== "object" || !Object.hasOwn(candidate, part)) { found = false; break; }
              candidate = candidate[part];
            }
            if (!found || candidate !== input.itemFilter.equals) continue;
          }
          const itemLabel = `${label} selectPath ${JSON.stringify(input.selectPath)} item[${i}]${input.itemPath === undefined ? "" : ` itemPath ${JSON.stringify(input.itemPath)}`}`;
          const item = input.itemPath === undefined ? items[i] : path(items[i], input.itemPath, `${itemLabel} itemPath`);
          if (typeof item !== "string") throw new Error(`${itemLabel}: expected string, received ${item === null ? "null" : Array.isArray(item) ? "array" : typeof item}`);
          chunks.push(item);
        }
      }
      sources.push({ ...(source.artifactId !== undefined ? { artifactId: source.artifactId } : { evidenceId: source.evidenceId }), ...(mode === "extract" && input.itemFilter !== undefined ? { inputCount: value.length } : {}), count: chunks.length - start });
    }
  }
  const text = chunks.join(input.separator);
  const bytes = new TextEncoder().encode(text);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  const artifact = await artifacts.text(input.filename, text, "text/plain;charset=utf-8");
  const sample = (value: string) => ({ text: value.slice(0, 160), truncated: value.length > 160 });
  return { sources, totalItems: chunks.length, ...lineCounts, byteLength: bytes.byteLength, sha256, artifact, access: { artifactId: artifact.id, path: [] },
    ...(mode === "extract" && chunks.length ? { samples: { first: sample(chunks[0]!), last: sample(chunks[chunks.length - 1]!) } } : {}) };

}
