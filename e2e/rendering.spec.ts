import { expect } from "@playwright/test";

import {
  configure,
  dispose,
  openExtension,
  startProvider,
  test,
  textResponse,
} from "./fixtures";

test(
  "follows the bottom through layout changes while respecting manual scrolling",
  { tag: "@user-journey" },
  async () => {
    const longReply =
      "SCROLL_LINE\n\n".repeat(400) +
      Array.from({ length: 500 }, (_, index) =>
        index % 40 === 0 ? `\nline ${index}\n` : ".",
      ).join("") +
      "FINAL_SCROLL_MARKER";
    const provider = await startProvider([
      textResponse(longReply),
      textResponse("滚动测试"),
    ]);
    const opened = await openExtension();
    try {
      await opened.page.setViewportSize({ width: 430, height: 850 });
      const options = await configure(
        opened.context,
        opened.page,
        provider.baseURL,
      );
      await options.close();
      const composer = opened.page.getByTestId("composer-input");
      await composer.fill("render a long response");
      await composer.press("Enter");

      const viewport = opened.page.getByTestId("thread-viewport");
      const remaining = () =>
        viewport.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        );
      await expect
        .poll(() =>
          viewport.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(1_200);
      await expect(
        opened.page.getByTestId("edit-message-button"),
      ).toBeVisible();
      await expect.poll(remaining).toBeLessThanOrEqual(1);
      const box = await viewport.boundingBox();
      if (!box) throw new Error("thread viewport has no bounding box");
      await opened.page.mouse.move(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      await opened.page.mouse.wheel(0, 500);
      await opened.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await opened.page.setViewportSize({ width: 430, height: 650 });
      await expect.poll(remaining).toBeLessThanOrEqual(1);
      await viewport.focus();
      await viewport.press("ArrowDown");
      await opened.page.setViewportSize({ width: 430, height: 550 });
      await expect.poll(remaining).toBeLessThanOrEqual(1);
      // Reflow and virtual-item measurements can move offsets independently of
      // user intent. Following must survive each new layout, not just one resize.
      for (const size of [
        { width: 600, height: 700 },
        { width: 380, height: 500 },
        { width: 430, height: 550 },
      ]) {
        await opened.page.setViewportSize(size);
        await expect.poll(remaining).toBeLessThanOrEqual(1);
      }
      const growLastTurn = async () => {
        const turn = viewport.locator(".conversation-turn");
        await expect(turn).toHaveCount(1);
        // Following the current bottom can finish before the virtualizer's next
        // measurement catches up with a width reflow. Establish the growth
        // baseline only after its single-turn spacer matches the actual layout.
        await expect
          .poll(() =>
            turn.evaluate((element) => {
              const spacer = element.parentElement;
              if (!spacer) throw new Error("virtual turn has no spacer");
              return Math.abs(
                spacer.getBoundingClientRect().height -
                  element.getBoundingClientRect().height,
              );
            }),
          )
          .toBeLessThanOrEqual(1);
        const height = await viewport.evaluate((element) => {
          const turn = element.querySelector(".conversation-turn");
          if (!turn) throw new Error("virtual turn is missing");
          const height = element.scrollHeight;
          const extra = document.createElement("div");
          extra.style.height = "400px";
          turn.append(extra);
          return height;
        });
        await expect
          .poll(() => viewport.evaluate((element) => element.scrollHeight))
          .toBeGreaterThan(height + 350);
      };
      await growLastTurn();
      await expect.poll(remaining).toBeLessThanOrEqual(1);
      await opened.page.mouse.wheel(0, -1_200);
      await expect.poll(remaining).toBeGreaterThan(500);
      const position = await viewport.evaluate((element) => element.scrollTop);
      await opened.page.setViewportSize({ width: 430, height: 650 });
      await expect
        .poll(() => viewport.evaluate((element) => element.scrollTop))
        .toBe(position);
      await growLastTurn();
      await expect.poll(remaining).toBeGreaterThan(500);
      await expect
        .poll(() => viewport.evaluate((element) => element.scrollTop))
        .toBe(position);

      const jump = opened.page.getByRole("button", { name: "滚动到底部" });
      await expect(jump).toBeVisible();
      await expect(jump).toBeEnabled();
      await jump.click();
      await expect.poll(remaining).toBeLessThanOrEqual(1);
      await expect(opened.page.locator(".markdown-body").last()).toContainText(
        "FINAL_SCROLL_MARKER",
      );
      await growLastTurn();
      await expect.poll(remaining).toBeLessThanOrEqual(1);
    } finally {
      await dispose(opened.context, opened.userDataDirectory, provider.server);
    }
  },
);
