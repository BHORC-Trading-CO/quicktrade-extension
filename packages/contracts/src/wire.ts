/**
 * Pure readers of JSON answers, shared by the web and the admin app (QUICK-250). No browser APIs, no React.
 */

/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept the canonical ISO timestamp emitted by JSON.stringify(Date), never ambiguous local dates. */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}
