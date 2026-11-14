/**
 * Side panel: thin chat client. All state lives in the daemon; this file only
 * renders the transcript and forwards user actions over the 'panel' port.
 */

interface StateMessage {
  kind: 'state';
  connected: boolean;
  agentConnected: boolean;
  agentNames: string[];
  agents: Array<{
    agentId: string;
    name: string;
    label: string;
    conversationId?: string;
    connectedAt: number;
    lastSeenAt: number;
  }>;
  sessions: Array<{ sessionId: string; title: string; state: string; profileId: string }>;
  approvals: Array<{ requestId: string; tool: string; summary: string; sessionId?: string }>;
}

interface ChatEventMessage {
  kind: 'chat-event';
  message: {
    type: string;
    payload: Record<string, unknown>;
  };
}

type PortMessage = StateMessage | ChatEventMessage;

const port = chrome.runtime.connect({ name: 'panel' });

const transcript = document.getElementById('transcript')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const abortBtn = document.getElementById('abort-btn') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot')!;
const sessionSelect = document.getElementById('session-select') as HTMLSelectElement;
const modeStatus = document.getElementById('mode-status')!;
const agentSelect = document.getElementById('agent-select') as HTMLSelectElement;
const newChatBtn = document.getElementById('new-chat') as HTMLButtonElement;
const approvalsEl = document.getElementById('approvals')!;
const emptyHint = document.querySelector('.empty-hint');
const activityEl = document.getElementById('activity')!;
const activityText = document.getElementById('activity-text')!;

let busy = false;
let agentConnected = false;
let selectedAgentId = '';
let sharedReplayRendered = false;
let pendingAgentRequestId: string | null = null;
let agentRequestTimer: number | null = null;

function postToBackground(message: unknown) {
  try {
    port.postMessage(message);
  } catch {
    // The panel can outlive an MV3 service-worker restart; reopening it will
    // create a fresh port and the current daemon state is restored.
  }
}

function scrollBottom() {
  transcript.scrollTop = transcript.scrollHeight;
}

function setBusy(value: boolean) {
  busy = value;
  abortBtn.classList.toggle('hidden', !value);
  activityEl.classList.toggle('active', value);
  if (!value) setActivity('就绪 · 等待你的指令', false);
}

function setActivity(text: string, active = busy) {
  activityText.textContent = text;
  activityEl.classList.toggle('active', active);
}

function removeEmptyHint() {
  emptyHint?.remove();
}

function addUserMessage(text: string) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  transcript.appendChild(div);
  scrollBottom();
}

function addErrorMessage(text: string) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = text;
  transcript.appendChild(div);
  scrollBottom();
}

function addSharedAgentMessage(role: string, text: string) {
  const div = document.createElement('div');
  div.className = role === 'user' ? 'msg user shared-agent' : 'msg assistant shared-agent';
  div.textContent = role === 'user' ? text : `本地 Agent · ${text}`;
  transcript.appendChild(div);
  scrollBottom();
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    list_sessions: '查找终端会话',
    send_command: '执行终端命令',
    read_output: '读取命令输出',
    wait_output: '等待终端输出',
    send_key: '发送终端按键',
    screen_snapshot: '读取终端画面',
    upload_file: '上传文件',
    download_file: '下载文件',
    get_shared_context: '读取共享会话',
    append_shared_context: '写入共享会话',
  };
  return labels[tool] ?? tool;
}

function renderApprovals(approvals: StateMessage['approvals']) {
  approvalsEl.textContent = '';
  for (const approval of approvals) {
    const div = document.createElement('div');
    div.className = 'approval';
    div.innerHTML = `
      <div class="title"></div>
      <div class="summary"></div>
      <div class="actions">
        <button class="approve">批准执行</button>
        <button class="deny">拒绝</button>
      </div>`;
    (div.querySelector('.title') as HTMLElement).textContent = `需要批准：${toolLabel(
      approval.tool
    )}${approval.sessionId ? ` · 终端 ${approval.sessionId.slice(0, 14)}` : ''}`;
    (div.querySelector('.summary') as HTMLElement).textContent = approval.summary;
    (div.querySelector('.approve') as HTMLButtonElement).addEventListener('click', () => {
      postToBackground({
        kind: 'approval-response',
        requestId: approval.requestId,
        approved: true,
      });
    });
    (div.querySelector('.deny') as HTMLButtonElement).addEventListener('click', () => {
      postToBackground({
        kind: 'approval-response',
        requestId: approval.requestId,
        approved: false,
      });
    });
    approvalsEl.appendChild(div);
  }
}

function renderState(state: StateMessage) {
  agentConnected = state.agentConnected;
  statusDot.className = `dot ${state.connected ? 'dot-on' : 'dot-off'}`;
  statusDot.title = state.connected ? '本地服务已连接' : '本地服务未连接';
  modeStatus.textContent = agentConnected
    ? `Agent 已连接${state.agentNames.length ? ` · ${state.agentNames.join('、')}` : ''}`
    : '等待本地 Agent（MCP）';
  modeStatus.className = `mode-status ${agentConnected ? 'ok' : ''}`;
  agentSelect.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.agents.length
    ? '选择本地 Agent 对话（选择后读取上下文）'
    : '等待本地 Agent';
  agentSelect.appendChild(placeholder);
  for (const agent of state.agents) {
    const option = document.createElement('option');
    option.value = agent.agentId;
    option.textContent = agent.conversationId
      ? `${agent.label} · ${agent.conversationId.slice(0, 12)}`
      : agent.label;
    agentSelect.appendChild(option);
  }
  if (!state.agents.some((agent) => agent.agentId === selectedAgentId)) {
    selectedAgentId = '';
  }
  if (state.agents.some((agent) => agent.agentId === selectedAgentId)) {
    agentSelect.value = selectedAgentId;
  }
  agentSelect.disabled = state.agents.length === 0;

  sessionSelect.textContent = '';
  if (state.sessions.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未连接终端';
    sessionSelect.appendChild(option);
    sessionSelect.disabled = true;
  } else {
    sessionSelect.disabled = false;
    for (const session of state.sessions) {
      const option = document.createElement('option');
      option.value = session.sessionId;
      option.textContent = `${session.title} (${session.profileId})`;
      sessionSelect.appendChild(option);
    }
  }
  renderApprovals(state.approvals);
  if (!busy)
    setActivity(state.connected ? '已连接 · 等待你的指令' : '未连接本地服务 · 请打开设置', false);
  if (state.connected) removeEmptyHint();
  const hookHint = document.getElementById('hook-hint');
  if (hookHint) {
    hookHint.classList.toggle('hidden', !(state.connected && state.sessions.length === 0));
  }
}

function handleChatEvent(message: ChatEventMessage['message']) {
  const payload = message.payload;
  switch (message.type) {
    case 'shared_context_event': {
      const entry = payload.entry as
        | {
            source?: string;
            role?: string;
            content?: string;
            targetAgentId?: string;
            requestId?: string;
          }
        | undefined;
      if (
        entry?.source === 'mcp' &&
        entry.content &&
        (!entry.targetAgentId || entry.targetAgentId === selectedAgentId)
      ) {
        addSharedAgentMessage(entry.role ?? 'note', entry.content);
        if (
          entry.role === 'assistant' &&
          pendingAgentRequestId &&
          entry.requestId === pendingAgentRequestId
        ) {
          pendingAgentRequestId = null;
          if (agentRequestTimer !== null) window.clearTimeout(agentRequestTimer);
          agentRequestTimer = null;
          setBusy(false);
          setActivity('本地 Agent 已回写 · 可以继续', false);
        }
      }
      break;
    }
    case 'shared_context_replay': {
      if (sharedReplayRendered) break;
      sharedReplayRendered = true;
      const entries = (payload.entries ?? []) as Array<{
        source?: string;
        role?: string;
        content?: string;
        chatId?: string;
        targetAgentId?: string;
        requestId?: string;
      }>;
      for (const entry of entries) {
        if (!entry.content || entry.source === 'agent') continue;
        if (entry.targetAgentId && entry.targetAgentId !== selectedAgentId) continue;
        if (entry.source === 'panel' && entry.role === 'user' && !entry.chatId)
          addSharedAgentMessage('user', entry.content);
        else if (entry.source === 'mcp') addSharedAgentMessage(entry.role ?? 'note', entry.content);
      }
      break;
    }
    case 'error':
      abortBtn.disabled = false;
      addErrorMessage(String((payload as { message?: string }).message ?? '未知错误'));
      setBusy(false);
      break;
    default:
      break;
  }
}

port.onMessage.addListener((msg: PortMessage) => {
  if (msg.kind === 'state') {
    renderState(msg);
  } else if (msg.kind === 'chat-event') {
    removeEmptyHint();
    handleChatEvent(msg.message);
  }
});

postToBackground({ kind: 'get-state' });

function sendToAgent(text: string) {
  if (!agentConnected) {
    addErrorMessage('本地 Agent 尚未连接。请启动 Claude Code 或 Codex，并配置 bastion-pilot MCP。');
    setBusy(false);
    return;
  }
  if (!selectedAgentId) {
    addErrorMessage('请先选择一个本地 Agent 对话。');
    setBusy(false);
    return;
  }
  const requestId = crypto.randomUUID();
  pendingAgentRequestId = requestId;
  if (agentRequestTimer !== null) window.clearTimeout(agentRequestTimer);
  agentRequestTimer = window.setTimeout(() => {
    if (pendingAgentRequestId !== requestId) return;
    pendingAgentRequestId = null;
    setBusy(false);
    setActivity('本地 Agent 响应超时 · 请确认 Agent 已读取共享上下文', false);
    addErrorMessage(
      '本地 Agent 暂未回写响应。请在 Agent 对话中调用 get_shared_context 后，使用 append_shared_context 回答。'
    );
  }, 120_000);
  setBusy(true);
  setActivity('已发送至选中的 Agent 对话 · 等待回写…', true);
  postToBackground({ kind: 'agent-message', text, targetAgentId: selectedAgentId, requestId });
}

function send() {
  const text = input.value.trim();
  if (!text) return;
  removeEmptyHint();
  addUserMessage(text);
  input.value = '';
  sendToAgent(text);
}

function resetConversation() {
  if (busy) {
    addErrorMessage('当前任务仍在执行，请先停止后再新建对话。');
    return;
  }
  sharedReplayRendered = false;
  pendingAgentRequestId = null;
  if (agentRequestTimer !== null) {
    window.clearTimeout(agentRequestTimer);
    agentRequestTimer = null;
  }
  transcript.textContent = '';
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.innerHTML =
    '<p class="welcome-title">新对话已准备好</p><p>描述你的目标，执行前会显示审批卡片。</p>';
  transcript.appendChild(hint);
  setActivity('新对话已准备好 · 等待本地 Agent', false);
}

sendBtn.addEventListener('click', send);
newChatBtn.addEventListener('click', resetConversation);
abortBtn.addEventListener('click', () => {
  abortBtn.disabled = true;
  if (agentRequestTimer !== null) {
    window.clearTimeout(agentRequestTimer);
    agentRequestTimer = null;
  }
  pendingAgentRequestId = null;
  setBusy(false);
  setActivity('已停止等待 · 本地 Agent 仍可能继续执行', false);
});
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    send();
  }
});

document.getElementById('open-options')!.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('empty-options-link')?.addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

agentSelect.addEventListener('change', () => {
  if (agentRequestTimer !== null) window.clearTimeout(agentRequestTimer);
  agentRequestTimer = null;
  pendingAgentRequestId = null;
  if (busy) setBusy(false);
  selectedAgentId = agentSelect.value;
  sharedReplayRendered = false;
  if (selectedAgentId) {
    postToBackground({ kind: 'get-shared-context', targetAgentId: selectedAgentId, limit: 50 });
  }
});
