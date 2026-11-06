import type { DiagnosticKind } from './diagnostics';

/** Support (QUICK-243). Plain text only; dates on the wire are canonical ISO strings. */
export const SUPPORT_LIMITS = {
  textMin: 1,
  createTextMin: 10,
  textMax: 2000,
  messagesPerTicket: 100,
  notesPerTicket: 200,
  duplicateTextMin: 20,
  openTickets: 3,
  ticketsPerHour: 3,
  ticketsPerDay: 10,
  messagesPerMinute: 10,
  messagesPerDay: 200,
  bannedOpenTickets: 1,
  bannedTicketsPerDay: 3,
  bannedMessagesPerDay: 50,
  globalTicketsPerDay: 500,
  duplicateWindowMs: 600_000,
  reopenWindowMs: 30 * 86_400_000,
  retentionMs: 180 * 86_400_000,
  userPageSize: 20,
  adminPageSize: 50,
  readRate: 60,
  writeRate: 20,
  casAttempts: 8,
} as const;

export const SUPPORT_CATEGORIES = ['problem', 'listing', 'inventory', 'billing', 'account', 'other'] as const;
export const SUPPORT_SOURCES = [
  'menu',
  'listing_failure',
  'inventory_partial',
  'banned',
  'plan_unconfirmed',
  'settings_steam',
  'billing',
] as const;
export const SUPPORT_STATUSES = ['open', 'waiting_user', 'closed'] as const;
export const SUPPORT_ERRORS = {
  disabled: 'support_disabled',
  notFound: 'support_ticket_not_found',
  streamNotFound: 'support_stream_not_found',
  closed: 'support_ticket_closed',
  full: 'support_ticket_full',
  tooManyOpen: 'support_too_many_open',
  rateLimited: 'support_rate_limited',
  busy: 'support_busy',
  ticketBusy: 'support_ticket_busy',
  invalidText: 'support_invalid_text',
  invalidAssignee: 'support_invalid_assignee',
  invalidCursor: 'support_invalid_cursor',
  invalidRead: 'support_invalid_read',
  unavailable: 'support_unavailable',
  attachmentType: 'support_attachment_type',
  attachmentTooLarge: 'support_attachment_too_large',
  attachmentNotFound: 'support_attachment_not_found',
  attachmentUsed: 'support_attachment_used',
  attachmentExpired: 'support_attachment_expired',
  attachmentCount: 'support_attachment_count',
  attachmentTicketLimit: 'support_attachment_ticket_limit',
  attachmentAccountLimit: 'support_attachment_account_limit',
} as const;
export type SupportErrorCode = (typeof SUPPORT_ERRORS)[keyof typeof SUPPORT_ERRORS];
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportSource = (typeof SUPPORT_SOURCES)[number];
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportAuthor = 'user' | 'admin' | 'system';

export interface SupportEntryContext {
  platform: string | null;
  operation: 'list' | 'edit' | 'remove' | 'read' | null;
  errorCode: string | null;
  ok: number | null;
  failed: number | null;
  unknown: number | null;
  items: number | null;
  pages: number | null;
  stop: 'end' | 'page_failed' | 'page_cap' | 'no_answer' | 'steam_mismatch' | null;
}
export interface SupportContext {
  page: string | null;
  tab: string | null;
  web: string | null;
  ext: string | null;
  browser: string | null;
  locale: string | null;
  entry: SupportEntryContext | null;
}
export interface SupportCreateTicket {
  category: SupportCategory;
  text: string;
  source: SupportSource;
  context?: Partial<SupportContext> | null;
  idempotencyKey: string;
  attachmentIds?: string[];
}
/** Read through a sequence from the fetched thread: visible numbering for users, full numbering for admins. */
export interface SupportRead {
  upToSeq: number;
}
/** Unaudited marker acknowledgement. Contains no ticket content or owner metadata. */
export interface AdminSupportReadResult<TDate = string> extends SupportRead {
  ticketId: string;
  adminReadAt: TDate | null;
}
export interface SupportReply {
  text: string;
  idempotencyKey: string;
  attachmentIds?: string[];
}
export interface AdminSupportReply extends Omit<SupportReply, 'attachmentIds'> {
  internal: boolean;
}
/**
 * Sanitization drops Exif orientation. Browser uploads re-encode through a canvas,
 * which applies orientation; only non-browser uploads can therefore appear rotated.
 * Pending uploads need at least 10 minutes of TTL left to attach; on
 * support_attachment_expired (409), upload again and use the new id.
 */
export interface SupportAttachment {
  id: string;
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  width: number;
  height: number;
}
export interface SupportMessage<TDate = string> {
  id: string;
  seq: number;
  author: SupportAuthor;
  text: string;
  at: TDate;
  /** New servers always send an array; optional for older REST/stream responses. */
  attachments?: SupportAttachment[];
}
export interface AdminSupportMessage<TDate = string> extends SupportMessage<TDate> {
  internal: boolean;
  adminClerkId: string | null;
}
export interface SupportTicketSummary<TDate = string> {
  id: string;
  number: number;
  status: SupportStatus;
  category: SupportCategory;
  source: SupportSource;
  createdAt: TDate;
  updatedAt: TDate;
  lastUserAt: TDate;
  lastAdminAt: TDate | null;
  userReadAt: TDate | null;
  closedAt: TDate | null;
  unread: boolean;
  /** An admin read marker covers the latest user message, matching the stream's admin-side `seen`. */
  seenBySupport: boolean;
  /** Visible messages only. Internal notes do not change the user response. */
  messageCount: number;
}
export interface SupportTicketDetail<TDate = string> extends SupportTicketSummary<TDate> {
  messages: SupportMessage<TDate>[];
}
export interface AdminSupportTicketSummary<TDate = string> extends Omit<SupportTicketSummary<TDate>, 'seenBySupport'> {
  clerkId: string;
  assigneeClerkId: string | null;
  adminReadAt: TDate | null;
  revision: number;
}
export interface AdminSupportTicketDetail<TDate = string> extends AdminSupportTicketSummary<TDate> {
  messages: AdminSupportMessage<TDate>[];
  context: SupportContext;
  user: { clerkId: string; banned: boolean };
}
export interface SupportTicketList<TDate = string> {
  tickets: SupportTicketSummary<TDate>[];
  nextCursor: string | null;
}
export interface AdminSupportTicketList<TDate = string> {
  tickets: AdminSupportTicketSummary<TDate>[];
  nextCursor: string | null;
}
export interface SupportUnread {
  tickets: number;
}
/** Admin-only assignment options from the configured ADMIN_CLERK_IDS allowlist. */
export interface AdminSupportAdmins {
  admins: { clerkId: string }[];
}

/** An already-cleaned journal row; internal source ids are never exposed on the wire. */
export interface SupportJournalEvent<TDate = string> {
  event: Record<string, unknown>;
  at: TDate;
  kind: DiagnosticKind;
  platform: string | null;
  problem: boolean;
}
export interface AdminSupportJournal<TDate = string> {
  /**
   * Newest first by at. Selection is capped at 1000: problems, matching ticket tab, then recency.
   * Late arrivals with an earlier at can replace previously copied events within that cap;
   * the stored event count never shrinks below its previous size.
   */
  events: SupportJournalEvent<TDate>[];
  /** total is the highest observed source-window count (at least copied), retained after source expiry. */
  counts: { total: number; copied: number };
  /** pending: copy running; partial: refresh failed, stored copy retained; failed: initial copy failed. */
  status: 'ok' | 'failed' | 'empty' | 'pending' | 'partial';
  /** Last successful copy/refresh; GET retries the original two-hour window at most once per 60 s until createdAt + journal retention. */
  refreshedAt: TDate | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some((item) => item === value);
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

// Each pass consumes disjoint tokens. Never search an unbounded suffix from every character of a long run.
const SECRET_KEY = /password|passwd|api[_-]?key|token|secret|session|cookie|authorization|credential/i;
// Include unterminated strings (even a trailing escape) so a failed match cannot restart at every escaped quote.
const JSON_STRING = /"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)/g;
const OPAQUE_OR_EMAIL = /[A-Za-z0-9_+/@.=-]+/g;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/;
const EMAIL = /^[A-Za-z0-9_.+=/-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Mask credentials, including escaped JSON values; deliberate emails and Steam ids remain readable. */
export function maskSupportSecrets(text: string): string {
  // Scan JSON strings once: a secret-like key followed by a colon masks its next string value.
  let pendingEnd: number | null = null;
  const jsonMasked = text.replace(JSON_STRING, (token: string, offset: number) => {
    if (pendingEnd !== null && /^\s*:\s*$/.test(text.slice(pendingEnd, offset))) {
      pendingEnd = null;
      return '"[REDACTED]"';
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(token);
    } catch {
      decoded = token;
    }
    pendingEnd = typeof decoded === 'string' && SECRET_KEY.test(decoded) ? offset + token.length : null;
    return token;
  });
  return jsonMasked
    .replace(/\b(Bearer|Basic)([ \t\n]+)[A-Za-z0-9_+/.=~-]+/gi, '$1$2[REDACTED]')
    .replace(OPAQUE_OR_EMAIL, (token: string) => {
      if (token.includes('@') && EMAIL.test(token)) return token;
      if (JWT.test(token)) return '[REDACTED]';
      // Dots separate ordinary words; opaque credentials include base64, base64url and hex.
      return token.replace(/[A-Za-z0-9_+/=-]{40,}/g, '[REDACTED]');
    });
}

const SUPPORT_CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Keep normalized lines and word separators; strip other controls before masking credentials. */
export function sanitizeSupportText(text: string): string {
  return maskSupportSecrets(text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(SUPPORT_CONTROLS, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function boundedText(value: unknown, max: number, pattern?: RegExp): string | null {
  if (typeof value !== 'string' || !value || value.length > max || sanitizeSupportText(value) !== value) return null;
  return !pattern || pattern.test(value) ? value : null;
}
/** Semver identifiers, bounded before parsing; numeric prerelease identifiers cannot have leading zeros. */
function semver(value: unknown): string | null {
  const text = boundedText(value, 20);
  if (!text) return null;
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([^+]+))?(?:\+(.+))?$/.exec(text);
  if (!parts) return null;
  const identifiers = (part: string, prerelease: boolean) =>
    part.split('.').every((item) => /^[A-Za-z0-9-]+$/.test(item) && (!prerelease || !/^0\d+$/.test(item)));
  if (parts[4] !== undefined && !identifiers(parts[4], true)) return null;
  if (parts[5] !== undefined && !identifiers(parts[5], false)) return null;
  return text;
}
/** BCP47 structure (including private-use tags); input length bounds all validation work. */
function localeTag(value: unknown): string | null {
  const text = boundedText(value, 10);
  if (!text) return null;
  if (/^x(?:-[A-Za-z0-9]{1,8})+$/i.test(text)) return text;
  // Legacy registered BCP47 tags that Intl's Unicode locale subset does not accept.
  const legacy = [
    'en-gb-oed',
    'i-ami',
    'i-bnn',
    'i-default',
    'i-enochian',
    'i-hak',
    'i-klingon',
    'i-lux',
    'i-mingo',
    'i-navajo',
    'i-pwn',
    'i-tao',
    'i-tay',
    'i-tsu',
    'no-bok',
    'no-nyn',
    'sgn-be-fr',
    'sgn-be-nl',
    'sgn-ch-de',
    'zh-guoyu',
    'zh-hakka',
    'zh-min',
    'zh-min-nan',
    'zh-xiang',
  ];
  if (legacy.includes(text.toLowerCase())) return text;
  try {
    Intl.getCanonicalLocales(text);
    return text;
  } catch {
    return null;
  }
}
/** Rebuild untrusted entry metadata; identifiers, money, URLs and unknown keys are never copied. */
export function sanitizeSupportContext(value: unknown): SupportContext {
  const data = record(value) ? value : {};
  const entry = record(data['entry']) ? data['entry'] : null;
  const error = entry ? boundedText(entry['errorCode'], 80) : null;
  return {
    page: typeof data['page'] === 'string' && /^\/[a-z0-9/-]{0,99}$/.test(data['page']) ? data['page'] : null,
    tab: typeof data['tab'] === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(data['tab']) ? data['tab'] : null,
    web: boundedText(data['web'], 40),
    ext: semver(data['ext']),
    browser: boundedText(data['browser'], 40),
    locale: localeTag(data['locale']),
    entry: entry
      ? {
          platform: boundedText(entry['platform'], 40),
          operation: member(entry['operation'], ['list', 'edit', 'remove', 'read']) ? entry['operation'] : null,
          errorCode: error && !/@|\d{9}|[A-Za-z0-9_+/=-]{24}/.test(error) ? error : null,
          ok: integer(entry['ok'], 0, 100000) ? entry['ok'] : null,
          failed: integer(entry['failed'], 0, 100000) ? entry['failed'] : null,
          unknown: integer(entry['unknown'], 0, 100000) ? entry['unknown'] : null,
          items: integer(entry['items'], 0, 100000) ? entry['items'] : null,
          pages: integer(entry['pages'], 0, 100000) ? entry['pages'] : null,
          stop: member(entry['stop'], ['end', 'page_failed', 'page_cap', 'no_answer', 'steam_mismatch'])
            ? entry['stop']
            : null,
        }
      : null,
  };
}

function iso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function nullableIso(value: unknown): value is string | null {
  return value === null || iso(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{24}$/.test(value);
}
function clerkId(value: unknown): value is string {
  return typeof value === 'string' && /^user_[A-Za-z0-9]{1,53}$/.test(value);
}

export function parseSupportTicketSummary(value: unknown): SupportTicketSummary | null {
  const base = ticketSummary(value, SUPPORT_LIMITS.messagesPerTicket);
  if (!base || !record(value) || (value['seenBySupport'] !== undefined && typeof value['seenBySupport'] !== 'boolean'))
    return null;
  return { ...base, seenBySupport: value['seenBySupport'] === true };
}
function ticketSummary(value: unknown, limit: number): Omit<SupportTicketSummary, 'seenBySupport'> | null {
  if (
    !record(value) ||
    !id(value['id']) ||
    !integer(value['number'], 1) ||
    !member(value['status'], SUPPORT_STATUSES) ||
    !member(value['category'], SUPPORT_CATEGORIES) ||
    !member(value['source'], SUPPORT_SOURCES) ||
    !iso(value['createdAt']) ||
    !iso(value['updatedAt']) ||
    !iso(value['lastUserAt']) ||
    !nullableIso(value['lastAdminAt']) ||
    !nullableIso(value['userReadAt']) ||
    !nullableIso(value['closedAt']) ||
    typeof value['unread'] !== 'boolean' ||
    !integer(value['messageCount'], 1, limit)
  )
    return null;
  if ((value['status'] === 'closed') !== (value['closedAt'] !== null)) return null;
  return {
    id: value['id'],
    number: value['number'],
    status: value['status'],
    category: value['category'],
    source: value['source'],
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
    lastUserAt: value['lastUserAt'],
    lastAdminAt: value['lastAdminAt'],
    userReadAt: value['userReadAt'],
    closedAt: value['closedAt'],
    unread: value['unread'],
    messageCount: value['messageCount'],
  };
}
export function parseAdminSupportTicketSummary(value: unknown): AdminSupportTicketSummary | null {
  const base = ticketSummary(value, SUPPORT_LIMITS.messagesPerTicket + SUPPORT_LIMITS.notesPerTicket);
  if (
    !base ||
    !record(value) ||
    !clerkId(value['clerkId']) ||
    !(value['assigneeClerkId'] === null || clerkId(value['assigneeClerkId'])) ||
    !nullableIso(value['adminReadAt']) ||
    !integer(value['revision'], 1)
  )
    return null;
  return {
    ...base,
    clerkId: value['clerkId'],
    assigneeClerkId: value['assigneeClerkId'],
    adminReadAt: value['adminReadAt'],
    revision: value['revision'],
  };
}
export function parseSupportMessage(value: unknown): SupportMessage | null {
  return parseMessage(value, SUPPORT_LIMITS.messagesPerTicket);
}
export function parseSupportAttachment(value: unknown): SupportAttachment | null {
  if (
    !record(value) ||
    !id(value['id']) ||
    !member(value['type'], ['image/png', 'image/jpeg', 'image/webp']) ||
    !integer(value['bytes'], 1, 5 * 1024 * 1024) ||
    !integer(value['width'], 1, 4096) ||
    !integer(value['height'], 1, 4096)
  )
    return null;
  return {
    id: value['id'],
    type: value['type'],
    bytes: value['bytes'],
    width: value['width'],
    height: value['height'],
  };
}
function parseMessage(value: unknown, limit: number): SupportMessage | null {
  if (
    !record(value) ||
    value['internal'] === true ||
    !id(value['id']) ||
    !integer(value['seq'], 1, limit) ||
    !member(value['author'], ['user', 'admin', 'system']) ||
    !iso(value['at']) ||
    typeof value['text'] !== 'string' ||
    value['text'].length < 1 ||
    value['text'].length > SUPPORT_LIMITS.textMax
  )
    return null;
  const attachments: SupportAttachment[] = [];
  if (value['attachments'] !== undefined) {
    if (!Array.isArray(value['attachments']) || value['attachments'].length > 3) return null;
    for (const raw of value['attachments']) {
      const item = parseSupportAttachment(raw);
      if (!item || attachments.some((previous) => previous.id === item.id)) return null;
      attachments.push(item);
    }
  }
  return {
    id: value['id'],
    seq: value['seq'],
    author: value['author'],
    text: value['text'],
    at: value['at'],
    ...(value['attachments'] === undefined ? {} : { attachments }),
  };
}
export function parseAdminSupportMessage(value: unknown): AdminSupportMessage | null {
  if (
    !record(value) ||
    typeof value['internal'] !== 'boolean' ||
    !(value['adminClerkId'] === null || clerkId(value['adminClerkId']))
  )
    return null;
  const base = parseMessage(
    { ...value, internal: false },
    SUPPORT_LIMITS.messagesPerTicket + SUPPORT_LIMITS.notesPerTicket
  );
  if (
    !base ||
    (base.author === 'admin') !== (value['adminClerkId'] !== null) ||
    (value['internal'] && base.author !== 'admin')
  )
    return null;
  return { ...base, internal: value['internal'], adminClerkId: value['adminClerkId'] };
}
function messages<T extends SupportMessage>(
  value: unknown,
  parse: (value: unknown) => T | null,
  limit: number = SUPPORT_LIMITS.messagesPerTicket
): T[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit) return null;
  const result: T[] = [];
  for (const row of value) {
    const parsed = parse(row);
    if (!parsed || parsed.seq <= (result[result.length - 1]?.seq ?? 0)) return null;
    result.push(parsed);
  }
  return result;
}
export function parseSupportTicketDetail(value: unknown): SupportTicketDetail | null {
  const base = parseSupportTicketSummary(value);
  const thread = record(value) ? messages(value['messages'], parseSupportMessage) : null;
  return base && thread && base.messageCount === thread.length ? { ...base, messages: thread } : null;
}
export function parseAdminSupportTicketDetail(value: unknown): AdminSupportTicketDetail | null {
  const base = parseAdminSupportTicketSummary(value);
  if (
    !base ||
    !record(value) ||
    !record(value['context']) ||
    !record(value['user']) ||
    value['user']['clerkId'] !== base.clerkId ||
    typeof value['user']['banned'] !== 'boolean'
  )
    return null;
  const thread = messages(
    value['messages'],
    parseAdminSupportMessage,
    SUPPORT_LIMITS.messagesPerTicket + SUPPORT_LIMITS.notesPerTicket
  );
  return thread && base.messageCount === thread.length
    ? {
        ...base,
        messages: thread,
        context: sanitizeSupportContext(value['context']),
        user: { clerkId: base.clerkId, banned: value['user']['banned'] },
      }
    : null;
}
function list<T>(
  value: unknown,
  parse: (value: unknown) => T | null,
  limit: number
): { tickets: T[]; nextCursor: string | null } | null {
  if (
    !record(value) ||
    !Array.isArray(value['tickets']) ||
    value['tickets'].length > limit ||
    !(value['nextCursor'] === null || (typeof value['nextCursor'] === 'string' && value['nextCursor'].length <= 200))
  )
    return null;
  const tickets: T[] = [];
  for (const row of value['tickets']) {
    const ticket = parse(row);
    if (!ticket) return null;
    tickets.push(ticket);
  }
  return { tickets, nextCursor: value['nextCursor'] };
}
export function parseSupportTicketList(value: unknown): SupportTicketList | null {
  return list(value, parseSupportTicketSummary, SUPPORT_LIMITS.userPageSize);
}
export function parseAdminSupportTicketList(value: unknown): AdminSupportTicketList | null {
  return list(value, parseAdminSupportTicketSummary, SUPPORT_LIMITS.adminPageSize);
}
export function parseSupportUnread(value: unknown): SupportUnread | null {
  return record(value) && integer(value['tickets']) ? { tickets: value['tickets'] } : null;
}
export function parseAdminSupportAdmins(value: unknown): AdminSupportAdmins | null {
  if (!record(value) || !Array.isArray(value['admins'])) return null;
  const admins: AdminSupportAdmins['admins'] = [];
  for (const row of value['admins']) {
    if (!record(row) || !clerkId(row['clerkId'])) return null;
    admins.push({ clerkId: row['clerkId'] });
  }
  return { admins };
}
