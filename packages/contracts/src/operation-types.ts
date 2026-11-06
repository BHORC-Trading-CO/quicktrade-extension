/**
 * Declarative description of one marketplace request the extension may execute (QUICK-171).
 *
 * The table of these (`PLATFORM_OPERATIONS`) is bundled into the extension: the page cannot widen it at
 * runtime, only narrow it (a catalog entry's `operations`). Everything here is data; the matcher in
 * `operation-policy.ts` is the only interpreter.
 */

export type OperationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `none`: no body. `json`: a JSON object or array. `form`: an `application/x-www-form-urlencoded` string. */
export type OperationBodyKind = 'none' | 'json' | 'form';

/**
 * Who may run an operation:
 *  - `page`: a `proxy_request` from the web app (every non-internal operation);
 *  - `login`: a catalog login probe (non-mutating operations only);
 *  - `schedule-check` / `schedule-write`: the scheduler without a tab, only for operations marked `schedule`;
 *  - `internal`: the background itself (auth token refresh), never the page.
 */
export type OperationPurpose = 'page' | 'login' | 'schedule-check' | 'schedule-write' | 'internal';

/** A GraphQL endpoint serves many operations on one URL: the body must hold exactly this one. */
export interface OperationGraphql {
  type: 'query' | 'mutation';
  /** `operationName` and the name of the document's only operation. */
  name: string;
  /** Root fields the operation may select (aliases resolved). Root fragment spreads are refused. */
  fields: readonly string[];
}

/**
 * Auth header the background derives from a marketplace cookie. The cookie value never reaches the page:
 * the page sends the request without the header, and a page-supplied header of that name is refused.
 */
export interface OperationAuth {
  /** Origin the cookie belongs to (may differ from the API host, e.g. dmarket.com for api.dmarket.com). */
  cookieUrl: string;
  cookie: string;
  header: string;
  /** `bearer` sends `Bearer <token>`, `raw` the token itself. */
  format: 'bearer' | 'raw';
  /** The token is this field of a URL-encoded JSON cookie value (aim.market `__user-store`). */
  jsonField?: string;
  /**
   * A short-lived token is minted by this internal operation (white.market `auth_token`) when the cookie is
   * missing or the request answers 401; the token is read at `tokenPath` of its JSON response.
   */
  refresh?: {
    operation: string;
    body: string;
    headers: Readonly<Record<string, string>>;
    tokenPath: readonly string[];
  };
}

export interface PlatformOperation {
  /** Stable id, e.g. `csfloat.listing.edit`. A catalog entry's `operations` narrows by these ids. */
  id: string;
  method: OperationMethod;
  /** Exact host (no subdomain wildcard, https and the default port only). */
  host: string;
  /**
   * Anchored path pattern. Literal segments match exactly; `{name:type}` matches one segment of a type:
   * `int` (digits), `id` (letters, digits, `_`, `-`). A trailing slash is significant.
   */
  path: string;
  /** Allowed query keys (any subset, values unchecked). Omitted = no query string at all. */
  query?: readonly string[];
  body: OperationBodyKind;
  /** Allowed request header names, lower case. Omitted = no headers. */
  headers?: readonly string[];
  /** Changes state on the marketplace (list, edit, remove, …). */
  mutates: boolean;
  /** The scheduler may run it without a tab: `check` (read) or `write` (mutating). */
  schedule?: 'check' | 'write';
  graphql?: OperationGraphql;
  auth?: OperationAuth;
  /** Always sent without cookies (DMarket answers 504 when its session cookie rides along). */
  credentials?: 'omit';
  /**
   * Path patterns on the same host a server redirect may end on (e.g. Steam `/my/` → `/id/<vanity>/`).
   * Any other redirect target is refused and its body is not returned. Followed only for a GET read without `auth`
   * (`followsOperationRedirects`, QUICK-292); any other operation's 3xx is never followed.
   */
  redirects?: readonly string[];
  /** Run only by the background (auth refresh); never matched for page, login or scheduled requests. */
  internal?: boolean;
}

/**
 * Operations per platform id: the bundled `PLATFORM_OPERATIONS`, or the extension's effective table (the bundled
 * one with the platforms of an accepted signed table replaced, `operation-table-document.ts`).
 */
export type OperationTable = Readonly<Record<string, readonly PlatformOperation[]>>;

export type OperationRefusalReason =
  | 'unknown_platform'
  | 'invalid_url'
  | 'host'
  | 'method'
  | 'path'
  | 'query'
  | 'header'
  | 'body'
  | 'graphql'
  | 'purpose'
  | 'narrowed'
  | 'redirect'
  | 'auth_unavailable';

/** Why a request was refused. `detail` names a query key, header or operation id — never a value. */
export interface OperationRefusal {
  reason: OperationRefusalReason;
  detail?: string;
}

/** The request fields the matcher reads (a `PlatformRequest` / `HttpRequest`). */
export interface OperationRequest {
  url: string;
  method: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export type OperationMatch = { ok: true; operation: PlatformOperation } | { ok: false; refusal: OperationRefusal };
