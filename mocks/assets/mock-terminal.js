/**
 * BastionPilot mock terminal — 共享的假 SSH 终端实现。
 *
 * 每个 mock 页面用 xterm.js 渲染一个可交互的假 shell，模拟对应堡垒机
 * 产品的 Web 终端外观与 DOM 结构（terminalDomHints 命中相应 profile）。
 * 终端输入/输出走真实 WebSocket（/ws），供扩展 interceptor 拦截。
 *
 * 用法（页面内）：
 *   MockTerminal.mount({
 *     el: '#terminal-container',       // 终端容器（同时是 profile 的 DOM hint）
 *     prompt: 'root@web-01:~# ',
 *     hostname: 'web-01',
 *     banner: 'Welcome to ...',        // 由 mock PTY 在连接时下发
 *     welcomeNote: '...',
 *     frame: 'guacamole',              // 省略 = raw PTY 字节流
 *     encoding: 'gb18030',             // guacamole 下的载荷编码：utf-8 | gb18030
 *     frag: true,                      // guacamole 下请求服务端分片下发指令
 *     theme: { background: '#1e1e1e' },
 *     deferMount: true,                // 页面登录后再调用 mount()，不自动挂载
 *     onStatus(info),                  // 连接状态回调：{ state, message, encoding, frame, frag }
 *     onReady(api),                    // 挂载完成回调，参数与 window.mockTerm 相同
 *   });
 *
 * 控制器 API（window.mockTerm / onReady 参数）：
 *   term            xterm 实例
 *   fit()           重新适配尺寸
 *   connect(opts)   建立连接，可传 { encoding, frag } 覆盖当前设置
 *   reconnect(opts) 清屏后重连
 *   disconnect()    主动断开
 *   type(text)      向 PTY 发送文本（guacamole 下自动包 tes + base64）
 *   getStatus()     当前状态快照
 */
(function () {
  'use strict';

  var GB_TABLE = null;

  /* ---------------- 字节 / base64 / 编码 ---------------- */

  function bytesToBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * 浏览器只有 GB18030 解码器，这里用双字节码位反查表补编码：
   * 一次性解码全部 0x81..0xFE / 0x40..0xFE 组合，建立 字符 -> 字节 的映射。
   */
  function gbTable() {
    if (GB_TABLE) return GB_TABLE;
    var table = Object.create(null);
    try {
      var probe = new TextDecoder('gb18030', { fatal: true });
      for (var hi = 0x81; hi <= 0xfe; hi++) {
        for (var lo = 0x40; lo <= 0xfe; lo++) {
          if (lo === 0x7f) continue;
          try {
            var ch = probe.decode(new Uint8Array([hi, lo]));
            if (ch && ch !== '\ufffd' && table[ch] === undefined) table[ch] = [hi, lo];
          } catch (e) {
            /* 非法双字节码位 */
          }
        }
      }
    } catch (e) {
      table = null; // 环境不支持 gb18030：退化为 UTF-8
    }
    GB_TABLE = table;
    return table;
  }

  function encodeText(text, encoding) {
    if (encoding !== 'gb18030') return new TextEncoder().encode(text);
    var table = gbTable();
    if (!table) return new TextEncoder().encode(text);
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
        continue;
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        // 代理对：GB18030 四字节区，mock 用 '?' 占位
        bytes.push(0x3f);
        if (code <= 0xdbff) i += 1;
        continue;
      }
      var pair = table[text.charAt(i)];
      if (pair) bytes.push(pair[0], pair[1]);
      else bytes.push(0x3f);
    }
    return new Uint8Array(bytes);
  }

  /* ---------------- guacamole 分帧 ---------------- */

  function guacInstruction(opcode, payload) {
    return opcode.length + '.' + opcode + ',' + payload.length + '.' + payload + ';';
  }

  /**
   * 解析下行 guacamole 指令流：`<len>.tes,<len>.<base64>;`。
   * 一条指令可能被拆到多个 WebSocket 帧里，因此保留 carry 缓冲。
   */
  function createGuacDecoder(encoding, onText) {
    var carry = '';
    var utf8 = null;
    var gb = null;

    function decodePayload(b64) {
      var bytes;
      try {
        bytes = base64ToBytes(b64);
      } catch (e) {
        return;
      }
      var decoder;
      if (encoding === 'gb18030') {
        gb = gb || tryTextDecoder('gb18030');
        decoder = gb || new TextDecoder('utf-8');
      } else {
        utf8 = utf8 || new TextDecoder('utf-8');
        decoder = utf8;
      }
      var text = decoder.decode(bytes, { stream: true });
      if (text) onText(text);
    }

    function tryTextDecoder(label) {
      try {
        return new TextDecoder(label);
      } catch (e) {
        return null;
      }
    }

    /** 从 carry 头部尽可能多地取完整指令；残缺时保留到下一帧。 */
    function drain() {
      for (;;) {
        var elements = [];
        var pos = 0;
        var complete = false;
        var malformed = false;
        for (;;) {
          var dot = carry.indexOf('.', pos);
          if (dot === -1 || dot - pos > 10) break; // 不完整
          var len = Number(carry.slice(pos, dot));
          if (!isFinite(len) || len < 0 || len > 10000000) {
            malformed = true;
            break;
          }
          var start = dot + 1;
          if (start + len > carry.length) break; // 不完整
          elements.push(carry.slice(start, start + len));
          pos = start + len;
          var sep = carry.charAt(pos);
          if (sep === ',') {
            pos += 1;
            continue;
          }
          if (sep === ';') {
            pos += 1;
            complete = true;
            break;
          }
          if (sep === '') break; // 不完整
          malformed = true;
          break;
        }
        if (malformed) {
          carry = carry.slice(Math.max(pos, 1));
          continue;
        }
        if (!complete) break;
        carry = carry.slice(pos);
        if (elements[0] === 'tes' && elements[1]) decodePayload(elements[1]);
      }
      if (carry.length > 2000000) carry = carry.slice(-100000); // 不无限增长
    }

    return function feed(chunk) {
      carry += chunk;
      drain();
    };
  }

  /* ---------------- 终端挂载 ---------------- */

  function mount(cfg) {
    cfg = cfg || {};
    var hostEl = document.querySelector(cfg.el || 'body') || document.body;

    if (!window.Terminal) {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div style="color:#f66;font-family:monospace;padding:16px">' +
          '[mock] xterm.js 未加载（需要联网加载 CDN，或替换为本地 vendor 文件）。</div>'
      );
      return null;
    }

    var term = new window.Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
      scrollback: 5000,
      theme: cfg.theme || { background: '#1e1e1e' },
    });
    var fit = null;
    if (window.FitAddon) {
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open(hostEl);
    window.term = term; // 与常见产品页面一致：暴露 xterm 实例，便于 get_screen 读取真实屏幕
    function doFit() {
      if (!fit) return;
      try {
        fit.fit();
      } catch (e) {
        /* 容器尚未显示时忽略 */
      }
    }
    doFit();
    window.addEventListener('resize', doFit);

    var settings = {
      ws: cfg.ws !== false,
      frame: cfg.frame || '',
      encoding: cfg.encoding || (cfg.gb18030 ? 'gb18030' : 'utf-8'),
      frag: cfg.frag === true,
    };
    var socket = null;
    var state = { state: 'idle', message: '' };

    function status() {
      return {
        state: state.state,
        message: state.message,
        encoding: settings.encoding,
        frame: settings.frame || 'raw',
        frag: settings.frag,
      };
    }

    function emit(name, message) {
      state.state = name;
      state.message = message || '';
      if (typeof cfg.onStatus === 'function') {
        try {
          cfg.onStatus(status());
        } catch (e) {
          /* 页面回调异常不影响终端 */
        }
      }
    }

    function send(text) {
      if (!socket || socket.readyState !== 1) return false;
      if (settings.frame === 'guacamole') {
        var b64 = bytesToBase64(encodeText(text, settings.encoding));
        socket.send(guacInstruction('tes', b64));
      } else {
        socket.send(text);
      }
      return true;
    }

    term.onData(send);

    function disconnect(silent) {
      var old = socket;
      socket = null;
      if (old) {
        try {
          old.onclose = null;
          old.close();
        } catch (e) {
          /* 已关闭 */
        }
      }
      if (!silent) emit('closed', '已断开');
    }

    function connect(overrides) {
      overrides = overrides || {};
      if (overrides.encoding) settings.encoding = overrides.encoding;
      if (overrides.frag !== undefined) settings.frag = overrides.frag === true;
      disconnect(true);

      var qs = new URLSearchParams();
      qs.set('host', cfg.hostname || 'web-01');
      qs.set('prompt', cfg.prompt || '');
      qs.set('banner', cfg.banner || '');
      qs.set('note', cfg.welcomeNote || '');
      if (settings.frame) qs.set('frame', settings.frame);
      if (settings.encoding && settings.encoding !== 'utf-8') qs.set('enc', settings.encoding);
      if (settings.frag) qs.set('frag', '1');

      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      emit('connecting', '正在连接 ' + (cfg.hostname || 'web-01') + ' …');

      var ws = new WebSocket(proto + location.host + '/ws?' + qs.toString());
      ws.binaryType = 'arraybuffer';
      socket = ws;

      var bytesToText = new TextDecoder('utf-8');
      var guacDown =
        settings.frame === 'guacamole'
          ? createGuacDecoder(settings.encoding, function (text) {
              term.write(text);
            })
          : null;

      ws.onopen = function () {
        if (socket !== ws) return;
        emit('open', '会话已建立');
        term.focus();
      };
      ws.onmessage = function (ev) {
        if (settings.frame === 'guacamole') {
          guacDown(
            typeof ev.data === 'string' ? ev.data : bytesToText.decode(new Uint8Array(ev.data))
          );
        } else {
          term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
        }
      };
      ws.onclose = function () {
        if (socket !== ws) return;
        socket = null;
        emit('closed', '连接已断开');
        term.write('\r\n\x1b[33m[mock] PTY 连接已断开，可点击「重连」恢复。\x1b[0m\r\n');
      };
      ws.onerror = function () {
        if (socket !== ws) return;
        emit('error', 'WebSocket 连接失败');
        term.write(
          '\r\n\x1b[31m[mock] PTY 连接失败：请用 node mocks/server.mjs 启动（静态服务器无法提供 /ws）。\x1b[0m\r\n'
        );
      };
    }

    var api = {
      term: term,
      fit: doFit,
      connect: connect,
      reconnect: function (overrides) {
        term.reset();
        connect(overrides);
      },
      disconnect: disconnect,
      type: send,
      getStatus: status,
    };
    window.mockTerm = api;

    if (settings.ws) connect();
    else mountLocalShell(term, cfg);
    if (typeof cfg.onReady === 'function') {
      try {
        cfg.onReady(api);
      } catch (e) {
        /* 页面回调异常不影响终端 */
      }
    }
    return api;
  }

  /* ---------------- 本地假 shell（ws:false 时的降级路径） ---------------- */

  function mountLocalShell(term, cfg) {
    var PROMPT = cfg.prompt || 'root@web-01:~# ';
    var HOST = cfg.hostname || 'web-01';
    var history = [];
    var histIdx = -1;
    var buf = '';
    var lastExit = 0;

    function write(s) {
      term.write(s);
    }
    function println(s) {
      term.write(s + '\r\n');
    }

    var table = {
      '~': ['deploy.log', 'monitor.sh', 'notes.txt'],
      '/': ['bin', 'boot', 'dev', 'etc', 'home', 'opt', 'proc', 'root', 'tmp', 'usr', 'var'],
      '/etc': ['hosts', 'passwd', 'ssh', 'system-release'],
      '/var/log': ['secure', 'messages', 'audit.log'],
      '/opt': ['app', 'backup', 'scripts'],
    };

    function fakeLs(p) {
      if (!p || p === '.' || p === '~') p = '~';
      return table[p] || null;
    }

    var CMDS = {
      help: function () {
        println('Mock shell — 可用命令：');
        println('  help  ls  pwd  whoami  uname  date  uptime  df  free');
        println('  echo  cat  history  clear  id  hostname  exit');
        println('（本地模拟，所有输出均为 mock 数据）');
      },
      ls: function (args) {
        var target = args[0] || '~';
        var items = fakeLs(target);
        if (items == null) {
          println('ls: cannot access ' + JSON.stringify(target) + ': No such file or directory');
          return 2;
        }
        println(items.join('  '));
        return 0;
      },
      pwd: function () {
        println('/root');
        return 0;
      },
      whoami: function () {
        println('root');
        return 0;
      },
      id: function () {
        println('uid=0(root) gid=0(root) groups=0(root)');
        return 0;
      },
      hostname: function () {
        println(HOST);
        return 0;
      },
      uname: function (args) {
        println(
          args[0] === '-a'
            ? 'Linux ' +
                HOST +
                ' 4.19.91-27.1.an8.x86_64 #1 SMP mock Mon Oct  6 10:00:00 UTC 2025 x86_64 x86_64 x86_64 GNU/Linux'
            : 'Linux'
        );
        return 0;
      },
      date: function () {
        println(new Date().toString());
        return 0;
      },
      uptime: function () {
        println(
          ' ' +
            new Date().toTimeString().slice(0, 8) +
            ' up 32 days,  4:12,  2 users,  load average: 0.15, 0.10, 0.05'
        );
        return 0;
      },
      df: function (args) {
        if (args[0] !== '-h') {
          println('Filesystem     1K-blocks     Used Available Use% Mounted on');
          println('/dev/vda1       41922540 24117248 17805292  58% /');
          return 0;
        }
        println('Filesystem      Size  Used Avail Use% Mounted on');
        println('devtmpfs        3.8G     0  3.8G   0% /dev');
        println('/dev/vda1        40G   23G   17G  58% /');
        println('tmpfs           7.6G     0  7.6G   0% /dev/shm');
        return 0;
      },
      free: function (args) {
        var m = args[0] === '-m';
        println('              total        used        free      shared  buff/cache   available');
        println(
          m
            ? 'Mem:           7809        2314        3105         128        2390        5121'
            : 'Mem:            7.9Gi       2.3Gi       3.0Gi       125Mi       2.3Gi       5.0Gi'
        );
        println(
          m
            ? 'Swap:          2047           0        2047'
            : 'Swap:           2.0Gi          0B       2.0Gi'
        );
        return 0;
      },
      echo: function (args) {
        println(
          args
            .map(function (a) {
              return a.replace(/\$\?/g, String(lastExit));
            })
            .join(' ')
            .replace(/^["']|["']$/g, '')
        );
        return 0;
      },
      true: function () {
        return 0;
      },
      false: function () {
        return 1;
      },
      cat: function (args) {
        if (!args[0]) {
          println('cat: missing operand');
          return 1;
        }
        if (args[0] === '/etc/hosts') {
          println('127.0.0.1   localhost localhost.localdomain');
          println('10.0.0.11   ' + HOST);
          return 0;
        }
        println('cat: ' + args[0] + ': No such file or directory');
        return 1;
      },
      history: function () {
        history.forEach(function (c, i) {
          println('  ' + String(i + 1).padStart(4) + '  ' + c);
        });
        return 0;
      },
      clear: function () {
        term.clear();
        return 0;
      },
      exit: function () {
        println('logout');
        println('Connection to ' + HOST + ' closed.');
        return 0;
      },
    };

    function run(line) {
      var trimmed = line.trim();
      if (!trimmed) return 0;
      history.push(trimmed);
      histIdx = history.length;
      var segs = trimmed.includes('&&') ? trimmed.split('&&') : [trimmed];
      var rc = 0;
      for (var i = 0; i < segs.length; i++) {
        var p = segs[i].trim().split(/\s+/);
        if (CMDS[p[0]]) rc = CMDS[p[0]](p.slice(1)) || 0;
        else {
          println('bash: ' + p[0] + ': command not found');
          rc = 127;
          break;
        }
        if (rc !== 0) break;
      }
      lastExit = rc;
      return rc;
    }

    function showPrompt() {
      write('\r\n' + PROMPT);
      buf = '';
    }

    term.onData(function (data) {
      if (data === '\r') {
        write('\r\n');
        run(buf);
        showPrompt();
        return;
      }
      if (data === '\u007f') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }
      if (data === '\u0003') {
        write('^C');
        showPrompt();
        return;
      }
      if (data === '\u001b[A' || data === '\u001b[B') {
        if (history.length === 0) return;
        if (data === '\u001b[A' && histIdx > 0) histIdx--;
        if (data === '\u001b[B' && histIdx < history.length) histIdx++;
        for (var i = 0; i < buf.length; i++) term.write('\b \b');
        buf = history[histIdx] || '';
        term.write(buf);
        return;
      }
      if (data === '\u001b') return;
      buf += data;
      term.write(data);
    });

    if (cfg.banner) println(cfg.banner);
    if (cfg.welcomeNote) println(cfg.welcomeNote);
    showPrompt();
    term.focus();
  }

  window.MockTerminal = { mount: mount };

  function autoBoot() {
    if (!window.MOCK_CFG || window.MOCK_CFG.deferMount) return;
    mount(window.MOCK_CFG);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoBoot);
  } else {
    autoBoot();
  }
})();
