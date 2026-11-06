import type { ExtensionCapability } from '@qts/contracts';

import { MARKET_BUY_BOTS_ENABLED, MARKET_BUY_CSMONEY_MARKET_ENABLED } from './market-buy-config';
import { OPERATION_TABLE_PUBLIC_KEY } from './operation-table-key';

/**
 * What this build answers beyond the original bridge (QUICK-202), announced with `installed`. Since 1.6.0 the
 * extension has no UI of its own: `open_connect` waits for a click on the toolbar icon (`toolbar_connect`). Since
 * 1.7.0 its operations carry the Market page's search keys (`market_search`, QUICK-224). Since 1.8.0 it runs the Market
 * live feed in the background (`market_feed`, QUICK-231: `market_feed_*` / `get_market_feed*`, the `market_feed_update`
 * push), buys through one executor (`market_buy`, QUICK-226; `market_buy_csmoney_market` / `market_buy_bots` only while buying
 * from cs.money's market / bots is switched on) and keeps the account's QTS buy orders the web pushes (`buy_orders`, QUICK-232: `set_buy_orders`).
 * Since 1.9.0 it keeps its scheduler's runs per account and hands them to that account's page (`diagnostics_journal`,
 * QUICK-214: `take_diagnostics`).
 * `signed_operation_table` only when a real public key is bundled: with the placeholder no signed table is accepted.
 */
export const EXTENSION_CAPABILITIES: readonly ExtensionCapability[] = [
  'platform_statuses',
  'connect_tab',
  'toolbar_connect',
  'market_search',
  'market_feed',
  'market_buy',
  ...(MARKET_BUY_CSMONEY_MARKET_ENABLED ? (['market_buy_csmoney_market'] as const) : []),
  ...(MARKET_BUY_BOTS_ENABLED ? (['market_buy_bots'] as const) : []),
  'buy_orders',
  // QUICK-233: the buy-order engine (`set_buy_orders_lease`, `get_buy_orders_engine`, `set_buy_orders_stopped`).
  'buy_orders_engine',
  // QUICK-214 (1.9.0): the scheduler's runs per account, handed to the account's page (`take_diagnostics`).
  'diagnostics_journal',
  'listing_blocks',
  // QUICK-289 (1.10.0): the catalog's `scheduler` policy (clamped to this build's bounds) and batched scheduled writes.
  'scheduler_policy',
  // QUICK-289 PR 2 (1.10.0): explicit price schedules on reprice rules and the policy's per-platform error map.
  'scheduler_schedule',
  // QUICK-296 (1.10.0): price followers (`sync:` rules) that keep a live listing on its reference listing's price.
  'scheduler_sync',
  // QUICK-305 (1.12.0): one working browser per account runs the scheduled rules (`set_active_browser`).
  'active_browser',
  ...(OPERATION_TABLE_PUBLIC_KEY ? (['signed_operation_table'] as const) : []),
];
