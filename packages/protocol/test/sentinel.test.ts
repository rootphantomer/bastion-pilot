import { describe, expect, it } from 'vitest';
import {
  extractExitCode,
  isValidNonce,
  newSentinelNonce,
  sentinelCommandFor,
  sentinelRegexFor,
  wrapCommandWithSentinel,
} from '../src/sentinel.js';

const HIDDEN_SENTINEL = "printf '\\033[1A\\033[2K\\033___BP_ab12cd34_%s__\\033\\\\' $?";

describe('sentinel', () => {
  it('generates valid 8-hex nonces', () => {
    for (let i = 0; i < 20; i++) {
      const n = newSentinelNonce();
      expect(isValidNonce(n)).toBe(true);
    }
  });

  it('wraps a command with trailing-newline normalization', () => {
    expect(wrapCommandWithSentinel('ls -la\n\n\n', 'ab12cd34')).toBe(
      'ls -la\necho __BP_ab12cd34_$?__\n'
    );
  });

  it('builds the echo command with literal $?', () => {
    expect(sentinelCommandFor('ab12cd34')).toBe('echo __BP_ab12cd34_$?__');
  });

  it('builds a hidden sentinel that erases its echo and hides the marker in an APC string', () => {
    expect(sentinelCommandFor('ab12cd34', true)).toBe(HIDDEN_SENTINEL);
    expect(HIDDEN_SENTINEL).toContain('\\033[1A\\033[2K');
    expect(HIDDEN_SENTINEL).toContain('\\033___BP_ab12cd34_%s__\\033\\\\');
    expect(HIDDEN_SENTINEL.endsWith('$?')).toBe(true);
  });

  it('wraps a command with the hidden sentinel when requested', () => {
    expect(wrapCommandWithSentinel('ls -la\n\n', 'ab12cd34', true)).toBe(
      `ls -la\n${HIDDEN_SENTINEL}\n`
    );
    expect(wrapCommandWithSentinel('ls -la', 'ab12cd34', false)).toBe(
      'ls -la\necho __BP_ab12cd34_$?__\n'
    );
  });

  it('extracts exit code 0 from output', () => {
    const out = [
      'file1  file2',
      'echo __BP_ab12cd34_$?__', // echoed input line — must NOT match
      '__BP_ab12cd34_0__',
      'prompt$ ',
    ].join('\n');
    expect(extractExitCode(out, 'ab12cd34')).toBe(0);
  });

  it('extracts non-zero exit codes', () => {
    const out = 'something\n__BP_ab12cd34_127__\n';
    expect(extractExitCode(out, 'ab12cd34')).toBe(127);
  });

  it('does not match the echoed command containing literal $?', () => {
    expect(extractExitCode('echo __BP_ab12cd34_$?__\n', 'ab12cd34')).toBeNull();
  });

  it('extracts the exit code from the hidden APC marker', () => {
    expect(extractExitCode('\x1b___BP_ab12cd34_0__\x1b\\', 'ab12cd34')).toBe(0);
    expect(extractExitCode('\x1b___BP_ab12cd34_130__\x1b\\', 'ab12cd34')).toBe(130);
  });

  it('does not match the echoed hidden command containing literal %s', () => {
    expect(extractExitCode(`${HIDDEN_SENTINEL}\n`, 'ab12cd34')).toBeNull();
  });

  it('returns null when the sentinel has not appeared yet', () => {
    expect(extractExitCode('partial output still running', 'ab12cd34')).toBeNull();
  });

  it('rejects invalid nonces', () => {
    expect(isValidNonce('zz')).toBe(false);
    expect(() => sentinelCommandFor('NOT-VALID')).toThrow();
    expect(() => sentinelRegexFor('gogogo')).toThrow();
  });
});
