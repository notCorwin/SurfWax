import { expect } from "@playwright/test";
import { test, commandResponse, delayedResponse, textResponse, startProvider, openExtension, dispose, configure, type MockResponse } from "./fixtures";

const lastTool = (request: any) => {
  const content = request.messages.findLast((message: any) => message.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
};

for (const kind of ["same-process", "cross-process", "nested-in-oopif"] as const) test(`preserves a file chooser when an unrelated ${kind} sibling navigates`, async () => {
  const responses: MockResponse[] = [];
  const provider = await startProvider(responses);
  const opened = await openExtension();
  try {
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    const target = await opened.context.newPage();
    await target.goto(`${provider.origin}/target`);
    const frameOrigin = kind === "same-process" ? provider.origin : provider.origin.replace("127.0.0.1", "localhost");
    if (kind === "nested-in-oopif") await target.evaluate((url) => {
      const frame = document.createElement("iframe"); frame.id = "outer"; frame.style.cssText = "width:900px;height:500px"; frame.src = url; document.body.append(frame);
    }, `${frameOrigin}/same-frame`);
    const container = kind === "nested-in-oopif" ? target.frameLocator("#outer") : target;
    await container.locator("body").evaluate((body, url) => {
      for (const id of ["chooser-frame", "sibling-frame"]) {
        const frame = body.ownerDocument.createElement("iframe"); frame.id = id; frame.style.cssText = "width:320px;height:180px"; frame.src = url; body.append(frame);
      }
    }, `${frameOrigin}/same-frame`);
    const frame = container.frameLocator("#chooser-frame");
    await frame.locator("body").evaluate((body) => {
      body.innerHTML = '<input type="file" id="file" hidden><button id="open">Open chooser</button>';
      const input = body.querySelector<HTMLInputElement>("#file")!;
      body.querySelector<HTMLButtonElement>("#open")!.onclick = () => input.click();
      input.onchange = () => { body.dataset.file = input.files?.[0]?.name ?? ""; };
    });
    await expect(container.frameLocator("#sibling-frame").locator("body")).toBeVisible();
    let artifactId = 0, subscriptionId = "", chooserId = "";
    responses.push(
      commandResponse("create_text_artifact", { filename: "retained.txt", text: "file" }, "artifact"),
      (request) => { artifactId = lastTool(request).result.id; return commandResponse("subscribe_event", { kind: "filechooser" }, "subscribe"); },
      (request) => {
        subscriptionId = lastTool(request).subscriptionId;
        if (kind === "nested-in-oopif") return commandResponse("execute_program", {
          code: "return await page.frameLocator('#outer').frameLocator('#chooser-frame').locator('#open').click();", background: true,
        }, "open");
        return commandResponse("click", { target: { by: "css", value: "#open", frame: { by: "css", value: "#chooser-frame" } }, background: true }, "open");
      },
    );
    responses.push(() => commandResponse("wait_event", { subscriptionId, waitMs: 10000 }, "chooser"));
    responses.push(
      (request) => {
        chooserId = lastTool(request).events[0].payload.chooserId;
        const navigation = container.locator("#sibling-frame").evaluate(async (element, url) => {
          const frame = element as HTMLIFrameElement;
          await new Promise<void>((resolve, reject) => { frame.onload = () => resolve(); frame.onerror = () => reject(new Error("Frame navigation failed")); frame.src = url; });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }, `${frameOrigin}/same-frame?new=1`);
        return delayedResponse(commandResponse("upload_file", { chooserId, artifactId }, "upload"), 0, navigation) as any;
      },
      (request) => { expect(lastTool(request)).toMatchObject({ state: "completed" }); return textResponse("CHOOSER_RETAINED"); },
      textResponse("框架文件选择器"),
    );
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Upload after navigating the sibling frame");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("CHOOSER_RETAINED", { timeout: 60000 });
    await expect(frame.locator("body")).toHaveAttribute("data-file", "retained.txt");
  } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); }
});
