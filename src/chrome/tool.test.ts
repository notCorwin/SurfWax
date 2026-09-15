import { describe, expect, it } from "vitest";
import { parseChromeToolInput } from "./tool";

describe("chrome tool input", () => {
  it("accepts only one non-empty code field", () => {
    expect(parseChromeToolInput({ code: "return await chrome.tabs.query({});" })).toEqual({ code: "return await chrome.tabs.query({});" });
    expect(() => parseChromeToolInput({ code: "" })).toThrow();
    expect(() => parseChromeToolInput({ code: "return 1", operation: "call" })).toThrow();
  });
});
