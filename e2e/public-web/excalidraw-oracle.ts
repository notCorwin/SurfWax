/** Validate the exported graph; external provenance and restore evidence must be checked separately. */
export function checkExcalidrawGraph(input: unknown, stage: 1 | 2): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || (input as { type?: unknown }).type !== 'excalidraw' || !Array.isArray((input as { elements?: unknown }).elements)) return ['Invalid Excalidraw document'];
  const elements = (input as { elements: Record<string, any>[] }).elements.filter(e => e && !e.isDeleted);
  const names = ['用户请求', '浏览器操作', '观察', '验证', ...(stage === 2 ? ['完成'] : [])];
  const nodes = new Map<string, Record<string, any>>();
  for (const name of names) {
    const matches = elements.filter(e => e.type === 'text' && (e.text === name || e.originalText === name));
    if (matches.length !== 1) errors.push(`Expected one live text element: ${name}`);
    else nodes.set(name, matches[0]);
  }
  const endpoint = (name: string) => { const node = nodes.get(name); return node?.containerId || node?.id; };
  const edges = [['用户请求', '浏览器操作'], ['浏览器操作', '观察'], ['观察', '验证'], ['验证', '浏览器操作'], ...(stage === 2 ? [['验证', '完成']] : [])];
  for (const [from, to] of edges) {
    const source = endpoint(from), target = endpoint(to);
    if (!source || !target || !elements.some(e => e.type === 'arrow' && e.startBinding?.elementId === source && e.endBinding?.elementId === target && e.endArrowhead && !e.startArrowhead)) errors.push(`Missing directed bound arrow: ${from} -> ${to}`);
  }
  return errors;
}
