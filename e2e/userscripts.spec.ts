import { expect } from "@playwright/test";

import {
  dispose,
  enableUserScripts,
  openExtension,
  readEvents,
  startProvider,
  test,
} from "./fixtures";

test(
  "restores saved user scripts after the MV3 worker restarts",
  { tag: "@user-journey" },
  async () => {
    const provider = await startProvider([]);
    const opened = await openExtension();
    try {
      await enableUserScripts(opened.context, opened.extensionId, opened.page);
      // Establish saved state through the user's workbench. Writing declarations
      // directly races first-start reconciliation and bypasses the save path.
      const manager = await opened.context.newPage();
      await manager.goto(
        `chrome-extension://${opened.extensionId}/userscripts.html`,
      );
      await expect(manager.getByLabel("已保存脚本")).toBeVisible();
      await manager.getByRole("button", { name: "新建脚本" }).click();
      await manager.locator("#script-id").fill("restored");
      await manager.locator("#script-matches").fill("invalid-pattern");
      await manager.locator("#script-code .cm-content").fill("console.log('test')");
      await manager.getByRole("button", { name: "保存", exact: true }).click();
      await expect(manager.getByRole("alert")).toContainText("matches");
      await manager.evaluate(() => window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("secret-marker stack-marker raw-response-marker") })));
      await expect(manager.getByText("发生未处理的错误，请重试操作。")).toBeVisible();
      await expect(manager.locator("body")).toContainText("操作未完成，请检查设置后重试。");
      await expect(manager.locator("body")).not.toContainText("网络连接中断");
      await expect(manager.locator("body")).not.toContainText("secret-marker");
      await expect(manager.locator("body")).not.toContainText("stack-marker");
      await expect(manager.locator("body")).not.toContainText("raw-response-marker");
      await manager.locator("#script-matches").fill(`${provider.origin}/*`);
      await manager.locator("#script-code .cm-content").fill("function broken( {");
      await manager.getByRole("button", { name: "保存", exact: true }).click();
      await expect(manager.getByRole("alert").filter({ hasText: "用户脚本操作失败" })).toContainText("JavaScript 语法有误");
      await manager
        .locator("#script-code .cm-content")
        .fill("document.documentElement.dataset.restoredScript = 'ran'");
      await manager.getByRole("button", { name: "保存", exact: true }).click();
      await expect(manager.getByRole("status")).toContainText("脚本已保存");
      await manager.getByRole("button", { name: "返回列表" }).click();
      await expect(
        manager.getByLabel("已保存脚本").getByText("已注册"),
      ).toBeVisible();
      const saved = (
        await manager.evaluate(() =>
          chrome.storage.local.get("side-agent:user-scripts"),
        )
      )["side-agent:user-scripts"];
      expect(saved).toMatchObject([
        { id: "restored", matches: [`${provider.origin}/*`] },
      ]);
      await manager.evaluate(async () => {
        await chrome.storage.local.set({ "side-agent:unrelated": "keep" });
        // Fault injection: lose the executable projection, retaining the saved
        // declaration. Native Chrome persistence must not mask broken restore.
        await chrome.userScripts.unregister({ ids: ["restored"] });
      });
      expect(
        await manager.evaluate(
          async () =>
            (await chrome.userScripts.getScripts({ ids: ["restored"] })).length,
        ),
      ).toBe(0);
      // CDP loadUnpacked is not a persistent installation. Restart the actual
      // MV3 worker instead of reinstalling and calling that a browser restart.
      const protocol = await opened.context.newCDPSession(opened.page);
      let versionId: string | undefined;
      protocol.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
        versionId =
          versions.find(
            (version) =>
              version.scriptURL.startsWith(
                `chrome-extension://${opened.extensionId}/`,
              ) && version.runningStatus === "running",
          )?.versionId ?? versionId;
      });
      await protocol.send("ServiceWorker.enable");
      await expect.poll(() => versionId).toBeTruthy();
      await protocol.send("ServiceWorker.stopWorker", {
        versionId: versionId!,
      });
      await opened.page.reload();
      await expect(opened.page.getByTestId("open-user-scripts")).toBeVisible();
      await protocol.detach();
      await expect
        .poll(() =>
          opened.page.evaluate(
            async () =>
              (await chrome.userScripts.getScripts({ ids: ["restored"] }))
                .length,
          ),
        )
        .toBe(1);
      expect(
        (
          await opened.page.evaluate(async () =>
            chrome.storage.local.get("side-agent:user-scripts"),
          )
        )["side-agent:user-scripts"],
      ).toEqual(saved);
      expect(
        await opened.page.evaluate(
          async () =>
            (await chrome.storage.local.get("side-agent:unrelated"))[
              "side-agent:unrelated"
            ],
        ),
      ).toBe("keep");
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/target`);
      await expect
        .poll(() =>
          target.evaluate(
            () => document.documentElement.dataset.restoredScript,
          ),
        )
        .toBe("ran");
    } finally {
      const state = await opened.page
        .evaluate(async () => ({
          declarations: await chrome.storage.local.get([
            "side-agent:user-scripts",
            "side-agent:user-scripts-disabled",
            "side-agent:user-scripts-error",
          ]),
          native:
            typeof chrome.userScripts === "object"
              ? await chrome.userScripts.getScripts()
              : null,
        }))
        .catch((error) => ({ error: String(error) }));
      const workers = await Promise.all(
        opened.context
          .serviceWorkers()
          .filter((worker) =>
            worker
              .url()
              .startsWith(`chrome-extension://${opened.extensionId}/`),
          )
          .map((worker) =>
            worker
              .evaluate(async () => ({
                available: typeof chrome.userScripts,
                native:
                  typeof chrome.userScripts === "object"
                    ? await chrome.userScripts.getScripts()
                    : null,
              }))
              .catch((error) => ({ error: String(error) })),
          ),
      );
      const events = await readEvents(opened.page)
        .then((events) =>
          events.filter((event) => event.type.startsWith("userscript.")),
        )
        .catch((error) => ({ error: String(error) }));
      await test
        .info()
        .attach("user-script-restoration-state", {
          body: JSON.stringify({ state, workers, events }),
          contentType: "application/json",
        });
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  },
);

test("stale script drafts cannot undo another page's delete or disable", { tag: "@user-journey" }, async () => {
  test.setTimeout(120_000);
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await enableUserScripts(opened.context, opened.extensionId, opened.page);
    const a = await opened.context.newPage();
    const b = await opened.context.newPage();
    const url = `chrome-extension://${opened.extensionId}/userscripts.html`;
    await Promise.all([a.goto(url), b.goto(url)]);
    const create = async (page: typeof a, id: string, code: string) => {
      await page.getByRole("button", { name: "新建脚本" }).click();
      await page.locator("#script-id").fill(id);
      await page.locator("#script-matches").fill(`${provider.origin}/*`);
      await page.locator("#script-code .cm-content").fill(code);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("脚本已保存");
      if (id === "shared" && code.includes("original")) {
        await page.locator("#script-code .cm-content").fill("document.documentElement.dataset.concurrentScript = 'second_save'");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect.poll(() => page.evaluate(async () => JSON.stringify((await chrome.storage.local.get("side-agent:user-scripts"))["side-agent:user-scripts"]))).toContain("second_save");
      }
      await page.getByRole("button", { name: "返回列表" }).click();
    };
    await create(b, "shared", "document.documentElement.dataset.concurrentScript = 'original'");
    await expect(a.getByRole("button", { name: /shared/ }).first()).toBeVisible();
    await a.getByRole("button", { name: /shared/ }).first().click();
    await a.locator("#script-code .cm-content").fill("document.documentElement.dataset.concurrentScript = 'draft_canary'");
    await b.getByRole("button", { name: /shared/ }).first().click();
    await b.getByRole("button", { name: "删除", exact: true }).click();
    await b.getByRole("button", { name: "确认删除" }).click();
    await expect(b.getByRole("status")).toContainText("已删除 1 个脚本");
    await a.getByRole("button", { name: "保存", exact: true }).click();
    const error = a.getByRole("alert");
    await expect(error).toContainText("用户脚本操作失败");
    await error.getByText("错误详情").click();
    await expect(error.getByText("脚本已更改或删除，请复制草稿后刷新并重新编辑。")).toBeVisible();
    await expect(error).not.toContainText(/draft_canary|stack/i);
    await expect(a.locator("#script-code .cm-content")).toContainText("draft_canary");
    const deleted = await b.evaluate(async () => ({
      stored: (await chrome.storage.local.get(["side-agent:user-scripts", "side-agent:user-scripts-disabled"])),
      native: await chrome.userScripts.getScripts({ ids: ["shared"] }),
    }));
    expect(JSON.stringify(deleted.stored)).not.toContain('"shared"');
    expect(deleted.native).toEqual([]);
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    expect(await target.evaluate(() => document.documentElement.dataset.concurrentScript)).toBeUndefined();
    await create(b, "shared", "document.documentElement.dataset.concurrentScript = 'recreated'");
    await a.getByRole("button", { name: "保存", exact: true }).click();
    await expect(error).toContainText("用户脚本操作失败");
    await error.getByText("错误详情").click();
    await expect(error.getByText("脚本已更改或删除，请复制草稿后刷新并重新编辑。")).toBeVisible();
    await expect(a.locator("#script-code .cm-content")).toContainText("draft_canary");
    const recreated = await b.evaluate(async () => (await chrome.storage.local.get("side-agent:user-scripts"))["side-agent:user-scripts"]);
    expect(JSON.stringify(recreated)).toContain("recreated");
    expect(JSON.stringify(recreated)).not.toContain("draft_canary");
    a.once("dialog", dialog => dialog.accept());
    await a.goto(url);
    await expect(a.getByRole("button", { name: /shared/ }).first()).toBeVisible();
    await a.getByRole("button", { name: /shared/ }).first().click();
    await a.locator("#script-code .cm-content").fill("document.documentElement.dataset.concurrentScript = 'saved_after_other'");
    await create(b, "other", "document.documentElement.dataset.otherScript = 'other'");
    await a.getByRole("button", { name: "保存", exact: true }).click();
    await expect(a.getByRole("status")).toContainText("脚本已保存");
    const afterOther = await a.evaluate(async () => ({ stored: (await chrome.storage.local.get("side-agent:user-scripts"))["side-agent:user-scripts"], native: await chrome.userScripts.getScripts({ ids: ["shared", "other"] }) }));
    expect(JSON.stringify(afterOther.stored)).toContain("saved_after_other");
    expect(afterOther.native.map(script => script.id).sort()).toEqual(["other", "shared"]);
    await a.getByRole("button", { name: "返回列表" }).click();
    await a.getByRole("button", { name: /shared/ }).first().click();
    await a.locator("#script-code .cm-content").fill("document.documentElement.dataset.concurrentScript = 'disabled_canary'");
    await b.getByRole("button", { name: "停用 shared" }).click();
    await expect(b.getByRole("status")).toContainText("脚本已停用");
    await a.getByRole("button", { name: "保存", exact: true }).click();
    await expect(error).toContainText("用户脚本操作失败");
    await error.getByText("错误详情").click();
    await expect(error.getByText("脚本已更改或删除，请复制草稿后刷新并重新编辑。")).toBeVisible();
    await expect(error).not.toContainText(/disabled_canary|stack/i);
    await expect(a.locator("#script-code .cm-content")).toContainText("disabled_canary");
    const disabled = await b.evaluate(async () => ({
      stored: await chrome.storage.local.get(["side-agent:user-scripts", "side-agent:user-scripts-disabled"]),
      native: await chrome.userScripts.getScripts({ ids: ["shared"] }),
    }));
    expect(disabled.stored["side-agent:user-scripts-disabled"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "shared" })]));
    expect(disabled.native).toEqual([]);
    const afterDisable = await opened.context.newPage();
    await afterDisable.goto(`${provider.origin}/target`);
    expect(await afterDisable.evaluate(() => document.documentElement.dataset.concurrentScript)).toBeUndefined();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
