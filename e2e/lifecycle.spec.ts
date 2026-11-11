import { expect } from "@playwright/test";
import {
  assistantResponse,
  attachTarget,
  commandResponse,
  configure,
  dispose,
  nativePanel,
  openExtension,
  readEvents,
  readNativeEvents,
  startProvider,
  submitNative,
  test,
  textResponse,
} from "./fixtures";

function nativeAssistantText(panel: Awaited<ReturnType<typeof attachTarget>>) {
  return panel.evaluate<string>(`Array.from(document.querySelectorAll('[data-role="assistant"]'))
    .map(element => element.textContent || '').join('\\n')`);
}

test(
  "closing a native Side Panel aborts its owner and prevents a queued page mutation",
  { tag: "@user-journey" },
  async () => {
    const calls = [
      {
        name: "verify_state",
        input: {
          target: { by: "label", value: "Never exists" },
          state: "visible",
          timeoutMs: 300_000,
        },
      },
      {
        name: "click",
        input: {
          target: { by: "role", value: "button", name: "Queued native action" },
        },
      },
    ];
    const provider = await startProvider([
      assistantResponse({
        tool_calls: calls.map((call, index) => ({
          id: `native-queue-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      }),
    ]);
    const opened = await openExtension();
    try {
      await (
        await configure(opened.context, opened.page, provider.baseURL)
      ).close();
      const native = await nativePanel(opened, `${provider.origin}/target`);
      await native.target.evaluate(() => {
        const button = document.createElement("button");
        button.textContent = "Queued native action";
        button.onclick = () => {
          document.documentElement.dataset.queuedNativeRan = "yes";
        };
        document.body.append(button);
      });
      await submitNative(native.panel, "perform two queued actions");
      await expect
        .poll(() =>
          native.panel.evaluate<boolean>(
            'document.body.textContent.includes("检查页面状态")',
          ),
        )
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await readNativeEvents(native.panel)).filter(
              (event) =>
                event.type === "tool.started" &&
                event.toolCallId?.startsWith("native-queue-"),
            ).length,
        )
        .toBe(2);
      await native.panel.close();
      expect(
        (
          await native.browser.send("Target.closeTarget", {
            targetId: native.targetId,
          })
        ).success,
      ).toBe(true);
      await expect
        .poll(() =>
          native.target.evaluate(
            () => document.documentElement.dataset.queuedNativeRan,
          ),
        )
        .toBeUndefined();
      const recovery = await opened.context.newPage();
      await recovery.goto(
        `chrome-extension://${opened.extensionId}/sidepanel.html`,
      );
      await expect
        .poll(
          async () =>
            (await readEvents(recovery)).filter(
              (event) =>
                event.type === "tool.failed" &&
                event.toolCallId?.startsWith("native-queue-"),
            ).length,
        )
        .toBe(2);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  },
);

test("a recoverable complete-response failure retries without repeating a completed browser effect", async () => {
  const effectId = "retry-effect-once";
  const provider = await startProvider([
    commandResponse(
      "click",
      {
        target: { by: "role", value: "button", name: "RETRY_EFFECT_ACCEPTED" },
      },
      effectId,
    ),
    { status: 503, error: "temporary full-response failure" },
    textResponse("RETRY_RESPONSE_COMPLETE"),
    textResponse("恢复请求"),
  ]);
  const opened = await openExtension();
  let native: Awaited<ReturnType<typeof nativePanel>> | undefined;
  try {
    await (
      await configure(opened.context, opened.page, provider.baseURL)
    ).close();
    native = await nativePanel(opened, `${provider.origin}/target`);
    await native.target.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "RETRY_EFFECT_ACCEPTED";
      button.onclick = () => {
        const root = document.documentElement;
        root.dataset.retryEffects = String(
          Number(root.dataset.retryEffects || 0) + 1,
        );
      };
      document.body.append(button);
    });
    await submitNative(
      native.panel,
      "record one browser effect and retry a temporary full-response failure",
    );
    await expect
      .poll(() => nativeAssistantText(native!.panel))
      .toContain("RETRY_RESPONSE_COMPLETE");
    await expect(native.target.locator("html")).toHaveAttribute(
      "data-retry-effects",
      "1",
    );
    const agentRequests = provider.requests.filter((request) =>
      request.tools?.some((tool: any) => tool.function.name === "click"),
    );
    expect(agentRequests).toHaveLength(3);
    expect(agentRequests[2].messages).toEqual(agentRequests[1].messages);
    const resumedContext = JSON.stringify(agentRequests[2].messages);
    expect(resumedContext).toContain("RETRY_EFFECT_ACCEPTED");
    expect(
      agentRequests[2].messages.filter(
        (message: any) =>
          message.role === "tool" && message.tool_call_id === effectId,
      ),
    ).toHaveLength(1);
    await expect
      .poll(
        async () =>
          (await readNativeEvents(native!.panel)).filter(
            (event) => event.type === "conversation.finished",
          ).length,
      )
      .toBe(1);
    const events = await readNativeEvents(native.panel);
    const started = events.filter(
      (event) => event.type === "tool.started" && event.toolCallId === effectId,
    );
    const terminal = events.filter(
      (event) =>
        ["tool.finished", "tool.failed"].includes(event.type) &&
        event.toolCallId === effectId,
    );
    expect(started).toHaveLength(1);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("tool.finished");
    expect(
      events.filter((event) => event.type === "request.retry"),
    ).toMatchObject([{ retry: { attempt: 1, status: 503 } }]);
    expect(
      JSON.stringify(
        events.filter((event) => event.type === "conversation.message"),
      ),
    ).toContain("RETRY_RESPONSE_COMPLETE");
    expect(
      events.filter((event) =>
        ["conversation.failed", "conversation.aborted"].includes(event.type),
      ),
    ).toHaveLength(0);
  } finally {
    await native?.panel.close();
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
