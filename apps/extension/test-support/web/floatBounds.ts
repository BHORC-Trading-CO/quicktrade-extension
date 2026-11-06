// apps/web/src/lib/floatBounds.ts
// A float window at a marketplace's precision. Kept free of path aliases: the platform clients import it, and the
// extension's tests compile those clients with its own tsconfig.

export interface FloatBounds {
  min: number;
  max: number;
}

/** Guards a bound that sits on the grid against binary noise (0.15 × 10⁴ is 1499.9999999999998). */
const GRID_EPSILON = 1e-9;

/**
 * A window at a marketplace's precision, widened outwards: the lower bound cut down and the upper one raised to
 * `decimals` digits, so a band finer than the marketplace takes (0.06000–0.06001 at four digits) never becomes an
 * empty or a narrower range. The search filters the answer to the exact band afterwards.
 */
export function floatBoundsAtDecimals(floatMin: number, floatMax: number, decimals: number): FloatBounds {
  const scale = 10 ** decimals;
  const min = Math.floor(Math.max(0, floatMin) * scale + GRID_EPSILON) / scale;
  const max = Math.min(1, Math.ceil(floatMax * scale - GRID_EPSILON) / scale);
  return { min, max: max > min ? max : Math.min(1, min + 1 / scale) };
}
