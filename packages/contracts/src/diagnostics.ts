/**
 * The support diagnostics journal (QUICK-214): what each account's browser did, kept 14 days on our server, read by
 * admins in the user's Diagnostics tab. Metadata only: never cookies, tokens, authorization headers, request or
 * response bodies, or query values. The web and the extension build events with the helpers below; the server
 * validates and cleans every field again (`apps/server/src/diagnostics`).
 */

export const DIAGNOSTICS_LIMITS = {
  /** Events in one `POST /api/diagnostics/events`. */
  maxEventsPerRequest: 200,
  /** Body of that request. */
  maxBodyBytes: 256 * 1024,
  /** Stored per account per UTC day; the rest is counted as dropped. */
  storedPerAccountPerDay: 20_000,
  /** Bytes of stored events (their JSON) per account per UTC day; the rest is counted as dropped. */
  storedBytesPerAccountPerDay: 8 * 1024 * 1024,
  /** How long the server keeps an event. */
  retentionMs: 14 * 24 * 60 * 60 * 1000,
  /** Free text (an error message, an extension detail). */
  maxTextLength: 300,
  /** A stack trace, after cleaning. */
  maxStackLength: 2_000,
  /** A path template or an API route. */
  maxPathLength: 200,
  /** An event dated further from the server's clock than this is filed at the server's time. */
  maxClockSkewMs: 24 * 60 * 60 * 1000,
  /**
   * An event the extension kept for the page (its scheduler's runs) may be this old: the extension keeps them up to
   * `EXTENSION_JOURNAL_LIMITS.maxAgeMs`, until a page of the same account takes them.
   */
  maxReplayAgeMs: 8 * 24 * 60 * 60 * 1000,
} as const;

export const DIAGNOSTIC_KINDS = ['proxy', 'api', 'inventory', 'extension', 'scheduler', 'client_error'] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

/** Fields every event carries. */
export interface DiagnosticEventCommon {
  /** When it happened, the browser's clock (epoch ms). */
  at: number;
  /** One page load of one tab (random), so a support reader can follow one session. */
  tab: string;
  /** The web build (short commit). */
  web?: string;
  /** The extension's version, when one answered. */
  ext?: string;
  /** Browser family and major version, e.g. `chrome 130`. */
  browser?: string;
  /**
   * Events this tab dropped since the last one it kept (memory full, a failure repeating too fast, a batch the server
   * refused): a gap in the journal just before this event.
   */
  lost?: number;
}

/** A marketplace request the page sent through the extension. */
export interface ProxyDiagnostic extends DiagnosticEventCommon {
  kind: 'proxy';
  platform: string;
  /** The matched operation id (`cs.money.inventory`), absent when none matched. */
  operation?: string;
  method: string;
  /** Host and path template without values: the operation's declared path, or ids replaced by `:id`. */
  path: string;
  /** HTTP status; 0 = no answer (timeout, network, withheld redirect). */
  status: number;
  ms: number;
  /** Size of the answer in bytes, when known. */
  bytes?: number;
  /** The extension's or transport's error code: `timeout`, `operation_refused:<reason>`, … */
  error?: string;
}

/** A request to our own API. */
export interface ApiDiagnostic extends DiagnosticEventCommon {
  kind: 'api';
  /** Route template without values, e.g. `/api/panel-cache/:kind/:id`. */
  route: string;
  method: string;
  /** HTTP status; 0 = the request never reached the server. */
  status: number;
  ms: number;
  /** The server's error code (`plan_required`, `quota_exceeded`, …). */
  code?: string;
}

export const INVENTORY_DIAGNOSTIC_STEPS = ['page', 'read', 'shown'] as const;
export type InventoryDiagnosticStep = (typeof INVENTORY_DIAGNOSTIC_STEPS)[number];

/** `steam_mismatch`: the connected marketplaces name different Steam accounts, so nothing was read. */
export const INVENTORY_READ_STOPS = ['end', 'page_failed', 'page_cap', 'no_answer', 'steam_mismatch'] as const;
export type InventoryReadStop = (typeof INVENTORY_READ_STOPS)[number];

/**
 * The counts of one inventory load, step by step, so a support reader can tell where items went missing:
 * `page` = one marketplace page (its index, status, rows); `read` = one marketplace's read (pages, rows, why it
 * stopped, the total it reported); `shown` = the load (rows fetched from every market, cards after parsing and
 * merging them), then what the grid shows with its filters (a separate `shown` event, again when the filters change).
 */
export interface InventoryDiagnostic extends DiagnosticEventCommon {
  kind: 'inventory';
  step: InventoryDiagnosticStep;
  /** The marketplace; absent on `shown`. */
  platform?: string;
  /** Steam's inventory context: 2 tradable, 16 trade-protected (best effort, a 403 there is normal). */
  context?: number;
  page?: number;
  status?: number;
  /** Rows on the page (`page`), or rows read (`read`). */
  items?: number;
  pages?: number;
  stop?: InventoryReadStop;
  /** The total the marketplace reported, when it reports one. */
  total?: number;
  /** Rows the markets returned, Steam's assets and a CSFloat stall's listings included. */
  fetched?: number;
  /** Cards after parsing and merging every market's rows. */
  parsed?: number;
  /** Cards the grid shows with `filters`. */
  shown?: number;
  /**
   * The active grid filters as `name:value` words, e.g. `platform:cs.money status:onSale search:on` (never the search
   * text; `name=value` would be redacted as a secret).
   */
  filters?: string;
}

export const EXTENSION_DIAGNOSTIC_EVENTS = [
  'not_responding',
  'disconnected',
  'outdated',
  'operation_refused',
  'permission_missing',
  'redirect_withheld',
  'dnr_refused',
] as const;
export type ExtensionDiagnosticEvent = (typeof EXTENSION_DIAGNOSTIC_EVENTS)[number];

/** Something about the extension itself: it did not answer, is too old, refused a request or a rule. */
export interface ExtensionDiagnostic extends DiagnosticEventCommon {
  kind: 'extension';
  event: ExtensionDiagnosticEvent;
  platform?: string;
  operation?: string;
  detail?: string;
}

export const SCHEDULER_DIAGNOSTIC_OUTCOMES = ['ok', 'retry', 'paused', 'error', 'skipped'] as const;
export type SchedulerDiagnosticOutcome = (typeof SCHEDULER_DIAGNOSTIC_OUTCOMES)[number];

/** One run of a scheduled price rule in the extension's background. */
export interface SchedulerDiagnostic extends DiagnosticEventCommon {
  kind: 'scheduler';
  platform: string;
  stage: 'check' | 'write';
  outcome: SchedulerDiagnosticOutcome;
  status?: number;
  /** The rule's `pausedReason` when the run paused it. */
  paused?: string;
  /** The rule's `retiredReason` when the run ended it for good (`listed`, `not_listed`, `never_appeared`, …). */
  retired?: string;
}

/** An exception the page did not handle: message and where, cleaned. */
export interface ClientErrorDiagnostic extends DiagnosticEventCommon {
  kind: 'client_error';
  message: string;
  /** `file:line:col` of the throw, without query. */
  source?: string;
  stack?: string;
}

export type DiagnosticEvent =
  | ProxyDiagnostic
  | ApiDiagnostic
  | InventoryDiagnostic
  | ExtensionDiagnostic
  | SchedulerDiagnostic
  | ClientErrorDiagnostic;

/** `POST /api/diagnostics/events`. */
export interface DiagnosticEventsRequest {
  events: DiagnosticEvent[];
}

/** How many were stored; `dropped` = invalid ones plus those over the day's cap. */
export interface DiagnosticEventsResponse {
  accepted: number;
  dropped: number;
}

/** An event as the admin reads it: the client's fields plus when the server received it. */
export type StoredDiagnosticEvent<TDate = string> = DiagnosticEvent & { id: string; receivedAt: TDate };

export interface DiagnosticUsageDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  stored: number;
  dropped: number;
}

/** Filters on the event time, including an exact opaque tab id (1..64 letters, digits, underscores or hyphens). */
export interface AdminDiagnosticsFilter {
  kind?: DiagnosticKind;
  platform?: string;
  tab?: string;
  problems?: boolean;
  from?: number;
  to?: number;
  cursor?: string;
}

/** `GET /api/admin/users/:clerkId/diagnostics`: newest first. */
export interface AdminDiagnosticsResponse<TDate = string> {
  events: StoredDiagnosticEvent<TDate>[];
  nextCursor: string | null;
  /** The account's stored and dropped counts of the last days. */
  usage: DiagnosticUsageDay[];
}

const ID_SEGMENT =
  /^(?:\d{4,}|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{24,}|7656119\d{10})$/i;
/** What a path segment may keep: letters, digits, `._~-`, and an operation template's `{name:type}`. */
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]*$/;
/** An operation's declared placeholder, kept as it is: `{steamId:int}`, `{listingId:id}`. */
const TEMPLATE_SEGMENT = /^\{[A-Za-z]{1,32}:(?:int|id)\}$/;
/** A value hiding inside a segment: a Steam id, a long number or a long opaque run. */
const ID_INSIDE = /7656119\d{10}|\d{6,}|[A-Za-z0-9]{24,}/;
/** Segments whose next one is a value: a person (`/id/<vanity>`, `/profiles/<steam id>`) or a secret (`/token/<value>`). */
const VALUE_AFTER_SEGMENTS = new Set([
  'id',
  'profiles',
  'user',
  'users',
  'key',
  'keys',
  'secret',
  'session',
  'sessions',
  'token',
  'tokens',
]);

/** One segment, or `:id` when it is value-like, follows a person or secret segment (`/id/`, `/token/`, …) or has unusual characters. */
function redactSegment(segment: string, previous: string | undefined): string {
  if (!segment || TEMPLATE_SEGMENT.test(segment)) return segment;
  if (previous !== undefined && VALUE_AFTER_SEGMENTS.has(previous.toLowerCase())) return ':id';
  return !SAFE_SEGMENT.test(segment) || ID_SEGMENT.test(segment) || ID_INSIDE.test(segment) ? ':id' : segment;
}

/** One path's segments with every value-like, person-naming or unusual one replaced by `:id`. */
function redactSegments(path: string): string {
  const segments = path.split('/');
  return segments
    .map((segment, index) => redactSegment(segment, index > 0 ? segments[index - 1] : undefined))
    .join('/');
}

/**
 * A URL as host + path with every value-like segment replaced by `:id`, without query or fragment: what a
 * diagnostic may say about an address. An operation's declared path (`/api/v1/users/{steamId:int}/stall`) is a better
 * template when one matched; this is the fallback.
 */
export function redactDiagnosticPath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid-url';
  }
  return `${parsed.host}${redactSegments(parsed.pathname)}`.slice(0, DIAGNOSTICS_LIMITS.maxPathLength);
}

/** An API path (`/panel-cache/competitors/123?scope=x`) as a route template without values (`/panel-cache/competitors/:id`). */
export function redactDiagnosticRoute(path: string): string {
  return redactSegments(path.split(/[?#]/, 1)[0] ?? '').slice(0, DIAGNOSTICS_LIMITS.maxPathLength);
}

/** An error or code string as the server accepts it in a code field: letters, digits and `_:./-`, at most 120. */
export function diagnosticCode(value: string): string | undefined {
  const code = value
    .replace(/[^A-Za-z0-9_:./-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 120);
  return code || undefined;
}

/** Free text is cut to this many times its stored length before cleaning, so the rules never scan more than that. */
const TEXT_INPUT_FACTOR = 4;

/** Control characters and bidi marks: text that could pass for something else in the admin view. */
function isHiddenCharacter(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function withoutHiddenCharacters(text: string): string {
  let out = '';
  for (const character of text) if (!isHiddenCharacter(character.codePointAt(0) ?? 0)) out += character;
  return out;
}

/** A JSON key whose string value is a secret (`"password": "…"`, `"sessionToken": "…"`). */
const SECRET_KEY = /pass|secret|token|key|cookie|session|auth|sig|credential/i;

type TextReplacement = string | ((match: string, ...groups: string[]) => string);

const TEXT_RULES: readonly (readonly [RegExp, TextReplacement])[] = [
  // Credentials in an address (`https://user:password@host`).
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]{1,256}@/gi, '$1[redacted]@'],
  // Query strings and fragments, of absolute and relative addresses alike.
  [/([^\s?#'"<>])[?#][^\s'"<>]+/g, '$1?…'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{1,4096}=*/gi, '$1 [redacted]'],
  // A JWT whole, its short header and payload too (one candidate per run of token characters: linear).
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, '[jwt]'],
  // `name=value` pairs (cookies, form fields): the value goes, quoted ones with escapes or without their closing quote too.
  [
    /\b([A-Za-z_][A-Za-z0-9_.-]{0,63})=(?:"(?:[^"\\\n]|\\.){0,4096}"?|'(?:[^'\\\n]|\\.){0,4096}'?|[^\s;&,'"<>]{1,4096})/g,
    '$1=[redacted]',
  ],
  // A secret-named JSON key's string value (`"password":"…"`); other keys keep theirs.
  [
    /"([A-Za-z0-9_.-]{1,64})"(\s{0,8}:\s{0,8})"(?:[^"\\\n]|\\.){0,4096}"?/g,
    (match, key = '', separator = '') => (SECRET_KEY.test(key) ? `"${key}"${separator}"[redacted]"` : match),
  ],
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g, '[email]'],
  [/(?<!\d)7656119\d{10}(?!\d)/g, '[steamid]'],
  // Long numbers: trade offer, asset and listing ids.
  [/(?<![A-Za-z0-9])\d{9,}(?![A-Za-z0-9])/g, '[number]'],
  // Long opaque runs: session ids, keys, hashes; base64 with `+` and `/` from 40 characters.
  [/[A-Za-z0-9_-]{24,}/g, '[redacted]'],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]'],
];

/** A free-text field (error message, stack) without address values, tokens, credentials, emails or Steam ids, cut to `max`. */
export function sanitizeDiagnosticText(text: string, max: number = DIAGNOSTICS_LIMITS.maxTextLength): string {
  let out = withoutHiddenCharacters(text.slice(0, max * TEXT_INPUT_FACTOR));
  for (const [pattern, replacement] of TEXT_RULES)
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * The extension's own journal (QUICK-214 part 4, capability `diagnostics_journal`): what its background did while no
 * page may have been open (the scheduler's runs), kept in `storage.local` per account and handed to a page of the same
 * account with `take_diagnostics`, which files it in the account's journal.
 */
export const EXTENSION_JOURNAL_LIMITS = {
  /** Entries kept, all accounts together; the oldest go first. */
  maxEntries: 500,
  /** An entry older than this is dropped unread. */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Entries one `take_diagnostics` answer carries; the rest wait for the next one. */
  maxPerTake: 200,
} as const;

/** A scheduler event before the page adds the fields every event carries. */
export type SchedulerDiagnosticDraft = Omit<SchedulerDiagnostic, keyof DiagnosticEventCommon>;

/** One entry the extension hands to the page: when it happened (the extension's clock) and what. */
export interface ExtensionJournalEntry {
  at: number;
  event: SchedulerDiagnosticDraft;
}

/** A Clerk user id as the web app sends it with a rule or a `take_diagnostics` (`user_…`). */
export function isJournalOwner(value: unknown): value is string {
  return typeof value === 'string' && /^user_[A-Za-z0-9]{1,64}$/.test(value);
}

function journalCode(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value) && value.length <= max ? value : undefined;
}

/** The entries of an extension's `diagnostics` answer that have the shape of a scheduler run; the rest are dropped. */
export function parseExtensionJournalEntries(value: unknown): ExtensionJournalEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ExtensionJournalEntry[] = [];
  for (const item of value.slice(0, EXTENSION_JOURNAL_LIMITS.maxPerTake)) {
    if (!item || typeof item !== 'object') continue;
    const { at, event } = item as { at?: unknown; event?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at) || !event || typeof event !== 'object') continue;
    const raw = event as Record<string, unknown>;
    const platform =
      typeof raw['platform'] === 'string' && /^[a-z0-9][a-z0-9.-]{0,39}$/.test(raw['platform'])
        ? raw['platform']
        : undefined;
    const stage = raw['stage'] === 'check' || raw['stage'] === 'write' ? raw['stage'] : undefined;
    const outcome = (SCHEDULER_DIAGNOSTIC_OUTCOMES as readonly unknown[]).includes(raw['outcome'])
      ? (raw['outcome'] as SchedulerDiagnosticOutcome)
      : undefined;
    if (raw['kind'] !== 'scheduler' || !platform || !stage || !outcome) continue;
    const status = raw['status'];
    const paused = journalCode(raw['paused'], 40);
    const retired = journalCode(raw['retired'], 40);
    entries.push({
      at,
      event: {
        kind: 'scheduler',
        platform,
        stage,
        outcome,
        ...(typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 999 && { status }),
        ...(paused && { paused }),
        ...(retired && { retired }),
      },
    });
  }
  return entries;
}

/**
 * Error tracking (QUICK-240): the header a browser that refuses analytics (a stored opt-out, Do Not Track or Global
 * Privacy Control) sends with every request to our API; the server then reports none of that request's faults.
 */
export const NO_ANALYTICS_HEADER = 'x-qts-no-analytics';

/**
 * A quoted run on one line, up to 1000 characters (a `"` run may hold `\"` escapes); what code puts there is data.
 * Linear: a `"` right after a backslash never opens a run, so a scan that fails leaves no other opening quote of its
 * kind inside the stretch it read.
 */
const QUOTED_TEXT = /'[^'\n]{0,1000}'|(?<!\\)"(?:[^"\\\n]|\\.){0,1000}"|`[^`\n]{0,1000}`/g;
/** An innermost `{…}` or `[…]` group (a document, a body, a list of values), never the cleaner's own `[email]`-like marks. */
const INNERMOST_GROUP = /\{[^{}]*\}|\[(?!(?:email|jwt|steamid|number|redacted)\])[^[\]]*\]/g;
/** Nesting levels taken apart one by one; anything deeper is cut with the unclosed rest. */
const MAX_GROUP_DEPTH = 8;
/**
 * The value after a secret-named word and `:` or `=` (any spaces around it), up to the next space, commas included
 * (`password: hunter2`, `password:   foo,bar`). Linear: each `\s*` is followed by a character it cannot match.
 */
const SECRET_VALUE = /(password|passwd|secret|token|key|auth|session)(\s*[:=]\s*)[^\s]{1,4096}/gi;
/** What is left open: a group, a double quote or a backtick (a message cut short). */
const UNCLOSED = /[{"`]|\[(?!(?:email|jwt|steamid|number|redacted)\])/;

/**
 * An error message without the data it was given (QUICK-240): every quoted string and every `{…}` / `[…]` group
 * becomes `…`, so does the value after `password`, `passwd`, `secret`, `token`, `key`, `auth` or `session` and `:` or
 * `=` (any case), and from an unclosed group, double quote or backtick on, the rest goes too (an unclosed `'` is an
 * apostrophe). Linear in the text: no rule backtracks or rescans. Run before `sanitizeDiagnosticText`, which then
 * cleans what is left (tokens, emails, ids, query values) and cuts it.
 */
export function redactQuotedValues(text: string): string {
  let out = text.replace(QUOTED_TEXT, '…');
  for (let depth = 0; depth < MAX_GROUP_DEPTH; depth += 1) {
    const next = out.replace(INNERMOST_GROUP, '…');
    if (next === out) break;
    out = next;
  }
  out = out.replace(SECRET_VALUE, '$1$2…');
  const unclosed = out.search(UNCLOSED);
  return unclosed === -1 ? out : `${out.slice(0, unclosed)}…`;
}
