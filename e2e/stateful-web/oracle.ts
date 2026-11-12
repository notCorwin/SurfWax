export type Item = { variantId: string; quantity: number; price: number; originalPrice?: number; lineTotal?: number };
export type Cart = { currency: string; subtotal: number; items: Item[] };
const money = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validItem = (item: Item) => !!item && typeof item.variantId === 'string' && item.variantId.length > 0
  && Number.isSafeInteger(item.quantity) && item.quantity > 0 && money(item.price)
  && (item.originalPrice === undefined || money(item.originalPrice)) && (item.lineTotal === undefined || money(item.lineTotal));
const lineTotal = (item: Item) => item.lineTotal ?? item.price * item.quantity;
export function sanitizeCart(cart: any): Cart {
  if (!cart || typeof cart.currency !== 'string' || !cart.currency || !money(cart.items_subtotal_price) || !Array.isArray(cart.items)) throw new Error('Invalid shopping cart data');
  const items: Item[] = cart.items.map((item: any) => ({ variantId: String(item.variant_id ?? ''), quantity: item.quantity, price: item.final_price,
    originalPrice: item.original_price ?? item.price, lineTotal: item.final_line_price }));
  if (!items.every(validItem)) throw new Error('Invalid shopping cart item');
  return { currency: cart.currency, subtotal: cart.items_subtotal_price, items: items.sort((a, b) => a.variantId.localeCompare(b.variantId)) };
}
export function verifyCart(cart: Cart, expected: Item[], currency: string, budget: number): boolean {
  return !!cart && Array.isArray(cart.items) && Array.isArray(expected) && typeof currency === 'string' && currency.length > 0
    && money(budget) && cart.items.every(validItem) && expected.every(validItem)
    && new Set(expected.map(item => item.variantId)).size === expected.length && cart.currency === currency
    && money(cart.subtotal) && cart.subtotal <= budget && cart.items.length === expected.length
    && new Set(cart.items.map(item => item.variantId)).size === cart.items.length
    && expected.every(wanted => cart.items.some(item => item.variantId === wanted.variantId && item.quantity === wanted.quantity
      && (item.originalPrice ?? item.price) === wanted.price && item.price <= wanted.price && money(lineTotal(item)) && Math.abs(lineTotal(item) - item.price * item.quantity) < item.quantity && lineTotal(item) <= wanted.price * item.quantity))
    && cart.subtotal === cart.items.reduce((sum, item) => sum + lineTotal(item), 0);
}
export function sameCart(a: Cart, b: Cart): boolean { return JSON.stringify(a) === JSON.stringify(b); }
