import { expect, type CDPSession } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, type MockResponse } from "./fixtures";
import { frameReplacementFixture } from "./evaluation/frame-replacement-fixture";
import { sequenceFixture } from "./evaluation/sequence-fixture";

type Item = { id: string; line: string; ref?: string };

function lastTool(request: any): any {
  const content = request.messages.findLast((entry: any) => entry.role === "tool").content;
  return JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content);
}

/** Independent Chrome DOM mapping: frame URL -> its owner heading. */
async function frameOwners(cdp: CDPSession): Promise<Record<string, string>> {
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'iframe[title="Work item"]' });
  const result: Record<string, string> = {};
  for (const nodeId of nodeIds) {
    const { node } = await cdp.send("DOM.describeNode", { nodeId });
    if (!node.frameId) throw new Error("No child frame ID on iframe owner");
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
    if (!object.objectId) throw new Error("No frame owner object");
    const value = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: "function() { return { url: this.src, label: this.parentElement.querySelector('h2').textContent }; }",
    });
    if (value.exceptionDetails || typeof value.result.value?.url !== "string" || typeof value.result.value?.label !== "string") throw new Error("Cannot read frame owner heading");
    result[value.result.value.url] = value.result.value.label;
  }
  return result;
}

/** Read owner headings and corresponding child subtree button refs from the model-visible snapshot. */
function snapshotFrames(snapshot: any): Record<string, { label: string; buttonRef?: string }> {
  const items: Item[] = snapshot.items ?? [];
  const owners = new Map<string, string>();
  let label = "";
  for (const item of items) {
    const heading = /- heading "(Next|Waiting)"/.exec(item.line);
    if (heading) label = heading[1]!;
    if (!/- Iframe "Work item"/.test(item.line)) continue;
    const id = /\[frameRef=([^\]]+)\]/.exec(item.line)?.[1];
    if (id) owners.set(id, label);
  }
  const result: Record<string, { label: string; buttonRef?: string }> = {};
  for (let index = 0; index < items.length; index++) {
    const id = /^\s*- frame-document \[frameRef=([^\]]+)\]/.exec(items[index]!.line)?.[1];
    if (!id) continue;
    const next = items.slice(index + 1).findIndex((item) => /^\s*- frame-document \[frameRef=/.test(item.line));
    const subtree = items.slice(index + 1, next < 0 ? undefined : index + 1 + next);
    result[id] = { label: owners.get(id) ?? "", buttonRef: subtree.find((item) => /- button "Confirm"/.test(item.line))?.ref };
  }
  return result;
}

test("ties same-name iframe owners to their child snapshots across frame replacement", async () => {
  test.setTimeout(60_000);
  const fixture = await frameReplacementFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let first: any, repeated: any, second: any, click: any, verified: any, firstListed: any, secondListed: any, counted: any, stale: any, selectedFrameRef = "";
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    await expect(target.locator("#progress")).toHaveText("Completed 0 of 12");
    const cdp = await target.context().newCDPSession(target);
    const before = await frameOwners(cdp);
    expect(Object.values(before).sort()).toEqual(["Next", "Waiting"]);
    const targetInSelectedFrame = () => ({ by: "role", value: "button", name: "Confirm", frame: { ref: selectedFrameRef } });
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "frames-before"),
      (request) => {
        first = lastTool(request);
        selectedFrameRef = Object.entries(snapshotFrames(first)).find(([, frame]) => frame.label === "Next")?.[0] ?? "";
        return selectedFrameRef ? commandResponse("list_frames", {}, "frames-list-before") : textResponse("FRAME_OWNER_DONE");
      },
      (request) => { firstListed = lastTool(request); return commandResponse("count_elements", { target: targetInSelectedFrame() }, "frames-count"); },
      (request) => { counted = lastTool(request); return commandResponse("inspect_page", { budget: 12000 }, "frames-repeat"); },
      (request) => { repeated = lastTool(request); return commandResponse("click", { target: targetInSelectedFrame(), timeoutMs: 20000 }, "frames-click"); },
      (request) => { click = lastTool(request); return commandResponse("verify_state", { target: { by: "css", value: "#progress" }, textIncludes: "Completed 1 of 12", timeoutMs: 20000 }, "frames-ready"); },
      (request) => { verified = lastTool(request); return commandResponse("inspect_page", { budget: 12000 }, "frames-after"); },
      (request) => { second = lastTool(request); return commandResponse("list_frames", {}, "frames-list-after"); },
      (request) => { secondListed = lastTool(request); return commandResponse("count_elements", { target: targetInSelectedFrame(), timeoutMs: 3000 }, "frames-stale"); },
      (request) => { stale = lastTool(request); return textResponse("FRAME_OWNER_DONE"); },
      textResponse("Inspect frame ownership"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Confirm the next work item and inspect the updated frames");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("FRAME_OWNER_DONE", { timeout: 45_000 });

    expect(first).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    expect(repeated).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    const ids = (snapshot: any) => (snapshot.items as Item[]).map((item) => item.id);
    expect(new Set(ids(first)).size).toBe(first.items.length);
    expect(ids(repeated)).toEqual(ids(first));
    expect(ids(first).every((id) => /^f[0-9a-z]+:(?:a|d):.+$|^f[0-9a-z]+:doc$/.test(id))).toBe(true);
    const root = first.items.find((item: Item) => /- heading "Work queue"/.test(item.line));
    expect(root?.id).toEqual(expect.any(String));
    const rootScope = root.id.split(":")[0];
    const childScopes = first.items.filter((item: Item) => /^\s*- frame-document \[frameRef=/.test(item.line)).map((item: Item) => item.id.split(":")[0]);
    expect(childScopes).toHaveLength(2);
    expect(new Set([rootScope, ...childScopes]).size).toBe(3);
    const firstFrames = snapshotFrames(first);
    expect(Object.keys(firstFrames)).toHaveLength(2);
    for (const [ref, frame] of Object.entries(firstFrames)) {
      const metadata = firstListed.frames.find((item: any) => item.frameRef === ref);
      expect(metadata).toEqual(expect.any(Object));
      expect(frame).toMatchObject({ label: before[metadata.url], buttonRef: expect.any(String) });
    }
    expect(counted).toMatchObject({ ok: true, result: 1 });
    expect(click).toMatchObject({ ok: true });
    expect(verified).toMatchObject({ ok: true, result: { verified: true } });
    expect(fixture.evidence().attempts).toHaveLength(1);
    expect(fixture.evidence().attempts[0]).toMatchObject({ round: 0, accepted: true, trusted: true });

    expect(second).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    expect(new Set(ids(second)).size).toBe(second.items.length);
    expect(second.items.find((item: Item) => /- heading "Work queue"/.test(item.line))?.id).toBe(root.id);
    const replacedScopes = second.items.filter((item: Item) => /^\s*- frame-document \[frameRef=/.test(item.line)).map((item: Item) => item.id.split(":")[0]);
    expect(replacedScopes).toHaveLength(2);
    expect(replacedScopes.every((scope: string) => scope !== rootScope && !childScopes.includes(scope))).toBe(true);
    const after = await frameOwners(cdp);
    expect(Object.values(after).sort()).toEqual(["Next", "Waiting"]);
    const secondFrames = snapshotFrames(second);
    expect(Object.keys(secondFrames)).toHaveLength(2);
    expect(Object.keys(after).every((url) => !(url in before))).toBe(true);
    for (const [ref, frame] of Object.entries(secondFrames)) {
      const metadata = secondListed.frames.find((item: any) => item.frameRef === ref);
      expect(metadata).toEqual(expect.any(Object));
      expect(frame).toMatchObject({ label: after[metadata.url], buttonRef: expect.any(String) });
    }
    expect(stale).toMatchObject({ ok: false, error: { code: "stale-frame" } });
    await cdp.detach();
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});

test("nests cross-origin frame documents at their owners ahead of same-name outer controls", async () => {
  test.setTimeout(90_000);
  const fixture = await sequenceFixture(17), responses: MockResponse[] = [];
  const provider = await startProvider(responses), opened = await openExtension();
  let full: any, scoped: any, workspaceRef = "";
  try {
    const target = await opened.context.newPage();
    await target.goto(fixture.origin);
    responses.push(
      commandResponse("inspect_page", { budget: 12000 }, "nested-full"),
      (request) => {
        full = lastTool(request);
        const owner = full.items?.find((item: Item) => item.line.includes('- Iframe "Dispatch workspace"'));
        workspaceRef = /\[frameRef=([^\]]+)\]/.exec(owner?.line ?? "")?.[1] ?? "";
        return workspaceRef ? commandResponse("inspect_page", { budget: 12000,
          region: { by: "role", value: "main", frame: { ref: workspaceRef } } }, "nested-region") : textResponse("NESTED_DONE");
      },
      (request) => { scoped = lastTool(request); return textResponse("NESTED_DONE"); },
      textResponse("Inspect nested frames"),
    );
    await (await configure(opened.context, opened.page, provider.baseURL)).close();
    await target.bringToFront();
    await opened.page.getByTestId("composer-input").fill("Inspect the dispatch workspace");
    await opened.page.getByTestId("composer-input").press("Enter");
    await expect(opened.page.locator(".markdown-body").last()).toContainText("NESTED_DONE", { timeout: 60_000 });

    expect(full).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    const rows: Item[] = full.items;
    const workspace = rows.findIndex((item) => item.line.includes('- Iframe "Dispatch workspace"'));
    const editor = rows.findIndex((item) => item.line.includes('- Iframe "Sequence editor"'));
    const editorRef = /\[frameRef=([^\]]+)\]/.exec(rows[editor]?.line ?? "")?.[1];
    const depth = (line: string) => /^ */.exec(line)![0].length;
    expect(workspace).toBeGreaterThanOrEqual(0);
    expect(editor).toBeGreaterThan(workspace);
    expect(editorRef).toEqual(expect.any(String));
    expect(rows[workspace + 1]?.line).toContain(`- frame-document [frameRef=${workspaceRef}]`);
    expect(depth(rows[workspace + 1]!.line)).toBe(depth(rows[workspace]!.line) + 2);
    expect(rows[editor + 1]?.line).toContain(`- frame-document [frameRef=${editorRef}]`);
    expect(depth(rows[editor + 1]!.line)).toBe(depth(rows[editor]!.line) + 2);
    const sends = rows.filter((item) => item.line.includes('- button "Send dispatch"'));
    expect(sends).toHaveLength(2);
    expect(rows.indexOf(sends[0]!)).toBeGreaterThan(editor);
    expect(depth(sends[0]!.line)).toBeGreaterThan(depth(rows[editor]!.line));
    expect(depth(sends[1]!.line)).toBe(depth(rows[workspace]!.line));
    expect(sends[0]!.ref).not.toBe(sends[1]!.ref);
    expect(scoped).toMatchObject({ mode: "full", truncation: { baselineComplete: true } });
    expect((scoped.items as Item[]).filter((item) => item.line.includes('- button "Send dispatch"')).map((item) => item.ref)).toEqual([sends[0]!.ref]);
  } finally {
    await dispose(opened.context, opened.userDataDirectory, provider.server);
    await closeServer(fixture.server);
  }
});
