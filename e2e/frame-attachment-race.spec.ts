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
    responses.push(
      commandResponse("execute_program", { timeoutMs: 30000, code: `
await page.evaluate(async url => {
  for (let i = 0; i < 8; i++) {
    const frame = document.createElement('iframe'); frame.src = url + '?old=' + i;
    document.body.append(frame); await new Promise(resolve => setTimeout(resolve, 0)); frame.remove();
  }
  const frame = document.createElement('iframe'); frame.id = 'replacement'; frame.src = url + '?new=1';
  await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = reject; document.body.append(frame); });
}, ${JSON.stringify(url)});
await page.frameLocator('#replacement').getByRole('button', {name:'Frame action'}).click();
return 'clicked';` }, "replace-frames"),
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "clicked" }); return commandResponse("list_frames", {}, "frames-after-replace"); },
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
    responses.push(
      commandResponse("execute_program", { timeoutMs: 30000, code: `
await page.evaluate(async ({same, cross}) => {
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
  const frame = document.createElement('iframe');
  frame.id = 'switching-frame';
  document.body.appendChild(frame);
  for (let i = 0; i < 4; i++) {
    for (const url of [same, cross]) {
      await new Promise((resolve, reject) => {
        frame.onload = resolve;
        frame.onerror = reject;
        frame.src = url + '?swap=' + i;
      });
    }
  }
}, ${JSON.stringify({ same: `${provider.origin}/same-frame`, cross: crossUrl })});
return 'swapped';` }, "swap-frame-process"),
      (request) => { const result = lastTool(request); expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: "swapped" }); return commandResponse("list_frames", {}, "frames-after-swaps"); },
      (request) => {
        const result = lastTool(request);
        expect(result, JSON.stringify(result)).toMatchObject({ total: 2, frames: expect.any(Array) });
        expect(result.frames.some((frame: any) => frame.url.includes("swap=3") && frame.url.includes("localhost"))).toBe(true);
        return commandResponse("execute_program", { code: `await page.frameLocator('#switching-frame').getByRole('button', {name:'Frame action'}).click(); return 'clicked';` }, "click-after-swaps");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: "clicked" }); return textResponse("FRAME_PROCESS_SWAP_OK"); },
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
