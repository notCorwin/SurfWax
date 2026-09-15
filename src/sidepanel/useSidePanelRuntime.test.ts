import { describe, expect, it } from "vitest";
import { createSidePanelCloser } from "./useSidePanelRuntime";

describe("createSidePanelCloser", () => {
  it("cancels the visible run and closes only once", () => {
    const calls: string[] = [];
    const close = createSidePanelCloser({ thread: { cancelRun: () => calls.push("cancel") } });

    close();
    close();

    expect(calls).toEqual(["cancel"]);
  });
});
