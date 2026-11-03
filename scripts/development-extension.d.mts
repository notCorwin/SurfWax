import type { BrowserContext, CDPSession, Page } from "@playwright/test";
export function systemChromePath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, verifyInstalled?: boolean): string;
export function startDevelopmentExtension(options?: { cwd?: string; tmpdir?: string; timeoutMs?: number }): Promise<{
  extensionPath: string; url: string; port: number; close(): Promise<void>;
}>;

export function fitWindowToScreen(context: BrowserContext, page: Page, session?: CDPSession): Promise<void>;
