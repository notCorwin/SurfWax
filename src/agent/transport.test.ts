import { describe, expect, it } from "vitest";
import { followupDispatch, type SidePanelMessage } from "./transport";

describe("follow-up transport metadata", () => {
  it("accepts only complete internal dispatch metadata", () => {
    expect(followupDispatch({ metadata: { custom: { followupId: "next", followupMode: "immediate" } } } as SidePanelMessage))
      .toEqual({ id: "next", mode: "immediate" });
    expect(followupDispatch({ metadata: { custom: { followupId: "next" } } } as SidePanelMessage)).toBeUndefined();
    expect(followupDispatch(undefined)).toBeUndefined();
  });
});
