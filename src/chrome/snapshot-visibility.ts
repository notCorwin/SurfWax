/** Style order must match the DOMSnapshot.captureSnapshot request. */
export const SNAPSHOT_COMPUTED_STYLES = ["opacity", "overflow-x", "overflow-y", "visibility", "content-visibility", "position", "transform", "filter", "perspective", "contain", "will-change", "backdrop-filter", "translate", "rotate", "scale", "clip-path", "clip", "direction", "writing-mode", "display"] as const;

type Interval = readonly [number, number];
type Clip = { x: Interval; y: Interval };
const infinite: Interval = [-Infinity, Infinity];
const intersection = (a: Interval, b: Interval): Interval => [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
const intersects = (a: Interval, b: Interval) => a[1] > b[0] && a[0] < b[1] && b[1] > b[0];

type ScrollDirections = { x: "positive" | "negative" | "unknown"; y: "positive" | "unknown" };
const unknownDirections: ScrollDirections = { x: "unknown", y: "unknown" };

/** Reverse flex/grid and non-horizontal writing can move the scroll origin. */
function scrollDirections(style: (index: number) => string): ScrollDirections {
  const direction = style(17), writing = style(18), display = style(19);
  if (writing !== "horizontal-tb" || !["block", "inline-block", "flow-root"].includes(display)
    || (direction !== "ltr" && direction !== "rtl")) return unknownDirections;
  return { x: direction === "rtl" ? "negative" : "positive", y: "positive" };
}

/** Overestimate reachable positions whenever scroll direction is uncertain. */
function scrollRange(size: number, viewport: number, direction: "positive" | "negative" | "unknown"): Interval {
  // CDP dimensions can be rounded to integral CSS pixels.
  const distance = Math.max(0, size - viewport) + 1;
  return [direction === "positive" ? 0 : -distance, direction === "negative" ? 0 : distance];
}

/** Recognize only clips that are empty regardless of the element's size. */
function emptyInset(value: string): boolean {
  const match = /^inset\((.*)\)(?:\s+(?:border-box|padding-box|content-box|margin-box|fill-box|stroke-box|view-box))?$/.exec(value.trim());
  if (!match) return false;
  const offsets = match[1]!.split(/\s+round\s+/)[0]!.trim().split(/\s+/);
  if (offsets.length < 1 || offsets.length > 4) return false;
  const percent = (part: string): number | undefined => {
    if (/^[+-]?(?:0+(?:\.0*)?|\.0+)(?:px)?$/.test(part)) return 0;
    const percentage = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/.exec(part);
    return percentage ? Number(percentage[1]) : undefined;
  };
  const values = offsets.map(percent);
  const [top, right = top, bottom = top, left = right] = values;
  return top !== undefined && bottom !== undefined && top + bottom >= 100
    || right !== undefined && left !== undefined && right + left >= 100;
}

/** The legacy clip property affects only absolutely or fixed positioned boxes. */
function emptyLegacyClip(value: string, position: string): boolean {
  if (position !== "absolute" && position !== "fixed") return false;
  const match = /^rect\((.*)\)$/.exec(value.trim());
  if (!match) return false;
  const parts = match[1]!.split(/\s*,\s*/);
  if (parts.length !== 4) return false;
  const pixels = (part: string): number | undefined => {
    const pixel = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))px$/.exec(part.trim());
    return pixel ? Number(pixel[1]) : undefined;
  };
  const [top, right, bottom, left] = parts.map(pixels);
  return top !== undefined && bottom !== undefined && bottom <= top
    || left !== undefined && right !== undefined && right <= left;
}

/**
 * Index the visual state of DOM nodes from one target's bulk layout capture.
 * This deliberately excludes the viewport from clipping: content beyond the
 * viewport or a scrollable container can still be reached by scrolling.
 * Missing layout does not imply a hidden subtree (e.g. display:contents).
 */
export function snapshotVisibility(snapshot: any): Map<number, boolean> {
  if (!Array.isArray(snapshot?.documents) || !Array.isArray(snapshot?.strings)) throw new Error("Invalid DOM snapshot");
  const result = new Map<number, boolean>();
  const strings: string[] = snapshot.strings;
  for (const document of snapshot.documents) {
    const nodes = document.nodes, layout = document.layout;
    if (!Array.isArray(nodes?.backendNodeId) || !Array.isArray(nodes?.parentIndex)
      || !Array.isArray(layout?.nodeIndex) || !Array.isArray(layout?.bounds) || !Array.isArray(layout?.styles)) throw new Error("Invalid DOM snapshot document");
    const layoutByNode = new Map<number, number>();
    layout.nodeIndex.forEach((nodeIndex: number, index: number) => layoutByNode.set(nodeIndex, index));
    const nodeName = (index: number) => strings[nodes.nodeName?.[index]]?.toUpperCase();
    const styleFor = (nodeIndex: number, position: number) => {
      const layoutIndex = layoutByNode.get(nodeIndex);
      return layoutIndex === undefined ? "" : strings[layout.styles[layoutIndex]?.[position]] ?? "";
    };
    const documentNode = nodes.backendNodeId.findIndex((_: unknown, index: number) => nodeName(index) === "#DOCUMENT");
    const documentLayout = layoutByNode.get(documentNode);
    const viewport: number[] = documentLayout === undefined ? [] : layout.bounds[documentLayout] ?? [];
    // BODY direction and writing-mode can propagate to the viewport, even in
    // standards mode. Only infer a directional range when both agree.
    // A document type node is also named "html"; it has no computed style.
    const isElement = (index: number) => nodes.nodeType?.[index] === undefined || nodes.nodeType[index] === 1;
    const html = nodes.backendNodeId.findIndex((_: unknown, index: number) => isElement(index) && nodeName(index) === "HTML");
    const body = nodes.backendNodeId.findIndex((_: unknown, index: number) => isElement(index) && nodeName(index) === "BODY");
    const htmlDirections = scrollDirections((position) => styleFor(html, position));
    const bodyDirections = scrollDirections((position) => styleFor(body, position));
    const rootDirections = htmlDirections.x === bodyDirections.x && htmlDirections.y === bodyDirections.y ? htmlDirections : unknownDirections;
    const viewportAxis = (axis: 0 | 1): { reachable: Interval; fixed: Interval } => {
      const extent = viewport[axis + 2], content = axis === 0 ? document.contentWidth : document.contentHeight;
      const offset = axis === 0 ? document.scrollOffsetX : document.scrollOffsetY;
      if (!(typeof extent === "number" && Number.isFinite(extent) && extent > 0
        && typeof content === "number" && Number.isFinite(content) && content >= 0
        && typeof offset === "number" && Number.isFinite(offset))) return { reachable: infinite, fixed: infinite };
      const [minimum, maximum] = scrollRange(content, extent, axis === 0 ? rootDirections.x : rootDirections.y);
      return { reachable: [minimum - 1, maximum + extent + 1], fixed: [offset - 1, offset + extent + 1] };
    };
    const horizontalViewport = viewportAxis(0), verticalViewport = viewportAxis(1);
    const documentClip: Clip = { x: horizontalViewport.reachable, y: verticalViewport.reachable };
    const viewportClip: Clip = { x: horizontalViewport.fixed, y: verticalViewport.fixed };
    const contexts: Array<{ transparent: boolean; contentHidden: boolean; emptyClip: boolean; clip: Clip; absoluteClip: Clip; fixedClip: Clip; axisAligned: boolean }> = [];
    for (let index = 0; index < nodes.backendNodeId.length; index++) {
      const parent = contexts[nodes.parentIndex[index]];
      let transparent = parent?.transparent ?? false;
      let contentHidden = parent?.contentHidden ?? false;
      let emptyClip = parent?.emptyClip ?? false;
      const unbounded: Clip = { x: infinite, y: infinite };
      let clip: Clip = parent?.clip ?? (index === documentNode ? documentClip : unbounded);
      let absoluteClip: Clip = parent?.absoluteClip ?? (index === documentNode ? documentClip : unbounded);
      let fixedClip: Clip = parent?.fixedClip ?? (index === documentNode ? viewportClip : unbounded);
      let axisAligned = parent?.axisAligned ?? true;
      const layoutIndex = layoutByNode.get(index);
      // Frame elements do not use display:contents, and a frame with no
      // layout box cannot display its document. General layoutless nodes are
      // retained because their descendants may still be rendered.
      const tagName = nodeName(index);
      let visible = !transparent && !contentHidden && !emptyClip && !(layoutIndex === undefined && (tagName === "IFRAME" || tagName === "FRAME"));
      if (layoutIndex !== undefined) {
        const styles: number[] = layout.styles[layoutIndex] ?? [];
        const style = (position: number) => strings[styles[position]!] ?? "";
        const position = style(5);
        // Unlike overflow, these clips apply to the complete rendered subtree,
        // including fixed and absolute descendants that escape overflow clips.
        emptyClip ||= emptyInset(style(15)) || emptyLegacyClip(style(16), position);
        const transform = style(6);
        if (transform && transform !== "none") {
          const match = /^matrix\(([^)]+)\)$/.exec(transform);
          const matrix = match?.[1]?.split(",").map(Number);
          axisAligned &&= !!matrix && matrix.length === 6 && matrix[0]! > 0 && matrix[3]! > 0 && matrix[1] === 0 && matrix[2] === 0;
        }
        if ([style(8), style(13), style(14)].some((value) => value && value !== "none")) axisAligned = false;
        // Positioned descendants escape clips between them and their
        // containing block. Fixed elements use the viewport unless a CSS
        // property establishes a containing block for fixed descendants.
        if (position === "absolute") clip = absoluteClip;
        else if (position === "fixed") clip = fixedClip;
        transparent ||= Number.parseFloat(style(0)) === 0;
        const visibility = style(3);
        const bounds: number[] = layout.bounds[layoutIndex] ?? [];
        const hasBounds = bounds.length >= 4 && bounds.every(Number.isFinite);
        const x: Interval = hasBounds ? [bounds[0]!, bounds[0]! + bounds[2]!] : infinite;
        const y: Interval = hasBounds ? [bounds[1]!, bounds[1]! + bounds[3]!] : infinite;
        // Overflow clips to the padding box rather than the border box.
        // clientRects are relative to the border box; convert them to the
        // coordinates used by layout.bounds, accounting for simple scale.
        const client: number[] = layout.clientRects?.[layoutIndex] ?? [];
        const offset: number[] = layout.offsetRects?.[layoutIndex] ?? [];
        const clientAxis = (axis: 0 | 1, boundsAxis: Interval): Interval => {
          if (!axisAligned || !hasBounds || client.length < 4 || offset.length < 4 || !client.every(Number.isFinite) || !offset.every(Number.isFinite) || offset[axis + 2]! <= 0) return boundsAxis;
          const scale = bounds[axis + 2]! / offset[axis + 2]!;
          const start = bounds[axis]! + client[axis]! * scale;
          return [start, start + client[axis + 2]! * scale];
        };
        const clientX = clientAxis(0, x), clientY = clientAxis(1, y);
        // Zero-size structural containers may still contain visible overflow.
        // They have no visual box of their own, but must not hide descendants.
        const outsideClip = hasBounds && ((bounds[2]! > 0 && !intersects(x, clip.x)) || (bounds[3]! > 0 && !intersects(y, clip.y)));
        const emptyFrame = (tagName === "IFRAME" || tagName === "FRAME") && hasBounds && (bounds[2]! <= 0 || bounds[3]! <= 0);
        visible = !transparent && !contentHidden && !emptyClip && visibility !== "hidden" && visibility !== "collapse" && !outsideClip && !emptyFrame;
        const overflowX = style(1), overflowY = style(2);
        const scroll: number[] = layout.scrollRects?.[layoutIndex] ?? [];
        const directions = scrollDirections(style);
        const clipAxis = (axis: 0 | 1, overflow: string, parentClip: Interval, boundsAxis: Interval): Interval => {
          if (overflow === "hidden" || overflow === "clip") return intersection(parentClip, boundsAxis);
          if (overflow === "auto" || overflow === "scroll") {
            const exposed = intersection(parentClip, boundsAxis);
            if (!intersects(boundsAxis, parentClip)) return [0, 0];
            // Rectangles are unavailable or unreliable under rotated and
            // perspective transforms: retain the existing conservative view.
            if (!axisAligned || client.length < 4 || offset.length < 4 || scroll.length < 4
              || !client.every(Number.isFinite) || !offset.every(Number.isFinite) || !scroll.every(Number.isFinite)
              || offset[axis + 2]! <= 0 || client[axis + 2]! < 0 || scroll[axis + 2]! < 0) return infinite;
            const scale = bounds[axis + 2]! / offset[axis + 2]!;
            if (!(scale > 0 && Number.isFinite(scale))) return infinite;
            const [minimum, maximum] = scrollRange(scroll[axis + 2]!, client[axis + 2]!, axis === 0 ? directions.x : directions.y);
            const current = scroll[axis]!;
            return [exposed[0] + (minimum - current) * scale - 1, exposed[1] + (maximum - current) * scale + 1];
          }
          return parentClip;
        };
        if (hasBounds) clip = { x: clipAxis(0, overflowX, clip.x, clientX), y: clipAxis(1, overflowY, clip.y, clientY) };
        const establishesFixed = [style(6), style(7), style(8), style(11), style(12), style(13), style(14)].some((value) => value !== "" && value !== "none")
          || /\b(layout|paint|strict|content)\b/.test(style(9))
          || /\b(transform|translate|rotate|scale|filter|perspective|contain|backdrop-filter)\b/.test(style(10));
        if (establishesFixed) fixedClip = clip;
        if (establishesFixed || position && position !== "static") absoluteClip = clip;
        contentHidden ||= style(4) === "hidden";
      }
      const backendId = nodes.backendNodeId[index];
      if (typeof backendId === "number") result.set(backendId, visible);
      contexts[index] = { transparent, contentHidden, emptyClip, clip, absoluteClip, fixedClip, axisAligned };
    }
  }
  return result;
}
