// MCP over streamable HTTP at /mcp: JSON-RPC 2.0, plain JSON answers. Both protocol eras are
// served: the modern one (server/discover, no handshake) and the legacy handshake
// (initialize + notifications/initialized). The six tools are github-mcp-server's canonical
// names over the same domain operations the REST surface uses.

import type { ServerResponse } from 'node:http';
import { branchTipOf, type Forge, type Repo } from './store.ts';
import {
  repoView, issueView, pullView, createIssueRec, createPullRec, mergePull,
} from './rest.ts';
import type { PullRec } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
const STRING = { type: 'string' };

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema({ name: STRING, description: STRING, private: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, pull_number: { type: 'integer' } }, ['owner', 'repo', 'pull_number']),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolResult(view: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: view,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  if (args.owner !== forge.login) return null;
  return forge.repos.get(String(args.repo ?? '')) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: { code: number; message: string } } {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  const schema = tool.inputSchema as { required?: string[] };
  for (const required of schema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { rpcError: { code: -32602, message: `missing required argument: ${required}` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.repos.has(repoName)) return toolError(`a repository named '${repoName}' already exists`);
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      return repo === null ? toolError('repository not found') : toolResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const item = createIssueRec(forge, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolResult(issueView(repo, item));
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = [...repo.items.values()].filter(
        (item) => item.kind === 'issue' && (state === 'all' || item.state === state),
      );
      return toolResult(items.map((item) => issueView(repo, item as never)));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const head = String(args.head);
      const base = String(args.base);
      if (branchTipOf(repo, head) === null || branchTipOf(repo, base) === null) {
        return toolError('head and base must name existing branches');
      }
      const item = createPullRec(forge, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return toolResult(pullView(repo, item));
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const item = repo.items.get(Number(args.pull_number));
      if (item === undefined || item.kind !== 'pull') return toolError('pull request not found');
      const pull = item as PullRec;
      const sha = mergePull(forge, repo, pull, 'squash');
      if (sha === null) return toolError('pull request is not mergeable');
      return toolResult(pullView(repo, pull));
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

interface RpcOutcome {
  status: number;
  payload?: unknown;
}

/** Handle one JSON-RPC request object. Notifications answer with status 202 and no payload. */
function handleRpc(forge: Forge, request: Record<string, unknown>): RpcOutcome {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown): RpcOutcome => ({ status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } });
  const replyError = (code: number, message: string): RpcOutcome => ({
    status: 200,
    payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
  });

  if (isNotification) return { status: 202 };

  switch (method) {
    case 'server/discover':
      return reply({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return reply({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(forge, toolName, args);
      if ('rpcError' in outcome) return replyError(outcome.rpcError.code, outcome.rpcError.message);
      return reply(outcome);
    }
    default:
      return replyError(-32601, `method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, rawBody: Buffer, res: ServerResponse): void {
  const send = (status: number, payload?: unknown): void => {
    if (payload === undefined) {
      res.writeHead(status, { 'content-length': 0 });
      res.end();
      return;
    }
    const buffer = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buffer.length });
    res.end(buffer);
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const outcomes = parsed.map((entry) => handleRpc(forge, (entry ?? {}) as Record<string, unknown>));
    send(200, outcomes.filter((outcome) => outcome.payload !== undefined).map((outcome) => outcome.payload));
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const outcome = handleRpc(forge, parsed as Record<string, unknown>);
  send(outcome.status, outcome.payload);
}
