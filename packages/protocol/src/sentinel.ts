/**
 * Completion sentinel for shell commands.
 *
 * After typing the user command, BastionPilot appends a sentinel that reports
 * the exit code. Two forms are available:
 *
 *   echo __BP_<nonce>_$?__                                      (default, visible)
 *   printf '\033[1A\033[2K\033___BP_<nonce>_%s__\033\\' $?      (hidden)
 *
 * The hidden form erases the shell's echo of the sentinel line and carries the
 * exit code inside an APC string (`ESC _ ... ESC \`), which xterm-compatible
 * terminals consume without drawing. The marker is therefore only present in
 * the raw PTY stream, never in rendered output.
 *
 * In both forms the literal `$?` / `%s` in the echoed input never matches the
 * result regex (which requires digits), so only the *executed* sentinel can
 * resolve the wait.
 */

const NONCE_RE = /^[0-9a-f]{8}$/;

export function newSentinelNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidNonce(nonce: string): boolean {
  return NONCE_RE.test(nonce);
}

/**
 * The shell command appended after the user command.
 *
 * `hidden` keeps the sentinel out of the visible terminal view. It defaults to
 * `false`, so commands use the legacy visible `echo` form unless the user opts
 * into the invisible marker in extension settings.
 */
export function sentinelCommandFor(nonce: string, hidden = false): string {
  if (!isValidNonce(nonce)) throw new Error(`invalid sentinel nonce: ${nonce}`);
  return hidden
    ? `printf '\\033[1A\\033[2K\\033___BP_${nonce}_%s__\\033\\\\' $?`
    : `echo __BP_${nonce}_$?__`;
}

/**
 * Full payload to type into the terminal for a command execution:
 * the command, then the sentinel echo, each on its own line.
 */
export function wrapCommandWithSentinel(command: string, nonce: string, hidden = false): string {
  const cmd = stripTrailingNewlines(command);
  return `${cmd}\n${sentinelCommandFor(nonce, hidden)}\n`;
}

/**
 * Remove trailing newlines without a backtracking regex. `/\n+$/` is
 * polynomial on long newline runs that do not end the string, so a plain
 * backwards scan keeps this linear.
 */
export function stripTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

export function sentinelRegexFor(nonce: string): RegExp {
  if (!isValidNonce(nonce)) throw new Error(`invalid sentinel nonce: ${nonce}`);
  return new RegExp(`__BP_${nonce}_(\\d+)__`);
}

/** Extract the exit code from terminal output for the given nonce, if present. */
export function extractExitCode(text: string, nonce: string): number | null {
  const m = sentinelRegexFor(nonce).exec(text);
  if (!m) return null;
  const code = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(code) ? code : null;
}
