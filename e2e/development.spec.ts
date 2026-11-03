import { expect } from "@playwright/test";
import { test, configure, dispose, openExtension, startProvider, textResponse, commandResponse } from "./fixtures";

test("executes an atomic browser action without crashing the live development extension", async () => {
  const developmentURL = process.env.SURFWAX_DEV_SERVER_URL;
  if (!developmentURL) throw new Error("Start this test through the shared development extension setup.");
  const responses: Parameters<typeof startProvider>[0] = [];
  const actual = await startProvider(responses);
  responses.push(commandResponse("navigate", { url: `${actual.origin}/target` }, "development-navigate"), textResponse("DEV_SANDBOX_OK"));
  const opened = await openExtension();
  try {
    const target = await opened.context.newPage();
    await target.goto(`${actual.origin}/target`);
    await (await configure(opened.context, opened.page, actual.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("run through the development sandbox");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("DEV_SANDBOX_OK");
    await expect.poll(() => opened.context.serviceWorkers().length).toBe(1);
    const gatewayError = await opened.page.evaluate(async (url) => {
      const { generateText } = await import(/* @vite-ignore */ `${url}/node_modules/.vite/deps/ai.js`);
      const { GatewayAuthenticationError } = await import(/* @vite-ignore */ `${url}/node_modules/.vite/deps/@ai-sdk_gateway.js`);
      try {
        await generateText({
          model: {
            specificationVersion: "v4", provider: "test", modelId: "test", supportedUrls: {},
            doGenerate: async () => { throw new GatewayAuthenticationError(); },
          },
          prompt: "test", maxRetries: 0,
        });
        return { name: "", message: "No error was raised" };
      } catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
    }, developmentURL);
    expect(gatewayError.name).toBe("GatewayAuthenticationError");
    expect(gatewayError.message).toContain("Unauthenticated request to AI Gateway");
  } finally { await dispose(opened.context, opened.userDataDirectory, actual.server); }
});
