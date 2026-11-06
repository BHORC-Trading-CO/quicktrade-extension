/** QUICK-252. All endpoints require a Clerk admin session; the MFA cookie is not required here. */
export interface AdminMfaStatusResponse {
  enabled: boolean;
  verified: boolean;
  backupCodesLeft: number;
  required: boolean;
  sessionExpiresAt: string | null;
}
export interface AdminMfaSetupResponse {
  otpauthUri: string;
}
export interface AdminMfaBackupCodesResponse {
  backupCodes: string[];
}
export interface AdminMfaSuccessResponse {
  ok: true;
}
export interface AdminMfaCodeRequest {
  code: string;
}
export type AdminMfaVerifyRequest = { code: string; backupCode?: never } | { backupCode: string; code?: never };
export const ADMIN_MFA_ERROR_CODES = [
  'admin_mfa_unavailable',
  'admin_mfa_required',
  'admin_mfa_enabled',
  'admin_mfa_not_enabled',
  'admin_mfa_setup_expired',
  'admin_mfa_invalid_code',
  'admin_mfa_locked',
  'admin_mfa_session_required',
  'admin_mfa_busy',
] as const;
export type AdminMfaErrorCode = (typeof ADMIN_MFA_ERROR_CODES)[number];
export interface AdminMfaError {
  code: AdminMfaErrorCode;
  retryAfter?: number;
  attemptsLeft?: number;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseAdminMfaStatus(value: unknown): AdminMfaStatusResponse | null {
  if (
    !record(value) ||
    typeof value['enabled'] !== 'boolean' ||
    typeof value['verified'] !== 'boolean' ||
    typeof value['backupCodesLeft'] !== 'number' ||
    !Number.isInteger(value['backupCodesLeft']) ||
    value['backupCodesLeft'] < 0 ||
    value['backupCodesLeft'] > 10 ||
    (value['required'] !== undefined && typeof value['required'] !== 'boolean')
  )
    return null;
  const sessionExpiresAt = value['sessionExpiresAt'] ?? null;
  if (
    sessionExpiresAt !== null &&
    (typeof sessionExpiresAt !== 'string' || !Number.isFinite(Date.parse(sessionExpiresAt)))
  )
    return null;
  return {
    enabled: value['enabled'],
    verified: value['verified'],
    backupCodesLeft: value['backupCodesLeft'],
    required: value['required'] ?? false,
    sessionExpiresAt,
  };
}
export function parseAdminMfaSetup(value: unknown): AdminMfaSetupResponse | null {
  return record(value) && typeof value['otpauthUri'] === 'string' && value['otpauthUri'].startsWith('otpauth://totp/')
    ? { otpauthUri: value['otpauthUri'] }
    : null;
}
export function parseAdminMfaBackupCodes(value: unknown): AdminMfaBackupCodesResponse | null {
  if (!record(value)) return null;
  const codes = value['backupCodes'];
  if (
    !Array.isArray(codes) ||
    codes.length !== 10 ||
    !codes.every(
      (code): code is string => typeof code === 'string' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)
    ) ||
    new Set(codes).size !== 10
  )
    return null;
  return { backupCodes: [...codes] };
}
export function parseAdminMfaSuccess(value: unknown): AdminMfaSuccessResponse | null {
  return record(value) && value['ok'] === true ? { ok: true } : null;
}
export function parseAdminMfaError(value: unknown): AdminMfaError | null {
  if (!record(value)) return null;
  const code = ADMIN_MFA_ERROR_CODES.find((candidate) => candidate === value['message']);
  if (!code) return null;
  if (code === 'admin_mfa_locked') {
    const retryAfter = value['retryAfter'];
    return typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0
      ? { code, retryAfter }
      : null;
  }
  if (code === 'admin_mfa_invalid_code' && value['details'] !== undefined) {
    const details = value['details'];
    if (!record(details)) return null;
    const attemptsLeft = details['attemptsLeft'];
    return typeof attemptsLeft === 'number' &&
      Number.isSafeInteger(attemptsLeft) &&
      attemptsLeft >= 0 &&
      attemptsLeft <= 5
      ? { code, attemptsLeft }
      : null;
  }
  return { code };
}
