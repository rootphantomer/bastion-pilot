import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANHENG_MINGYU_PROFILE } from '../src/profiles.js';
import { TerminalSession } from '../src/content/session.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function readStatic(path: string): string {
  return fs.readFileSync(new URL(`../static/${path}`, import.meta.url), 'utf8');
}

function readSource(path: string): string {
  return fs.readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

/** One Guacamole instruction: `<len>.<opcode>,<len>.<arg>;`. */
function guac(opcode: string, arg: string): string {
  return `${opcode.length}.${opcode},${arg.length}.${arg};`;
}

function guacTes(text: string): string {
  return guac('tes', Buffer.from(text, 'utf8').toString('base64'));
}

/** "中文\n" encoded as GB18030. */
function guacGb18030(): string {
  return guac('tes', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]).toString('base64'));
}

function parseTes(frame: string): string {
  const match = /^\d+\.tes,\d+\.([^;]+);$/.exec(frame);
  if (!match) throw new Error(`not a tes frame: ${frame}`);
  return Buffer.from(match[1]!, 'base64').toString('utf8');
}

function makeMingyuSession() {
  const writes: string[] = [];
  const session = new TerminalSession(
    'ws_mingyu',
    ANHENG_MINGYU_PROFILE,
    (data) => writes.push(typeof data === 'string' ? data : decoder.decode(data as ArrayBuffer)),
    'https://mingyu.example.com/terminal',
    'mingyu',
    {
      bracketedPaste: ANHENG_MINGYU_PROFILE.io?.bracketedPaste,
      cleanOutput: ANHENG_MINGYU_PROFILE.io?.cleanOutput,
    }
  );
  return {
    session,
    writes,
    feed: (text: string) => session.feed(encoder.encode(text).buffer),
  };
}

describe('Mingyu smoke', () => {
  it('assembles a Guacamole instruction split across frames', () => {
    const h = makeMingyuSession();
    const frame = guacTes('中文输出\r\n');
    h.feed(frame.slice(0, 9));
    h.feed(frame.slice(9));
    expect(h.session.readText(0, 10_000).text).toContain('中文输出');
  });

  it('auto-detects GB18030 terminal output', () => {
    const h = makeMingyuSession();
    h.feed(guacGb18030());
    expect(h.session.readText(0, 10_000).text).toContain('中文');
  });

  it('executes a command through the Guacamole framer and cleans its output', async () => {
    const h = makeMingyuSession();
    const promise = h.session.executeCommand('ls -la', { waitMs: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const written = parseTes(h.writes[0] ?? '');
    expect(written).toContain('ls -la');
    const nonce = /__BP_([0-9a-f]{8})_\$\?__/.exec(written)?.[1];
    expect(nonce).toBeTruthy();

    h.feed(
      guacTes(['ls -la', 'total 8', 'file1.txt', `__BP_${nonce}_0__`, 'prompt$ ', ''].join('\r\n'))
    );

    const result = await promise;
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('file1.txt');
    expect(result.text).not.toContain('__BP_');
    expect(result.text).not.toContain('ls -la');
  });
});

describe('extension removal smoke', () => {
  it('keeps the options page free of remote AI provider configuration', () => {
    const html = readStatic('options.html');
    expect(html).not.toMatch(/AI 服务商|provider-list|add-provider-btn|save-providers-btn/);
    expect(html).toContain('本地服务');
    expect(html).toContain('堡垒机站点');
    expect(html).toContain('审批与审计');
    expect(html).toContain('本地 Agent 与会话');

    const source = readSource('options/main.ts');
    expect(source).not.toMatch(/provider_(configs|models)_(get|update)/);
    expect(source).not.toContain('apiKey');
  });

  it('exposes the hidden-sentinel switch on the options page', () => {
    const html = readStatic('options.html');
    expect(html).toContain('id="hidden-sentinel"');
    expect(html).toContain('命令完成标记不脏屏');

    const source = readSource('options/main.ts');
    expect(source).toMatch(/hiddenSentinel/);
    expect(source).toMatch(/chrome\.storage\.sync\s*\.set/);

    const controller = readSource('content/controller.ts');
    expect(controller).toContain('setHiddenSentinel');
    expect(controller).toMatch(/hiddenSentinel:\s*this\.settings\?\.hiddenSentinel === true/);
  });

  it('keeps the side panel approval-only with no chat controls', () => {
    const html = readStatic('sidepanel.html');
    expect(html).not.toMatch(
      /id="(input|send-btn|abort-btn|chat-mode|agent-select|new-chat)"|<textarea/
    );
    expect(html).toContain('id="approvals"');
    expect(html).not.toContain('id="approval-history"');
    expect(html).toContain('id="activity"');
    expect(html).toContain('id="mode-status"');
    expect(html).toContain('panel-footer');
  });

  it('keeps approvals and live shared context while dropping panel chat and history', () => {
    const source = readSource('background/service-worker.ts');
    expect(source).not.toMatch(/daemon\.send\(\s*['"]chat_(new|message|abort)['"]/);
    expect(source).not.toMatch(/case ['"]agent-message['"]/);
    expect(source).toMatch(/daemon\.send\(\s*['"]approval_response['"]/);
    expect(source).not.toMatch(/case ['"]get-shared-context['"]/);
    expect(source).not.toContain("case 'approval_history'");

    // The panel is session-only: it renders live shared-context events and
    // never replays history, so closing it clears the transcript.
    const panel = readSource('sidepanel/main.ts');
    expect(panel).toContain("case 'shared_context_event'");
    expect(panel).not.toContain('get-shared-context');
    expect(panel).not.toContain('shared_context_replay');
  });
});
