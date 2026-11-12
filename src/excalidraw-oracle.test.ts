import { describe, expect, it } from 'vitest';
import { checkExcalidrawGraph } from '../e2e/public-web/excalidraw-oracle';

describe('Excalidraw graph oracle', () => {
  const names = ['用户请求', '浏览器操作', '观察', '验证', '完成'];
  const nodes = names.map((text, i) => ({ id: String(i), type: 'text', text }));
  const arrow = (a: number, b: number) => ({ type: 'arrow', startBinding: { elementId: String(a) }, endBinding: { elementId: String(b) }, endArrowhead: 'arrow' });
  const doc = { type: 'excalidraw', elements: [...nodes, arrow(0,1), arrow(1,2), arrow(2,3), arrow(3,1), arrow(3,4)] };
  it('requires live nodes and correctly directed bound arrows', () => {
    expect(checkExcalidrawGraph(doc, 2)).toEqual([]);
    expect(checkExcalidrawGraph({ ...doc, elements: doc.elements.filter((_, i) => i !== 8) }, 2)).not.toEqual([]);
    expect(checkExcalidrawGraph({ ...doc, elements: doc.elements.map((e, i) => i === 4 ? { ...e, isDeleted: true } : e) }, 2)).not.toEqual([]);
    expect(checkExcalidrawGraph({}, 1)).not.toEqual([]);
  });
});
