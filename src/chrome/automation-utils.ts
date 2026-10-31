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

/** Only transient CDP execution-context errors are safe to retry on navigation. */
export function isTransientNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /execution context (?:was destroyed|is not available)|cannot find (?:default )?(?:execution )?context(?: with specified id)?/i.test(message);
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

// Chromium's Mac keyboard injection requires explicit editor commands. The
// mappings are adapted from Playwright, Copyright Microsoft Corporation,
// Apache-2.0 (see public/third-party/playwright). Pages can cancel keydown.
const macCommands: Record<number, Record<string, string | string[]>> = {
  0: { Backspace: "deleteBackward", Delete: "deleteForward", Escape: "cancelOperation", ArrowUp: "moveUp", ArrowDown: "moveDown", ArrowLeft: "moveLeft", ArrowRight: "moveRight", F5: "complete", Home: "scrollToBeginningOfDocument", End: "scrollToEndOfDocument", PageUp: "scrollPageUp", PageDown: "scrollPageDown" },
  8: { Backspace: "deleteBackward", Delete: "deleteForward", Escape: "cancelOperation", ArrowUp: "moveUpAndModifySelection", ArrowDown: "moveDownAndModifySelection", ArrowLeft: "moveLeftAndModifySelection", ArrowRight: "moveRightAndModifySelection", F5: "complete", Home: "moveToBeginningOfDocumentAndModifySelection", End: "moveToEndOfDocumentAndModifySelection", PageUp: "pageUpAndModifySelection", PageDown: "pageDownAndModifySelection", Numpad5: "delete" },
  2: { Tab: "selectNextKeyView", KeyA: "moveToBeginningOfParagraph", KeyB: "moveBackward", KeyD: "deleteForward", KeyE: "moveToEndOfParagraph", KeyF: "moveForward", KeyH: "deleteBackward", KeyK: "deleteToEndOfParagraph", KeyL: "centerSelectionInVisibleArea", KeyN: "moveDown", KeyO: "moveBackward", KeyP: "moveUp", KeyT: "transpose", KeyV: "pageDown", KeyY: "yank", Backspace: "deleteBackwardByDecomposingPreviousCharacter", ArrowUp: "scrollPageUp", ArrowDown: "scrollPageDown", ArrowLeft: "moveToLeftEndOfLine", ArrowRight: "moveToRightEndOfLine" },
  10: { Tab: "selectPreviousKeyView", KeyA: "moveToBeginningOfParagraphAndModifySelection", KeyB: "moveBackwardAndModifySelection", KeyE: "moveToEndOfParagraphAndModifySelection", KeyF: "moveForwardAndModifySelection", KeyN: "moveDownAndModifySelection", KeyP: "moveUpAndModifySelection", KeyV: "pageDownAndModifySelection", Backspace: "deleteBackwardByDecomposingPreviousCharacter", ArrowUp: "scrollPageUp", ArrowDown: "scrollPageDown", ArrowLeft: "moveToLeftEndOfLineAndModifySelection", ArrowRight: "moveToRightEndOfLineAndModifySelection" },
  1: { Backspace: "deleteWordBackward", Delete: "deleteWordForward", Escape: "complete", ArrowUp: ["moveBackward", "moveToBeginningOfParagraph"], ArrowDown: ["moveForward", "moveToEndOfParagraph"], ArrowLeft: "moveWordLeft", ArrowRight: "moveWordRight", PageUp: "pageUp", PageDown: "pageDown" },
  9: { Backspace: "deleteWordBackward", Delete: "deleteWordForward", Escape: "complete", ArrowUp: "moveParagraphBackwardAndModifySelection", ArrowDown: "moveParagraphForwardAndModifySelection", ArrowLeft: "moveWordLeftAndModifySelection", ArrowRight: "moveWordRightAndModifySelection", PageUp: "pageUp", PageDown: "pageDown" },
  3: { KeyB: "moveWordBackward", KeyF: "moveWordForward", Backspace: "deleteWordBackward" },
  11: { KeyB: "moveWordBackwardAndModifySelection", KeyF: "moveWordForwardAndModifySelection", Backspace: "deleteWordBackward" },
  4: { NumpadSubtract: "cancel", Backspace: "deleteToBeginningOfLine", ArrowUp: "moveToBeginningOfDocument", ArrowDown: "moveToEndOfDocument", ArrowLeft: "moveToLeftEndOfLine", ArrowRight: "moveToRightEndOfLine", KeyA: "selectAll", KeyC: "copy", KeyX: "cut", KeyV: "paste", KeyZ: "undo" },
  12: { NumpadSubtract: "cancel", Backspace: "deleteToBeginningOfLine", ArrowUp: "moveToBeginningOfDocumentAndModifySelection", ArrowDown: "moveToEndOfDocumentAndModifySelection", ArrowLeft: "moveToLeftEndOfLineAndModifySelection", ArrowRight: "moveToRightEndOfLineAndModifySelection", KeyZ: "redo" },
};

export function macEditingCommands(code: string, modifiers: number, platform = globalThis.navigator?.platform ?? ""): string[] | undefined {
  if (!/Mac/i.test(platform)) return undefined;
  const command = macCommands[modifiers]?.[code];
  return command === undefined ? undefined : Array.isArray(command) ? [...command] : [command];
}

const KEY_ALIASES: Record<string, string> = { alt: "Alt", option: "Alt", control: "Control", ctrl: "Control", meta: "Meta", cmd: "Meta", command: "Meta", shift: "Shift", controlormeta: "ControlOrMeta" };
const PUNCTUATION_KEYS: Record<string, [string, number]> = {
  "-": ["Minus", 189], "_": ["Minus", 189], "=": ["Equal", 187], "+": ["Equal", 187],
  "[": ["BracketLeft", 219], "{": ["BracketLeft", 219], "]": ["BracketRight", 221], "}": ["BracketRight", 221],
  "\\": ["Backslash", 220], "|": ["Backslash", 220], ";": ["Semicolon", 186], ":": ["Semicolon", 186],
  "'": ["Quote", 222], '"': ["Quote", 222], "`": ["Backquote", 192], "~": ["Backquote", 192],
  ",": ["Comma", 188], "<": ["Comma", 188], ".": ["Period", 190], ">": ["Period", 190], "/": ["Slash", 191], "?": ["Slash", 191],
};
for (const [index, character] of [...")!@#$%^&*("].entries()) PUNCTUATION_KEYS[character] = [`Digit${index}`, 48 + index];

export function parseKeyboardChord(chord: string): { key: string; modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> } {
  // A trailing plus is the key itself, not an empty key after a separator.
  const literalPlus = chord === "+" || chord.endsWith("++");
  const parts = literalPlus ? (chord === "+" ? [] : chord.slice(0, -2).split("+")) : chord.split("+");
  const requested = literalPlus ? "+" : parts.pop() ?? "";
  const modifiers = parts.map((part) => {
    const modifier = KEY_ALIASES[part.toLowerCase()];
    if (!modifier) throw new Error(`AutomationError[invalid-key]: Unknown chord modifier ${JSON.stringify(part)}`);
    return (modifier === "ControlOrMeta" ? (modifierMask([modifier]) === 4 ? "Meta" : "Control") : modifier) as "Alt" | "Control" | "Meta" | "Shift";
  });
  if (new Set(modifiers).size !== modifiers.length) throw new Error("AutomationError[invalid-key]: Duplicate chord modifier");
  if (!requested) throw new Error("AutomationError[invalid-key]: A chord must include a key");
  const named = KEY_ALIASES[requested.toLowerCase()] ?? requested;
  const key = named === "Space" ? " " : named === "ControlOrMeta" ? (modifierMask([named]) === 4 ? "Meta" : "Control") : named;
  if (modifiers.some((modifier) => modifier === key)) throw new Error("AutomationError[invalid-key]: Duplicate chord modifier");
  return { key, modifiers };
}

export function keyboardParams(chord: string): Record<string, unknown> {
  const { key, modifiers: modifiersList } = parseKeyboardChord(chord);
  const modifierKeys: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const modifiers = modifierMask(modifiersList) | (modifierKeys[key] ?? 0);
  const code = key === " " ? "Space" : ["Alt", "Control", "Shift", "Meta"].includes(key) ? `${key}Left` : PUNCTUATION_KEYS[key]?.[0] ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key.length === 1 && /\d/.test(key) ? `Digit${key}` : key);
  const virtualKeys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Alt: 18, Control: 17, Shift: 16, Meta: 91, " ": 32 };
  return { key, code, modifiers, windowsVirtualKeyCode: virtualKeys[key] ?? PUNCTUATION_KEYS[key]?.[1] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0), ...(key.length === 1 && !(modifiers & 7) ? { text: key } : key === "Enter" ? { text: "\r" } : {}) };
}
