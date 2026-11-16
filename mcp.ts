// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP. It answers application/json, handles the
// handshake (initialize / notifications/initialized), server/discover, tools/list and tools/call for
// six tools that act on the same Store as REST. Revision 2026-07-28 with handshake fallback.

import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Store, type Repo, type Issue } from './store.ts';

const REVISION = '2026-07-28';
const HANDSHAKE_REVS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface Tool { name: string; description: string; inputSchema: unknown; }

const TOOLS: Tool[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository, optionally by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function bearer(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function mcpHandle(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  msg: any,
  send: (status: number, obj: unknown) => void,
): void {
  const method = msg?.method;
  const id = msg?.id;

  // Notifications (no id): acknowledge with 202-ish empty 200.
  if (method === 'notifications/initialized') { send(200, {}); return; }

  if (method === 'initialize') {
    send(200, rpcResult(id, {
      protocolVersion: REVISION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'forge-mcp', version: '0.1.0' },
    }));
    return;
  }

  if (method === 'server/discover') {
    send(200, rpcResult(id, { supportedVersions: HANDSHAKE_REVS }));
    return;
  }

  // Auth required for tools surface.
  if (method === 'tools/list' || method === 'tools/call') {
    if (!bearer(req)) { send(401, rpcError(id, -32000, 'Unauthorized')); return; }
  }

  if (method === 'tools/list') {
    send(200, rpcResult(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const name: string = (msg?.params?.name ?? '').toLowerCase();
    const args = msg?.params?.arguments ?? {};
    const tool = TOOLS.find((t) => name === t.name || name.endsWith(`__${t.name}`) || name.endsWith(t.name));
    if (!tool) { send(200, rpcError(id, -32602, `Unknown tool: ${name}`)); return; }
    try {
      const content = callTool(store, tool.name, args);
      send(200, rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(content) }], structuredContent: content }));
    } catch (e: any) {
      send(200, rpcResult(id, { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }));
    }
    return;
  }

  send(200, rpcError(id, -32601, `Method not found: ${method}`));
}

function ownerRepo(store: Store, args: any): { owner: string; repo: string } {
  if (args.full_name && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/');
    return { owner: o, repo: r };
  }
  return { owner: args.owner ?? store.login, repo: args.repo ?? args.name };
}

function callTool(store: Store, name: string, args: any): unknown {
  if (name === 'create_repo') {
    const rn = args.name ?? args.repo;
    if (!rn) throw new Error('name is required');
    const r = store.getRepo(store.login, rn) ?? store.createRepo(store.login, rn, args.description ?? '');
    return { id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner } };
  }
  if (name === 'get_repo') {
    const { owner, repo } = ownerRepo(store, args);
    const r = store.getRepo(owner, repo);
    if (!r) throw new Error('Not Found');
    return { id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner } };
  }
  if (name === 'create_issue') {
    const { owner, repo } = ownerRepo(store, args);
    const r = store.getRepo(owner, repo);
    if (!r) throw new Error('Not Found');
    const n = store.nextIssueNumber(r);
    const issue: Issue = { id: 1000 + n, number: n, title: args.title ?? '', body: args.body ?? '', state: 'open', labels: [], createdAt: Date.now() };
    r.issues.set(n, issue);
    return { id: issue.id, number: n, title: issue.title, state: issue.state };
  }
  if (name === 'list_issues') {
    const { owner, repo } = ownerRepo(store, args);
    const r = store.getRepo(owner, repo);
    if (!r) throw new Error('Not Found');
    let issues = [...r.issues.values()];
    if (args.state && args.state !== 'all') issues = issues.filter((i) => i.state === args.state);
    return issues.map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state }));
  }
  if (name === 'create_pull_request') {
    const { owner, repo } = ownerRepo(store, args);
    const r = store.getRepo(owner, repo);
    if (!r) throw new Error('Not Found');
    const n = store.nextPullNumber(r);
    r.pulls.set(n, { id: 2000 + n, number: n, title: args.title ?? '', body: args.body ?? '', head: args.head ?? '', base: args.base ?? r.defaultBranch, state: 'open', merged: false, mergeCommit: null, createdAt: Date.now() });
    return { number: n, state: 'open' };
  }
  if (name === 'merge_pull_request') {
    const { owner, repo } = ownerRepo(store, args);
    const r = store.getRepo(owner, repo);
    if (!r) throw new Error('Not Found');
    const p = r.pulls.get(args.pull_number);
    if (!p) throw new Error('Not Found');
    p.state = 'closed'; p.merged = true;
    return { merged: true, number: p.number };
  }
  throw new Error(`unhandled tool ${name}`);
}
