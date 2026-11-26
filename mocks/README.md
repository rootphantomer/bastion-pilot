# BastionPilot mock bastion sites

本地模拟的堡垒机 Web SSH 终端，带真实 WebSocket PTY（raw 字节流 / guacamole 指令流），
供扩展 interceptor 拦截、hook 出会话，用于无真实堡垒机时联调。

## 启动

```bash
# 方式一：单实例（全部页面，'/' 是导航页）
node mocks/server.mjs            # http://127.0.0.1:8899/

# 方式二（推荐）：每个产品一个独立端口
# 扩展 profile 按 origin 配置，独立端口才能给每个站点固定 profile
node mocks/server.mjs 8901 generic-xterm
node mocks/server.mjs 8902 jumpserver
node mocks/server.mjs 8903 teleport
node mocks/server.mjs 8904 qizhi
node mocks/server.mjs 8905 aliyun-bastionhost
node mocks/server.mjs 8906 anheng-mingyu
```

## 端口 ↔ profile 对照

| 端口 | 地址                   | profile            |
| ---- | ---------------------- | ------------------ |
| 8901 | http://127.0.0.1:8901/ | generic-xterm      |
| 8902 | http://127.0.0.1:8902/ | jumpserver         |
| 8903 | http://127.0.0.1:8903/ | teleport           |
| 8904 | http://127.0.0.1:8904/ | qizhi              |
| 8905 | http://127.0.0.1:8905/ | aliyun-bastionhost |
| 8906 | http://127.0.0.1:8906/ | anheng-mingyu      |

扩展 Options → Bastion sites 逐个添加上表 origin 并选择对应 profile；
打开页面 → 登录（任意凭据）→ 扩展即 hook 出会话，`list_sessions` 可见。

## WS 协议

`ws://<host>/ws?host=<主机名>&prompt=<提示符>`

| 参数              | 说明                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `banner` / `note` | 连接时下发的欢迎行（页面通过 `MOCK_CFG.banner` 传入，含中文便于验证编码）                              |
| `frame=guacamole` | 下行/上行改为 Guacamole 指令流 `<len>.tes,<len>.<base64>;`（mingyu V2.0 样式）                         |
| `enc=gb18030`     | guacamole 载荷按 GB18030 编解码（默认 UTF-8）；中文即 GB18030 字节，供扩展 `textEncoding: "auto"` 识别 |
| `frag=1`          | 把一条 guacamole 指令拆成多帧下发，覆盖扩展 framer 的 carry 重组路径                                   |

原生帧（无 `frame`）为 raw PTY 字节（UTF-8，`\r\n` 换行）。

## Mock PTY 能力

- 回显 + 提示符；命令：
  `help ls pwd whoami id hostname uname date uptime df free echo printf cat tail history clear true false exit`
- `ls` 支持 `-l`（长格式），`cat`/`tail` 可读 `/var/log/secure`、`/var/log/messages`、
  `/var/log/audit.log`、`deploy.log`
- `&&` 串联、退出码（未知命令 127）、`$?` 展开
- readline 行为：退格、`ctrl+c` / `ctrl+u` / `ctrl+d`、上下箭头历史
- 括号粘贴标记（`\x1b[200~` / `\x1b[201~`）与其它 CSI/OSC/APC 序列被消费，不落到命令行
- `printf` 支持 `\n \t \r \e \\ \0NNN` 与 `%s %d %%`，因此扩展的
  可见哨兵（`echo __BP_x_$?__`）和隐藏哨兵（`printf '\033[1A\033[2K\033___BP_x_%s__\033\\' $?`）
  都能正常返回退出码

## 协议自检

```bash
node mocks/selftest.mjs 8906
```

不依赖浏览器，直接验证：raw 帧收发、guacamole/UTF-8、guacamole/GB18030 双向编码、
括号粘贴 + 可见哨兵、printf 隐藏哨兵、分片下发重组。

## 已知问题（anheng-mingyu profile）

mock 联调中发现的扩展侧问题与真机验证清单见
[`docs/anheng-mingyu-findings.md`](../docs/anheng-mingyu-findings.md)。

## mingyu 页面（8906）

`anheng-mingyu.html` 模拟 V2.0 的运维界面（顶部导航 / 资源树 / 会话页签 / 工具栏 /
状态栏 / 水印），默认使用 `guacamole + GB18030`，尽量贴近真实产品：

- 工具栏可切换 **编码**（GB18030 ↔ UTF-8）：重连后观察扩展是否能正确识别/切换
- **分片下发** 勾选框：默认关闭，勾选后把指令拆成多帧，验证 framer 的 carry 重组
- **断开 / 重连 / 全屏 / 复制 / 粘贴**：验证会话状态与 DOM 输入
- 状态栏显示连接状态、编码、录制指示与会话时长
- 页面暴露 `window.term`（xterm 实例），使扩展的 `get_screen` 能读到真实屏幕内容

> 已被扩展 hook 的标签页里，切换编码 / 分片或点「重连」会刷新页面重新建立会话
> （扩展目前是「一个标签页一个会话」，页面内重连会留下失效会话）。刷新后登录状态与
> 编码选择从 sessionStorage 恢复。
