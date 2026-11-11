import { test } from "./fixtures";
import { evaluationOptionsFromEnvironment } from "./evaluation/options";
import { runEvaluation } from "./evaluation/run-evaluation";

test.use({ trace: "off", screenshot: "off", video: "off" });

// An explicit opt-in is required: this test may incur provider charges.
test("@real-model browser task", async () => {
  test.skip(process.env.SURFWAX_REAL_MODEL_EVAL !== "1", "Explicit real-model opt-in required");
  const options = evaluationOptionsFromEnvironment(process.env);
  // Keep setup, evidence collection and teardown outside the task's time budget.
  test.setTimeout(options.taskTimeoutMs + 60_000);
  await runEvaluation(options);
});
