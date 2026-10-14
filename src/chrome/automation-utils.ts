export function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

export function signalError(signal: AbortSignal): unknown {
  const reason = signal.reason;
  return reason && typeof reason === "object" && "name" in reason && typeof reason.name === "string" ? reason : abortError();
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signalError(signal);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signalError(signal)); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function axValue(value: unknown): string {
  const resolved = value && typeof value === "object" && "value" in value ? value.value : undefined;
  return typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean" ? String(resolved) : "";
}

export function quote(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function jpegSize(base64: string): { width: number; height: number } | undefined {
  const binary = atob(base64);
  for (let offset = 2; offset + 8 < binary.length;) {
    if (binary.charCodeAt(offset) !== 0xff) { offset += 1; continue; }
    const marker = binary.charCodeAt(offset + 1);
    const length = binary.charCodeAt(offset + 2) * 256 + binary.charCodeAt(offset + 3);
    if (marker >= 0xc0 && marker <= 0xc3) return {
      height: binary.charCodeAt(offset + 5) * 256 + binary.charCodeAt(offset + 6),
      width: binary.charCodeAt(offset + 7) * 256 + binary.charCodeAt(offset + 8),
    };
    offset += Math.max(2, length + 2);
  }
}

export function imageSize(base64: string, format: string): { width: number; height: number } | undefined {
  if (format === "jpeg") return jpegSize(base64);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  if (format === "png" && bytes.length >= 24) { const view = new DataView(bytes.buffer); return { width: view.getUint32(16), height: view.getUint32(20) }; }
  if (format === "webp" && bytes.length >= 30 && binary.slice(12, 16) === "VP8X") return { width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
}

export function modifierMask(parts: string[]): number {
  return parts.reduce((mask, part) => mask | (part === "ControlOrMeta" ? (/Mac/.test(globalThis.navigator?.platform ?? "") ? 4 : 2) : /alt/i.test(part) ? 1 : /control/i.test(part) ? 2 : /meta/i.test(part) ? 4 : /shift/i.test(part) ? 8 : 0), 0);
}

export function keyboardParams(chord: string): Record<string, unknown> {
  const parts = chord.split("+"); const requested = parts.pop() || "";
  const key = requested === "Space" ? " " : requested;
  const modifierKeys: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const modifiers = modifierMask(parts) | (modifierKeys[key] ?? 0);
  const code = key === " " ? "Space" : ["Alt", "Control", "Shift", "Meta"].includes(key) ? `${key}Left` : key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key.length === 1 && /\d/.test(key) ? `Digit${key}` : key;
  const virtualKeys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Alt: 18, Control: 17, Shift: 16, Meta: 91, " ": 32 };
  return { key, code, modifiers, windowsVirtualKeyCode: virtualKeys[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0), ...(key.length === 1 && !(modifiers & 7) ? { text: key } : key === "Enter" ? { text: "\r" } : {}) };
}
