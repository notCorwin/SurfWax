import { expect } from "@playwright/test";
import { test, commandResponse, textResponse, startProvider, openExtension, dispose, configure, closeServer, readEvents, type MockResponse } from "./fixtures";
import { procurementFixture, procurementScore } from "./evaluation/procurement-fixture";
import { completedProgramOperations, toolLifecycleEvidence } from "./evaluation/tool-lifecycle";

// The provider is a deterministic controller; the page and business ledger stay independent.
for (const seed of [17, 73]) {
  test(`scripted procurement review across paginated cross-origin invoices (seed ${seed})`, async () => {
    test.setTimeout(420_000);
    const fixture = await procurementFixture(seed), responses: MockResponse[] = [];
    const provider = await startProvider(responses), opened = await openExtension();
    const frame = { by: "css", value: 'iframe[title="Invoice queue"]' };
    let problem: unknown, page = 1, pageCount = 0, pending: string[] = [];
    const reviewed: string[] = [];
    const done = () => textResponse("PROCUREMENT_TOOL_PATH_DONE");
    const after = (handler: (result: any) => ReturnType<typeof commandResponse>): MockResponse => {
      const step: MockResponse = (request) => {
        const message = request.messages.findLast((entry: any) => entry.role === "tool");
        if (!message) { responses.unshift(step); return textResponse("Procurement"); }
        try { const content = message.content; return handler(JSON.parse(Array.isArray(content) ? content.find((part: any) => part.type === "text").text : content)); }
        catch (error) { problem = error; return done(); }
      };
      return step;
    };
    const click = (name: string, id: string) => commandResponse("click", { target: { by: "role", value: "button", name, exact: true, frame } }, id);
    const nextPage = (): ReturnType<typeof commandResponse> => {
      if (page === pageCount) return done();
      responses.unshift(after((result) => {
        expect(result.ok).toBe(true); page++;
        responses.unshift(after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); return readPage(); }));
        return commandResponse("verify_state", { target: { by: "css", value: "#page", frame }, textIncludes: `Page ${page} of ${pageCount}`, timeoutMs: 10_000 }, `procurement-page-ready-${page}`);
      }));
      return click("Next page", `procurement-next-${page}`);
    };
    const reviewNext = (): ReturnType<typeof commandResponse> => {
      const id = pending.shift();
      if (!id) return nextPage();
      responses.unshift(after((result) => {
        expect(result.ok).toBe(true);
        responses.unshift(after((result) => {
          expect(result).toMatchObject({ ok: true, result: { verified: true } });
          responses.unshift(after((result) => {
            expect(result).toMatchObject({ ok: true, result: { items: expect.any(Array) } });
            const details = result.result.items.map((item: any) => item.text.trim());
            expect(details[0]).toBe(`Invoice: ${id}`);
            const amount = Number(details[1].replace("Amount: $", "")), hold = details[2];
            if (amount > 500 || hold !== "Hold: No") {
              responses.unshift(after((result) => { expect(result.ok).toBe(true); return reviewNext(); }));
              return click("Close details", `procurement-close-${id}`);
            }
            responses.unshift(after((result) => {
              expect(result.ok).toBe(true);
              responses.unshift(after((result) => {
                expect(result.ok).toBe(true);
                responses.unshift(after((result) => {
                  expect(result.ok).toBe(true);
                  responses.unshift(after((result) => {
                    expect(result.ok).toBe(true);
                    responses.unshift(after((result) => { expect(result).toMatchObject({ ok: true, result: { verified: true } }); reviewed.push(id); return reviewNext(); }));
                    return commandResponse("verify_state", { target: { by: "css", value: "#notice", frame }, textIncludes: `Review submitted for ${id}`, timeoutMs: 10_000 }, `procurement-submitted-${id}`);
                  }));
                  return click("Submit review", `procurement-submit-${id}`);
                }));
                return commandResponse("fill", { target: { by: "label", value: "Memo", frame }, value: "Approved under APAC policy" }, `procurement-memo-${id}`);
              }));
              return commandResponse("select_option", { target: { by: "label", value: "Reason", frame }, value: "Within policy" }, `procurement-reason-${id}`);
            }));
            return commandResponse("select_option", { target: { by: "label", value: "Decision", frame }, value: "Approve" }, `procurement-decision-${id}`);
          }));
          return commandResponse("read_elements", { target: { by: "css", value: "#detail p", frame } }, `procurement-detail-${id}`);
        }));
        return commandResponse("verify_state", { target: { by: "css", value: "#detail-id", frame }, textEquals: `Invoice: ${id}`, timeoutMs: 10_000 }, `procurement-opened-${id}`);
      }));
      return click(`Review ${id}`, `procurement-review-${id}`);
    };
    const readPage = () => {
      responses.unshift(after((result) => {
        expect(result).toMatchObject({ ok: true, result: { items: expect.any(Array) } });
        const rows = result.result.items.map((item: any) => item.text.trim().split(/\s+/));
        expect(rows).toHaveLength(2);
        pending = rows.filter((row: string[]) => row[1] === "APAC" && row[2] === "pending").map((row: string[]) => row[0]);
        return reviewNext();
      }));
      return commandResponse("read_elements", { target: { by: "css", value: "tbody tr", frame } }, `procurement-read-${page}`);
    };
    try {
      const target = await opened.context.newPage(); await target.goto(fixture.origin);
      responses.push(
        commandResponse("verify_state", { target: { by: "css", value: "#page", frame }, textIncludes: "Page 1 of ", timeoutMs: 10_000 }, "procurement-ready"),
        after((result) => {
          expect(result).toMatchObject({ ok: true, result: { verified: true, actual: expect.any(String) } });
          pageCount = Number(result.result.actual.match(/Page 1 of (\d+)/)?.[1]);
          expect(pageCount).toBeGreaterThan(1);
          return readPage();
        }),
        textResponse("Procurement"),
      );
      await (await configure(opened.context, opened.page, provider.baseURL)).close();
      await target.bringToFront();
      await opened.page.getByTestId("composer-input").fill(fixture.prompt);
      await opened.page.getByTestId("composer-input").press("Enter");
      await expect(opened.page.locator(".markdown-body").last()).toContainText("PROCUREMENT_TOOL_PATH_DONE", { timeout: 400_000 });
      if (problem) throw problem;
      const evidence = fixture.evidence();
      expect([...reviewed].sort()).toEqual([...evidence.expectedIds].sort());
      expect(evidence.attempts).toHaveLength(evidence.expectedIds.length);
      expect(evidence.expectedIds.length).toBeGreaterThanOrEqual(6);
      expect(procurementScore(evidence), JSON.stringify(evidence)).toBe(true);
      const events = await readEvents(opened.page);
      expect(toolLifecycleEvidence(events).complete).toBe(true);
      const operations = completedProgramOperations(events);
      expect(Object.entries(operations).filter(([name]) => name.endsWith(".click")).reduce((total, [, count]) => total + count, 0)).toBeGreaterThanOrEqual(20);
    } finally { await dispose(opened.context, opened.userDataDirectory, provider.server); await closeServer(fixture.server); }
  });
}
