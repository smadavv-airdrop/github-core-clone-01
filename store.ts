// In-memory data model for the forge: repositories, their git object store, refs, files, issues,
// labels and pull requests. One process, one store; every surface (REST v3, GraphQL, MCP, git smart
// HTTP) acts on this same store so an object created over one reads back over another unchanged.

import { createHash } from 'node:crypto';

export interface GitObject {
  readonly type: 'blob' | 'tree' | 'commit';
  readonly data: Buffer;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommit: string | null;
  createdAt: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  defaultBranch: string;
  createdAt: number;
  objects: Map<string, GitObject>; // sha1 hex -> object
  refs: Map<string, string>; // full ref name -> sha1
  issues: Map<number, Issue>;
  labels: Set<string>;
  pulls: Map<number, Pull>;
  issueSeq: number;
  pullSeq: number;
}

let idSeq = 1;
const nextId = (): number => idSeq++;

export class Store {
  readonly login: string;
  private repos = new Map<string, Repo>(); // "owner/name" -> repo

  constructor(login: string) {
    this.login = login;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description = ''): Repo {
    const repo: Repo = {
      id: nextId(),
      name,
      owner,
      description,
      defaultBranch: 'main',
      createdAt: Date.now(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      labels: new Set(),
      pulls: new Map(),
      issueSeq: 0,
      pullSeq: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // ---- git object helpers ----

  static hashObject(type: GitObject['type'], data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`);
    return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const sha = Store.hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  // Build a commit from a single-file tree, chained on `parent` (or root).
  commitFile(repo: Repo, path: string, content: Buffer, message: string, parent: string | null): string {
    const blob = this.putObject(repo, 'blob', content);
    // Carry forward the parent's tree entries, then set/replace this path (flat tree only).
    const entries = new Map<string, { mode: string; sha: string }>();
    if (parent) {
      const pc = repo.objects.get(parent);
      if (pc && pc.type === 'commit') {
        const treeSha = parseCommitTree(pc.data);
        if (treeSha) for (const e of parseTree(repo.objects.get(treeSha)?.data)) entries.set(e.name, { mode: e.mode, sha: e.sha });
      }
    }
    entries.set(path, { mode: '100644', sha: blob });
    const treeSha = this.putObject(repo, 'tree', buildTree(entries));
    const commit = buildCommit(treeSha, parent, message);
    return this.putObject(repo, 'commit', commit);
  }

  nextIssueNumber(repo: Repo): number {
    repo.issueSeq += 1;
    return repo.issueSeq;
  }

  nextPullNumber(repo: Repo): number {
    repo.pullSeq += 1;
    return repo.pullSeq;
  }
}

// ---- git object encode/decode (loose format bodies, no zlib here) ----

export function buildTree(entries: Map<string, { mode: string; sha: string }>): Buffer {
  // Tree entries are sorted by name (git's ordering, bytewise with a trailing / for dirs; flat here).
  const names = [...entries.keys()].sort();
  const parts: Buffer[] = [];
  for (const name of names) {
    const e = entries.get(name)!;
    parts.push(Buffer.from(`${e.mode} ${name}\0`), Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer | undefined): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  if (!data) return out;
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = data.toString('utf8', i, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

export function buildCommit(tree: string, parent: string | null, message: string): Buffer {
  const who = 'forge <forge@make.fun> 0 +0000';
  let text = `tree ${tree}\n`;
  if (parent) text += `parent ${parent}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message}\n`;
  return Buffer.from(text);
}

export function parseCommitTree(data: Buffer): string | null {
  const text = data.toString('utf8');
  const m = text.match(/^tree ([0-9a-f]{40})/m);
  return m ? m[1] : null;
}
