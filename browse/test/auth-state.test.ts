import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import {
  mergeAuthState,
  readAuthStateFile,
  writeAuthStateFile,
  type AuthStateFile,
} from '../src/auth-state';

function sampleState(overrides: Partial<AuthStateFile> = {}): AuthStateFile {
  return {
    version: 1,
    updatedAt: '2026-03-31T00:00:00.000Z',
    sourceUrl: 'https://security-webshell.byted.org/common/v2',
    cookies: [],
    origins: [],
    ...overrides,
  };
}

describe('auth-state', () => {
  test('mergeAuthState keeps old entries and overrides matching cookie keys', () => {
    const existing = sampleState({
      updatedAt: '2026-03-31T00:00:00.000Z',
      sourceUrl: 'https://old',
      cookies: [
        { name: 'sessionid', value: 'old', domain: 'sso.bytedance.com', path: '/' },
        { name: 'legacy', value: '1', domain: 'security-webshell.byted.org', path: '/' },
      ],
      origins: [
        {
          origin: 'https://security-webshell.byted.org',
          localStorage: [{ name: 'old_key', value: 'old_value' }],
        },
      ],
    });

    const incoming = sampleState({
      updatedAt: '2026-03-31T00:10:00.000Z',
      sourceUrl: 'https://new',
      cookies: [
        { name: 'sessionid', value: 'new', domain: 'sso.bytedance.com', path: '/' },
        { name: 'fresh', value: '2', domain: 'security-webshell.byted.org', path: '/' },
      ],
      origins: [
        {
          origin: 'https://security-webshell.byted.org',
          localStorage: [{ name: 'new_key', value: 'new_value' }],
        },
      ],
    });

    const merged = mergeAuthState(existing, incoming);
    expect(merged.updatedAt).toBe('2026-03-31T00:10:00.000Z');
    expect(merged.sourceUrl).toBe('https://new');
    expect(merged.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sessionid', value: 'new', domain: 'sso.bytedance.com' }),
        expect.objectContaining({ name: 'legacy', value: '1' }),
        expect.objectContaining({ name: 'fresh', value: '2' }),
      ])
    );

    const origin = merged.origins.find((o) => o.origin === 'https://security-webshell.byted.org');
    expect(origin).toBeDefined();
    expect(origin?.localStorage).toEqual(
      expect.arrayContaining([
        { name: 'old_key', value: 'old_value' },
        { name: 'new_key', value: 'new_value' },
      ])
    );
  });

  test('writeAuthStateFile merges with existing file and enforces 0600 perms', () => {
    const p = `/tmp/browse-auth-state-merge-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;

    const first = sampleState({
      cookies: [{ name: 'sessionid', value: 'old', domain: 'sso.bytedance.com', path: '/' }],
    });

    const second = sampleState({
      updatedAt: '2026-03-31T00:20:00.000Z',
      cookies: [{ name: 'fresh', value: '1', domain: 'security-webshell.byted.org', path: '/' }],
      origins: [{ origin: 'https://security-webshell.byted.org', localStorage: [{ name: 'k', value: 'v' }] }],
    });

    writeAuthStateFile(p, first);
    fs.chmodSync(p, 0o644);
    writeAuthStateFile(p, second);

    const saved = readAuthStateFile(p);
    expect(saved.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sessionid', value: 'old' }),
        expect.objectContaining({ name: 'fresh', value: '1' }),
      ])
    );
    expect(saved.origins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: 'https://security-webshell.byted.org' }),
      ])
    );

    const mode = fs.statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);

    fs.unlinkSync(p);
  });
});
