// apps/extension/shared/operation-table-key.ts
//
// The public half of the key that signs operation tables (ECDSA P-256, as a JWK). The private half never enters
// the repository: `npm run operations:generate-key -- <path outside the repo>` writes it there and prints the
// public key to paste below. See DEPLOY.md, "Updating marketplace operations without an extension release".

/** An ECDSA P-256 public key in JWK form (base64url coordinates, no private `d`). */
export interface OperationTablePublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/**
 * The operator's signing key (generated 2026-10-26). Set to null to switch signed tables off: the extension then
 * accepts none, does not announce `signed_operation_table`, and executes only the bundled `PLATFORM_OPERATIONS`.
 */
export const OPERATION_TABLE_PUBLIC_KEY: OperationTablePublicKey | null = {
  kty: 'EC',
  crv: 'P-256',
  x: 'fAJaTn9ou-AaPItJBvFUhk31SzqzS-_q1xgQJ8uNJxA',
  y: 'bmMXSCtmUcvlxL9RjAlOLqXj8kx_AQn0PDfjqONiKMA',
};
