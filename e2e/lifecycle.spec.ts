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
      { name: "click", input: { target: { by: "role", value: "button", name: "Completed native action" } } },
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
        const completed = document.createElement("button");
        completed.textContent = "Completed native action";
        completed.onclick = () => document.documentElement.dataset.completedNativeCount = String(Number(document.documentElement.dataset.completedNativeCount ?? 0) + 1);
        document.body.append(completed);
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
        .toBe(3);
      await expect.poll(() => native.target.evaluate(() => document.documentElement.dataset.completedNativeCount)).toBe("1");
      await expect.poll(async () => (await readNativeEvents(native.panel)).some(event =>
        event.type === "browser.job.progress" && event.toolCallId === "native-queue-1"
        && event.content?.state === "not-dispatched")).toBe(true);
      const beforeClose = await readNativeEvents(native.panel);
      const starts = beforeClose.filter(event => event.type === "tool.started" && event.toolCallId?.startsWith("native-queue-"));
      expect(new Set(starts.map(event => event.runId)).size).toBe(1);
      expect(beforeClose.filter(event => ["tool.finished", "tool.failed"].includes(event.type) && event.toolCallId === "native-queue-1")).toHaveLength(0);
      const protocol = await opened.context.newCDPSession(native.target);
      let versionId: string | undefined;
      let stopped = false;
      protocol.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
        for (const version of versions) if (version.scriptURL.startsWith(`chrome-extension://${opened.extensionId}/`)) {
          if (version.runningStatus === "running") versionId = version.versionId;
          if (version.versionId === versionId && version.runningStatus === "stopped") stopped = true;
        }
      });
      await protocol.send("ServiceWorker.enable");
      await expect.poll(() => versionId).toBeTruthy();
      await native.panel.close();
      expect(
        (
          await native.browser.send("Target.closeTarget", {
            targetId: native.targetId,
          })
        ).success,
      ).toBe(true);
      await protocol.send("ServiceWorker.stopWorker", { versionId: versionId! });
      await expect.poll(() => stopped).toBe(true);
      await protocol.detach();
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
      await expect(recovery.getByTestId("composer-input")).toBeVisible();
      const assertRecovered = async () => {
        const events = await readEvents(recovery);
        for (const start of starts) {
          const terminals = events.filter(event => ["tool.finished", "tool.failed"].includes(event.type)
            && event.conversationId === start.conversationId && event.runId === start.runId && event.toolCallId === start.toolCallId
            && event.content?.callId === start.content?.callId);
          expect(terminals).toHaveLength(1);
          expect(terminals[0].type).toBe(start.toolCallId === "native-queue-0" ? "tool.finished" : "tool.failed");
          if (start.toolCallId !== "native-queue-0") expect(terminals[0].content?.status).toBe("interrupted");
        }
        expect(events.filter(event => event.type === "browser.job.progress" && event.toolCallId === "native-queue-2")).toHaveLength(0);
        expect(await native.target.evaluate(() => document.documentElement.dataset.completedNativeCount)).toBe("1");
        expect(await native.target.evaluate(() => document.documentElement.dataset.queuedNativeRan)).toBeUndefined();
        return events.filter(event => ["tool.finished", "tool.failed"].includes(event.type) && event.runId === starts[0].runId);
      };
      const recovered = await assertRecovered();
      await recovery.reload();
      await expect(recovery.getByTestId("composer-input")).toBeVisible();
      expect(await assertRecovered()).toEqual(recovered);
      await test.info().attach("native-lifecycle-recovery", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        stoppedWorker: versionId, workerStoppedObserved: stopped, sameRun: starts[0].runId,
        starts: starts.map(event => ({ id: event.id, toolCallId: event.toolCallId, callId: event.content?.callId })),
        beforeCloseTerminals: beforeClose.filter(event => ["tool.finished", "tool.failed"].includes(event.type)
          && event.runId === starts[0].runId).map(event => ({ id: event.id, type: event.type, toolCallId: event.toolCallId })),
        inflightProgress: beforeClose.filter(event => event.type === "browser.job.progress" && event.toolCallId === "native-queue-1")
          .map(event => ({ id: event.id, content: event.content })),
        terminals: recovered.map(({ id, type, runId, toolCallId, content, error, abort }) => ({ id, type, runId, toolCallId, content, error, abort })),
        completedEffects: 1, queuedEffects: 0, browserProcessRestart: false,
      }, null, 2)) });
      expect(provider.requests).toHaveLength(1);
    } finally {
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  },
);

test("a recoverable complete-response failure retries without repeating a completed browser effect", async () => {
  const effectId = "retry-effect-once";
  const remaining = "Inspect the final page state before accepting completion.";
  const rawReview = JSON.stringify({ accept: true, reason: "Current state still needs verification.", remaining: [remaining] }, null, 2);
  const completedGoal = (evidenceId: string) => ({ taskType: "browser", status: "completed", evidence: [{ evidenceId, observation: "The page shows the completed browser effect." }] });
  const provider = await startProvider([
    commandResponse(
      "click",
      {
        target: { by: "role", value: "button", name: "RETRY_EFFECT_ACCEPTED" },
      },
      effectId,
    ),
    { status: 503, error: "temporary full-response failure" },
    commandResponse("complete_goal", completedGoal(effectId), "inconsistent-completion", "RETRY_RESPONSE_COMPLETE"),
    (request) => {
      const output = JSON.parse(request.messages.findLast((message: any) => message.role === "tool").content);
      expect(output).toMatchObject({ ok: false, error: { code: "goal-incomplete" } });
      expect(output.error.message).toContain(remaining);
      return textResponse("PROGRESS_NOTE_ONLY");
    },
    () => {
      return commandResponse("inspect_page", { full: true }, "final-state");
    },
    (request) => {
      const output = JSON.parse(request.messages.findLast((message: any) => message.role === "tool").content);
      return commandResponse("complete_goal", completedGoal(output.evidenceId), "verified-completion");
    },
    textResponse("恢复请求"),
  ], 0, undefined, undefined, 0, 0, [rawReview, JSON.stringify({ accept: true, reason: "The final state is verified.", remaining: [] })]);
  const opened = await openExtension();
  let native: Awaited<ReturnType<typeof nativePanel>> | undefined;
  try {
    await (
      await configure(opened.context, opened.page, provider.baseURL, undefined, { goalMode: true })
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
    await expect
      .poll(
        async () =>
          (await readNativeEvents(native!.panel)).filter(
            (event) => event.type === "conversation.finished",
          ).length,
      )
      .toBe(1);
    await expect(native.target.locator("html")).toHaveAttribute(
      "data-retry-effects",
      "1",
    );
    const agentRequests = provider.requests.filter((request) =>
      request.tools?.some((tool: any) => tool.function.name === "click"),
    );
    expect(agentRequests).toHaveLength(6);
    expect(agentRequests[2].messages).toEqual(agentRequests[1].messages);
    const resumedContext = JSON.stringify(agentRequests[2].messages);
    expect(resumedContext).toContain("RETRY_EFFECT_ACCEPTED");
    expect(
      agentRequests[2].messages.filter(
        (message: any) =>
          message.role === "tool" && message.tool_call_id === effectId,
      ),
    ).toHaveLength(1);
    const events = await readNativeEvents(native.panel);
    expect(events.filter(event => event.type === "agent.goal.continued" && (event.content as { reason?: string })?.reason === "unfinished-goal")).toHaveLength(1);
    const reviews = events.filter(event => event.type === "agent.goal.review.finished");
    expect(reviews).toHaveLength(2);
    expect(reviews[0].content).toMatchObject({ accept: false, remaining: [remaining], responseText: rawReview, normalization: "accept-with-remaining" });
    expect(reviews[1].content).toMatchObject({ accept: true, remaining: [] });
    expect(events.filter(event => event.type === "agent.goal.review.failed")).toHaveLength(0);
    expect(events.find(event => event.type === "tool.failed" && event.toolCallId === "inconsistent-completion")?.output).toMatchObject({ ok: false, error: { code: "goal-incomplete" } });
    expect(provider.requests.filter(request => request.messages?.some((message: any) => message.role === "system" && String(message.content).startsWith("SURFWAX_GOAL_REVIEW")))).toHaveLength(2);
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

test("debugger cleanup quarantines delayed native calls without blocking another resource", async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  await opened.page.waitForLoadState("networkidle");
  const worker = opened.context.serviceWorkers().find(worker => new URL(worker.url()).hostname === opened.extensionId)!;
  try {
    const targets = await opened.page.evaluate(async () => {
      const tabs = await Promise.all([chrome.tabs.create({ url: "about:blank", active: false }), chrome.tabs.create({ url: "about:blank", active: false })]);
      const targets = await chrome.debugger.getTargets();
      return tabs.map(tab => ({ tabId: tab.id!, targetId: targets.find(target => target.tabId === tab.id)!.id }));
    });
    await worker.evaluate(() => {
      // Only the external native API is delayed. Production ports, ownership,
      // cleanup deadlines, IndexedDB and telemetry remain untouched.
      const gate = (globalThis as any).__debuggerGate = {
        method: "", tabId: -1, entered: 0, settled: 0, targetQueries: 0, rejectDetach: false, release: () => {},
      };
      const nativeTargets = chrome.debugger.getTargets.bind(chrome.debugger);
      (chrome.debugger as any).getTargets = async () => { gate.targetQueries++; return nativeTargets(); };
      for (const method of ["attach", "detach", "sendCommand"] as const) {
        const native = chrome.debugger[method].bind(chrome.debugger) as (...args: any[]) => Promise<void>;
        (chrome.debugger as any)[method] = async (...args: any[]) => {
          if (method === "detach" && gate.rejectDetach && args[0].tabId === gate.tabId)
            throw new Error("Injected native detach rejection");
          const held = gate.method === method && args[0].tabId === gate.tabId;
          if (held) {
            gate.entered++;
            await new Promise<void>(resolve => { gate.release = resolve; });
          }
          try { return await native(...args); }
          finally { if (held) gate.settled++; }
        };
      }
    });
    await opened.page.evaluate(() => {
      const harness = (globalThis as any).__debuggerLifecycle = {
        owners: new Map(), bridges: new Map(), aborted: false,
        async claim(name: string) {
          const owner = chrome.runtime.connect({ name: "surf-wax-run-owner" });
          harness.owners.set(name, owner);
          const identity = await new Promise<any>((resolve, reject) => {
            owner.onMessage.addListener(message => {
              if (message.type === "abort") harness.aborted = true;
              if (message.type === "claimed") message.error ? reject(new Error(message.error)) : resolve(message);
            });
            owner.postMessage({ type: "claim", runId: crypto.randomUUID(), ownerId: crypto.randomUUID(), conversationId: crypto.randomUUID() });
          });
          const port = chrome.runtime.connect({ name: "surf-wax-debugger" });
          const pending = new Map<string, (message: any) => void>();
          port.onMessage.addListener(message => {
            if (!message.id) return;
            pending.get(message.id)?.(message);
            pending.delete(message.id);
          });
          port.onDisconnect.addListener(() => {
            for (const resolve of pending.values()) resolve({ disconnected: true });
            pending.clear();
          });
          harness.bridges.set(name, { port, pending, identity });
        },
        request(name: string, method: string, args: unknown[]) {
          const { port, pending, identity } = harness.bridges.get(name);
          const id = crypto.randomUUID();
          return new Promise<any>(resolve => {
            pending.set(id, resolve);
            port.postMessage({ ...identity, id, method, args, operationId: crypto.randomUUID() });
          });
        },
        finish(name: string) { harness.owners.get(name).postMessage({ type: "finished" }); },
      };
    });
    const claim = (name: string) => opened.page.evaluate(name => (globalThis as any).__debuggerLifecycle.claim(name), name);
    const request = (name: string, method: string, args: unknown[]) => opened.page.evaluate(({ name, method, args }) => (globalThis as any).__debuggerLifecycle.request(name, method, args), { name, method, args });
    const finish = (name: string) => opened.page.evaluate(name => (globalThis as any).__debuggerLifecycle.finish(name), name);
    const idle = () => expect.poll(() => opened.page.evaluate(async () => (await chrome.runtime.sendMessage({ type: "surf-wax:run-status" })).identity ?? null)).toBeNull();
    const setGate = (method: string) => worker.evaluate(({ method, tabId }) => {
      const gate = (globalThis as any).__debuggerGate;
      Object.assign(gate, { method, tabId, entered: 0, settled: 0 });
    }, { method, tabId: targets[0].tabId });
    const release = () => worker.evaluate(() => {
      const gate = (globalThis as any).__debuggerGate;
      gate.method = "";
      gate.release();
    });
    const assertAlive = async (name: string, tabId: number) => {
      const reply = await request(name, "sendCommand", [{ tabId }, "Runtime.evaluate", { expression: "6 * 7", returnByValue: true }]);
      expect(reply.error).toBeUndefined();
      expect(reply.result.result.value).toBe(42);
    };

    await claim("old");
    for (const { tabId } of targets) expect((await request("old", "attach", [{ tabId }, "1.3"])).error).toBeUndefined();
    await setGate("detach");
    const cancelledAt = Date.now();
    await opened.page.evaluate(() => (globalThis as any).__debuggerLifecycle.owners.get("old").postMessage({ type: "cancelled" }));
    await expect.poll(() => opened.page.evaluate(() => (globalThis as any).__debuggerLifecycle.aborted)).toBe(true);
    expect((await request("old", "sendCommand", [{ tabId: targets[0].tabId }, "Runtime.evaluate", { expression: "1" }])).error).toContain("取消");
    const cancellationMs = Date.now() - cancelledAt;
    expect(cancellationMs).toBeLessThan(1_000);
    await opened.page.evaluate(() => (globalThis as any).__debuggerLifecycle.owners.get("old").disconnect());
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__debuggerGate.entered)).toBe(1);
    await idle();
    const ownerReleaseMs = Date.now() - cancelledAt;
    expect(ownerReleaseMs).toBeLessThan(4_000);
    await expect.poll(async () => (await readEvents(opened.page)).filter(event => event.type === "run.cleanup.failed" && event.content?.step === "cleanup-timeout").length).toBe(1);
    expect(await worker.evaluate(() => (globalThis as any).__debuggerGate.settled)).toBe(0);
    await claim("next");
    for (const debuggee of [{ tabId: targets[0].tabId }, { targetId: targets[0].targetId }]) {
      expect((await request("next", "attach", [debuggee, "1.3"])).error).toContain("resource-cleaning");
    }
    await expect.poll(async () => (await request("next", "attach", [{ tabId: targets[1].tabId }, "1.3"])).error ?? null).toBeNull();
    await assertAlive("next", targets[1].tabId);
    await release();
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__debuggerGate.settled)).toBe(1);
    await expect.poll(async () => (await request("next", "attach", [{ tabId: targets[0].tabId }, "1.3"])).error ?? null).toBeNull();
    await assertAlive("next", targets[0].tabId);

    // A normal detach must also exclude an overlapping reattach on this port,
    // including the targetId alias of the same tab.
    await setGate("detach");
    const detaching = request("next", "detach", [{ tabId: targets[0].tabId }]);
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__debuggerGate.entered)).toBe(1);
    expect((await request("next", "attach", [{ targetId: targets[0].targetId }, "1.3"])).error).toContain("resource-busy");
    await release();
    expect((await detaching).error).toBeUndefined();
    expect((await request("next", "attach", [{ targetId: targets[0].targetId }, "1.3"])).error).toBeUndefined();
    await assertAlive("next", targets[0].tabId);
    await setGate("sendCommand");
    const delayedCommand = request("next", "sendCommand", [{ tabId: targets[0].tabId }, "Runtime.evaluate", { expression: "globalThis.__lateCommand = true" }]);
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__debuggerGate.entered)).toBe(1);
    expect((await request("next", "detach", [{ targetId: targets[0].targetId }])).error).toBeUndefined();
    expect((await request("next", "attach", [{ tabId: targets[0].tabId }, "1.3"])).error).toContain("resource-busy");
    await release();
    expect((await delayedCommand).error).toBeTruthy();
    await expect.poll(async () => (await request("next", "attach", [{ tabId: targets[0].tabId }, "1.3"])).error ?? null).toBeNull();
    const untouched = await request("next", "sendCommand", [{ tabId: targets[0].tabId }, "Runtime.evaluate", { expression: "Boolean(globalThis.__lateCommand)", returnByValue: true }]);
    expect(untouched.result.result.value).toBe(false);
    await finish("next");
    await idle();

    // Cancellation can beat native attachment. Its late success still belongs
    // to the old lease and must be detached before the next run can reuse it.
    await claim("pending");
    await setGate("attach");
    const attaching = request("pending", "attach", [{ tabId: targets[0].tabId }, "1.3"]);
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__debuggerGate.entered)).toBe(1);
    expect((await request("pending", "attach", [{ targetId: targets[0].targetId }, "1.3"])).error).toContain("resource-busy");
    await finish("pending");
    await idle();
    await claim("after-pending");
    expect((await request("after-pending", "attach", [{ targetId: targets[0].targetId }, "1.3"])).error).toContain("resource-cleaning");
    expect((await request("after-pending", "attach", [{ tabId: targets[1].tabId }, "1.3"])).error).toBeUndefined();
    await release();
    expect(await attaching).toEqual({ disconnected: true });
    await expect.poll(async () => (await request("after-pending", "attach", [{ tabId: targets[0].tabId }, "1.3"])).error ?? null).toBeNull();
    await assertAlive("after-pending", targets[0].tabId);
    await finish("after-pending");
    await idle();

    // A rejected detach can leave the real native session attached. Preserve
    // quarantine, report recovery, and only admit the next owner after a
    // successful final detach of the old session.
    await claim("failed-detach");
    expect((await request("failed-detach", "attach", [{ tabId: targets[0].tabId }, "1.3"])).error).toBeUndefined();
    await worker.evaluate(() => { (globalThis as any).__debuggerGate.rejectDetach = true; });
    await finish("failed-detach");
    await idle();
    await expect.poll(async () => (await readEvents(opened.page)).filter(event => event.type === "run.cleanup.failed" && event.content?.step === "final-detach" && event.content?.recovery?.includes("关闭目标页")).length).toBeGreaterThan(0);
    expect(await opened.page.evaluate(async tabId => (await chrome.debugger.getTargets()).find(target => target.tabId === tabId)?.attached, targets[0].tabId)).toBe(true);
    await claim("after-failed-detach");
    expect((await request("after-failed-detach", "attach", [{ targetId: targets[0].targetId }, "1.3"])).error).toContain("resource-cleaning");
    expect((await request("after-failed-detach", "attach", [{ tabId: targets[1].tabId }, "1.3"])).error).toBeUndefined();
    await assertAlive("after-failed-detach", targets[1].tabId);
    await worker.evaluate(() => { (globalThis as any).__debuggerGate.rejectDetach = false; });
    expect((await request("after-failed-detach", "attach", [{ tabId: targets[0].tabId }, "1.3"])).error).toBeUndefined();
    await assertAlive("after-failed-detach", targets[0].tabId);
    await finish("after-failed-detach");
    await idle();

    // A real native click closes its script-opened source. Empty input
    // bookkeeping still names that tab, but settled cleanup must verify the
    // native target is gone instead of persisting a false unknown detach.
    const opener = await opened.context.newPage();
    await opener.goto(`${provider.origin}/target`);
    await opener.setContent(`<h1>Surviving portal</h1><button>Portal action</button><iframe src="${provider.origin}/target?portal-frame"></iframe>`);
    const sourceUrl = `${provider.origin}/target?self-closing-cleanup`;
    const popupEvent = opener.waitForEvent("popup");
    await opener.evaluate(url => window.open(url, "_blank", "popup,width=900,height=700"), sourceUrl);
    const source = await popupEvent;
    await source.waitForLoadState();
    await source.setContent('<button onclick="setTimeout(()=>window.close(),100)">Close source</button>');
    const pages = await opened.page.evaluate(async ({ sourceUrl, portalUrl }) => {
      const tabs = await chrome.tabs.query({});
      const source = tabs.find(tab => tab.url === sourceUrl)!;
      const portal = tabs.find(tab => tab.url === portalUrl)!;
      return { source: { tabId: source.id!, windowId: source.windowId }, portal: { tabId: portal.id!, windowId: portal.windowId } };
    }, { sourceUrl, portalUrl: `${provider.origin}/target` });
    const sourceTabId = pages.source.tabId;
    expect(pages.source.windowId).not.toBe(pages.portal.windowId);
    const selfClosedIdentity = await opened.page.evaluate(async ({ dev, sourceTabId }) => {
      const { ChromeExecutor } = await import(`${dev}/src/chrome/executor.ts`);
      const { createProgramTools } = await import(`${dev}/src/chrome/tool.ts`);
      const { EventLogger } = await import(`${dev}/src/logging.ts`);
      const { claimConversationRun, getRunIdentity } = await import(`${dev}/src/agent/coordinator.ts`);
      const harness = (globalThis as any).__debuggerLifecycle;
      const conversationId = crypto.randomUUID();
      const lease = await claimConversationRun(conversationId);
      const identity = getRunIdentity()!;
      const logger = new EventLogger();
      logger.beginRun(conversationId, identity.runId);
      const executor = new ChromeExecutor({ logger });
      await executor.beginRun();
      // Bind through the real selection operation before the window closes;
      // do not replace browserState or the native Chrome API in this regression.
      await executor.switchTab(sourceTabId);
      const tools = createProgramTools(executor, { logger, conversationId, runSignal: lease.signal });
      harness.observation = { executor, logger, lease, async call(name: string, input: unknown = {}) {
        return tools[name].execute(input, { toolCallId: crypto.randomUUID(), messages: [], context: {} });
      } };
      return identity;
    }, { dev: process.env.SURFWAX_DEV_SERVER_URL!, sourceTabId });
    const sourceClosed = source.waitForEvent("close");
    const clicked = await opened.page.evaluate(sourceTabId => (globalThis as any).__debuggerLifecycle.observation.call("click", {
      tabId: sourceTabId, target: { by: "role", value: "button", name: "Close source", exact: true },
    }), sourceTabId);
    expect(clicked, JSON.stringify(clicked)).toMatchObject({ ok: true, result: { performed: true } });
    await sourceClosed;
    await expect.poll(() => opened.page.evaluate(id => chrome.windows.get(id).then(() => true, () => false), pages.source.windowId)).toBe(false);
    const reads = await opened.page.evaluate(async ({ portalTabId, sourceTabId }) => {
      const { call } = (globalThis as any).__debuggerLifecycle.observation;
      const target = { by: "role", value: "button", name: "Portal action", exact: true };
      const results: Record<string, any> = {};
      results.defaultClosed = await call("inspect_page", { full: true });
      results.tabs = await call("list_tabs");
      results.explicitInspect = await call("inspect_page", { tabId: portalTabId, full: true });
      results.explicitFind = await call("find_elements", { tabId: portalTabId, target });
      results.explicitFrames = await call("list_frames", { tabId: portalTabId });
      results.explicitSubscribe = await call("subscribe_event", { tabId: portalTabId, kind: "console" });
      await chrome.scripting.executeScript({ target: { tabId: portalTabId }, func: () => console.log("SURVIVING_PORTAL_CONSOLE") });
      results.consoleEvent = await call("wait_event", { subscriptionId: results.explicitSubscribe.subscriptionId, waitMs: 1_000 });
      await call("unsubscribe_event", { subscriptionId: results.explicitSubscribe.subscriptionId });
      for (const [name, input] of [
        ["inspect_page", { full: true }], ["find_elements", { target }],
        ["list_frames", {}], ["subscribe_event", { kind: "console" }],
      ] as const) results[`invalid:${name}`] = await call(name, { ...input, tabId: sourceTabId });
      // Explicit observations do not silently move the default binding.
      results.defaultStillClosed = await call("inspect_page", { full: true });
      results.switched = await call("switch_tab", { tabId: portalTabId });
      results.defaultInspect = await call("inspect_page", { full: true });
      results.defaultFind = await call("find_elements", { target });
      results.defaultFrames = await call("list_frames");
      results.defaultSubscribe = await call("subscribe_event", { kind: "console" });
      await call("unsubscribe_event", { subscriptionId: results.defaultSubscribe.subscriptionId });
      return results;
    }, { portalTabId: pages.portal.tabId, sourceTabId });
    for (const key of ["defaultClosed", "defaultStillClosed"]) {
      expect(reads[key]).toMatchObject({ ok: false, error: { code: "window-closed", recovery: expect.stringContaining("switch_tab") } });
    }
    expect(reads.tabs.result.some((tab: any) => tab.id === pages.portal.tabId && tab.windowId === pages.portal.windowId)).toBe(true);
    for (const key of ["explicitInspect", "defaultInspect"]) {
      expect(reads[key].ok, JSON.stringify(reads[key])).not.toBe(false);
      expect(JSON.stringify(reads[key])).toContain("Surviving portal");
    }
    for (const key of ["explicitFind", "defaultFind"]) expect(reads[key].elements).toHaveLength(1);
    for (const key of ["explicitFrames", "defaultFrames"]) expect(reads[key].frames.length).toBeGreaterThan(0);
    for (const key of ["explicitSubscribe", "defaultSubscribe"]) expect(reads[key].subscriptionId).toEqual(expect.any(String));
    expect(JSON.stringify(reads.consoleEvent)).toContain("SURVIVING_PORTAL_CONSOLE");
    for (const key of Object.keys(reads).filter(key => key.startsWith("invalid:"))) {
      expect(reads[key]).toMatchObject({ ok: false });
      expect(reads[key].error.code).not.toBe("window-closed");
    }
    expect(reads.switched.result.find((tab: any) => tab.id === pages.portal.tabId)).toMatchObject({ current: true });
    await test.info().attach("closed-window-explicit-targets", { body: JSON.stringify({ pages, reads }, null, 2), contentType: "application/json" });
    // The public executor has its own normal UI-side teardown reads. Measure
    // the background finalization separately, as in the original raw-port case.
    await opened.page.evaluate(() => (globalThis as any).__debuggerLifecycle.observation.executor.endRun());
    const targetQueriesBeforeCleanup = await worker.evaluate(() => (globalThis as any).__debuggerGate.targetQueries);
    await opened.page.evaluate(async () => {
      const { executor, logger, lease } = (globalThis as any).__debuggerLifecycle.observation;
      executor.dispose(); logger.dispose(); lease.finish();
      delete (globalThis as any).__debuggerLifecycle.observation;
    });
    await idle();
    const selfClosedEvents = (await readEvents(opened.page)).filter(event => event.runId === selfClosedIdentity.runId);
    const cleanupTargetQueries = await worker.evaluate(() => (globalThis as any).__debuggerGate.targetQueries) - targetQueriesBeforeCleanup;
    expect(cleanupTargetQueries).toBe(1);
    expect(selfClosedEvents.filter(event => event.type === "run.cleanup.failed")).toEqual([]);
    expect(selfClosedEvents.some(event => event.type === "browser.input.state" && !event.content.keys.length && !event.content.buttons.length)).toBe(true);
    await claim("after-self-closed");
    expect((await request("after-self-closed", "attach", [{ tabId: targets[1].tabId }, "1.3"])).error).toBeUndefined();
    await assertAlive("after-self-closed", targets[1].tabId);
    await finish("after-self-closed");
    await idle();
    await test.info().attach("self-closed-debugger-cleanup", {
      body: JSON.stringify({ sourceTabId, runIdentity: selfClosedIdentity, nativeInputAcknowledged: !clicked.error, cleanupTargetQueries,
        cleanupFailures: selfClosedEvents.filter(event => event.type === "run.cleanup.failed"),
        inputStates: selfClosedEvents.filter(event => event.type === "browser.input.state"),
        followingRunOtherResourceUsable: true }, null, 2), contentType: "application/json",
    });
    await test.info().attach("debugger-cleanup-timing", {
      body: JSON.stringify({ cancellationMs, ownerReleaseMs, resources: targets, delayedDetachSettledBeforeOwnerRelease: false,
        scenarios: ["delayed teardown", "tab/target aliases", "independent resource", "normal detach", "late command", "pending attach", "rejected detach recovery", "self-closed settled cleanup"] }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await opened.page.evaluate(async () => {
      const observation = (globalThis as any).__debuggerLifecycle?.observation;
      if (observation) try { await observation.executor.endRun(); }
      finally { observation.executor.dispose(); observation.logger.dispose(); observation.lease.finish(); }
    }).catch(() => undefined);
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
