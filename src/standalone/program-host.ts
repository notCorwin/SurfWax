import { Worker } from "node:worker_threads";
import { executeProgramWithTransport, type ProgramHostState } from "../chrome/program-host";
import { programWorkerMain } from "../chrome/program-worker";
import { createProgramCodec } from "../chrome/program-codec";

/** Reuse the browser worker protocol, with hard termination on cancellation. */
export async function executeNodeProgram(code: string, capabilities: Record<string, unknown>, signal: AbortSignal,
  onState?: (state: ProgramHostState) => void): Promise<unknown> {
  signal.throwIfAborted();
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = {
      postMessage: value => parentPort.postMessage(value),
      addEventListener: (name, listener) => {
        if (name === 'unhandledrejection') process.on('unhandledRejection', reason => listener({ reason, preventDefault() {} }));
      },
      close: () => process.exit(0),
    };
    (${programWorkerMain.toString()})(${createProgramCodec.toString()});
    parentPort.on('message', data => self.onmessage({ data }));
    parentPort.postMessage({ type: 'ready' });
  `, { eval: true });
  let closed = false;
  const port = {
    onmessage: null as MessagePort["onmessage"],
    postMessage(value: unknown) { if (!closed && (value as any)?.type !== "dispose") worker.postMessage(value); },
    close() {}, start() {},
  };
  const receive = (data: unknown) => port.onmessage?.call(port as unknown as MessagePort, { data } as MessageEvent);
  worker.on("message", receive);
  worker.on("error", error => receive({ type: "failed", error: { message: error instanceof Error ? error.message : String(error) } }));
  worker.on("exit", code => { if (!closed) receive({ type: "failed", error: { message: `Program worker exited (${code})` } }); });
  return executeProgramWithTransport(code, capabilities, signal, onState, {
    port, start() {}, close() { closed = true; void worker.terminate(); },
  });
}
