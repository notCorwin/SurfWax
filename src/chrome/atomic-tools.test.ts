import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ATOMIC_TOOL_REGISTRY } from "./atomic-tools";
import { createProgramTools, PROGRAM_TOOL_CONTEXT } from "./tool";

const definition = (name: string) => {
  const found = ATOMIC_TOOL_REGISTRY.find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function execute(name: string, input: unknown, capabilities: Record<string, unknown>) {
  const { code } = definition(name).program(input);
  const entries = Object.entries(capabilities);
  return new AsyncFunction(...entries.map(([key]) => key), code)(...entries.map(([, value]) => value));
}

describe("atomic browser tool programs", () => {
  it("dispatches a structured target with user text passed as data", async () => {
    const value = `x'); throw new Error('injected'); //\n${String.fromCharCode(0x2028)}`;
    const fill = vi.fn(async (text: string) => ({ text }));
    const getByLabel = vi.fn(() => ({ fill }));
    const page = { getByLabel };
    expect(await execute("fill", { target: { by: "label", value: "Email" }, value }, { page })).toEqual({ text: value });
    expect(getByLabel).toHaveBeenCalledWith("Email", {});
    expect(fill).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenCalledWith(value);
  });

  it("binds an explicit tab and applies frame and index to a locator", async () => {
    const click = vi.fn(async () => "done");
    const nth = vi.fn(() => ({ click }));
    const getByRole = vi.fn(() => ({ nth }));
    const frameLocator = vi.fn(() => ({ getByRole }));
    const browser = { page: vi.fn(async () => ({ frameLocator })) };
    const input = { tabId: 7, target: { by: "role", value: "button", name: "Save", index: 1, frame: { by: "css", value: "iframe" } } };
    expect(await execute("click", input, { page: {}, browser })).toBe("done");
    expect(browser.page).toHaveBeenCalledWith(7);
    expect(frameLocator).toHaveBeenCalledWith("iframe");
    expect(getByRole).toHaveBeenCalledWith("button", { name: "Save" });
    expect(nth).toHaveBeenCalledWith(1);
  });

  it("uses a discovered frame reference for an atomic action", async () => {
    const click = vi.fn(async () => "clicked");
    const getByRole = vi.fn(() => ({ click }));
    const frameRef = vi.fn(() => ({ getByRole }));
    const input = { target: { by: "role", value: "button", name: "Save", frame: { ref: "frame-1" } } };
    expect(await execute("click", input, { page: { frameRef } })).toBe("clicked");
    expect(frameRef).toHaveBeenCalledWith("frame-1");
    expect(getByRole).toHaveBeenCalledWith("button", { name: "Save" });
  });

  it("binds pointer movement to the observation used for its coordinates", async () => {
    const point = vi.fn(async () => "moved");
    expect(await execute("move_pointer", { observationId: "obs", x: 12, y: 34 }, { page: { point } })).toBe("moved");
    expect(point).toHaveBeenCalledWith("obs", 12, 34, "hover");
    expect(() => definition("move_pointer").program({ x: 12, y: 34 })).toThrow();
  });

  it("passes the requested checked state to the shared browser operation", async () => {
    const check = vi.fn(async () => "checked");
    const uncheck = vi.fn(async () => "unchecked");
    const page = { ref: () => ({ check, uncheck }) };
    expect(await execute("set_checked", { target: { ref: "e1" }, checked: true }, { page })).toBe("checked");
    expect(await execute("set_checked", { target: { ref: "e1" }, checked: false }, { page })).toBe("unchecked");
    expect(check).toHaveBeenCalledOnce();
    expect(uncheck).toHaveBeenCalledOnce();
  });

  it("allows focusing and blurring as independent background-capable actions", async () => {
    const focus = vi.fn(async () => "focused");
    const blur = vi.fn(async () => "blurred");
    const page = { ref: () => ({ focus, blur }) };
    for (const [name, result] of [["focus_element", "focused"], ["blur_element", "blurred"]] as const) {
      expect(await execute(name, { target: { ref: "e1" }, background: true }, { page })).toBe(result);
      expect(definition(name).program({ target: { ref: "e1" }, background: true })).toMatchObject({ background: true });
    }
    expect(focus).toHaveBeenCalledOnce();
    expect(blur).toHaveBeenCalledOnce();
  });

  it("validates input before creating a program and retains an explicit timeout", () => {
    expect(() => definition("fill").program({ target: { ref: "e1" }, value: "x", extra: true })).toThrow();
    expect(() => definition("fetch").program({ url: "https://example.com" })).toThrow();
    expect(definition("click").program({ target: { ref: "e1" }, timeoutMs: 500 }).timeoutMs).toBe(500);
    expect(definition("click").program({ target: { ref: "e1" }, background: true })).toMatchObject({ background: true });
    expect(() => definition("read_text").program({ target: { ref: "e1" }, background: true })).toThrow();
    expect(() => definition("verify_state").program({ target: { ref: "e1" } })).toThrow();
    expect(() => definition("verify_state").program({ target: { ref: "e1" }, valueEquals: "x", state: "visible" })).toThrow();
  });

  it("uploads only the bytes of the requested artifact and rejects unavailable content before dispatch", async () => {
    const setInputFiles = vi.fn(async () => "uploaded");
    const page = { ref: () => ({ setInputFiles }) };
    const read = vi.fn(async () => ({ filename: "report.txt", mimeType: "text/plain", base64: "aGVsbG8=" }));
    expect(await execute("upload_file", { target: { ref: "e1" }, artifactId: 7 }, { page, artifacts: { read } })).toBe("uploaded");
    expect(read).toHaveBeenCalledWith(7);
    expect(setInputFiles).toHaveBeenCalledWith([{ name: "report.txt", mimeType: "text/plain", base64: "aGVsbG8=" }]);
    read.mockResolvedValueOnce({ filename: "report.txt", mimeType: "text/plain" } as never);
    await expect(execute("upload_file", { target: { ref: "e1" }, artifactId: 8 }, { page, artifacts: { read } })).rejects.toThrow("invalid-artifact");
    expect(setInputFiles).toHaveBeenCalledOnce();
  });

  it("accepts exactly one upload destination and reuses duplicate artifact reads", async () => {
    const upload = definition("upload_file");
    expect(() => upload.inputSchema.parse({ artifactId: 1 })).toThrow();
    expect(() => upload.inputSchema.parse({ artifactId: 1, chooserId: "c", target: { ref: "e1" } })).toThrow();
    expect(() => upload.inputSchema.parse({ artifactId: 1, chooserId: "c", tabId: 2 })).toThrow();
    expect(() => upload.inputSchema.parse({ artifactId: 1, chooserId: "c", background: true })).toThrow();
    expect(upload.inputSchema.parse({ artifactId: [1, 1], chooserId: "c" })).toMatchObject({ chooserId: "c" });
    const read = vi.fn(async () => ({ filename: "a.txt", mimeType: "text/plain", base64: "YQ==" }));
    const setInputFiles = vi.fn(async () => "done");
    await execute("upload_file", { artifactId: [1, 1], target: { ref: "e1" } }, { page: { ref: () => ({ setInputFiles }) }, artifacts: { read } });
    expect(read).toHaveBeenCalledOnce();
    expect(setInputFiles).toHaveBeenCalledWith([expect.objectContaining({ name: "a.txt" }), expect.objectContaining({ name: "a.txt" })]);
  });

  it("verifies a single bound observation without confusing missing targets with false states", async () => {
    const readCondition = vi.fn(async () => ({ present: false, actual: null as string | boolean | null }));
    const page = { ref: () => ({ readCondition }) };
    const target = { ref: "e1" };
    expect(await execute("verify_state", { target, state: "unchecked" }, { page })).toEqual({ verified: false, actual: null, present: false });
    expect(readCondition).toHaveBeenLastCalledWith("checked");
    expect(await execute("verify_state", { target, state: "disabled" }, { page })).toEqual({ verified: false, actual: null, present: false });
    expect(readCondition).toHaveBeenLastCalledWith("enabled");
    expect(await execute("verify_state", { target, state: "hidden" }, { page })).toEqual({ verified: true, actual: null, present: false });
    expect(readCondition).toHaveBeenLastCalledWith("visible");
    expect(await execute("verify_state", { target, textIncludes: "" }, { page })).toEqual({ verified: false, actual: null, present: false });
    expect(readCondition).toHaveBeenLastCalledWith("text");
    readCondition.mockResolvedValueOnce({ present: true, actual: false });
    expect(await execute("verify_state", { target, state: "disabled" }, { page })).toEqual({ verified: true, actual: false, present: true });
    readCondition.mockResolvedValueOnce({ present: true, actual: "saved" });
    expect(await execute("verify_state", { target, valueEquals: "saved" }, { page })).toEqual({ verified: true, actual: "saved", present: true });
    expect(readCondition).toHaveBeenLastCalledWith("value");
    readCondition.mockRejectedValueOnce(new Error("AutomationError[strict-mode]"));
    await expect(execute("verify_state", { target, state: "visible" }, { page })).rejects.toThrow("strict-mode");
  });

  it("waits for one condition and reports missing timeout without treating it as success", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const readCondition = vi.fn(async () => ({ present: false, actual: null }));
      const sleep = vi.fn(async (ms: number) => { now += ms; });
      const page = { ref: () => ({ readCondition }) };
      expect(await execute("verify_state", { target: { ref: "e1" }, state: "disabled", timeoutMs: 125 }, { page, sleep }))
        .toEqual({ verified: false, actual: null, present: false, timedOut: true });
      expect(readCondition).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 25]);

      const eventually = vi.fn()
        .mockResolvedValueOnce({ present: false, actual: null })
        .mockResolvedValueOnce({ present: true, actual: true });
      expect(await execute("verify_state", { target: { ref: "e2" }, state: "checked", timeoutMs: 500 },
        { page: { ref: () => ({ readCondition: eventually }) }, sleep }))
        .toEqual({ verified: true, actual: true, present: true });
      expect(eventually).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it("reads a response only with its captured request reference", async () => {
    const responseBody = vi.fn(async () => "response");
    const input = { requestRef: "request-epoch:1" };
    expect(await execute("read_response", input, { page: { tabId: 7 }, net: { responseBody } })).toBe("response");
    expect(responseBody).toHaveBeenCalledWith("request-epoch:1", 7);
    expect(() => definition("read_response").inputSchema.parse({ requestIndex: 1 })).toThrow();
  });

  it("passes script definitions and explicit fetch contexts without substituting them", async () => {
    const definition = { id: "script", matches: ["https://example.com/*"], js: [{ code: "alert('ok')" }] };
    const create = vi.fn(async () => "created");
    expect(await execute("create_script", { definition }, { browser: { scripts: { create } } })).toBe("created");
    expect(create).toHaveBeenCalledWith(definition);
    const remove = vi.fn(async () => ({ id: "script" }));
    await execute("delete_script", { scriptId: "script" }, { browser: { scripts: { delete: remove } } });
    expect(remove).toHaveBeenCalledWith("script");
    const fetch = vi.fn(async () => ({ status: 200 }));
    await execute("fetch", { context: "page", url: "https://example.com", tabId: 2 }, { net: { fetch } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ context: "page", tabId: 2 }));
  });

  it("exports schemas representable as JSON schema", () => {
    for (const { inputSchema } of ATOMIC_TOOL_REGISTRY) expect(() => z.toJSONSchema(inputSchema)).not.toThrow();
  });

  it("keeps system tool positions concise while retaining full model-facing descriptions and schemas", () => {
    const tools = createProgramTools({} as never);
    const positions = [
      ["fill", "Replace an editable element's value; an empty value clears it.", "Does not emit beforeinput or keyboard events."],
      ["type_text", "Insert text character by character into an editable element.", "does not emit beforeinput, keydown or keyup."],
      ["press_key", "Press a key or chord, optionally focusing an element first.", "The interaction blocker can reject editing keys with guard-blocked-input and unknown effects."],
      ["key_down", "Hold a key until key_up or run cleanup.", "The interaction blocker can reject editing keys with guard-blocked-input and unknown effects."],
      ["send_cdp", "Send a Chrome DevTools Protocol command to an owned tab or session.", "Input event timestamps are replaced for isolation; guarded Input.insertText is dispatched as character key events."],
      ["select_option", "Select option values or labels on a select element.", "An empty array clears selection; missing, disabled or ambiguous options fail without changing selection."],
      ["drag", "Drag one element to another using pointer events.", "Native HTML5 draggable sources are unavailable while the interaction blocker is active."],
      ["upload_file", "Upload artifacts to a file input or captured chooser.", "Supply exactly one target or chooserId; chooser uploads cannot set tabId or background."],
      ["read_artifact", "Read a stored artifact or large tool result by ID, including during a background job.", "nested undefined and array holes are null with undefinedPaths and holePaths;"],
      ["list_requests", "List captured network requests and requestRef identifiers.", "integrity describes captured history, not all network traffic"],
      ["read_console", "Read captured console messages.", "nextOffset paginates a live, possibly changing list."],
    ] as const;
    for (const [name, summary, detail] of positions) {
      const item = definition(name);
      expect(item.summary).toBe(summary);
      expect(PROGRAM_TOOL_CONTEXT).toContain(`- ${name}: ${summary}`);
      expect(PROGRAM_TOOL_CONTEXT).not.toContain(detail);
      expect(tools[name]!.description).toBe(item.description);
      expect(item.description).toContain(detail);
      expect(tools[name]!.inputSchema).toBe(item.inputSchema);
    }
    expect(definition("select_option").inputSchema.safeParse({ target: { ref: "e1" }, value: [], background: true }).success).toBe(true);
    expect(definition("drag").inputSchema.safeParse({ source: { ref: "e1" }, destination: { ref: "e2" } }).success).toBe(true);
    expect(definition("upload_file").inputSchema.safeParse({ chooserId: "c1", artifactId: 1, tabId: 2 }).success).toBe(false);
    expect(definition("read_artifact").inputSchema.safeParse({ artifactId: 1, path: ["rows", -1] }).success).toBe(false);
    for (const name of ["list_requests", "read_console"]) expect(definition(name).inputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("keeps the registry free of duplicate actions and unsupported event subscriptions", () => {
    const names = ATOMIC_TOOL_REGISTRY.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const absent of ["clear", "check", "uncheck", "subscribe_event", "wait_event"]) expect(names).not.toContain(absent);
  });
});
