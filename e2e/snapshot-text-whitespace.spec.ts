import { expect } from "@playwright/test";
import { snapshotDomSupplement } from "../src/chrome/snapshot-dom";
import { SNAPSHOT_COMPUTED_STYLES, snapshotVisibility } from "../src/chrome/snapshot-visibility";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

test.use({ screenshot: "off", trace: "off" });

test("uses Chrome's text boxes for visible whitespace in snapshots", async () => {
  test.setTimeout(90_000);
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  try {
    const page = await opened.context.newPage();
    await page.goto(`${provider.origin}/target`);
    await page.evaluate(() => {
      document.body.innerHTML = `<a href="#" id="indent" style="display:block">\n            1\n          </a>
        <button id="spaced"><span>Save </span><span> changes</span></button>
        <button id="joined"><span>Save</span><span>changes</span></button>
        <div id="space"><span>A</span>   <span>B</span></div>
        <div id="nbsp">A&nbsp; &nbsp;B</div>
        <div id="pre" style="white-space:pre"> A  B\n C </div>
        <div id="wrap" style="white-space:pre-wrap"> A  B\n C </div>
        <div id="break" style="white-space:break-spaces"> A  B\n C </div>
        <div id="line" style="white-space:pre-line"> A  B \n C </div>
        <div id="soft" style="width:20px">A B C</div>`;
    });
    const cdp = await opened.context.newCDPSession(page);
    const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [...SNAPSHOT_COMPUTED_STYLES], includeDOMRects: true, includePaintOrder: true });
    await cdp.detach();
    const documentSnapshot = snapshot.documents[0]!, strings = snapshot.strings;
    const { attributes = [], backendNodeId = [], parentIndex = [] } = documentSnapshot.nodes;
    const visibility = snapshotVisibility(snapshot);
    const { items } = snapshotDomSupplement(snapshot, { visibility, covered: new Set() });
    const parentId = (id: string): number => {
      const index = attributes.findIndex((attrs) => attrs?.some((entry, i) => strings[entry] === "id" && strings[attrs[i + 1]!] === id));
      return backendNodeId[index]!;
    };
    const children = (id: string) => items.filter((item) => item.parentBackendNodeId === parentId(id) && item.kind === "text");
    expect(children("indent")).toMatchObject([{ text: "1", textWhitespaceProven: true }]);
    expect(children("space")).toMatchObject([{ text: " ", textWhitespaceProven: true }]);
    expect(children("nbsp")).toMatchObject([{ text: "A\u00a0 \u00a0B", textWhitespaceProven: true }]);
    for (const id of ["pre", "wrap", "break"]) expect(children(id)).toMatchObject([{ text: " A  B\n C ", preserveTextWhitespace: true }]);
    expect(children("line")).toMatchObject([{ text: "A B\nC", preserveTextWhitespace: true }]);
    expect(children("soft")).toMatchObject([{ text: "A B C", textWhitespaceProven: true }]);
    const fragmentText = (id: string) => {
      const parent = parentId(id), spanIds = new Set(items.filter((item) => item.parentBackendNodeId === parent).map((item) => item.backendNodeId));
      // SPANs are not emitted as supplementary controls, so locate them in the captured DOM.
      parentIndex.forEach((parentIndexValue, index) => { if (backendNodeId[parentIndexValue] === parent) spanIds.add(backendNodeId[index]!); });
      return items.filter((item) => item.kind === "text" && spanIds.has(item.parentBackendNodeId!)).map((item) => item.text).join("");
    };
    expect(fragmentText("spaced")).toBe("Save changes");
    expect(fragmentText("joined")).toBe("Savechanges");

    let inspected: any;
    responses.push(commandResponse("inspect_page", { budget: 12000 }, "whitespace-inspect"), (request) => {
      const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
      inspected = JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
      return textResponse("WHITESPACE_DONE");
    });
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await page.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the content");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("WHITESPACE_DONE", { timeout: 60_000 });
    const lines = inspected.items.map((item: any) => item.line).join("\n");
    expect(lines).not.toContain('"\\n            1\\n          "');
    expect(lines).toContain('" A  B\\n C "');
    expect(lines).toContain('"A B\\nC"');
    expect(lines).toContain("A\u00a0 \u00a0B");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
