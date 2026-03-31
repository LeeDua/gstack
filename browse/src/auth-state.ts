import * as fs from 'fs';
import * as path from 'path';

export interface AuthStateFile {
  version: number;
  updatedAt: string;
  sourceUrl: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

function cookieKey(cookie: AuthStateFile['cookies'][number]): string {
  const domain = (cookie.domain || '').toLowerCase();
  const pathValue = cookie.path || '/';
  return `${domain}|${pathValue}|${cookie.name}`;
}

function mergeCookies(
  existing: AuthStateFile['cookies'],
  incoming: AuthStateFile['cookies'],
): AuthStateFile['cookies'] {
  const merged = new Map<string, AuthStateFile['cookies'][number]>();

  for (const cookie of existing) {
    merged.set(cookieKey(cookie), cookie);
  }

  for (const cookie of incoming) {
    merged.set(cookieKey(cookie), cookie);
  }

  return [...merged.values()];
}

function mergeOrigins(
  existing: AuthStateFile['origins'],
  incoming: AuthStateFile['origins'],
): AuthStateFile['origins'] {
  const originMap = new Map<string, Map<string, string>>();

  for (const entry of existing) {
    if (!entry?.origin) continue;
    const kv = originMap.get(entry.origin) || new Map<string, string>();
    for (const item of entry.localStorage || []) {
      kv.set(item.name, item.value);
    }
    originMap.set(entry.origin, kv);
  }

  for (const entry of incoming) {
    if (!entry?.origin) continue;
    const kv = originMap.get(entry.origin) || new Map<string, string>();
    for (const item of entry.localStorage || []) {
      kv.set(item.name, item.value);
    }
    originMap.set(entry.origin, kv);
  }

  return [...originMap.entries()].map(([origin, kv]) => ({
    origin,
    localStorage: [...kv.entries()].map(([name, value]) => ({ name, value })),
  }));
}

export function mergeAuthState(
  existing: AuthStateFile,
  incoming: AuthStateFile,
): AuthStateFile {
  return {
    version: 1,
    updatedAt: incoming.updatedAt,
    sourceUrl: incoming.sourceUrl,
    cookies: mergeCookies(existing.cookies || [], incoming.cookies || []),
    origins: mergeOrigins(existing.origins || [], incoming.origins || []),
  };
}

export function writeAuthStateFile(filePath: string, data: AuthStateFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let next = data;
  try {
    if (fs.existsSync(filePath)) {
      next = mergeAuthState(readAuthStateFile(filePath), data);
    }
  } catch {
    next = data;
  }

  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpFile, filePath);

  // Ensure restrictive permissions even when replacing an existing file.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

export function readAuthStateFile(filePath: string): AuthStateFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as AuthStateFile;
  if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
    throw new Error(`Invalid auth state format in ${filePath}`);
  }
  return parsed;
}
