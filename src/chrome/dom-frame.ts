/** Wait on the live side panel, rather than a potentially suspended child frame. */
export function waitForDocumentFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return new Promise(resolve => setTimeout(resolve, 16));
  return new Promise((resolve) => {
    // Keep checks progressing if the panel itself is temporarily backgrounded.
    const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 50);
    const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
}
