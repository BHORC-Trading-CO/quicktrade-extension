export const platforms = ['cs.money', 'csfloat.com', 'buff.163.com', 'steamcommunity.com', 'tradeit.gg', 'aim.market'] as const;
export const sell_items = [{ id: 34873047834, price: 10 }] as const;

/** Periodic alarm that triggers the deferred-reprice catch-up pass while the browser is open. */
export const REPRICE_TICK_ALARM = 'qts:reprice-tick';

/** One-shot alarm that continues a chunked catch-up pass when more rules remain due. */
export const REPRICE_CONTINUE_ALARM = 'qts:reprice-continue';

/** Max successful reprice edits applied per processDueRules pass (keeps each SW invocation short). */
export const MAX_FIRES_PER_PASS = 50;
