import { gunzipSync } from "node:zlib";
import bundledCatalog from "../src/data/models-dev-api";
import {
  assistantResponse,
  commandResponse,
  configure,
  delayedResponse,
  dispose,
  expect,
  focusPageControl,
  openExtension,
  readEvents,
  startNewConversation,
  startProvider,
  test,
  textResponse,
} from "./fixtures";

const largeReply = "OLD_CONTEXT_MARKER " + "page observation ".repeat(8_000);
const summary =
  "Earlier page observations and the user request have been recorded.";

test("automatically summarizes after a completed turn and preserves the full canonical history", async () => {
  const provider = await startProvider(
    [
      textResponse(largeReply),
      textResponse("压缩测试"),
      textResponse("COMPACTED_REPLY"),
    ],
    0,
    summary,
  );
  const opened = await openExtension();
  try {
    await expect(opened.page.getByTestId("open-settings")).toBeVisible();
    // This exercises compaction against a known model catalog, not Models.dev
    // uptime. Reuse the bundled data so external refreshes cannot delay a reply.
    await opened.page.evaluate(
      (catalog) =>
        chrome.storage.local.set({
          "side-agent:model-catalog": {
            version: 2,
            fetchedAt: Date.now(),
            catalog,
          },
        }),
      JSON.parse(
        gunzipSync(Buffer.from(bundledCatalog, "base64")).toString("utf8"),
      ),
    );
    await (
      await configure(opened.context, opened.page, provider.baseURL, 50_000)
    ).close();
    const composer = opened.page.getByTestId("composer-input");
    await composer.fill("first request");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "OLD_CONTEXT_MARKER",
    );
    await expect(opened.page.getByTestId("context-status")).toContainText(
      "历史上下文已被压缩成摘要",
    );
    await expect(opened.page.getByTestId("context-choice")).toHaveCount(0);
    await expect(composer).toBeEnabled();
    const events = await readEvents(opened.page);
    const checkpoint = events.find(
      (event) => event.type === "context.compacted",
    );
    expect(checkpoint?.content).toEqual(
      expect.objectContaining({
        strategy: "summary",
        sourceCount: expect.any(Number),
        sourceDigest: expect.any(String),
        summaryDigest: expect.any(String),
        branchIds: expect.any(Array),
      }),
    );
    expect(
      JSON.stringify(
        events.filter((event) => event.type === "conversation.message"),
      ),
    ).toContain("OLD_CONTEXT_MARKER");
    await composer.fill("continue");
    await composer.press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "COMPACTED_REPLY",
    );
    const final = [...provider.requests]
      .reverse()
      .find((request) => JSON.stringify(request.messages).includes("continue"));
    expect(JSON.stringify(final?.messages)).toContain(summary);
    expect(JSON.stringify(final?.messages)).not.toContain("OLD_CONTEXT_MARKER");
    await opened.page.getByTestId("conversation-menu").click();
    await startNewConversation(opened.page);
    await expect(opened.page.getByTestId("context-status")).toHaveCount(0);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});

test(
  "updates context while a reply is pending and when switching branches",
  { tag: "@user-journey" },
  async () => {
    let releaseReply!: () => void;
    const replyMayFinish = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    let releaseRetry!: () => void;
    const retryMayFinish = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const provider = await startProvider([
      delayedResponse(
        textResponse("LONG_BRANCH " + "page observation ".repeat(2_000)),
        0,
        replyMayFinish,
      ),
      textResponse("上下文分支测试"),
      commandResponse("list_tabs", {}, "retry-branch-tabs"),
      delayedResponse(textResponse("SHORT_BRANCH"), 0, retryMayFinish),
      { status: 400, error: "Regeneration rejected before any response" },
      commandResponse("list_tabs", {}, "edited-branch-tabs"),
      textResponse("EDITED_BRANCH_REPLY"),
      textResponse("RELOADED_BRANCH_REPLY"),
    ]);
    const opened = await openExtension();
    try {
      const options = await configure(
        opened.context,
        opened.page,
        provider.baseURL,
        100_000,
      );
      await options.close();
      const projection = () => opened.page.evaluate(async (dev) => {
        const { EventLogger, fromLogValue } = await import(`${dev}/src/logging.ts`);
        const { activeContext } = await import(`${dev}/src/agent/context-choice.ts`);
        const logger = new EventLogger();
        const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))))
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        try {
          const conversationId = (await logger.messageEvents()).at(-1).conversationId;
          const snapshot = await activeContext(logger, conversationId);
          return { branchIds: snapshot.branchIds, digest: await hash(snapshot.raw),
            lastText: snapshot.ui.at(-1)?.parts.filter((part: any) => part.type === "text").map((part: any) => part.text).join("").slice(0, 40),
            messages: await Promise.all(snapshot.raw.map(async (message: any) => ({ role: message.role, characters: JSON.stringify(message).length, digest: await hash(message) }))),
            supplemental: await Promise.all(snapshot.events.filter((event: any) => event.type === "model.context.appended").map(async (event: any) => {
              const content = fromLogValue(event.content, event.valueEncoding);
              return { eventId: event.id, runId: event.runId, anchorMessageId: content.anchorMessageId, partCount: content.partCount, digest: await hash(content.message) };
            })) };
        } finally { logger.dispose(); }
      }, process.env.SURFWAX_DEV_SERVER_URL!);
      const indicator = opened.page.getByTestId("context-indicator");
      await expect(indicator).toHaveAttribute("data-state", "ready");
      const initial = Number(await indicator.getAttribute("data-used-percent"));

      const composer = opened.page.getByTestId("composer-input");
      await composer.fill("pending request ".repeat(1_000));
      await composer.press("Enter");
      await expect(
        opened.page.getByRole("button", { name: "停止生成" }),
      ).toBeVisible();
      await expect
        .poll(async () =>
          Number(await indicator.getAttribute("data-used-percent")),
        )
        .toBeGreaterThan(initial);

      releaseReply();
      await expect(opened.page.locator(".markdown-body").last()).toContainText(
        "LONG_BRANCH",
      );
      await expect(opened.page.getByTestId("conversation-menu")).toContainText(
        "上下文分支测试",
      );
      await expect(
        opened.page.getByTestId("replay-message-button"),
      ).toBeVisible();
      let longPercent = 0;
      await expect
        .poll(async () => {
          longPercent = Number(
            await indicator.getAttribute("data-used-percent"),
          );
          return longPercent;
        })
        .toBeGreaterThan(initial + 5);
      const originalProjection = await projection();
      const observed = await opened.context.newPage();
      await observed.goto(`${provider.origin}/target`);
      await observed.evaluate(() => { document.title = "R2_CURRENT_TAB"; });
      await opened.page.getByTestId("replay-message-button").click();
      await expect(opened.page.getByRole("button", { name: "停止生成" })).toBeVisible();
      await expect(indicator).toHaveAttribute("data-state", "ready");
      await expect.poll(async () => Number(await indicator.getAttribute("data-used-percent"))).toBeLessThan(longPercent);
      releaseRetry();
      await expect(opened.page.locator(".markdown-body").last()).toContainText(
        "SHORT_BRANCH",
      );
      const agentRequests = () => provider.requests.filter(request => request.tools?.some((tool: any) => tool.function.name === "list_tabs"));
      for (const request of agentRequests().slice(1)) {
        const retryInput = JSON.stringify(request.messages);
        expect(retryInput).toContain("pending request");
        expect(retryInput).not.toContain("LONG_BRANCH");
        expect(retryInput).toContain("R2_CURRENT_TAB");
      }
      expect(JSON.stringify(agentRequests()[1].messages).match(/<browser-context>/g)).toHaveLength(1);
      expect(agentRequests()[2].messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "retry-branch-tabs" }));
      await expect
        .poll(async () =>
          Number(await indicator.getAttribute("data-used-percent")),
        )
        .toBeLessThan(longPercent);
      const beforeRejectedSwitch = await projection();
      const selectedBefore = (await readEvents(opened.page)).filter(event => event.type === "conversation.branch.selected");
      await opened.page.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        document.documentElement.dataset.rejectBranchStatus = "true";
        chrome.runtime.sendMessage = ((...args: any[]) => {
          if (args[0]?.type === "surf-wax:run-status" && document.documentElement.dataset.rejectBranchStatus === "true")
            return Promise.reject(new Error("branch-raw-marker stack-marker credential-marker"));
          return (send as any)(...args);
        }) as typeof chrome.runtime.sendMessage;
      });
      await opened.page.getByRole("button", { name: "上一个分支" }).last().click();
      await expect(opened.page.locator(".thread-warning")).toBeVisible();
      const failurePresentation = await opened.page.locator(".thread-warning").innerText();
      const afterRejectedSwitch = await projection();
      await test.info().attach("rejected-branch-switch", { contentType: "application/json", body: Buffer.from(JSON.stringify({ failurePresentation, beforeRejectedSwitch, afterRejectedSwitch })) });
      expect.soft(failurePresentation).not.toMatch(/branch-raw-marker|stack-marker|credential-marker/);
      expect.soft(failurePresentation).toContain("会话操作失败；请重试。");
      expect(afterRejectedSwitch.digest).toBe(beforeRejectedSwitch.digest);
      expect(afterRejectedSwitch.branchIds).toEqual(beforeRejectedSwitch.branchIds);
      expect((await readEvents(opened.page)).filter(event => event.type === "conversation.branch.selected")).toEqual(selectedBefore);
      await expect(opened.page.locator(".markdown-body").last()).toContainText("SHORT_BRANCH");
      await opened.page.evaluate(() => { document.documentElement.dataset.rejectBranchStatus = "false"; });
      await opened.page
        .getByRole("button", { name: "上一个分支" })
        .last()
        .click();
      await expect(opened.page.locator(".markdown-body").last()).toContainText(
        "LONG_BRANCH",
      );
      await expect(opened.page.locator(".thread-warning")).toHaveCount(0);
      await expect.poll(async () => (await projection()).lastText).toContain("LONG_BRANCH");
      const restoredProjection = await projection();
      await test.info().attach("context-branch-projections", { contentType: "application/json", body: Buffer.from(JSON.stringify({ originalProjection, restoredProjection }, null, 2)) });
      expect(restoredProjection.digest).toBe(originalProjection.digest);
      await expect
        .poll(async () =>
          Number(await indicator.getAttribute("data-used-percent")),
        )
        .toBe(longPercent);

      // A rejected retry must use the requested input while preserving the idle
      // selected reply, including after reopening its canonical history.
      await observed.evaluate(() => { document.title = "R3_FAILED_ATTEMPT_TAB"; });
      await opened.page.getByTestId("replay-message-button").click();
      await expect(opened.page.getByRole("button", { name: "发送消息" })).toBeVisible();
      await expect(opened.page.locator(".markdown-body").last()).toContainText("LONG_BRANCH");
      expect(agentRequests()).toHaveLength(4);
      expect(JSON.stringify(agentRequests()[3].messages)).not.toMatch(/LONG_BRANCH|SHORT_BRANCH/);
      expect(JSON.stringify(agentRequests()[3].messages)).toContain("R3_FAILED_ATTEMPT_TAB");
      expect(JSON.stringify(agentRequests()[3].messages).match(/<browser-context>/g)).toHaveLength(1);
      expect((await projection()).digest).toBe(originalProjection.digest);
      await opened.page.reload();
      await opened.page.getByTestId("conversation-menu").click();
      await opened.page.locator(".conversation-select").filter({ hasText: "上下文分支测试" }).click();
      await expect(opened.page.locator(".markdown-body").last()).toContainText("LONG_BRANCH");
      expect((await projection()).digest).toBe(originalProjection.digest);

      await opened.page.getByTestId("edit-message-button").click();
      await opened.page.getByTestId("edit-message-input").fill("EDITED_BRANCH_REQUEST");
      await opened.page.getByRole("button", { name: "保存并重新生成" }).click();
      await expect(opened.page.locator(".markdown-body").last()).toContainText("EDITED_BRANCH_REPLY");
      expect(agentRequests()).toHaveLength(6);
      for (const request of agentRequests().slice(4)) {
        const input = JSON.stringify(request.messages);
        expect(input).toContain("EDITED_BRANCH_REQUEST");
        expect(input).not.toMatch(/pending request|LONG_BRANCH|SHORT_BRANCH/);
      }
      expect(agentRequests()[5].messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "edited-branch-tabs" }));
      await opened.page.reload();
      await opened.page.getByTestId("conversation-menu").click();
      await opened.page.locator(".conversation-select").filter({ hasText: "上下文分支测试" }).click();
      await expect(opened.page.locator(".markdown-body").last()).toContainText("EDITED_BRANCH_REPLY");
      await opened.page.getByTestId("composer-input").fill("FOLLOWUP_AFTER_RELOAD");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("RELOADED_BRANCH_REPLY");
      const reloaded = JSON.stringify(agentRequests()[6].messages);
      expect(agentRequests()[6].messages.slice(0, agentRequests()[5].messages.length)).toEqual(agentRequests()[5].messages);
      expect(reloaded).toContain("EDITED_BRANCH_REQUEST");
      expect(reloaded).toContain("EDITED_BRANCH_REPLY");
      expect(reloaded).not.toMatch(/pending request|LONG_BRANCH|SHORT_BRANCH/);
      const canonical = JSON.stringify((await readEvents(opened.page)).filter(event => event.type === "conversation.message"));
      expect(canonical).toContain("LONG_BRANCH");
      expect(canonical).toContain("SHORT_BRANCH");
    } finally {
      releaseReply();
      releaseRetry();
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  },
);

test("anchors context usage to provider-reported input tokens", async () => {
  const provider = await startProvider([
    assistantResponse(
      {
        tool_calls: [
          {
            id: "call-usage-e2e",
            type: "function",
            function: { name: "list_tabs", arguments: "{}" },
          },
        ],
      },
      { promptTokens: 10_000, completionTokens: 5, cachedTokens: 3_000 },
    ),
    textResponse("USAGE_ANCHOR_REPLY", {
      promptTokens: 30_000,
      completionTokens: 5,
      cachedTokens: 12_000,
    }),
    textResponse("用量测试"),
    textResponse("SECOND_USAGE_REPLY", {
      promptTokens: 20_000,
      completionTokens: 5,
      cachedTokens: 7_000,
    }),
  ]);
  const opened = await openExtension();
  try {
    const options = await configure(
      opened.context,
      opened.page,
      provider.baseURL,
      100_000,
    );
    const indicator = opened.page.getByTestId("context-indicator");
    await expect(indicator).toHaveAttribute("data-state", "ready");

    await opened.page
      .getByTestId("composer-input")
      .fill("measure provider usage");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "USAGE_ANCHOR_REPLY",
    );
    await expect(
      opened.page.getByRole("button", { name: "发送消息" }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        Number(await indicator.getAttribute("data-used-percent")),
      )
      .toBeGreaterThanOrEqual(30);

    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-input")).toContainText(
      "40,000 tokens",
    );
    await expect(opened.page.getByTestId("context-output")).toContainText(
      "10 tokens",
    );
    await expect(opened.page.getByTestId("context-cache-read")).toContainText(
      "15,000 tokens",
    );

    await opened.page
      .getByTestId("composer-input")
      .fill("measure cumulative usage");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText(
      "SECOND_USAGE_REPLY",
    );
    await expect(
      opened.page.getByRole("button", { name: "发送消息" }),
    ).toBeVisible();
    await focusPageControl(opened.page, indicator);
    await expect(opened.page.getByTestId("context-input")).toContainText(
      "60,000 tokens",
    );
    await expect(opened.page.getByTestId("context-output")).toContainText(
      "15 tokens",
    );
    await expect(opened.page.getByTestId("context-cache-read")).toContainText(
      "22,000 tokens",
    );
    await options.close();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
