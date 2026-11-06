// CS2 Doppler / Gamma Doppler finishes are identified by `paint_index`, not consistently
// by the market_hash_name across platforms: CSFloat omits the phase from the name (so it
// must be searched by def_index + paint_index), while cs.money includes it in the name
// (e.g. "★ Karambit | Doppler Sapphire (Factory New)"). A cs.money search by the generic
// name therefore returns every phase. This map drives the cs.money name augmentation;
// CSFloat narrows by paint_index directly and needs no label.
//
// Values from the CS:GO item schema (paint_index → phase):
//   Doppler        415 Ruby · 416 Sapphire · 417 Black Pearl · 418–421 Phase 1–4
//   Gamma Doppler  568 Emerald · 569–572 Phase 1–4
// Only these drive the cs.money name augmentation: their cs.money spelling is the one the competitor
// search was built and checked against.
export const PHASE_BY_PAINT_INDEX: Record<number, string> = {
  415: 'Ruby',
  416: 'Sapphire',
  417: 'Black Pearl',
  418: 'Phase 1',
  419: 'Phase 2',
  420: 'Phase 3',
  421: 'Phase 4',
  568: 'Emerald',
  569: 'Phase 1',
  570: 'Phase 2',
  571: 'Phase 3',
  572: 'Phase 4',
};


const EXTRA_PHASE_BY_PAINT_INDEX: Record<number, string> = {
  617: 'Black Pearl',
  618: 'Phase 2',
  619: 'Sapphire',
  852: 'Phase 1',
  853: 'Phase 2',
  854: 'Phase 3',
  855: 'Phase 4',
  1119: 'Emerald',
  1120: 'Phase 1',
  1121: 'Phase 2',
  1122: 'Phase 3',
  1123: 'Phase 4',
};

/** Every phase label, longest first so "Black Pearl" is matched as a whole. */
const PHASE_LABELS = [...new Set(Object.values(PHASE_BY_PAINT_INDEX))].toSorted((a, b) => b.length - a.length);

/** The Doppler/Gamma-Doppler phase label for a paint index, or null if it isn't a known phase. */
export function phaseLabel(paintIndex: number | undefined): string | null {
  if (paintIndex === undefined) return null;
  return PHASE_BY_PAINT_INDEX[paintIndex] ?? null;
}


export function dopplerPhaseLabel(paintIndex: number | undefined): string | null {
  if (paintIndex === undefined) return null;
  return PHASE_BY_PAINT_INDEX[paintIndex] ?? EXTRA_PHASE_BY_PAINT_INDEX[paintIndex] ?? null;
}

/**
 * Insert the Doppler/Gamma-Doppler phase label into a market_hash_name that lacks it, so a
 * cs.money name search narrows to the right phase. Inserts the label before the " (Wear)"
 * suffix ("…Doppler (Factory New)" → "…Doppler Sapphire (Factory New)"). Returns the name
 * unchanged when there's no phase for the index, the name already carries it, or the name
 * isn't a Doppler (guards against any unrelated skin colliding with a Doppler paint index).
 */
export function withPhaseName(name: string, paintIndex: number | undefined): string {
  const phase = phaseLabel(paintIndex);
  if (!phase || !name || !name.includes('Doppler')) return name;
  if (name.includes(phase)) return name;
  const inserted = name.replace(/(\s\([^)]*\))\s*$/, ` ${phase}$1`);
  return inserted !== name ? inserted : `${name} ${phase}`;
}

/**
 * The phase a Doppler / Gamma Doppler name carries itself — cs.money spells it into the name
 * (`★ Karambit | Doppler Sapphire (Factory New)`) — or null when the name names none (Steam's and CSFloat's
 * market_hash_name never do) or is not a Doppler.
 */
export function phaseFromName(name: string | undefined): string | null {
  if (!name?.includes('Doppler')) return null;
  return PHASE_LABELS.find((label) => name.includes(label)) ?? null;
}

/**
 * A Doppler / Gamma Doppler name without the phase it spells, in either form (cs.money's suffix `Doppler Sapphire`, our
 * brackets `Doppler (Sapphire)`), so it names the same skin as Steam's and CSFloat's phase-less name. Other names
 * are returned unchanged.
 */
export function withoutPhaseName(name: string): string {
  const phase = phaseFromName(name);
  if (!phase) return name;
  return name.replace(` (${phase})`, '').replace(` ${phase}`, '');
}
