// The document is intentionally empty: ChromeExecutor reaches it through CDP.
globalThis.addEventListener("unhandledrejection", (event) => console.error("Surf Wax offscreen host", event.reason));
