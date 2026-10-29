import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ATOMIC_TOOL_REGISTRY } from "./atomic-tools";

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

  it("does not dispatch an impossible uncheck of a selected native radio", async () => {
    const uncheck = vi.fn();
    const page = { ref: () => ({ isChecked: async () => true, getAttribute: async () => "radio", uncheck }) };
    await expect(execute("set_checked", { target: { ref: "e1" }, checked: false }, { page })).rejects.toThrow("Cannot uncheck a selected radio");
    expect(uncheck).not.toHaveBeenCalled();
  });

  it("validates input before creating a program and retains an explicit timeout", () => {
    expect(() => definition("fill").program({ target: { ref: "e1" }, value: "x", extra: true })).toThrow();
    expect(() => definition("fetch").program({ url: "https://example.com" })).toThrow();
    expect(definition("click").program({ target: { ref: "e1" }, timeoutMs: 500 }).timeoutMs).toBe(500);
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

  it("keeps the registry free of duplicate actions and unsupported event subscriptions", () => {
    const names = ATOMIC_TOOL_REGISTRY.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const absent of ["clear", "check", "uncheck", "subscribe_event", "wait_event"]) expect(names).not.toContain(absent);
  });
});
