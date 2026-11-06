import fs from 'node:fs';
import path from 'node:path';

import { LOCALES } from '@qts/contracts';
import { describe, expect, it } from 'vitest';

// QUICK-189: the manifest name and description per browser language (public/_locales/<code>/messages.json). The
// extension has no page of its own since 1.6.0, so these are its only translated strings.

const EXTENSION_DIR = path.resolve(__dirname, '../..');
const CHROME_LOCALES_DIR = path.join(EXTENSION_DIR, 'public/_locales');

function sorted(values: Iterable<string>): string[] {
  return Array.from(values).toSorted();
}

describe('manifest name and description (_locales)', () => {
  const chromeCodes = LOCALES.map((locale) => locale.replace('-', '_'));

  it('exist for every locale, in the browser folder names', () => {
    expect(sorted(fs.readdirSync(CHROME_LOCALES_DIR))).toEqual(sorted(chromeCodes));
  });

  it.each(chromeCodes)('%s: the product name unchanged, a description within the store limit', (code) => {
    const messages = JSON.parse(fs.readFileSync(path.join(CHROME_LOCALES_DIR, code, 'messages.json'), 'utf8')) as Record<string, { message?: unknown }>;
    expect(Object.keys(messages).toSorted()).toEqual(['extDescription', 'extName']);
    expect(messages['extName']?.message).toBe('QuickTrade.skin');
    const description = messages['extDescription']?.message;
    expect(typeof description).toBe('string');
    // The Chrome Web Store refuses a description over 132 characters.
    expect(String(description).length).toBeLessThanOrEqual(132);
    // Brand and marketplace names are never translated (docs/i18n/GLOSSARY.md, section 1).
    for (const name of ['QuickTrade', 'CS2', 'CS.Money', 'CSFloat', 'Buff.163']) expect(description).toContain(name);
  });
});
