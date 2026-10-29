import { describe, expect, it, vi } from "vitest";
import { ForegroundBlockers, type BlockedEvidence, type ObservedDialog } from "./foreground-blockers";

const owner = { conversationId: "conversation", runId: "run" };
const otherOwner = { conversationId: "conversation", runId: "other" };
const dialog = (tabId: number, dialogId = "dialog"): ObservedDialog => ({ dialogId, source: { tabId, sessionId: "child-frame" }, type: "prompt", message: "Question?" });
function latch<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("foreground dialog blockers", () => {
  it("only wakes a matching live operation after its association is durable", async () => {
    const receipt = latch<number>();
    const persist = vi.fn(async (_evidence: BlockedEvidence) => receipt.promise);
    const coordinator = new ForegroundBlockers(persist);
    const job = coordinator.begin(owner, "job");
    const operation = coordinator.startOperation(job, "page.click", { tabId: 4 });
    coordinator.markDispatched(operation, { tabId: 4 });
    let resolved = false;
    const waiting = coordinator.wait(job).then((outcome) => { resolved = true; return outcome; });
    const recording = coordinator.observeDialog(owner, dialog(4));
    expect(coordinator.knownDialogs(owner, 4)).toEqual([dialog(4)]);
    expect(resolved).toBe(false);
    expect(persist).toHaveBeenCalledWith({ owner, jobId: "job", dialog: dialog(4), operations: [{ operation: "page.click", source: { tabId: 4 }, dispatched: true }] });
    receipt.resolve(17);
    await recording;
    await expect(waiting).resolves.toEqual({ status: "blocked", jobId: "job", dialog: dialog(4), evidenceId: 17, operationDispatchedAtObservation: true });
  });

  it("does not associate a dialog with another tab or run, while retaining its actual source session", async () => {
    const persist = vi.fn(async () => 5);
    const coordinator = new ForegroundBlockers(persist);
    const job = coordinator.begin(owner, "job");
    coordinator.startOperation(job, "page.click", { tabId: 4 });
    await coordinator.observeDialog(owner, dialog(5, "other-tab"));
    await coordinator.observeDialog(otherOwner, dialog(4, "other-run"));
    expect(persist).not.toHaveBeenCalled();
    expect(coordinator.knownDialogs(owner, 5)).toEqual([dialog(5, "other-tab")]);
    expect(coordinator.knownDialogs(owner, 4)).toEqual([]);
    coordinator.settle(job);
    await expect(coordinator.wait(job)).resolves.toEqual({ status: "settled" });
  });

  it("retains observed dialogs without subscriptions, but never treats an empty list as proof of absence", async () => {
    const persist = vi.fn(async () => 1);
    const coordinator = new ForegroundBlockers(persist);
    await coordinator.observeDialog(owner, dialog(4));
    expect(coordinator.knownDialogs(owner, 4)).toEqual([dialog(4)]);
    expect(coordinator.knownDialogs(otherOwner, 4)).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    coordinator.closeDialog(owner, "dialog");
    expect(coordinator.knownDialogs(owner, 4)).toEqual([]);
  });

  it("reports dispatch state only as it was captured in the durable observation", async () => {
    const receipt = latch<number>();
    const persist = vi.fn((_evidence: BlockedEvidence) => receipt.promise);
    const coordinator = new ForegroundBlockers(persist);
    const job = coordinator.begin(owner, "job");
    const operation = coordinator.startOperation(job, "click", { tabId: 4 });
    const recording = coordinator.observeDialog(owner, dialog(4));
    coordinator.markDispatched(operation, { tabId: 4 });
    receipt.resolve(7);
    await recording;
    expect(persist.mock.calls[0]![0]).toMatchObject({ operations: [{ dispatched: false }] });
    await expect(coordinator.wait(job)).resolves.toMatchObject({ status: "blocked", operationDispatchedAtObservation: false });
  });

  it("does not promote a job after its operation, dialog, or run is already finished", async () => {
    for (const ending of ["operation", "dialog", "job", "run"] as const) {
      const receipt = latch<number>();
      const coordinator = new ForegroundBlockers(() => receipt.promise);
      const job = coordinator.begin(owner, `job-${ending}`);
      const operation = coordinator.startOperation(job, "page.click", { tabId: 4 });
      const recording = coordinator.observeDialog(owner, dialog(4));
      if (ending === "operation") coordinator.endOperation(operation);
      if (ending === "dialog") coordinator.closeDialog(owner, "dialog");
      if (ending === "job") coordinator.settle(job);
      if (ending === "run") coordinator.closeOwner(owner);
      receipt.resolve(17);
      await recording;
      if (ending === "operation" || ending === "dialog") coordinator.settle(job);
      await expect(coordinator.wait(job)).resolves.toEqual(ending === "run" ? { status: "cancelled", reason: "run-ended" } : { status: "settled" });
    }
  });

  it("surfaces a failed evidence write without claiming the browser operation completed", async () => {
    const error = new Error("canonical log unavailable");
    const coordinator = new ForegroundBlockers(async () => { throw error; });
    const job = coordinator.begin(owner, "job");
    const operation = coordinator.startOperation(job, "page.click", { tabId: 4 });
    coordinator.markDispatched(operation, { tabId: 4, sessionId: "child-frame" });
    await coordinator.observeDialog(owner, dialog(4));
    await expect(coordinator.wait(job)).resolves.toEqual({ status: "persistence-failed", error, effectUnknown: true });
    coordinator.cancel(job, "cancelled");
  });

  it("marks a failed evidence write as effect-unknown even if the current operation was not dispatched", async () => {
    const error = new Error("canonical log unavailable");
    const coordinator = new ForegroundBlockers(async () => { throw error; });
    const job = coordinator.begin(owner, "job");
    coordinator.startOperation(job, "page.click", { tabId: 4 });
    await coordinator.observeDialog(owner, dialog(4));
    await expect(coordinator.wait(job)).resolves.toEqual({ status: "persistence-failed", error, effectUnknown: true });
    coordinator.cancel(job, "cancelled");
  });

  it("does not turn a late persistence failure into an error after the dialog closes", async () => {
    const receipt = latch<number>();
    const coordinator = new ForegroundBlockers(() => receipt.promise);
    const job = coordinator.begin(owner, "job");
    coordinator.startOperation(job, "page.click", { tabId: 4 });
    const recording = coordinator.observeDialog(owner, dialog(4));
    coordinator.closeDialog(owner, "dialog");
    receipt.reject(new Error("late failure"));
    await recording;
    coordinator.settle(job);
    await expect(coordinator.wait(job)).resolves.toEqual({ status: "settled" });
  });

  it("does not accept a tab change masquerading as the same dispatch", () => {
    const coordinator = new ForegroundBlockers(async () => 1);
    const job = coordinator.begin(owner, "job");
    const operation = coordinator.startOperation(job, "click", { tabId: 4 });
    expect(() => coordinator.markDispatched(operation, { tabId: 5 })).toThrow("does not match");
    coordinator.endOperation(operation);
    expect(() => coordinator.markDispatched(operation, { tabId: 4 })).toThrow("no longer active");
    coordinator.cancel(job, "cancelled");
  });

  it("deduplicates the same observed dialog while its evidence is being persisted", async () => {
    const receipt = latch<number>();
    const persist = vi.fn(() => receipt.promise);
    const coordinator = new ForegroundBlockers(persist);
    const job = coordinator.begin(owner, "job");
    coordinator.startOperation(job, "click", { tabId: 4 });
    const first = coordinator.observeDialog(owner, dialog(4));
    const second = coordinator.observeDialog(owner, dialog(4));
    expect(persist).toHaveBeenCalledOnce();
    expect(() => coordinator.observeDialog(owner, dialog(5))).toThrow("different event");
    receipt.resolve(7);
    await Promise.all([first, second]);
    await expect(coordinator.wait(job)).resolves.toMatchObject({ status: "blocked", evidenceId: 7 });
  });
});
