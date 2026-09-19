import { describe, expect, it } from "vitest";
import { CDP_DOMAINS, collectCapabilities } from "./capabilities";

describe("collectCapabilities", () => {
  it("reports runtime hosts and the exact debugger domain allowlist", async () => {
    const chromeApi = {
      debugger: {}, offscreen: {},
      permissions: { getAll: async () => ({ permissions: ["debugger"], origins: ["<all_urls>"] }) },
      runtime: {
        getManifest: () => ({ manifest_version: 3, name: "test", version: "1" }),
        getPlatformInfo: async () => ({ os: "mac" }),
        getContexts: async () => [{ contextType: "BACKGROUND" }, { contextType: "DEVELOPER_TOOLS" }],
      },
    } as unknown as typeof chrome;
    const report = await collectCapabilities(chromeApi, { nativeAvailable: true });
    expect(report.hosts.serviceWorker.available).toBe(true);
    expect(report.hosts.devtools.available).toBe(true);
    expect(report.hosts.native.available).toBe(true);
    expect(report.cdp.domains).toEqual(CDP_DOMAINS);
    expect(report.cdp.domains).toHaveLength(27);
  });
});
