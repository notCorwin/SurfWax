import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, configure, readEvents, dispose, type MockResponse } from "./fixtures";

function lastTool(request: any) {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

for (const nestedOrigin of ["cross-process", "same-process"] as const) test(`waits for each embedding frame with a ${nestedOrigin} nested frame`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const outer = target.frameLocator('iframe[src*=localhost]');
    await outer.getByRole("button", { name: "Frame action" }).waitFor();
    await outer.locator("body").evaluate((body, url) => {
      const frame = document.createElement("iframe");
      frame.id = "nested";
      frame.src = url;
      body.append(frame);
      const cover = document.createElement("div");
      cover.id = "inner-cover";
      cover.style.cssText = "position:fixed;inset:0;z-index:2147480000";
      cover.onclick = () => { body.dataset.coverClicked = "yes"; };
      body.append(cover);
    }, `${nestedOrigin === "same-process" ? provider.origin.replace("127.0.0.1", "localhost") : provider.origin}/frame`);
    const inner = outer.frameLocator("#nested");
    await inner.getByRole("button", { name: "Frame action" }).waitFor();
    await target.evaluate(() => {
      const cover = document.createElement("div");
      cover.id = "parent-cover";
      cover.style.cssText = "position:fixed;inset:0;z-index:2147480000";
      cover.onclick = () => { document.body.dataset.coverClicked = "yes"; };
      document.body.append(cover);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    let completed: any;
    const poll: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) { completed = job; return textResponse("FRAME_CLICK_DONE"); }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId: job.jobId, after: job.nextCursor, limit: 1, waitMs: 10000 }, "frame-poll");
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 20000, code: `
await page.frameLocator('iframe[src*=localhost]').frameLocator('#nested').getByRole('button', { name: 'Frame action' }).click();
return 'clicked';` }, "frame-click"), (request) => {
      const job = lastTool(request);
      if (job.state === "blocked") {
        responses.unshift(poll);
        return commandResponse("get_job", { jobId: job.jobId, limit: 1, waitMs: 10000 }, "frame-first-poll");
      }
      completed = job;
      return textResponse("FRAME_CLICK_DONE");
    });
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click Frame action");
    await opened.page.getByTestId("composer-input").press("Enter");
    const intercepted = async () => (await readEvents(opened.page)).filter((event) => event.type === "automation.action.attempt" && event.content.reason === "intercepted").length;
    await expect.poll(intercepted, { timeout: 10000 }).toBeGreaterThan(0);
    await expect(outer.locator("body")).not.toHaveAttribute("data-cover-clicked");
    await outer.locator("#inner-cover").evaluate((node) => node.remove());
    const previous = await intercepted();
    await expect.poll(intercepted, { timeout: 10000 }).toBeGreaterThan(previous);
    await expect(target.locator("body")).not.toHaveAttribute("data-cover-clicked");
    await expect(inner.locator("body")).not.toHaveAttribute("data-clicked");
    await target.locator("#parent-cover").evaluate((node) => node.remove());
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_CLICK_DONE", { timeout: 30000 });
    expect(completed).toMatchObject({ ok: true, result: "clicked" });
    await expect(inner.locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("waits for a parent overlay above a same-process frame", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const frame = target.frameLocator('iframe[src="/same-frame"]');
    await frame.locator("body").evaluate((body) => {
      const button = document.createElement("button");
      button.textContent = "Frame action";
      button.onclick = () => { body.dataset.clicked = "yes"; };
      body.append(button);
    });
    await target.evaluate(() => {
      const cover = document.createElement("div");
      cover.id = "parent-cover";
      cover.style.cssText = "position:fixed;inset:0;z-index:2147480000";
      cover.onclick = () => { document.body.dataset.coverClicked = "yes"; };
      document.body.append(cover);
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    let completed: any;
    const poll: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) { completed = job; return textResponse("FRAME_CLICK_DONE"); }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId: job.jobId, after: job.nextCursor, limit: 1, waitMs: 10000 }, "same-poll");
    };
    responses.push(commandResponse("execute_program", { timeoutMs: 20000, code: `
await page.frameLocator('iframe[src="/same-frame"]').getByRole('button', { name: 'Frame action' }).click();
return 'clicked';` }, "same-click"), (request) => {
      const job = lastTool(request);
      if (job.state === "blocked") { responses.unshift(poll); return commandResponse("get_job", { jobId: job.jobId, limit: 1, waitMs: 10000 }, "same-first-poll"); }
      completed = job;
      return textResponse("FRAME_CLICK_DONE");
    });
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Click Frame action");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "automation.action.attempt" && event.content.reason === "intercepted"), { timeout: 10000 }).toBe(true);
    await expect(target.locator("body")).not.toHaveAttribute("data-cover-clicked");
    await expect(frame.locator("body")).not.toHaveAttribute("data-clicked");
    await target.locator("#parent-cover").evaluate((node) => node.remove());
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_CLICK_DONE", { timeout: 30000 });
    expect(completed).toMatchObject({ ok: true, result: "clicked" });
    await expect(frame.locator("body")).toHaveAttribute("data-clicked", "yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
