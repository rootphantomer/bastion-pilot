#!/usr/bin/env node
/**
 * BastionPilot mock bastion server — 静态页面 + 真实 WebSocket PTY 模拟。
 *
 * 用途：让浏览器扩展的 interceptor 真正拦截到 WebSocket（raw PTY 字节流），
 * 从而 hook 出可用的终端 session，本地联调无需真实堡垒机。
 *
 * 启动：node mocks/server.mjs [port] [product]   （默认 8899）
 * 访问：http://127.0.0.1:8899/
 *
 * WS 协议：ws://<host>/ws?host=<主机名>&prompt=<提示符>[&frame=guacamole][&enc=gb18030][&frag=1]
 *   - 下行：二进制帧，raw PTY 字节（默认 UTF-8，\r\n 换行）；frame=guacamole 时为
 *     `<len>.tes,<len>.<base64>;` 指令流，enc=gb18030 时 base64 前的字节按 GB18030 编码
 *     （与 mingyu V2.0 一致），frag=1 时把一条指令拆成多个帧下发（测试分帧重组）
 *   - 上行：文本/二进制帧 = 终端输入字节；guacamole 模式为 tes 指令，按 enc 解码
 *
 * 假 shell 尽量贴近 bash + readline，使扩展的命令执行语义可端到端验证：
 *   - 命令回显、提示符、`$?` 展开、`echo` 哨兵、`printf` 隐藏哨兵（含 \033 转义）
 *   - 括号粘贴标记（`\x1b[200~` / `\x1b[201~`）按 readline 行为吃掉、不落到命令行
 *   - CSI/OSC/APC 控制序列、退格、ctrl+c/u/d、上下箭头历史
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encodePty } from './gb18030.mjs';

const require = createRequire(
  path.join(fileURLToPath(import.meta.url), '..', '..', 'packages', 'bridge', 'package.json')
);
const { WebSocketServer } = require('ws');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 用法: node server.mjs [port] [product]
// product 指定时，'/' 直接跳到对应页面（便于每个产品一个独立端口/origin）。
const PORT = Number(process.argv[2] || 8899);
const PRODUCT = process.argv[3] || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' && PRODUCT) urlPath = `/${PRODUCT}.html`;
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + urlPath);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/* ---------------- GB18030 编码见 ./gb18030.mjs ---------------- */

/* ---------------- fake PTY ---------------- */

const DIR_NAMES = new Set([
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'opt',
  'proc',
  'root',
  'ssh',
  'tmp',
  'usr',
  'var',
  'app',
  'backup',
  'scripts',
]);

function makeShell(query) {
  const host = query.get('host') || 'web-01';
  const prompt = (query.get('prompt') || `root@${host}:~# `).replace(/\\e/g, '');
  const banner = query.get('banner') || '';
  const note = query.get('note') || '';
  const state = {
    host,
    prompt,
    banner,
    note,
    line: '',
    hist: [],
    histIdx: 0,
    cwd: '~',
    closed: false,
    lastExit: 0,
  };

  const out = [];
  function w(s) {
    out.push(s);
  }
  function nl() {
    out.push('\r\n');
  }
  function ps1() {
    w(state.prompt);
  }

  const FS = {
    '~': ['deploy.log', 'monitor.sh', 'notes.txt'],
    '/': ['bin', 'boot', 'dev', 'etc', 'home', 'opt', 'proc', 'root', 'tmp', 'usr', 'var'],
    '/etc': ['hosts', 'passwd', 'ssh', 'system-release'],
    '/opt': ['app', 'backup', 'scripts'],
    '/var/log': ['secure', 'messages', 'audit.log'],
  };

  const LOGS = {
    'deploy.log': [
      '2025-10-06 09:12:41 [INFO] deploy web-01 revision 8f3c2a1',
      '2025-10-06 09:12:58 [INFO] healthcheck ok (200)',
      '2025-10-06 09:13:02 [WARN] upstream 10.0.0.21 slow: 812ms',
      '2025-10-06 09:13:10 [INFO] deploy finished in 29s',
    ],
    '/var/log/secure': [
      'Oct  6 09:58:11 web-01 sshd[2211]: Accepted password for deploy from 10.0.0.100 port 51422 ssh2',
      'Oct  6 09:58:11 web-01 sshd[2211]: pam_unix(sshd:session): session opened for user deploy',
      'Oct  6 10:00:07 web-01 sshd[2244]: Failed password for invalid user test from 10.0.0.66 port 40011 ssh2',
      'Oct  6 10:00:09 web-01 sshd[2244]: Connection closed by invalid user test 10.0.0.66',
    ],
    '/var/log/messages': [
      'Oct  6 09:40:02 web-01 systemd[1]: Started Session 12 of user deploy.',
      'Oct  6 09:41:15 web-01 kernel: [ 3211.442] EXT4-fs (vda1): mounted filesystem',
    ],
    '/var/log/audit.log': [
      'type=USER_LOGIN msg=audit(1759716491.221:118): pid=2211 uid=0 auid=1000 ses=3 msg=\'op=login acct="deploy" exe="/usr/sbin/sshd" hostname=10.0.0.100 addr=10.0.0.100 terminal=ssh res=success\'',
    ],
  };

  /** 去掉最外层引号（mock 简化：不处理嵌套与转义）。 */
  const unquote = (s) => s.replace(/^(['"])([\s\S]*)\1$/, '$2');
  /** 变量展开：只支持 $?（上一条命令退出码）。 */
  const expand = (s) => s.replace(/\$\?/g, String(state.lastExit));
  const argsOf = (args) => args.map((a) => expand(unquote(a)));

  const commands = {
    help() {
      w('Mock shell — 可用命令：');
      nl();
      w('  help  ls  pwd  whoami  id  hostname  uname  date  uptime  df  free');
      nl();
      w('  echo  printf  cat  tail  history  clear  true  false  exit');
      nl();
      w('  支持 cmd1 && cmd2 / cmd1 ; cmd2 串联、$? 退出码展开、括号粘贴与 printf 转义。');
      nl();
      w('所有输出均为 mock 数据，中文用于验证 GB18030 编码。');
      nl();
      return 0;
    },
    ls(args) {
      const flags = args.filter((a) => a.startsWith('-'));
      const targets = args.filter((a) => !a.startsWith('-'));
      const raw = targets[0] || state.cwd;
      const target = raw === '.' ? state.cwd : raw;
      const items = FS[target];
      if (!items) {
        w(`ls: cannot access '${raw}': No such file or directory`);
        nl();
        return 2;
      }
      if (flags.some((f) => f.includes('l'))) {
        w(`total ${items.length * 4}`);
        nl();
        for (const name of items) {
          const isDir = DIR_NAMES.has(name);
          const size = isDir ? 4096 : 512 + name.length * 137;
          w(
            `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 root root ${String(size).padStart(6)} Oct  6 09:12 ${name}`
          );
          nl();
        }
        return 0;
      }
      w(items.join('  '));
      nl();
      return 0;
    },
    pwd() {
      w(state.cwd === '~' ? '/root' : state.cwd);
      nl();
      return 0;
    },
    whoami() {
      w('root');
      nl();
      return 0;
    },
    id() {
      w('uid=0(root) gid=0(root) groups=0(root)');
      nl();
      return 0;
    },
    hostname() {
      w(state.host);
      nl();
      return 0;
    },
    uname(args) {
      if (args[0] === '-a') {
        w(
          `Linux ${state.host} 4.19.91-27.1.an8.x86_64 #1 SMP mock Mon Oct 6 10:00:00 UTC 2025 x86_64 GNU/Linux`
        );
        nl();
      } else (w('Linux'), nl());
      return 0;
    },
    date() {
      w(new Date().toString());
      nl();
      return 0;
    },
    uptime() {
      w(
        ` ${new Date().toTimeString().slice(0, 8)} up 32 days,  4:12,  2 users,  load average: 0.15, 0.10, 0.05`
      );
      nl();
      return 0;
    },
    df(args) {
      if (args[0] !== '-h') {
        w('Filesystem     1K-blocks     Used Available Use% Mounted on');
        nl();
        w('/dev/vda1       41922540 24117248 17805292  58% /');
        nl();
        return 0;
      }
      w('Filesystem      Size  Used Avail Use% Mounted on');
      nl();
      w('devtmpfs        3.8G     0  3.8G   0% /dev');
      nl();
      w('/dev/vda1        40G   23G   17G  58% /');
      nl();
      w('tmpfs           7.6G     0  7.6G   0% /dev/shm');
      nl();
      return 0;
    },
    free(args) {
      const m = args[0] === '-m';
      w('              total        used        free      shared  buff/cache   available');
      nl();
      w(
        m
          ? 'Mem:           7809        2314        3105         128        2390        5121'
          : 'Mem:            7.9Gi       2.3Gi       3.0Gi       125Mi       2.3Gi       5.0Gi'
      );
      nl();
      w(
        m
          ? 'Swap:          2047           0        2047'
          : 'Swap:           2.0Gi          0B       2.0Gi'
      );
      nl();
      return 0;
    },
    echo(args) {
      w(argsOf(args).join(' '));
      nl();
      return 0;
    },
    /**
     * printf 只实现 mock 需要的子集：\n \t \r \e \\ \0NNN 与 %s %d %%。
     * 扩展的隐藏哨兵依赖 `printf '\033[1A\033[2K\033___BP_x_%s__\033\\' $?`。
     */
    printf(args) {
      if (args.length === 0) {
        w('printf: usage: printf format [arguments]');
        nl();
        return 1;
      }
      const fmt = unquote(args[0]);
      const rest = argsOf(args.slice(1));
      let text = '';
      let argIndex = 0;
      for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i];
        if (ch === '\\') {
          const esc = fmt[i + 1];
          i += 1;
          if (esc === undefined) break;
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === 'e' || esc === 'E') text += '\x1b';
          else if (esc === 'a') text += '\x07';
          else if (esc === '\\') text += '\\';
          else if (esc >= '0' && esc <= '7') {
            let digits = esc;
            while (digits.length < 3 && fmt[i + 1] >= '0' && fmt[i + 1] <= '7') {
              digits += fmt[i + 1];
              i += 1;
            }
            text += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
          } else text += esc;
        } else if (ch === '%') {
          const spec = fmt[i + 1];
          if (spec === '%') {
            text += '%';
            i += 1;
          } else if (spec === 's') {
            text += rest[argIndex++] ?? '';
            i += 1;
          } else if (spec === 'd') {
            text += String(Number.parseInt(rest[argIndex++] ?? '0', 10) || 0);
            i += 1;
          } else text += '%';
        } else text += ch;
      }
      w(text.replace(/\r?\n/g, '\r\n')); // 模拟 PTY 的 ONLCR
      return 0;
    },
    true() {
      return 0;
    },
    false() {
      return 1;
    },
    cat(args) {
      if (!args[0]) {
        w('cat: missing operand');
        nl();
        return 1;
      }
      const name = unquote(args[0]);
      if (name === '/etc/hosts') {
        w('127.0.0.1   localhost localhost.localdomain');
        nl();
        w(`10.0.0.11   ${state.host}`);
        nl();
        return 0;
      }
      if (name === '/etc/hostname') {
        w(state.host);
        nl();
        return 0;
      }
      if (name === '/etc/system-release') {
        w('Anolis OS release 8.8 (mock)');
        nl();
        return 0;
      }
      const lines = LOGS[name];
      if (lines) {
        for (const line of lines) {
          w(line);
          nl();
        }
        return 0;
      }
      w(`cat: ${name}: No such file or directory`);
      nl();
      return 1;
    },
    tail(args) {
      let count = 10;
      let file = '';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-n') {
          count = Number(args[i + 1]) || 10;
          i += 1;
          continue;
        }
        if (args[i].startsWith('-')) continue;
        file = unquote(args[i]);
      }
      if (!file) {
        w('tail: missing file operand');
        nl();
        return 1;
      }
      const lines = LOGS[file];
      if (!lines) {
        w(`tail: cannot open '${file}' for reading: No such file or directory`);
        nl();
        return 1;
      }
      for (const line of lines.slice(-count)) {
        w(line);
        nl();
      }
      return 0;
    },
    history() {
      state.hist.forEach((c, i) => w(`  ${String(i + 1).padStart(4)}  ${c}\r\n`));
      return 0;
    },
    clear() {
      w('\x1b[2J\x1b[H');
      return 0;
    },
    exit() {
      w('logout');
      nl();
      w(`Connection to ${state.host} closed.`);
      nl();
      state.closed = true;
      return 0;
    },
  };

  function exec(raw) {
    const line = raw.trim();
    if (!line) return;
    state.hist.push(line);
    state.histIdx = state.hist.length;
    let rc = 0;
    // 先按 ';' 分段（无条件执行），每段内再按 '&&' 串联（失败即停）
    for (const clause of line.split(';')) {
      const trimmed = clause.trim();
      if (!trimmed) continue;
      for (const seg of trimmed.split('&&')) {
        const parts = seg.trim().split(/\s+/);
        const cmd = parts[0];
        const args = parts.slice(1);
        if (commands[cmd]) rc = commands[cmd](args) ?? 0;
        else {
          w(`bash: ${cmd}: command not found`);
          nl();
          rc = 127;
        }
        if (rc !== 0) break;
      }
    }
    state.lastExit = rc;
    return rc;
  }

  function eraseChars(count) {
    for (let k = 0; k < count; k++) w('\b \b');
  }

  function historyMove(dir) {
    eraseChars(state.line.length);
    if (dir === 'A') {
      if (state.histIdx > 0) state.histIdx -= 1;
    } else if (state.histIdx < state.hist.length) state.histIdx += 1;
    state.line = state.hist[state.histIdx] ?? '';
    w(state.line);
  }

  /**
   * 消费一个 ESC 起始的控制序列，返回序列最后一个字符的下标。
   * 括号粘贴标记、方向键、OSC/APC 都按终端行为处理：不落到命令行。
   */
  function escapeEnd(data, start) {
    const next = data[start + 1];
    if (next === '[') {
      let j = start + 2;
      while (j < data.length && !(data[j] >= '@' && data[j] <= '~')) j += 1;
      if (j >= data.length) return data.length;
      const final = data[j];
      const body = data.slice(start + 2, j);
      if (final === 'A' || final === 'B') historyMove(final);
      // '200~' / '201~' = bracketed paste 开始/结束，readline 会吃掉
      return j;
    }
    if (next === 'O') return Math.min(start + 2, data.length);
    if (next === ']' || next === 'P' || next === '^' || next === '_') {
      let j = start + 2;
      while (j < data.length) {
        if (data[j] === '\x07') return j;
        if (data[j] === '\x1b' && data[j + 1] === '\\') return j + 1;
        j += 1;
      }
      return data.length;
    }
    return start + 1;
  }

  return {
    /** 处理终端输入字节，返回要写回 PTY 的输出 */
    feed(data) {
      out.length = 0;
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (state.closed) break;
        if (ch === '\r' || ch === '\n') {
          nl();
          exec(state.line);
          state.line = '';
          if (!state.closed) ps1();
        } else if (ch === '\x7f' || ch === '\b') {
          // backspace
          if (state.line.length > 0) {
            state.line = state.line.slice(0, -1);
            w('\b \b');
          }
        } else if (ch === '\x03') {
          // ctrl+c
          w('^C');
          nl();
          state.line = '';
          ps1();
        } else if (ch === '\x15') {
          // ctrl+u
          eraseChars(state.line.length);
          state.line = '';
        } else if (ch === '\x04') {
          // ctrl+d
          if (state.line.length === 0) {
            w('logout');
            nl();
            state.closed = true;
          }
        } else if (ch === '\x1b') {
          i = escapeEnd(data, i);
        } else if (ch >= ' ') {
          state.line += ch;
          w(ch);
        }
      }
      const text = out.join('');
      return state.closed ? null : Buffer.from(text, 'utf8');
    },
    banner() {
      const lines = [];
      if (state.banner) lines.push(state.banner);
      if (state.note) lines.push(state.note);
      lines.push(`Linux ${state.host} 4.19.91-27.1.an8.x86_64 (mock PTY)`);
      lines.push('Last login: Mon Oct  6 10:00:00 2025 from 10.0.0.100');
      lines.push("Type 'help' for mock commands.");
      return lines.join('\r\n') + '\r\n' + state.prompt;
    },
    closed() {
      return state.closed;
    },
  };
}

/* ---------------- WebSocket PTY ---------------- */

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const params = url.searchParams;
  const guac = params.get('frame') === 'guacamole';
  const encoding = params.get('enc') === 'gb18030' ? 'gb18030' : 'utf-8';
  const frag = params.get('frag') === '1' || params.get('frag') === 'true';
  const shell = makeShell(params);

  // raw PTY 字节 → guacamole 指令: <len>.tes,<len>.<base64>;（与 mingyu V2.0 一致）
  const wrapGuac = (buf) => {
    const b64 = encodePty(buf.toString('utf8'), encoding).toString('base64');
    return `${3}.tes,${b64.length}.${b64};`;
  };

  // frag=1：把一条指令拆成多帧发送，验证扩展 framer 的 carry 缓冲
  const queue = [];
  let pumping = false;
  const splitFragments = (text) => {
    if (text.length < 40) return [text];
    const cuts = [Math.round(text.length * 0.42), Math.round(text.length * 0.78)]
      .filter((cut) => cut > 0 && cut < text.length)
      .concat(text.length);
    const pieces = [];
    let prev = 0;
    for (const cut of cuts) {
      if (cut > prev) {
        pieces.push(text.slice(prev, cut));
        prev = cut;
      }
    }
    return pieces;
  };
  const pump = () => {
    if (pumping) return;
    const text = queue.shift();
    if (!text) return;
    pumping = true;
    const pieces = splitFragments(text);
    let index = 0;
    const step = () => {
      if (ws.readyState !== 1) {
        queue.length = 0;
        pumping = false;
        return;
      }
      ws.send(pieces[index]);
      index += 1;
      if (index < pieces.length) setTimeout(step, 12);
      else {
        pumping = false;
        pump();
      }
    };
    step();
  };

  const sendPty = (buf) => {
    if (!guac) {
      ws.send(buf);
      return;
    }
    const instruction = wrapGuac(buf);
    if (!frag) {
      ws.send(instruction);
      return;
    }
    queue.push(instruction);
    pump();
  };

  // 解析上游 guacamole 指令流，抽取 tes 载荷（base64）得到终端输入
  const makeUpDecoder = () => {
    let carry = '';
    const gbDecoder = encoding === 'gb18030' ? new TextDecoder('gb18030') : null;
    const utf8Strict = encoding === 'gb18030' ? new TextDecoder('utf-8', { fatal: true }) : null;
    return (text) => {
      carry += text;
      const payloads = [];
      for (;;) {
        // 逐个读取 <len>.<value> 元素，直到 ';' 结束一条指令
        const elements = [];
        let pos = 0;
        let done = false;
        let malformed = false;
        for (;;) {
          const rest = carry.slice(pos);
          const dot = rest.indexOf('.');
          if (dot === -1 || dot > 12) {
            done = true;
            break;
          } // incomplete
          const len = Number(rest.slice(0, dot));
          if (!Number.isSafeInteger(len) || len < 0 || len > 10_000_000) {
            malformed = true;
            break;
          }
          if (rest.length < dot + 1 + len) {
            done = true;
            break;
          } // incomplete
          elements.push(rest.slice(dot + 1, dot + 1 + len));
          pos += dot + 1 + len;
          const sep = carry[pos];
          if (sep === ',') {
            pos += 1;
            continue;
          }
          if (sep === ';') {
            pos += 1;
            break;
          }
          if (sep === undefined) {
            done = true;
            break;
          }
          malformed = true;
          break;
        }
        if (malformed) {
          carry = carry.slice(pos + 1);
          continue;
        }
        if (done) break;
        carry = carry.slice(pos);
        if (elements[0] === 'tes' && elements[1]) {
          try {
            payloads.push(Buffer.from(elements[1], 'base64'));
          } catch {
            /* skip */
          }
        }
        if (carry.length === 0) break;
      }
      if (payloads.length === 0) return '';
      const bytes = Buffer.concat(payloads);
      if (!gbDecoder || !utf8Strict) return bytes.toString('utf8');
      // 上行输入宽松解码：先按 UTF-8，失败再按 GB18030。
      // 扩展的 guacamole framer 目前固定用 UTF-8 发送输入（下游自动识别不回写），
      // 宽松处理可让 Agent 直接输入中文命令而不必先修扩展。
      try {
        return utf8Strict.decode(bytes);
      } catch {
        return gbDecoder.decode(bytes, { stream: true });
      }
    };
  };
  const decodeUp = guac ? makeUpDecoder() : null;

  // 横幅按行下发（真实 PTY 也是分块读出的）：guacamole 下每行一条 tes 指令，
  // 避免"只有一帧文本"时扩展的终端识别启发式（需要 ≥2 个文本帧）漏掉会话。
  const bannerText = shell.banner();
  if (guac) {
    const lines = bannerText.split('\r\n');
    lines.forEach((line, index) => {
      const piece = index === lines.length - 1 ? line : `${line}\r\n`;
      if (piece) sendPty(Buffer.from(piece, 'utf8'));
    });
  } else {
    sendPty(encodePty(bannerText, encoding));
  }
  ws.on('message', (raw) => {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const keys = decodeUp ? decodeUp(text) : text;
    if (!keys) return;
    const chunk = shell.feed(keys);
    if (chunk && chunk.length) {
      sendPty(guac ? chunk : encodePty(chunk.toString('utf8'), encoding));
    }
    if (shell.closed()) ws.close();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const suffix = PRODUCT ? ` (${PRODUCT})` : '';
  console.log(`[mock] bastion mock server${suffix}: http://127.0.0.1:${PORT}/`);
  console.log(`[mock] WS PTY:         ws://127.0.0.1:${PORT}/ws`);
});
