import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventLogger } from "../src/logging";
import { createMemoryEventStore } from "../src/memory-event-store";
import { actionHistory, runEvidence } from "../src/agent/goal-completion";
import {
  assistantResponse,
  commandResponse,
  configure,
  dispose,
  openExtension,
  readEvents,
  startProvider,
  test,
  textResponse,
  type MockResponse,
} from "./fixtures";

// This is a deterministic execution-contract probe, not a model benchmark:
// every tool choice below is scripted. Actual provider usage is unavailable.
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const lastTool = (request: any) => {
  const content = request.messages.findLast(
    (message: any) => message.role === "tool",
  )?.content;
  return JSON.parse(
    Array.isArray(content)
      ? content.find((part: any) => part.type === "text").text
      : content,
  );
};
const head = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};
const dirty = () => {
  try {
    return (
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0
    );
  } catch {
    return null;
  }
};

for (const seed of [17])
  test(`scripted complex task: cross-frame order recovery (seed ${seed})`, async () => {
    test.setTimeout(90_000);
    const responses: MockResponse[] = [];
    const provider = await startProvider(responses);
    const opened = await openExtension();
    const started = Date.now();
    let businessVerified = false,
      frameRef = "",
      buttonRef = "",
      actual: unknown,
      events: any[] = [];
    const checkpoints: Record<string, unknown> = {};
    const order = `ORDER-${seed}`;
    const service = seed === 17 ? "express" : "economy";
    const callIds = [
      "frames",
      "find-submit",
      "invalid-service",
      "read-after-failure",
      "choose-service",
      "enter-order",
      "confirm-checkbox",
      "submit-order",
      "verify-status",
    ];
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/complex`);
      await target.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>(
          "iframe[src*=localhost]",
        )!;
        document.querySelector<HTMLIFrameElement>(
          'iframe[src="/same-frame"]',
        )!.style.display = "none";
        frame.style.cssText = "width:540px;height:360px;transform:none";
        const decoy = document.createElement("button");
        decoy.textContent = "Submit order";
        decoy.onclick = () => {
          document.body.dataset.decoyClicks = String(
            Number(document.body.dataset.decoyClicks || 0) + 1,
          );
        };
        document.body.append(decoy);
      });
      const frame = target
        .frames()
        .find((item) => item.url().includes("localhost"))!;
      await frame.evaluate(() => {
        document.body.innerHTML = `<label>Order reference <input id="order"></label>
        <label>Service <select id="service"><option value="standard">Standard</option><option value="express">Express</option><option value="economy">Economy</option></select></label>
        <label><input type="checkbox" id="confirmed"> Confirm details</label>
        <button id="submit">Submit order</button><output id="status">Not submitted</output>`;
        const changes: string[] = [];
        document
          .querySelector<HTMLSelectElement>("#service")!
          .addEventListener("change", (event) =>
            changes.push((event.target as HTMLSelectElement).value),
          );
        (window as any).businessChanges = changes;
        (window as any).businessOrders = [];
        document.querySelector<HTMLButtonElement>("#submit")!.onclick = () => {
          const submitted = {
            order: document.querySelector<HTMLInputElement>("#order")!.value,
            service:
              document.querySelector<HTMLSelectElement>("#service")!.value,
            confirmed:
              document.querySelector<HTMLInputElement>("#confirmed")!.checked,
          };
          (window as any).businessOrders.push(submitted);
          document.querySelector("#status")!.textContent =
            "Submitted " + submitted.order;
          document.querySelector("#submit")!.remove();
        };
      });
      const targetInFrame = (by: string, value: string) => ({
        by,
        value,
        frame: { ref: frameRef },
      });
      responses.push(
        commandResponse("list_frames", {}, callIds[0]!),
        (request) => {
          const result = lastTool(request);
          frameRef =
            result.frames?.find((entry: any) => entry.url.includes("localhost"))
              ?.frameRef ?? "missing-frame";
          checkpoints.frames = result;
          return commandResponse(
            "find_elements",
            {
              target: {
                ...targetInFrame("role", "button"),
                name: "Submit order",
              },
            },
            callIds[1]!,
          );
        },
        (request) => {
          const result = lastTool(request);
          buttonRef = result.elements?.[0]?.id ?? "missing-ref";
          checkpoints.find = { total: result.total, ref: buttonRef };
          return commandResponse(
            "select_option",
            {
              target: targetInFrame("css", "#service"),
              value: "not-an-option",
            },
            callIds[2]!,
          );
        },
        (request) => {
          checkpoints.failedSelection = lastTool(request);
          return commandResponse(
            "read_value",
            { target: targetInFrame("css", "#service") },
            callIds[3]!,
          );
        },
        (request) => {
          checkpoints.afterFailure = lastTool(request);
          return commandResponse(
            "select_option",
            { target: targetInFrame("css", "#service"), value: service },
            callIds[4]!,
          );
        },
        (request) => {
          checkpoints.selection = lastTool(request);
          return commandResponse(
            "fill",
            { target: targetInFrame("css", "#order"), value: order },
            callIds[5]!,
          );
        },
        (request) => {
          checkpoints.fill = lastTool(request);
          return commandResponse(
            "check_element",
            { target: targetInFrame("css", "#confirmed") },
            callIds[6]!,
          );
        },
        (request) => {
          checkpoints.check = lastTool(request);
          return commandResponse(
            "click",
            { target: { id: buttonRef } },
            callIds[7]!,
          );
        },
        (request) => {
          checkpoints.submit = lastTool(request);
          return commandResponse(
            "verify_state",
            {
              target: targetInFrame("css", "#status"),
              textIncludes: `Submitted ${order}`,
            },
            callIds[8]!,
          );
        },
        (request) => {
          const result = lastTool(request);
          checkpoints.verify = result;
          return assistantResponse({ content: "SCRIPTED_TASK_DONE", tool_calls: [{ id: "complete-order", type: "function", function: {
            name: "complete_goal", arguments: JSON.stringify({ taskType: "browser", status: "completed", evidence: [
              { evidenceId: (checkpoints.frames as any).evidenceId, observation: "The initial frame observation identified the checkout before submission." },
              { evidenceId: result.evidenceId, observation: "The final status confirms the requested order was submitted." },
            ] }),
          } }] });
        },
        textResponse("跨框架订单"),
      );
      await (
        await configure(opened.context, opened.page, provider.baseURL, undefined, { goalMode: true })
      ).close();
      await target.bringToFront();
      await opened.page
        .getByTestId("composer-input")
        .fill(
          `Submit order ${order} using ${service} service and confirm details.`,
        );
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText(
        "SCRIPTED_TASK_DONE",
        { timeout: 60_000 },
      );

      await expect.poll(async () => (await readEvents(opened.page)).filter(event => event.type === "conversation.finished").length).toBe(1);
      await expect(frame.locator("#submit")).toHaveCount(0);

      // The business judge reads the application state independently of the LLM
      // and of tool receipts; the model's final text is never the pass criterion.
      actual = await frame.evaluate(() => ({
        orders: (window as any).businessOrders,
        changes: (window as any).businessChanges,
        selected: document.querySelector<HTMLSelectElement>("#service")!.value,
      }));
      expect(actual).toEqual({
        orders: [{ order, service, confirmed: true }],
        changes: [service],
        selected: service,
      });
      expect(
        await target.locator("body").getAttribute("data-decoy-clicks"),
      ).toBeNull();
      expect(checkpoints.failedSelection).toMatchObject({ ok: false });
      expect(checkpoints.afterFailure).toMatchObject({
        ok: true,
        result: "standard",
      });
      expect(checkpoints.find).toMatchObject({
        total: 1,
        ref: expect.any(String),
      });
      expect(checkpoints.verify).toMatchObject({
        ok: true,
        result: { verified: true },
      });
      events = await readEvents(opened.page);
      const reviewRequest = provider.requests.find(request => request.messages?.some((message: any) => message.role === "system" && String(message.content).startsWith("SURFWAX_GOAL_REVIEW")));
      expect(reviewRequest).toBeTruthy();
      const reviewInput = JSON.parse(reviewRequest!.messages.findLast((message: any) => message.role === "user").content);
      const submitted = reviewInput.actionHistory.find((entry: any) => entry.receipt?.input?.target?.id === buttonRef);
      const attempt = events.find(event => event.type === "automation.action.attempt" && event.toolCallId === "submit-order" && event.content?.reason === "actionable");
      expect(submitted?.receipt).toMatchObject({ observedTargets: [{ source: "automation.action.attempt", order: attempt!.id, role: "button", name: "Submit order", ref: buttonRef }] });
      expect(submitted.receipt.labels?.target).toBeUndefined();
      // A fresh projection must retain the same identity from durable events,
      // even though the successful action removed the button from the page.
      const replay = new EventLogger({ store: createMemoryEventStore(structuredClone(events)) });
      const finished = events.find(event => event.type === "conversation.finished")!;
      const replayed = actionHistory(await runEvidence(replay, finished.conversationId, finished.runId));
      expect(replayed.find(entry => entry.receipt.input?.target && (entry.receipt.input.target as any).id === buttonRef)?.receipt.observedTargets).toEqual(submitted.receipt.observedTargets);
      expect(reviewInput.context.evidenceOrder).toContain("other entries newest first");
      const observed = reviewInput.context.excerpts.filter((entry: any) => entry.role !== "user");
      const resultExcerpt = (toolCallId: string) => observed.findIndex((entry: any) => entry.excerpt.some((part: any) => part.type === "tool-result" && part.toolCallId === toolCallId));
      expect(resultExcerpt("frames")).toBeGreaterThan(resultExcerpt("submit-order"));
      expect(resultExcerpt("verify-status")).toBeLessThan(resultExcerpt("submit-order"));
      expect(observed.every((entry: any) => Number.isSafeInteger(entry.order))).toBe(true);
      expect(observed.map((entry: any) => entry.order)).toEqual(observed.map((entry: any) => entry.order).sort((left: number, right: number) => right - left));
      const terminals = events.filter(
        (event) =>
          ["tool.finished", "tool.failed"].includes(event.type) &&
          callIds.includes(event.toolCallId),
      );
      for (const id of callIds)
        expect(
          terminals.filter((event) => event.toolCallId === id),
          `terminal result for ${id}`,
        ).toHaveLength(1);
      const requests = provider.requests.filter((request) =>
        Array.isArray(request.tools),
      );
      expect(requests).toHaveLength(callIds.length + 1);
      expect(
        requests.every(
          (request) => digest(request.tools) === digest(requests[0].tools),
        ),
      ).toBe(true);
      expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(
        expect.arrayContaining([
          "list_frames",
          "find_elements",
          "select_option",
          "read_value",
          "fill",
          "check_element",
          "click",
          "verify_state",
        ]),
      );
      businessVerified = true;
    } finally {
      // Preserve failed attempts and their request costs, rather than reporting
      // successful runs only. These are JSON-byte measures, not billed tokens.
      if (!events.length)
        events = await readEvents(opened.page).catch(() => []);
      const requests = provider.requests.filter((request) =>
        Array.isArray(request.tools),
      );
      const schemas = requests.map((request) => digest(request.tools));
      const systemMessages =
        requests[0]?.messages?.filter(
          (message: any) => message.role === "system",
        ) ?? [];
      const browser = await opened.context
        .newCDPSession(opened.page)
        .then((session) => session.send("Browser.getVersion"))
        .catch(() => null);
      const report = {
        scenario: "cross-frame-order-recovery",
        seed,
        execution: "scripted-mock-provider",
        businessVerified,
        scenarioWallClockMsIncludingSetup: Date.now() - started,
        gitHead: head(),
        gitDirty: dirty(),
        browser: browser?.product ?? null,
        provider: "mock-openai-compatible",
        model: "test-model",
        providerUsage: null,
        providerUsageReason:
          "The scripted provider did not report actual model usage; request bytes are not token counts.",
        toolCatalogHash: schemas[0] ?? null,
        toolCatalogStableAcrossRequests: schemas.every(
          (hash) => hash === schemas[0],
        ),
        toolCatalogBytes: requests[0] ? byteSize(requests[0].tools) : null,
        systemMessagesHash: digest(systemMessages),
        modelRequests: requests.length,
        reserializedRequestBytes: requests.reduce(
          (sum, request) => sum + byteSize(request),
          0,
        ),
        toolTerminalCounts: {
          succeeded: events.filter(
            (event) =>
              event.type === "tool.finished" &&
              callIds.includes(event.toolCallId),
          ).length,
          failed: events.filter(
            (event) =>
              event.type === "tool.failed" &&
              callIds.includes(event.toolCallId),
          ).length,
        },
        expectedToolCalls: callIds.length,
        observedTerminalResults: events.filter(
          (event) =>
            ["tool.finished", "tool.failed"].includes(event.type) &&
            callIds.includes(event.toolCallId),
        ).length,
        actual,
        checkpoints,
      };
      await test
        .info()
        .attach("scripted-complex-task-report", {
          body: JSON.stringify(report, null, 2),
          contentType: "application/json",
        });
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  });
