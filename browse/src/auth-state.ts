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

export function writeAuthStateFile(filePath: string, data: AuthStateFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function readAuthStateFile(filePath: string): AuthStateFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as AuthStateFile;
  if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
    throw new Error(`Invalid auth state format in ${filePath}`);
  }
  return parsed;
}
