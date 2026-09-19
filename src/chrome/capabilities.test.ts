import { describe, expect, it } from "vitest";
import { CDP_DOMAINS, collectCapabilities, nativeHostStatus } from "./capabilities";

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
    const report = await collectCapabilities(chromeApi, { native: { available: true } });
    expect(report.hosts.serviceWorker.available).toBe(true);
    expect(report.hosts.devtools.available).toBe(true);
    expect(report.hosts.native.available).toBe(true);
    expect(report.cdp.domains).toEqual(CDP_DOMAINS);
    expect(report.cdp.domains).toHaveLength(27);
  });

  it("distinguishes native host installation, ID and launch failures", () => {
    expect(nativeHostStatus(new Error("Specified native messaging host not found."))).toMatchObject({ reason: expect.stringContaining("not installed") });
    expect(nativeHostStatus(new Error("Access to the specified native messaging host is forbidden."))).toMatchObject({ reason: expect.stringContaining("extension ID") });
    expect(nativeHostStatus(new Error("Failed to start native messaging host."))).toMatchObject({ reason: expect.stringContaining("could not run") });
    expect(nativeHostStatus(new Error("This extension does not have permission to use native messaging."))).toMatchObject({ reason: expect.stringContaining("store build") });
  });
});
