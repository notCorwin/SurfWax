/** Hide a node only when a later, opaque, uncomplicated rectangular paint
 * completely contains its layout box. A text node that intersects such paint
 * is withheld in full because its hidden characters cannot be identified from
 * a box alone. Unknown paint remains visible. */
export function applySnapshotOcclusion(snapshot: any, visibility: Map<number, boolean>): void {
  const strings: string[] = snapshot.strings;
  for (const document of snapshot.documents) {
    const nodes = document.nodes, layout = document.layout;
    if (!Array.isArray(layout.paintOrders) || layout.paintOrders.length !== layout.nodeIndex.length) continue;
    const byNode = new Map<number, number>();
    layout.nodeIndex.forEach((node: number, index: number) => byNode.set(node, index));
    const value = (index: number, style: number) => strings[layout.styles[index]?.[style]] ?? "";
    const rect = (index: number): number[] | undefined => {
      const r = layout.bounds[index];
      return Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0 ? r : undefined;
    };
    const contains = (a: number[], b: number[]) => a[0]! <= b[0]! && a[1]! <= b[1]!
      && a[0]! + a[2]! >= b[0]! + b[2]! && a[1]! + a[3]! >= b[1]! + b[3]!;
    const overlaps = (a: number[], b: number[]) => a[0]! < b[0]! + b[2]! && a[0]! + a[2]! > b[0]!
      && a[1]! < b[1]! + b[3]! && a[1]! + a[3]! > b[1]!;
    const noEffect = (index: number) => value(index, 0) === "1" && value(index, 3) === "visible"
      && [6, 7, 8, 11, 12, 13, 14, 15, 29, 30].every((key) => value(index, key) === "none")
      && value(index, 9) === "none" && value(index, 10) === "auto" && value(index, 16) === "auto"
      && value(index, 36) === "normal" && value(index, 40) === "auto" && value(index, 41) === "normal";
    // CDP paintOrders identify groups, not a total CSS paint order: a negative
    // stacking context can have a higher group number than ordinary content.
    // Accept only a positive z-index cover in the root stacking context and
    // a target with no intervening stacking context of its own.
    const stackSafe: boolean[] = [];
    for (let node = 0; node < nodes.parentIndex.length; node++) {
      const parent = nodes.parentIndex[node], inherited = parent < 0 ? true : stackSafe[parent] === true;
      const index = byNode.get(node);
      stackSafe[node] = inherited && (nodes.nodeType?.[node] !== 1 || index !== undefined && noEffect(index)
        && value(index, 39) === "auto" && !["fixed", "sticky"].includes(value(index, 5)));
    }
    const rootStack = (node: number) => node < 0 || stackSafe[node] === true;
    const covers: Array<{ node: number; paint: number; bounds: number[] }> = [];
    for (let i = 0; i < layout.nodeIndex.length; i++) {
      const node = layout.nodeIndex[i], bounds = rect(i), paint = layout.paintOrders[i];
      if (nodes.nodeType?.[node] !== 1 || !bounds || !Number.isFinite(paint)
        || visibility.get(nodes.backendNodeId[node]) !== true || !["absolute", "fixed"].includes(value(i, 5))
        || !/^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(value(i, 34))
        || !/^[1-9]\d*$/.test(value(i, 39)) || !rootStack(nodes.parentIndex[node])
        || value(i, 24) !== "border-box" || !/^(?:0(?:px|%)?\s*)+$/.test(value(i, 35)) || !noEffect(i)) continue;
      let safe = true;
      for (let parent = nodes.parentIndex[node]; parent >= 0; parent = nodes.parentIndex[parent]) {
        if (nodes.nodeType?.[parent] !== 1) continue;
        const index = byNode.get(parent);
        if (index === undefined || !noEffect(index) || value(index, 1) !== "visible" || value(index, 2) !== "visible") { safe = false; break; }
      }
      if (safe) covers.push({ node, paint, bounds });
    }
    // A covering rectangle must contain the target's top-left cell. Index
    // bounded rectangles once rather than comparing every node with every
    // positioned background on pages with many cards or table cells.
    const grid = new Map<string, typeof covers>(), large: typeof covers = [], cellSize = 128;
    for (const cover of covers) {
      const [x, y, width, height] = cover.bounds;
      const x1 = Math.floor(x! / cellSize), y1 = Math.floor(y! / cellSize);
      const x2 = Math.floor((x! + width!) / cellSize), y2 = Math.floor((y! + height!) / cellSize);
      if (![x1, y1, x2, y2].every(Number.isSafeInteger) || (x2 - x1 + 1) * (y2 - y1 + 1) > 64) { large.push(cover); continue; }
      for (let cx = x1; cx <= x2; cx++) for (let cy = y1; cy <= y2; cy++) {
        const key = `${cx},${cy}`, entries = grid.get(key) ?? [];
        entries.push(cover); grid.set(key, entries);
      }
    }
    for (let i = 0; i < layout.nodeIndex.length && covers.length; i++) {
      const node = layout.nodeIndex[i], bounds = rect(i), id = nodes.backendNodeId[node], paint = layout.paintOrders[i];
      // Shadows, outlines, filters or text strokes can paint beyond a layout
      // box, so containment of that box alone does not prove full coverage.
      if (!bounds || !Number.isFinite(paint) || visibility.get(id) !== true || !rootStack(node)
        || value(i, 7) !== "none" || value(i, 22) !== "none" || value(i, 23) !== "0px"
        || value(i, 37) !== "none" || value(i, 38) !== "none") continue;
      const name = strings[nodes.nodeName?.[node]] ?? "";
      const text = nodes.nodeType?.[node] === 3 || /^::(?:before|after|first-letter|marker)$/i.test(name);
      const x1 = Math.floor(bounds[0]! / cellSize), y1 = Math.floor(bounds[1]! / cellSize);
      const x2 = Math.floor((bounds[0]! + bounds[2]!) / cellSize), y2 = Math.floor((bounds[1]! + bounds[3]!) / cellSize);
      const candidates = new Set(large);
      if (![x1, y1, x2, y2].every(Number.isSafeInteger) || text && (x2 - x1 + 1) * (y2 - y1 + 1) > 64) {
        for (const cover of covers) candidates.add(cover);
      } else {
        for (let x = x1; x <= (text ? x2 : x1); x++) for (let y = y1; y <= (text ? y2 : y1); y++)
          for (const cover of grid.get(`${x},${y}`) ?? []) candidates.add(cover);
      }
      for (const cover of candidates) {
        if (cover.paint <= paint || !(text ? overlaps(cover.bounds, bounds) : contains(cover.bounds, bounds))) continue;
        // A container's background cannot cover its own descendants.
        let descendant = false;
        for (let parent = cover.node; parent >= 0; parent = nodes.parentIndex[parent]) if (parent === node) { descendant = true; break; }
        if (!descendant) { visibility.set(id, false); break; }
      }
    }
  }
}
