import type { APIRequestContext } from '@playwright/test';
import type { Cart, Item } from './oracle';

/** Classify observed transport failures, never an assistant's claim of a blocker. */
export function providerFailure(requests: { responseStatus: number | null }[]) {
  const errors: number[] = [];
  for (const request of [...requests].reverse()) {
    const status = request.responseStatus;
    if (status === null) continue;
    if (![401, 403, 408, 429].includes(status) && status < 500) break;
    errors.push(status);
  }
  return { unavailable: errors.length >= 2 || errors.some(status => status === 401 || status === 403), statuses: errors };
}

/** Re-read only missing/underfilled variants; a failed probe is not stock evidence. */
export async function missingStock(request: APIRequestContext, wanted: Item[], actual: Cart, products: { variantId: string; url: string }[]) {
  const missing = wanted.filter(item => (actual.items.find(row => row.variantId === item.variantId)?.quantity ?? 0) < item.quantity);
  return Promise.all(missing.map(async item => {
    const product = products.find(product => product.variantId === item.variantId)!;
    let status: number | null = null, available: boolean | null = null;
    try {
      const response = await request.get(`${product.url}.js`, { timeout: 10000 });
      status = response.status();
      if (response.ok()) {
        const data = await response.json();
        const variant = data.variants?.find((variant: any) => String(variant.id) === item.variantId);
        if (typeof variant?.available === 'boolean') available = variant.available;
      }
    } catch { /* An unavailable probe cannot establish that the item sold out. */ }
    return { variantId: item.variantId, status, available };
  }));
}
