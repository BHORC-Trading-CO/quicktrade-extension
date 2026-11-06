import type { DnrRule } from '@qts/contracts';

// Background-owned counterpart of web/constants/haloskins.ts. Keep this small copy while
// extension 1.0.55 still needs the web's legacy primer. No cookie/rule data is returned to the page.
export const HALOSKINS_DNR_ID = 1014;
/** A HaloSkins proxy request re-reads the cookies into rule 1014 when the last refresh is older than this. */
export const HALOSKINS_PRIME_MAX_AGE_MS = 4 * 60 * 1000;
const COOKIE_URL = 'https://www.haloskins.com';
const SESSION_COOKIES = ['prodToken', 'sessionId', 'device_id'] as const;

type HaloSkinsRule = DnrRule & { condition: { requestDomains: string[] } };

export function buildHaloSkinsRule(cookieHeader: string, userAgent: string, extensionHost: string): HaloSkinsRule {
  return {
    id: HALOSKINS_DNR_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: COOKIE_URL },
        { header: 'Referer', operation: 'set', value: `${COOKIE_URL}/` },
        { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
        { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
        { header: 'Cookie', operation: 'set', value: cookieHeader },
        { header: 'User-Agent', operation: 'set', value: userAgent },
      ],
    },
    condition: {
      urlFilter: '|https://www.haloskins.com/api/',
      requestDomains: ['www.haloskins.com'],
      resourceTypes: ['xmlhttprequest', 'other'],
      excludedInitiatorDomains: ['haloskins.com'],
      initiatorDomains: [extensionHost],
    },
  };
}

async function refreshHaloSkinsRule(): Promise<void> {
  if (!browser.declarativeNetRequest?.updateDynamicRules) return;
  const removeRuleIds = [HALOSKINS_DNR_ID];
  try {
    const addRules: HaloSkinsRule[] = [];
    if (await browser.permissions.contains({ origins: [`${COOKIE_URL}/*`] })) {
      const clearance = await browser.cookies.get({
        url: COOKIE_URL,
        name: 'cf_clearance',
        partitionKey: { topLevelSite: 'https://haloskins.com' },
      } as Parameters<typeof browser.cookies.get>[0]);
      if (clearance?.value) {
        const cookies = await Promise.all(SESSION_COOKIES.map((name) => browser.cookies.get({ url: COOKIE_URL, name })));
        const pairs = [`cf_clearance=${clearance.value}`];
        cookies.forEach((cookie, index) => {
          if (cookie?.value) pairs.push(`${SESSION_COOKIES[index]}=${cookie.value}`);
        });
        addRules.push(buildHaloSkinsRule(pairs.join('; '), navigator.userAgent, new URL(browser.runtime.getURL('/')).hostname));
      }
    }
    // Atomic replacement removes legacy page-built rules and clears 1014 when permission/clearance is lost.
    await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: addRules as chrome.declarativeNetRequest.Rule[] });
  } catch {
    // Do not forward browser errors: DNR validation errors can contain header/cookie values.
    try {
      await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    } catch {
      console.warn('[qts background] HaloSkins rule cleanup failed');
    }
    console.warn('[qts background] HaloSkins priming failed');
  }
}

let priming: Promise<void> = Promise.resolve();
/** When this worker last queued a refresh; null until the first one. */
let lastPrimedAt: number | null = null;

/** Serialize startup/permission/on-demand refreshes so an older read cannot overwrite a newer one. */
export function primeHaloSkins(): Promise<void> {
  lastPrimedAt = Date.now();
  priming = priming.then(refreshHaloSkinsRule);
  return priming;
}

/**
 * Runs before every proxied request instead of a polling alarm (an alarm keeps waking the MV3 worker).
 * A HaloSkins request refreshes rule 1014 when this worker has not primed in the last
 * HALOSKINS_PRIME_MAX_AGE_MS, otherwise it waits for any refresh still in flight. Other hosts pass through.
 */
export function primeHaloSkinsForRequest(url: string): Promise<void> {
  if (!isHaloSkinsUrl(url)) return Promise.resolve();
  const age = lastPrimedAt === null ? Infinity : Date.now() - lastPrimedAt;
  return age >= 0 && age < HALOSKINS_PRIME_MAX_AGE_MS ? priming : primeHaloSkins();
}

function isHaloSkinsUrl(url: string): boolean {
  try {
    return new URL(url).origin === COOKIE_URL;
  } catch {
    return false;
  }
}
