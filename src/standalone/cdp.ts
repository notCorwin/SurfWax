/** A bounded flattened CDP connection; no extension or global chrome shim. */
export class CdpConnection {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly listeners = new Set<(message: any) => void>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`CDP: ${message.error.message}`));
        else request.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener("close", () => this.fail(new Error("Chrome disconnected; reconnect the standalone tool runtime.")));
    socket.addEventListener("error", () => this.fail(new Error("Chrome CDP connection failed.")));
  }
  static async connect(endpoint: string): Promise<CdpConnection> {
    if (!/^wss?:/.test(endpoint)) {
      const response = await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Chrome CDP discovery failed: HTTP ${response.status}`);
      endpoint = (await response.json()).webSocketDebuggerUrl;
    }
    const socket = new WebSocket(endpoint);
    const connection = new CdpConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Chrome CDP connection timed out; start Chrome with --remote-debugging-port.")); }, 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Cannot connect to Chrome CDP; check the endpoint and --remote-debugging-port.")); }, { once: true });
    });
    return connection;
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome CDP connection is closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out after 40 seconds.`)); }, 40_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  close() { this.fail(new Error("Standalone runtime closed.")); this.socket.close(); }
}
