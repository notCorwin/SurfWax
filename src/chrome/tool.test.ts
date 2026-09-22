import { describe, expect, it } from "vitest";
import { parseCommandTarget } from "./executor";
import { COMMAND_NAMES, parseCommandInput, prepareToolMessages } from "./tool";

describe("browser command tools", () => {
  it("registers exactly the 88 documented commands without browser", () => {
    expect(COMMAND_NAMES).toHaveLength(88);
    expect(new Set(COMMAND_NAMES).size).toBe(88);
    expect(COMMAND_NAMES).not.toContain("browser");
    expect(COMMAND_NAMES).toEqual(expect.arrayContaining(["snapshot", "click", "run-code", "video-stop", "kill-all"]));
  });

  it("strictly validates command-specific structured inputs", () => {
    expect(parseCommandInput("click", { target: "e15", button: "right", modifiers: ["Shift"] })).toEqual({ target: "e15", button: "right", modifiers: ["Shift"] });
    expect(parseCommandInput("fill", { target: { by: "label", value: "Email" }, text: "a@b.test", submit: true })).toMatchObject({ text: "a@b.test" });
    expect(parseCommandInput("tab-select", { index: 0 })).toEqual({ index: 0 });
    expect(parseCommandInput("request", { index: 1 })).toEqual({ index: 1 });
    expect(parseCommandInput("upload", { files: [{ name: "a.txt", text: "hello" }] })).toMatchObject({ files: [{ name: "a.txt" }] });
    expect(() => parseCommandInput("click", { target: "e1", extra: true })).toThrow();
    expect(() => parseCommandInput("upload", { files: [{ name: "a.txt", text: "x", base64: "eA==" }] })).toThrow();
    expect(() => parseCommandInput("request", { index: 0 })).toThrow();
  });

  it("accepts refs, CSS, documented locators, and structured targets", () => {
    expect(parseCommandTarget("e15")).toEqual({ ref: "e15" });
    expect(parseCommandTarget("#main > button")).toEqual({ by: "css", value: "#main > button" });
    expect(parseCommandTarget("getByRole('button', { name: 'Submit', exact: true })")).toEqual({ by: "role", value: "button", name: "Submit", exact: true });
    expect(parseCommandTarget('getByText("Login")')).toEqual({ by: "text", value: "Login" });
    expect(parseCommandTarget('getByLabel("Email", { exact: false })')).toEqual({ by: "label", value: "Email", exact: false });
    expect(parseCommandTarget({ by: "label", value: "Email" })).toEqual({ by: "label", value: "Email" });
    expect(() => parseCommandTarget("getByUnknown('x')")).toThrow(/Unsupported locator expression/);
    expect(() => parseCommandTarget("getByRole('button', { pressed: true })")).toThrow(/Unsupported locator expression/);
  });

  it("injects only the latest screenshot and keeps historical browser results compatible", () => {
    const messages = [{ role: "tool", content: [
      { type: "tool-result", toolName: "browser", output: { type: "json", value: { screenshot: { mediaType: "image/jpeg", data: "old" } } } },
      { type: "tool-result", toolName: "screenshot", output: { type: "json", value: { screenshot: { mediaType: "image/png", data: "new" } } } },
    ] }];
    const prepared = prepareToolMessages(messages, 1);
    expect(prepared[0].content[0].output.value.screenshot.data).toBe("[stored in canonical event log]");
    expect(prepared[0].content[1].output.value.screenshot.data).toBe("[stored in canonical event log]");
    expect(prepared[1]).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "new" } }] });
    expect(prepareToolMessages(messages, 0)).toHaveLength(1);
  });
});
