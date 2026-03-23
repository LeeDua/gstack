/**
 * Output redaction helpers.
 *
 * Keeps debugging context while masking obvious secrets before model consumption.
 */

interface RedactionRule {
  pattern: RegExp;
  replacer: string | ((substring: string, ...args: any[]) => string);
}

const BASE_RULES: RedactionRule[] = [
  {
    // Authorization: Bearer xxx
    pattern: /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacer: '$1 [REDACTED]',
  },
  {
    // Generic key=value for sensitive keys
    pattern: /\b(authorization|token|session|csrf|api[-_]?key|secret|password|credential)\b(\s*[:=]\s*)([^\s"',;]+)/gi,
    replacer: '$1$2[REDACTED]',
  },
  {
    // JWT-like tokens
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacer: '[REDACTED_JWT]',
  },
  {
    // Common API token prefixes
    pattern: /\b(sk_live_|sk_test_|xox[baprs]-|ghp_|gho_|github_pat_)[A-Za-z0-9_\-]{8,}\b/gi,
    replacer: '$1[REDACTED]',
  },
  {
    // AWS access key id
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacer: 'AKIA[REDACTED]',
  },
];

function loadExtraRules(): RedactionRule[] {
  const raw = process.env.BROWSE_REDACT_EXTRA_PATTERNS;
  if (!raw) return [];
  try {
    const patterns = JSON.parse(raw);
    if (!Array.isArray(patterns)) return [];
    return patterns
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => ({ pattern: new RegExp(p, 'gi'), replacer: '[REDACTED_CUSTOM]' }));
  } catch {
    return [];
  }
}

const EXTRA_RULES = loadExtraRules();

export function redactOutput(input: string, enabled: boolean = true): string {
  if (!enabled || !input) return input;
  let redacted = input;
  for (const rule of BASE_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacer as any);
  }
  for (const rule of EXTRA_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacer as any);
  }
  return redacted;
}

export function truncateTail(input: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (input.length <= maxChars) return input;
  return input.slice(input.length - maxChars);
}

