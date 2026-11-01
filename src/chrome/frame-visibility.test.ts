import { describe, expect, it } from "vitest";
import { createFrameVisibility } from "./frame-visibility";

describe("frame visibility ancestry", () => {
  it("propagates a hidden owner through same-process and cross-process descendants", () => {
    const visible = createFrameVisibility("root", new Map([
      ["root", undefined], ["same", "root"], ["cross", "same"], ["nested", "cross"], ["unknown-host", "same"], ["sibling", "root"],
    ]), new Map([["same", false], ["cross", true], ["nested", true], ["sibling", true]]));
    expect(visible("root")).toBe("visible");
    expect(visible("same")).toBe("hidden");
    expect(visible("cross")).toBe("hidden");
    expect(visible("nested")).toBe("hidden");
    expect(visible("unknown-host")).toBe("hidden");
    expect(visible("sibling")).toBe("visible");
  });

  it("does not infer visibility from missing host data, ancestry, or cycles", () => {
    const visible = createFrameVisibility("root", new Map([
      ["missing-owner", "root"], ["missing-parent", undefined], ["a", "b"], ["b", "a"], ["known-hidden", "missing-owner"],
    ]), new Map([["missing-parent", true], ["a", true], ["b", true], ["known-hidden", false]]));
    expect(visible("missing-owner")).toBe("unknown");
    expect(visible("missing-parent")).toBe("unknown");
    expect(visible("a")).toBe("unknown");
    expect(visible("b")).toBe("unknown");
    expect(visible("missing-frame")).toBe("unknown");
    expect(visible("known-hidden")).toBe("hidden");
  });

  it("handles deep frame ancestry without recursion", () => {
    const parents = new Map<string, string | undefined>();
    const owners = new Map<string, boolean>();
    for (let i = 1; i <= 20000; i++) {
      parents.set(String(i), i === 1 ? "root" : String(i - 1));
      owners.set(String(i), true);
    }
    const visible = createFrameVisibility("root", parents, owners);
    expect(visible("20000")).toBe("visible");
    expect(visible("10000")).toBe("visible");
  });
});
