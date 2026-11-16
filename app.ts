// The forge's HTTP surface: git smart HTTP, REST v3 (/api/v3), GraphQL (/api/graphql) and MCP (/mcp),
// all over one in-memory Store. main.ts keeps the harness lifecycle; this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store, type Repo, type Issue, type Pull } from './store.ts';
import {
  uploadPackV2Advertise, uploadPackV0Advertise, uploadPackV2,
  receivePackAdvertise, receivePack,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function reqId(): string { return randomUUID(); }

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': reqId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'token';
const LOGIN = process.env.MAKEFUN_SHOP_LOGIN ?? 'octocat';

function repoJson(r: Repo): unknown {
  return {
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: 1, type: 'User' },
    private: false,
    description: r.description,
    default_branch: r.defaultBranch,
    fork: false,
  };
}

function issueJson(r: Repo, i: Issue): unknown {
  return {
    id: i.id,
    node_id: `I_${i.id}`,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((n) => ({ name: n })),
    html_url: `/${r.owner}/${r.name}/issues/${i.number}`,
  };
}

function pullJson(r: Repo, p: Pull): unknown {
  return {
    id: p.id,
    node_id: `PR_${p.id}`,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merge_commit_sha: p.mergeCommit,
    head: { ref: p.head, sha: r.refs.get(`refs/heads/${p.head}`) ?? null },
    base: { ref: p.base, sha: r.refs.get(`refs/heads/${p.base}`) ?? null },
  };
}

export function createApp(): Server {
  const store = new Store(LOGIN);

  return createServer((req, res) => {
    handle(req, res, store).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { message: String(err) });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true });

  // ---- git smart HTTP ---- /{owner}/{repo}.git/...
  const git = path.match(/^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/);
  if (git) return gitSmart(req, res, store, git[1], git[2], git[3] ?? '');

  // ---- MCP ----
  if (path === '/mcp') return mcp(req, res, store);

  // ---- GraphQL ----
  if (path === '/api/graphql') return graphql(req, res, store);

  // ---- REST v3 ----
  if (path === '/api/v3' || path === '/api/v3/') {
    if (!bearer(req)) return sendJson(res, 401, { message: 'Requires authentication' });
    return sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo' });
  }
  if (path === '/api/v3/meta') {
    return sendJson(res, 200, { installed_version: '3.12.0', verifiable_password_authentication: false });
  }
  if (path.startsWith('/api/v3/')) return restV3(req, res, store, path, method, url);

  return sendJson(res, 404, { message: 'Not Found' });
}

// ===================== REST v3 =====================

async function restV3(req: IncomingMessage, res: ServerResponse, store: Store, path: string, method: string, url: URL): Promise<void> {
  if (!bearer(req)) return sendJson(res, 401, { message: 'Requires authentication' });
  const seg = path.split('/').filter(Boolean); // ['api','v3',...]
  const rest = seg.slice(2);

  // GET /user/repos ; POST /user/repos
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = store.listRepos(store.login);
      const per = 30;
      const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
      const slice = all.slice((page - 1) * per, page * per);
      const headers: Record<string, string> = {};
      if (all.length > page * per) headers['link'] = `<${url.pathname}?page=${page + 1}>; rel="next"`;
      return sendJson(res, 200, slice.map(repoJson), headers);
    }
    if (method === 'POST') {
      const body = await parseJson(req, res); if (body === undefined) return;
      const name = (body as any)?.name;
      if (typeof name !== 'string' || name === '') return sendJson(res, 422, { message: 'name is required' });
      if (store.getRepo(store.login, name)) return sendJson(res, 422, { message: 'name already exists' });
      const r = store.createRepo(store.login, name, (body as any)?.description ?? '');
      return sendJson(res, 201, repoJson(r));
    }
  }

  // /repos/{owner}/{repo}...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1], name = rest[2], tail = rest.slice(3);
    const repo = store.getRepo(owner, name);

    if (tail.length === 0) {
      if (owner !== store.login) return sendJson(res, 404, { message: 'Not Found' });
      if (method === 'GET') return repo ? sendJson(res, 200, repoJson(repo)) : sendJson(res, 404, { message: 'Not Found' });
      if (method === 'PATCH') {
        if (!repo) return sendJson(res, 404, { message: 'Not Found' });
        const body = await parseJson(req, res); if (body === undefined) return;
        if (typeof (body as any)?.description === 'string') repo.description = (body as any).description;
        if (typeof (body as any)?.name === 'string') repo.name = (body as any).name;
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return sendJson(res, 404, { message: 'Not Found' });
        store.deleteRepo(owner, name);
        return sendRaw(res, 204, JSON_TYPE, Buffer.alloc(0));
      }
    }

    if (!repo) return sendJson(res, 404, { message: 'Not Found' });

    // contents/{path}
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') {
        const body = await parseJson(req, res); if (body === undefined) return;
        const content = Buffer.from((body as any)?.content ?? '', 'base64');
        const message = (body as any)?.message ?? 'update';
        const sha = (body as any)?.sha as string | undefined;
        const branch = repo.defaultBranch;
        const head = repo.refs.get(`refs/heads/${branch}`) ?? null;
        const exists = fileSha(store, repo, filePath, head);
        if (exists && sha && sha !== exists) return sendJson(res, 409, { message: 'sha does not match' });
        const commit = store.commitFile(repo, filePath, content, message, head);
        repo.refs.set(`refs/heads/${branch}`, commit);
        if (!repo.refs.has('HEAD')) repo.refs.set('HEAD', commit);
        const newBlob = fileSha(store, repo, filePath, commit);
        return sendJson(res, exists ? 200 : 201, {
          content: { path: filePath, sha: newBlob },
          commit: { sha: commit },
        });
      }
      if (method === 'DELETE') {
        const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
        const exists = fileSha(store, repo, filePath, head);
        if (!exists) return sendJson(res, 404, { message: 'Not Found' });
        const commit = store.commitFile(repo, filePath, Buffer.alloc(0), 'delete', head); // tombstone-less: flat
        // remove entry: rebuild tree without path
        removeFile(store, repo, filePath, head);
        return sendJson(res, 200, { commit: { sha: repo.refs.get(`refs/heads/${repo.defaultBranch}`) } });
      }
    }

    // labels
    if (tail[0] === 'labels' && method === 'POST') {
      const body = await parseJson(req, res); if (body === undefined) return;
      const lname = (body as any)?.name;
      if (typeof lname !== 'string' || lname === '') return sendJson(res, 422, { message: 'name is required' });
      repo.labels.add(lname);
      return sendJson(res, 201, { name: lname });
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'POST') {
        const body = await parseJson(req, res); if (body === undefined) return;
        const labels: string[] = Array.isArray((body as any)?.labels) ? (body as any).labels : [];
        for (const l of labels) if (!repo.labels.has(l)) return sendJson(res, 422, { message: `label ${l} does not exist` });
        const n = store.nextIssueNumber(repo);
        const issue: Issue = { id: 1000 + n, number: n, title: (body as any)?.title ?? '', body: (body as any)?.body ?? '', state: 'open', labels, createdAt: Date.now() };
        repo.issues.set(n, issue);
        return sendJson(res, 201, issueJson(repo, issue));
      }
      if (tail.length === 2 && method === 'GET') {
        const i = repo.issues.get(parseInt(tail[1], 10));
        return i ? sendJson(res, 200, issueJson(repo, i)) : sendJson(res, 404, { message: 'Not Found' });
      }
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'POST') {
        const body = await parseJson(req, res); if (body === undefined) return;
        const n = store.nextPullNumber(repo);
        const pull: Pull = { id: 2000 + n, number: n, title: (body as any)?.title ?? '', body: (body as any)?.body ?? '', head: (body as any)?.head ?? '', base: (body as any)?.base ?? repo.defaultBranch, state: 'open', merged: false, mergeCommit: null, createdAt: Date.now() };
        repo.pulls.set(n, pull);
        return sendJson(res, 201, pullJson(repo, pull));
      }
      if (tail.length === 2 && method === 'GET') {
        const p = repo.pulls.get(parseInt(tail[1], 10));
        return p ? sendJson(res, 200, pullJson(repo, p)) : sendJson(res, 404, { message: 'Not Found' });
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const p = repo.pulls.get(parseInt(tail[1], 10));
        if (!p) return sendJson(res, 404, { message: 'Not Found' });
        const headSha = repo.refs.get(`refs/heads/${p.head}`);
        if (!headSha) return sendJson(res, 405, { message: 'not mergeable' });
        // squash commit onto base
        const baseSha = repo.refs.get(`refs/heads/${p.base}`) ?? null;
        const squash = store.commitFile(repo, `.merge/${p.number}`, Buffer.from(`merged #${p.number}\n`), `Merge pull request #${p.number}`, baseSha);
        repo.refs.set(`refs/heads/${p.base}`, squash);
        p.state = 'closed'; p.merged = true; p.mergeCommit = squash;
        return sendJson(res, 200, { sha: squash, merged: true, message: 'Pull Request successfully merged' });
      }
    }
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

async function parseJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return undefined; }
}

// file helpers over the flat-tree model
import { parseTree, parseCommitTree, buildTree } from './store.ts';
function fileSha(store: Store, repo: Repo, path: string, commit: string | null): string | null {
  if (!commit) return null;
  const c = repo.objects.get(commit); if (!c || c.type !== 'commit') return null;
  const treeSha = parseCommitTree(c.data); if (!treeSha) return null;
  for (const e of parseTree(repo.objects.get(treeSha)?.data)) if (e.name === path) return e.sha;
  return null;
}
function removeFile(store: Store, repo: Repo, path: string, commit: string | null): void {
  if (!commit) return;
  const c = repo.objects.get(commit); if (!c || c.type !== 'commit') return;
  const treeSha = parseCommitTree(c.data); if (!treeSha) return;
  const entries = new Map<string, { mode: string; sha: string }>();
  for (const e of parseTree(repo.objects.get(treeSha)?.data)) if (e.name !== path && !e.name.startsWith('.merge/')) entries.set(e.name, { mode: e.mode, sha: e.sha });
  const newTree = store.putObject(repo, 'tree', buildTree(entries));
  const newCommit = buildCommitWrap(store, repo, newTree, commit, `delete ${path}`);
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, newCommit);
}
import { buildCommit } from './store.ts';
function buildCommitWrap(store: Store, repo: Repo, tree: string, parent: string, msg: string): string {
  return store.putObject(repo, 'commit', buildCommit(tree, parent, msg));
}

// ===================== git smart HTTP =====================

async function gitSmart(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string, tail: string): Promise<void> {
  const repo = store.getRepo(owner, name);
  // info/refs advertisement
  if (req.method === 'GET' && tail === '/info/refs') {
    const service = new URL(req.url ?? '/', 'http://forge').searchParams.get('service');
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    if (service === 'git-upload-pack') {
      const version = req.headers['git-protocol'];
      if (typeof version === 'string' && version.includes('version=2')) {
        return sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackV2Advertise());
      }
      return sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackV0Advertise(repo));
    }
    if (service === 'git-receive-pack') {
      return sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', receivePackAdvertise(repo));
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }
  if (req.method === 'POST' && tail === '/git-upload-pack') {
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const body = await readBody(req);
    const version = req.headers['git-protocol'];
    const out = (typeof version === 'string' && version.includes('version=2'))
      ? uploadPackV2(repo, body) : uploadPackV2(repo, body);
    return sendRaw(res, 200, 'application/x-git-upload-pack-result', out);
  }
  if (req.method === 'POST' && tail === '/git-receive-pack') {
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const body = await readBody(req);
    const out = receivePack(repo, store, body);
    return sendRaw(res, 200, 'application/x-git-receive-pack-result', out);
  }
  return sendJson(res, 404, { message: 'Not Found' });
}

// ===================== GraphQL =====================

async function graphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (!bearer(req)) return sendJson(res, 401, { message: 'requires authentication' });
  const body = await parseJson(req, res); if (body === undefined) return;
  const query = (body as any)?.query ?? '';
  const variables = (body as any)?.variables ?? {};
  const { graphqlExecute } = await import('./graphql.ts');
  return sendJson(res, 200, graphqlExecute(store, query, variables));
}

// ===================== MCP =====================

async function mcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { message: 'method not allowed' });
  const raw = await readBody(req);
  let msg: any;
  try { msg = JSON.parse(raw.toString('utf8')); }
  catch { return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const { mcpHandle } = await import('./mcp.ts');
  return mcpHandle(req, res, store, msg, (status, obj) => sendJson(res, status, obj));
}
