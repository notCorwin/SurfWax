import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ readEvents: vi.fn(), dispose: vi.fn(), closeServer: vi.fn(), openExtension: vi.fn(), configure: vi.fn() }));
vi.mock("../e2e/fixtures", () => mocks);
vi.mock("../scripts/development-extension.mjs", () => ({ fitWindowToScreen: vi.fn() }));
vi.mock("../e2e/evaluation/model-proxy", () => ({ modelProxy: async () => ({ baseURL: "local", token: "token", server: {}, requests: [] }), usageEvidence: () => null }));
vi.mock("../e2e/evaluation/build-fingerprint", () => ({ buildFingerprint: async () => ({ sha256: "same" }) }));
vi.mock("@playwright/test", () => ({ expect: { poll: () => ({ toBe: async () => {} }) } }));

import { runPublicTask } from "../e2e/public-web/run";

let root = "";
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });

it("captures and cleans up after polling fails while page association is pending", async () => {
  root = await mkdtemp(join(tmpdir(), "public-caller-"));
  vi.stubEnv("SURFWAX_PUBLIC_WEB_REPORT_DIR", root);
  vi.stubEnv("SURFWAX_EVAL_BASE_URL", "local"); vi.stubEnv("SURFWAX_EVAL_API_KEY", "key"); vi.stubEnv("SURFWAX_EVAL_MODEL", "model");
  let finish!: (value: unknown) => void;
  const association = new Promise(resolve => { finish = resolve; });
  const handlers: Record<string, (...args: any[]) => void> = {};
  const page = { on: (name: string, callback: (...args: any[]) => void) => { handlers[name] = callback; }, mainFrame: () => "frame", evaluate: async () => 42,
    getByTestId: () => ({ fill: async () => {}, press: async () => {} }) };
  const target = { goto: async () => {
    handlers.response({ request: () => ({ isNavigationRequest: () => true, resourceType: () => "document" }), frame: () => "frame", url: () => "https://example.org/", status: () => 200 });
    handlers.requestfailed({ isNavigationRequest: () => true, resourceType: () => "document", url: () => "https://example.org/", failure: () => ({ errorText: "original" }) });
    return { ok: () => true };
  }, bringToFront: async () => {} };
  const context = { pages: () => [page], on: () => {}, newCDPSession: async () => ({ send: () => association, detach: async () => {} }), browser: () => ({ version: () => "mock" }), newPage: async () => target };
  mocks.openExtension.mockResolvedValue({ context, page, userDataDirectory: "mock" });
  mocks.configure.mockResolvedValue({ getByLabel: () => ({ fill: async () => {} }), getByRole: () => ({ click: async () => {} }), close: async () => {} });
  const events = [{ id: 1, type: "conversation.submitted", conversationId: "c", runId: "r", timestamp: new Date().toISOString() }];
  mocks.readEvents.mockRejectedValueOnce(new Error("poll failed")).mockImplementationOnce(async () => { finish({ targetInfo: { targetId: "target" } }); await Promise.resolve();
    handlers.requestfailed({ isNavigationRequest: () => true, resourceType: () => "document", url: () => "https://example.org/late", failure: () => ({ errorText: "late" }) });
    return events; });
  const task = { id: "caller", title: "caller", difficulty: "test", startUrl: "https://example.org/", prompt: "test", prepare: async () => ({ sources: [], expected: null, requiredUrls: [] }), evidenceTerms: () => [], evidenceUrls: () => [], grade: () => false };
  expect(await runPublicTask(task as any, 1000)).toBe("setup_failed");
  const dir = join(root, (await readdir(root))[0]);
  expect(JSON.parse(await readFile(join(dir, "events.json"), "utf8"))).toEqual(events);
  const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  expect(report).toMatchObject({ reason: "poll failed", capture: { status: "succeeded", hasObservation: true }, documents: [{ tabId: null, status: 200 }], navigationFailures: [{ error: "original" }] });
  expect(mocks.readEvents).toHaveBeenCalledTimes(2);
  expect(mocks.dispose).toHaveBeenCalledOnce(); expect(mocks.closeServer).toHaveBeenCalledOnce();
}, 3000);
