import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

test("exposes editable hosts and preserves their usable refs across regions and frames", async () => {
  test.setTimeout(120_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let initial: any, withActions: any, region: any, richFill: any, plainType: any, childFill: any, hiddenFill: any, articleFill: any, hiddenRoleFill: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => {
      document.body.innerHTML = `
        <div id="rich" contenteditable="true" aria-label="Rich editor" style="border:1px solid">Initial <b>rich text</b></div>
        <div id="plain" contenteditable="plaintext-only" aria-label="Plain editor" style="border:1px solid">Initial plain</div>
        <div id="outer" contenteditable="true" aria-label="Outer editor" style="border:1px solid">
          Outer <span aria-label="Inherited child">inherited text</span><span aria-label="Fixed child" contenteditable="false">fixed text</span>
        </div>
        <input aria-label="Native textbox" value="Native value">
        <div contenteditable="false" aria-label="Locked area">Locked text</div>
        <div role="article" contenteditable="true" aria-label="Article editor">Article text</div>
        <div role="button" contenteditable="true" aria-label="Button editor">Button text</div>
        <div role="heading" contenteditable="plaintext-only" aria-label="Heading editor">Heading text</div>
        <div role="textbox" contenteditable="plaintext-only" aria-label="ARIA textbox editor">Textbox text</div>
        <div role="searchbox" contenteditable="true" aria-label="ARIA search editor">Search text</div>
        <div role="spinbutton" contenteditable="true" aria-label="ARIA spin editor">Spin text</div>
        <div role="article" contenteditable="true" aria-readonly="true" aria-label="Read-only editor">Read-only text</div>
        <div role="article" contenteditable="true" aria-disabled="true" aria-label="Disabled editor">Disabled text</div>
        <div role="article" tabindex="0" style="-webkit-user-modify:read-write" aria-label="CSS-only editor">CSS-only text</div>
        <div role="article" contenteditable="true" style="-webkit-user-modify:read-write-plaintext-only" aria-label="CSS plaintext editor">Plain text</div>
        <div role="article" contenteditable="plaintext-only" style="-webkit-user-modify:read-write" aria-label="CSS rich editor">Rich text</div>
        <div role="article" tabindex="0" contenteditable="true" style="-webkit-user-modify:read-only" aria-label="CSS read-only editor">Read-only text</div>
        <button contenteditable="true" aria-label="Native button">Native button text</button>
        <section aria-hidden="true">
          <div id="ax-hidden" contenteditable="true" aria-label="AX hidden editor" style="border:1px solid">Visible editor</div>
          <div role="button" id="ax-hidden-role" contenteditable="true" aria-label="AX hidden role editor">AX hidden role text</div>
          <div role="textbox" contenteditable="true" aria-readonly="true" aria-label="AX hidden read-only">Read-only text</div>
          <div role="article" contenteditable="true" aria-disabled="true" aria-label="AX hidden disabled">Disabled text</div>
          <div role="article" contenteditable="true" style="-webkit-user-modify:read-write-plaintext-only" aria-label="AX hidden CSS plaintext">Plain text</div>
          <div role="article" contenteditable="plaintext-only" style="-webkit-user-modify:read-write" aria-label="AX hidden CSS rich">Rich text</div>
          <div role="article" contenteditable="true" style="-webkit-user-modify:read-only" aria-label="AX hidden CSS read-only">Read-only text</div>
          <div contenteditable="plaintext-only" aria-label="AX hidden plain" style="border:1px solid">
            <span tabindex="0" aria-label="AX hidden inherited">Inherited and focusable</span>
            <span contenteditable="false" aria-label="AX hidden fixed">Fixed text</span>
          </div>
        </section>
        <iframe title="Child editor" style="width:450px;height:120px" srcdoc="&lt;div contenteditable='true' aria-label='Frame editor' style='border:1px solid'&gt;Frame initial&lt;/div&gt;"></iframe>`;
      const section = document.querySelector('section[aria-hidden="true"]')!;
      for (const mode of ["open", "closed"] as const) {
        const host = document.createElement("div"); host.contentEditable = "plaintext-only";
        host.attachShadow({ mode }).innerHTML = "<slot></slot>";
        const child = document.createElement("span"); child.tabIndex = 0;
        child.setAttribute("aria-label", `${mode} slot editor`); child.textContent = `${mode} slot text`;
        host.append(child); section.append(host);
      }
    });
    await expect(target.frameLocator('iframe[title="Child editor"]').locator('[contenteditable]')).toBeVisible();
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "editable-initial"), (request) => {
      initial = lastTool(request);
      const byName = (name: string) => initial.items?.find((item: any) => item.line.includes(`"${name}"`));
      const rich = byName("Rich editor")?.ref, plain = byName("Plain editor")?.ref, child = byName("Frame editor")?.ref, hidden = byName("AX hidden editor")?.ref;
      const article = byName("Article editor")?.ref, hiddenRole = byName("AX hidden role editor")?.ref;
      if (!rich || !plain || !child || !hidden || !article || !hiddenRole) return textResponse("EDITABLE_TEST_DONE");
      responses.unshift(
        (next) => { withActions = lastTool(next); return commandResponse("inspect_page", { region: { ref: rich }, budget: 12000 }, "editable-region"); },
        (next) => { region = lastTool(next); return commandResponse("fill", { target: { ref: rich }, value: "RICH_UPDATED" }, "editable-rich-fill"); },
        (next) => { richFill = lastTool(next); return commandResponse("type_text", { target: { ref: plain }, text: "_TYPED" }, "editable-plain-type"); },
        (next) => { plainType = lastTool(next); return commandResponse("fill", { target: { ref: child }, value: "FRAME_UPDATED" }, "editable-frame-fill"); },
        (next) => { childFill = lastTool(next); return commandResponse("fill", { target: { ref: hidden }, value: "AX_HIDDEN_UPDATED" }, "editable-ax-hidden-fill"); },
        (next) => { hiddenFill = lastTool(next); return commandResponse("fill", { target: { ref: article }, value: "ARTICLE_UPDATED" }, "editable-article-fill"); },
        (next) => { articleFill = lastTool(next); return commandResponse("fill", { target: { ref: hiddenRole }, value: "HIDDEN_ROLE_UPDATED" }, "editable-hidden-role-fill"); },
        (next) => { hiddenRoleFill = lastTool(next); return textResponse("EDITABLE_TEST_DONE"); },
      );
      return commandResponse("inspect_page", { fields: ["text", "state", "ref", "actions"], budget: 12000 }, "editable-actions");
    }, textResponse("Inspect the editors"));
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect and update the editable regions");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("EDITABLE_TEST_DONE", { timeout: 90_000 });

    expect(initial).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    const line = (name: string) => initial.items.find((item: any) => item.line.includes(`"${name}"`))?.line as string | undefined;
    expect(line("Rich editor")).toContain("[editable=richtext]");
    expect(line("Plain editor")).toContain("[editable=plaintext]");
    expect(line("Outer editor")).toContain("[editable=richtext]");
    expect(line("Frame editor")).toContain("[editable=richtext]");
    expect(line("AX hidden editor")).toContain("[editable=richtext]");
    expect(line("AX hidden plain")).toContain("[editable=plaintext]");
    expect(line("AX hidden inherited")).toContain("[editable=plaintext]");
    expect(line("Article editor")).toContain('article "Article editor" [editable=richtext]');
    expect(line("Button editor")).toContain('button "Button editor" [editable=richtext]');
    expect(line("Heading editor")).toContain('heading "Heading editor" [editable=plaintext]');
    expect(line("ARIA textbox editor")).toContain("editable=plaintext");
    expect(line("ARIA search editor")).toContain("editable=richtext");
    expect(line("ARIA spin editor")).toContain("editable=richtext");
    expect(line("CSS plaintext editor")).toContain("editable=plaintext");
    expect(line("CSS rich editor")).toContain("editable=richtext");
    expect(line("AX hidden CSS plaintext")).toContain("editable=plaintext");
    expect(line("AX hidden CSS rich")).toContain("editable=richtext");
    expect(line("open slot editor")).toContain("editable=plaintext");
    expect(line("closed slot editor")).toContain("editable=plaintext");
    expect(line("AX hidden role editor")).toContain('button "AX hidden role editor" [editable=richtext]');
    expect(line("Native button")).not.toContain("[editable=");
    expect(line("AX hidden fixed") ?? "").not.toContain("[editable=");
    expect(line("Inherited child") ?? "").not.toContain("[editable=");
    expect(line("Fixed child") ?? "").not.toContain("[editable=");
    expect(line("Locked area") ?? "").not.toContain("[editable=");
    expect(line("Native textbox")).toContain("textbox");
    for (const name of ["Read-only editor", "AX hidden read-only", "CSS read-only editor", "AX hidden CSS read-only"]) {
      expect(line(name)).toContain("readonly=true");
      expect(line(name)).not.toContain("editable=");
    }
    for (const name of ["Disabled editor", "AX hidden disabled"]) {
      expect(line(name)).toContain("disabled=true");
      expect(line(name)).not.toContain("editable=");
    }
    expect(line("CSS-only editor")).not.toContain("editable=");
    for (const name of ["Rich editor", "Plain editor", "Frame editor", "AX hidden editor", "AX hidden inherited", "Article editor", "Button editor", "Heading editor", "AX hidden role editor", "ARIA textbox editor", "ARIA search editor", "ARIA spin editor", "CSS plaintext editor", "CSS rich editor", "AX hidden CSS plaintext", "AX hidden CSS rich", "open slot editor", "closed slot editor"]) {
      const item = withActions?.items?.find((entry: any) => entry.line.includes(`"${name}"`));
      expect(item?.line).toContain("[actions=click,fill,press_key,type_text]");
    }
    for (const name of ["Read-only editor", "AX hidden read-only", "Disabled editor", "AX hidden disabled", "CSS-only editor", "CSS read-only editor", "AX hidden CSS read-only"]) {
      const item = withActions?.items?.find((entry: any) => entry.line.includes(`"${name}"`));
      expect(item?.line).not.toContain("fill");
      expect(item?.line).not.toContain("type_text");
    }
    expect(withActions?.items?.find((entry: any) => entry.line.includes('"Native button"'))?.line).not.toContain("type_text");
    expect(region).toMatchObject({ mode: "full" });
    expect(JSON.stringify(region.items)).toContain("[editable=richtext]");
    expect(JSON.stringify(region.items)).not.toContain("Plain editor");
    expect(richFill).toMatchObject({ ok: true });
    expect(plainType).toMatchObject({ ok: true });
    expect(childFill).toMatchObject({ ok: true });
    expect(hiddenFill).toMatchObject({ ok: true });
    expect(articleFill).toMatchObject({ ok: true });
    expect(hiddenRoleFill).toMatchObject({ ok: true });
    await expect(target.locator("#rich")).toHaveText("RICH_UPDATED");
    await expect(target.locator("#plain")).toContainText("_TYPED");
    await expect(target.frameLocator('iframe[title="Child editor"]').locator('[contenteditable]')).toHaveText("FRAME_UPDATED");
    await expect(target.locator("#ax-hidden")).toHaveText("AX_HIDDEN_UPDATED");
    await expect(target.getByLabel("Article editor")).toHaveText("ARTICLE_UPDATED");
    await expect(target.locator("#ax-hidden-role")).toHaveText("HIDDEN_ROLE_UPDATED");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});

test("handles designMode documents without treating the document node as an element", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let snapshot: any, filled: any;
  try {
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    await target.evaluate(() => { document.body.innerHTML = "<p>DESIGN_MODE_INITIAL</p>"; document.designMode = "on"; });
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "design-mode-inspect"), (request) => {
      snapshot = lastTool(request);
      const editor = snapshot.items?.find((item: any) => item.line.includes("generic") && item.line.includes("[editable=richtext]") && item.ref);
      if (!editor?.ref) return textResponse("DESIGN_MODE_DONE");
      responses.unshift((next) => { filled = lastTool(next); return textResponse("DESIGN_MODE_DONE"); });
      return commandResponse("fill", { target: { ref: editor.ref }, value: "DESIGN_MODE_UPDATED" }, "design-mode-fill");
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect and edit the page");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DESIGN_MODE_DONE", { timeout: 60_000 });
    expect(snapshot).toMatchObject({ mode: "full", items: expect.any(Array) });
    expect(filled).toMatchObject({ ok: true });
    await expect(target.locator("body")).toHaveText("DESIGN_MODE_UPDATED");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
