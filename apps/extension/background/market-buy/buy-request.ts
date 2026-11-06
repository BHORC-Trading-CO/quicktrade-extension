// apps/extension/background/market-buy/buy-request.ts
//
// QUICK-226: the only place a buy request leaves the browser. It must be an instance of one of the buy operations
// (internal operations of PLATFORM_OPERATIONS: never matched for the page, a login probe or the scheduler) on an origin
// the user granted. The body goes out exactly as the executor built it. No retry, no redirect: a redirected buy is an
// answer QTS cannot read (the fetch fails, the outcome is unknown).
import type { MarketBuyAnswer, OperationRequest } from '@qts/contracts';
import { operationRefusedError } from '@qts/contracts';

import { resolveOperation } from '../operation-policy';

/** The buy operations; `internal` alone is not enough (white.market's token refresh is internal too). */
export const MARKET_BUY_OPERATION_IDS: ReadonlySet<string> = new Set([
  'csfloat.listings.buy',
  'csmoney.market.purchase',
  'csmoney.trade.send-offer',
  'csmoney.trade.confirm-virtual',
  'csmoney.trade.virtual.decline',
]);

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Sends one buy request: 403 with `operation_refused:<reason>` / `permission_denied` when nothing was sent, status 0
 * with `network` when the fetch failed (it may have reached the marketplace), else the answer (JSON when it parses,
 * the text otherwise) with its headers.
 */
export async function sendBuyRequest(platform: string, request: OperationRequest): Promise<MarketBuyAnswer> {
  const match = await resolveOperation(platform, request, 'internal');
  if (!match.ok) return { ok: false, status: 403, data: null, error: operationRefusedError(match.refusal) };
  if (!MARKET_BUY_OPERATION_IDS.has(match.operation.id)) return { ok: false, status: 403, data: null, error: operationRefusedError({ reason: 'purpose' }) };
  const origin = `${new URL(request.url).origin}/*`;
  let permitted = false;
  try {
    permitted = await browser.permissions.contains({ origins: [origin] });
  } catch {
    permitted = false;
  }
  if (!permitted) return { ok: false, status: 403, data: null, error: `permission_denied: ${origin}` };
  let res: Response;
  try {
    res = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
      credentials: 'include',
      redirect: 'error',
    });
  } catch {
    return { ok: false, status: 0, data: null, error: 'network' };
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: res.ok, status: res.status, data: null, headers, error: 'body_unreadable' };
  }
  return { ok: res.ok, status: res.status, data: parseBody(text), headers };
}
