import { expect, it, vi } from 'vitest';
import { EventLogger } from './logging';
import { LogIOError } from './log-io';

it('fails a hung writer fatally and refuses later effects instead of pretending a receipt exists', async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const append = vi.fn(() => new Promise<never>(() => {}));
  const logger = new EventLogger({ ioTimeoutMs: 20, onError, store: { append, all: async () => [] } });
  try {
    const writing = expect(logger.append({ type: 'tool.started' })).rejects.toBeInstanceOf(LogIOError);
    await vi.advanceTimersByTimeAsync(21);
    await writing;
    expect(onError).toHaveBeenCalledOnce();
    await expect(logger.append({ type: 'tool.finished' })).rejects.toBeInstanceOf(LogIOError);
    expect(append).toHaveBeenCalledOnce();
    await expect(logger.flush()).rejects.toBeInstanceOf(LogIOError);
  } finally { await logger.dispose().catch(() => {}); vi.useRealTimers(); }
});

it('bounds a canonical read whose storage request never returns', async () => {
  vi.useFakeTimers();
  const logger = new EventLogger({ ioTimeoutMs: 20, store: { append: async event => ({ ...event, id: 1 }), all: () => new Promise<never>(() => {}) } });
  try {
    const reading = expect(logger.summaryEvents()).rejects.toBeInstanceOf(LogIOError);
    await vi.advanceTimersByTimeAsync(21);
    await reading;
  } finally { await logger.dispose(); vi.useRealTimers(); }
});
