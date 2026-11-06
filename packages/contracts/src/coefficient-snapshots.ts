import type { ReferencePlatformId } from './preferences';

/**
 * The account's daily coefficient snapshots: the benchmark median price (USD) of every coefficient platform as the
 * browser calculated it, one per UTC day, the newest calculation of the day kept. Trade-history profit in a reference
 * platform's prices converts each leg with the snapshot of its day, so changing the reference later re-bases it.
 */

/** `YYYY-MM-DD`, UTC. */
export type CoefficientSnapshotDay = string;

/** Benchmark median per coefficient platform; a platform without a price is left out. */
export type CoefficientMedians = Partial<Record<ReferencePlatformId, number>>;

export interface CoefficientSnapshot {
  day: CoefficientSnapshotDay;
  /** ISO time of the calculation. */
  calculatedAt: string;
  medians: CoefficientMedians;
}

/** `GET /api/coefficient-snapshots`: the account's snapshots, oldest day first. */
export interface CoefficientSnapshotsResponse {
  snapshots: CoefficientSnapshot[];
}

/** `PUT /api/coefficient-snapshots`: one calculation; the server files it under its UTC day. */
export interface CoefficientSnapshotWrite {
  /** ms epoch on the client's clock; within `COEFFICIENT_SNAPSHOT_MAX_AGE_MS` of the server's. */
  calculatedAt: number;
  medians: CoefficientMedians;
}

/** A calculation older than this is refused: a snapshot records the day it was made, not history after the fact. */
export const COEFFICIENT_SNAPSHOT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
