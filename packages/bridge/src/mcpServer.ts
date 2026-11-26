import { randomUUID } from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOLS, REDLINE_POLICY_PROMPT } from '@bastion-pilot/protocol';
import { loadConfig, resolveHome, type BastionPilotConfig } from './config.js';
import { HubClient, selfCliPath } from './hubClient.js';
import { renderToolResult } from './render.js';
import { createLogger, type Logger } from './logger.js';
import { VERSION } from './version.js';

/**
 * Build a HubClient connected to the local daemon, with the same identity
 * defaults used by the stdio MCP server. The daemon is auto-spawned when the
 * port is not yet listening.
 */
function connectHub(config: BastionPilotConfig, log: Logger): HubClient {
  return new HubClient(
    {
      url: `ws://127.0.0.1:${config.server.port}`,
      token: config.security.token,
      name: 'mcp-server',
      version: VERSION,
      // MCP hosts normally spawn one process per conversation. Preserve that
      // identity so the panel can target one Codex/Claude conversation rather
      // than broadcasting a request to every connected agent.
      agentId:
        process.env.BASTION_PILOT_AGENT_ID ??
        `${process.env.BASTION_PILOT_AGENT_NAME ?? 'mcp'}-${process.pid}`,
      conversationId:
        process.env.BASTION_PILOT_CONVERSATION_ID ??
        process.env.CODEX_THREAD_ID ??
        process.env.CODEX_SESSION_ID ??
        process.env.CLAUDE_SESSION_ID,
      label:
        process.env.BASTION_PILOT_AGENT_LABEL ??
        process.env.CODEX_THREAD_TITLE ??
        process.env.CLAUDE_SESSION_NAME ??
        (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID ? 'Codex 对话' : undefined),
      spawnDaemon: {
        command: process.execPath,
        args: [selfCliPath(), 'daemon'],
        env: process.env,
      },
    },
    log
  );
}

/**
 * Register every exposed tool on a fresh McpServer, forwarding calls to the
 * shared HubClient. One server instance maps to one transport connection;
 * stdio uses a single long-lived server, while the HTTP entry point creates a
 * per-connection server so stateful sessions do not collide.
 */
function createMcpServer(hub: HubClient): McpServer {
  const server = new McpServer(
    { name: 'bastion-pilot', version: VERSION },
    {
      instructions: [
        'BastionPilot shares conversation context with its browser side panel. At the start of a related task call get_shared_context; after forming a plan or reaching a conclusion call append_shared_context. When a panel user message includes a requestId, echo that requestId in your assistant append_shared_context response so the panel can correlate the reply. Shared context is background only: always call list_sessions and verify live terminal state before reporting current facts.',
        REDLINE_POLICY_PROMPT,
      ].join('\n\n'),
    }
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.shape },
      async (params: Record<string, unknown>) => {
        try {
          const data = await hub.executeTool('mcp', tool.name, params);
          return { content: [{ type: 'text', text: renderToolResult(tool.name, data) }] };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `ERROR: ${(err as Error).message}` }],
            isError: true,
          };
        }
      }
    );
  }
  return server;
}

/**
 * `bastion-pilot mcp`: an MCP stdio server that forwards tool calls to the
 * daemon. Spawned by MCP clients (Claude Code, Codex, ...); auto-starts the
 * daemon when nothing is listening yet.
 */
export async function runMcpServer(): Promise<void> {
  const log = createLogger('mcp');
  const { config } = loadConfig(resolveHome());

  const hub = connectHub(config, log);
  await hub.connect();

  const server = createMcpServer(hub);
  await server.connect(new StdioServerTransport());
  log.info('MCP stdio server ready (forwarding to daemon)');

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      hub.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('close', shutdown);
  });
}

/**
 * `bastion-pilot mcp-http`: Streamable HTTP MCP entry for MCP clients that
 * cannot spawn a local stdio subprocess (e.g. desktop office clients that only
 * accept a remote URL). Binds to 127.0.0.1 only; every request must carry the
 * pairing token as a Bearer token. The daemon and approval/audit chain are the
 * same ones used by the stdio entry.
 */
export async function runMcpHttpServer(options: { port?: number } = {}): Promise<http.Server> {
  const log = createLogger('mcp-http');
  const { config } = loadConfig(resolveHome());
  const port = options.port ?? config.server.mcpHttpPort ?? 8766;

  const hub = connectHub(config, log);
  await hub.connect();

  const app = express();
  app.disable('x-powered-by');

  // Bearer-token gate: reuse the daemon pairing token. No token, no tools.
  app.use('/mcp', (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const token = match?.[1]?.trim();
    if (!token || token !== config.security.token) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'unauthorized: invalid or missing Bearer token' },
        id: null,
      });
      return;
    }
    next();
  });

  // Per-connection stateful transport. A new McpServer/transport pair is
  // created for each initialized session; the shared HubClient owns the
  // daemon connection underneath.
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  const attach = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session: initialize a fresh transport and bind a dedicated server.
    // Session callbacks must be supplied through the transport options (the
    // SDK wrapper does not expose them as settable properties).
    const server = createMcpServer(hub);
    const session: { transport: StreamableHTTPServerTransport; server: McpServer } = {
      transport: null as unknown as StreamableHTTPServerTransport,
      server,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        void session.transport.close();
      },
    });
    session.transport = transport;
    transport.onerror = (err) => log.error('transport error:', (err as Error).message);
    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);
  };

  app.post('/mcp', (req, res) => void attach(req, res));
  app.get('/mcp', (req, res) => void attach(req, res));
  app.delete('/mcp', (req, res) => void attach(req, res));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  log.info(`MCP Streamable HTTP server ready on http://127.0.0.1:${port}/mcp`);

  const shutdown = () => {
    for (const { transport } of sessions.values()) void transport.close();
    sessions.clear();
    hub.close();
    server.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
