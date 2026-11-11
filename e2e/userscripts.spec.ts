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
      await manager.evaluate(() => window.dispatchEvent(new ErrorEvent("error", { error: new Error("secret-marker stack-marker raw-response-marker") })));
      await expect(manager.getByText("发生未处理的错误，请重试操作。")).toBeVisible();
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
