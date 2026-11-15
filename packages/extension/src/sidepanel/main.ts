/**
 * Side panel: approval and shared-context monitor. All state lives in the
 * daemon; this file renders approvals and read-only agent context over the
 * 'panel' port.
 */

import type { ApprovalHistoryEntry } from '@bastion-pilot/protocol';

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
  approvalHistory: ApprovalHistoryEntry[];
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
const statusDot = document.getElementById('status-dot')!;
const sessionSelect = document.getElementById('session-select') as HTMLSelectElement;
const modeStatus = document.getElementById('mode-status')!;
const approvalsEl = document.getElementById('approvals')!;
const approvalHistoryCount = document.getElementById('approval-history-count')!;
const approvalHistoryList = document.getElementById('approval-history-list')!;
const emptyHint = document.querySelector('.empty-hint');
const activityEl = document.getElementById('activity')!;
const activityText = document.getElementById('activity-text')!;

let agentConnected = false;
let sharedReplayRendered = false;
let replayRequested = false;
let latestState: StateMessage | null = null;
let selectedSessionId = '';

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

function setActivity(text: string, active = false) {
  activityText.textContent = text;
  activityEl.classList.toggle('active', active);
}

function removeEmptyHint() {
  emptyHint?.remove();
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

const DECISION_LABELS: Record<ApprovalHistoryEntry['decision'], string> = {
  approved: '已批准',
  denied: '已拒绝',
  expired: '已超时',
};

function formatHistoryTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function renderApprovalHistory(entries: ApprovalHistoryEntry[], sessionId: string) {
  const visible = sessionId ? entries.filter((entry) => entry.sessionId === sessionId) : [];
  approvalHistoryCount.textContent = String(visible.length);
  approvalHistoryList.textContent = '';

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'approval-history-empty';
    empty.textContent = sessionId ? '当前终端暂无审批记录' : '未选择终端';
    approvalHistoryList.appendChild(empty);
    return;
  }

  for (const entry of visible) {
    const item = document.createElement('div');
    item.className = `approval-history-item ${entry.decision}`;

    const head = document.createElement('div');
    head.className = 'approval-history-head';

    const decision = document.createElement('span');
    decision.className = 'approval-history-decision';
    decision.textContent = DECISION_LABELS[entry.decision];

    const title = document.createElement('span');
    title.className = 'approval-history-title';
    title.textContent = toolLabel(entry.tool);

    const time = document.createElement('time');
    time.className = 'approval-history-time';
    time.dateTime = new Date(entry.decidedAt).toISOString();
    time.textContent = formatHistoryTime(entry.decidedAt);

    const summary = document.createElement('div');
    summary.className = 'approval-history-summary';
    summary.textContent = entry.summary;

    head.append(decision, title, time);
    item.append(head, summary);
    approvalHistoryList.appendChild(item);
  }
}

function renderState(state: StateMessage) {
  latestState = state;
  agentConnected = state.agentConnected;
  statusDot.className = `dot ${state.connected ? 'dot-on' : 'dot-off'}`;
  statusDot.title = state.connected ? '本地服务已连接' : '本地服务未连接';
  modeStatus.textContent = agentConnected
    ? `本地 Agent 已连接${state.agentNames.length ? ` · ${state.agentNames.join('、')}` : ''}`
    : '等待本地 Agent（MCP）';
  modeStatus.className = `mode-status ${agentConnected ? 'ok' : ''}`;

  sessionSelect.textContent = '';
  if (state.sessions.length === 0) {
    selectedSessionId = '';
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
    if (!state.sessions.some((session) => session.sessionId === selectedSessionId)) {
      selectedSessionId = state.sessions[0]?.sessionId ?? '';
    }
    sessionSelect.value = selectedSessionId;
  }

  renderApprovals(state.approvals);
  renderApprovalHistory(state.approvalHistory, selectedSessionId);
  setActivity(
    !state.connected
      ? '未连接本地服务 · 请打开设置'
      : state.approvals.length > 0
        ? `等待审批 · ${state.approvals.length} 项`
        : '已连接 · 等待审批',
    state.approvals.length > 0
  );

  if (state.connected && !replayRequested) {
    replayRequested = true;
    postToBackground({ kind: 'get-shared-context', limit: 50 });
  }

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
        { source?: string; role?: string; content?: string } | undefined;
      if (entry?.source === 'mcp' && entry.content) {
        removeEmptyHint();
        addSharedAgentMessage(entry.role ?? 'note', entry.content);
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
      }>;
      let rendered = 0;
      for (const entry of entries) {
        if (!entry.content || entry.source === 'agent') continue;
        if (entry.source === 'panel' && entry.role === 'user' && !entry.chatId) {
          addSharedAgentMessage('user', entry.content);
          rendered += 1;
        } else if (entry.source === 'mcp') {
          addSharedAgentMessage(entry.role ?? 'note', entry.content);
          rendered += 1;
        }
      }
      if (rendered > 0) removeEmptyHint();
      break;
    }
    case 'error':
      addErrorMessage(String((payload as { message?: string }).message ?? '未知错误'));
      break;
    default:
      break;
  }
}

port.onMessage.addListener((msg: PortMessage) => {
  if (msg.kind === 'state') {
    renderState(msg);
  } else if (msg.kind === 'chat-event') {
    handleChatEvent(msg.message);
  }
});

postToBackground({ kind: 'get-state' });

sessionSelect.addEventListener('change', () => {
  selectedSessionId = sessionSelect.value;
  if (latestState) renderApprovalHistory(latestState.approvalHistory, selectedSessionId);
});

document.getElementById('open-options')!.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('empty-options-link')?.addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});
