// apps/extension/background/operation-table-policy.ts
//
// Acceptance of a signed operation table: signature over the exact bytes with the bundled public key, then the
// strict document check of @qts/contracts (shape and the limits a signature cannot override), expiry and the
// anti-rollback floor. Pure apart from WebCrypto (`crypto.subtle`, Chrome 101+ and Firefox); never throws.
import type { OperationTableDocument, OperationTableRefusal, SignedOperationTable } from '@qts/contracts';
import { BUNDLED_OPERATION_TABLE_VERSION, OPERATION_TABLE_CLOCK_SKEW_MS, OPERATION_TABLE_LIMITS, parseOperationTableDocument } from '@qts/contracts';

import type { OperationTablePublicKey } from '@/shared/operation-table-key';

/** 64 bytes (IEEE P1363 `r || s` of P-256) in standard base64. */
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const BASE64URL_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

export interface OperationTableAcceptance {
  /** The bundled key; null (placeholder) disables signed tables. */
  publicKey: OperationTablePublicKey | null;
  /** The highest version this extension accepted so far (0 when none); only ever rises. */
  highestVersion: number;
  /** The exact document currently accepted, if any: the same version is accepted again only with these bytes. */
  acceptedDocument: string | null;
  now: number;
}

export type OperationTableVerdict = { ok: true; envelope: SignedOperationTable; document: OperationTableDocument; unchanged: boolean } | { ok: false; refusal: OperationTableRefusal };

function refuse(reason: OperationTableRefusal['reason'], detail?: string): OperationTableVerdict {
  return { ok: false, refusal: detail === undefined ? { reason } : { reason, detail } };
}

/** Exactly `{ document, signature }` strings; anything else is malformed. */
export function readSignedEnvelope(value: unknown): SignedOperationTable | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('document') || !keys.includes('signature')) return null;
  const { document, signature } = value as Record<string, unknown>;
  return typeof document === 'string' && typeof signature === 'string' ? { document, signature } : null;
}

/** A usable P-256 public JWK: a pasted private key (`d`) or a malformed coordinate disables signed tables. */
export function isUsablePublicKey(key: OperationTablePublicKey | null): key is OperationTablePublicKey {
  if (!key || typeof key !== 'object' || 'd' in key) return false;
  return key.kty === 'EC' && key.crv === 'P-256' && BASE64URL_COORDINATE.test(key.x) && BASE64URL_COORDINATE.test(key.y);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** ECDSA P-256 / SHA-256 over the UTF-8 bytes of `document`, exactly as received. */
export async function verifyOperationTableSignature(envelope: SignedOperationTable, publicKey: OperationTablePublicKey): Promise<boolean> {
  if (!SIGNATURE_BASE64.test(envelope.signature)) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const bytes = new TextEncoder().encode(envelope.document);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64(envelope.signature), bytes);
  } catch {
    return false;
  }
}

/**
 * The verdict on a signed table delivered by the page or read back from storage. Order: key configured, envelope
 * shape and size, signature over the exact bytes, parse + strict document check (incl. the maximum lifetime), expiry,
 * issue time not ahead of the clock (beyond the skew), version floor.
 */
export async function verifySignedOperationTable(value: unknown, options: OperationTableAcceptance): Promise<OperationTableVerdict> {
  if (!isUsablePublicKey(options.publicKey)) return refuse('disabled');
  const envelope = readSignedEnvelope(value);
  if (!envelope) return refuse('malformed');
  if (envelope.document.length > OPERATION_TABLE_LIMITS.documentLength) return refuse('too_large');
  if (!SIGNATURE_BASE64.test(envelope.signature)) return refuse('malformed', 'signature');
  if (!(await verifyOperationTableSignature(envelope, options.publicKey))) return refuse('signature');
  const parsed = parseOperationTableDocument(envelope.document);
  if (!parsed.ok) return { ok: false, refusal: parsed.refusal };
  const { document } = parsed;
  if (document.expiresAt <= options.now) return refuse('expired');
  // A document dated ahead of the clock would outlive the maximum lifetime the document check enforces.
  if (document.issuedAt > options.now + OPERATION_TABLE_CLOCK_SKEW_MS) return refuse('not_yet_valid');
  if (document.version < BUNDLED_OPERATION_TABLE_VERSION || document.version < options.highestVersion) return refuse('rollback');
  if (document.version === options.highestVersion) {
    if (envelope.document !== options.acceptedDocument) return refuse('version_conflict');
    return { ok: true, envelope, document, unchanged: true };
  }
  return { ok: true, envelope, document, unchanged: false };
}
