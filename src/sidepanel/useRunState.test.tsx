import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { activeRunIdentity } from "../agent/coordinator";
import { useRunState } from "./useRunState";

vi.mock("@/sidepanel/runtime-view", () => ({ usePanelState: () => false }));
vi.mock("../agent/coordinator", () => ({ activeRunIdentity: vi.fn(), getRunIdentity: () => undefined }));

describe("run status diagnostics", () => {
  it("exposes a failed ownership query and clears the error on a successful refresh", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } } });
    vi.mocked(activeRunIdentity).mockRejectedValueOnce(new Error("worker unavailable"));
    let state: ReturnType<typeof useRunState> | undefined;
    function Harness() { state = useRunState(); return null; }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(<Harness />); });
    expect(state?.error).toEqual(expect.objectContaining({ message: "worker unavailable" }));
    vi.mocked(activeRunIdentity).mockResolvedValueOnce({ runId: "run", ownerId: "owner", generation: 1 });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(state?.error).toBeUndefined();
    expect(state?.otherRunning).toBe(true);
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});
