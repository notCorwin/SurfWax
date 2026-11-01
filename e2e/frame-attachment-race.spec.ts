import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

test("operates on a replacement OOPIF after repeated attachment and removal", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const url = `${provider.origin.replace("127.0.0.1", "localhost")}/frame`;
    await target.evaluate((frameUrl) => {
      const button = document.createElement("button"); button.id = "replace-frames"; button.textContent = "Replace frames";
      const status = document.createElement("output"); status.id = "replacement-status"; status.textContent = "waiting";
      button.onclick = async () => {
        for (let i = 0; i < 8; i++) {
          const frame = document.createElement("iframe"); frame.src = `${frameUrl}?old=${i}`;
          document.body.append(frame); await new Promise((resolve) => setTimeout(resolve, 0)); frame.remove();
        }
        const frame = document.createElement("iframe"); frame.id = "replacement"; frame.src = `${frameUrl}?new=1`;
        await new Promise<void>((resolve, reject) => { frame.onload = () => resolve(); frame.onerror = reject; document.body.append(frame); });
        status.textContent = "ready";
      };
      document.body.append(button, status);
    }, url);
    responses.push(
      commandResponse("click", { target: { by: "css", value: "#replace-frames" }, timeoutMs: 30_000 }, "replace-frames"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("verify_state", { target: { by: "css", value: "#replacement-status" }, textIncludes: "ready", timeoutMs: 30_000 }, "replacement-ready"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true } }); return commandResponse("click", { target: { by: "role", value: "button", name: "Frame action", frame: { by: "css", value: "#replacement" } } }, "click-replacement"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("list_frames", {}, "frames-after-replace"); },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ total: 2, frames: expect.any(Array) });
        expect(result.frames.some((frame: any) => frame.url.includes("old="))).toBe(false);
        expect(result.frames.some((frame: any) => frame.url.includes("new=1"))).toBe(true);
        return textResponse("FRAME_ATTACHMENT_RACE_OK");
      },
      textResponse("框架重建"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Replace frames and click the final action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_ATTACHMENT_RACE_OK", { timeout: 45000 });
    await expect(target.frameLocator("#replacement").locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("observes and operates on the same iframe after repeated process swaps", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const crossUrl = `${provider.origin.replace("127.0.0.1", "localhost")}/frame`;
    await target.evaluate(({ same, cross }) => {
      const button = document.createElement("button"); button.id = "swap-frames"; button.textContent = "Swap frame process";
      const status = document.createElement("output"); status.id = "swap-status"; status.textContent = "waiting";
      button.onclick = async () => {
        document.querySelectorAll("iframe").forEach((frame) => frame.remove());
        const frame = document.createElement("iframe"); frame.id = "switching-frame"; document.body.appendChild(frame);
        for (let i = 0; i < 4; i++) for (const url of [same, cross]) {
          await new Promise<void>((resolve, reject) => { frame.onload = () => resolve(); frame.onerror = reject; frame.src = `${url}?swap=${i}`; });
        }
        status.textContent = "swapped";
      };
      document.body.append(button, status);
    }, { same: `${provider.origin}/same-frame`, cross: crossUrl });
    responses.push(
      commandResponse("click", { target: { by: "css", value: "#swap-frames" }, timeoutMs: 30_000 }, "swap-frame-process"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return commandResponse("verify_state", { target: { by: "css", value: "#swap-status" }, textIncludes: "swapped", timeoutMs: 30_000 }, "swaps-ready"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: { verified: true } }); return commandResponse("list_frames", {}, "frames-after-swaps"); },
      (request) => {
        const result = lastTool(request);
        expect(result, JSON.stringify(result)).toMatchObject({ total: 2, frames: expect.any(Array) });
        expect(result.frames.some((frame: any) => frame.url.includes("swap=3") && frame.url.includes("localhost"))).toBe(true);
        return commandResponse("click", { target: { by: "role", value: "button", name: "Frame action", frame: { by: "css", value: "#switching-frame" } } }, "click-after-swaps");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("FRAME_PROCESS_SWAP_OK"); },
      textResponse("框架进程切换"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Navigate the iframe between processes and click its final action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_PROCESS_SWAP_OK", { timeout: 45000 });
    await expect(target.frameLocator("#switching-frame").locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
