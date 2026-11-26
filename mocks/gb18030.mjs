/**
 * GB18030 PTY 编码工具（mock 服务端与自检脚本共用）。
 *
 * Node 只内置 GB18030 解码（TextDecoder），没有编码器。这里用双字节码位
 * 反查表补一个：一次性解码 0x81..0xFE / 0x40..0xFE 的全部组合，建立
 * 字符 -> 字节 的映射。GB18030 四字节区（生僻字、emoji）不覆盖，退化为 '?'。
 */

let table = null;

function gbTable() {
  if (table) return table;
  table = new Map();
  const probe = new TextDecoder('gb18030', { fatal: true });
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      try {
        const ch = probe.decode(Buffer.from([hi, lo]));
        if (ch && ch !== '\ufffd' && !table.has(ch)) table.set(ch, [hi, lo]);
      } catch {
        /* 非法双字节码位（4 字节序列的前半段等） */
      }
    }
  }
  return table;
}

/** 把 PTY 文本编码成线上字节；encoding 只认 'gb18030'，其余走 UTF-8。 */
export function encodePty(text, encoding) {
  if (encoding !== 'gb18030') return Buffer.from(text, 'utf8');
  const map = gbTable();
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const pair = map.get(ch);
    if (pair) bytes.push(pair[0], pair[1]);
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}
