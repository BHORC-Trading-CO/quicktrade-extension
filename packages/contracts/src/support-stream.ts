import {
  type AdminSupportMessage,
  SUPPORT_STATUSES,
  type SupportMessage,
  type SupportStatus,
  parseAdminSupportMessage,
  parseSupportMessage,
} from './support';

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Mutable state belongs to one connection. Pass it back with only the next decoded chunk. */
export interface SseParserState {
  rest: string;
  offset: number;
  lineStart: number;
  event: string;
  id?: string;
  data: string[];
  skipLf: boolean;
}

const newSseState = (): SseParserState => ({
  rest: '',
  offset: 0,
  lineStart: 0,
  event: 'message',
  data: [],
  skipLf: false,
});
export const MAX_SSE_BUFFER_LENGTH = 64 * 1024;

/** Call `parseSseChunk(decodedChunk, previous?.state)`; do not prepend `rest`.
 * The state retains at most 64 Ki characters of the incomplete block and scans each character once.
 * Comments/unknown fields are ignored; blank lines dispatch data. CR dispatches immediately, including
 * at a chunk boundary; its following LF is skipped. Overflow drops the pending block and remaining
 * chunk and emits `error` with `{reason:"sse_buffer_overflow"}`: the caller must reconnect/refetch REST.
 * No replay or event-id state is kept between blocks or connections.
 */
export function parseSseChunk(
  chunk: string,
  state: SseParserState = newSseState()
): { events: SseEvent[]; rest: string; state: SseParserState } {
  const events: SseEvent[] = [];
  const buffer = state.rest + chunk;
  let consumed = 0;
  for (let i = state.offset; i < buffer.length; i++) {
    if (i - consumed >= MAX_SSE_BUFFER_LENGTH) {
      Object.assign(state, newSseState(), { id: undefined });
      events.push({ event: 'error', data: '{"reason":"sse_buffer_overflow"}' });
      return { events, rest: '', state };
    }
    const code = buffer.charCodeAt(i);
    if (state.skipLf) {
      state.skipLf = false;
      if (code === 10) {
        state.lineStart = i + 1;
        if (consumed === i) consumed = i + 1;
        continue;
      }
    }
    if (code !== 10 && code !== 13) continue;
    state.skipLf = code === 13;
    const line = buffer.slice(state.lineStart, i);
    state.lineStart = i + 1;
    if (line === '') {
      if (state.data.length)
        events.push({
          event: state.event || 'message',
          data: state.data.join('\n'),
          ...(state.id === undefined ? {} : { id: state.id }),
        });
      consumed = i + 1;
      state.event = 'message';
      state.id = undefined;
      state.data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') state.event = value;
    if (field === 'data') state.data.push(value);
    if (field === 'id' && !value.includes('\0')) state.id = value;
  }
  state.rest = buffer.slice(consumed);
  state.offset = buffer.length - consumed;
  state.lineStart -= consumed;
  return { events, rest: state.rest, state };
}

type Event<TName extends string, TData> = { event: TName; data: TData };
type Side = 'user' | 'admin';
type Ticket = { ticketId: string };
type CommonEvent<TDate> =
  | Event<'hello', { serverTime: TDate; streamId: string }>
  | Event<'status', Ticket & { status: SupportStatus }>
  | Event<'replaced', { reason: 'replaced' }>
  | Event<'ended', { reason: 'expired' | 'shutdown' }>;
type MessageEvent<TMessage, TDate> = Event<
  'message',
  Ticket & {
    number: number;
    message: TMessage;
    status: SupportStatus;
    updatedAt: TDate;
  }
>;

export type UserSupportStreamEvent<TDate = string> =
  | CommonEvent<TDate>
  | Event<'typing', Ticket & { side: Side }>
  | MessageEvent<SupportMessage<TDate>, TDate>
  | Event<'read', Ticket & ({ side: 'user'; upToSeq: number } | { side: 'admin'; seen: boolean })>
  | Event<'presence', { supportOnline: boolean }>;
export type AdminSupportStreamEvent<TDate = string> =
  | CommonEvent<TDate>
  | Event<'typing', Ticket & ({ side: 'user' } | { side: 'admin'; adminClerkId: string })>
  | MessageEvent<AdminSupportMessage<TDate>, TDate>
  | Event<'read', Ticket & { side: Side; upToSeq: number }>
  | Event<'assign', Ticket & { assigneeClerkId: string | null }>
  | Event<'ticket', Ticket>
  | Event<'presence', { visibleAdminStreams: number }>;
export type SupportStreamEvent<TDate = string> = UserSupportStreamEvent<TDate> | AdminSupportStreamEvent<TDate>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const ticketId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{24}$/.test(value);
const iso = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const status = (value: unknown): value is SupportStatus => SUPPORT_STATUSES.some((item) => item === value);

/** Accepts a parsed SSE envelope (JSON data string) or {event, data: unknown}.
 * User parsing is the default; admins must opt in so internal payloads cannot cross audiences.
 * `hello` means refetch the displayed REST resources, including after reconnect.
 * `replaced` MUST stop automatic reconnect (including EOF/error backoff); resume only on user action/focus.
 * `ended` with `expired` or `shutdown` permits automatic reconnect with backoff. EOF without a terminal
 * frame also permits retry; each new connection uses fresh parser state and refetches on hello.
 */
export function parseSupportStreamEvent(value: unknown, audience?: 'user'): UserSupportStreamEvent | null;
export function parseSupportStreamEvent(value: unknown, audience: 'admin'): AdminSupportStreamEvent | null;
export function parseSupportStreamEvent(value: unknown, audience: Side = 'user'): SupportStreamEvent | null {
  if (!record(value)) return null;
  let data: unknown = value['data'];
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!record(data)) return null;
  const event = value['event'];
  if (event === 'hello') {
    return iso(data['serverTime']) &&
      typeof data['streamId'] === 'string' &&
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(data['streamId'])
      ? { event, data: { serverTime: data['serverTime'], streamId: data['streamId'] } }
      : null;
  }
  if (event === 'replaced') return data['reason'] === 'replaced' ? { event, data: { reason: 'replaced' } } : null;
  if (event === 'ended')
    return data['reason'] === 'expired' || data['reason'] === 'shutdown'
      ? { event, data: { reason: data['reason'] } }
      : null;
  if (event === 'presence') {
    if (audience === 'admin')
      return integer(data['visibleAdminStreams'], 0)
        ? { event, data: { visibleAdminStreams: data['visibleAdminStreams'] } }
        : null;
    return typeof data['supportOnline'] === 'boolean'
      ? { event, data: { supportOnline: data['supportOnline'] } }
      : null;
  }
  if (!ticketId(data['ticketId'])) return null;
  const ticket = { ticketId: data['ticketId'] };
  if (event === 'ticket') return audience === 'admin' ? { event, data: ticket } : null;
  if (event === 'assign')
    return audience === 'admin' &&
      (data['assigneeClerkId'] === null ||
        (typeof data['assigneeClerkId'] === 'string' && /^user_[A-Za-z0-9]{1,53}$/.test(data['assigneeClerkId'])))
      ? { event, data: { ...ticket, assigneeClerkId: data['assigneeClerkId'] } }
      : null;
  if (event === 'status') return status(data['status']) ? { event, data: { ...ticket, status: data['status'] } } : null;
  if (event === 'message') {
    const message =
      audience === 'admin' ? parseAdminSupportMessage(data['message']) : parseSupportMessage(data['message']);
    return message && integer(data['number'], 1) && status(data['status']) && iso(data['updatedAt'])
      ? {
          event,
          data: { ...ticket, number: data['number'], message, status: data['status'], updatedAt: data['updatedAt'] },
        }
      : null;
  }
  const side = data['side'];
  if (side !== 'user' && side !== 'admin') return null;
  if (event === 'typing') {
    if (audience === 'admin' && side === 'admin')
      return typeof data['adminClerkId'] === 'string' && /^user_[A-Za-z0-9]{1,53}$/.test(data['adminClerkId'])
        ? { event, data: { ...ticket, side, adminClerkId: data['adminClerkId'] } }
        : null;
    return { event, data: { ...ticket, side } };
  }
  if (event === 'read') {
    if (audience === 'user' && side === 'admin')
      return typeof data['seen'] === 'boolean' ? { event, data: { ...ticket, side, seen: data['seen'] } } : null;
    return integer(data['upToSeq'], 1, audience === 'admin' ? 300 : 100)
      ? { event, data: { ...ticket, side, upToSeq: data['upToSeq'] } }
      : null;
  }
  return null;
}
