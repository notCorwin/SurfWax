import { describe, expect, it } from "vitest";
import { abortAllConversationWork, abortConversationWork, claimConversationRun, registerBackgroundRequest } from "./coordinator";

describe("conversation run coordinator", () => {
  it("aborts and settles the previous run before granting the next", async () => {
    const first = await claimConversationRun("first");
    let granted = false;
    const secondTask = claimConversationRun("second").then((lease) => {
      granted = true;
      return lease;
    });

    await Promise.resolve();
    expect(first.signal.aborted).toBe(true);
    expect(granted).toBe(false);
    first.finish();
    const second = await secondTask;
    expect(granted).toBe(true);
    second.finish();
  });

  it("aborts the active run and title requests when the panel closes", async () => {
    const run = await claimConversationRun("thread");
    const title = new AbortController();
    const finishTitle = registerBackgroundRequest(title);
    abortAllConversationWork();
    expect(run.signal.aborted).toBe(true);
    expect(title.signal.aborted).toBe(true);
    run.finish();
    finishTitle();
  });

  it("waits for the deleted conversation while leaving other title requests alone", async () => {
    const run = await claimConversationRun("deleted");
    const deletedTitle = new AbortController();
    const otherTitle = new AbortController();
    const finishDeletedTitle = registerBackgroundRequest(deletedTitle, "deleted");
    const finishOtherTitle = registerBackgroundRequest(otherTitle, "other");
    let settled = false;
    const abort = abortConversationWork("deleted").then(() => { settled = true; });
    await Promise.resolve();
    expect(run.signal.aborted).toBe(true);
    expect(deletedTitle.signal.aborted).toBe(true);
    expect(otherTitle.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    run.finish();
    finishDeletedTitle();
    await abort;
    finishOtherTitle();
  });
});
