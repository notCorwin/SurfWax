// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppErrorCapture } from "./error-notice";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test("render failures keep a reload action and full diagnostic detail", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const Throw = () => { throw new Error("render diagnostic"); };
  await act(async () => root.render(<AppErrorCapture><Throw /></AppErrorCapture>));
  expect(host.textContent).toContain("界面发生错误");
  expect(host.querySelector("button")?.textContent).toBe("重新加载");
  expect(host.querySelector(".app-error-detail")?.textContent).toContain("render diagnostic");
});

test("normal aborts are ignored while unhandled rejections are shown once", async () => {
  await act(async () => root.render(<AppErrorCapture><main>usable</main></AppErrorCapture>));
  const reject = (reason: unknown) => {
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: reason });
    window.dispatchEvent(event);
  };
  await act(async () => reject(new DOMException("stopped", "AbortError")));
  expect(host.querySelector(".app-error-notice")).toBeNull();
  await act(async () => { reject(new Error("unhandled diagnostic")); reject(new Error("unhandled diagnostic")); });
  expect(host.querySelectorAll(".app-error-notice")).toHaveLength(1);
  expect(host.textContent).toContain("usable");
  expect(host.querySelector(".app-error-detail")?.textContent).toContain("unhandled diagnostic");
});
