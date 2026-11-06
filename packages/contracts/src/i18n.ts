/**
 * Interface languages shared by the web app, the landing and the extension (QUICK-189): the locale list, their
 * names, the `NEXT_LOCALE` cookie and the language-tag matcher. Pure and browser-API-free: the caller passes the
 * language tags (the web parses `Accept-Language`, the landing and the extension read `navigator.languages`) and the
 * locales it has enabled (each app decides its own list).
 */

/** Every locale the product is translated into; `en` is the source language. */
export const LOCALES = ['en', 'ru', 'uk', 'zh-CN', 'zh-TW', 'pt-BR', 'es', 'de', 'fr', 'pl', 'tr', 'ja', 'ko'] as const;

export type Locale = (typeof LOCALES)[number];

/** The source language: the fallback for every missing match and every missing message. */
export const SOURCE_LOCALE: Locale = 'en';

/** Each language named in itself, for the language switcher (no flags: a language is not a country). */
export const LOCALE_NATIVE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  ru: 'Русский',
  uk: 'Українська',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'pt-BR': 'Português (Brasil)',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  pl: 'Polski',
  tr: 'Türkçe',
  ja: '日本語',
  ko: '한국어',
};

/** The cookie that holds an explicit choice made in a language switcher. A detected language is never stored. */
export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE';
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The registrable domain whose hosts (apex landing, app host) share one language choice. */
const SHARED_COOKIE_DOMAIN = 'quicktrade.skin';

/** At most this many `Accept-Language` entries (or `navigator.languages`) are read; a real browser sends a handful. */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 32;

const LOCALE_BY_LOWER_CASE: ReadonlyMap<string, Locale> = new Map(
  LOCALES.map((locale) => [locale.toLowerCase(), locale])
);

/** Chinese regions that write Traditional characters. */
const TRADITIONAL_CHINESE_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo']);

/** Languages of the CIS whose speakers usually read Russian: they get `ru` only when no other tag matched. */
const RUSSIAN_READING_LANGUAGES: ReadonlySet<string> = new Set(['be', 'kk', 'ky']);

/** A BCP 47-shaped tag: letters, then letter/digit subtags. Anything else is ignored as junk. */
const LANGUAGE_TAG = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** `zh-cn`, `ZH_CN` → `zh-CN`: one of LOCALES written in any case, with `-` or `_`; otherwise null. */
export function canonicalLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  return LOCALE_BY_LOWER_CASE.get(value.trim().replace(/_/g, '-').toLowerCase()) ?? null;
}

/**
 * The enabled locales from a comma-separated list (an app's env override), in LOCALES order. Unknown entries are
 * dropped and `en` is always included. An unset or blank list gives `fallback` (the app's own constant).
 */
export function parseEnabledLocales(raw: string | null | undefined, fallback: readonly Locale[]): Locale[] {
  const listed = raw?.trim() ? raw.split(',') : fallback;
  const enabled = new Set<Locale>([SOURCE_LOCALE]);
  for (const entry of listed) {
    const locale = canonicalLocale(entry);
    if (locale) enabled.add(locale);
  }
  return LOCALES.filter((locale) => enabled.has(locale));
}

/**
 * The language tags of an `Accept-Language` header, most preferred first: sorted by `q` (stable, so equal weights
 * keep the header's order), without `*`, entries with `q=0` and entries whose `q` is not a number in (0, 1].
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const entries: { tag: string; q: number; index: number }[] = [];
  const parts = header.split(',').slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES);
  for (let index = 0; index < parts.length; index++) {
    const [rawTag = '', ...params] = (parts[index] ?? '').split(';');
    const tag = rawTag.trim();
    if (!tag || tag === '*') continue;
    let q = 1;
    for (const param of params) {
      const [name = '', value = ''] = param.split('=');
      if (name.trim().toLowerCase() !== 'q') continue;
      q = /^\s*[01](?:\.\d{0,3})?\s*$/.test(value) ? Number(value) : Number.NaN;
    }
    if (!(q > 0 && q <= 1)) continue;
    entries.push({ tag, q, index });
  }
  entries.sort((a, b) => b.q - a.q || a.index - b.index);
  return entries.map((entry) => entry.tag);
}

/** A tag in lower case with `-` separators, or null when it is not BCP 47-shaped (`*`, `kk-!`, `be-<script>`, `ky---`). */
function normalizeTag(rawTag: string): string | null {
  const tag = rawTag.trim().replace(/_/g, '-').toLowerCase();
  return LANGUAGE_TAG.test(tag) ? tag : null;
}

/** The locale one language tag asks for, whether or not it is enabled; null when the product has no such language. */
function localeForTag(rawTag: string): Locale | null {
  const tag = normalizeTag(rawTag);
  if (!tag) return null;

  const exact = LOCALE_BY_LOWER_CASE.get(tag);
  if (exact) return exact;

  const [language = '', ...subtags] = tag.split('-');
  if (language === 'zh') {
    // A script subtag decides (zh-Hant-*, zh-Hans-*); otherwise the region: TW/HK/MO write Traditional.
    const script = subtags.find((subtag) => subtag.length === 4);
    if (script === 'hant') return 'zh-TW';
    if (script === 'hans') return 'zh-CN';
    return subtags.some((subtag) => TRADITIONAL_CHINESE_REGIONS.has(subtag)) ? 'zh-TW' : 'zh-CN';
  }
  if (language === 'pt') return 'pt-BR';
  // A base-language match: de-AT → de, fr-CA → fr, es-419 → es, ko-KR → ko, en-GB → en.
  return LOCALE_BY_LOWER_CASE.get(language) ?? null;
}

/** The base language of a valid tag (`kk-KZ` → `kk`), lower case; null for junk. */
function baseLanguage(rawTag: string): string | null {
  return normalizeTag(rawTag)?.split('-')[0] ?? null;
}

/**
 * The first enabled locale that the preference-ordered tags ask for, or null. Each tag in turn: the exact locale
 * (case-insensitive, `_` allowed); `zh`, `zh-Hans*`, `zh-CN`, `zh-SG` → zh-CN and `zh-Hant*`, `zh-TW`, `zh-HK`,
 * `zh-MO` → zh-TW; any `pt*` → pt-BR; otherwise the base language (`de-AT` → de). A tag whose locale is not enabled,
 * `*` and junk are skipped. Only when no tag matched: `be`, `kk`, `ky` anywhere in the list → ru, so `kk, en` gets
 * English (the browser named it) and `kk` alone gets Russian.
 */
export function matchLocale(languages: readonly string[], enabled: readonly Locale[]): Locale | null {
  // The same bound as the header, so `navigator.languages` and `Accept-Language` agree on long lists.
  const tags = languages.slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES);
  for (const tag of tags) {
    const locale = localeForTag(tag);
    if (locale && enabled.includes(locale)) return locale;
  }
  const readsRussian = tags.some((tag) => {
    const language = baseLanguage(tag);
    return language !== null && RUSSIAN_READING_LANGUAGES.has(language);
  });
  return readsRussian && enabled.includes('ru') ? 'ru' : null;
}

/**
 * The interface language: the cookie when it names an enabled locale (an explicit choice), else the best enabled
 * match for the user's languages (most preferred first), else `en`.
 */
export function resolveLocale(input: {
  cookie: string | null | undefined;
  languages: readonly string[];
  enabled: readonly Locale[];
}): Locale {
  const chosen = canonicalLocale(input.cookie);
  if (chosen && input.enabled.includes(chosen)) return chosen;
  return matchLocale(input.languages, input.enabled) ?? SOURCE_LOCALE;
}

/** `.quicktrade.skin` on that domain and its subdomains (the landing and the app share a choice); else host-only. */
export function localeCookieDomain(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host === SHARED_COOKIE_DOMAIN || host.endsWith(`.${SHARED_COOKIE_DOMAIN}`)
    ? `.${SHARED_COOKIE_DOMAIN}`
    : undefined;
}

/** The `document.cookie` assignment that stores an explicit language choice for a year. */
export function serializeLocaleCookie(locale: Locale, page: { hostname: string; secure: boolean }): string {
  const domain = localeCookieDomain(page.hostname);
  return [
    `${LOCALE_COOKIE_NAME}=${locale}`,
    'Path=/',
    `Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
    ...(domain ? [`Domain=${domain}`] : []),
    ...(page.secure ? ['Secure'] : []),
  ].join('; ');
}
