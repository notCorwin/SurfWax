import { expect, test } from "@playwright/test";
import { procurementFixture, procurementScore } from "./procurement-fixture";

for (const seed of [17, 73]) test(`validates a seeded invoice review in browser (seed ${seed})`, async ({ page }) => {
  const fixture = await procurementFixture(seed);
  try {
    await page.goto(fixture.origin);
    const frame = page.frameLocator('iframe[title="Invoice queue"]');
    await expect(frame.locator('#page')).toHaveText('Page 1 of 8');
    await frame.locator('tbody tr').first().evaluate((row) => { (window as any).__firstInvoiceRow = row; });
    for (let currentPage = 0; currentPage < 8; currentPage++) {
      for (let rowIndex = 0; rowIndex < 2; rowIndex++) {
        const row = frame.locator('tbody tr').nth(rowIndex);
        const cells = await row.locator('td').allTextContents();
        if (cells[1] !== 'APAC' || cells[2] !== 'pending') continue;
        await row.getByRole('button', { name: `Review ${cells[0]}` }).click();
        await expect(frame.locator('#detail-id')).toHaveText(`Invoice: ${cells[0]}`);
        const amount = Number((await frame.locator('#amount').innerText()).replace('Amount: $', ''));
        const hold = await frame.locator('#hold').innerText();
        if (amount <= 500 && hold === 'Hold: No') {
          await frame.getByLabel('Decision').selectOption({ label: 'Approve' });
          await frame.getByLabel('Reason').selectOption({ label: 'Within policy' });
          await frame.getByLabel('Memo').fill('Approved under APAC policy');
          await frame.getByRole('button', { name: 'Submit review' }).click();
          await expect(frame.locator('#notice')).toHaveText(`Review submitted for ${cells[0]}`);
        } else await frame.getByRole('button', { name: 'Close details' }).click();
      }
      if (currentPage < 7) {
        await frame.getByRole('button', { name: 'Next page' }).click();
        expect(await frame.locator('tbody tr').first().evaluate((row) => row === (window as any).__firstInvoiceRow)).toBe(true);
      }
    }
    expect(procurementScore(fixture.evidence())).toBe(true);
    const firstAttempt = fixture.evidence().attempts[0]!;
    const duplicate = await page.request.post(`${fixture.origin}/review`, { data: {
      id: firstAttempt.id, revision: firstAttempt.revision, decision: firstAttempt.decision,
      reason: firstAttempt.reason, memo: firstAttempt.memo,
    } });
    expect(duplicate.status()).toBe(409);
    expect(procurementScore(fixture.evidence())).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('rejects incorrect reviews and records attempts independently of the page', async ({ page }) => {
  const fixture = await procurementFixture(17);
  try {
    const invoice = fixture.evidence().invoices.find((item) => item.hold)!;
    const result = await page.request.post(`${fixture.origin}/review`, { data: { id: invoice.id, revision: invoice.revision, decision: 'Approve', reason: 'Within policy', memo: 'Approved under APAC policy' } });
    expect(result.status()).toBe(409);
    expect(fixture.evidence().attempts).toHaveLength(1);
    expect(procurementScore(fixture.evidence())).toBe(false);
    expect((await page.request.get(`${fixture.origin}/reset`)).status()).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
  }
});
