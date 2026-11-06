/**
 * What Chrome's `storage.local` hands back: a JSON copy whose object keys come back sorted at every depth
 * (Chrome stores a base::Value dictionary) and whose undefined values are dropped. A structured clone keeps
 * insertion order (Firefox), which hid scheduler bugs that compare a stored rule with an in-memory one.
 */
export function chromeStored<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) =>
      inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner
    )
  ) as T;
}
