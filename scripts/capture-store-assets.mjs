import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const profile = await mkdtemp(resolve(tmpdir(), "surf-wax-store-assets-"));
const extensionPath = resolve(process.env.SURFWAX_EXTENSION_PATH ?? "dist");
const output = resolve("docs/store/screenshot-1280x800.png");
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.SURFWAX_CHROME_PATH ?? chromium.executablePath(),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"],
});

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5_000 }).catch(() => undefined);
  let extensionId = worker ? new URL(worker.url()).hostname : "";
  if (!extensionId) {
    const extensions = await context.newPage();
    await extensions.goto("chrome://extensions/");
    extensionId = await extensions.evaluate(() => {
      const manager = document.querySelector("extensions-manager")?.shadowRoot;
      const list = manager?.querySelector("extensions-item-list")?.shadowRoot;
      const items = [...(list?.querySelectorAll("extensions-item") ?? [])];
      return items.find((item) => item.shadowRoot?.querySelector("#name")?.textContent?.trim() === "Surf Wax")?.id ?? "";
    });
    await extensions.close();
  }
  if (!extensionId) throw new Error("Could not discover the loaded Surf Wax extension ID");
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.evaluate(async () => chrome.storage.local.set({
    "side-agent:model-config": {
      selectedProviderId: "custom",
      profiles: { custom: { providerId: "custom", sdk: "@ai-sdk/openai-compatible", providerSettings: {},
        baseURL: "http://127.0.0.1:11434/v1", model: "local-assistant", endpointType: "openai-chat-completions", imageInput: "auto" } },
    },
  }));
  await page.reload();
  await page.getByTestId("composer-input").waitFor();
  await page.evaluate(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open("side-agent-runtime");
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("events", "readwrite");
    const store = transaction.objectStore("events");
    const conversationId = "store-preview";
    const runId = "store-preview-run";
    const started = new Date("2026-10-15T05:00:00.000Z").toISOString();
    const finished = new Date("2026-10-15T05:00:08.000Z").toISOString();
    store.add({ type: "conversation.created", conversationId, timestamp: started, content: { title: "整理发布前检查" } });
    store.add({ type: "conversation.title.updated", conversationId, timestamp: started, content: { title: "整理发布前检查", source: "manual" } });
    store.add({ type: "conversation.message", conversationId, timestamp: started, parentId: null,
      content: { id: "store-user", role: "user", parts: [{ type: "text", text: "检查当前页面并整理发布前需要处理的事项。" }] } });
    store.add({ type: "conversation.submitted", conversationId, runId, timestamp: started, content: { messageId: "store-user" } });
    store.add({ type: "conversation.message", conversationId, runId, timestamp: finished, parentId: "store-user",
      content: { id: "store-assistant", role: "assistant", parts: [{ type: "text", text: "## 检查完成\n\n- 页面结构与主要交互已核对\n- 风险项已按优先级整理\n- 下载文件前会再次请求你的确认\n\n可以继续查看详细结果，或让我处理下一项。" }] } });
    store.add({ type: "conversation.finished", conversationId, runId, timestamp: finished, content: { messageId: "store-assistant" } });
    await new Promise((resolveDone, reject) => {
      transaction.oncomplete = () => resolveDone();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  });
  await page.reload();
  await page.getByTestId("conversation-menu").click();
  await page.locator(".conversation-item", { hasText: "整理发布前检查" }).locator(".conversation-select").click();
  await page.locator(".markdown-body").last().getByText("检查完成").waitFor();
  await page.screenshot({ path: output });
  console.log(`Saved ${output}`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
