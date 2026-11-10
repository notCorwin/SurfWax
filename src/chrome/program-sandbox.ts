import { programWorkerMain } from "./program-worker";
import { createProgramCodec } from "./program-codec";

/** Opaque-origin page hosting a disposable program worker. */
const initialize = (event: MessageEvent) => {
  if (
    event.source !== parent ||
    (!import.meta.env.DEV && event.origin !== new URL(location.href).origin) ||
    event.data?.type !== "surf-wax:program-init" ||
    event.data.token !== location.hash.slice(1) ||
    event.ports.length !== 1
  )
    return;
  window.removeEventListener("message", initialize);
  const port = event.ports[0]!;
  const blob = new Blob([`(${programWorkerMain.toString()})(${createProgramCodec.toString()})`], {
    type: "text/javascript",
  });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { name: "surf-wax-program" });
  URL.revokeObjectURL(url);
  const cleanup = () => {
    worker.terminate();
    port.close();
  };
  worker.onmessage = (reply) => port.postMessage(reply.data);
  worker.onerror = (error) =>
    port.postMessage({ type: "failed", error: { message: error.message } });
  port.onmessage = (request) => {
    if (request.data?.type === "dispose") cleanup();
    else worker.postMessage(request.data);
  };
  port.start();
  port.postMessage({ type: "ready" });
};
window.addEventListener("message", initialize);
