import crypto from 'node:crypto';
import {
  ToolName,
  inspectRedlines,
  toRedlineWarning,
  type RedlineWarning,
} from '@bastion-pilot/protocol';

const READONLY_TOOLS = new Set<string>([
  ToolName.ListSessions,
  ToolName.ReadOutput,
  ToolName.WaitOutput,
  ToolName.GetScreen,
]);

export interface ApprovalPolicy {
  mode: 'auto' | 'confirm' | 'readonly';
  /** Product-safe default: no terminal tool may run without a user decision. */
  requireUserApproval?: boolean;
  confirmTimeoutMs?: number;
  readonlyAllowlist?: string[];
}

export type ApprovalSource = 'mcp' | 'agent' | 'panel';

export interface ApprovalRequest {
  requestId: string;
  source: ApprovalSource;
  tool: string;
  sessionId?: string;
  summary: string;
  /** Present when a built-in ops redline matched; forces a secondary confirmation. */
  redline?: RedlineWarning;
  expiresAt: number;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
  /** Redline ids hit by this call, recorded in the audit log. */
  redlineIds?: string[];
}

export type UserApprovalGate = (req: ApprovalRequest) => Promise<boolean>;

export function isReadonlyTool(tool: string): boolean {
  return READONLY_TOOLS.has(tool);
}

export function summarizeToolCall(tool: string, params: Record<string, unknown>): string {
  if (tool === ToolName.SendCommand && typeof params.command === 'string') {
    const cmd = redactCommand(params.command);
    return `command: ${cmd}`;
  }
  if (tool === ToolName.SendKey && typeof params.key === 'string') {
    return `key press: ${params.key}`;
  }
  if (tool === ToolName.SendCommand || tool === ToolName.SendKey) {
    return `tool ${tool} (missing parameters)`;
  }
  return `tool ${tool}`;
}

/** Approval cards are visible in notifications and the browser panel. Avoid
 * echoing credentials while keeping the command recognizable to the user. */
function redactCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  const redacted = compact
    .replace(
      /(\b(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)([^\s;]+)/gi,
      '$1[redacted]'
    )
    .replace(/(--(?:password|token|secret|api[-_]?key)(?:=|\s+))([^\s;]+)/gi, '$1[redacted]');
  return redacted.length > 200 ? redacted.slice(0, 200) + '…' : redacted;
}

/**
 * Enforces the approval policy for every tool call, regardless of which brain
 * (MCP client or built-in agent) requested it:
 * The commercial product always asks for a decision for terminal-affecting
 * tools when `requireUserApproval` is enabled (the default). Legacy policy
 * modes remain available only for explicitly opted-out/compatibility configs.
 */
export class ApprovalEngine {
  constructor(
    private readonly policy: ApprovalPolicy,
    private readonly gate: UserApprovalGate | null
  ) {}

  async check(
    source: ApprovalSource,
    tool: string,
    params: Record<string, unknown>
  ): Promise<ApprovalDecision> {
    // Reading already-rendered terminal state cannot change the server. It is
    // intentionally approval-free; commands, keystrokes and file transfers
    // still require an explicit decision in the strict product policy.
    if (isReadonlyTool(tool)) return { approved: true, reason: 'read-only tool' };

    const summary = summarizeToolCall(tool, params);
    const findings = inspectRedlines(tool, params);
    const redlineIds = findings.map((finding) => finding.id);
    const redline = toRedlineWarning(findings);

    const askUser = async (): Promise<ApprovalDecision> => {
      if (!this.gate) {
        return {
          approved: false,
          reason: redline
            ? 'redline hit requires secondary confirmation, but no panel is connected'
            : 'user approval is required, but no panel is connected',
          redlineIds,
        };
      }
      const timeoutMs = this.policy.confirmTimeoutMs ?? 120_000;
      const request: ApprovalRequest = {
        requestId: crypto.randomUUID(),
        source,
        tool,
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        summary,
        ...(redline ? { redline } : {}),
        expiresAt: Date.now() + timeoutMs,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const approved = await Promise.race([
          this.gate(request).catch(() => false),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        return {
          approved,
          reason: approved
            ? redline
              ? 'approved by user after redline secondary confirmation'
              : 'approved by user'
            : 'denied by user or confirmation timed out',
          redlineIds,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // A redline always needs a visible second confirmation, even in legacy
    // auto/allowlist modes that otherwise skip the approval prompt.
    if (redline) return askUser();

    const strict =
      this.policy.requireUserApproval === true ||
      (this.policy.requireUserApproval === undefined && this.policy.mode === 'confirm');
    if (strict) return askUser();

    switch (this.policy.mode) {
      case 'auto':
        return { approved: true, reason: 'policy: auto' };
      case 'readonly': {
        const target =
          tool === ToolName.SendCommand && typeof params.command === 'string'
            ? params.command
            : tool === ToolName.SendKey && typeof params.key === 'string'
              ? `key:${params.key}`
              : '';
        const allowlist = this.policy.readonlyAllowlist ?? [];
        const allowed = allowlist.some((pattern) => {
          try {
            return new RegExp(pattern).test(target);
          } catch {
            return false; // an invalid regex in config must never open the gates
          }
        });
        return allowed
          ? { approved: true, reason: 'policy: readonly allowlist' }
          : {
              approved: false,
              reason:
                `approval policy is "readonly" and blocked "${summary}". ` +
                'Ask the user to switch the approval mode or add a readonlyAllowlist entry.',
            };
      }
      case 'confirm':
        return askUser();
    }
  }
}
