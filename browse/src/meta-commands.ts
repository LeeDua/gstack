/**
 * Meta commands — tabs, server control, screenshots, chain, diff, snapshot
 */

import type { BrowserManager } from './browser-manager';
import { handleSnapshot } from './snapshot';
import { getCleanText } from './read-commands';
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from './commands';
import { validateNavigationUrl } from './url-validation';
import * as Diff from 'diff';
import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig } from './config';
import {
  webshellUsage,
  listWebshellRuns,
  startWebshellRun,
  preflightWebshellRun,
  getWebshellRunStatus,
  setWebshellRunConfig,
  executeWebshellRunCommand,
  finishWebshellRun,
} from './webshell-runtime';
import { readAuthStateFile, writeAuthStateFile } from './auth-state';
import { TEMP_DIR, isPathWithin } from './platform';

const BROWSE_CONFIG = resolveConfig();

// Security: Path validation to prevent path traversal attacks
const SAFE_DIRECTORIES = [TEMP_DIR, process.cwd()];

export function validateOutputPath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(resolved, dir));
  if (!isSafe) {
    throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
  }
}

interface BrowseSessionInfo {
  name: string;
  stateFile: string;
  active: boolean;
  current: boolean;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getSessionRootsFromEnv(): string[] {
  const roots: string[] = [];
  let hasExplicitRoot = false;

  if (process.env.BROWSE_STATE_ROOT) {
    roots.push(process.env.BROWSE_STATE_ROOT);
    hasExplicitRoot = true;
  }

  if (process.env.BROWSE_STATE_FILE) {
    // Typical structure: <root>/<session>/browse.json
    roots.push(path.dirname(path.dirname(process.env.BROWSE_STATE_FILE)));
    hasExplicitRoot = true;
  }

  if (!hasExplicitRoot) {
    const tmpRoot = process.env.TMPDIR || '/tmp';
    roots.push(path.join(tmpRoot, 'gstack-browse-sessions'));
  }

  return [...new Set(roots.map(r => path.resolve(r)))];
}

function readSessionInfoFromStateFile(
  stateFile: string,
  currentStateFile: string | undefined
): BrowseSessionInfo {
  const name = path.basename(path.dirname(stateFile));
  let active = false;

  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === 'number') {
      active = isProcessAlive(parsed.pid);
    }
  } catch {
    // Invalid/missing state JSON still yields a discoverable session.
  }

  const current = Boolean(
    currentStateFile && path.resolve(stateFile) === path.resolve(currentStateFile)
  );

  return { name, stateFile, active, current };
}

function listBrowseSessions(): string {
  const roots = getSessionRootsFromEnv();
  const currentStateFile = process.env.BROWSE_STATE_FILE;
  const sessionsByStateFile = new Map<string, BrowseSessionInfo>();

  for (const root of roots) {
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const stateFile = path.join(root, dirent.name, 'browse.json');
      if (!fs.existsSync(stateFile)) continue;

      const key = path.resolve(stateFile);
      if (sessionsByStateFile.has(key)) continue;
      sessionsByStateFile.set(key, readSessionInfoFromStateFile(stateFile, currentStateFile));
    }
  }

  if (
    currentStateFile &&
    fs.existsSync(currentStateFile) &&
    !sessionsByStateFile.has(path.resolve(currentStateFile))
  ) {
    sessionsByStateFile.set(
      path.resolve(currentStateFile),
      readSessionInfoFromStateFile(currentStateFile, currentStateFile)
    );
  }

  const sessions = [...sessionsByStateFile.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (sessions.length === 0) {
    return [
      'No browse sessions found.',
      'Searched roots:',
      ...roots.map(root => `- ${root}`),
    ].join('\n');
  }

  return [
    `Sessions (${sessions.length}):`,
    ...sessions.map(s => `${s.current ? '→' : ' '} ${s.name} [${s.active ? 'active' : 'inactive'}] — ${s.stateFile}`),
  ].join('\n');
}

export async function handleMetaCommand(
  command: string,
  args: string[],
  bm: BrowserManager,
  shutdown: () => Promise<void> | void
): Promise<string> {
  switch (command) {
    // ─── Tabs ──────────────────────────────────────────
    case 'tabs': {
      const tabs = await bm.getTabListWithTitles();
      return tabs.map(t =>
        `${t.active ? '→ ' : '  '}[${t.id}] ${t.title || '(untitled)'} — ${t.url}`
      ).join('\n');
    }

    case 'tab': {
      const id = parseInt(args[0], 10);
      if (isNaN(id)) throw new Error('Usage: browse tab <id>');
      bm.switchTab(id);
      return `Switched to tab ${id}`;
    }

    case 'newtab': {
      const url = args[0];
      const id = await bm.newTab(url);
      return `Opened tab ${id}${url ? ` → ${url}` : ''}`;
    }

    case 'closetab': {
      const id = args[0] ? parseInt(args[0], 10) : undefined;
      await bm.closeTab(id);
      return `Closed tab${id ? ` ${id}` : ''}`;
    }

    // ─── Server Control ────────────────────────────────
    case 'status': {
      const page = bm.getPage();
      const tabs = bm.getTabCount();
      return [
        `Status: healthy`,
        `URL: ${page.url()}`,
        `Tabs: ${tabs}`,
        `PID: ${process.pid}`,
      ].join('\n');
    }

    case 'sessions': {
      return listBrowseSessions();
    }

    case 'url': {
      return bm.getCurrentUrl();
    }

    case 'stop': {
      await shutdown();
      return 'Server stopped';
    }

    case 'restart': {
      // Signal that we want a restart — the CLI will detect exit and restart
      console.log('[browse] Restart requested. Exiting for CLI to restart.');
      await shutdown();
      return 'Restarting...';
    }

    // ─── Visual ────────────────────────────────────────
    case 'screenshot': {
      // Parse priority: flags (--viewport, --clip) → selector (@ref, CSS) → output path
      const page = bm.getPage();
      let outputPath = `${TEMP_DIR}/browse-screenshot.png`;
      let clipRect: { x: number; y: number; width: number; height: number } | undefined;
      let targetSelector: string | undefined;
      let viewportOnly = false;

      const remaining: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--viewport') {
          viewportOnly = true;
        } else if (args[i] === '--clip') {
          const coords = args[++i];
          if (!coords) throw new Error('Usage: screenshot --clip x,y,w,h [path]');
          const parts = coords.split(',').map(Number);
          if (parts.length !== 4 || parts.some(isNaN))
            throw new Error('Usage: screenshot --clip x,y,width,height — all must be numbers');
          clipRect = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        } else if (args[i].startsWith('--')) {
          throw new Error(`Unknown screenshot flag: ${args[i]}`);
        } else {
          remaining.push(args[i]);
        }
      }

      // Separate target (selector/@ref) from output path
      for (const arg of remaining) {
        if (arg.startsWith('@e') || arg.startsWith('@c') || arg.startsWith('.') || arg.startsWith('#') || arg.includes('[')) {
          targetSelector = arg;
        } else {
          outputPath = arg;
        }
      }

      validateOutputPath(outputPath);

      if (clipRect && targetSelector) {
        throw new Error('Cannot use --clip with a selector/ref — choose one');
      }
      if (viewportOnly && clipRect) {
        throw new Error('Cannot use --viewport with --clip — choose one');
      }

      if (targetSelector) {
        const resolved = await bm.resolveRef(targetSelector);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        await locator.screenshot({ path: outputPath, timeout: 5000 });
        return `Screenshot saved (element): ${outputPath}`;
      }

      if (clipRect) {
        await page.screenshot({ path: outputPath, clip: clipRect });
        return `Screenshot saved (clip ${clipRect.x},${clipRect.y},${clipRect.width},${clipRect.height}): ${outputPath}`;
      }

      await page.screenshot({ path: outputPath, fullPage: !viewportOnly });
      return `Screenshot saved${viewportOnly ? ' (viewport)' : ''}: ${outputPath}`;
    }

    case 'pdf': {
      const page = bm.getPage();
      const pdfPath = args[0] || `${TEMP_DIR}/browse-page.pdf`;
      validateOutputPath(pdfPath);
      await page.pdf({ path: pdfPath, format: 'A4' });
      return `PDF saved: ${pdfPath}`;
    }

    case 'responsive': {
      const page = bm.getPage();
      const prefix = args[0] || `${TEMP_DIR}/browse-responsive`;
      validateOutputPath(prefix);
      const viewports = [
        { name: 'mobile', width: 375, height: 812 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'desktop', width: 1280, height: 720 },
      ];
      const originalViewport = page.viewportSize();
      const results: string[] = [];

      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const path = `${prefix}-${vp.name}.png`;
        await page.screenshot({ path, fullPage: true });
        results.push(`${vp.name} (${vp.width}x${vp.height}): ${path}`);
      }

      // Restore original viewport
      if (originalViewport) {
        await page.setViewportSize(originalViewport);
      }

      return results.join('\n');
    }

    // ─── Chain ─────────────────────────────────────────
    case 'chain': {
      // Read JSON array from args[0] (if provided) or expect it was passed as body
      const jsonStr = args[0];
      if (!jsonStr) throw new Error('Usage: echo \'[["goto","url"],["text"]]\' | browse chain');

      let commands: string[][];
      try {
        commands = JSON.parse(jsonStr);
      } catch {
        throw new Error('Invalid JSON. Expected: [["command", "arg1", "arg2"], ...]');
      }

      if (!Array.isArray(commands)) throw new Error('Expected JSON array of commands');

      const results: string[] = [];
      const { handleReadCommand } = await import('./read-commands');
      const { handleWriteCommand } = await import('./write-commands');

      for (const cmd of commands) {
        const [name, ...cmdArgs] = cmd;
        try {
          let result: string;
          if (WRITE_COMMANDS.has(name))    result = await handleWriteCommand(name, cmdArgs, bm);
          else if (READ_COMMANDS.has(name))  result = await handleReadCommand(name, cmdArgs, bm);
          else if (META_COMMANDS.has(name))  result = await handleMetaCommand(name, cmdArgs, bm, shutdown);
          else throw new Error(`Unknown command: ${name}`);
          results.push(`[${name}] ${result}`);
        } catch (err: any) {
          results.push(`[${name}] ERROR: ${err.message}`);
        }
      }

      return results.join('\n\n');
    }

    // ─── Diff ──────────────────────────────────────────
    case 'diff': {
      const [url1, url2] = args;
      if (!url1 || !url2) throw new Error('Usage: browse diff <url1> <url2>');

      const page = bm.getPage();
      await validateNavigationUrl(url1);
      await page.goto(url1, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const text1 = await getCleanText(page);

      await validateNavigationUrl(url2);
      await page.goto(url2, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const text2 = await getCleanText(page);

      const changes = Diff.diffLines(text1, text2);
      const output: string[] = [`--- ${url1}`, `+++ ${url2}`, ''];

      for (const part of changes) {
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        const lines = part.value.split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          output.push(`${prefix} ${line}`);
        }
      }

      return output.join('\n');
    }

    // ─── Snapshot ─────────────────────────────────────
    case 'snapshot': {
      return await handleSnapshot(args, bm);
    }

    // ─── Handoff ────────────────────────────────────
    case 'handoff': {
      const message = args.join(' ') || 'User takeover requested';
      return await bm.handoff(message);
    }

    case 'resume': {
      bm.resume();
      // Re-snapshot to capture current page state after human interaction
      const snapshot = await handleSnapshot(['-i'], bm);
      return `RESUMED\n${snapshot}`;
    }

    // ─── Auth Cache ─────────────────────────────────
    case 'auth-save': {
      const savePath = args[0]
        ? path.resolve(args[0])
        : BROWSE_CONFIG.authStateFile;
      const state = await bm.exportAuthState();
      writeAuthStateFile(savePath, state);
      return [
        `Auth state saved: ${savePath}`,
        `cookies=${state.cookies.length}`,
        `origins=${state.origins.length}`,
        `updatedAt=${state.updatedAt}`,
      ].join('\n');
    }

    case 'auth-load': {
      const loadPath = args[0]
        ? path.resolve(args[0])
        : BROWSE_CONFIG.authStateFile;
      if (!fs.existsSync(loadPath)) {
        throw new Error(`Auth state file not found: ${loadPath}`);
      }
      const state = readAuthStateFile(loadPath);
      const restored = await bm.importAuthState(state);
      return [
        `Auth state loaded: ${loadPath}`,
        `cookies=${restored.cookies}`,
        `origins=${restored.origins}`,
        `updatedAt=${state.updatedAt}`,
      ].join('\n');
    }

    case 'auth-status': {
      const authPath = args[0]
        ? path.resolve(args[0])
        : BROWSE_CONFIG.authStateFile;
      if (!fs.existsSync(authPath)) {
        return `Auth state: missing\npath=${authPath}`;
      }
      const state = readAuthStateFile(authPath);
      return [
        'Auth state: present',
        `path=${authPath}`,
        `updatedAt=${state.updatedAt}`,
        `cookies=${state.cookies.length}`,
        `origins=${state.origins.length}`,
        `sourceUrl=${state.sourceUrl || ''}`,
      ].join('\n');
    }

    // ─── Webshell Runtime ───────────────────────────
    case 'webshell': {
      const sub = args[0];
      if (!sub || sub === '--help' || sub === '-h') {
        return webshellUsage();
      }

      if (sub === 'list') {
        return listWebshellRuns();
      }

      if (sub === 'start') {
        const targetUrl = args[1];
        const requestedRunId = args[2];
        if (!targetUrl) {
          throw new Error('Usage: browse webshell start <target_url> [run_id]');
        }
        return await startWebshellRun(targetUrl, requestedRunId, bm);
      }

      if (sub === 'preflight') {
        const runId = args[1];
        const targetUrl = args[2];
        if (!runId) {
          throw new Error('Usage: browse webshell preflight <run_id> [target_url]');
        }
        return await preflightWebshellRun(runId, bm, targetUrl);
      }

      if (sub === 'status') {
        const runId = args[1];
        if (!runId) {
          throw new Error('Usage: browse webshell status <run_id>');
        }
        return getWebshellRunStatus(runId);
      }

      if (sub === 'set') {
        const runId = args[1];
        const key = args[2];
        const rawValue = args.slice(3).join(' ');
        if (!runId || !key || !rawValue) {
          throw new Error('Usage: browse webshell set <run_id> <focus_selector|poll_interval_ms|timeout_ms|no_frame_timeout_ms|auth_state_path|auth_loaded> <value>');
        }
        return setWebshellRunConfig(runId, key, rawValue);
      }

      if (sub === 'cmd') {
        const runId = args[1];
        if (!runId) {
          throw new Error('Usage: browse webshell cmd <run_id> [--confirm] [--] <shell_command...>');
        }

        let i = 2;
        let confirm = false;
        if (args[i] === '--confirm') {
          confirm = true;
          i += 1;
        }
        if (args[i] === '--') {
          i += 1;
        }

        const shellCommand = args.slice(i).join(' ').trim();
        if (!shellCommand) {
          throw new Error('Usage: browse webshell cmd <run_id> [--confirm] [--] <shell_command...>');
        }

        return await executeWebshellRunCommand(runId, shellCommand, bm, { confirm });
      }

      if (sub === 'finish') {
        const runId = args[1];
        if (!runId) {
          throw new Error('Usage: browse webshell finish <run_id>');
        }
        return finishWebshellRun(runId);
      }

      throw new Error(`Unknown webshell subcommand: ${sub}\n\n${webshellUsage()}`);
    }

    default:
      throw new Error(`Unknown meta command: ${command}`);
  }
}
