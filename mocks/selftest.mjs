#!/usr/bin/env node
/**
 * mock PTY 自检：不依赖浏览器，直接验证 WebSocket 协议行为。
 *
 * 用法：node mocks/selftest.mjs [port]     （默认 8906）
 *
 * 覆盖：
 *   1. raw 帧 — 连接横幅 + 命令回显 + 输出
 *   2. guacamole/UTF-8 — tes 指令收发
 *   3. guacamole/GB18030 — 中文输出按 GB18030 编码，输入同样按 GB18030 解码
 *   4. 括号粘贴 + 可见哨兵 — 扩展的 bracketed-paste 探针与 `echo __BP_..._$?__`
 *   5. printf 隐藏哨兵 — `\033[1A\033[2K\033___BP_...__\033\\` 的转义处理
 *   6. 分片下发（frag=1）— 一条指令拆多帧，客户端重组后仍可执行命令
 *
 * 退出码 0 表示全部通过。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encodePty } from './gb18030.mjs';

const require = createRequire(path.join(fileURLToPath(import.meta.url), '..', '..', 'packages', 'bridge', 'package.json'));
const { WebSocket } = require('ws');

const PORT = Number(process.argv[2] || 8906);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '✔' : '✘';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 一条连接的收包缓冲：原文 + guacamole tes 载荷解码后的字节。 */
function openSocket(query, encoding = 'utf-8') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${query}`);
    const state = { ws, raw: '', text: '', bytes: Buffer.alloc(0), carry: '', frameCount: 0 };
    const decoder = encoding === 'gb18030' ? new TextDecoder('gb18030') : null;
    const guac = query.includes('frame=guacamole');

    ws.on('open', () => setTimeout(() => resolve(state), 60));
    ws.on('error', reject);
    ws.on('message', (data) => {
      state.frameCount += 1;
      const isBuffer = Buffer.isBuffer(data);
      state.raw += isBuffer ? data.toString('utf8') : String(data);
      if (!guac) return;
      state.carry += isBuffer ? data.toString('utf8') : String(data);
      // 解析 tes 载荷（可能与扩展一样跨帧）
      for (;;) {
        const match = /^(\d+)\.([a-z]+),(\d+)\.([A-Za-z0-9+/=]*);/.exec(state.carry);
        if (!match) break;
        state.carry = state.carry.slice(match[0].length);
        if (match[2] !== 'tes') continue;
        const bytes = Buffer.from(match[4], 'base64');
        state.bytes = Buffer.concat([state.bytes, bytes]);
        state.text += decoder ? decoder.decode(bytes, { stream: true }) : bytes.toString('utf8');
      }
    });
  });
}

function closeSocket(state) {
  try { state.ws.close(); } catch { /* ignore */ }
}

function tes(text, encoding = 'utf-8') {
  const b64 = encodePty(text, encoding).toString('base64');
  return `3.tes,${b64.length}.${b64};`;
}

function waitFor(state, predicate, timeout = 1200) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate(state)) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > timeout) { clearInterval(timer); resolve(false); }
    }, 20);
  });
}

async function main() {
  // 1. raw 帧
  {
    const s = await openSocket('host=web-01&prompt=web-01%20~%20%24%20&banner=mingyu%20%E6%A8%A1%E6%8B%9F');
    await waitFor(s, (x) => x.raw.includes('web-01 ~ $'));
    s.ws.send('echo raw-ok\r');
    const ok = await waitFor(s, (x) => x.raw.includes('\r\nraw-ok\r\n'));
    check('raw 帧：横幅 + 命令回显', ok && s.raw.includes('mingyu 模拟'), s.raw.split('\r\n')[0]);
    closeSocket(s);
  }

  // 2. guacamole / UTF-8
  {
    const s = await openSocket('host=web-01&prompt=web-01%20~%20%24%20&frame=guacamole');
    const bannerOk = await waitFor(s, (x) => x.text.includes('web-01 ~ $'));
    s.ws.send(tes('df -h\r'));
    const dfOk = await waitFor(s, (x) => x.text.includes('/dev/vda1'));
    check('guacamole/UTF-8：tes 指令收发', bannerOk && dfOk);
    closeSocket(s);
  }

  // 3. guacamole / GB18030
  {
    const qs = new URLSearchParams({
      host: 'web-01',
      prompt: 'web-01 ~ $ ',
      banner: 'mingyu 运维审计系统（mock）',
      frame: 'guacamole',
      enc: 'gb18030',
    });
    const s = await openSocket(qs.toString(), 'gb18030');
    const bannerOk = await waitFor(s, (x) => x.text.includes('web-01 ~ $'));
    // 下行中文应真的是 GB18030 字节（不是 UTF-8）
    const hasGbBytes = s.bytes.some((b, i) => b >= 0x81 && b <= 0xfe && s.bytes[i + 1] >= 0x40 && s.bytes[i + 1] <= 0xfe);
    s.ws.send(tes('echo 中文输出测试\r', 'gb18030'));
    const echoOk = await waitFor(s, (x) => x.text.includes('中文输出测试'));
    check('guacamole/GB18030：中文下行按 GB18030 编码', bannerOk && hasGbBytes);
    check('guacamole/GB18030：中文上行按 GB18030 解码', echoOk);
    closeSocket(s);
  }

  // 4. 括号粘贴 + 可见哨兵（扩展默认命令执行路径）
  {
    const s = await openSocket('host=web-01&prompt=web-01%20~%20%24%20');
    const nonce = 'deadbeef';
    const paste = '\x1b[200~echo pasted-ok\x1b[201~\necho __BP_' + nonce + '_$?__\n';
    s.ws.send(paste);
    const sentinelOk = await waitFor(s, (x) => x.raw.includes(`__BP_${nonce}_0__`));
    const cleanOk = !/200~|201~|\[200|\[201/.test(s.raw.replace(/\x1b/g, ''));
    const outputOk = s.raw.includes('pasted-ok');
    check('括号粘贴标记不落到命令行', cleanOk);
    check('可见哨兵返回退出码（$? 展开）', sentinelOk);
    check('括号粘贴内容正常执行', outputOk);
    closeSocket(s);
  }

  // 5. printf 隐藏哨兵（设置里开启"隐藏哨兵"时走这条路径）
  {
    const s = await openSocket('host=web-01&prompt=web-01%20~%20%24%20');
    const nonce = 'cafebabe';
    const hidden = `printf '\\033[1A\\033[2K\\033___BP_${nonce}_%s__\\033\\\\' $?`;
    s.ws.send(`${hidden}\n`);
    const ok = await waitFor(s, (x) => x.raw.includes(`\x1b___BP_${nonce}_0__\x1b\\`));
    const noError = !s.raw.includes('printf: command not found');
    check('printf 隐藏哨兵（\\033 转义 / 光标上移擦除）', ok && noError);
    closeSocket(s);
  }

  // 6. 分片下发
  {
    const s = await openSocket('host=web-01&prompt=web-01%20~%20%24%20&frame=guacamole&frag=1');
    const bannerOk = await waitFor(s, (x) => x.text.includes('web-01 ~ $'));
    s.ws.send(tes('ls -l\r'));
    const lsOk = await waitFor(s, (x) => x.text.includes('-rw-r--r--') && x.text.includes('deploy.log'));
    check('分片下发：指令跨帧重组', bannerOk && lsOk, `${s.frameCount} 个 WS 帧`);
    closeSocket(s);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[selftest] 失败:', err?.message || err);
  console.error('提示：先启动 mock 服务 node mocks/server.mjs ' + PORT + ' anheng-mingyu');
  process.exit(1);
});
