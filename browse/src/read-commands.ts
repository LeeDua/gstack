/**
 * Read commands — extract data from pages without side effects
 *
 * text, html, links, forms, accessibility, js, eval, css, attrs,
 * console, network, websocket, observe, cookies, storage, perf
 */

import type { BrowserManager } from './browser-manager';
import { consoleBuffer, networkBuffer, dialogBuffer, websocketBuffer } from './buffers';
import type { Locator, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR, isPathWithin } from './platform';
import { redactOutput, truncateTail } from './redaction';

/** Detect await keyword, ignoring comments. Accepted risk: await in string literals triggers wrapping (harmless). */
function hasAwait(code: string): boolean {
  const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /\bawait\b/.test(stripped);
}

/** Detect whether code needs a block wrapper {…} vs expression wrapper (…) inside an async IIFE. */
function needsBlockWrapper(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.split('\n').length > 1) return true;
  if (/\b(const|let|var|function|class|return|throw|if|for|while|switch|try)\b/.test(trimmed)) return true;
  if (trimmed.includes(';')) return true;
  return false;
}

/** Wrap code for page.evaluate(), using async IIFE with block or expression body as needed. */
function wrapForEvaluate(code: string): string {
  if (!hasAwait(code)) return code;
  const trimmed = code.trim();
  return needsBlockWrapper(trimmed)
    ? `(async()=>{\n${code}\n})()`
    : `(async()=>(${trimmed}))()`;
}

// Security: Path validation to prevent path traversal attacks
const SAFE_DIRECTORIES = [TEMP_DIR, process.cwd()];

export function validateReadPath(filePath: string): void {
  if (path.isAbsolute(filePath)) {
    const resolved = path.resolve(filePath);
    const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(resolved, dir));
    if (!isSafe) {
      throw new Error(`Absolute path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
    }
  }
  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) {
    throw new Error('Path traversal sequences (..) are not allowed');
  }
}

/**
 * Extract clean text from a page (strips script/style/noscript/svg).
 * Exported for DRY reuse in meta-commands (diff).
 */
export async function getCleanText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    const clone = body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
    return clone.innerText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  });
}

interface ObserveOptions {
  intervalMs: number;
  durationMs: number;
  mode: 'text' | 'html' | 'value';
  stableMs: number;
  maxChars: number;
  redact: boolean;
}

function extractRedactFlag(rawArgs: string[]): { args: string[]; redact: boolean } {
  const args = [...rawArgs];
  const idx = args.indexOf('--redact');
  if (idx === -1) return { args, redact: true };

  const value = args[idx + 1];
  if (value !== 'on' && value !== 'off') {
    throw new Error('Usage: --redact <on|off>');
  }
  args.splice(idx, 2);
  return { args, redact: value === 'on' };
}

function parseObserveArgs(args: string[]): { target: string; options: ObserveOptions } {
  const { args: normalizedArgs, redact } = extractRedactFlag(args);
  const target = normalizedArgs[0];
  if (!target || target.startsWith('--')) {
    throw new Error(
      'Usage: browse observe <sel|@ref> [--interval-ms N] [--duration-ms N] [--mode text|html|value] [--stable-ms N] [--max-chars N] [--redact on|off]'
    );
  }

  const options: ObserveOptions = {
    intervalMs: 500,
    durationMs: 15000,
    mode: 'text',
    stableMs: 1200,
    maxChars: 20000,
    redact,
  };

  for (let i = 1; i < normalizedArgs.length; i++) {
    const flag = normalizedArgs[i];
    const value = normalizedArgs[i + 1];
    if (!flag.startsWith('--')) throw new Error(`Unknown observe argument: ${flag}`);

    switch (flag) {
      case '--interval-ms':
        options.intervalMs = parseInt(value, 10);
        if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
          throw new Error('--interval-ms must be a positive integer');
        }
        i++;
        break;
      case '--duration-ms':
        options.durationMs = parseInt(value, 10);
        if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
          throw new Error('--duration-ms must be a positive integer');
        }
        i++;
        break;
      case '--mode':
        if (value !== 'text' && value !== 'html' && value !== 'value') {
          throw new Error('--mode must be one of: text, html, value');
        }
        options.mode = value;
        i++;
        break;
      case '--stable-ms':
        options.stableMs = parseInt(value, 10);
        if (!Number.isFinite(options.stableMs) || options.stableMs <= 0) {
          throw new Error('--stable-ms must be a positive integer');
        }
        i++;
        break;
      case '--max-chars':
        options.maxChars = parseInt(value, 10);
        if (!Number.isFinite(options.maxChars) || options.maxChars <= 0) {
          throw new Error('--max-chars must be a positive integer');
        }
        i++;
        break;
      default:
        throw new Error(`Unknown observe flag: ${flag}`);
    }
  }

  return { target, options };
}

function computeDelta(previous: string, current: string): string {
  if (current === previous) return '';
  if (!previous) return current;
  if (!current) return '[cleared output]';
  if (current.startsWith(previous)) return current.slice(previous.length);

  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < current.length &&
    previous[prefix] === current[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < (previous.length - prefix) &&
    suffix < (current.length - prefix) &&
    previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = previous.slice(prefix, previous.length - suffix);
  const added = current.slice(prefix, current.length - suffix);

  if (!removed) return added;
  if (!added) return `[deleted ${removed.length} chars]`;
  return `[replaced ${removed.length} chars]\n${added}`;
}

async function readObservedContent(target: string, mode: ObserveOptions['mode'], bm: BrowserManager): Promise<string> {
  const page = bm.getPage();
  const resolved = await bm.resolveRef(target);
  const locator: Locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);

  switch (mode) {
    case 'html':
      return await locator.innerHTML({ timeout: 5000 });
    case 'value':
      return await locator.evaluate((el) => {
        const candidate = el as HTMLInputElement | HTMLTextAreaElement;
        if (typeof candidate.value === 'string') return candidate.value;
        return (el as HTMLElement).innerText || el.textContent || '';
      });
    case 'text':
    default:
      return await locator.evaluate((el) => (el as HTMLElement).innerText || el.textContent || '');
  }
}


export async function handleReadCommand(
  command: string,
  args: string[],
  bm: BrowserManager
): Promise<string> {
  const page = bm.getPage();

  switch (command) {
    case 'text': {
      return await getCleanText(page);
    }

    case 'html': {
      const selector = args[0];
      if (selector) {
        const resolved = await bm.resolveRef(selector);
        if ('locator' in resolved) {
          return await resolved.locator.innerHTML({ timeout: 5000 });
        }
        return await page.innerHTML(resolved.selector);
      }
      return await page.content();
    }

    case 'links': {
      const links = await page.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.textContent?.trim().slice(0, 120) || '',
          href: (a as HTMLAnchorElement).href,
        })).filter(l => l.text && l.href)
      );
      return links.map(l => `${l.text} → ${l.href}`).join('\n');
    }

    case 'forms': {
      const forms = await page.evaluate(() => {
        return [...document.querySelectorAll('form')].map((form, i) => {
          const fields = [...form.querySelectorAll('input, select, textarea')].map(el => {
            const input = el as HTMLInputElement;
            return {
              tag: el.tagName.toLowerCase(),
              type: input.type || undefined,
              name: input.name || undefined,
              id: input.id || undefined,
              placeholder: input.placeholder || undefined,
              required: input.required || undefined,
              value: input.type === 'password' ? '[redacted]' : (input.value || undefined),
              options: el.tagName === 'SELECT'
                ? [...(el as HTMLSelectElement).options].map(o => ({ value: o.value, text: o.text }))
                : undefined,
            };
          });
          return {
            index: i,
            action: form.action || undefined,
            method: form.method || 'get',
            id: form.id || undefined,
            fields,
          };
        });
      });
      return JSON.stringify(forms, null, 2);
    }

    case 'accessibility': {
      const snapshot = await page.locator("body").ariaSnapshot();
      return snapshot;
    }

    case 'js': {
      const expr = args[0];
      if (!expr) throw new Error('Usage: browse js <expression>');
      const wrapped = wrapForEvaluate(expr);
      const result = await page.evaluate(wrapped);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'eval': {
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: browse eval <js-file>');
      validateReadPath(filePath);
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const code = fs.readFileSync(filePath, 'utf-8');
      const wrapped = wrapForEvaluate(code);
      const result = await page.evaluate(wrapped);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'css': {
      const [selector, property] = args;
      if (!selector || !property) throw new Error('Usage: browse css <selector> <property>');
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        const value = await resolved.locator.evaluate(
          (el, prop) => getComputedStyle(el).getPropertyValue(prop),
          property
        );
        return value;
      }
      const value = await page.evaluate(
        ([sel, prop]) => {
          const el = document.querySelector(sel);
          if (!el) return `Element not found: ${sel}`;
          return getComputedStyle(el).getPropertyValue(prop);
        },
        [resolved.selector, property]
      );
      return value;
    }

    case 'attrs': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse attrs <selector>');
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        const attrs = await resolved.locator.evaluate((el) => {
          const result: Record<string, string> = {};
          for (const attr of el.attributes) {
            result[attr.name] = attr.value;
          }
          return result;
        });
        return JSON.stringify(attrs, null, 2);
      }
      const attrs = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return `Element not found: ${sel}`;
        const result: Record<string, string> = {};
        for (const attr of el.attributes) {
          result[attr.name] = attr.value;
        }
        return result;
      }, resolved.selector);
      return typeof attrs === 'string' ? attrs : JSON.stringify(attrs, null, 2);
    }

    case 'console': {
      const { args: cmdArgs, redact } = extractRedactFlag(args);
      if (cmdArgs[0] === '--clear') {
        consoleBuffer.clear();
        return 'Console buffer cleared.';
      }
      const entries = cmdArgs[0] === '--errors'
        ? consoleBuffer.toArray().filter(e => e.level === 'error' || e.level === 'warning')
        : consoleBuffer.toArray();
      if (entries.length === 0) return cmdArgs[0] === '--errors' ? '(no console errors)' : '(no console messages)';
      const text = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n');
      return redactOutput(text, redact);
    }

    case 'network': {
      const { args: cmdArgs, redact } = extractRedactFlag(args);
      if (cmdArgs[0] === '--clear') {
        networkBuffer.clear();
        return 'Network buffer cleared.';
      }
      if (networkBuffer.length === 0) return '(no network requests)';
      const text = networkBuffer.toArray().map(e =>
        `${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n');
      return redactOutput(text, redact);
    }

    case 'websocket': {
      const { args: cmdArgs, redact } = extractRedactFlag(args);

      let clear = false;
      let tail = 0;
      let since: number | null = null;

      for (let i = 0; i < cmdArgs.length; i++) {
        const flag = cmdArgs[i];
        switch (flag) {
          case '--clear':
            clear = true;
            break;
          case '--tail': {
            const rawTail = cmdArgs[i + 1];
            tail = parseInt(rawTail, 10);
            if (!Number.isFinite(tail) || tail <= 0) {
              throw new Error('Usage: websocket [--clear] [--tail N] [--since N]');
            }
            i++;
            break;
          }
          case '--since': {
            const rawSince = cmdArgs[i + 1];
            since = parseInt(rawSince, 10);
            if (!Number.isFinite(since) || since < 0) {
              throw new Error('Usage: websocket [--clear] [--tail N] [--since N]');
            }
            i++;
            break;
          }
          default:
            throw new Error('Usage: websocket [--clear] [--tail N] [--since N]');
        }
      }

      if (clear) {
        websocketBuffer.clear();
        return 'WebSocket buffer cleared.';
      }

      if (tail > 0 && since !== null) {
        throw new Error('websocket: --tail and --since cannot be used together');
      }

      const entries = websocketBuffer.toArray();
      if (entries.length === 0) return '(no websocket activity)';

      const firstSeq = websocketBuffer.totalAdded - entries.length + 1;
      const entriesWithSeq = entries.map((entry, idx) => ({
        entry,
        seq: firstSeq + idx,
      }));

      let selected = entriesWithSeq;
      if (since !== null) {
        selected = selected.filter(({ seq }) => seq > since);
      }
      if (tail > 0) {
        selected = selected.slice(-tail);
      }

      if (since !== null && selected.length === 0) {
        return `(no websocket activity since ${since})\nNEXT_SINCE ${since}`;
      }

      const text = selected.map(({ entry, seq }) => {
        const timestamp = new Date(entry.timestamp).toISOString();
        const bytes = entry.payloadBytes ? ` (${entry.payloadBytes}B)` : '';
        const payload = entry.payload ? ` ${entry.payload}` : '';
        const error = entry.error ? ` ERROR: ${entry.error}` : '';
        const seqPrefix = since !== null ? `[#${seq}] ` : '';
        return `${seqPrefix}[${timestamp}] [${entry.direction}] ${entry.url}${bytes}${payload}${error}`;
      }).join('\n');

      if (since !== null) {
        const nextSince = selected[selected.length - 1]!.seq;
        return `${redactOutput(text, redact)}\nNEXT_SINCE ${nextSince}`;
      }

      return redactOutput(text, redact);
    }

    case 'dialog': {
      if (args[0] === '--clear') {
        dialogBuffer.clear();
        return 'Dialog buffer cleared.';
      }
      if (dialogBuffer.length === 0) return '(no dialogs captured)';
      return dialogBuffer.toArray().map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n');
    }

    case 'is': {
      const property = args[0];
      const selector = args[1];
      if (!property || !selector) throw new Error('Usage: browse is <property> <selector>\nProperties: visible, hidden, enabled, disabled, checked, editable, focused');

      const resolved = await bm.resolveRef(selector);
      let locator;
      if ('locator' in resolved) {
        locator = resolved.locator;
      } else {
        locator = page.locator(resolved.selector);
      }

      switch (property) {
        case 'visible':  return String(await locator.isVisible());
        case 'hidden':   return String(await locator.isHidden());
        case 'enabled':  return String(await locator.isEnabled());
        case 'disabled': return String(await locator.isDisabled());
        case 'checked':  return String(await locator.isChecked());
        case 'editable': return String(await locator.isEditable());
        case 'focused': {
          const isFocused = await locator.evaluate(
            (el) => el === document.activeElement
          );
          return String(isFocused);
        }
        default:
          throw new Error(`Unknown property: ${property}. Use: visible, hidden, enabled, disabled, checked, editable, focused`);
      }
    }

    case 'observe': {
      const { target, options } = parseObserveArgs(args);
      const startedAt = Date.now();
      let lastChangeAt = startedAt;
      let previous = '';
      const lines: string[] = [];
      let completedReason: 'stable' | 'timeout' = 'timeout';

      while (Date.now() - startedAt < options.durationMs) {
        const now = Date.now();
        const content = truncateTail(
          await readObservedContent(target, options.mode, bm),
          options.maxChars
        );
        const delta = computeDelta(previous, content);

        if (delta) {
          lines.push(JSON.stringify({
            type: 'delta',
            ts: new Date(now).toISOString(),
            full_len: content.length,
            delta: redactOutput(delta, options.redact),
          }));
          previous = content;
          lastChangeAt = now;
        } else {
          lines.push(JSON.stringify({
            type: 'heartbeat',
            ts: new Date(now).toISOString(),
            full_len: content.length,
          }));
        }

        if (now - lastChangeAt >= options.stableMs) {
          completedReason = 'stable';
          break;
        }

        await Bun.sleep(options.intervalMs);
      }

      lines.push(JSON.stringify({
        type: 'done',
        ts: new Date().toISOString(),
        reason: completedReason,
        full_len: previous.length,
        sample: redactOutput(truncateTail(previous, 1000), options.redact),
      }));

      return lines.join('\n');
    }

    case 'cookies': {
      const cookies = await page.context().cookies();
      return JSON.stringify(cookies, null, 2);
    }

    case 'storage': {
      if (args[0] === 'set' && args[1]) {
        const key = args[1];
        const value = args[2] || '';
        await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
        return `Set localStorage["${key}"]`;
      }
      const storage = await page.evaluate(() => ({
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      }));
      // Redact values that look like secrets (tokens, keys, passwords, JWTs)
      const SENSITIVE_KEY = /(^|[_.-])(token|secret|key|password|credential|auth|jwt|session|csrf)($|[_.-])|api.?key/i;
      const SENSITIVE_VALUE = /^(eyJ|sk-|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|sk-ant-|ghp_|gho_|github_pat_|xox[bpsa]-|AKIA[A-Z0-9]{16}|AIza|SG\.|Bearer\s|sbp_)/;
      const redacted = JSON.parse(JSON.stringify(storage));
      for (const storeType of ['localStorage', 'sessionStorage'] as const) {
        const store = redacted[storeType];
        if (!store) continue;
        for (const [key, value] of Object.entries(store)) {
          if (typeof value !== 'string') continue;
          if (SENSITIVE_KEY.test(key) || SENSITIVE_VALUE.test(value)) {
            store[key] = `[REDACTED — ${value.length} chars]`;
          }
        }
      }
      return JSON.stringify(redacted, null, 2);
    }

    case 'perf': {
      const timings = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (!nav) return 'No navigation timing data available.';
        return {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          ssl: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          domParse: Math.round(nav.domInteractive - nav.responseEnd),
          domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          total: Math.round(nav.loadEventEnd - nav.startTime),
        };
      });
      if (typeof timings === 'string') return timings;
      return Object.entries(timings)
        .map(([k, v]) => `${k.padEnd(12)} ${v}ms`)
        .join('\n');
    }

    default:
      throw new Error(`Unknown read command: ${command}`);
  }
}
