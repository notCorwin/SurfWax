import { expect, test } from "@playwright/test";
import {
  commandResponse,
  textResponse,
  startProvider,
  openExtension,
  configure,
  nameCurrentConversation,
  readEvents,
  dispose,
  enableUserScripts,
  reloadUpgradedExtension,
  nativePanel,
  submitNative,
  readNativeEvents,
} from "./fixtures";

function lastTool(request: any) {
  const value = request.messages.findLast(
    (message: any) => message.role === "tool",
  ).content;
  return JSON.parse(
    Array.isArray(value)
      ? value.find((part: any) => part.type === "text").text
      : value,
  );
}
async function evidence(page: any, provider: any) {
  await test.info().attach("program-evidence", {
    body: JSON.stringify({
      requests: provider.requests,
      events: await readEvents(page),
    }),
    contentType: "application/json",
  });
}
async function submit(page: any) {
  await page
    .getByTestId("composer-input")
    .fill("Exercise the composable browser program");
  await page.getByTestId("composer-input").press("Enter");
}

test("publishes three tools, defaults vision inspection to text, and captures pixels only on demand", async () => {
  const provider = await startProvider([
    commandResponse("inspect", {}, "text-default"),
    (request) => {
      expect(lastTool(request)).not.toHaveProperty("screenshot");
      return commandResponse("inspect", { image: true }, "pixels-requested");
    },
    (request) => {
      const image = lastTool(request);
      expect(image).toMatchObject({
        tabId: expect.any(Number),
        documentId: expect.any(Number),
      });
      if (!image.screenshot)
        return textResponse(
          `UNEXPECTED_IMAGE_RESULT: ${JSON.stringify(image)}`,
        );
      return commandResponse(
        "run",
        {
          code: `await page.point(${JSON.stringify(image.observationId)}, ${50 * image.screenshot.scale}, ${40 * image.screenshot.scale}, 'click'); await check(await page.evaluate(() => document.body.dataset.clicked) === 'yes'); return await page.inspect();`,
        },
        "visual-program",
      );
    },
    textResponse("TEXT_AND_PIXELS_VERIFIED"),
  ]);
  const opened = await openExtension(undefined, { catalog: "program" });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/visual`);
    const options = await configure(
      opened.context,
      opened.page,
      provider.baseURL,
    );
    await options.getByLabel("图片输入能力").click();
    await options.getByRole("option", { name: "支持", exact: true }).click();
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await options.close();
    await nameCurrentConversation(opened.page, "Program vision");
    await target.bringToFront();
    await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "TEXT_AND_PIXELS_VERIFIED",
    );
    expect(
      provider.requests[0].tools.map((item: any) => item.function.name),
    ).toEqual(["inspect", "run", "jobs"]);
    const events = await readEvents(opened.page);
    expect(
      events.find(
        (event) =>
          event.type === "tool.finished" && event.toolCallId === "text-default",
      ).output,
    ).toMatchObject({
      mode: "full",
      snapshot: expect.any(String),
      tabId: expect.any(Number),
      documentId: expect.any(Number),
    });
    expect(
      events.filter(
        (event) =>
          event.type === "tool.result.data" &&
          event.content?.mimeType?.startsWith("image/"),
      ),
    ).toHaveLength(1);
    expect(
      events.find(
        (event) =>
          event.type === "tool.finished" &&
          event.toolCallId === "visual-program",
      ).output,
    ).toMatchObject({ ok: true, state: "succeeded" });
    expect(
      events.some(
        (event) =>
          event.type === "browser.job.progress" &&
          event.content?.state === "verified",
      ),
    ).toBe(true);
    expect(await target.evaluate(() => document.body.dataset.clicked)).toBe(
      "yes",
    );
    await expect(
      opened.page.locator("iframe[src*=program-sandbox]"),
    ).toHaveCount(0);
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("composes same-process and cross-origin frames, chooser replies, native dialogs, held input, and downloads", async () => {
  const responses: any[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { catalog: "program" });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/complex`);
    target.on("dialog", () => {}); // Let the agent handle the dialog instead of Playwright's automatic dismissal.
    const frame = target
      .frames()
      .find((frame) => frame.url().includes("localhost"))!;
    await frame.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.hidden = true;
      input.multiple = true;
      input.onchange = () => {
        document.body.dataset.files = [...(input.files ?? [])]
          .map((file) => file.name)
          .join(",");
      };
      document.body.append(input);
      const chooser = document.createElement("button");
      chooser.textContent = "Upload files";
      chooser.onclick = () => input.click();
      document.body.append(chooser);
    });
    await target.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Prompt";
      button.onclick = () => {
        document.body.dataset.answer =
          prompt("Question", "initial") ?? "cancelled";
      };
      document.body.append(button);
      const input = document.createElement("input");
      input.id = "held";
      document.body.append(input);
      const drag = document.createElement("div");
      drag.style.cssText =
        "position:fixed;left:20px;top:300px;width:200px;height:40px;background:#eee";
      drag.onpointermove = (event) => {
        if (event.buttons & 1)
          document.body.dataset.dragged = String(event.clientX);
      };
      document.body.append(drag);
    });
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await nameCurrentConversation(opened.page, "Program capabilities");
    responses.push(
      commandResponse(
        "run",
        {
          timeoutMs: 20000,
          code: `
const same = page.frameLocator('iframe[src="/same-frame"]');
const cross = page.frameLocator('iframe[src*=localhost]');
await same.locator('main').evaluate(el => { el.textContent = 'same updated'; });
await cross.getByRole('button', { name: 'Frame action' }).click();
const chooserWait = page.waitForEvent('filechooser');
await cross.getByRole('button', { name: 'Upload files' }).click();
const chooser = await chooserWait; await check(chooser.isMultiple());
await chooser.setFiles([{name:'one.txt',text:'one'},{name:'two.txt',text:'two'}]);
const dialogWait = page.waitForEvent('dialog');
const click = page.getByRole('button', { name: 'Prompt' }).click();
const dialog = await dialogWait; await check(dialog.message() === 'Question'); await dialog.accept('accepted'); await click;
await page.locator('#held').focus(); await page.keyboard.down('Shift'); await page.keyboard.press('a'); await page.keyboard.up('Shift');
await page.mouse.move(40,315); await page.mouse.down(); await page.mouse.move(160,315); await page.mouse.up();
await check(await page.locator('#held').inputValue() === 'A');
await check(await page.evaluate(() => document.body.dataset.answer) === 'accepted');
await check(await cross.locator('body').getAttribute('data-files') === 'one.txt,two.txt');
const popupWait = page.waitForEvent('popup');
await page.evaluate(url => { window.open(url,'_blank'); }, ${JSON.stringify(provider.origin + "/visual")});
const popup = await popupWait;
const popupText = await popup.observe(); await check(popupText.tabId === popup.tabId && !popupText.screenshot);
await popup.keyboard.press('Escape'); await browser.tabs.close(popup.tabId);
const pdf = await page.pdf(); await check(pdf.artifact.mimeType === 'application/pdf');
let missingArtifact = false; try { await artifacts.save(999999); } catch { missingArtifact = true; } await check(missingArtifact);
const artifact = await artifacts.text('program-notes.txt','captured text');
await check((await artifacts.read(artifact.id)).base64 === 'Y2FwdHVyZWQgdGV4dA==');
return await artifacts.save(artifact.id);
`,
        },
        "all-capabilities",
      ),
      textResponse("CAPABILITIES_VERIFIED"),
    );
    await target.bringToFront();
    await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "CAPABILITIES_VERIFIED",
      { timeout: 30000 },
    );
    await expect(
      target.frameLocator('iframe[src="/same-frame"]').locator("main"),
    ).toHaveText("same updated");
    await expect(frame.locator("body")).toHaveAttribute("data-clicked", "yes");
    await expect(target.locator("body")).toHaveAttribute("data-dragged", "160");
    const events = await readEvents(opened.page);
    expect(events.filter((event) => event.type === "tool.failed")).toEqual([]);
    const saves = events.filter(
      (event) =>
        event.type === "browser.job.progress" &&
        event.content.operation === "artifacts.save",
    );
    const rejectedSave = saves.filter(
      (event) => event.content.sequence === saves[0].content.sequence,
    );
    expect(rejectedSave).toHaveLength(2);
    expect(
      rejectedSave.every((event) => event.content.state === "not-dispatched"),
    ).toBe(true);
    expect(
      saves.filter((event) => event.content.state === "dispatched-unknown"),
    ).toHaveLength(1);
    expect(
      events.find(
        (event) =>
          event.type === "tool.finished" &&
          event.toolCallId === "all-capabilities",
      ).output,
    ).toMatchObject({
      ok: true,
      result: { artifact: { saved: true, downloadId: expect.any(Number) } },
    });
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("keeps network domains explicit, scopes protocol and tabs, and rejects stale document refs", async () => {
  let baseline: any;
  const responses: any[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { catalog: "program" });
  responses.push(
    commandResponse("inspect", {}, "owned-baseline"),
    (request: any) => {
      baseline = lastTool(request);
      const ref = /button "Sign in" \[ref=([^\]]+)\]/.exec(
        baseline.snapshot,
      )![1];
      return commandResponse(
        "run",
        {
          timeoutMs: 20000,
          code: `
let denied = false; try { await net.fetch({context:'page',url:${JSON.stringify(provider.origin.replace("127.0.0.1", "localhost") + "/frame")}}); } catch { denied = true; } await check(denied,'page CORS must reject');
const fetched = await net.fetch({context:'extension',url:${JSON.stringify(provider.origin.replace("127.0.0.1", "localhost") + "/frame")}}); await check(fetched.ok && fetched.body.includes('Frame action'));
const isolated = await browser.runIn({kind:'page',tabId:page.tabId,world:'ISOLATED'}, "globalThis.onlyIsolated=7; return onlyIsolated;");
let worldRequired = false; try { await browser.runIn({kind:'page',tabId:page.tabId},'return true;'); } catch(error) { worldRequired = error.message.includes('explicit'); } await check(worldRequired);
await check(await page.evaluate(() => globalThis.onlyIsolated) === undefined);
const cdp = await protocol.send({tabId:page.tabId},'Runtime.evaluate',{expression:'document.title',returnByValue:true}); await check(cdp.result.value === 'Automation Target');
await check((await protocol.sessions()).every(session => session.tabId === page.tabId));
let rejected = false; try { await protocol.send({tabId:page.tabId},'Browser.grantPermissions',{}); } catch { rejected=true; } await check(rejected);
const other = await browser.tabs.open(${JSON.stringify(provider.origin + "/target")}); await other.waitForURL(new RegExp('/target')); await check((await browser.tabs.list()).some(tab => tab.tabId === other.tabId || tab.id === other.tabId)); await browser.tabs.close(other.tabId);
await page.goto(${JSON.stringify(provider.origin + "/complex-next")}); await page.waitForURL(/complex-next/);
let stale = false; try { await page.ref(${JSON.stringify(ref)}).click(); } catch (error) { stale=String(error.message).includes('stale-ref'); } await check(stale);
return { isolated, requests:await net.requests(), console:await net.console(), observation:await page.inspect() };
`,
        },
        "domains-and-ownership",
      );
    },
    textResponse("DOMAINS_AND_OWNERSHIP_VERIFIED"),
  );
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await nameCurrentConversation(opened.page, "Program domains");
    await target.bringToFront();
    await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "DOMAINS_AND_OWNERSHIP_VERIFIED",
      { timeout: 30000 },
    );
    await expect(target).toHaveURL(`${provider.origin}/complex-next`);
    const result = (await readEvents(opened.page)).find(
      (event) =>
        event.type === "tool.finished" &&
        event.toolCallId === "domains-and-ownership",
    ).output;
    expect(result).toMatchObject({
      ok: true,
      result: { observation: { documentId: expect.any(Number), mode: "full" } },
    });
    expect(result.result.observation.documentId).toBeGreaterThan(
      baseline.documentId,
    );
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("persists MAIN and USER_SCRIPT matching and enablement through extension reload", async () => {
  const responses: any[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { catalog: "program" });
  const main = {
    id: "program-main",
    matches: [`${provider.origin}/*`],
    excludeMatches: [`${provider.origin}/frame`],
    js: [{ code: "document.documentElement.dataset.mainScript='first'" }],
    world: "MAIN",
    runAt: "document_end",
  };
  const user = {
    id: "program-user",
    matches: [`${provider.origin}/*`],
    js: [{ code: "document.documentElement.dataset.userScript='yes'" }],
    world: "USER_SCRIPT",
    runAt: "document_end",
  };
  responses.push(
    commandResponse(
      "run",
      {
        code: `await browser.scripts.create(${JSON.stringify(main)}); await browser.scripts.create(${JSON.stringify(user)}); await browser.scripts.setEnabled('program-main',false); await browser.scripts.edit('program-main',{js:[{code:"document.documentElement.dataset.mainScript='edited'"}]}); await check((await browser.scripts.read('program-main')).enabled === false); return await browser.scripts.list();`,
      },
      "persistent-create",
    ),
    textResponse("SCRIPTS_PERSISTED"),
  );
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await nameCurrentConversation(opened.page, "Program scripts");
    await target.bringToFront();
    await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "SCRIPTS_PERSISTED",
    );
    await reloadUpgradedExtension(opened);
    expect(
      await opened.page.evaluate(async () =>
        (await chrome.userScripts.getScripts()).map(({ id, world }) => ({
          id,
          world,
        })),
      ),
    ).toEqual([{ id: "program-user", world: "USER_SCRIPT" }]);
    responses.push(
      commandResponse(
        "run",
        {
          timeoutMs: 20000,
          code: `const disabled=await browser.scripts.read('program-main'); await check(!disabled.enabled && disabled.script.js[0].code.includes('edited')); await browser.scripts.setEnabled('program-main',true); await page.reload(); for(let i=0;i<100 && await page.evaluate(() => document.documentElement.dataset.userScript) !== 'yes';i++) await sleep(20); await check(await page.evaluate(() => document.documentElement.dataset.mainScript) === 'edited'); await check(await page.evaluate(() => document.documentElement.dataset.userScript) === 'yes'); return await browser.scripts.list();`,
        },
        "persistent-restored",
      ),
      textResponse("SCRIPTS_RESTORED"),
    );
    await target.bringToFront();
    await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "SCRIPTS_RESTORED",
    );
    expect(
      (await readEvents(opened.page)).filter(
        (event) => event.type === "tool.failed",
      ),
    ).toEqual([]);
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("terminates synchronous timeout and abnormal worker exit, then recovers after a partial failed program", async () => {
  const provider = await startProvider([
    commandResponse(
      "run",
      { timeoutMs: 300, code: "while(true){}" },
      "cpu-timeout",
    ),
    commandResponse(
      "run",
      {
        timeoutMs: 2000,
        code: "await page.evaluate(() => { document.body.dataset.pagePartial='yes'; while(true){} });",
      },
      "page-loop-timeout",
    ),
    commandResponse("run", { code: "self.close()" }, "worker-exit"),
    commandResponse(
      "run",
      {
        code: "await page.getByLabel('Email').fill('kept@example.com'); await check(false,'intentional outcome failure'); await page.getByRole('button',{name:'Sign in'}).click();",
      },
      "partial-program",
    ),
    commandResponse(
      "run",
      {
        code: "await check(await page.evaluate(() => document.body.dataset.pagePartial) === 'yes'); await check(await page.getByLabel('Email').inputValue() === 'kept@example.com'); await check(await page.locator('output').innerText() === ''); await page.getByRole('button',{name:'Sign in'}).click(); await check(await page.locator('output').innerText() === 'Welcome kept@example.com'); return await page.inspect();",
      },
      "partial-recovery",
    ),
    textResponse("TIMEOUT_EXIT_AND_RECOVERY_VERIFIED"),
  ]);
  const opened = await openExtension(undefined, { catalog: "program" });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await nameCurrentConversation(opened.page, "Program failure");
    await target.bringToFront();
    await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "TIMEOUT_EXIT_AND_RECOVERY_VERIFIED",
    );
    const events = await readEvents(opened.page);
    expect(
      events.find(
        (event) =>
          event.type === "tool.failed" && event.toolCallId === "cpu-timeout",
      ).output,
    ).toMatchObject({
      state: "failed",
      error: { code: "timeout", retryable: false },
    });
    expect(
      events.find(
        (event) =>
          event.type === "tool.failed" &&
          event.toolCallId === "page-loop-timeout",
      ).output,
    ).toMatchObject({
      state: "failed",
      error: { code: "timeout", retryable: false, effectUnknown: true },
    });
    expect(
      events.find(
        (event) =>
          event.type === "tool.failed" && event.toolCallId === "worker-exit",
      ).output.error.message,
    ).toContain("worker exited");
    expect(
      events.filter(
        (event) =>
          event.type === "browser.job.progress" &&
          event.toolCallId === "partial-program" &&
          event.content.operation.endsWith("click"),
      ),
    ).toEqual([]);
    expect(
      events.find(
        (event) =>
          event.type === "tool.finished" &&
          event.toolCallId === "partial-recovery",
      ).output.ok,
    ).toBe(true);
    await expect(
      opened.page.locator("iframe[src*=program-sandbox]"),
    ).toHaveCount(0);
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("panel reload interrupts the owned job, preserves receipts, and prevents delayed browser effects", async () => {
  const responses: any[] = [
    commandResponse(
      "run",
      {
        background: true,
        code: "await page.evaluate(() => {document.body.dataset.partial='1'}); await emit('ready-to-reload'); await sleep(60000); await page.evaluate(() => {document.body.dataset.late='yes'});",
      },
      "reload-job",
    ),
    {
      parts: textResponse("unreachable"),
      delayMs: 0,
      startAfter: new Promise(() => undefined),
    },
  ];
  const provider = await startProvider(responses);
  const opened = await openExtension(undefined, { catalog: "program" });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await nameCurrentConversation(opened.page, "Program restart");
    await target.bringToFront();
    await submit(opened.page);
    await expect
      .poll(async () =>
        (await readEvents(opened.page)).some(
          (event) =>
            event.type === "browser.job.progress" &&
            event.output === "ready-to-reload",
        ),
      )
      .toBe(true);
    const job = (await readEvents(opened.page)).find(
      (event) =>
        event.type === "browser.job.state" && event.toolCallId === "reload-job",
    ).content.jobId;
    await opened.page.reload();
    await expect(opened.page.getByTestId("composer-input")).toBeEnabled();
    await opened.page.getByTestId("conversation-menu").click();
    await opened.page
      .locator(".conversation-item", { hasText: "Program restart" })
      .locator(".conversation-select")
      .click();
    responses.push(
      commandResponse("jobs", { action: "status", id: job }, "reloaded-status"),
      commandResponse(
        "run",
        {
          code: "await check(await page.evaluate(() => document.body.dataset.partial) === '1'); await check(await page.evaluate(() => document.body.dataset.late) === undefined); return await page.inspect();",
        },
        "reloaded-recovery",
      ),
      textResponse("RESTART_RECEIPTS_VERIFIED"),
    );
    await target.bringToFront();
    await expect(opened.page.getByTestId("interrupted-message")).toBeVisible();
    await opened.page.getByTestId("continue-interrupted").click();
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "RESTART_RECEIPTS_VERIFIED",
    );
    const status = (await readEvents(opened.page)).find(
      (event) =>
        event.toolCallId === "reloaded-status" && event.type === "tool.failed",
    ).output;
    expect(["interrupted", "cancelled"]).toContain(status.state);
    expect(status.terminal).toBe(true);
    expect(
      status.events.some(
        (event: any) =>
          event.operation === "emit" && event.output === "ready-to-reload",
      ),
    ).toBe(true);
    expect(
      await target.evaluate(() => document.body.dataset.late),
    ).toBeUndefined();
    await expect(
      opened.page.locator("iframe[src*=program-sandbox]"),
    ).toHaveCount(0);
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("the real native Side Panel owns a sandbox program and cleans held input when closed", async () => {
  const provider = await startProvider([
    commandResponse(
      "run",
      {
        background: true,
        code: "await page.getByLabel('Email').fill('native@example.com'); await page.keyboard.down('Shift'); await emit('native-ready'); await page.evaluate(() => { console.log('native-page-loop'); while(true){} });",
      },
      "native-program",
    ),
    {
      parts: textResponse("unreachable"),
      delayMs: 0,
      startAfter: new Promise(() => undefined),
    },
  ]);
  const opened = await openExtension(undefined, { catalog: "program" });
  try {
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    const native = await nativePanel(opened, `${provider.origin}/automation`);
    await native.target.evaluate(() =>
      document.addEventListener("keyup", (event) => {
        if (event.key === "Shift") document.body.dataset.shiftReleased = "yes";
      }),
    );
    await submitNative(native.panel, "run the native sandbox program");
    await expect
      .poll(async () =>
        (await readNativeEvents(native.panel)).some(
          (event) =>
            event.type === "browser.job.progress" &&
            event.output === "native-ready",
        ),
      )
      .toBe(true);
    expect(
      provider.requests[0].tools.map((tool: any) => tool.function.name),
    ).toEqual(["inspect", "run", "jobs"]);
    await expect
      .poll(async () =>
        (await readNativeEvents(native.panel)).some(
          (event) =>
            event.type === "browser.diagnostic" &&
            event.content?.method === "Runtime.consoleAPICalled" &&
            event.output?.args?.some(
              (argument: any) => argument.value === "native-page-loop",
            ),
        ),
      )
      .toBe(true);
    await native.panel.close();
    expect(
      (
        await native.browser.send("Target.closeTarget", {
          targetId: native.targetId,
        })
      ).success,
    ).toBe(true);
    await expect(native.target.locator("#__surf-wax-page-guard")).toHaveCount(
      0,
    );
    await expect(native.target.locator("body")).toHaveAttribute(
      "data-shift-released",
      "yes",
    );
    await expect(native.target.getByLabel("Email")).toHaveValue(
      "native@example.com",
    );
    const recovery = await opened.context.newPage();
    await recovery.goto(
      `chrome-extension://${opened.extensionId}/sidepanel.html`,
    );
    const events = await readEvents(recovery);
    expect(
      events.some(
        (event) =>
          event.type === "browser.job.progress" &&
          event.toolCallId === "native-program" &&
          event.output === "native-ready",
      ),
    ).toBe(true);
    await test.info().attach("native-program-events", {
      body: JSON.stringify(events),
      contentType: "application/json",
    });
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("composes form operations and returns only text changes with owned references", async () => {
  const provider = await startProvider([
    commandResponse("inspect", {}, "form-before"),
    (request) => {
      const observation = lastTool(request);
      const email = /textbox "Email" \[ref=([^\]]+)\]/.exec(
        observation.snapshot,
      )![1];
      const button = /button "Sign in" \[ref=([^\]]+)\]/.exec(
        observation.snapshot,
      )![1];
      return commandResponse(
        "run",
        {
          code: `const full=await page.snapshot(); await check(full.tabId === page.tabId && full.snapshot.includes(${JSON.stringify(`[ref=${email}]`)}) && !full.snapshot.includes('[ref=e')); await page.ref(${JSON.stringify(email)}).fill('me@example.com'); await page.ref(${JSON.stringify(button)}).click(); await check((await page.locator('output').innerText()).includes('Welcome me@example.com')); return await page.inspect({ since: ${JSON.stringify(observation.observationId)} });`,
        },
        "form-batch",
      );
    },
    textResponse("FORM_PROGRAM_VERIFIED"),
  ]);
  const opened = await openExtension(undefined, { catalog: "program" });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/automation`);
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await nameCurrentConversation(opened.page, "Program form");
    await target.bringToFront();
    await submit(opened.page);
    await expect(target.locator("output")).toHaveText("Welcome me@example.com");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "FORM_PROGRAM_VERIFIED",
    );
    const events = await readEvents(opened.page);
    const result = events.find(
      (event) =>
        event.type === "tool.finished" && event.toolCallId === "form-batch",
    ).output;
    expect(result).toMatchObject({
      ok: true,
      result: {
        mode: "delta",
        changes: expect.any(Array),
        truncation: { truncated: false },
      },
    });
    expect(result.result).not.toHaveProperty("snapshot");
    expect(JSON.stringify(result.result.changes)).toContain(
      "Welcome me@example.com",
    );
    expect(
      events.filter(
        (event) =>
          event.type === "browser.job.progress" &&
          event.content?.state === "completed",
      ).length,
    ).toBeGreaterThanOrEqual(4);
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test("queries and cancels a synchronous infinite program while preserving prior effects", async () => {
  let jobId: string;
  const provider = await startProvider([
    commandResponse(
      "run",
      {
        background: true,
        code: "await page.getByRole('button', { name: 'Increment' }).click(); await emit('first input completed'); while (true) {}",
      },
      "infinite-job",
    ),
    (request) => {
      jobId = lastTool(request).jobId;
      return commandResponse(
        "jobs",
        { action: "wait", id: jobId, waitMs: 1000 },
        "job-responsive",
      );
    },
    () =>
      commandResponse("jobs", { action: "cancel", id: jobId }, "job-cancel"),
    () =>
      commandResponse(
        "jobs",
        { action: "wait", id: jobId, waitMs: 1000 },
        "job-terminal",
      ),
    commandResponse(
      "run",
      {
        code: "await check(await page.locator('output').innerText() === '1'); return await page.inspect();",
      },
      "job-recovery",
    ),
    textResponse("CANCELLED_WITHOUT_ROLLBACK"),
  ]);
  const opened = await openExtension(undefined, { catalog: "program" });
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/performance`);
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    await nameCurrentConversation(opened.page, "Program cancel");
    await target.bringToFront();
    await submit(opened.page);
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "CANCELLED_WITHOUT_ROLLBACK",
      { timeout: 30000 },
    );
    await expect(target.locator("output")).toHaveText("1");
    const events = await readEvents(opened.page);
    expect(
      events.find(
        (event) =>
          event.type === "tool.finished" &&
          event.toolCallId === "job-responsive",
      ).output,
    ).toMatchObject({ id: jobId!, state: "running", terminal: false });
    expect(
      events.find(
        (event) =>
          event.type === "tool.failed" && event.toolCallId === "job-terminal",
      ).output,
    ).toMatchObject({
      id: jobId!,
      state: "cancelled",
      terminal: true,
      ok: false,
    });
    expect(
      events.find(
        (event) =>
          event.type === "tool.finished" && event.toolCallId === "job-recovery",
      ).output,
    ).toMatchObject({ ok: true });
    await expect(
      opened.page.locator("iframe[src*=program-sandbox]"),
    ).toHaveCount(0);
  } finally {
    await evidence(opened.page, provider);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
