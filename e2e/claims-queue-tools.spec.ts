import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { claimsFixture, claimsScore } from "./evaluation/claims-fixture";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// A local scripted provider exercises actual extension tools, not model understanding.
for (const { seed, duplicate } of [{ seed: 17, duplicate: false }, { seed: 72, duplicate: false }, { seed: 17, duplicate: true }]) {
  test(`extension reviews the paginated claims queue (seed ${seed}, stale retry ${duplicate})`, async () => {
    test.setTimeout(240_000);
    const fixture = await claimsFixture(seed), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    const frame = { by: "css", value: 'iframe[title="Claims queue"]' };
    let problem: unknown, page = 1, retried = false, pending: string[] = [], operations = 0;
    const done = () => textResponse("CLAIMS_TOOL_PATH_DONE");
    const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
      const step: MockResponse = (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        if (!message) { responses.unshift(step); return textResponse("Claims"); }
        try { const content = message.content; return handler(JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content)); }
        catch (error) { problem = error; return done(); }
      };
      return step;
    };
    try {
      const target = await opened.context.newPage(); await target.goto(fixture.origin);
      const nextPage = () => {
        if (page === 3) return done();
        responses.unshift(after((result) => {
          expect(result.ok).toBe(true); page++;
          responses.unshift(after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); return readPage(); }));
          return commandResponse("verify_state", { target: { by: "css", value: "#page", frame }, textIncludes: `Page ${page} of 3`, timeoutMs: 10_000 }, `claims-page-ready-${page}`);
        }));
        return commandResponse("click", { target: { by: "role", value: "button", name: "Next page", frame } }, `claims-page-next-${page}`);
      };
      const approveNext = (): ReturnType<typeof commandResponse> => {
        const id = pending.shift();
        if (!id) return nextPage();
        const button = { by: "role", value: "button", name: `Approve ${id}`, exact: true, frame };
        responses.unshift(after((result) => {
          expect(result.ok).toBe(true); operations++;
          responses.unshift(after((result) => {
            expect(result).toMatchObject({ ok: true, result: { verified: true } });
            if (!duplicate || retried) return approveNext();
            retried = true;
            // The fixture restores an obsolete button to simulate a stale UI retry; the model still uses a normal click.
            void target.frameLocator('iframe[title="Claims queue"]').locator(`button[data-id="${id}"]`).evaluate((element: HTMLElement) => { element.hidden = false; element.dataset.revision = "1"; }).catch((error) => { problem = error; });
            responses.unshift(after((visible) => {
              expect(visible).toMatchObject({ ok: true, result: { verified: true } });
              responses.unshift(after((clicked) => {
                expect(clicked.ok).toBe(true); operations++;
                responses.unshift(after((failure) => { expect(failure).toMatchObject({ ok: true, result: { verified: true } }); return approveNext(); }));
                return commandResponse("verify_state", { target: { by: "css", value: "#notice", frame }, textIncludes: `Approval failed for ${id}`, timeoutMs: 10_000 }, "claims-stale-failed");
              }));
              return commandResponse("click", { target: button }, "claims-stale-retry");
            }));
            return commandResponse("verify_state", { target: button, state: "visible", timeoutMs: 10_000 }, "claims-stale-visible");
          }));
          return commandResponse("verify_state", { target: { by: "css", value: "#notice", frame }, textIncludes: `Approved ${id}`, timeoutMs: 10_000 }, `claims-approved-${id}`);
        }));
        return commandResponse("click", { target: button }, `claims-approve-${id}`);
      };
      const readPage = () => {
        responses.unshift(after((result) => {
          expect(result).toMatchObject({ ok: true, result: { items: expect.any(Array) } });
          const rows = result.result.items.map((item: any) => item.text.trim().split(/\s+/));
          expect(rows).toHaveLength(3);
          pending = rows.filter((row: string[]) => row[1] === "APAC" && Number(row[2].slice(1)) <= 500 && row[3] === "pending").map((row: string[]) => row[0]);
          return approveNext();
        }));
        return commandResponse("read_elements", { target: { by: "css", value: "tbody tr", frame } }, `claims-read-${page}`);
      };
      responses.push(
        commandResponse("verify_state", { target: { by: "css", value: "#page", frame }, textIncludes: "Page 1 of 3", timeoutMs: 10_000 }, "claims-ready"),
        after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); return readPage(); }),
        textResponse("Claims"),
      );
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill(fixture.prompt);
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("CLAIMS_TOOL_PATH_DONE", { timeout: 220_000 });
      if (problem) throw problem;
      const evidence = fixture.evidence(), events = await readEvents(opened.page);
      expect(toolLifecycleEvidence(events).complete).toBe(true);
      expect(Object.entries(completedProgramOperations(events)).filter(([name]) => name.endsWith(".click")).reduce((total, [, count]) => total + count, 0)).toBeGreaterThanOrEqual(5);
      expect(operations).toBe(duplicate ? 4 : 3);
      expect(evidence.attempts.filter((attempt) => attempt.accepted)).toHaveLength(3);
      expect(new Set(evidence.attempts.filter((attempt) => attempt.accepted).map((attempt) => attempt.id)).size).toBe(3);
      expect(evidence.attempts).toHaveLength(duplicate ? 4 : 3);
      if (duplicate) {
        expect(evidence.attempts[1]).toMatchObject({ id: evidence.attempts[0]!.id, revision: 1, accepted: false });
        expect(claimsScore(evidence)).toBe(false);
      } else {
        expect(evidence.attempts.every((attempt) => attempt.accepted)).toBe(true);
        expect(claimsScore(evidence)).toBe(true);
      }
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
  });
}
