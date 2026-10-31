import { createArrayView, decodeLogGraph, visitLogGraph } from "./log-graph";

/** Each part is an event; the lookup table in IndexedDB is only a derived index. */
export type ArtifactPart = { node: number; section: string; part: number; value: any };
export type ArtifactGraph = { version: 1; key: string; root: any };
export type ArtifactSelection = { path?: string | Array<string | number>; offset?: number; limit?: number };
type Reader = (node: number, section?: string, first?: number, last?: number) => Promise<ArtifactPart[]>;
type BucketReader = (node: number, prefix: "i:" | "e:", first: number, last: number) => Promise<ArtifactPart[]>;
const TEXT = 8192;
const ENTRIES = 128;
const isText = (value: any): value is { s: number; l: number } => value !== null && typeof value === "object" && !Array.isArray(value) && Number.isSafeInteger(value.s) && Number.isSafeInteger(value.l) && Object.keys(value).length === 2;
const indexKey = (key: string) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffff_ffff && String(Number(key)) === key ? Number(key) : undefined;
function hash(key: string): number { let value = 2166136261; for (let i = 0; i < key.length; i++) value = Math.imul(value ^ key.charCodeAt(i), 16777619); return (value >>> 0) % 256; }

/** Snapshot directly into the indexed V5 representation, without first building a second complete graph. */
export function partitionArtifact(value: unknown): { graph: ArtifactGraph; parts: ArtifactPart[] } {
  const parts: ArtifactPart[] = [];
  let textId = 0;
  const pack = (item: any): any => {
    if (typeof item === "string" && item.length > 512) {
      const id = textId++;
      for (let offset = 0; offset < item.length; offset += TEXT) parts.push({ node: -id - 1, section: "text", part: offset / TEXT, value: item.slice(offset, offset + TEXT) });
      return { s: id, l: item.length };
    }
    if (Array.isArray(item)) return item.map(pack);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, pack(child)]));
    return item;
  };
  // Base64 boundaries must be divisible by three bytes so concatenating the
  // individually encoded pieces exactly matches a whole-buffer encoding.
  const packBuffer = (bytes: Uint8Array): string | { s: number; l: number } => {
    const length = Math.ceil(bytes.length / 3) * 4;
    const encode = (start: number, end: number) => btoa(String.fromCharCode(...bytes.subarray(start, end)));
    if (length <= 512) return encode(0, bytes.length);
    const id = textId++;
    for (let offset = 0; offset < bytes.length; offset += 6144)
      parts.push({ node: -id - 1, section: "text", part: offset / 6144, value: encode(offset, offset + 6144) });
    return { s: id, l: length };
  };
  let root: any;
  const headers: any[][] = [];
  visitLogGraph(value, {
    root: (token) => { root = pack(token); },
    buffer: packBuffer,
    node: (node, metadata, entries, properties) => {
    const groups = new Map<string, { part: number; entries: any[] }>();
    const put = (section: string, ordinal: number, entry: any) => {
      let group = groups.get(section);
      if (!group) groups.set(section, group = { part: 0, entries: [] });
      group.entries.push([ordinal, pack(entry)]);
      if (group.entries.length === ENTRIES) {
        parts.push({ node, section, part: group.part++, value: group.entries });
        group.entries = [];
      }
    };
    let ordinal = 0;
    if (entries) for (const entry of entries) {
      if (metadata.type === "array" || metadata.type === "object") {
        const position = metadata.type === "array" ? indexKey(entry[0]) : undefined;
        put(position === undefined ? `k:${hash(entry[0])}` : `i:${Math.floor(position / ENTRIES)}`, ordinal, entry);
      } else put(`e:${Math.floor(ordinal / ENTRIES)}`, ordinal, entry);
      ordinal++;
    }
    if (metadata.type === "map" || metadata.type === "set") metadata.size = ordinal;
    ordinal = 0;
    if (properties) for (const entry of properties) put(`p:${hash(entry[0])}`, ordinal++, entry);
    (headers[Math.floor(node / 64)] ??= []).push(pack(metadata));
    for (const [section, group] of groups) if (group.entries.length) parts.push({ node, section, part: group.part, value: group.entries });
    },
  });
  headers.forEach((header, part) => parts.push({ node: part, section: "headers", part: 0, value: header }));
  return { graph: { version: 1, key: crypto.randomUUID(), root }, parts };
}

/** Read only selected sections; reconstruct the reachable V5 graph when values contain aliases or cycles. */
export async function readPartitionedArtifact(graph: ArtifactGraph, read: Reader, selection: ArtifactSelection, id: number, readBuckets: BucketReader): Promise<unknown> {
  let synthetic: any;
  const requests = new Map<string, Promise<ArtifactPart[]>>();
  const parts = (node: number, section?: string, first?: number, last?: number) => {
    const key = JSON.stringify([node, section ?? null, first ?? null, last ?? null]);
    let request = requests.get(key);
    if (!request) { request = read(node, section, first, last); requests.set(key, request); }
    return request;
  };
  const textSlice = async (value: { s: number; l: number }, from = 0, end = value.l): Promise<string> => {
    from = Math.min(value.l, Math.max(0, from)); end = Math.min(value.l, Math.max(from, end));
    if (from === end) return "";
    const first = Math.floor(from / TEXT), last = Math.floor((end - 1) / TEXT);
    const rows = await parts(-value.s - 1, "text", first, last);
    rows.sort((a, b) => a.part - b.part);
    if (rows.length !== last - first + 1 || rows.some((row, index) => row.part !== first + index || typeof row.value !== "string")) throw new Error("Invalid artifact text parts");
    return rows.map((row) => row.value).join("").slice(from - first * TEXT, end - first * TEXT);
  };
  const unpack = async (item: any): Promise<any> => {
    if (isText(item)) return textSlice(item);
    if (Array.isArray(item)) return Promise.all(item.map(unpack));
    if (item && typeof item === "object") return Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, child]) => [key, await unpack(child)])));
    return item;
  };
  const header = async (node: number): Promise<any> => {
    if (node === -1 && synthetic) return synthetic;
    const rows = await parts(Math.floor(node / 64), "headers", 0, 0);
    const value = rows[0]?.value?.[node % 64];
    if (rows.length !== 1 || !value) throw new Error("Invalid artifact node header");
    return value;
  };
  const entries = async (node: number, section?: string): Promise<any[]> => {
    if (node === -1 && synthetic) return synthetic.entries.map((entry: any, ordinal: number) => [`i:${Math.floor(Number(entry[0]) / ENTRIES)}`, ordinal, entry]).filter((row: any[]) => section === undefined || row[0] === section);
    const rows = await parts(node, section);
    return rows.filter((row) => row.section !== "headers" && row.section !== "text")
      .flatMap((row) => row.value.map((entry: any) => [row.section, ...entry]));
  };
  const property = async (node: number, nodeHeader: any, key: string): Promise<any | undefined> => {
    const position = nodeHeader.type === "array" ? indexKey(key) : undefined;
    const section = nodeHeader.type === "object" || nodeHeader.type === "array"
      ? position === undefined ? `k:${hash(key)}` : `i:${Math.floor(position / ENTRIES)}` : `p:${hash(key)}`;
    for (const [, , entry] of await entries(node, section)) if (await unpack(entry[0]) === key) return entry[1];
    return undefined;
  };
  const readBytes = async (info: any, first: number, last: number): Promise<ArrayBuffer | ArrayBufferView> => {
    const buffer = info.type === "buffer" ? info : await header(info.buffer[1]);
    const width = info.type === "view" && info.name !== "DataView" ? (globalThis as any)[info.name].BYTES_PER_ELEMENT : 1;
    const startByte = (info.type === "view" ? info.offset : 0) + first * width, endByte = startByte + (last - first) * width;
    const base64 = buffer.base64;
    const startChar = Math.floor(startByte / 3) * 4, endChar = Math.ceil(endByte / 3) * 4;
    const raw = typeof base64 === "string" ? base64.slice(startChar, endChar) : await textSlice(base64, startChar, endChar);
    const decoded = atob(raw); const skip = startByte - Math.floor(startByte / 3) * 3;
    const bytes = Uint8Array.from(decoded.slice(skip, skip + endByte - startByte), (character) => character.charCodeAt(0));
    return info.type === "buffer" ? bytes.buffer : createArrayView(info.name, bytes.buffer, 0, last - first);
  };
  const materialize = async (root: any, localSynthetic = synthetic): Promise<unknown> => {
    const nodes = new Map<number, any>();
    if (localSynthetic && root?.[0] === 1 && root?.[1] === -1) nodes.set(-1, localSynthetic);
    const pending: number[] = [];
    const inspect = (item: any): void => {
      if (Array.isArray(item)) {
        if (item.length === 2 && item[0] === 1 && Number.isSafeInteger(item[1])) { if (!nodes.has(item[1])) { nodes.set(item[1], null); pending.push(item[1]); } }
        else for (const child of item) inspect(child);
      } else if (item && typeof item === "object" && !isText(item)) for (const child of Object.values(item)) inspect(child);
    };
    inspect(root); if (nodes.has(-1)) inspect(localSynthetic);
    for (let next = 0; next < pending.length; next++) {
      const node = pending[next]!;
      const metadata = await header(node);
      const rows = await entries(node);
      const main = rows.filter(([section]) => section.startsWith("i:") || section.startsWith("k:") || section.startsWith("e:"));
      const props = rows.filter(([section]) => section.startsWith("p:"));
      main.sort((a, b) => a[1] - b[1]); props.sort((a, b) => a[1] - b[1]);
      const complete = { ...metadata, ...(["object", "array", "map", "set"].includes(metadata.type) ? { entries: main.map((entry) => entry[2]) } : {}),
        ...(!["object", "array"].includes(metadata.type) ? { properties: props.map((entry) => entry[2]) } : {}) };
      nodes.set(node, complete); inspect(complete);
    }
    const ids = [...nodes.keys()]; const remap = new Map(ids.map((key, index) => [key, index]));
    const convert = async (item: any): Promise<any> => {
      if (isText(item)) return textSlice(item);
      if (Array.isArray(item)) {
        if (item.length === 2 && item[0] === 1 && Number.isSafeInteger(item[1])) {
          const index = remap.get(item[1]); if (index === undefined) throw new Error("Invalid artifact graph reference"); return [1, index];
        }
        return Promise.all(item.map(convert));
      }
      if (item && typeof item === "object") return Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, child]) => [key, await convert(child)])));
      return item;
    };
    return decodeLogGraph({ $type: "object-graph", root: await convert(root), nodes: await Promise.all(ids.map((key) => convert(nodes.get(key)))) });
  };
  const path = typeof selection.path === "string" ? [selection.path] : selection.path ?? [];
  if (!Array.isArray(path) || path.some((part) => typeof part !== "string" && (!Number.isSafeInteger(part) || part < 0))) throw new Error("Tool result path must contain only strings and nonnegative integer indices");
  const missing = () => Object.assign(new Error(`Tool result ${id} has no path ${JSON.stringify(path)}`), { code: "result-path-not-found" });
  let token: any = graph.root;
  for (const part of path) {
    if (Array.isArray(token) && token[0] === 0 && (typeof token[1] === "string" || isText(token[1]))) {
      const string = token[1]; const size = typeof string === "string" ? string.length : string.l;
      if (part === "length") { token = [0, size]; continue; }
      const position = indexKey(String(part)); if (position === undefined || position >= size) throw missing();
      token = [0, typeof string === "string" ? string[position] : await textSlice(string, position, position + 1)]; continue;
    }
    if (!Array.isArray(token) || token[0] !== 1) throw missing();
    const node = token[1], info = await header(node);
    if (typeof part === "number" && (info.type === "map" || info.type === "set")) {
      const rows = await entries(node, `e:${Math.floor(part / ENTRIES)}`);
      const entry = rows.find((row) => row[1] === part)?.[2]; if (entry === undefined) throw missing();
      if (info.type === "set") token = entry;
      else { synthetic = { type: "array", length: 2, entries: [["0", entry[0]], ["1", entry[1]]] }; token = [1, -1]; }
      continue;
    }
    if (info.type === "array" && part === "length") { token = [0, info.length]; continue; }
    if (info.type === "view" && info.name !== "DataView") {
      const position = indexKey(String(part));
      if (position !== undefined && position < info.length) {
        const item = (await readBytes(info, position, position + 1) as any)[0];
        token = typeof item === "bigint" ? [4, String(item)] : !Number.isFinite(item) || Object.is(item, -0) ? [3, Object.is(item, -0) ? "-0" : String(item)] : [0, item];
        continue;
      }
    }
    if (info.type === "regexp" && part === "lastIndex") { token = info.lastIndex; continue; }
    if (info.type === "error" && ["name", "message", "stack", "cause"].includes(String(part))) {
      if (part === "cause" && !info.hasCause) throw missing(); token = info[part]; continue;
    }
    const entry = await property(node, info, String(part));
    if (entry === undefined) throw missing(); token = entry;
  }
  if (selection.offset === undefined && selection.limit === undefined) return materialize(token);
  const offset = Math.max(0, Math.trunc(selection.offset ?? 0) || 0);
  const end = selection.limit === undefined ? Infinity : offset + Math.max(0, Math.trunc(selection.limit) || 0);
  if (Array.isArray(token) && token[0] === 0 && (typeof token[1] === "string" || isText(token[1]))) {
    const value = token[1]; return typeof value === "string" ? value.slice(offset, end) : textSlice(value, offset, end);
  }
  if (!Array.isArray(token) || token[0] !== 1) throw new Error("offset/limit requires an array, string, Map, Set, ArrayBuffer or binary view");
  const node = token[1], info = await header(node);
  if (["array", "map", "set"].includes(info.type)) {
    const prefix = info.type === "array" ? "i:" as const : "e:" as const;
    const size = info.type === "array" ? info.length : info.size;
    const first = Math.min(size, offset), last = Math.min(size, end);
    const firstBucket = Math.floor(first / ENTRIES), lastBucket = Math.floor((last - 1) / ENTRIES);
    const all = last <= first ? [] : node === -1 && synthetic ? [{ node, section: "i:0", part: 0, value: synthetic.entries.map((entry: any, ordinal: number) => [ordinal, entry]) }]
      : lastBucket > firstBucket ? await readBuckets(node, prefix, firstBucket, lastBucket)
      : (await Promise.all(Array.from({ length: lastBucket - firstBucket + 1 }, (_, index) => parts(node, `${prefix}${firstBucket + index}`)))).flat();
    const rows = all.filter((row) => row.section.startsWith(prefix)).flatMap((row) => row.value);
    const chosen = rows.filter(([ordinal, entry]: any) => {
      const index = info.type === "array" ? Number(entry[0]) : ordinal; return index >= first && index < last;
    }).sort((a, b) => a[0] - b[0]);
    const selected = info.type === "array" ? chosen.map(([, entry]: any) => [String(Number(entry[0]) - first), entry[1]]) : chosen.map(([, entry]: any) => entry);
    return materialize([1, -1], { type: info.type, ...(info.type === "array" ? { length: Math.max(0, last - first) } : {}), entries: selected, ...(info.type === "array" ? {} : { properties: [] }) });
  }
  if (info.type === "buffer" || info.type === "view") {
    const count = info.type === "buffer" ? info.byteLength : info.length;
    const first = Math.min(count, offset), last = Math.min(count, end);
    return readBytes(info, first, last);
  }
  throw new Error("offset/limit requires an array, string, Map, Set, ArrayBuffer or binary view");
}
