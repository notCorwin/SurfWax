/** Inputs to a native marker bound; advance rectangles alone are never paint proof. */
export const MARKER_STYLES = [
  "display", "font-family", "font-size", "font-style", "font-weight", "font-stretch",
  "font-variant-caps", "font-variant-numeric", "font-feature-settings", "font-variation-settings",
  "font-kerning", "font-size-adjust", "font-optical-sizing", "font-palette", "text-rendering", "-webkit-locale",
  "line-height", "counter-reset", "counter-increment", "counter-set",
  "letter-spacing", "word-spacing", "direction", "writing-mode", "content", "list-style-type", "list-style-position", "list-style-image",
  "text-shadow", "-webkit-text-stroke-width", "text-decoration-line", "text-emphasis-style", "outline-style",
  "filter", "backdrop-filter", "transform", "translate", "rotate", "scale", "zoom",
] as const;

export type NativeMarkerRecord = {
  index: number; host: number; marker: number; hostBox: number[]; markerBox: number[]; text: string;
  hostStyles: Record<string, string>; markerStyles: Record<string, string>;
};

/** Pure conversion of one capture. Caller must bind IDs to retained live nodes. */
export function markerCaptureEvidence(snapshot: any, identity: { document: number; loader: string; owners: number[] }): NativeMarkerRecord[] | undefined {
  if (!identity.loader || !Number.isSafeInteger(identity.document) || identity.document <= 0) return;
  const strings = snapshot?.strings;
  if (!Array.isArray(strings) || !Array.isArray(snapshot.documents)) return;
  const doc = snapshot.documents.find((doc: any) => doc.nodes?.nodeType?.some((type: number, index: number) => type === 9 && doc.nodes.backendNodeId[index] === identity.document));
  if (!doc?.nodes || !doc.layout) return;
  const nodes = doc.nodes, layout = doc.layout;
  if (![nodes.nodeType, nodes.backendNodeId, nodes.parentIndex, nodes.nodeName, layout.nodeIndex, layout.bounds, layout.styles].every(Array.isArray)) return;
  const rows = new Map<number, number[]>();
  layout.nodeIndex.forEach((index: number, row: number) => { const list = rows.get(index) ?? []; list.push(row); rows.set(index, list); });
  const owners = new Map(identity.owners.map((id, index) => [id, index]));
  const style = (row: number) => Object.fromEntries(MARKER_STYLES.map((key, index) => [key, strings[layout.styles[row]?.[index]]]));
  const rect = (row: number) => {
    const r = layout.bounds[row];
    return Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0
      ? [r[0] - (doc.scrollOffsetX ?? 0), r[1] - (doc.scrollOffsetY ?? 0), r[2], r[3]] : undefined;
  };
  const result: NativeMarkerRecord[] = [];
  for (let index = 0; index < nodes.nodeName.length; index++) {
    if (strings[nodes.nodeName[index]] !== "::marker") continue;
    const parent = nodes.parentIndex[index], host = nodes.backendNodeId[parent], owner = owners.get(host);
    if (owner === undefined) continue;
    const markerRows = (rows.get(index) ?? []).filter(row => typeof strings[layout.text?.[row]] === "string" && strings[layout.text[row]].length);
    const hostRows = rows.get(parent) ?? [];
    if (markerRows.length !== 1 || hostRows.length !== 1) continue;
    const markerRow = markerRows[0]!, hostRow = hostRows[0]!, markerBox = rect(markerRow), hostBox = rect(hostRow);
    if (!markerBox || !hostBox) continue;
    const hostStyles = style(hostRow), markerStyles = style(markerRow);
    if (![hostStyles, markerStyles].every(values => Object.values(values).every(value => typeof value === "string"))) continue;
    result.push({ index: owner, host, marker: nodes.backendNodeId[index], hostBox, markerBox, text: strings[layout.text[markerRow]], hostStyles, markerStyles });
  }
  return result;
}

/** Serialized into the same isolated world as the requesting reader. Identity
 * references and native data may live through the capture; no paint/style
 * calculation from the first pass is reused by the final synchronous reader. */
export function prepareMarkerQuery(this: any, token: string, deadline: number, schedule: (ms: number, callback: () => void) => () => void) {
  if (this?.nativeMarkerQuery !== token || !Array.isArray(this.markerOwners) || !this.markerOwners.length) return null;
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) return [];
  const owners = [...new Set<Element>(this.markerOwners)], doc = owners[0]?.ownerDocument;
  if (!doc || doc.readyState !== "complete" || doc.fonts.status !== "loaded"
    || owners.some(node => !node.isConnected || node.ownerDocument !== doc || node.getRootNode() !== doc)) return [];
  const fontFaces = [...doc.fonts];
  const fontSignature = () => [...doc.fonts].map((font, index) => [font === fontFaces[index], font.status, font.family,
    font.style, font.weight, font.stretch, font.unicodeRange, font.featureSettings, font.variationSettings, font.display,
    font.ascentOverride, font.descentOverride, font.lineGapOverride]);
  const initialFonts = JSON.stringify(fontSignature());
  const sheets = () => {
    const seen = new Set<CSSStyleSheet>();
    const read = (sheet: CSSStyleSheet): any => {
      if (seen.has(sheet)) return null;
      seen.add(sheet);
      return [sheet.disabled, sheet.media.mediaText, [...sheet.cssRules].map(rule => [rule.cssText,
        "styleSheet" in rule && rule.styleSheet ? read(rule.styleSheet as CSSStyleSheet) : null,
        "conditionText" in rule && rule.type === CSSRule.MEDIA_RULE ? matchMedia(String(rule.conditionText)).matches : null])];
    };
    return JSON.stringify([...doc.styleSheets, ...doc.adoptedStyleSheets].map(read));
  };
  let signature: string;
  try { signature = sheets(); } catch { return []; }
  const view = doc.defaultView!, viewport = () => [view.innerWidth, view.innerHeight, view.scrollX, view.scrollY, view.devicePixelRatio, view.visualViewport?.scale];
  const initialViewport = JSON.stringify(viewport());
  const stableAnimations = () => !doc.getAnimations().some(animation => {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect)) return true;
    const keys = effect.getKeyframes().flatMap(frame => Object.keys(frame));
    // A sibling/ancestor counter can affect numbering without a DOM write.
    if (keys.some(key => /^counter(?:-|[A-Z])/.test(key))) return true;
    const target = effect.target;
    return target instanceof Element && owners.some(owner => target.contains(owner) || owner.contains(target))
      && keys.some(key => /^(?:font|lineHeight|letterSpacing|wordSpacing|listStyle|content$|direction$|writingMode)/.test(key));
  });
  if (!stableAnimations()) return [];
  let changed = false, disposed = false;
  const observer = new MutationObserver(() => { changed = true; observer.disconnect(); });
  observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  const state: any = [doc, ...owners];
  const images = new Set<{ image: HTMLImageElement; url: string }>();
  let cancelTimer: (() => void) | undefined;
  const dispose = () => {
    disposed = true; observer.disconnect(); cancelTimer?.();
    for (const { image, url } of images) { image.removeAttribute("src"); URL.revokeObjectURL(url); }
    images.clear();
    const key = Symbol.for("surf-wax.rendered-marker-query.v1");
    if ((globalThis as any)[key] === state) delete (globalThis as any)[key];
  };
  const valid = () => {
    try {
      if (observer.takeRecords().length) changed = true;
      return !disposed && Date.now() < deadline && !changed && doc.isConnected && doc === view.document
        && doc.readyState === "complete" && doc.fonts.status === "loaded" && JSON.stringify(fontSignature()) === initialFonts
        && JSON.stringify(viewport()) === initialViewport && sheets() === signature
        && stableAnimations()
        && owners.every(node => node.isConnected && node.ownerDocument === doc && node.getRootNode() === doc);
    } catch { return false; }
  };
  Object.defineProperties(state, {
    token: { value: token }, valid: { value: valid },
    install: { value: (data: unknown) => {
      if (!valid()) return false;
      Object.defineProperty(state, "data", { value: data, configurable: true });
      (globalThis as any)[Symbol.for("surf-wax.rendered-marker-query.v1")] = state;
      return true;
    } },
    image: { value: (image: HTMLImageElement, url: string) => {
      const item = { image, url }; images.add(item);
      return () => { images.delete(item); image.removeAttribute("src"); URL.revokeObjectURL(url); };
    } },
    dispose: { value: dispose },
  });
  cancelTimer = schedule(Math.max(1, deadline - Date.now()), dispose);
  return state;
}

/** This function is serialized, and only reads browser-owned font evidence.
 * Rasterize generated marker glyphs off-DOM with the native platform face and
 * supported shaping, rather than treating advance/layout boxes as ink. */
export async function measureMarkerInk(this: any, records: Array<NativeMarkerRecord & { font?: { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number } }>) {
  if (!this.valid()) return false;
  const advance = new OffscreenCanvas(1, 1).getContext("2d");
  if (!advance) return false;
  const qualified = records.filter(record => {
    const p = record.markerStyles, h = record.hostStyles, font = record.font;
    const supported = font && !font.isCustomFont && /^[A-Za-z][A-Za-z0-9 -]{0,100}$/.test(font.familyName) && font.postScriptName && font.glyphCount >= record.text.length
      && /^[0-9]+\. $/.test(record.text) && p.content === "normal" && h["list-style-type"] === "decimal" && h["list-style-image"] === "none"
      && ["inside", "outside"].includes(h["list-style-position"]) && p["font-style"] === "normal" && p["font-weight"] === "400"
      && p["font-stretch"] === "100%" && p["font-variant-caps"] === "normal" && ["normal", "tabular-nums"].includes(p["font-variant-numeric"]!)
      && p["font-size"] === h["font-size"]
      && p["font-feature-settings"] === "normal" && p["font-variation-settings"] === "normal" && p["font-size-adjust"] === "none"
      && p["font-optical-sizing"] === "auto" && p["font-palette"] === "normal" && p["text-rendering"] === "auto"
      && /^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(p["font-size"]!) && ["auto", "normal", "none"].includes(p["font-kerning"]!)
      && p["direction"] === "ltr" && p["writing-mode"] === "horizontal-tb" && p["line-height"] === "normal"
      && ["normal", "0px"].includes(p["letter-spacing"]!) && ["normal", "0px"].includes(p["word-spacing"]!)
      && [p, h].every(style => ["text-shadow", "text-decoration-line", "text-emphasis-style", "outline-style", "filter", "backdrop-filter", "transform", "translate", "rotate", "scale"].every(key => style[key] === "none")
        && parseFloat(style["-webkit-text-stroke-width"]!) === 0 && ["1", "normal"].includes(style.zoom!));
    if (!supported) return false;
    advance.font = `normal 400 ${p["font-size"]} ${JSON.stringify(font.familyName)}`;
    advance.fontKerning = p["font-kerning"] as CanvasFontKerning;
    // An additional mismatch rejection, not the ink proof. Rasterized SVG
    // below owns the supported numeric shaping and actual glyph envelope.
    return Math.abs(advance.measureText(record.text).width - record.markerBox[2]!) <= (record.text.length + 1) / 64;
  });
  const groups = new Map<string, typeof qualified>();
  for (const record of qualified) {
    const key = JSON.stringify([record.font, record.markerStyles]);
    const group = groups.get(key) ?? []; group.push(record); groups.set(key, group);
  }
  const measured: Array<NativeMarkerRecord & { ink: number[] }> = [];
  const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
  const scale = devicePixelRatio;
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) return false;
  for (const group of groups.values()) {
    const p = group[0]!.markerStyles, font = group[0]!.font!;
    const size = parseFloat(p["font-size"]!);
    if (!Number.isFinite(size) || size <= 0 || size > 256) continue;
    const padding = Math.ceil(4 * size + 8), stride = padding * 2;
    const width = Math.ceil((Math.max(...group.map(record => record.markerBox[2]!)) + 2 * padding) * scale);
    const rowHeight = Math.ceil(stride * scale), perImage = Math.max(1, Math.floor(Math.min(4096, 4_194_304 / width) / rowHeight));
    if (width > 4096 || rowHeight > 4096) continue;
    const style = `font-family:${JSON.stringify(font.familyName)};font-size:${p["font-size"]};font-style:normal;font-weight:400;font-stretch:100%;font-variant-numeric:${p["font-variant-numeric"]};font-kerning:${p["font-kerning"]};white-space:pre;fill:black`;
    for (let offset = 0; offset < group.length; offset += perImage) {
      if (!this.valid()) return false;
      const batch = group.slice(offset, offset + perImage), height = rowHeight * batch.length;
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width / scale} ${height / scale}">${batch.map((record, index) => `<text x="${padding}" y="${(index * rowHeight) / scale + padding}" xml:space="preserve" style="${xml(style)}">${xml(record.text)}</text>`).join("")}</svg>`;
      const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" })), image = new Image();
      const releaseImage = this.image(image, url);
      try {
        image.src = url; await image.decode();
        if (!this.valid()) return false;
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
        if (!context) return false;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, width, height).data;
        for (let index = 0; index < batch.length; index++) {
          let left = width, right = -1, top = rowHeight, bottom = -1;
          for (let y = 0; y < rowHeight; y++) for (let x = 0; x < width; x++) if (pixels[((index * rowHeight + y) * width + x) * 4 + 3]) {
            left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
          }
          // A crop touching the bitmap edge cannot establish bounded ink.
          if (left <= 0 || right >= width || top <= 0 || bottom >= rowHeight || right <= left || bottom <= top) continue;
          const record = batch[index]!, tolerance = 1 + 1 / scale + record.text.length / 64;
          measured.push({ ...record, ink: [left / scale - padding - tolerance, top / scale - padding - tolerance,
            right / scale - padding + tolerance, bottom / scale - padding + tolerance] });
        }
      } finally { releaseImage(); }
    }
  }
  return this.install(measured);
}

/** A new synchronous reader checks current geometry/style and state again.
 * Baseline is conservatively allowed anywhere within the native line box. */
export function markerInkRects(state: any): Map<Element, readonly { left: number; top: number; right: number; bottom: number }[]> {
  const result = new Map<Element, readonly { left: number; top: number; right: number; bottom: number }[]>();
  if (!state || typeof state.valid !== "function" || !state.valid() || !Array.isArray(state.data)) return result;
  for (const record of state.data) {
    const owner = state[record.index + 1];
    if (!(owner instanceof Element) || owner.ownerDocument !== document || !owner.isConnected) continue;
    const host = owner.getBoundingClientRect(), current = [host.x, host.y, host.width, host.height];
    if (current.some((value, index) => Math.abs(value - record.hostBox[index]) > 1 / 64)) continue;
    if (![getComputedStyle(owner), getComputedStyle(owner, "::marker")].every((style, index) =>
      Object.entries(index ? record.markerStyles : record.hostStyles).every(([key, value]) => style.getPropertyValue(key) === value))) continue;
    const [x, y, _width, height] = record.markerBox, [left, top, right, bottom] = record.ink;
    result.set(owner, [{ left: x + left, right: x + right, top: y + top, bottom: y + height + bottom }]);
  }
  return result;
}
