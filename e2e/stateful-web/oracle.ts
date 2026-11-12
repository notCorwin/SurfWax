export type Item = { variantId: string; quantity: number; price: number };
export type Cart = { currency: string; subtotal: number; items: Item[] };
export function sanitizeCart(cart: any): Cart {
  return { currency: cart.currency, subtotal: cart.items_subtotal_price, items: cart.items.map((i: any) => ({ variantId: String(i.variant_id), quantity: i.quantity, price: i.final_price })).sort((a: Item, b: Item) => a.variantId.localeCompare(b.variantId)) };
}
export function verifyCart(cart: Cart, expected: Item[], currency: string, budget: number): boolean {
  const validItem = (i: Item) => typeof i.variantId === 'string' && i.variantId.length > 0 && Number.isSafeInteger(i.quantity) && i.quantity >= 0 && Number.isSafeInteger(i.price) && i.price >= 0;
  return typeof currency === 'string' && currency.length > 0 && Number.isSafeInteger(budget) && budget >= 0 && cart.items.every(validItem) && expected.every(validItem) && new Set(expected.map(i => i.variantId)).size === expected.length && cart.currency === currency && Number.isSafeInteger(cart.subtotal) && cart.subtotal >= 0 && cart.subtotal <= budget && cart.items.length === expected.length && new Set(cart.items.map(i => i.variantId)).size === cart.items.length && expected.every(e => cart.items.some(i => i.variantId === e.variantId && i.quantity === e.quantity && i.price === e.price)) && cart.subtotal === expected.reduce((sum, i) => sum + i.price * i.quantity, 0);
}
export function sameCart(a: Cart, b: Cart): boolean { return JSON.stringify(a) === JSON.stringify(b); }
