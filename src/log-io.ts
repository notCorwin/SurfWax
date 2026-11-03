import { createDeadline } from './deadline';

export const LOG_IO_TIMEOUT_MS = 10_000;

/** Persistence failures are fatal: never claim a browser effect has a durable receipt. */
export class LogIOError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`事件日志${operation}未完成；已停止后续操作。请检查存储并重新打开侧栏。`, { cause });
    this.name = 'LogIOError';
  }
}

export async function logIO<T>(work: PromiseLike<T>, operation: string, timeoutMs = LOG_IO_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  const deadline = createDeadline(timeoutMs, signal, `Canonical log ${operation}`);
  try { return await deadline.wait(work); }
  catch (error) {
    if (signal?.aborted && signal.reason instanceof DOMException && signal.reason.name === 'AbortError') throw signal.reason;
    if (deadline.signal.aborted) throw new LogIOError(operation, error);
    throw error;
  } finally { deadline.dispose(); }
}
