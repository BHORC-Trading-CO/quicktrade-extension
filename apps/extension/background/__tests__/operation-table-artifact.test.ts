import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BUNDLED_OPERATION_TABLE_VERSION, parseOperationTableDocument } from '@qts/contracts';
import { describe, expect, it } from 'vitest';

import { OPERATION_TABLE_PUBLIC_KEY } from '@/shared/operation-table-key';

import { readSignedEnvelope, verifySignedOperationTable } from '../operation-table-policy';

// The artifact the web serves (`npm run operations:sign`). When it exists, this build must accept it as a fresh
// install would: signed by the bundled key, valid, not expired, not below the bundled floor. The web suite checks
// that its table is exactly PLATFORM_OPERATIONS (operation-table-artifact.test.ts there).
const ARTIFACT = fileURLToPath(new URL('../../test-support/operation-table.json', import.meta.url));

function artifactDocument() {
  const envelope = readSignedEnvelope(JSON.parse(readFileSync(ARTIFACT, 'utf8')) as unknown);
  if (!envelope) throw new Error('test-support/operation-table.json is not a { document, signature } envelope');
  const parsed = parseOperationTableDocument(envelope.document);
  if (!parsed.ok) throw new Error(`the artifact's document is refused: ${parsed.refusal.reason} ${parsed.refusal.detail ?? ''}`);
  return { envelope, document: parsed.document };
}

describe('signed operation table artifact (signature)', () => {
  it.runIf(existsSync(ARTIFACT))('is accepted by this build with its bundled public key', async () => {
    expect(OPERATION_TABLE_PUBLIC_KEY, 'an artifact exists but operation-table-key.ts still holds the placeholder').not.toBeNull();
    const { envelope, document } = artifactDocument();
    const now = Date.now();
    // Fails on expiry by design: the artifact must be re-signed before it expires (DEPLOY.md, re-sign cadence).
    expect(
      document.expiresAt > now,
      `the signed operation table expired on ${new Date(document.expiresAt).toISOString()}: re-sign it (npm run operations:sign) and commit the artifact; extensions already fell back to the bundled table`
    ).toBe(true);
    const verdict = await verifySignedOperationTable(envelope, { publicKey: OPERATION_TABLE_PUBLIC_KEY, highestVersion: 0, acceptedDocument: null, now });
    expect(verdict.ok ? null : verdict.refusal).toBeNull();
  });

  // Signing never needs a release: only the reverse holds. A floor above the artifact would make this build refuse it.
  it.runIf(existsSync(ARTIFACT))('is not below BUNDLED_OPERATION_TABLE_VERSION', () => {
    const { document } = artifactDocument();
    expect(
      document.version,
      `the committed artifact is v${document.version}, below BUNDLED_OPERATION_TABLE_VERSION (${BUNDLED_OPERATION_TABLE_VERSION}): this build would refuse it; re-sign with a higher --version`
    ).toBeGreaterThanOrEqual(BUNDLED_OPERATION_TABLE_VERSION);
  });
});
