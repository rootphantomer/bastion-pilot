# mingyu V2.0 支持情况与已知问题

> 来源：用本地 mock 页面（`mocks/server.mjs 8906 anheng-mingyu`）联调 `anheng-mingyu`
> profile 得到的结论，提交 `a873cbb`。真机上尚未验证的项单独标注。
> 复现入口见文末「复现方式」。

## 结论摘要

| # | 问题 | 严重度 | 证据来源 |
| --- | --- | --- | --- |
| 1 | 上行输入固定 UTF-8，与下行自动识别的 GB18030 不对称 | 高 | mock 已复现 |
| 2 | 文本帧需 ≥2 帧才建会话，且建会话时丢掉第一帧 | 高 | mock 已复现 |
| 3 | 一个标签页只 hook 一个会话（页内多会话/重连拿不到） | 高 | mock 已复现 |
| 4 | 终端 socket 关闭后不注销会话，工具打到死连接空等超时 | 高 | mock 已复现 |
| 5 | GB18030/UTF-8 自动识别可能被「半字符」永久带偏 | 中 | 代码审查 |
| 6 | 没有 Guacamole 握手 / `size` 指令 | 中 | 代码审查 |
| 7 | 没有重连语义（token 过期、网络抖动后只能刷新页面） | 中 | 代码审查 |

---

## 一、已用 mock 复现

### 1）上行编码永远是 UTF-8（高）

```ts
// packages/extension/src/content/framer.ts:111-114
encodeUp: (text) => {
  const payload = cfg.enterAsCr ? text.replace(/\r?\n/g, '\r') : text;
  return guacInstruction('tes', bytesToBase64(encoder.encode(payload))); // encoder = TextEncoder（UTF-8）
},
```

- 下行 `toUtf8Bytes()` 会识别 GB18030，但 `encodeUp` 不读识别出的 `mode`；
  profile 注释里写的「input must be sent the same way」并未实现。
- 现象：Agent 执行 `echo "中文输出测试"`，真实产品按 GB18030 解释 UTF-8 字节，
  回显为 `涓枃杈撳嚭娴嬭瘯`。
- 影响：任何含中文/非 ASCII 的命令、粘贴内容在真机上都会坏；纯 ASCII 命令不受影响。
- 建议修法：识别出 `mode` 后 `encodeUp` 使用同一编码；GB18030 需要编码器
  （可参考 `mocks/gb18030.mjs` 的双字节反查表），或在 profile 显式配置编码时直接按配置编码。

### 2）文本帧要「≥2 帧」才建会话，且丢掉第一帧（高）

```ts
// packages/extension/src/content/controller.ts:154-164 / 189
if (typeof msg.data === 'string') {
  observation.stringFrames++;
  if (!this.isLikelyTerminalText(observation, msg.data)) return; // 非 JSON：要求 >= 2 帧
}
...
this.createSession(msg.socketId, observation, msg.data ?? ''); // 只 feed 当前帧
```

- Guacamole 流按定义就是文本帧，这条「防心跳/分析噪声」的启发式对它不成立。
- 现象：连接后只下发一条 `tes`（例如横幅）时，页面上终端有内容但 `list_sessions` 是空；
  第二条帧才建会话，且第一帧内容（横幅/首行输出）永久丢失。
- 影响：真机上连接后如果安静一会儿，Agent 看不到会话；`read_output` 从第二条帧开始。
- 建议修法：`framer.type` 为 `guacamole` / `json` 等已知协议时直接视为终端文本；
  建会话时把观测期缓存的帧一起 `feed`。

### 3）一个标签页只 hook 一个会话（高）

```ts
// packages/extension/src/content/controller.ts:148-152
if (this.session) return; // one terminal per tab for now
```

- mingyu V2.0 这类产品**一个浏览器页里可以开多个会话页签**，每个会话一条 WebSocket；
  token 过期/网络抖动重连也会新建 socket。
- 现象：第二个会话完全不可控；重连后扩展仍指向旧 socket，命令超时。
- 影响：多会话运维场景不可用；页面一旦重连（很常见），Agent 就失能。
- 建议修法：按 `socketId` 管理多个 `TerminalSession`，`list_sessions` 暴露多个，
  工具按 `sessionId` 路由；至少要在当前 socket 被替换时切换过去。

### 4）socket 关闭不通知任何一层，会话「假存活」（高）

```ts
// packages/extension/src/injected/interceptor.ts:62
this.addEventListener('close', () => sockets.delete(socketId)); // 不 postMessage
```

- `list_sessions` 仍显示 `state: active`；`get_screen` 为空；
  `send_command` 写入被 `findSocket()` 的 null 检查静默吞掉，最终报 `timeout`
  （实测文案：`wait window elapsed while output kept flowing`）。
- registry 要等 port 断开（标签页关闭）才清理。
- 建议修法：interceptor 补发 `socket-close`；controller 标记会话 closed / 注销并通知 worker
  从 registry 移除；写失败时让工具调用立即返回明确错误（"terminal socket closed"）。

---

## 二、代码审查发现，需真机确认

### 5）编码自动识别可能被「半字符」永久带偏（中）

`framer.ts:75-92` 用 `utf8Probe.decode(bytes, { stream: true })` 探测：若一个 GB18030
汉字的两个字节被拆到两条 `tes` 载荷，第一段只有前导字节，流式 UTF-8 探测器**不会抛错**，
`mode` 被锁成 `utf-8`，之后所有 GB18030 文本永久乱码。真实 PTY 的 read 分块有可能在字符中间切。

建议：探测前攒到完整字符边界；或允许前若干帧内纠正；识别失败不锁定。

### 6）没有 Guacamole 握手 / `size` 指令（中）

当前只发 `tes`，没有 `connect`/`select`/`size`。需确认：
- 真机是否要求握手后才接受输入；
- 终端 resize 不同步会不会导致折行、`vim`/`top` 花屏。
mock 不做握手，测不出来。

### 7）没有重连语义（中）

真实产品 token 过期或网络抖动会重连 WS；结合 #3/#4，Agent 会一直打到死会话上。
当前只能刷新页面恢复。

---

## 三、mock 侧的绕行（不是修复）

联调时为了能继续测插件功能，在 mock 侧做了三处兼容，**扩展本身的 bug 仍在**：

1. `mocks/server.mjs`：GB18030 模式下上行输入「UTF-8 优先、失败回退 GB18030」宽松解码；
2. `mocks/server.mjs`：guacamole 横幅按行拆成多条 `tes`，凑够「≥2 帧」才能建会话；
3. `mocks/anheng-mingyu.html`：检测到 `window.__bastionPilotInterceptor` 时，
   切换编码/重连改为刷新页面重建会话（绕开「一标签页一会话」）。

---

## 四、真机验证清单

- [ ] **中文输入**：`echo "中文输出测试"`、`printf '中文\n'`，看回显是否乱码（问题 1）
- [ ] **连接即安静**：登录进入终端后不做任何操作，等 10s 再 `list_sessions`（问题 2）
- [ ] **首帧内容**：`read_output` 从头读，确认横幅/提示符没丢（问题 2）
- [ ] **页内多会话**：开两个会话页签，看 `list_sessions` 是否只有一个（问题 3）
- [ ] **重连**：断开/重连或等待 token 过期，观察工具是否还能用（问题 3 / 7）
- [ ] **关闭 socket**：关闭单个会话页签（不是整个浏览器标签），确认会话被移除且报错明确（问题 4）
- [ ] **GB18030 边界**：连续输出大量中文（`cat 中文文件`），看是否中途乱码（问题 5）
- [ ] **尺寸同步**：打开 `vim`/`top`，观察是否花屏、是否随窗口 resize 重排（问题 6）
- [ ] **审计/审批**：确认写操作在真实环境仍走审批，且输出被正确录制

---

## 五、复现方式（mock）

```bash
# 1) 启动 mingyu mock（8906 端口对应 profile anheng-mingyu）
node mocks/server.mjs 8906 anheng-mingyu

# 2) 协议自检（不依赖浏览器）
node mocks/selftest.mjs 8906

# 3) 扩展 Options → Bastion sites 添加 http://127.0.0.1:8906 并选 anheng-mingyu
#    打开页面 → 任意凭据登录 → 终端 hook 成功
```

工具侧观察点：

```text
list_sessions                      # 会话是否出现、是否只有 1 个
get_screen / read_output           # 首帧是否完整、中文是否乱码
send_command 'echo "中文输出测试"'  # 问题 1
```

页面工具栏还可切换「编码（GB18030/UTF-8）」与「分片下发」复现不同分帧/编码组合。
