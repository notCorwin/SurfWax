import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const value = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(value) ? value.find((part: any) => part.type === "text").text : value);
};

test("stops targeted keyboard input when page handlers redirect focus", async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/automation`);
    await page.evaluate(() => {
      document.body.innerHTML = '<input id="redirect" value="original"><input id="other" value="untouched"><input id="typing"><input id="keydown" value="existing">';
      const redirect = document.querySelector<HTMLInputElement>("#redirect")!;
      const other = document.querySelector<HTMLInputElement>("#other")!;
      redirect.addEventListener("focus", () => other.focus());
      other.addEventListener("keydown", (event) => { document.body.dataset.otherKeys = `${document.body.dataset.otherKeys || ""}${event.key},`; });
      document.querySelector<HTMLInputElement>("#typing")!.addEventListener("input", () => other.focus());
      document.querySelector<HTMLInputElement>("#keydown")!.addEventListener("keydown", () => other.focus());
    });
    const css = (value: string) => ({ by: "css", value });
    const error = (request: any) => expect(lastTool(request)).toMatchObject({ ok: false, error: { code: "focus-lost", effectUnknown: true } });
    responses.push(
      commandResponse("fill", { target: css("#redirect"), value: "secret" }, "redirected-fill"),
      (request) => { error(request); return commandResponse("press_key", { target: css("#redirect"), key: "x" }, "redirected-press"); },
      (request) => { error(request); return commandResponse("type_text", { target: css("#typing"), text: "abc" }, "partial-type"); },
      (request) => { error(request); return commandResponse("fill", { target: css("#keydown"), value: "replacement" }, "direct-fill"); },
      (request) => { expect(lastTool(request)).toMatchObject({ ok: true }); return textResponse("FOCUS_BINDING_OK"); },
      textResponse("Focus binding"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Run the focus checks");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOCUS_BINDING_OK", { timeout: 60_000 });
    expect(await page.evaluate(() => ({ redirect: document.querySelector<HTMLInputElement>("#redirect")!.value,
      other: document.querySelector<HTMLInputElement>("#other")!.value,
      typing: document.querySelector<HTMLInputElement>("#typing")!.value,
      keydown: document.querySelector<HTMLInputElement>("#keydown")!.value,
      otherKeys: document.body.dataset.otherKeys ?? "" })))
      .toEqual({ redirect: "original", other: "untouched", typing: "a", keydown: "replacement", otherKeys: "" });
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("keeps normal targeted typing usable inside shadow roots and cross-origin frames", async () => {
  const provider = await startProvider([
    commandResponse("execute_program", { code: `
await page.locator('#shadow-host').locator('input').fill('shadow');
await page.frameLocator('iframe[src*="localhost"]').locator('#frame-input').fill('frame');
await page.frameLocator('iframe[src*="localhost"]').locator('#frame-input').pressSequentially('!');
return true;` }, "shadow-frame-input"),
    (request) => { expect(lastTool(request)).toMatchObject({ ok: true, result: true }); return textResponse("FOCUS_FRAMES_OK"); },
    textResponse("Focus frames"),
  ]);
  const opened = await openExtension();
  try {
    const page = await opened.context.newPage(); await page.goto(`${provider.origin}/complex`);
    await page.evaluate(() => {
      const host = document.createElement("div"); host.id = "shadow-host";
      host.attachShadow({ mode: "open" }).innerHTML = '<input id="shadow-input">'; document.body.append(host);
      const frame = document.querySelector<HTMLIFrameElement>('iframe[src*="localhost"]')!;
      frame.style.cssText = "width:540px;height:360px;transform:none";
    });
    const frame = page.frames().find((value) => value.url().includes("localhost"))!;
    await frame.evaluate(() => { document.body.innerHTML = '<input id="frame-input">'; });
    await (await configure(opened.context, opened.page, provider.baseURL)).close(); await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Type in shadow and frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FOCUS_FRAMES_OK", { timeout: 60_000 });
    expect(await page.locator("#shadow-host").evaluate((host) => (host.shadowRoot!.querySelector("input") as HTMLInputElement).value)).toBe("shadow");
    expect(await frame.locator("#frame-input").inputValue()).toBe("frame!");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
