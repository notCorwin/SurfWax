/** Chrome extension ports use JSON serialization, which discards Error properties. */
export type BridgeError = { name: string; message: string; stack?: string; cause?: BridgeError };

export function encodeBridgeError(value: unknown, depth = 0): BridgeError {
  if (!(value instanceof Error)) return { name: "Error", message: String(value) };
  return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}),
    ...(depth < 4 && value.cause !== undefined ? { cause: encodeBridgeError(value.cause, depth + 1) } : {}) };
}

export function decodeBridgeError(value: BridgeError): Error {
  const error = new Error(value.message, value.cause ? { cause: decodeBridgeError(value.cause) } : undefined);
  error.name = value.name;
  if (value.stack) error.stack = value.stack;
  return error;
}
