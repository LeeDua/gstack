import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BrowserManager } from './browser-manager';
import { websocketBuffer } from './buffers';
import { resolveConfig } from './config';
import { readAuthStateFile, writeAuthStateFile } from './auth-state';
import { validateNavigationUrl } from './url-validation';

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export type WebshellRunState =
  | 'init'
  | 'auth'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed';

export type CommandRisk = 'safe' | 'review';

export interface WebshellRunRecord {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  state: WebshellRunState;
  targetUrl: string;
  currentUrl: string;
  authStatePath: string;
  authLoaded: boolean;
  sinceCursor: number;
  commandCount: number;
  focusSelector: string | null;
  pollIntervalMs: number;
  timeoutMs: number;
  noFrameTimeoutMs: number;
  lastError: string | null;
}

interface RunPaths {
  rootDir: string;
  runDir: string;
  runFile: string;
  eventsFile: string;
  commandsFile: string;
  observationsDir: string;
}

interface WebSocketSlice {
  nextSince: number;
  payload: string;
  frameCount: number;
}

interface ReadinessProbe {
  ready: boolean;
  reason: string;
  url: string;
  title: string;
  bodyTextLen: number;
  iframeCount: number;
  terminalHintCount: number;
  hasSsoSignals: boolean;
}

interface CommandFocusResult {
  mode: 'explicit' | 'explicit_failed' | 'auto' | 'none';
  selector: string | null;
  error: string | null;
}

interface CommandWarmupResult {
  nextSince: number;
  observed: boolean;
  frameCount: number;
  pollCount: number;
  waitedMs: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function runTimestamp(): string {
  return nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
}

function getRunRoot(): string {
  const config = resolveConfig();
  return path.resolve(config.webshellRunRoot);
}

function validateRunId(raw: string): string {
  const runId = raw.trim();
  if (!runId) throw new Error('run_id cannot be empty');
  if (!RUN_ID_RE.test(runId)) {
    throw new Error('Invalid run_id. Allowed: A-Z a-z 0-9 . _ -');
  }
  return runId;
}

function makeRunId(): string {
  return `ws-${runTimestamp()}-${crypto.randomUUID().slice(0, 8)}`;
}

function parsePositiveInt(raw: string, key: string): number {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return n;
}

function looksLikeWebshellUrl(url: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (host.includes('security-webshell.byted.org')) return true;
    if (host.includes('relay-yg.byted.org') && pathname.includes('/bnd/webshell')) return true;
    if (host.includes('webshell') && pathname.includes('/common/v2')) return true;
    return false;
  } catch {
    const value = url.toLowerCase();
    return value.includes('security-webshell.byted.org/') || value.includes('/bnd/webshell');
  }
}

function looksLikeSsoUrl(url: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return host.includes('sso.bytedance.com') || pathname.includes('/authentication/validate');
  } catch {
    return url.toLowerCase().includes('sso.bytedance.com');
  }
}

function getRunPaths(runId: string): RunPaths {
  const safeRunId = validateRunId(runId);
  const rootDir = getRunRoot();
  const runDir = path.join(rootDir, safeRunId);
  return {
    rootDir,
    runDir,
    runFile: path.join(runDir, 'run.json'),
    eventsFile: path.join(runDir, 'events.jsonl'),
    commandsFile: path.join(runDir, 'commands.jsonl'),
    observationsDir: path.join(runDir, 'observations'),
  };
}

function ensureRunDirectories(paths: RunPaths): void {
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.mkdirSync(paths.observationsDir, { recursive: true });
}

function writeRun(paths: RunPaths, run: WebshellRunRecord): void {
  fs.writeFileSync(paths.runFile, `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
}

function readRun(paths: RunPaths): WebshellRunRecord {
  if (!fs.existsSync(paths.runFile)) {
    throw new Error(`Run not found: ${paths.runFile}`);
  }
  const run = JSON.parse(fs.readFileSync(paths.runFile, 'utf-8')) as WebshellRunRecord;
  if (!run || run.version !== 1 || typeof run.runId !== 'string') {
    throw new Error(`Invalid run file: ${paths.runFile}`);
  }
  return run;
}

function appendJsonl(filePath: string, entry: Record<string, unknown>): void {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

function appendEvent(paths: RunPaths, run: WebshellRunRecord, event: string, detail: Record<string, unknown>): void {
  appendJsonl(paths.eventsFile, {
    ts: nowIso(),
    event,
    state: run.state,
    run_id: run.runId,
    detail,
  });
}

function readWebSocketSince(since: number): WebSocketSlice {
  const entries = websocketBuffer.toArray();
  if (entries.length === 0) {
    return { nextSince: since, payload: '', frameCount: 0 };
  }

  const firstSeq = websocketBuffer.totalAdded - entries.length + 1;
  let nextSince = since;
  let frameCount = 0;
  const payloadParts: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const seq = firstSeq + i;
    if (seq <= since) continue;

    const entry = entries[i];
    frameCount += 1;
    nextSince = seq;

    if (entry.direction === 'in' && entry.payload) {
      payloadParts.push(entry.payload);
    }
  }

  const payload = payloadParts.join('').replace(ANSI_RE, '').replace(/\r/g, '');
  return { nextSince, payload, frameCount };
}

async function warmupWebSocketCursor(
  since: number,
  options: { timeoutMs: number; pollIntervalMs: number },
): Promise<CommandWarmupResult> {
  const startMs = Date.now();
  let cursor = since;
  let frameCount = 0;
  let pollCount = 0;

  while (Date.now() - startMs < options.timeoutMs) {
    pollCount += 1;
    const slice = readWebSocketSince(cursor);
    cursor = slice.nextSince;
    frameCount += slice.frameCount;

    if (slice.frameCount > 0) {
      return {
        nextSince: cursor,
        observed: true,
        frameCount,
        pollCount,
        waitedMs: Date.now() - startMs,
      };
    }

    await Bun.sleep(options.pollIntervalMs);
  }

  return {
    nextSince: cursor,
    observed: frameCount > 0,
    frameCount,
    pollCount,
    waitedMs: Date.now() - startMs,
  };
}

async function focusTerminalInput(
  bm: BrowserManager,
  run: WebshellRunRecord,
): Promise<CommandFocusResult> {
  const page = bm.getPage();

  async function tryFocus(selector: string): Promise<boolean> {
    const locator = page.locator(selector).first();
    if ((await locator.count()) < 1) return false;

    try {
      await locator.click({ timeout: 800 });
      return true;
    } catch {
      // fallback to focus for hidden helper textarea
    }

    try {
      await locator.focus({ timeout: 800 });
      return true;
    } catch {
      return false;
    }
  }

  if (run.focusSelector) {
    const ok = await tryFocus(run.focusSelector);
    if (ok) {
      return { mode: 'explicit', selector: run.focusSelector, error: null };
    }
    return {
      mode: 'explicit_failed',
      selector: run.focusSelector,
      error: 'failed to focus explicit selector: ' + run.focusSelector,
    };
  }

  const candidates = [
    'textarea.xterm-helper-textarea',
    '.xterm-helper-textarea',
    '.xterm-screen',
    '.xterm',
    '[role="textbox"]',
    'textarea',
    'input[type="text"]',
    'input',
  ];

  for (const selector of candidates) {
    if (await tryFocus(selector)) {
      return { mode: 'auto', selector, error: null };
    }
  }

  return { mode: 'none', selector: null, error: null };
}

function isLikelyEchoedWrapperPayload(rawBetweenMarkers: string): boolean {
  const trimmed = rawBetweenMarkers.replace(/^\n+/, '');

  // The terminal may echo the typed wrapper command first, which includes markers
  // as literal source text (for example: "\n'; echo ...; printf '\n"). Ignore that pair.
  if (/^\\n';[\s\S]*?;\s*printf\s+'\\n/.test(trimmed)) return true;
  if (/^';/.test(trimmed) && /;\s*printf\s+'\\n/.test(trimmed)) return true;

  return false;
}

function parseMixedWebshellPayload(
  captured: string,
  begin: string,
  end: string,
): { output: string | null; beginSeen: boolean } {
  const beginSeen = captured.includes(begin);
  if (!beginSeen) return { output: null, beginSeen: false };

  let searchEnd = captured.length;
  while (searchEnd > 0) {
    const endIndex = captured.lastIndexOf(end, searchEnd - 1);
    if (endIndex === -1) break;

    const beginIndex = captured.lastIndexOf(begin, endIndex - 1);
    if (beginIndex === -1) {
      searchEnd = endIndex;
      continue;
    }

    const rawBetween = captured.slice(beginIndex + begin.length, endIndex);
    if (isLikelyEchoedWrapperPayload(rawBetween)) {
      searchEnd = beginIndex;
      continue;
    }

    const output = rawBetween.replace(/^\n+/, '');
    return { output, beginSeen: true };
  }

  return { output: null, beginSeen: true };
}

async function probeReadiness(bm: BrowserManager): Promise<ReadinessProbe> {
  const page = bm.getPage();
  const url = bm.getCurrentUrl();

  let title = '';
  let bodyTextLen = 0;
  let iframeCount = 0;
  let terminalHintCount = 0;
  let hasSsoSignals = false;

  try {
    const info = await page.evaluate(() => {
      const terminalHints = document.querySelectorAll(
        'textarea,input,[contenteditable],pre,.terminal,.xterm,.xterm-screen,.xterm-rows,[role="textbox"]'
      ).length;
      const ssoHints = document.querySelectorAll(
        'input[type="password"], input[name*="otp" i], input[name*="code" i], form[action*="sso" i], [data-testid*="mfa" i]'
      ).length;
      const titleLower = (document.title || '').toLowerCase();
      const bodyLower = (document.body?.innerText || '').toLowerCase();
      const textLooksLikeSso =
        titleLower.includes('sso') ||
        titleLower.includes('login') ||
        bodyLower.includes('verify') ||
        bodyLower.includes('mfa') ||
        bodyLower.includes('otp') ||
        bodyLower.includes('验证码') ||
        bodyLower.includes('登录');

      return {
        title: document.title || '',
        bodyTextLen: (document.body?.innerText || '').trim().length,
        iframeCount: document.querySelectorAll('iframe').length,
        terminalHintCount: terminalHints,
        hasSsoSignals: ssoHints > 0 || textLooksLikeSso,
      };
    });
    title = info.title;
    bodyTextLen = info.bodyTextLen;
    iframeCount = info.iframeCount;
    terminalHintCount = info.terminalHintCount;
    hasSsoSignals = info.hasSsoSignals;
  } catch {
    // Best-effort readiness probe; keep defaults.
  }

  const notBlank = url !== 'about:blank';
  const hasDomSignal = bodyTextLen > 0 || iframeCount > 0;
  const hasTerminalHints = terminalHintCount > 0;
  const urlLooksLikeWebshell = looksLikeWebshellUrl(url);
  const urlLooksLikeSso = looksLikeSsoUrl(url);
  hasSsoSignals = hasSsoSignals || urlLooksLikeSso;

  const ready = notBlank && !hasSsoSignals && (hasTerminalHints || hasDomSignal || urlLooksLikeWebshell);

  let reason = 'ready';
  if (!notBlank) {
    reason = 'about_blank';
  } else if (hasSsoSignals) {
    reason = 'sso_required';
  } else if (hasTerminalHints) {
    reason = 'terminal_hint';
  } else if (hasDomSignal) {
    reason = 'dom_signal';
  } else if (urlLooksLikeWebshell) {
    reason = 'webshell_url_hint';
  } else {
    reason = 'no_dom_signal';
  }

  return { ready, reason, url, title, bodyTextLen, iframeCount, terminalHintCount, hasSsoSignals };
}

function classifyCommandRisk(command: string): CommandRisk {
  const riskyPatterns = [
    /\brm\s+-rf\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bTRUNCATE\b/i,
    /\bkubectl\s+delete\b/i,
    /\bterraform\s+destroy\b/i,
  ];

  return riskyPatterns.some((pattern) => pattern.test(command)) ? 'review' : 'safe';
}

export function webshellUsage(): string {
  return [
    'Usage: browse webshell <subcommand> ...',
    '',
    'Subcommands:',
    '  webshell list',
    '  webshell start <target_url> [run_id]',
    '  webshell preflight <run_id> [target_url]',
    '  webshell status <run_id>',
    '  webshell cmd <run_id> [--confirm] [--] <shell_command...>',
    '  webshell set <run_id> <focus_selector|poll_interval_ms|timeout_ms|no_frame_timeout_ms|auth_state_path|auth_loaded> <value>',
    '  webshell finish <run_id>',
  ].join('\n');
}

export function listWebshellRuns(): string {
  const root = getRunRoot();
  if (!fs.existsSync(root)) {
    return `No webshell runs found. root=${root}`;
  }

  const rows: Array<{ runId: string; state: string; updatedAt: string; targetUrl: string }> = [];
  const dirents = fs.readdirSync(root, { withFileTypes: true });
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const runFile = path.join(root, dirent.name, 'run.json');
    if (!fs.existsSync(runFile)) continue;

    try {
      const run = JSON.parse(fs.readFileSync(runFile, 'utf-8')) as WebshellRunRecord;
      rows.push({
        runId: run.runId,
        state: run.state,
        updatedAt: run.updatedAt,
        targetUrl: run.targetUrl,
      });
    } catch {
      rows.push({
        runId: dirent.name,
        state: 'invalid',
        updatedAt: '-',
        targetUrl: '-',
      });
    }
  }

  if (rows.length === 0) {
    return `No webshell runs found. root=${root}`;
  }

  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const lines = rows.map((r) => `${r.runId} [${r.state}] updated=${r.updatedAt} target=${r.targetUrl}`);
  return [`Webshell runs (${rows.length}) root=${root}`, ...lines].join('\n');
}

async function loadAuthIfPresent(
  bm: BrowserManager,
  authPath: string,
): Promise<{ loaded: boolean; detail: Record<string, unknown> }> {
  if (!fs.existsSync(authPath)) {
    return {
      loaded: false,
      detail: { auth_state: 'missing', path: authPath },
    };
  }

  const state = readAuthStateFile(authPath);
  const restored = await bm.importAuthState(state);
  return {
    loaded: true,
    detail: {
      auth_state: 'loaded',
      path: authPath,
      cookies: restored.cookies,
      origins: restored.origins,
      updatedAt: state.updatedAt,
    },
  };
}

async function executePreflight(
  run: WebshellRunRecord,
  paths: RunPaths,
  bm: BrowserManager,
  targetUrl?: string,
): Promise<{ run: WebshellRunRecord; probe: ReadinessProbe }> {
  run.state = 'auth';
  run.updatedAt = nowIso();
  writeRun(paths, run);
  appendEvent(paths, run, 'preflight_started', {
    target_url: targetUrl || run.targetUrl,
    current_url: bm.getCurrentUrl(),
  });

  try {
    const auth = await loadAuthIfPresent(bm, run.authStatePath);
    run.authLoaded = auth.loaded;
    appendEvent(paths, run, 'auth_checked', auth.detail);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    run.lastError = message;
    appendEvent(paths, run, 'auth_check_failed', { error: message });
  }

  const nextUrl = targetUrl || run.targetUrl;
  if (nextUrl) {
    await validateNavigationUrl(nextUrl);
    const response = await bm.getPage().goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    run.targetUrl = nextUrl;
    run.currentUrl = bm.getCurrentUrl();
    run.updatedAt = nowIso();
    appendEvent(paths, run, 'navigation', {
      target_url: nextUrl,
      status: response?.status() || 'unknown',
      current_url: run.currentUrl,
    });
  } else {
    run.currentUrl = bm.getCurrentUrl();
  }

  const probe = await probeReadiness(bm);
  run.currentUrl = probe.url;
  run.sinceCursor = websocketBuffer.totalAdded;
  run.updatedAt = nowIso();

  if (probe.ready) {
    run.state = 'ready';
    run.lastError = null;

    try {
      const refreshed = await bm.exportAuthState();
      writeAuthStateFile(run.authStatePath, refreshed);
      appendEvent(paths, run, 'auth_saved', {
        path: run.authStatePath,
        cookies: refreshed.cookies.length,
        origins: refreshed.origins.length,
        updatedAt: refreshed.updatedAt,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      appendEvent(paths, run, 'auth_save_failed', {
        path: run.authStatePath,
        error: message,
      });
    }
  } else {
    run.state = 'auth';
    run.lastError = `readiness_probe_failed: ${probe.reason}`;
  }

  writeRun(paths, run);
  appendEvent(paths, run, 'ready_probe', {
    ready: probe.ready,
    reason: probe.reason,
    url: probe.url,
    title: probe.title,
    body_text_len: probe.bodyTextLen,
    iframe_count: probe.iframeCount,
    terminal_hint_count: probe.terminalHintCount,
    has_sso_signals: probe.hasSsoSignals,
    since_cursor: run.sinceCursor,
  });

  return { run, probe };
}

export async function startWebshellRun(
  targetUrl: string,
  requestedRunId: string | undefined,
  bm: BrowserManager,
): Promise<string> {
  await validateNavigationUrl(targetUrl);

  const runId = requestedRunId ? validateRunId(requestedRunId) : makeRunId();
  const paths = getRunPaths(runId);
  ensureRunDirectories(paths);

  if (fs.existsSync(paths.runFile)) {
    throw new Error(`Run already exists: ${runId}`);
  }

  const config = resolveConfig();
  const run: WebshellRunRecord = {
    version: 1,
    runId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    state: 'init',
    targetUrl,
    currentUrl: bm.getCurrentUrl(),
    authStatePath: config.authStateFile,
    authLoaded: false,
    sinceCursor: websocketBuffer.totalAdded,
    commandCount: 0,
    focusSelector: null,
    pollIntervalMs: parsePositiveInt(process.env.BROWSE_WEBSHELL_POLL_INTERVAL_MS || '120', 'poll_interval_ms'),
    timeoutMs: parsePositiveInt(process.env.BROWSE_WEBSHELL_TIMEOUT_MS || '12000', 'timeout_ms'),
    noFrameTimeoutMs: parsePositiveInt(process.env.BROWSE_WEBSHELL_NO_FRAME_TIMEOUT_MS || '1500', 'no_frame_timeout_ms'),
    lastError: null,
  };

  writeRun(paths, run);
  appendEvent(paths, run, 'run_created', {
    run_dir: paths.runDir,
    target_url: targetUrl,
    auth_state_path: run.authStatePath,
  });

  const { run: updatedRun, probe } = await executePreflight(run, paths, bm, targetUrl);
  return [
    `Webshell run started: ${updatedRun.runId}`,
    `state=${updatedRun.state}`,
    `run_dir=${paths.runDir}`,
    `target_url=${updatedRun.targetUrl}`,
    `current_url=${updatedRun.currentUrl}`,
    `since_cursor=${updatedRun.sinceCursor}`,
    `ready_probe=${probe.reason}`,
  ].join('\n');
}

export async function preflightWebshellRun(
  runId: string,
  bm: BrowserManager,
  targetUrl?: string,
): Promise<string> {
  const paths = getRunPaths(runId);
  ensureRunDirectories(paths);
  const run = readRun(paths);

  const { run: updatedRun, probe } = await executePreflight(run, paths, bm, targetUrl);
  return [
    `Webshell preflight: ${updatedRun.runId}`,
    `state=${updatedRun.state}`,
    `target_url=${updatedRun.targetUrl}`,
    `current_url=${updatedRun.currentUrl}`,
    `since_cursor=${updatedRun.sinceCursor}`,
    `ready_probe=${probe.reason}`,
  ].join('\n');
}

export function getWebshellRunStatus(runId: string): string {
  const paths = getRunPaths(runId);
  const run = readRun(paths);
  if (!run.noFrameTimeoutMs || run.noFrameTimeoutMs <= 0) {
    run.noFrameTimeoutMs = parsePositiveInt(process.env.BROWSE_WEBSHELL_NO_FRAME_TIMEOUT_MS || '1500', 'no_frame_timeout_ms');
  }

  return [
    `run_id=${run.runId}`,
    `state=${run.state}`,
    `created_at=${run.createdAt}`,
    `updated_at=${run.updatedAt}`,
    `target_url=${run.targetUrl}`,
    `current_url=${run.currentUrl}`,
    `auth_state_path=${run.authStatePath}`,
    `auth_loaded=${run.authLoaded}`,
    `since_cursor=${run.sinceCursor}`,
    `command_count=${run.commandCount}`,
    `focus_selector=${run.focusSelector || ''}`,
    `poll_interval_ms=${run.pollIntervalMs}`,
    `timeout_ms=${run.timeoutMs}`,
    `no_frame_timeout_ms=${run.noFrameTimeoutMs}`,
    `last_error=${run.lastError || ''}`,
    `run_dir=${paths.runDir}`,
  ].join('\n');
}

function parseBoolean(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  throw new Error('Value must be a boolean: true/false');
}

export function setWebshellRunConfig(runId: string, key: string, rawValue: string): string {
  const paths = getRunPaths(runId);
  const run = readRun(paths);
  if (!run.noFrameTimeoutMs || run.noFrameTimeoutMs <= 0) {
    run.noFrameTimeoutMs = parsePositiveInt(process.env.BROWSE_WEBSHELL_NO_FRAME_TIMEOUT_MS || '1500', 'no_frame_timeout_ms');
  }

  switch (key) {
    case 'focus_selector':
      run.focusSelector = rawValue;
      break;
    case 'poll_interval_ms':
      run.pollIntervalMs = parsePositiveInt(rawValue, 'poll_interval_ms');
      break;
    case 'timeout_ms':
      run.timeoutMs = parsePositiveInt(rawValue, 'timeout_ms');
      break;
    case 'no_frame_timeout_ms':
      run.noFrameTimeoutMs = parsePositiveInt(rawValue, 'no_frame_timeout_ms');
      break;
    case 'auth_state_path':
      run.authStatePath = path.resolve(rawValue);
      break;
    case 'auth_loaded':
      run.authLoaded = parseBoolean(rawValue);
      break;
    default:
      throw new Error('Unknown key. Use: focus_selector | poll_interval_ms | timeout_ms | no_frame_timeout_ms | auth_state_path | auth_loaded');
  }

  run.updatedAt = nowIso();
  writeRun(paths, run);
  appendEvent(paths, run, 'config_updated', { key, value: rawValue });

  return [
    `Webshell config updated: ${run.runId}`,
    `key=${key}`,
    `value=${rawValue}`,
  ].join('\n');
}

export async function executeWebshellRunCommand(
  runId: string,
  command: string,
  bm: BrowserManager,
  options: { confirm: boolean },
): Promise<string> {
  const paths = getRunPaths(runId);
  let run = readRun(paths);
  if (!run.noFrameTimeoutMs || run.noFrameTimeoutMs <= 0) {
    run.noFrameTimeoutMs = parsePositiveInt(process.env.BROWSE_WEBSHELL_NO_FRAME_TIMEOUT_MS || '1500', 'no_frame_timeout_ms');
  }

  let liveUrl = bm.getCurrentUrl();

  if (run.state !== 'ready' && run.state !== 'executing') {
    appendEvent(paths, run, 'command_auto_preflight', {
      reason: 'state_not_ready',
      current_state: run.state,
      live_url: liveUrl,
    });
    const preflight = await executePreflight(run, paths, bm, run.targetUrl);
    run = preflight.run;
    liveUrl = run.currentUrl;
  }

  if (liveUrl === 'about:blank') {
    appendEvent(paths, run, 'command_auto_preflight', {
      reason: 'about_blank',
      current_state: run.state,
      live_url: liveUrl,
    });
    const preflight = await executePreflight(run, paths, bm, run.targetUrl);
    run = preflight.run;
    liveUrl = run.currentUrl;
  }

  if (run.state !== 'ready' && run.state !== 'executing') {
    throw new Error(`Run ${run.runId} is not ready (state=${run.state}). Run 'webshell preflight ${run.runId}' first.`);
  }
  if (liveUrl === 'about:blank') {
    throw new Error(`Run ${run.runId} is at about:blank. Run 'webshell preflight ${run.runId} <target_url>' first.`);
  }

  run.currentUrl = liveUrl;

  const risk = classifyCommandRisk(command);
  if (risk === 'review' && !options.confirm) {
    throw new Error(`Command classified as review. Re-run with --confirm to execute: ${command}`);
  }

  const page = bm.getPage();
  const seq = run.commandCount + 1;
  const fixedMarker = process.env.BROWSE_WEBSHELL_FIXED_MARKER?.trim();
  const marker = fixedMarker || crypto.randomUUID().slice(0, 10);
  const begin = `__GS_BEGIN_${marker}__`;
  const end = `__GS_END_${marker}__`;
  const wrapped = `printf '${begin}\\n'; ${command}; printf '\\n${end}\\n'`;

  let warmupResult: CommandWarmupResult = {
    nextSince: run.sinceCursor,
    observed: false,
    frameCount: 0,
    pollCount: 0,
    waitedMs: 0,
  };

  if (looksLikeWebshellUrl(liveUrl)) {
    const readyTimeoutMs = parsePositiveInt(
      process.env.BROWSE_WEBSHELL_READY_TIMEOUT_MS || '3000',
      'ready_timeout_ms',
    );
    const readyPollIntervalMs = parsePositiveInt(
      process.env.BROWSE_WEBSHELL_READY_POLL_INTERVAL_MS || '100',
      'ready_poll_interval_ms',
    );
    warmupResult = await warmupWebSocketCursor(run.sinceCursor, {
      timeoutMs: readyTimeoutMs,
      pollIntervalMs: Math.min(readyPollIntervalMs, run.pollIntervalMs),
    });
    run.sinceCursor = warmupResult.nextSince;
  }

  const focusStartMs = Date.now();
  const focusResult = await focusTerminalInput(bm, run);
  const focusDoneMs = Date.now();

  run.state = 'executing';
  run.updatedAt = nowIso();
  writeRun(paths, run);
  appendEvent(paths, run, 'command_started', {
    seq,
    command,
    risk,
    confirmed: options.confirm,
    since_cursor: run.sinceCursor,
    focus_mode: focusResult.mode,
    focus_selector: focusResult.selector,
    focus_error: focusResult.error,
    focus_ms: focusDoneMs - focusStartMs,
    warmup_wait_ms: warmupResult.waitedMs,
    warmup_polls: warmupResult.pollCount,
    warmup_frames: warmupResult.frameCount,
    warmup_observed: warmupResult.observed,
  });

  const inputStartMs = Date.now();
  await page.keyboard.type(wrapped);
  const typeDoneMs = Date.now();
  await page.keyboard.press('Enter');
  const enterDoneMs = Date.now();

  let cursor = run.sinceCursor;
  let pollCount = 0;
  let pollFrameCount = 0;
  let firstOutputMs: number | null = null;
  let resultDoneMs = enterDoneMs;
  let timedOut = false;
  let noWebsocketActivity = false;
  let captured = '';
  let output = '';

  const timeoutAt = enterDoneMs + run.timeoutMs;
  while (Date.now() <= timeoutAt) {
    pollCount += 1;
    const slice = readWebSocketSince(cursor);
    cursor = slice.nextSince;
    pollFrameCount += slice.frameCount;

    if (slice.payload) {
      captured += slice.payload;
    }

    const parsed = parseMixedWebshellPayload(captured, begin, end);
    if (firstOutputMs === null && parsed.beginSeen) {
      firstOutputMs = Date.now();
    }

    if (parsed.output !== null) {
      output = parsed.output;
      resultDoneMs = Date.now();
      break;
    }

    if (pollFrameCount === 0 && Date.now() - enterDoneMs >= run.noFrameTimeoutMs) {
      noWebsocketActivity = true;
      resultDoneMs = Date.now();
      output = '<NO_WEBSOCKET_ACTIVITY>';
      break;
    }

    await Bun.sleep(run.pollIntervalMs);
  }

  if (!output) {
    resultDoneMs = Date.now();
    timedOut = true;
    output = '<TIMEOUT_NO_END_MARKER>';
  }

  const outputFile = path.join(paths.observationsDir, `cmd-${String(seq).padStart(4, '0')}.log`);
  fs.writeFileSync(outputFile, output, 'utf-8');

  const commandRecord = {
    ts: nowIso(),
    run_id: run.runId,
    seq,
    command,
    command_length: command.length,
    wrapped_command: wrapped,
    risk,
    confirmed: options.confirm,
    focus_mode: focusResult.mode,
    focus_selector: focusResult.selector,
    focus_error: focusResult.error,
    focus_ms: focusDoneMs - focusStartMs,
    warmup_wait_ms: warmupResult.waitedMs,
    warmup_poll_count: warmupResult.pollCount,
    warmup_frame_count: warmupResult.frameCount,
    warmup_observed: warmupResult.observed,
    begin_marker: begin,
    end_marker: end,
    since_start: run.sinceCursor,
    since_end: cursor,
    timed_out: timedOut,
    no_websocket_activity: noWebsocketActivity,
    output_file: outputFile,
    output_bytes: output.length,
    poll_count: pollCount,
    poll_frame_count: pollFrameCount,
    input_start_ms: inputStartMs,
    type_done_ms: typeDoneMs,
    enter_done_ms: enterDoneMs,
    first_output_ms: firstOutputMs,
    result_done_ms: resultDoneMs,
    input_to_send_ms: enterDoneMs - inputStartMs,
    send_to_first_output_ms: firstOutputMs === null ? null : firstOutputMs - enterDoneMs,
    send_to_result_ms: resultDoneMs - enterDoneMs,
    input_to_result_ms: resultDoneMs - inputStartMs,
  };
  appendJsonl(paths.commandsFile, commandRecord);

  run.commandCount = seq;
  run.sinceCursor = cursor;
  run.currentUrl = bm.getCurrentUrl();
  run.updatedAt = nowIso();
  run.state = (timedOut || noWebsocketActivity) ? 'failed' : 'ready';
  run.lastError = timedOut ? 'command_timeout' : (noWebsocketActivity ? 'no_websocket_activity' : null);
  writeRun(paths, run);
  appendEvent(paths, run, 'command_finished', {
    seq,
    timed_out: timedOut,
    no_websocket_activity: noWebsocketActivity,
    since_cursor: run.sinceCursor,
    output_file: outputFile,
    input_to_result_ms: commandRecord.input_to_result_ms,
    send_to_result_ms: commandRecord.send_to_result_ms,
    poll_count: commandRecord.poll_count,
  });

  return [
    `Webshell command executed: run_id=${run.runId} seq=${seq}`,
    `risk=${risk} confirmed=${options.confirm}`,
    `state=${run.state}`,
    `since_cursor=${run.sinceCursor}`,
    `timing_ms input_to_result=${commandRecord.input_to_result_ms} send_to_result=${commandRecord.send_to_result_ms} polls=${commandRecord.poll_count}`,
    `output_file=${outputFile}`,
    '',
    output,
  ].join('\n');
}

export function finishWebshellRun(runId: string): string {
  const paths = getRunPaths(runId);
  const run = readRun(paths);

  run.state = 'completed';
  run.updatedAt = nowIso();
  run.lastError = null;
  writeRun(paths, run);
  appendEvent(paths, run, 'run_finished', {
    command_count: run.commandCount,
  });

  return [
    `Webshell run finished: ${run.runId}`,
    `state=${run.state}`,
    `command_count=${run.commandCount}`,
    `run_dir=${paths.runDir}`,
  ].join('\n');
}
