import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, delayedResponse, startProvider, openExtension, dispose, configure, readEvents, type MockResponse } from "./fixtures";

for (const removeInput of [false, true]) {
  test(`file chooser ${removeInput ? "rejects a removed input" : "survives history navigation"}`, async () => {
    const responses: MockResponse[] = [];
    const provider = await startProvider(responses);
    const opened = await openExtension();
    try {
      const target = await opened.context.newPage();
      await target.goto(`${provider.origin}/automation`);
      await target.evaluate(() => {
        const input = document.createElement("input");
        input.type = "file"; input.hidden = true; input.id = "original-input";
        input.onchange = () => { document.body.dataset.uploadName = input.files?.[0]?.name; };
        const button = document.createElement("button");
        button.id = "choose-history"; button.textContent = "Choose file";
        button.onclick = () => input.click();
        document.body.append(input, button);
      });
      let artifactId = 0, subscriptionId = "";
      const lastTool = (request: any) => JSON.parse(request.messages.findLast((entry: any) => entry.role === "tool").content);
      responses.push(
        commandResponse("create_text_artifact", { filename: "history.txt", text: "contents" }, "history-artifact"),
        (request) => { artifactId = lastTool(request).result.id; return commandResponse("subscribe_event", { kind: "filechooser" }, "history-subscribe"); },
        (request) => { subscriptionId = lastTool(request).subscriptionId; return commandResponse("click", { target: { by: "css", value: "#choose-history" }, background: true, timeoutMs: 30_000 }, "history-click"); },
        () => commandResponse("wait_event", { subscriptionId, waitMs: 10_000 }, "history-wait"),
        (request) => {
          const chooser = lastTool(request).events.find((item: any) => item.kind === "filechooser");
          expect(chooser.payload.chooserId).toBeTruthy();
          const navigation = target.evaluate(async (remove) => {
            history.pushState({}, "", "#after-choice");
            if (remove) {
              document.querySelector("#original-input")!.remove();
              const replacement = document.createElement("input");
              replacement.type = "file"; replacement.id = "replacement";
              replacement.onchange = () => { document.body.dataset.replacementChanged = "yes"; };
              document.body.append(replacement);
            }
            // Let the extension consume the navigation event before the upload tool starts.
            await new Promise((resolve) => setTimeout(resolve, 100));
          }, removeInput);
          return delayedResponse(commandResponse("upload_file", { chooserId: chooser.payload.chooserId, artifactId }, "history-upload"), 0, navigation) as any;
        },
        (request) => {
          const result = lastTool(request);
          if (removeInput) expect(result).toMatchObject({ ok: false, error: { code: "invalid-upload-target" } });
          else expect(result).toMatchObject({ state: "completed", artifactIds: [artifactId] });
          return textResponse("HISTORY_CHOOSER_OK");
        },
        textResponse("上传测试"),
      );
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill("choose the file");
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("HISTORY_CHOOSER_OK", { timeout: 30_000 });
      expect(new URL(target.url()).hash).toBe("#after-choice");
      if (removeInput) {
        expect(await target.locator("#replacement").evaluate((node: HTMLInputElement) => node.files?.length)).toBe(0);
        expect(await target.locator("body").getAttribute("data-replacement-changed")).toBeNull();
        expect((await readEvents(opened.page)).find((event) => event.toolCallId === "history-upload" && event.type === "tool.failed")).toBeDefined();
      } else {
        expect(await target.locator("body").getAttribute("data-upload-name")).toBe("history.txt");
      }
    } finally {
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  });
}
