import { describe, it, expect } from 'vitest';
import { verifyCart, sameCart, sanitizeCart, type Cart } from '../e2e/stateful-web/oracle';
describe('cart oracle', () => {
  const items = [{ variantId: 'a', quantity: 1, price: 100 }, { variantId: 'b', quantity: 2, price: 200 }];
  const cart: Cart = { currency: 'GBP', subtotal: 500, items };
  it('rejects lost protected items, incorrect quantities, duplicates, extra items and overspending', () => {
    expect(verifyCart(cart, items, 'GBP', 500)).toBe(true);
    for (const changed of [{ ...cart, items: items.slice(1) }, { ...cart, items: [items[0]!, { ...items[1]!, quantity: 1 }] }, { ...cart, items: [items[0]!, items[0]!] }, { ...cart, items: [...items, items[0]!] }]) expect(verifyCart(changed, items, 'GBP', 500)).toBe(false);
    expect(verifyCart(cart, items, 'GBP', 499)).toBe(false);
  });
  it('accepts real discounts while rejecting invalid money, quantities and malformed API data', () => {
    const discounted = { ...cart, subtotal: 460, items: [items[0]!, { ...items[1]!, originalPrice: 200, price: 180, lineTotal: 360 }] };
    expect(verifyCart(discounted, items, 'GBP', 500)).toBe(true);
    for (const invalid of [{ ...cart, subtotal: -1 }, { ...cart, items: [{ ...items[0]!, quantity: 0 }, items[1]!] }, { ...cart, items: [{ ...items[0]!, price: NaN }, items[1]!] }]) expect(verifyCart(invalid, items, 'GBP', 500)).toBe(false);
    expect(verifyCart({ currency: 'GBP', subtotal: 0, items: [{ variantId: 'a', quantity: 1, price: 100, originalPrice: 100, lineTotal: 0 }] }, [items[0]!], 'GBP', 100)).toBe(false);
    expect(() => sanitizeCart({ currency: 'GBP', items_subtotal_price: 0 })).toThrow('Invalid shopping cart');
  });
  it('rejects changed recovery data', () => { expect(sameCart(cart, structuredClone(cart))).toBe(true); expect(sameCart(cart, { ...cart, subtotal: 499 })).toBe(false); });
});

import { backgroundCleanupSucceeded } from '../e2e/stateful-web/cleanup';
it('requires a durable successful cleanup for this run and rejects background errors without a conversation id', () => {
  const success = { id: 1, type: 'run.cleanup.finished', runId: 'run', content: { failures: 0 }, output: { ok: true } };
  expect(backgroundCleanupSucceeded([success] as any, 'run')).toBe(true);
  expect(backgroundCleanupSucceeded([success] as any, 'other')).toBe(false);
  expect(backgroundCleanupSucceeded([] as any, 'run')).toBe(false);
  expect(backgroundCleanupSucceeded([success, { ...success, id: 2, type: 'run.cleanup.failed', content: { effectUnknown: true } }] as any, 'run')).toBe(false);
});
