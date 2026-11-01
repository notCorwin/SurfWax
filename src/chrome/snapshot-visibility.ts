/** Style order must match the DOMSnapshot.captureSnapshot request. */
export const SNAPSHOT_COMPUTED_STYLES = ["opacity", "overflow-x", "overflow-y", "visibility", "content-visibility", "position", "transform", "filter", "perspective", "contain", "will-change", "backdrop-filter", "translate", "rotate", "scale", "clip-path", "clip"] as const;

type Interval = readonly [number, number];
type Clip = { x: Interval; y: Interval };
const infinite: Interval = [-Infinity, Infinity];
const intersection = (a: Interval, b: Interval): Interval => [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
const intersects = (a: Interval, b: Interval) => a[1] > b[0] && a[0] < b[1] && b[1] > b[0];

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
    const contexts: Array<{ transparent: boolean; contentHidden: boolean; emptyClip: boolean; clip: Clip; absoluteClip: Clip; fixedClip: Clip; axisAligned: boolean }> = [];
    for (let index = 0; index < nodes.backendNodeId.length; index++) {
      const parent = contexts[nodes.parentIndex[index]];
      let transparent = parent?.transparent ?? false;
      let contentHidden = parent?.contentHidden ?? false;
      let emptyClip = parent?.emptyClip ?? false;
      const unbounded: Clip = { x: infinite, y: infinite };
      let clip: Clip = parent?.clip ?? unbounded;
      let absoluteClip: Clip = parent?.absoluteClip ?? unbounded;
      let fixedClip: Clip = parent?.fixedClip ?? unbounded;
      let axisAligned = parent?.axisAligned ?? true;
      const layoutIndex = layoutByNode.get(index);
      // Frame elements do not use display:contents, and a frame with no
      // layout box cannot display its document. General layoutless nodes are
      // retained because their descendants may still be rendered.
      const nodeName = strings[nodes.nodeName?.[index]]?.toUpperCase();
      let visible = !transparent && !contentHidden && !emptyClip && !(layoutIndex === undefined && (nodeName === "IFRAME" || nodeName === "FRAME"));
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
        const emptyFrame = (nodeName === "IFRAME" || nodeName === "FRAME") && hasBounds && (bounds[2]! <= 0 || bounds[3]! <= 0);
        visible = !transparent && !contentHidden && !emptyClip && visibility !== "hidden" && visibility !== "collapse" && !outsideClip && !emptyFrame;
        const overflowX = style(1), overflowY = style(2);
        const clipAxis = (overflow: string, parentClip: Interval, boundsAxis: Interval): Interval => {
          if (overflow === "hidden" || overflow === "clip") return intersection(parentClip, boundsAxis);
          // A scroll container can move its descendants through the clip.
          // If the container itself is outside a non-scrollable clip, it
          // cannot expose them; otherwise its scrollable axis is unbounded.
          if (overflow === "auto" || overflow === "scroll") return intersects(boundsAxis, parentClip) ? infinite : [0, 0];
          return parentClip;
        };
        if (hasBounds) clip = { x: clipAxis(overflowX, clip.x, clientX), y: clipAxis(overflowY, clip.y, clientY) };
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
