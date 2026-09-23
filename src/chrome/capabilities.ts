export const CDP_DOMAINS = [
  "Accessibility", "Audits", "CacheStorage", "Console", "CSS", "Database", "Debugger", "DOM",
  "DOMDebugger", "DOMSnapshot", "Emulation", "Fetch", "IO", "Input", "Inspector", "Log", "Network",
  "Overlay", "Page", "Performance", "Profiler", "Runtime", "Storage", "Target", "Tracing", "WebAudio", "WebAuthn",
] as const;

export type CapabilityStatus = {
  available: boolean;
  reason?: string;
  action?: string;
};

export type CapabilityReport = {
  browser: { version?: number; platform?: string; extensionId?: string };
  permissions: { permissions: string[]; origins: string[] };
  hosts: Record<"extension" | "serviceWorker" | "pageMain" | "pageIsolated" | "userScript" | "offscreen" | "devtools", CapabilityStatus>;
  cdp: { available: boolean; domains: readonly string[] };
  extensionApis: Record<string, CapabilityStatus>;
  manifest: Record<string, CapabilityStatus>;
  web: { languageModel: boolean; summarizer: boolean; translator: boolean; languageDetector: boolean; webMcp: boolean };
};

const EXTENSION_APIS = [
  "runtime", "extension", "permissions", "management", "alarms", "scripting", "userScripts", "dom", "offscreen", "i18n",
  "tabs", "windows", "tabGroups", "action", "commands", "contextMenus", "omnibox", "sidePanel", "search", "notifications",
  "bookmarks", "history", "browsingData", "cookies", "storage", "downloads", "sessions", "topSites", "readingList", "mimeHandler",
  "webNavigation", "webRequest", "declarativeNetRequest", "declarativeContent", "contentSettings", "proxy", "privacy", "fontSettings",
  "accessibilityFeatures", "publicSuffix", "desktopCapture", "tabCapture", "pageCapture", "tts", "ttsEngine", "printerProvider", "idle",
  "power", "system.cpu", "system.memory", "system.display", "system.storage", "identity", "gcm", "instanceID", "webAuthenticationProxy",
  "debugger", "devtools.inspectedWindow", "devtools.network", "devtools.panels", "devtools.performance", "devtools.recorder",
] as const;

export async function collectCapabilities(chromeApi: typeof chrome, options: {
  contexts?: chrome.runtime.ExtensionContext[];
} = {}): Promise<CapabilityReport> {
  const [rawPermissions, platform] = await Promise.all([
    chromeApi.permissions?.getAll?.().catch(() => ({})) ?? Promise.resolve({}),
    chromeApi.runtime?.getPlatformInfo?.().catch(() => undefined),
  ]);
  const permissions = rawPermissions as chrome.permissions.Permissions;
  const version = Number(globalThis.navigator?.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1]) || undefined;
  const contexts = options.contexts ?? await chromeApi.runtime?.getContexts?.({}).catch(() => []) ?? [];
  const has = (type: chrome.runtime.ExtensionContext["contextType"]) => contexts.some((item) => item.contextType === type);
  const userScripts = Boolean(chromeApi.userScripts);
  const documentWithMcp = globalThis.document as Document & { modelContext?: unknown } | undefined;
  const apiValue = (path: string) => path.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], chromeApi);
  const manifest = chromeApi.runtime.getManifest() as chrome.runtime.ManifestV3 & Record<string, unknown>;
  return {
    browser: { version, platform: platform?.os, extensionId: chromeApi.runtime.id },
    permissions: { permissions: permissions.permissions ?? [], origins: permissions.origins ?? [] },
    hosts: {
      extension: { available: true },
      serviceWorker: { available: has("BACKGROUND") },
      pageMain: { available: true },
      pageIsolated: { available: Boolean(chromeApi.debugger) },
      userScript: userScripts ? { available: true } : {
        available: false,
        reason: "User Scripts is paused in this build.",
      },
      offscreen: has("OFFSCREEN_DOCUMENT") ? { available: true } : {
        available: Boolean(chromeApi.offscreen),
        reason: chromeApi.offscreen ? "The offscreen host will be created on first use." : "The offscreen API is unavailable.",
      },
      devtools: has("DEVELOPER_TOOLS") ? { available: true } : {
        available: false,
        reason: "No DevTools extension page is open.",
        action: "Open DevTools for a tab and retry.",
      },
    },
    cdp: { available: Boolean(chromeApi.debugger), domains: CDP_DOMAINS },
    extensionApis: Object.fromEntries(EXTENSION_APIS.map((name) => [name, apiValue(name)
      ? { available: true }
      : { available: false, reason: `chrome.${name} is not exposed in the current extension context, version, platform, or manifest.` }])),
    manifest: Object.fromEntries(["commands", "omnibox", "devtools_page", "mime_types_handler", "tts_engine", "externally_connectable", "web_accessible_resources"]
      .map((name) => [name, manifest[name]
        ? { available: true }
        : { available: false, reason: `${name} is not declared by this build.` }])),
    web: {
      languageModel: "LanguageModel" in globalThis,
      summarizer: "Summarizer" in globalThis,
      translator: "Translator" in globalThis,
      languageDetector: "LanguageDetector" in globalThis,
      webMcp: Boolean(documentWithMcp?.modelContext),
    },
  };
}
