import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { publicTasks } from "./tasks.ts";
import { sourceReader } from "./sources.ts";

const [command, id] = process.argv.slice(2);
try {
  if (command === "list") {
    console.log(JSON.stringify(publicTasks.map(({ id, title, difficulty, startUrl, prompt }) => ({ id, title, difficulty, startUrl, prompt })), null, 2));
  } else if (command === "preflight") {
    const tasks = id ? publicTasks.filter(task => task.id === id) : publicTasks;
    if (!tasks.length) throw new Error("Unknown public website task");
    const read = sourceReader();
    const results = await Promise.all(tasks.map(async task => {
      const directory = resolve(process.env.SURFWAX_PUBLIC_WEB_REPORT_DIR ?? ".dev/verification/public-web", `preflight-${Date.now()}-${task.id}-${randomUUID()}`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const prepared = await task.prepare(read);
        await writeFile(resolve(directory, "sources.json"), JSON.stringify(prepared.sources, null, 2), { flag: "wx", mode: 0o600 });
        const result = { task: task.id, outcome: "ready", requiredUrls: prepared.requiredUrls, sources: prepared.sources.map(({ body: _body, ...metadata }) => metadata) };
        await writeFile(resolve(directory, "report.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
        return { ...result, report: resolve(directory, "report.json") };
      } catch (error) {
        const result = { task: task.id, outcome: "blocked", reason: error instanceof Error ? error.message : "Source preflight failed" };
        await writeFile(resolve(directory, "report.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
        return { ...result, report: resolve(directory, "report.json") };
      }
    }));
    console.log(JSON.stringify(results, null, 2));
    if (results.some(result => result.outcome !== "ready")) process.exitCode = 1;
  } else throw new Error("Usage: npm run eval:public-web -- list | preflight [task-id] | run <task-id>");
} catch (error) { console.error(error instanceof Error ? error.message : "Public website operation failed"); process.exitCode = 1; }
