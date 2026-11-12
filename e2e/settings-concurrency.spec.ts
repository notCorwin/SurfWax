import { configure, dispose, openExtension, startProvider, test, expect } from "./fixtures";

test("stale settings drafts preserve the other page's saved configuration", { tag: "@user-journey" }, async () => {
  const provider = await startProvider([]);
  const opened = await openExtension();
  try {
    await opened.context.route("https://models.dev/**", route => route.abort());
    const probe = await opened.page.evaluate(async () => {
      const sample = { z: 1, a: { z: 2, a: 3 } };
      await chrome.storage.local.set({ "settings-order-probe": sample });
      const roundtrip = (await chrome.storage.local.get("settings-order-probe"))["settings-order-probe"] as typeof sample;
      await chrome.storage.local.remove("settings-order-probe");
      return { oldComparison: JSON.stringify(sample) === JSON.stringify(roundtrip), before: Object.keys(sample), after: Object.keys(roundtrip) };
    });
    console.log("Synthetic storage probe:", probe);
    expect(probe.oldComparison).toBe(false);
    const initial = await configure(opened.context, opened.page, provider.baseURL);
    await initial.getByLabel("Model ID", { exact: true }).fill("same-page-second-save");
    await initial.getByRole("button", { name: "保存配置" }).click();
    await expect.poll(() => initial.evaluate(async () => ((await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"] as { profiles?: { custom?: { model?: string } } })?.profiles?.custom?.model)).toBe("same-page-second-save");
    await initial.close();
    const a = await opened.context.newPage();
    const b = await opened.context.newPage();
    const url = `chrome-extension://${opened.extensionId}/options.html`;
    await Promise.all([a.goto(url), b.goto(url)]);
    await expect(a.getByLabel("Model ID", { exact: true })).toHaveValue("same-page-second-save");
    await expect(b.getByLabel("Model ID", { exact: true })).toHaveValue("same-page-second-save");
    const original = await a.evaluate(async () => (await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"]);
    await a.getByLabel("Model ID", { exact: true }).fill("model-from-a");
    await a.getByLabel("API Key", { exact: true }).fill("fake-key-from-a");
    await b.getByLabel("Model ID", { exact: true }).fill("draft-canary-from-b");
    await a.getByRole("button", { name: "保存配置" }).click();
    await expect(a.getByRole("status")).toContainText("配置已保存");
    const saved = await a.evaluate(async () => (await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"]);
    expect(saved).toMatchObject({ selectedProviderId: "custom", profiles: { custom: { model: "model-from-a", providerSettings: { apiKey: "fake-key-from-a" }, baseURL: provider.baseURL } } });
    const savedProfile = (saved as { profiles: { custom: { contextWindowOverride?: number } } }).profiles.custom;
    const originalProfile = (original as { profiles: { custom: { contextWindowOverride?: number } } }).profiles.custom;
    expect(savedProfile.contextWindowOverride).toEqual(originalProfile.contextWindowOverride);
    await b.getByRole("button", { name: "保存配置" }).click();
    const error = b.getByRole("alert");
    await expect(error).toContainText("配置已在其他页面更改。请复制当前草稿，然后重新加载页面。");
    await expect(error).not.toContainText(/draft-canary-from-b|fake-key-from-a|stack/i);
    const draft = b.getByLabel("Model ID", { exact: true });
    await expect(draft).toHaveValue("draft-canary-from-b");
    await draft.selectText();
    await b.keyboard.press("ControlOrMeta+c");
    await draft.fill("");
    await b.keyboard.press("ControlOrMeta+v");
    await expect(draft).toHaveValue("draft-canary-from-b");
    expect(await b.evaluate(async () => (await chrome.storage.local.get("side-agent:model-config"))["side-agent:model-config"])).toEqual(saved);
    b.once("dialog", dialog => dialog.accept());
    await b.reload();
    await expect(b.getByLabel("Model ID", { exact: true })).toHaveValue("model-from-a");
    await expect(b.getByLabel("API Key", { exact: true })).toHaveValue("fake-key-from-a");
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
  }
});
