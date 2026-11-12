import { test, expect } from "./fixtures";
import { publicTasks } from "./public-web/tasks";
import { runPublicTask } from "./public-web/run";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("@public-web real website task", async () => {
  test.skip(process.env.SURFWAX_PUBLIC_WEB_EVAL !== "1", "Explicit public website evaluation opt-in required");
  const task = publicTasks.find(task => task.id === process.env.SURFWAX_PUBLIC_WEB_TASK);
  if (!task) throw new Error("Choose a task with npm run eval:public-web -- list");
  const timeout = Number(process.env.SURFWAX_EVAL_TIMEOUT_MS ?? 900_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 7_200_000) throw new Error("Invalid evaluation timeout (1000–7200000 ms)");
  test.setTimeout(timeout + 180_000);
  expect(await runPublicTask(task, timeout)).toBe("passed");
});
