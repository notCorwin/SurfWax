/** Self-contained so Chrome can install the same algorithms in an isolated world. */
export function snapshotObservationPrimitives(install = false, worldIdentity) {
  const get = (style, name) => typeof style?.getPropertyValue === "function" ? style.getPropertyValue(name).trim() : String(style?.[name] ?? "").trim();
  const finiteRect = (r) => r && [r.left, r.top, r.right, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top;
  const within = (r, b) => r.left >= b.left && r.top >= b.top && r.right <= b.right && r.bottom <= b.bottom;
  const tokens = (value, separator) => {
    const result = []; let depth = 0, start = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === "(") depth++; else if (c === ")") { if (--depth < 0) return null; }
      else if (!depth && separator(c)) { if (i > start) result.push(value.slice(start, i).trim()); start = i + 1; }
      if (/["'\\{};]/.test(c)) return null;
    }
    if (depth) return null;
    if (start < value.length) result.push(value.slice(start).trim());
    return result;
  };
  const terms = (value) => tokens(value, (c) => /\s/.test(c));
  const length = (value, extent) => {
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|%)?$/i.test(value)) {
      const number = parseFloat(value);
      if (!Number.isFinite(number) || number !== 0 && !/(?:px|%)$/.test(value)) return null;
      return value.endsWith("%") ? number * extent / 100 : number;
    }
    if (!/^calc\([^()]+\)$/.test(value)) return null;
    const source = value.slice(5, -1).replace(/\s+/g, "");
    const parts = source.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px|%)/gi);
    if (!parts || parts.join("") !== source) return null;
    let result = 0;
    for (const part of parts) result += parseFloat(part) * (part.endsWith("%") ? extent / 100 : 1);
    return Number.isFinite(result) ? result : null;
  };
  const expand = (values) => values.length === 1 ? [values[0], values[0], values[0], values[0]]
    : values.length === 2 ? [values[0], values[1], values[0], values[1]]
      : values.length === 3 ? [values[0], values[1], values[2], values[1]] : values.length === 4 ? values : null;
  const rounded = (box, value, allowPercent = true) => {
    const parts = tokens(value, (c) => c === "/");
    if (!parts || parts.length > 2 || !parts.length || !allowPercent && value.includes("%")) return null;
    const x = expand(terms(parts[0]) ?? []), y = parts.length === 2 ? expand(terms(parts[1]) ?? []) : x;
    if (!x || !y) return null;
    const width = box.right - box.left, height = box.bottom - box.top;
    const rx = x.map((part) => length(part, width)), ry = y.map((part) => length(part, height));
    if ([...rx, ...ry].some((part) => part === null || part < 0)) return null;
    const scale = Math.min(1, ...[width / (rx[0] + rx[1]), width / (rx[3] + rx[2]), height / (ry[0] + ry[3]), height / (ry[1] + ry[2])]);
    return { box, rx: rx.map((r) => r * scale), ry: ry.map((r) => r * scale) };
  };
  const inside = (rect, shape) => {
    if (!shape || !within(rect, shape.box)) return false;
    const b = shape.box;
    return [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]].every(([px, py]) =>
      shape.rx.every((rx, i) => {
        const ry = shape.ry[i]; if (!rx || !ry) return true;
        const left = i === 0 || i === 3, top = i < 2;
        const cx = left ? b.left + rx : b.right - rx, cy = top ? b.top + ry : b.bottom - ry;
        return !(left ? px < cx : px > cx) || !(top ? py < cy : py > cy) || ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 < 1;
      }));
  };
  const alpha = (color) => {
    if (color === "transparent") return 0;
    if (color === "black" || color === "white" || /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color)) return 1;
    if (/^#[\da-f]{4}$/i.test(color)) return parseInt(color[4], 16) / 15;
    if (/^#[\da-f]{8}$/i.test(color)) return parseInt(color.slice(7), 16) / 255;
    const match = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(([^()]*)\)$/i.exec(color);
    if (!match) return null;
    const body = match[2], slash = body.split("/");
    if (slash.length > 2) return null;
    let value;
    if (slash.length === 2) value = slash[1].trim();
    else if (/^(?:rgba|hsla)$/i.test(match[1])) {
      const comma = body.split(","); if (comma.length !== 4) return null;
      value = comma[3].trim();
    } else return 1;
    if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value)) return null;
    const number = parseFloat(value) / (value.endsWith("%") ? 100 : 1);
    return number >= 0 && number <= 1 ? number : null;
  };
  const neutralGeometry = (s) => {
    if (!["filter", "backdrop-filter", "perspective", "offset-path", "-webkit-box-reflect"].every((key) => ["", "none"].includes(get(s, key)))) return false;
    if (!["", "flat"].includes(get(s, "transform-style")) || !["", "1", "normal"].includes(get(s, "zoom"))) return false;
    const transform = get(s, "transform");
    if (transform && transform !== "none") {
      const m = /^matrix\(([^()]*)\)$/.exec(transform)?.[1].split(",").map(Number);
      if (!m || m.length !== 6 || !m.every(Number.isFinite) || m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1) return false;
    }
    const translate = get(s, "translate"), scale = get(s, "scale"), rotate = get(s, "rotate");
    return (!translate || translate === "none" || translate.split(/\s+/).length <= 2 && translate.split(/\s+/).every((x) => length(x, 1) !== null))
      && (!scale || scale === "none" || scale.split(/\s+/).length <= 2 && scale.split(/\s+/).every((x) => Number(x) === 1))
      && (!rotate || rotate === "none" || /^(?:0(?:deg|rad|grad|turn))$/.test(rotate));
  };
  const axisGradient = (image, box) => {
    if (!image.startsWith("linear-gradient(") || !image.endsWith(")")) return null;
    const parts = tokens(image.slice(16, -1), (c) => c === ",");
    if (!parts || parts.length < 2) return null;
    let axis = "y", reverse = false;
    const directions = { "to right": ["x", false], "90deg": ["x", false], "to left": ["x", true], "270deg": ["x", true],
      "to bottom": ["y", false], "180deg": ["y", false], "to top": ["y", true], "0deg": ["y", true], "360deg": ["y", true] };
    if (directions[parts[0]]) [axis, reverse] = directions[parts.shift()];
    else if (/^(?:to\b|[+-]?[\d.]+(?:deg|rad|grad|turn))/.test(parts[0])) return null;
    const extent = axis === "x" ? box.right - box.left : box.bottom - box.top;
    const stops = [];
    for (const part of parts) {
      const words = terms(part); if (!words || words.length < 1 || words.length > 3) return null;
      const opacity = alpha(words[0]); if (opacity === null) return null;
      if (words.length === 1) stops.push({ alpha: opacity, at: null });
      else for (const position of words.slice(1)) {
        const at = length(position, extent); if (at === null) return null;
        stops.push({ alpha: opacity, at });
      }
    }
    if (stops.length < 2) return null;
    if (stops[0].at === null) stops[0].at = 0;
    if (stops[stops.length - 1].at === null) stops[stops.length - 1].at = extent;
    let maximum = -Infinity;
    for (const stop of stops) if (stop.at !== null) { stop.at = Math.max(maximum, stop.at); maximum = stop.at; }
    for (let i = 0; i < stops.length; i++) if (stops[i].at === null) {
      const previous = stops[i - 1]; let end = i;
      while (stops[end].at === null) end++;
      for (let j = i; j < end; j++) stops[j].at = previous.at + (stops[end].at - previous.at) * (j - i + 1) / (end - i + 1);
      i = end;
    }
    const intervals = (opacity) => {
      const out = [];
      const add = (start, end) => {
        if (!(end > start)) return;
        if (out.length && out[out.length - 1][1] === start) out[out.length - 1][1] = end; else out.push([start, end]);
      };
      if (stops[0].alpha === opacity) add(-Infinity, stops[0].at);
      for (let i = 1; i < stops.length; i++) if (stops[i - 1].alpha === opacity && stops[i].alpha === opacity) add(stops[i - 1].at, stops[i].at);
      if (stops[stops.length - 1].alpha === opacity) add(stops[stops.length - 1].at, Infinity);
      return out;
    };
    return { axis, reverse, opaque: intervals(1), transparent: intervals(0) };
  };
  const maskStatus = (s, box, rects) => {
    if (!["", "none"].includes(get(s, "-webkit-mask-box-image-source")) || !["", "none"].includes(get(s, "mask-border-source"))) return "unknown";
    const image = get(s, "mask-image"); if (image === "none") return "opaque";
    if (!finiteRect(box) || !Array.isArray(rects) || !rects.length || !rects.every(finiteRect) || !neutralGeometry(s)) return "unknown";
    if (!["alpha", "match-source"].includes(get(s, "mask-mode")) || get(s, "mask-origin") !== "border-box" || get(s, "mask-clip") !== "border-box"
      || !["auto", "auto auto"].includes(get(s, "mask-size")) || get(s, "mask-position") !== "0% 0%"
      || !["repeat", "no-repeat"].includes(get(s, "mask-repeat")) || get(s, "mask-composite") !== "add") return "unknown";
    if (!["", "round", "superellipse(1)"].includes(get(s, "corner-shape"))) return "unknown";
    const border = rounded(box, get(s, "border-radius") || "0px");
    if (!border || !rects.every((rect) => inside(rect, border))) return "unknown";
    const gradient = axisGradient(image, box); if (!gradient) return "unknown";
    const coordinates = (rect) => gradient.axis === "x" ? gradient.reverse ? [box.right - rect.right, box.right - rect.left] : [rect.left - box.left, rect.right - box.left]
      : gradient.reverse ? [box.bottom - rect.bottom, box.bottom - rect.top] : [rect.top - box.top, rect.bottom - box.top];
    const covered = (intervals) => rects.every((rect) => { const [lo, hi] = coordinates(rect); return intervals.some(([start, end]) => lo >= start && hi <= end); });
    return covered(gradient.opaque) ? "opaque" : covered(gradient.transparent) ? "transparent" : "unknown";
  };
  const insetRegion = (s, box) => {
    if (!finiteRect(box) || !neutralGeometry(s)) return null;
    const match = /^inset\((.*)\)(?:\s+border-box)?$/.exec(get(s, "clip-path")); if (!match) return null;
    const parts = match[1].split(/\s+round\s+/); if (parts.length > 2) return null;
    const offsets = expand(terms(parts[0]) ?? []); if (!offsets) return null;
    const width = box.right - box.left, height = box.bottom - box.top;
    const values = offsets.map((x, i) => length(x, i % 2 ? width : height)); if (values.some((x) => x === null)) return null;
    const clipped = { left: box.left + values[3], top: box.top + values[0], right: box.right - values[1], bottom: box.bottom - values[2] };
    if (!finiteRect(clipped)) return { empty: true };
    // Percentage radii with nonzero insets have a separate reference-box
    // resolution rule; retain uncertainty instead of guessing that geometry.
    const shape = rounded(clipped, parts[1] || "0px", values.every((x) => x === 0)); if (!shape) return null;
    return { empty: false, clipped, shape };
  };
  const clipStatus = (s, box, rects) => {
    if (get(s, "clip-path") === "none") return "opaque";
    if (!Array.isArray(rects) || !rects.length || !rects.every(finiteRect)) return "unknown";
    const region = insetRegion(s, box); if (!region) return "unknown";
    if (region.empty) return "transparent";
    const { shape, clipped } = region;
    if (rects.every((rect) => inside(rect, shape))) return "opaque";
    return rects.every((r) => r.right <= clipped.left || r.left >= clipped.right || r.bottom <= clipped.top || r.top >= clipped.bottom) ? "transparent" : "unknown";
  };
  // Layout/Range boxes may include original fragments hidden by line-clamp.
  // Only a single, simple text flow can prove that no extra line or generated
  // box caused ellipsis. This is a local flow proof, not an overflow or paint
  // proof; callers must retain those independent checks.
  const emptyPositionedPseudo = (s) => {
    // A transparent stretched-link pseudo is out of flow and contributes no
    // line or ink. Positioned generated content is otherwise still unknown.
    const outset = terms(get(s, "border-image-outset"));
    return get(s, "content") === '\"\"' && ["absolute", "fixed"].includes(get(s, "position"))
      && ["block", "flow-root", "inline-block", "flex", "grid", "inline-flex", "inline-grid"].includes(get(s, "display"))
      && alpha(get(s, "background-color")) === 0 && get(s, "mix-blend-mode") === "normal"
      && ["visible", "hidden", "clip"].includes(get(s, "overflow-x")) && ["visible", "hidden", "clip"].includes(get(s, "overflow-y"))
      && ["background-image", "border-image-source", "box-shadow", "text-shadow", "outline-style", "text-decoration-line", "text-emphasis-style",
        "appearance", "border-shape", "filter", "backdrop-filter", "-webkit-box-reflect", "transform", "translate", "rotate", "scale", "perspective",
        "clip-path", "mask-image", "-webkit-mask-box-image-source", "offset-path"].every((key) => get(s, key) === "none")
      && ["", "none"].includes(get(s, "mask-border-source")) && parseFloat(get(s, "-webkit-text-stroke-width")) === 0
      && !!outset?.length && outset.every((part) => length(part, 1) === 0)
      && ["top", "right", "bottom", "left"].every((side) => parseFloat(get(s, `border-${side}-width`)) === 0);
  };
  const textFlowCoverage = (text, styleFor, composedParent) => {
    const clipInputs = [];
    const unknown = () => ({ coverage: "unknown", clipInputs: clipInputs.sort() });
    if (!text || text.nodeType !== 3 || !text.isConnected || !text.parentElement) return unknown();
    const doc = text.ownerDocument, view = doc?.defaultView;
    if (!view) return unknown();
    const cssFor = styleFor || ((element) => view.getComputedStyle(element));
    const parentOf = composedParent || ((node) => node.assignedSlot || node.parentElement || node.getRootNode?.()?.host || null);
    const scopes = [];
    let ambiguous = false;
    for (let element = parentOf(text); element; element = parentOf(element)) {
      const s = cssFor(element), clamp = get(s, "-webkit-line-clamp");
      if (clamp && clamp !== "none") { scopes.push(element); clipInputs.push(`-webkit-line-clamp:${clamp}`); }
      ambiguous ||= !!element.assignedSlot || element.getRootNode() !== doc || !!element.shadowRoot;
      if (element.namespaceURI === "http://www.w3.org/1999/xhtml" && typeof globalThis.chrome?.dom?.openOrClosedShadowRoot === "function"
        && globalThis.chrome.dom.openOrClosedShadowRoot(element)) ambiguous = true;
    }
    if (!scopes.length) return { coverage: "complete", clipInputs };
    if (text.assignedSlot || ambiguous) return unknown();
    if (scopes.length !== 1) return unknown();
    if (!/^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]*$/u.test(text.data)
      || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text.data)) return unknown();
    const range = doc.createRange(); range.selectNodeContents(text);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rects.length || !rects.every(finiteRect)) return unknown();
    const clamp = scopes[0], base = cssFor(clamp), count = Number(get(base, "-webkit-line-clamp"));
    if (!Number.isSafeInteger(count) || count < 1 || get(base, "-webkit-box-orient") !== "vertical"
      || !["flow-root", "-webkit-box", "inline-block", "-webkit-inline-box"].includes(get(base, "display"))) return unknown();
    const font = parseFloat(get(base, "font-size")), line = parseFloat(get(base, "line-height"));
    if (!(font > 0 && line >= font) || !get(base, "line-height").endsWith("px")) return unknown();
    let current = clamp;
    while (current !== text) {
      if (current.nodeType !== 1 || current.getRootNode() !== doc || current.shadowRoot || current.assignedSlot) return unknown();
      const s = cssFor(current), whiteSpace = get(s, "white-space");
      if (get(s, "writing-mode") !== "horizontal-tb" || get(s, "direction") !== "ltr" || !["normal", "isolate"].includes(get(s, "unicode-bidi"))) return unknown();
      if (parseFloat(get(s, "font-size")) !== font || get(s, "line-height") !== get(base, "line-height")
        || !["normal", "nowrap", "pre-wrap"].includes(whiteSpace) || get(s, "text-transform") !== "none"
        || get(s, "-webkit-text-security") !== "none" || whiteSpace === "pre-wrap" && /[\r\n]/.test(text.data)) return unknown();
      if (current !== clamp && (!["block", "flow-root", "inline"].includes(get(s, "display")) || get(s, "position") !== "static")) return unknown();
      if (get(s, "float") !== "none" || get(s, "column-count") !== "auto" || get(s, "column-width") !== "auto"
        || parseFloat(get(s, "text-indent")) !== 0 || get(s, "shape-outside") !== "none" || !neutralGeometry(s)) return unknown();
      if (current !== clamp && ["margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
        "border-top-width", "border-right-width", "border-bottom-width", "border-left-width"].some((key) => parseFloat(get(s, key)) !== 0)) return unknown();
      for (const pseudo of ["::before", "::after"]) {
        const generated = view.getComputedStyle(current, pseudo);
        if (!["none", "normal"].includes(generated.content) && !emptyPositionedPseudo(generated)) return unknown();
      }
      const children = [...current.childNodes].filter((node) => node.nodeType !== 8 && !(node.nodeType === 3 && !node.data));
      if (children.length !== 1) return unknown();
      current = children[0];
      if (current.nodeType === 3 && current !== text) return unknown();
    }
    const rows = [];
    for (const rect of rects) {
      let row = rows.find((row) => row.top === rect.top && row.bottom === rect.bottom);
      if (!row) { row = { top: rect.top, bottom: rect.bottom, rects: [] }; rows.push(row); }
      if (row.rects.some((other) => rect.left < other.right && rect.right > other.left)) return unknown();
      row.rects.push(rect);
    }
    rows.sort((a, b) => a.top - b.top);
    if (rows.length > count || rows.some((row, index) => index && Math.abs(row.top - rows[0].top - index * line) > 1 / 64)) return unknown();
    return { coverage: "complete", clipInputs: clipInputs.sort() };
  };
  const api = { version: 2, worldIdentity, maskStatus, clipStatus, textFlowCoverage, clipIsEmpty: (style, box) => insetRegion(style, box)?.empty === true, effectCoverage: (style, box, rects) => {
    const mask = maskStatus(style, box, rects), clip = clipStatus(style, box, rects);
    return mask === "opaque" && clip === "opaque" ? "complete" : mask === "transparent" || clip === "transparent" ? "empty" : "unknown";
  }, neutralGeometry };
  if (install) { globalThis[Symbol.for("surf-wax.snapshot-observation-primitives.v2")] = api; return api.version; }
  return api;
}
