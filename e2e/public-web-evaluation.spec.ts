import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test, openExtension, configure, dispose, closeServer, readEvents } from "./fixtures";
import { modelProxy, usageEvidence } from "./evaluation/model-proxy";
import { deadlineEvidence } from "./evaluation/deadline-evidence";
import { toolLifecycleEvidence } from "./evaluation/tool-lifecycle";
import { browserJobsSettled } from "./evaluation/job-evidence";
import { fromLogValue, isConversationMessage } from "../src/logging";

test.use({ trace: "off", screenshot: "off", video: "off" });

// Public pages change: these runs collect reviewable evidence, rather than
// treating a plausible answer or a finished conversation as a business pass.
const tasks = [
  {
    id: "wikipedia-telescope-comparison",
    startURL: "https://en.wikipedia.org/wiki/James_Webb_Space_Telescope",
    evidenceURLs: ["https://en.wikipedia.org/wiki/James_Webb_Space_Telescope", "https://en.wikipedia.org/wiki/Hubble_Space_Telescope"],
    fields: ["launch date", "primary mirror diameter", "orbital location", "named scientific instruments", "source URLs"],
    prompt: "请只读浏览英文 Wikipedia 的 James Webb Space Telescope 与 Hubble Space Telescope 两个条目，必要时沿条目链接核验。制作对照表：各自发射日期、主镜直径、所在轨道位置，以及各两个具名科学仪器及其用途。给每一行事实附上具体页面 URL/章节链接，并说明 Hubble 当前与历史仪器的区别。必须实际浏览两个条目；不要修改网页或登录。最终用中文回答，不能把搜索摘要当作正文证据。",
  },
  {
    id: "github-release-and-firefox-issues",
    startURL: "https://github.com/microsoft/playwright",
    evidenceURLs: ["https://github.com/microsoft/playwright/releases", "https://github.com/microsoft/playwright/issues"],
    fields: ["latest stable release tag", "release publication date", "three release changes", "three open Firefox bug issue numbers/titles/labels/URLs", "issue query"],
    prompt: "请只读浏览 GitHub 的 microsoft/playwright 公开仓库。进入 Releases 找到当前最新非 prerelease、非 draft 的稳定发布，报告 tag、发布日期、三个具体变更与发布链接。再进入 Issues，查找 open、带 browser-firefox 和 bug 标签的 issue，按最新创建排序，列出前三条的编号、完整标题、标签和详情 URL，并打开各自详情核验仍为 open。报告实际使用的查询及访问时间；若不足三条，明确数量与原因。不要登录、创建或修改任何内容。最终用中文回答并提供来源链接。",
  },
] as const;

for (const task of tasks) test(`@real-model public web ${task.id}`, async () => {
  test.skip(process.env.SURFWAX_REAL_MODEL_EVAL !== "1", "Explicit real-model opt-in required");
  const timeoutMs = Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 600_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_363_647) throw new Error("Invalid evaluation timeout");
  test.setTimeout(timeoutMs + 120_000);
  const upstream = process.env.SURFWAX_EVAL_BASE_URL;
  const key = process.env.SURFWAX_EVAL_API_KEY;
  const model = process.env.SURFWAX_EVAL_MODEL;
  if (!upstream || !key || !model) throw new Error("Set SURFWAX_EVAL_BASE_URL, SURFWAX_EVAL_API_KEY and SURFWAX_EVAL_MODEL");
  const proxy = await modelProxy(upstream, key);
  const directory = resolve(process.env.SURFWAX_PUBLIC_EVAL_REPORT_DIR ?? ".dev/verification/public-web-baseline", `${Date.now()}-${task.id}-${randomUUID()}`);
  const redact = (value: unknown) => JSON.stringify(value, null, 2).split(key).join("[credential removed]").split(proxy.token).join("[proxy credential removed]");
  let opened: Awaited<ReturnType<typeof openExtension>> | undefined;
  let events: any[] = [], error: string | null = null;
  let startedAt: number | null = null, deadlineAt: number | null = null;
  let outcome = "setup_failed";
  const navigations: Array<{ timestamp: string; url: string }> = [];
  const pages: Array<{ url: string; title: string; text: string | null }> = [];
  const observed = new WeakSet<Page>();
  const observe = (page: Page) => {
    if (observed.has(page)) return;
    observed.add(page);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && /^https?:/.test(frame.url())) navigations.push({ timestamp: new Date().toISOString(), url: frame.url() });
    });
  };
  try {
    opened = await openExtension();
    opened.context.pages().forEach(observe);
    opened.context.on("page", observe);
    const target = await opened.context.newPage();
    await target.goto(task.startURL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const options = await configure(opened.context, opened.page, proxy.baseURL, 256_000, { goalMode: true });
    await options.getByLabel("Model ID", { exact: true }).fill(model);
    await options.getByLabel("API Key", { exact: true }).fill(proxy.token);
    await options.getByRole("button", { name: "保存配置" }).click();
    await expect(options.getByRole("status")).toContainText("配置已保存");
    await expect.poll(() => options.evaluate(async ({ model, token, baseURL }) => {
      const values = await chrome.storage.local.get("side-agent:model-config");
      const saved = values["side-agent:model-config"] as { profiles?: Record<string, { model?: string; providerSettings?: { apiKey?: string }; baseURL?: string }> } | undefined;
      const profile = saved?.profiles?.custom;
      return profile?.model === model && profile?.providerSettings?.apiKey === token && profile?.baseURL === baseURL;
    }, { model, token: proxy.token, baseURL: proxy.baseURL })).toBe(true);
    await options.close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill(task.prompt);
    startedAt = Date.now(); deadlineAt = startedAt + timeoutMs;
    await opened.page.getByTestId("composer-input").press("Enter");
    while (Date.now() < deadlineAt) {
      events = await readEvents(opened.page);
      if (deadlineEvidence(events, startedAt, deadlineAt).state !== "pending") break;
      await new Promise((done) => setTimeout(done, Math.min(1000, Math.max(0, deadlineAt! - Date.now()))));
    }
    events = await readEvents(opened.page);
    const terminal = deadlineEvidence(events, startedAt, deadlineAt);
    outcome = terminal.state === "on_time" ? terminal.terminal! : terminal.state === "unknown" ? "terminal_time_unknown" : "timed_out";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    try {
      if (opened) {
        events = await readEvents(opened.page).catch(() => events);
        // Independent end-state page text supplements the model's cited facts.
        // This does not navigate pages or help the model solve its task.
        for (const page of opened.context.pages()) {
          if (!/^https:\/\/(en\.wikipedia\.org|github\.com)\//.test(page.url())) continue;
          pages.push({ url: page.url(), title: await page.title().catch(() => ""), text: await page.locator("body").innerText({ timeout: 3000 }).catch(() => null) });
        }
      }
      const messages = events.filter((event) => event.type === "conversation.message").map((event) => fromLogValue(event.content, event.valueEncoding)).filter(isConversationMessage);
      const assistantReplies = messages.filter((message) => message.role === "assistant").map((message) => message.parts.flatMap((part) => {
        if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") return [];
        return [part.text];
      }).join("\n")).filter(Boolean);
      const lifecycle = toolLifecycleEvidence(events);
      const jobsSettled = browserJobsSettled(events);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "canonical-events.json"), redact(events), { flag: "wx" });
      await writeFile(resolve(directory, "page-evidence.json"), redact({ navigations, pages }), { flag: "wx" });
      await writeFile(resolve(directory, "report.json"), redact({
        task: task.id, prompt: task.prompt, model, provider: process.env.SURFWAX_EVAL_PROVIDER ?? "custom",
        startedAt, deadlineAt, outcome, error,
        classification: "unknown", reviewRequired: true,
        reviewReason: "Public-web factual accuracy requires comparing the final answer with source page evidence; conversation completion alone is not a pass.",
        requiredEvidenceURLs: task.evidenceURLs, requiredFields: task.fields,
        finalReply: assistantReplies.at(-1) ?? null, assistantReplies,
        lifecycle, jobsSettled, requests: structuredClone(proxy.requests), usage: usageEvidence(events),
      }), { flag: "wx" });
      expect(outcome, `Evidence saved to ${directory}`).toBe("conversation.finished");
      expect(lifecycle.complete, "Every tool must have one terminal").toBe(true);
      expect(events.some((event) => event.type === "tool.started"), "The model must operate browser tools").toBe(true);
      expect(jobsSettled, "Browser tasks must settle").toBe(true);
      expect(assistantReplies.length, "A final answer is required").toBeGreaterThan(0);
    } finally {
      // Closing the browser aborts pending model requests before closing proxy.
      try { if (opened) await dispose(opened.context, opened.userDataDirectory); }
      finally { await closeServer(proxy.server); }
    }
  }
});
