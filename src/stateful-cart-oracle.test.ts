import { describe, it, expect } from 'vitest';
import { verifyCart, sameCart, type Cart } from '../e2e/stateful-web/oracle';
describe('cart oracle', () => {
  const items = [{ variantId: 'a', quantity: 1, price: 100 }, { variantId: 'b', quantity: 2, price: 200 }];
  const cart: Cart = { currency: 'GBP', subtotal: 500, items };
  it('rejects lost protected items, incorrect quantities, duplicates, extra items and overspending', () => {
    expect(verifyCart(cart, items, 'GBP', 500)).toBe(true);
    for (const changed of [{ ...cart, items: items.slice(1) }, { ...cart, items: [items[0]!, { ...items[1]!, quantity: 1 }] }, { ...cart, items: [items[0]!, items[0]!] }, { ...cart, items: [...items, items[0]!] }]) expect(verifyCart(changed, items, 'GBP', 500)).toBe(false);
    expect(verifyCart(cart, items, 'GBP', 499)).toBe(false);
  });
  it('rejects changed recovery data', () => { expect(sameCart(cart, structuredClone(cart))).toBe(true); expect(sameCart(cart, { ...cart, subtotal: 499 })).toBe(false); });
});
