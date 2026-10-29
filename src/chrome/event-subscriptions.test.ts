import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSubscriptions, type EventOwner } from "./event-subscriptions";

const owner: EventOwner = { conversationId: "conversation", runId: "run" };
const other: EventOwner = { conversationId: "conversation", runId: "another-run" };
const source = { tabId: 7, sessionId: "frame-session" };
function events(options: { capacity?: number; maxEventBytes?: number } = {}) {
  let next = 0;
  return new EventSubscriptions({ ...options, createId: () => `handle-${++next}` });
}
afterEach(() => vi.useRealTimers());

describe("run-owned browser event subscriptions", () => {
  it("routes events by owner, tab and kind, with stable non-consuming cursors", async () => {
    const stream = events();
    const first = stream.subscribe({ owner, tabId: 7, kinds: ["dialog", "popup"] });
    const second = stream.subscribe({ owner, tabId: 8, kinds: ["dialog"] });
    const third = stream.subscribe({ owner: other, tabId: 7, kinds: ["dialog"] });
    const payload = { message: "original" };
    stream.publish(owner, { kind: "dialog", source, payload });
    payload.message = "changed after publication";
    stream.publish(owner, { kind: "popup", source: { tabId: 7 }, payload: { tabId: 9 } });
    stream.publish(owner, { kind: "console", source, payload: "ignored" });
    const one = await stream.read({ owner, subscriptionId: first.subscriptionId, limit: 1 });
    expect(one).toMatchObject({ nextCursor: 1, events: [{ cursor: 1, kind: "dialog", source, payload: { message: "original" } }] });
    (one.events[0]!.payload as any).message = "changed by reader";
    expect(await stream.read({ owner, subscriptionId: first.subscriptionId, after: 1 })).toMatchObject({ nextCursor: 2, events: [{ cursor: 2, kind: "popup" }] });
    expect((await stream.read({ owner, subscriptionId: first.subscriptionId })).events[0]!.payload).toEqual({ message: "original" });
    expect((await stream.read({ owner, subscriptionId: second.subscriptionId })).events).toEqual([]);
    expect((await stream.read({ owner: other, subscriptionId: third.subscriptionId })).events).toEqual([]);
    await expect(stream.read({ owner: other, subscriptionId: first.subscriptionId })).rejects.toThrow("unavailable");
    await expect(stream.read({ owner, subscriptionId: first.subscriptionId, after: 3 })).rejects.toThrow("ahead");
  });

  it("reports the lost cursor interval when a bounded queue overflows", async () => {
    const stream = events({ capacity: 2 });
    const { subscriptionId } = stream.subscribe({ owner, tabId: 7, kinds: ["request"] });
    for (let index = 1; index <= 4; index++) stream.publish(owner, { kind: "request", source, payload: { index } });
    const first = await stream.read({ owner, subscriptionId, after: 0, limit: 1 });
    expect(first).toMatchObject({ overflow: { from: 1, through: 2 }, nextCursor: 3, events: [{ cursor: 3, payload: { index: 3 } }] });
    expect(await stream.read({ owner, subscriptionId, after: first.nextCursor })).toMatchObject({ nextCursor: 4, events: [{ cursor: 4, payload: { index: 4 } }] });
    expect((await stream.read({ owner, subscriptionId, after: 2 })).overflow).toBeUndefined();
  });

  it("marks oversized event payloads rather than silently discarding them", async () => {
    const stream = events({ maxEventBytes: 100 });
    const { subscriptionId } = stream.subscribe({ owner, tabId: 7, kinds: ["console"] });
    stream.publish(owner, { kind: "console", source, payload: "x".repeat(300) });
    expect(await stream.read({ owner, subscriptionId })).toMatchObject({ events: [{ cursor: 1, kind: "console", source, payload: null, payloadTruncated: { reason: "event-too-large", bytes: expect.any(Number) } }] });
    const dialog = stream.subscribe({ owner, tabId: 7, kinds: ["dialog"] });
    stream.publish(owner, { kind: "dialog", source, payload: { dialogId: "dialog-1", type: "prompt", message: "x".repeat(300) } });
    expect(await stream.read({ owner, subscriptionId: dialog.subscriptionId })).toMatchObject({ events: [{ payload: { dialogId: "dialog-1", type: "prompt" }, payloadTruncated: { reason: "event-too-large" } }] });
    const chooser = stream.subscribe({ owner, tabId: 7, kinds: ["filechooser"] });
    stream.publish(owner, { kind: "filechooser", source, payload: { chooserId: "chooser-1", mode: "selectMultiple", extra: "x".repeat(300) } });
    expect(await stream.read({ owner, subscriptionId: chooser.subscriptionId })).toMatchObject({ events: [{ payload: { chooserId: "chooser-1", mode: "selectMultiple" }, payloadTruncated: { reason: "event-too-large" } }] });
  });

  it("wakes on a new event, times out without cancelling the subscription, and supports simultaneous readers", async () => {
    vi.useFakeTimers();
    const stream = events();
    const { subscriptionId } = stream.subscribe({ owner, tabId: 7, kinds: ["dialog"] });
    const first = stream.read({ owner, subscriptionId, waitMs: 60_000 });
    const second = stream.read({ owner, subscriptionId, waitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(30_001);
    stream.publish(owner, { kind: "dialog", source, payload: { message: "hello" } });
    expect(await first).toMatchObject({ events: [{ cursor: 1, payload: { message: "hello" } }] });
    expect(await second).toMatchObject({ events: [{ cursor: 1, payload: { message: "hello" } }] });
    const timed = stream.read({ owner, subscriptionId, after: 1, waitMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await timed).toMatchObject({ events: [], nextCursor: 1, timedOut: true });
    stream.publish(owner, { kind: "dialog", source, payload: "still open" });
    expect(await stream.read({ owner, subscriptionId, after: 1 })).toMatchObject({ events: [{ cursor: 2, payload: "still open" }] });
  });

  it("cleans aborted and unsubscribed waiters and isolates tab and run teardown", async () => {
    const stream = events();
    const first = stream.subscribe({ owner, tabId: 7, kinds: ["dialog"] });
    const second = stream.subscribe({ owner, tabId: 8, kinds: ["dialog"] });
    const third = stream.subscribe({ owner: other, tabId: 7, kinds: ["dialog"] });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const aborted = stream.read({ owner, subscriptionId: first.subscriptionId, waitMs: 60_000, signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    const waiting = stream.read({ owner, subscriptionId: first.subscriptionId, waitMs: 60_000 });
    stream.closeTab(owner, 7);
    expect(await waiting).toMatchObject({ closed: "tab-closed", events: [] });
    await expect(stream.read({ owner, subscriptionId: first.subscriptionId })).rejects.toThrow("unavailable");
    stream.publish(owner, { kind: "dialog", source: { tabId: 8 }, payload: "other tab" });
    expect(await stream.read({ owner, subscriptionId: second.subscriptionId })).toMatchObject({ events: [{ payload: "other tab" }] });
    stream.publish(other, { kind: "dialog", source, payload: "other run" });
    expect(await stream.read({ owner: other, subscriptionId: third.subscriptionId })).toMatchObject({ events: [{ payload: "other run" }] });
    const pending = stream.read({ owner, subscriptionId: second.subscriptionId, after: 1, waitMs: 60_000 });
    stream.closeOwner(owner);
    expect(await pending).toMatchObject({ closed: "run-ended" });
    expect((await stream.read({ owner: other, subscriptionId: third.subscriptionId })).events).toHaveLength(1);
    stream.unsubscribe(other, third.subscriptionId);
    await expect(stream.read({ owner: other, subscriptionId: third.subscriptionId })).rejects.toThrow("unavailable");
  });
});

describe("dialog handles", () => {
  it("binds to the owning run and source session, and prevents duplicate dispatch", () => {
    const stream = events();
    const dialog = stream.registerDialog({ owner, source, type: "prompt", message: "Name?", defaultPrompt: "Ada" });
    expect(dialog).toMatchObject({ source, state: "active", type: "prompt" });
    expect(() => stream.claimDialog(other, dialog.id)).toThrow("unavailable");
    const claim = stream.claimDialog(owner, dialog.id);
    expect(claim).toMatchObject({ source, state: "handling" });
    expect(() => stream.claimDialog(owner, dialog.id)).toThrow("handling");
    stream.finishDialog(owner, dialog.id, claim.claimId, "not-dispatched");
    const secondClaim = stream.claimDialog(owner, dialog.id);
    expect(secondClaim).toMatchObject({ state: "handling" });
    expect(() => stream.finishDialog(owner, dialog.id, claim.claimId, "not-dispatched")).toThrow("stale");
    stream.finishDialog(owner, dialog.id, secondClaim.claimId, "uncertain");
    expect(() => stream.claimDialog(owner, dialog.id)).toThrow("uncertain");
    stream.closeDialog(owner, dialog.id);
    expect(() => stream.claimDialog(owner, dialog.id)).toThrow("unavailable");
  });

  it("invalidates handles when the tab or owning run ends", () => {
    const stream = events();
    const first = stream.registerDialog({ owner, source, type: "confirm", message: "Continue?" });
    const second = stream.registerDialog({ owner: other, source, type: "confirm", message: "Continue?" });
    stream.closeTab(owner, source.tabId);
    expect(() => stream.claimDialog(owner, first.id)).toThrow("unavailable");
    const claim = stream.claimDialog(other, second.id);
    expect(claim).toMatchObject({ state: "handling" });
    stream.closeOwner(other);
    expect(() => stream.claimDialog(other, second.id)).toThrow("unavailable");
    expect(() => stream.finishDialog(other, second.id, claim.claimId, "handled")).not.toThrow();
  });
});

describe("file chooser handles", () => {
  it("isolates source and run, fences concurrent claims, and refuses uncertain replay", () => {
    const stream = events();
    const chooser = stream.registerChooser({ owner, source, backendNodeId: 12, mode: "selectMultiple" });
    expect(() => stream.claimChooser(other, chooser.id)).toThrow("unavailable");
    const first = stream.claimChooser(owner, chooser.id);
    expect(first).toMatchObject({ source, backendNodeId: 12, mode: "selectMultiple", state: "handling" });
    expect(() => stream.claimChooser(owner, chooser.id)).toThrow("handling");
    stream.finishChooser(owner, chooser.id, first.claimId, "not-dispatched");
    const second = stream.claimChooser(owner, chooser.id);
    expect(() => stream.assertChooserClaim(owner, chooser.id, first.claimId)).toThrow("stale");
    stream.finishChooser(owner, chooser.id, second.claimId, "uncertain");
    expect(() => stream.claimChooser(owner, chooser.id)).toThrow("uncertain");
  });

  it("invalidates superseded, navigated and completed chooser handles", () => {
    const stream = events();
    const old = stream.registerChooser({ owner, source, backendNodeId: 12, mode: "selectSingle" });
    const current = stream.registerChooser({ owner, source, backendNodeId: 12, mode: "selectSingle" });
    expect(() => stream.claimChooser(owner, old.id)).toThrow("unavailable");
    const claim = stream.claimChooser(owner, current.id);
    stream.finishChooser(owner, current.id, claim.claimId, "handled");
    expect(() => stream.claimChooser(owner, current.id)).toThrow("handled");
    stream.closeChoosers(owner, source.tabId, source.sessionId);
    expect(() => stream.claimChooser(owner, current.id)).toThrow("unavailable");
  });
});
