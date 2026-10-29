import { describe, expect, it } from "vitest";
import { PROGRAM_HANDLE_ASSERT_LIVE, ProgramHandles } from "./program-handles";

describe("program capability lifetime", () => {
  it("releases page and locator handles for a closed tab without touching other capabilities", () => {
    const handles = new ProgramHandles();
    const page = {}, locator = {}, otherPage = {}, otherCapability = () => {};
    const pageId = handles.remember(page, 3);
    const locatorId = handles.remember(locator, 3);
    const otherId = handles.remember(otherPage, 4);
    const capabilityId = handles.remember(otherCapability);

    expect(handles.remember(page, 3)).toBe(pageId);
    handles.closeTab(3);
    expect(handles.size).toBe(2);
    expect(() => handles.resolve(pageId)).toThrow("stale-page");
    expect(() => handles.resolve(locatorId)).toThrow("stale-page");
    expect(handles.resolve(otherId)).toBe(otherPage);
    expect(handles.resolve(capabilityId)).toBe(otherCapability);

    // An RPC that obtained this object before the close must not resurrect it
    // if its result is encoded after the tab has gone away.
    expect(handles.remember(page, 3)).toBe(pageId);
    expect(() => handles.resolve(pageId)).toThrow("stale-page");
    expect(handles.size).toBe(2);
  });

  it("does not retain each closed page during a long program", () => {
    const handles = new ProgramHandles();
    const stable = handles.remember({}, 1);
    for (let tabId = 2; tabId < 2002; tabId++) {
      handles.remember({}, tabId);
      handles.remember({}, tabId);
      handles.closeTab(tabId);
    }
    expect(handles.size).toBe(1);
    expect(handles.resolve(stable)).toBeDefined();
    handles.clear();
    expect(handles.size).toBe(0);
  });

  it("refuses first-time encoding when an in-flight RPC returns after closure", () => {
    const handles = new ProgramHandles();
    let open = true;
    const page = { [PROGRAM_HANDLE_ASSERT_LIVE]: () => { if (!open) throw new Error("stale-page"); } };
    // The close arrives before this page has ever reached the host registry.
    handles.closeTab(42);
    open = false;
    expect(() => handles.remember(page, 42)).toThrow("stale-page");
    expect(handles.size).toBe(0);
  });
});
