import { describe, expect, test } from 'bun:test';
import { redactOutput, truncateTail } from '../src/redaction';

describe('redaction', () => {
  test('redacts bearer tokens', () => {
    const input = 'Authorization: Bearer sk_test_abcdef123456';
    const output = redactOutput(input, true);
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('sk_test_abcdef123456');
  });

  test('redacts sensitive key-value pairs', () => {
    const input = 'token=abc123 session:xyz789 password=hunter2';
    const output = redactOutput(input, true);
    expect(output).toContain('token=[REDACTED]');
    expect(output).toContain('session:[REDACTED]');
    expect(output).toContain('password=[REDACTED]');
  });

  test('returns input unchanged when redaction disabled', () => {
    const input = 'token=abc123';
    expect(redactOutput(input, false)).toBe(input);
  });
});

describe('truncateTail', () => {
  test('returns tail when input exceeds maxChars', () => {
    expect(truncateTail('abcdefghij', 4)).toBe('ghij');
  });

  test('returns full string when within limit', () => {
    expect(truncateTail('abc', 10)).toBe('abc');
  });
});
