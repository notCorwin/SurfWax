import { gunzipSync } from "node:zlib";
import bundledCatalog from "../src/data/models-dev-api";
import {
  assistantResponse,
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
    const provider = await startProvider([
      delayedResponse(
        textResponse("LONG_BRANCH " + "page observation ".repeat(2_000)),
        0,
        replyMayFinish,
      ),
      textResponse("上下文分支测试"),
      textResponse("SHORT_BRANCH"),
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

      await opened.page.getByTestId("replay-message-button").click();
      await expect(opened.page.locator(".markdown-body").last()).toContainText(
        "SHORT_BRANCH",
      );
      await expect
        .poll(async () =>
          Number(await indicator.getAttribute("data-used-percent")),
        )
        .toBeLessThan(longPercent);
      await opened.page
        .getByRole("button", { name: "上一个分支" })
        .last()
        .click();
      await expect(opened.page.locator(".markdown-body").last()).toContainText(
        "LONG_BRANCH",
      );
      await expect
        .poll(async () =>
          Number(await indicator.getAttribute("data-used-percent")),
        )
        .toBe(longPercent);
    } finally {
      releaseReply();
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
