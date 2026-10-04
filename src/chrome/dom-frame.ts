/** Wait on the live side panel, rather than a potentially suspended child frame. */
export function waitForDocumentFrame(): Promise<void> {
  return new Promise((resolve) => {
    // Keep checks progressing if the panel itself is temporarily backgrounded.
    const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 50);
    const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
}
