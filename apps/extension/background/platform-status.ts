// apps/extension/background/platform-status.ts
//
// QUICK-202: permission, login state and last check issue per platform, for the web's Platforms page. Access is
// read for the bundled origins (PLATFORM_CONNECTIONS), never the page-published ones; login checks run only with
// full access, after queued DNR installs, at most one per platform at a time, with a short cache and a cooldown.
// The answer is status only: every row is built field by field from enumerated values.
import type { ConnectablePlatform, PlatformCatalogEntry, PlatformConnectionStatus, PlatformPermissionState } from '@qts/contracts';
import { PLATFORM_CONNECTIONS } from '@qts/contracts';

import { platformPermission } from '@/shared/platform-access';
import { getPlatformCatalog } from '@/shared/platformCatalog';

import { pageDnrInstalledAt, pageDnrSettled } from './dnr-service';
import { type LoginObservation, observeLogin } from './loginStatus';

/** A request without `force` is answered from a check this recent. */
export const STATUS_CACHE_MS = 30_000;
/** Even a forced refresh reuses a check this recent (Retry clicks, several tabs). */
export const STATUS_FORCE_COOLDOWN_MS = 5_000;
/** A check that has not answered by then is reported as `timeout`. */
export const STATUS_CHECK_TIMEOUT_MS = 10_000;

const cache = new Map<ConnectablePlatform, PlatformConnectionStatus>();
const inFlight = new Map<ConnectablePlatform, Promise<PlatformConnectionStatus>>();
/**
 * Login probes still running, by platform. A timeout reports the check without cancelling its request, so a later
 * check waits for that request again instead of sending a second one to a marketplace that is already slow.
 */
const liveProbes = new Map<ConnectablePlatform, Promise<LoginObservation>>();

function toStatus(platform: ConnectablePlatform, permission: PlatformPermissionState, observation: LoginObservation): PlatformConnectionStatus {
  const status: PlatformConnectionStatus = { platform, permission, login: observation.login, checkedAt: Date.now() };
  if (observation.evidence) status.evidence = observation.evidence;
  if (observation.issue) status.issue = observation.issue;
  if (observation.httpStatus !== undefined) status.httpStatus = observation.httpStatus;
  if (observation.retryAt !== undefined) status.retryAt = observation.retryAt;
  return status;
}

const NOT_CHECKED: LoginObservation = { login: 'unknown', issue: 'not_granted' };

function withTimeout(observation: Promise<LoginObservation>): Promise<LoginObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LoginObservation>((resolve) => {
    timer = setTimeout(() => resolve({ login: 'unknown', issue: 'timeout' }), STATUS_CHECK_TIMEOUT_MS);
  });
  return Promise.race([observation, timeout]).finally(() => clearTimeout(timer));
}

function probe(platform: ConnectablePlatform, entry: PlatformCatalogEntry): Promise<LoginObservation> {
  const live = liveProbes.get(platform);
  if (live) return live;
  const started = observeLogin({ ...entry, origins: [...PLATFORM_CONNECTIONS[platform].origins] }).finally(() => liveProbes.delete(platform));
  liveProbes.set(platform, started);
  return started;
}

async function check(platform: ConnectablePlatform, entry: PlatformCatalogEntry | undefined): Promise<PlatformConnectionStatus> {
  const permission = await platformPermission(platform);
  if (permission !== 'granted') return toStatus(platform, permission, NOT_CHECKED);
  const observation: LoginObservation = entry ? await withTimeout(probe(platform, entry)) : { login: 'unknown', issue: 'no_check' };
  // Access revoked while the check ran: its answer no longer describes what the extension may do.
  const after = await platformPermission(platform);
  return after === 'granted' ? toStatus(platform, after, observation) : toStatus(platform, after, NOT_CHECKED);
}

function hostsOf(platform: ConnectablePlatform): string[] {
  return PLATFORM_CONNECTIONS[platform].origins.map((origin) => new URL(origin.replace(/\/\*$/, '/')).host);
}

/**
 * A row checked before header rules for one of its hosts were installed may hold the answer the rules prevent (a
 * cross-origin 403): it is not reused (QUICK-202 r1).
 */
function predatesRules(status: PlatformConnectionStatus): boolean {
  return status.checkedAt < pageDnrInstalledAt(hostsOf(status.platform));
}

/** Until when a cached row answers: its cache window, and never before the platform's own retry time. */
function reusableUntil(status: PlatformConnectionStatus, force: boolean): number {
  return Math.max(status.checkedAt + (force ? STATUS_FORCE_COOLDOWN_MS : STATUS_CACHE_MS), status.retryAt ?? 0);
}

function statusOf(platform: ConnectablePlatform, entry: PlatformCatalogEntry | undefined, force: boolean): Promise<PlatformConnectionStatus> {
  const pending = inFlight.get(platform);
  if (pending) return pending;
  const run = (async () => {
    const cached = cache.get(platform);
    // The cache holds what was observed under one access state; a grant or a revocation since makes it stale.
    if (cached && Date.now() < reusableUntil(cached, force) && !predatesRules(cached) && (await platformPermission(platform)) === cached.permission) return cached;
    const status = await check(platform, entry);
    cache.set(platform, status);
    return status;
  })().finally(() => inFlight.delete(platform));
  inFlight.set(platform, run);
  return run;
}

/** The status of each platform, in the order asked. Never throws for one platform's failure. */
export async function getPlatformStatuses(platforms: readonly ConnectablePlatform[], options: { force?: boolean } = {}): Promise<PlatformConnectionStatus[]> {
  // Taken before any await: a set_dnr_rules that reached the background first is installed before any probe.
  await pageDnrSettled();
  const catalog = await getPlatformCatalog();
  return Promise.all(
    platforms.map((platform) =>
      statusOf(
        platform,
        catalog.find((entry) => entry.id === platform),
        options.force === true
      )
    )
  );
}
