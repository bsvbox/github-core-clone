// Model Context Protocol over streamable HTTP (POST /mcp).
// Both eras the suite accepts: modern 2026-07-28 (`server/discover`, no
// handshake, no session) and legacy (initialize + notifications/initialized).
// The client in the kit (sdk/conformance/mcp-client.ts) is the authority.

import type { Forge, RepoRecord } from './store.ts';
import { parseJson } from './util.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function repoJson(forge: Forge, repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${forge.viewerLogin}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: forge.viewerLogin, id: forge.viewerId },
  };
}

function textResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') return req;
  }
  return null;
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): RepoRecord | string {
  const owner = args.owner as string | undefined;
  const repoName = (args.repo as string | undefined) ?? (args.repository as string | undefined);
  if (!repoName) return 'repo is required';
  if (owner !== undefined && owner !== forge.viewerLogin) return 'repository not found';
  const repo = forge.getRepo(repoName);
  return repo ?? 'repository not found';
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { __rpcError: -32602, __message: `unknown tool: ${name}` };
  const missing = missingArgs(tool, args);
  if (missing) return errorResult(`missing required argument: ${missing}`);

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (forge.getRepo(repoName)) return errorResult('name already exists on this account');
    const repo = forge.createRepo(
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    )!;
    return textResult(repoJson(forge, repo));
  }

  const resolved = resolveRepo(forge, args);
  if (typeof resolved === 'string') return errorResult(resolved);
  const repo = resolved;

  if (name === 'get_repo') {
    return textResult(repoJson(forge, repo));
  }
  if (name === 'create_issue') {
    const issue = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return textResult({
      id: issue.id,
      node_id: forge.issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [],
    });
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.number - a.number);
    return textResult(list.map((i) => ({
      id: i.id,
      node_id: forge.issueGlobalId(repo, i),
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      labels: i.labels.map((l) => ({ name: l })),
    })));
  }
  if (name === 'create_pull_request') {
    const result = forge.createPull(repo, String(args.head), String(args.base), String(args.title), typeof args.body === 'string' ? args.body : '');
    if ('error' in result) return errorResult(result.error);
    return textResult({
      id: result.id,
      node_id: forge.pullGlobalId(repo, result),
      number: result.number,
      title: result.title,
      body: result.body,
      state: result.state,
      head: { ref: result.headRef, sha: result.headSha },
      base: { ref: result.baseRef, sha: result.baseSha },
    });
  }
  if (name === 'merge_pull_request') {
    const pr = forge.getPull(repo, Number(args.pull_number));
    if (!pr) return errorResult('pull request not found');
    if (pr.state !== 'open') return errorResult('pull request is not open');
    if (forge.mergeConflict(repo, pr)) return errorResult('merge conflict');
    const sha = forge.mergePull(repo, pr)!;
    return textResult({ merged: true, number: pr.number, sha, state: pr.state });
  }
  return errorResult(`unknown tool: ${name}`);
}

export interface McpResponse {
  status: number;
  json?: unknown;
  empty?: boolean;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/** Handle one MCP HTTP request body. */
export function handleMcp(forge: Forge, body: Buffer): McpResponse {
  const parsed = parseJson(body);
  if (parsed === null) {
    // Parse error: extract an id from the raw body if one is visible.
    const m = /"id"\s*:\s*("[^"]*"|\d+)/.exec(body.toString('utf8'));
    let id: unknown = null;
    if (m) {
      try { id = JSON.parse(m[1]); } catch { id = null; }
    }
    return rpcError(id, -32700, 'Parse error', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = parsed as { method?: unknown; params?: unknown; id?: unknown };
  const method = typeof req.method === 'string' ? req.method : '';
  const id = 'id' in req ? req.id : undefined;
  const params = (req.params && typeof req.params === 'object' && !Array.isArray(req.params))
    ? (req.params as Record<string, unknown>)
    : {};

  // A request without an id is a notification: answer 202 with no body.
  if (id === undefined) {
    return { status: 202, empty: true };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      serverInfo: serverInfo(),
      capabilities: { tools: {} },
      supportedVersions: [...SUPPORTED_VERSIONS],
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'initialize') {
    const offered = (params.protocolVersion as string | undefined) ?? '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = params.name as string | undefined;
    const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};
    if (typeof toolName !== 'string' || toolName.length === 0) {
      return rpcError(id, -32602, 'tools/call requires a tool name');
    }
    const outcome = callTool(forge, toolName, args);
    if ('__rpcError' in outcome) {
      return rpcError(id, outcome.__rpcError as number, String(outcome.__message ?? 'tool error'));
    }
    return rpcResult(id, outcome);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
