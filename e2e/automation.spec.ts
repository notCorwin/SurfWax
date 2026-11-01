import { chromium, expect, type BrowserContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PROGRAM_CATALOG_VERSION } from "../src/chrome/tool";


import { test, p95, textResponse, assistantResponse, commandResponse, delayedResponse, startProvider, closeServer, openExtension, dispose, selectProvider, configure, themeColors, expectThemeButton, startNewConversation, nameCurrentConversation, enableUserScripts, readEvents, attachTarget, warnsOnLeave, nativePanel, submitNative, readNativeEvents, type MockResponse } from './fixtures';

test("selects large tool output without creating another reference", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  let artifactRef = 0;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => { const main = document.querySelector("main")!; main.textContent = "LARGE_START" + "zx".repeat(6000); main.style.display = "none"; });
    responses.push(
      commandResponse("read_text", { target: { by: "css", value: "main" } }, "call-large"),
      (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        const output = JSON.parse(message.content);
        expect(output.access.artifactId).toBe(output.$ref);
        artifactRef = output.$ref;
        return commandResponse("read_artifact", { ...output.access, limit: 11 }, "call-select-large");
      },
      textResponse("DONE_COMPACT"),
      textResponse("引用测试"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("inspect page contexts and a large result");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DONE_COMPACT");
    await expect.poll(() => provider.requests.filter((request) => request.tools).length).toBeGreaterThanOrEqual(3);
    const requests = provider.requests.filter((request) => request.tools);
    const secondPrompt = JSON.stringify(requests[1].messages);
    expect(secondPrompt).toContain("$ref");
    expect(secondPrompt).not.toContain("zx".repeat(2_100));
    expect(JSON.stringify(requests[2].messages)).toContain("LARGE_START");
    const events = await readEvents(opened.page);
    const data = events.find((event) => event.type === "tool.result.data");
    expect(data.output).toMatchObject({ result: "LARGE_START" + "zx".repeat(6000) });
    expect(artifactRef).toBe(data.id);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-select-large")?.output.result).toBe("LARGE_START");
    expect(events.filter((event) => event.type === "tool.result.data")).toHaveLength(1);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", {hasText:"引用测试"}).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DONE_COMPACT");
    await target.bringToFront();
    responses.push(commandResponse("read_artifact", { artifactId: data.id, path: ["result"], offset: 0, limit: 11 }, "read-after-reload"), textResponse("RESTORED_READ"));
    await opened.page.getByTestId("composer-input").fill("read the stored result in this restored conversation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RESTORED_READ");
    expect((await readEvents(opened.page)).find(event => event.type === "tool.finished" && event.toolCallId === "read-after-reload")?.output.result).toBe("LARGE_START");
    expect(await opened.page.evaluate(() => typeof (globalThis as any).__surfWaxResult)).toBe("undefined");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("inspects the page and fills and clicks with atomic tools", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/automation`);
    expect(tab?.id).toBeDefined();
    responses.push(
      commandResponse("inspect_page", {}, "call-snapshot"),
      commandResponse("fill", { target: { by: "label", value: "Email" }, value: "me@example.com" }, "call-fill"),
      commandResponse("click", { target: { by: "role", value: "button", name: "Sign in" } }, "call-click"),
      commandResponse("inspect_page", {}, "call-verify"),
      textResponse("PAGE_AUTOMATION_OK"),
      textResponse("页面自动化"),
    );
    const windowCount = await opened.page.evaluate(async () => (await chrome.windows.getAll()).length);
    await opened.page.getByTestId("composer-input").fill("use semantic page automation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PAGE_AUTOMATION_OK");
    const events = await readEvents(opened.page);
    const observation = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-snapshot")?.output;
    const clicked = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-click")?.output;
    const verified = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-verify")?.output;
    expect(observation.items).toEqual(expect.arrayContaining([expect.objectContaining({ ref: expect.stringMatching(/^t\d+s[a-f0-9]+d\d+e\d+$/) })]));
    expect(clicked.pageSnapshot.items).toEqual(expect.arrayContaining([expect.objectContaining({ line: expect.stringContaining("Welcome me@example.com") })]));
    expect(verified.items).toEqual(expect.arrayContaining([expect.objectContaining({ line: expect.stringContaining("Welcome me@example.com") })]));
    await expect.poll(() => target.locator("output").textContent()).toBe("Welcome me@example.com");
    expect(events.some((event) => event.type === "automation.action.finished" && event.toolCallId === "call-click")).toBe(true);
    const toolNames = provider.requests[0].tools.map((tool: any) => tool.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(["inspect_page", "fill", "click", "send_request"]));
    expect(toolNames).not.toContain("execute_program");
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames).not.toContain("run");
    expect(toolNames).not.toContain("inspect");
    expect(toolNames).not.toContain("jobs");
    expect(toolNames).not.toContain("browser");
    expect(toolNames.filter((name: string) => ["open", "attach", "close", "detach", "show", "list", "close-all", "kill-all"].includes(name))).toEqual([]);
    expect(await opened.page.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(windowCount);
    expect(provider.requests.filter((request) => request.tools)).toHaveLength(5);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("uploads a stored artifact through an independent tool", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "upload-target";
      input.onchange = async () => {
        const file = input.files?.[0];
        document.body.dataset.uploadedName = file?.name ?? "";
        document.body.dataset.uploadedContent = await file?.text() ?? "";
      };
      document.body.append(input);
    });
    responses.push(
      commandResponse("create_text_artifact", { filename: "report.txt", text: "hello from artifact", mimeType: "text/plain" }, "create-upload"),
      (request) => {
        const result = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
        return commandResponse("upload_file", { target: { by: "css", value: "#upload-target" }, artifactId: result.result.id }, "upload-artifact");
      },
      textResponse("ARTIFACT_UPLOAD_OK"), textResponse("上传产物"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("upload the created report");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("ARTIFACT_UPLOAD_OK");
    await expect.poll(() => target.locator("body").getAttribute("data-uploaded-content")).toBe("hello from artifact");
    expect(await target.locator("body").getAttribute("data-uploaded-name")).toBe("report.txt");
    expect((await readEvents(opened.page)).find((event) => event.toolCallId === "upload-artifact" && event.type === "tool.finished")?.output).toMatchObject({ ok: true });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("uploads multiple artifacts to a chooser across independent tool calls", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.hidden = true;
      input.onchange = async () => {
        const files = [...(input.files ?? [])];
        document.body.dataset.chooserNames = files.map((file) => file.name).join(",");
        document.body.dataset.chooserContents = (await Promise.all(files.map((file) => file.text()))).join(",");
      };
      const button = document.createElement("button");
      button.id = "open-chooser"; button.textContent = "Choose files";
      button.onclick = () => input.click();
      document.body.append(input, button);
    });
    let firstId = 0, secondId = 0, subscriptionId = "", jobId = "", pollCount = 0;
    const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) { expect(job).toMatchObject({ ok: true, state: "succeeded" }); return textResponse("CHOOSER_TOOLS_OK"); }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: job.nextCursor, waitMs: 10_000 }, `chooser-job-${++pollCount}`);
    };
    responses.push(
      commandResponse("create_text_artifact", { filename: "first.txt", text: "first" }, "chooser-artifact-one"),
      (request) => { firstId = lastTool(request).result.id; return commandResponse("create_text_artifact", { filename: "second.txt", text: "second" }, "chooser-artifact-two"); },
      (request) => { secondId = lastTool(request).result.id; return commandResponse("subscribe_event", { kind: "filechooser" }, "subscribe-chooser"); },
      (request) => { subscriptionId = lastTool(request).subscriptionId; return commandResponse("click", { target: { by: "css", value: "#open-chooser" }, background: true, timeoutMs: 30_000 }, "open-chooser"); },
      (request) => { jobId = lastTool(request).jobId; return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "wait-chooser"); },
      (request) => {
        const event = lastTool(request).events.find((item: any) => item.kind === "filechooser");
        expect(event.payload).toMatchObject({ mode: "selectMultiple", chooserId: expect.any(String) });
        return commandResponse("upload_file", { chooserId: event.payload.chooserId, artifactId: [firstId, secondId] }, "answer-chooser");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ state: "completed", artifactIds: [firstId, secondId] }); return commandResponse("get_job", { jobId }, "read-chooser-job"); },
      poll, textResponse("选择文件"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("upload the two files");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHOOSER_TOOLS_OK", { timeout: 30_000 });
    await expect.poll(() => target.locator("body").getAttribute("data-chooser-contents")).toBe("first,second");
    expect(await target.locator("body").getAttribute("data-chooser-names")).toBe("first.txt,second.txt");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.toolCallId === "answer-chooser" && event.type === "tool.finished")?.output).toMatchObject({ state: "completed", artifactIds: [firstId, secondId] });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("resumes a chooser upload whose change handler opens a dialog", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    target.on("dialog", () => {});
    await target.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file"; input.hidden = true;
      input.onchange = () => { document.body.dataset.uploadAnswer = prompt("Upload confirmation?") ?? "cancelled"; document.body.dataset.uploadName = input.files?.[0]?.name; };
      const button = document.createElement("button");
      button.id = "chooser-dialog"; button.textContent = "Choose"; button.onclick = () => input.click();
      document.body.append(input, button);
    });
    let artifactId = 0, subscriptionId = "", clickJobId = "", uploadJobId = "", pollCount = 0;
    const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const pollClick: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) { expect(job).toMatchObject({ ok: true, state: "succeeded" }); return textResponse("CHOOSER_DIALOG_OK"); }
      responses.unshift(pollClick);
      return commandResponse("get_job", { jobId: clickJobId, after: job.nextCursor, waitMs: 10_000 }, `chooser-dialog-click-${++pollCount}`);
    };
    const pollUpload: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) {
        expect(job).toMatchObject({ ok: true, state: "succeeded" });
        responses.unshift(pollClick);
        return commandResponse("get_job", { jobId: clickJobId }, "chooser-dialog-click-job");
      }
      responses.unshift(pollUpload);
      return commandResponse("get_job", { jobId: uploadJobId, after: job.nextCursor, waitMs: 10_000 }, `chooser-dialog-upload-${++pollCount}`);
    };
    responses.push(
      commandResponse("create_text_artifact", { filename: "confirmation.txt", text: "data" }, "dialog-artifact"),
      (request) => { artifactId = lastTool(request).result.id; return commandResponse("subscribe_event", { kind: "filechooser" }, "dialog-chooser-subscribe"); },
      (request) => { subscriptionId = lastTool(request).subscriptionId; return commandResponse("click", { target: { by: "css", value: "#chooser-dialog" }, background: true, timeoutMs: 30_000 }, "dialog-chooser-click"); },
      (request) => { clickJobId = lastTool(request).jobId; return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "dialog-chooser-wait"); },
      (request) => { const event = lastTool(request).events.find((item: any) => item.kind === "filechooser"); return commandResponse("upload_file", { chooserId: event.payload.chooserId, artifactId, timeoutMs: 30_000 }, "dialog-chooser-upload"); },
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ accepted: true, complete: false, state: "blocked", blockedBy: { kind: "dialog", type: "prompt", message: "Upload confirmation?" } });
        uploadJobId = result.jobId;
        expect(uploadJobId).toBeTruthy();
        return commandResponse("handle_dialog", { dialogId: result.blockedBy.dialogId, accept: true, prompt: "yes" }, "dialog-chooser-answer");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ state: "completed" }); return commandResponse("get_job", { jobId: uploadJobId }, "chooser-dialog-upload-job"); },
      pollUpload,
      textResponse("上传并确认"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("upload the file and confirm the prompt");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHOOSER_DIALOG_OK", { timeout: 30_000 });
    expect(await target.locator("body").getAttribute("data-upload-answer")).toBe("yes");
    expect(await target.locator("body").getAttribute("data-upload-name")).toBe("confirmation.txt");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("uploads to a cross-origin frame chooser through its captured session", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const frame = target.frames().find((item) => item.url().includes("localhost"))!;
    await frame.evaluate(() => {
      const input = document.createElement("input"); input.type = "file"; input.hidden = true;
      input.onchange = async () => { document.body.dataset.uploaded = await input.files?.[0]?.text() ?? ""; };
      const button = document.createElement("button"); button.id = "frame-chooser"; button.textContent = "Choose file";
      button.onclick = () => input.click(); document.body.append(input, button);
    });
    let artifactId = 0, subscriptionId = "", jobId = "", sequence = 0;
    const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) { expect(job).toMatchObject({ ok: true, state: "succeeded" }); return textResponse("FRAME_CHOOSER_OK"); }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: job.nextCursor, waitMs: 10_000 }, `frame-job-${++sequence}`);
    };
    responses.push(
      commandResponse("create_text_artifact", { filename: "frame.txt", text: "frame contents" }, "frame-artifact"),
      (request) => { artifactId = lastTool(request).result.id; return commandResponse("subscribe_event", { kind: "filechooser" }, "frame-subscribe"); },
      (request) => { subscriptionId = lastTool(request).subscriptionId; return commandResponse("click", { target: { by: "css", value: "#frame-chooser", frame: { by: "css", value: "iframe[src*=localhost]" } }, background: true, timeoutMs: 30_000 }, "frame-chooser-click"); },
      (request) => { jobId = lastTool(request).jobId; return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "frame-chooser-event"); },
      (request) => {
        const event = lastTool(request).events.find((item: any) => item.kind === "filechooser");
        expect(event.source.sessionId).toEqual(expect.any(String));
        return commandResponse("upload_file", { chooserId: event.payload.chooserId, artifactId }, "frame-chooser-upload");
      },
      (request) => { expect(lastTool(request)).toMatchObject({ state: "completed", artifactIds: [artifactId] }); return commandResponse("get_job", { jobId }, "frame-job"); },
      poll, textResponse("跨帧上传"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("upload the frame file");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_CHOOSER_OK", { timeout: 30_000 });
    await expect.poll(() => frame.locator("body").getAttribute("data-uploaded")).toBe("frame contents");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("reads and sets ARIA checked state without toggling an already satisfied control", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const toggle = document.createElement("button");
      toggle.id = "aria-switch";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", "true");
      toggle.textContent = "Notifications";
      toggle.onclick = () => {
        document.body.dataset.switchClicks = String(Number(document.body.dataset.switchClicks ?? 0) + 1);
        toggle.setAttribute("aria-checked", toggle.getAttribute("aria-checked") === "true" ? "false" : "true");
      };
      const radio = document.createElement("input");
      radio.id = "selected-radio";
      radio.type = "radio";
      radio.checked = true;
      const invalid = document.createElement("button");
      invalid.id = "unknown-switch";
      invalid.setAttribute("role", "switch");
      invalid.textContent = "Unknown state";
      invalid.onclick = () => { document.body.dataset.invalidClicks = "yes"; };
      document.body.append(toggle, radio, invalid);
    });
    const toggle = { by: "css", value: "#aria-switch" };
    responses.push(
      commandResponse("read_checked", { target: toggle }, "read-initial"),
      commandResponse("set_checked", { target: toggle, checked: true }, "already-checked"),
      commandResponse("set_checked", { target: toggle, checked: false }, "uncheck-switch"),
      commandResponse("read_checked", { target: toggle }, "read-final"),
      commandResponse("set_checked", { target: { by: "css", value: "#selected-radio" }, checked: false }, "uncheck-radio"),
      commandResponse("set_checked", { target: { by: "css", value: "#unknown-switch" }, checked: true }, "unknown-switch"),
      textResponse("CHECKED_STATE_OK"), textResponse("勾选状态"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("check and update the controls");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHECKED_STATE_OK");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.toolCallId === "read-initial" && event.type === "tool.finished")?.output.result).toBe(true);
    expect(events.find((event) => event.toolCallId === "read-final" && event.type === "tool.finished")?.output.result).toBe(false);
    expect(events.find((event) => event.toolCallId === "uncheck-radio" && event.type === "tool.failed")?.output.error.code).toBe("invalid-state");
    expect(events.find((event) => event.toolCallId === "unknown-switch" && event.type === "tool.failed")?.output.error.code).toBe("invalid-checked-state");
    expect(await target.locator("body").getAttribute("data-switch-clicks")).toBe("1");
    expect(await target.locator("body").getAttribute("data-invalid-clicks")).toBeNull();
    expect(await target.locator("#selected-radio").isChecked()).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("handles a dialog raised by a background atomic click across tool calls", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    target.on("dialog", () => {});
    await target.evaluate(() => {
      const button = document.createElement("button");
      button.id = "open-dialog";
      button.textContent = "Open prompt";
      button.onclick = () => { document.body.dataset.answer = prompt("Your answer?", "default") ?? "cancelled"; };
      document.body.append(button);
    });
    let subscriptionId = "";
    let jobId = "";
    let pollCount = 0;
    const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) {
        expect(job).toMatchObject({ ok: true, state: "succeeded" });
        return textResponse("DIALOG_TOOLS_OK");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: job.nextCursor, waitMs: 10_000 }, `wait-job-${++pollCount}`);
    };
    responses.push(
      commandResponse("subscribe_event", { kind: "dialog" }, "subscribe-dialog"),
      (request) => {
        subscriptionId = lastTool(request).subscriptionId;
        expect(subscriptionId).toBeTruthy();
        return commandResponse("click", { target: { by: "css", value: "#open-dialog" }, background: true, timeoutMs: 30_000 }, "background-click");
      },
      (request) => {
        const job = lastTool(request);
        expect(job).toMatchObject({ accepted: true, complete: false });
        jobId = job.jobId;
        return assistantResponse({ tool_calls: [
          { id: "blocked-read", type: "function", function: { name: "inspect_page", arguments: "{}" } },
          { id: "wait-dialog", type: "function", function: { name: "wait_event", arguments: JSON.stringify({ subscriptionId, waitMs: 10_000 }) } },
        ] });
      },
      (request) => {
        const blocked = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool" && entry.tool_call_id === "blocked-read").content);
        expect(blocked).toMatchObject({ ok: false, error: { code: "background-job-pending" } });
        const observed = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool" && entry.tool_call_id === "wait-dialog").content);
        const event = observed.events.find((item: any) => item.kind === "dialog");
        expect(event.payload).toMatchObject({ type: "prompt", message: "Your answer?" });
        return commandResponse("handle_dialog", { dialogId: event.payload.dialogId, accept: true, prompt: "confirmed" }, "answer-dialog");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ accepted: true, state: "completed" });
        return commandResponse("get_job", { jobId }, "read-job");
      },
      poll,
      textResponse("处理对话框"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("open the prompt and enter confirmed");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DIALOG_TOOLS_OK", { timeout: 30_000 });
    expect(await target.locator("body").getAttribute("data-answer")).toBe("confirmed");
    const events = await readEvents(opened.page);
    for (const id of ["subscribe-dialog", "background-click", "wait-dialog", "answer-dialog"]) {
      expect(events.filter((event) => event.toolCallId === id && ["tool.finished", "tool.failed"].includes(event.type))).toHaveLength(1);
    }
    expect(events.find((event) => event.toolCallId === "blocked-read" && event.type === "tool.failed")?.output.error.code).toBe("background-job-pending");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("hands a foreground click blocked by a dialog to a resumable job", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    target.on("dialog", () => {});
    await target.evaluate(() => {
      const button = document.createElement("button");
      button.id = "foreground-dialog";
      button.textContent = "Open prompt";
      button.onclick = () => { document.body.dataset.answer = prompt("Foreground answer?") ?? "cancelled"; };
      document.body.append(button);
    });
    let jobId = "";
    let polls = 0;
    const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
    const poll: MockResponse = (request) => {
      const job = lastTool(request);
      if (job.terminal) {
        expect(job).toMatchObject({ ok: true, state: "succeeded" });
        return textResponse("FOREGROUND_DIALOG_OK");
      }
      responses.unshift(poll);
      return commandResponse("get_job", { jobId, after: job.nextCursor, waitMs: 10_000 }, `foreground-poll-${++polls}`);
    };
    responses.push(
      commandResponse("click", { target: { by: "css", value: "#foreground-dialog" }, timeoutMs: 30_000 }, "foreground-click"),
      (request) => {
        const result = lastTool(request);
        expect(result).toMatchObject({ accepted: true, complete: false, state: "blocked", blockedBy: { kind: "dialog", type: "prompt", message: "Foreground answer?" } });
        jobId = result.jobId;
        expect(jobId).toBeTruthy();
        return commandResponse("handle_dialog", { dialogId: result.blockedBy.dialogId, accept: true, prompt: "confirmed" }, "foreground-answer");
      },
      (request) => {
        expect(lastTool(request)).toMatchObject({ accepted: true, state: "completed" });
        return commandResponse("get_job", { jobId }, "foreground-job");
      },
      poll,
      textResponse("处理前台对话框"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("open the prompt and enter confirmed");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOREGROUND_DIALOG_OK", { timeout: 30_000 });
    expect(await target.locator("body").getAttribute("data-answer")).toBe("confirmed");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.toolCallId === "foreground-click" && event.type === "tool.finished")).toHaveLength(1);
    expect(events.filter((event) => event.toolCallId === "foreground-answer" && event.type === "tool.finished")).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("verifies current and asynchronously changing element state", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const button = document.createElement("button");
      button.id = "start-verification";
      button.textContent = "Start";
      button.onclick = () => setTimeout(() => { document.querySelector("#verification-result")!.textContent = "Finished"; }, 300);
      const result = document.createElement("output");
      result.id = "verification-result";
      result.textContent = "Waiting";
      document.body.append(button, result);
    });
    const resultTarget = { by: "css", value: "#verification-result" };
    responses.push(
      commandResponse("click", { target: { by: "css", value: "#start-verification" } }, "start-verification"),
      commandResponse("verify_state", { target: resultTarget, textIncludes: "Finished", timeoutMs: 5_000 }, "wait-verification"),
      commandResponse("verify_state", { target: resultTarget, textIncludes: "Missing" }, "immediate-verification"),
      textResponse("STATE_VERIFIED"), textResponse("验证状态"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("start and verify the result");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STATE_VERIFIED");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.toolCallId === "wait-verification" && event.type === "tool.finished")?.output.result).toMatchObject({ verified: true, actual: "Finished", present: true });
    expect(events.find((event) => event.toolCallId === "immediate-verification" && event.type === "tool.finished")?.output.result).toMatchObject({ verified: false, actual: "Finished", present: true });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("moves a held pointer across independent observation-bound tools", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      document.addEventListener("pointermove", (event) => {
        if (event.buttons & 1) document.body.dataset.dragPosition = `${event.clientX},${event.clientY}`;
      });
      document.addEventListener("pointerup", () => { document.body.dataset.pointerReleased = "yes"; });
    });
    responses.push(
      commandResponse("inspect_page", {}, "pointer-observation"),
      (request) => {
        const observation = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
        responses.unshift(
          commandResponse("press_pointer", { button: "left" }, "pointer-down"),
          commandResponse("move_pointer", { observationId: observation.observationId, x: 80, y: 90 }, "pointer-move"),
          commandResponse("release_pointer", { button: "left" }, "pointer-up"),
        );
        return commandResponse("move_pointer", { observationId: observation.observationId, x: 20, y: 30 }, "pointer-start");
      },
      textResponse("POINTER_TOOLS_OK"), textResponse("指针工具"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("drag the pointer");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("POINTER_TOOLS_OK");
    const failures = (await readEvents(opened.page)).filter((event) => ["pointer-start", "pointer-down", "pointer-move", "pointer-up"].includes(event.toolCallId) && event.type === "tool.failed");
    expect(failures).toEqual([]);
    expect(await target.locator("body").getAttribute("data-drag-position")).toBe("80,90");
    expect(await target.locator("body").getAttribute("data-pointer-released")).toBe("yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("moves the trusted pointer before a semantic click and dispatches the click once", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      const button = document.createElement("button"); button.textContent = "Pointer target";
      button.style.cssText = "position:fixed;left:20px;top:20px;width:120px;height:40px";
      button.onmousemove = event => { if (event.isTrusted) button.dataset.moved = "yes"; };
      button.onmousedown = () => { button.dataset.movedBeforePress = button.dataset.moved || "no"; };
      button.onclick = event => { button.dataset.clicks = String(Number(button.dataset.clicks || 0) + 1); button.dataset.trustedClick = String(event.isTrusted); };
      document.body.append(button);
    });
    responses.push(commandResponse("click", { target: { by: "role", value: "button", name: "Pointer target" } }, "pointer-before-click"),
      commandResponse("read_attribute", { target: { by: "role", value: "button", name: "Pointer target" }, name: "data-moved-before-press" }, "pointer-verify"),
      textResponse("POINTER_OK"), textResponse("原生指针"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.mouse.move(220, 220);
    await opened.page.getByTestId("composer-input").fill("click the semantic target with native pointer input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("POINTER_OK");
    const button = target.getByRole("button", {name:"Pointer target"});
    expect(await button.getAttribute("data-moved-before-press")).toBe("yes");
    expect(await button.getAttribute("data-clicks")).toBe("1");
    expect(await button.getAttribute("data-trusted-click")).toBe("true");
    const events = await readEvents(opened.page);
    expect(events.find(event => event.type === "tool.finished" && event.toolCallId === "pointer-before-click")?.output).toMatchObject({ok:true,state:"succeeded"});
    expect(events.find(event => event.type === "tool.finished" && event.toolCallId === "pointer-verify")?.output).toMatchObject({ok:true,result:"yes"});
    expect(events.filter(event => event.type === "automation.action.finished" && event.content?.operation === "click")).toHaveLength(1);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

for (const deviceScaleFactor of [1, 2]) test(`injects a screenshot and clicks its observation coordinates at DPR ${deviceScaleFactor}`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { deviceScaleFactor });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/visual`);
    responses.push(
      commandResponse("take_screenshot", {}, "call-visual-observe"),
      (request) => {
        const tool = request.messages.findLast((message: any) => message.role === "tool");
        const result = JSON.parse(tool.content).result;
        const observationId = result.observationId;
        if (!observationId) throw new Error("Visual observation id was not returned to the model");
        return commandResponse("move_pointer", { observationId, x: 50 * result.screenshot.scale, y: 40 * result.screenshot.scale }, "call-visual-move");
      },
      commandResponse("press_pointer", {}, "call-visual-press"),
      commandResponse("release_pointer", {}, "call-visual-release"),
      textResponse("VISUAL_OK"), textResponse("视觉自动化"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.getByLabel("图片输入能力").click();
    await options.getByRole("option", { name: "支持", exact: true }).click();
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await options.close();
    await opened.page.getByTestId("composer-input").fill("use visual automation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => provider.requests.length).toBeGreaterThanOrEqual(2);
    const events = await readEvents(opened.page);
    const observation = events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-visual-observe")?.output.result;
    expect(observation?.screenshot?.mediaType).toBe("image/png");
    expect(observation?.viewport.scale).toBe(deviceScaleFactor);
    const artifact = events.find((event) => event.id === observation.artifact.id)?.output;
    const dimensions = await opened.page.evaluate(async (base64) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const dimensions = { width: image.width, height: image.height }; image.close(); return dimensions;
    }, artifact.base64);
    expect(observation.screenshot).toMatchObject(dimensions);
    expect(observation.screenshot.scale).toBe(dimensions.width / observation.viewport.width);
    expect(observation?.artifact).toMatchObject({ id: expect.any(Number), filename: expect.stringMatching(/\.png$/), mimeType: "image/png", byteLength: expect.any(Number), saved: false });
    expect(observation?.artifact).not.toHaveProperty("downloadId");
    expect(observation?.screenshot?.artifactId).toBe(observation?.artifact?.id);
    expect(await opened.page.evaluate(async () => chrome.permissions.contains({ permissions: ["downloads"] }))).toBe(true);
    expect(JSON.stringify(provider.requests[1])).toContain("image_url");
    expect(observation.observationId).toEqual(expect.any(String));
    await expect.poll(() => target.locator("body").getAttribute("data-clicked")).toBe("yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


for (const suspendedFrames of [false, true]) test(`uses frameLocator inside a cross-origin iframe${suspendedFrames ? " with suspended animation frames" : ""}`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    if (suspendedFrames) await target.addInitScript(() => {
      if (window !== window.top) {
        // Chrome may suppress callbacks in an occluded child frame. Exercise
        // that condition while still requiring a real native click below.
        window.requestAnimationFrame = () => 1;
        window.cancelAnimationFrame = () => undefined;
      }
    });
    await target.goto(`${provider.origin}/complex`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/complex`);
    responses.push(
      commandResponse("click", { tabId: tab.id!, target: { by: "role", value: "button", name: "Frame action", frame: { by: "css", value: 'iframe[src*=localhost]' } } }, "call-page-frame"),
      textResponse("FRAME_AUTOMATION_OK"),
      textResponse("跨域框架"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("click inside the cross-origin frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_AUTOMATION_OK", { timeout: 10_000 });
    await expect.poll(() => target.frames().find((frame) => frame.url().includes("localhost"))?.locator("body").getAttribute("data-clicked")).toBe("yes");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-page-frame")?.output).toMatchObject({ ok: true, state: "succeeded" });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("re-resolves replaced nodes and uses browser semantics through open shadow DOM", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation-dynamic`);
    const [tab] = await opened.page.evaluate((url) => chrome.tabs.query({ url }), `${provider.origin}/automation-dynamic`);
    const action = { by: "role", value: "button", name: "Delayed action" };
    for (let index = 0; index < 3; index++) {
      responses.push(commandResponse("verify_state", { tabId: tab.id!, target: action, state: "enabled", timeoutMs: 10_000 }, `dynamic-ready-${index}`),
        commandResponse("click", { tabId: tab.id!, target: action }, `dynamic-click-${index}`));
    }
    responses.push(commandResponse("click", { tabId: tab.id!, target: { by: "role", value: "button", name: "Shadow action" } }, "dynamic-shadow"),
      commandResponse("read_attribute", { tabId: tab.id!, target: { by: "css", value: "shadow-action" }, name: "data-clicked" }, "call-page-dynamic"),
      textResponse("DYNAMIC_AUTOMATION_OK"), textResponse("动态页面自动化"));
    await opened.page.getByTestId("composer-input").fill("exercise dynamic semantic automation");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(target.locator("output")).toHaveText("3", { timeout: 30_000 });
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DYNAMIC_AUTOMATION_OK", { timeout: 30_000 });
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "call-page-dynamic")?.output.result).toBe("yes");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("returns a tool result for a removed command and lets the agent recover", async () => {
  const provider = await startProvider([
    commandResponse("install", {}, "call-unsupported"),
    textResponse("RECOVERED_AFTER_DEBUGGER_ERROR"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("recover from an unsupported extension command");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RECOVERED_AFTER_DEBUGGER_ERROR");
    const activity = opened.page.getByTestId("tool-group-summary");
    await expect(activity).toHaveText(/^执行浏览器操作(?: · \d+\.\d{2} 秒)?$/);
    await expect(activity.locator("summary, button")).toHaveCount(0);
    await expect(opened.page.getByTestId("live-tool-calls")).toHaveCount(0);
    await expect.poll(() => provider.requests.filter((request) => request.tools).length).toBe(2);
    const events = await readEvents(opened.page);
    expect(JSON.stringify(events.find((event) => event.type === "tool.failed" && event.toolCallId === "call-unsupported")?.error))
      .toContain("install");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("binds each turn to the active tab and supplies all current-window tab metadata", async () => {
  const provider = await startProvider([
    commandResponse("click", { target: { by: "css", value: "#context-action" } }, "call-context-first"),
    textResponse("FIRST_CONTEXT_DONE"),
    textResponse("标签页上下文"),
    commandResponse("click", { target: { by: "css", value: "#context-action" } }, "call-context-second"),
    textResponse("SECOND_CONTEXT_DONE"),
  ]);
  const opened = await openExtension();
  try {
    const firstUrl = `${provider.origin}/target`;
    const secondUrl = `${provider.origin}/complex-next`;
    const first = await opened.context.newPage();
    await first.goto(firstUrl);
    const second = await opened.context.newPage();
    await second.goto(secondUrl);
    for (const [page, label] of [[first, "first"], [second, "second"]] as const) {
      await page.evaluate((value) => {
        const button = document.createElement("button"); button.id = "context-action"; button.textContent = "Mark active tab";
        button.onclick = () => { document.documentElement.dataset.contextTurn = value; }; document.body.append(button);
      }, label);
    }
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const windowCount = await opened.page.evaluate(async () => (await chrome.windows.getAll()).length);
    const composer = opened.page.getByTestId("composer-input");

    await first.bringToFront();
    await composer.fill("use the first active tab");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FIRST_CONTEXT_DONE");
    await expect.poll(() => first.evaluate(() => document.documentElement.dataset.contextTurn)).toBe("first");
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("标签页上下文");

    await second.bringToFront();
    await composer.fill("now use the second active tab");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("SECOND_CONTEXT_DONE");
    await expect.poll(() => second.evaluate(() => document.documentElement.dataset.contextTurn)).toBe("second");

    const agentRequests = provider.requests.filter((request) => request.tools);
    const firstRequest = agentRequests.find((request) => JSON.stringify(request.messages).includes("use the first active tab"));
    const secondRequest = [...agentRequests].reverse().find((request: any) => JSON.stringify(request.messages).includes("now use the second active tab"));
    const firstPrompt = JSON.stringify(firstRequest?.messages);
    const secondPrompt = JSON.stringify(secondRequest?.messages);
    for (const prompt of [firstPrompt, secondPrompt]) {
      expect(prompt).toContain("<browser-context>");
      expect(prompt).toContain(firstUrl);
      expect(prompt).toContain(secondUrl);
      expect(prompt).not.toContain('"type":"file"');
    }
    expect(firstPrompt).toContain('current\\\":true,\\\"title\\\":\\\"Side Agent Target');
    expect(secondPrompt).toContain('current\\\":true,\\\"title\\\":\\\"After Navigation');
    expect(await opened.page.evaluate(async () => (await chrome.windows.getAll()).length)).toBe(windowCount);

    const events = await readEvents(opened.page);
    const contexts = events.filter((event) => event.type === "browser.context.prepared");
    expect(contexts.some((event) => event.content.stepNumber === 0
      && event.content.tabs.some((tab: any) => tab.current && tab.url === firstUrl))).toBe(true);
    expect(contexts.some((event) => event.content.stepNumber === 0
      && event.content.tabs.some((tab: any) => tab.current && tab.url === secondUrl))).toBe(true);
    expect(JSON.stringify(events.filter((event) => event.type === "conversation.message"))).not.toContain("<browser-context>");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("keeps the default title after an unrecoverable title request failure", async () => {
  const provider = await startProvider([textResponse("BODY_REPLY"), { status: 400, error: "bad title request" }]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("title should fail");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("BODY_REPLY");
    await expect.poll(async () => (await readEvents(opened.page)).some((event) => event.type === "model.title.failed")).toBe(true);
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await expect(opened.page.getByTestId("composer-input")).toBeEnabled();
    const requestCount = provider.requests.length;
    await opened.page.reload();
    await expect(opened.page.getByTestId("conversation-menu")).toContainText("新对话");
    await expect(opened.page.locator(".markdown-body")).toHaveCount(0);
    await opened.page.waitForTimeout(200);
    expect(provider.requests).toHaveLength(requestCount);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("contains long unhandled errors in both extension views", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 360, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    for (const page of [opened.page, options]) {
      await page.setViewportSize({ width: 360, height: 700 });
      await page.evaluate(() => {
        const error = new Error("LONG_ERROR_".repeat(2000));
        window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
      });
      const notice = page.getByRole("alert").filter({ hasText: "发生未处理的错误" });
      await expect(notice).toBeVisible();
      await expect(notice.getByText("错误详情")).toBeVisible();
      await expect(notice.locator(".app-error-detail")).toBeHidden();
      await notice.getByText("错误详情").click();
      await expect(notice.locator(".app-error-detail")).toContainText("LONG_ERROR_");
      expect(await notice.locator(".app-error-detail").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await notice.getByRole("button", { name: "关闭错误提示" }).click();
      await expect(notice).toHaveCount(0);
    }
    await expect(opened.page.getByTestId("composer-input")).toBeVisible();
    await expect(options.getByRole("button", { name: "保存配置" })).toBeVisible();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("shows a compact model request error while keeping its full detail", async () => {
  const detail = "PROVIDER_ERROR_".repeat(1000);
  const provider = await startProvider([{ status: 400, error: detail }]);
  const opened = await openExtension();
  try {
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("request fails");
    await composer.press("Enter");
    const notice = opened.page.locator(".app-error-notice").filter({ hasText: "模型请求失败" });
    await expect(notice).toBeVisible();
    await expect(notice.locator(".app-error-detail")).toBeHidden();
    await notice.getByText("错误详情").click();
    await expect(notice.locator(".app-error-detail")).toContainText("PROVIDER_ERROR_");
    await expect(composer).toBeVisible();
    const events = await readEvents(opened.page);
    expect(JSON.stringify(events)).toContain("PROVIDER_ERROR_");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});


test("shows a bounded diagnostic when the canonical event log fails", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.page.setViewportSize({ width: 360, height: 700 });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        if ((names === "events" || Array.isArray(names) && names.includes("events")) && mode === "readwrite") throw new Error("LOG_ERROR_".repeat(2000));
        return original.call(this, names, mode, options);
      };
    });
    await opened.page.getByTestId("composer-input").fill("trigger log write");
    await opened.page.getByTestId("composer-input").press("Enter");
    const notice = opened.page.getByTestId("fatal-log-error").locator(".app-error-notice");
    await expect(notice).toContainText("事件日志不可用");
    await expect(opened.page.getByTestId("open-settings")).toBeVisible();
    await notice.getByText("错误详情").click();
    await expect(notice.locator(".app-error-detail")).toContainText("LOG_ERROR_");
    expect(await notice.locator(".app-error-detail").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});



test("preserves held keyboard and pointer input across independent commands", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const canvas = document.createElement("div"); canvas.style.cssText = "position:fixed;left:20px;top:200px;width:200px;height:40px;background:#eee";
      canvas.onpointerdown = () => { document.body.dataset.dragStarted = "yes"; };
      canvas.onpointermove = (event) => { if (event.buttons & 1) document.body.dataset.dragMoved = `${event.clientX}`; };
      canvas.onpointerup = (event) => { document.body.dataset.dragReleased = `${event.clientX},${event.clientY}`; };
      document.body.append(canvas);
    });
    responses.push(
      commandResponse("fill", { target: { by: "label", value: "Email" }, value: "" }, "focus-email"),
      commandResponse("key_down", { key: "Shift" }, "hold-shift"),
      commandResponse("press_key", { key: "a" }, "shift-a"),
      commandResponse("key_up", { key: "Shift" }, "release-shift"),
      commandResponse("inspect_page", {}, "pointer-observation"),
      (request) => {
        const observation = JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
        responses.unshift(commandResponse("press_pointer", {}, "drag-start"),
          commandResponse("move_pointer", { observationId: observation.observationId, x: 160, y: 215 }, "drag-move"),
          commandResponse("release_pointer", {}, "drag-end"));
        return commandResponse("move_pointer", { observationId: observation.observationId, x: 40, y: 215 }, "move-start");
      },
      textResponse("CHOOSER_AND_INPUT_OK"), textResponse("上传和输入"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("use held keyboard and pointer input");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHOOSER_AND_INPUT_OK");
    await expect(target.getByLabel("Email")).toHaveValue("A");
    expect(await target.evaluate(() => ({ ...document.body.dataset }))).toMatchObject({ dragStarted: "yes", dragMoved: "160", dragReleased: "160,215" });
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.failed")).toEqual([]);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("restores completed tool receipts after a failed form verification", async () => {
  const provider = await startProvider([
    commandResponse("fill", { target: { by: "label", value: "Email" }, value: "saved@example.com" }, "batch-fill"),
    commandResponse("verify_state", { target: { by: "label", value: "Email" }, valueEquals: "different@example.com" }, "batch-partial"),
    textResponse("PARTIAL_BATCH_REPORTED"), textResponse("批次恢复"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("verify a partial batch preserves its progress");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("PARTIAL_BATCH_REPORTED");
    const read = async () => (await readEvents(opened.page)).find((event) => ["tool.failed", "tool.finished"].includes(event.type) && event.toolCallId === "batch-partial")?.output;
    const result = await read();
    expect(result).toMatchObject({ ok: true, state: "succeeded", result: { verified: false, actual: "saved@example.com" } });
    const events = await readEvents(opened.page);
    expect(events.find(event => event.type === "tool.finished" && event.toolCallId === "batch-fill")?.output).toMatchObject({ ok: true });
    expect(events.some(event => event.type === "automation.action.finished" && event.content.operation === "click")).toBe(false);
    await opened.page.reload();
    expect(await read()).toEqual(result);
    await expect(target.getByLabel("Email")).toHaveValue("saved@example.com");
    await expect(target.locator("output")).toHaveText("");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("preserves completed tool progress when its native Side Panel closes during a later wait", async () => {
  const provider = await startProvider([
    commandResponse("fill", { target: { by: "label", value: "Email" }, value: "persisted@example.com" }, "native-partial-fill"),
    commandResponse("verify_state", { target: { by: "css", value: "#never-created" }, state: "visible", timeoutMs: 300_000 }, "native-partial-act"),
  ]);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const native = await nativePanel(opened, `${provider.origin}/automation`);
    await submitNative(native.panel, "complete the first action and wait for the next assertion");
    await expect(native.target.getByLabel("Email")).toHaveValue("persisted@example.com");
    await expect.poll(async () => (await readNativeEvents(native.panel)).filter((event) => event.type === "tool.finished" && event.toolCallId === "native-partial-fill").length).toBe(1);
    await expect.poll(async () => (await readNativeEvents(native.panel)).filter((event) => event.type === "tool.started" && event.toolCallId === "native-partial-act").length).toBe(1);
    await native.panel.close();
    expect((await native.browser.send("Target.closeTarget", { targetId: native.targetId })).success).toBe(true);
    const recovery = await opened.context.newPage(); await recovery.goto(`chrome-extension://${opened.extensionId}/sidepanel.html`);
    const results = async () => (await readEvents(recovery)).filter((event) => ["tool.failed", "tool.finished"].includes(event.type) && event.toolCallId === "native-partial-act");
    await expect.poll(async () => (await results()).length).toBe(1);
    const result = (await results())[0].output;
    expect(result).toMatchObject({ ok: false });
    const receipts = await readEvents(recovery);
    expect(receipts.some(event => event.type === "tool.finished" && event.toolCallId === "native-partial-fill")).toBe(true);
    expect(receipts.some(event => event.type === "automation.action.finished" && event.content.operation === "click")).toBe(false);
    await recovery.reload();
    expect((await results()).map((event) => event.output)).toEqual([result]);
    await expect(native.target.getByLabel("Email")).toHaveValue("persisted@example.com");
    await expect(native.target.locator("output")).toHaveText("");
    expect(provider.requests.filter(request => request.tools)).toHaveLength(2);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("rejects detached snapshot references after the page replaces a node", async () => {
  let ref = "";
  const responses: MockResponse[] = [
    commandResponse("inspect_page", {}, "original-ref"),
    (request) => {
      const message = request.messages.findLast((message: any) => message.role === "tool");
      ref = JSON.parse(message.content).items.find((item: any) => item.line.includes('button "Sign in"')).ref;
      return commandResponse("click", { target: { by: "css", value: "#replace-signin" } }, "replace-ref");
    },
    () => commandResponse("click", { target: { ref }, timeoutMs: 1000 }, "detached-ref"),
    textResponse("STALE_AND_INDEX_OK"), textResponse("引用与索引"),
  ];
  const provider = await startProvider(responses); const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/automation`);
    await target.evaluate(() => {
      const replace = document.createElement("button"); replace.id = "replace-signin"; replace.textContent = "Replace sign in";
      replace.onclick = () => {
        const button = document.querySelector("button:not(#replace-signin)")!;
        const replacement = button.cloneNode(true) as HTMLButtonElement;
        replacement.onclick = () => { document.body.dataset.replacementClicked = "yes"; }; button.replaceWith(replacement);
      };
      document.body.append(replace);
    });
    const options = await configure(opened.context, opened.page, provider.baseURL); await options.close();
    await opened.page.getByTestId("composer-input").fill("verify stale refs");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("STALE_AND_INDEX_OK");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.failed" && event.toolCallId === "detached-ref")?.output.error.code).toMatch(/stale|detached/);
    expect(await target.locator("body").getAttribute("data-replacement-clicked")).toBeNull();
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("reads cross-frame response bodies and records complete diagnostic events", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    const frame = target.frames().find((item) => item.url().includes("localhost"))!;
    await frame.evaluate(() => {
      const button = document.createElement("button"); button.id = "frame-diagnostic"; button.textContent = "Generate diagnostics";
      button.onclick = () => { console.warn("frame-diagnostic"); void fetch("/frame"); }; document.body.append(button);
    });
    let subscriptionId = "", eventCursor = 0, waits = 0;
    const waitResponse: MockResponse = (request) => {
      const result = JSON.parse(request.messages.findLast((message: any) => message.role === "tool").content);
      if (result.events.some((event: any) => event.kind === "response" && event.payload?.response?.url.endsWith("/frame"))) return commandResponse("list_requests", { limit: 100 }, "frame-requests");
      expect(++waits).toBeLessThan(10); eventCursor = result.nextCursor; responses.unshift(waitResponse);
      return commandResponse("wait_event", { subscriptionId, after: eventCursor, waitMs: 10_000 }, `frame-response-wait-${waits}`);
    };
    responses.push(
      commandResponse("read_console", { limit: 10 }, "frame-console-start"),
      commandResponse("list_requests", { limit: 10 }, "frame-requests-start"),
      commandResponse("subscribe_event", { kind: "response" }, "frame-subscribe"),
      (request) => { subscriptionId = JSON.parse(request.messages.findLast((message: any) => message.role === "tool").content).subscriptionId; return commandResponse("click", { target: { by: "css", value: "#frame-diagnostic", frame: { by: "css", value: 'iframe[src*=localhost]' } } }, "frame-fetch"); },
      () => { responses.unshift(waitResponse); return commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "frame-response-wait"); },
      (request) => {
        const tool = request.messages.findLast((message: any) => message.role === "tool");
        const requests = JSON.parse(tool.content).result.requests.filter((item: any) => item.url.endsWith("/frame"));
        return commandResponse("read_response", { requestRef: requests.at(-1).requestRef }, "frame-response-body");
      },
      commandResponse("read_console", { limit: 10 }, "frame-console"),
      textResponse("FRAME_DIAGNOSTICS_OK"), textResponse("框架诊断"),
    );
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.close();
    await opened.page.getByTestId("composer-input").fill("read diagnostics from a cross-origin frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_DIAGNOSTICS_OK");
    const events = await readEvents(opened.page);
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "frame-response-body")?.output.result).toContain("Cross Origin Frame");
    expect(events.find((event) => event.type === "tool.finished" && event.toolCallId === "frame-console")?.output.result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "frame-diagnostic" })]));
    const raw = events.find((event) => event.type === "browser.diagnostic" && event.content.method === "Network.responseReceived" && event.output.response?.url.endsWith("/frame"));
    expect(raw?.content.source.sessionId).toEqual(expect.any(String));
    expect(raw?.output.response).toMatchObject({ status: 200, headers: expect.any(Object) });
    const count = (await readEvents(opened.page)).filter((event) => event.type === "browser.diagnostic").length;
    await target.evaluate(async () => { console.warn("after-run"); await fetch("/complex-next"); });
    expect((await readEvents(opened.page)).filter((event) => event.type === "browser.diagnostic")).toHaveLength(count);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

for (const format of ["legacy-user-tools", "system-tools"] as const) test(`continues ${format} history with current tools and rejects old names without rewriting receipts`, async () => {
  const provider = await startProvider([
    commandResponse("run-code", { code: "async page => { throw new Error('old entry executed'); }" }, "removed-old-entry"),
    commandResponse("click", { target: { by: "css", value: "#migrated-action" } }, "current-entry"),
    textResponse("MIGRATED_CURRENT_TOOLS"), textResponse("RETRY_CURRENT_TOOLS"),
  ]);
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage(); await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      const button = document.createElement("button"); button.id = "migrated-action"; button.textContent = "Apply action";
      button.onclick = () => { document.body.dataset.migratedEffects = String(Number(document.body.dataset.migratedEffects || 0) + 1); };
      document.body.append(button);
    });
    const options = await configure(opened.context, opened.page, provider.baseURL);
    await options.getByRole("tab", { name: "智能体" }).click();
    await options.getByLabel("自定义系统提示词").fill("PERSISTED_CUSTOM_GUIDANCE");
    await options.getByRole("button", { name: "保存配置" }).click(); await expect(options.getByRole("status")).toContainText("配置已保存"); await options.close();
    await nameCurrentConversation(opened.page, `History ${format}`);
    const conversationId = (await readEvents(opened.page)).find(event => event.type === "conversation.title.updated" && event.content.title === `History ${format}`).conversationId;
    await opened.page.evaluate(async ({ conversationId, format }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("side-agent-runtime"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const tx = db.transaction("events", "readwrite"); const store = tx.objectStore("events"); const timestamp = new Date().toISOString();
      store.add({ type: "context.prompt.updated", conversationId, timestamp, content: { prompt: { version: format === "system-tools" ? 2 : 1, format, catalogVersion: "formal-49-v2", source: "PERSISTED_CUSTOM_GUIDANCE", instructions: "HISTORICAL_PROMPT_ONLY" } } });
      store.add({ type: "conversation.message", conversationId, timestamp, content: { id: "historical-user", role: "user", parts: [{ type: "text", text: "HISTORICAL_USER" }], metadata: { custom: { toolCatalog: { version: "formal-49-v2", context: "Available tools:\n- run-code: historical only" } } } }, parentId: null });
      store.add({ type: "conversation.message", conversationId, timestamp, content: { id: "historical-assistant", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "run-code", toolCallId: "historical-tool", state: "output-available", input: { code: "async page => 7" }, output: { historical: "HISTORICAL_RECEIPT" } }, { type: "text", text: "HISTORICAL_REPLY" }] }, parentId: "historical-user" });
      store.add({ type: "conversation.branch.selected", conversationId, timestamp, content: { headId: "historical-assistant" } });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    }, { conversationId, format });
    const historical = (await readEvents(opened.page)).filter(event => event.conversationId === conversationId);
    await opened.page.reload();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page.locator(".conversation-item", { hasText: `History ${format}` }).locator(".conversation-select").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("HISTORICAL_REPLY"); await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("continue the historical task with current tools"); await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("MIGRATED_CURRENT_TOOLS");
    const events = await readEvents(opened.page);
    for (const event of historical) expect(events.find(current => current.id === event.id)).toEqual(event);
    expect(events.filter(event => event.type === "tool.failed" && event.toolCallId === "removed-old-entry")).toHaveLength(1);
    expect(JSON.stringify(events.find(event => event.type === "tool.failed" && event.toolCallId === "removed-old-entry")?.error)).toContain("run-code");
    expect(events.some(event => event.type === "automation.action.started" && event.toolCallId === "removed-old-entry")).toBe(false);
    expect(events.find(event => event.type === "tool.finished" && event.toolCallId === "current-entry")?.output).toMatchObject({ ok: true, state: "succeeded" });
    expect(events.some(event => event.type === "automation.action.finished" && event.toolCallId === "current-entry")).toBe(true);
    expect(events.filter(event => event.type === "context.prompt.updated").at(-1)?.content).toMatchObject({ migratedFrom: "formal-49-v2", prompt: { catalogVersion: PROGRAM_CATALOG_VERSION, format: "system-tools" } });
    const requests = provider.requests.filter(request => request.tools);
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["inspect_page", "click", "fill", "send_request", "list_jobs", "get_job", "cancel_job"]));
    expect(requests[0].messages[0].content).toMatch(/^PERSISTED_CUSTOM_GUIDANCE\n\nAvailable tools:/);
    expect(JSON.stringify(requests[0].messages)).toContain("HISTORICAL_RECEIPT");
    await opened.page.getByTestId("replay-message-button").last().click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText("RETRY_CURRENT_TOOLS");
    expect(provider.requests.filter(request => request.tools).at(-1).tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["inspect_page", "click", "fill", "send_request", "list_jobs", "get_job", "cancel_job"]));
    await expect(target.locator("body")).toHaveAttribute("data-migrated-effects", "1");
    for (const event of historical) expect((await readEvents(opened.page)).find(current => current.id === event.id)).toEqual(event);
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
