// A tiny GraphQL executor for just the documents gh and github-mcp-server send: introspection of the
// Issue, PullRequest, Repository and SearchType types, repository(...).issues with ordering and state
// filters, and createPullRequest. Not a full GraphQL engine; a pragmatic matcher over the real queries.

import { type Store, type Repo } from './store.ts';

interface GqlResult { data?: unknown; errors?: { message: string }[]; }

// Field lists the suite's introspection checks require per type.
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

function introspectType(name: string): unknown | null {
  if (name === 'SearchType') {
    return { name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((n) => ({ name: n })) };
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return { name, kind: 'OBJECT', fields: fields.map((f) => ({ name: f })) };
}

function splitOperations(query: string): string[] {
  // Rough: the suite may send two operation documents concatenated. Split on top-level "query"/"mutation".
  const ops: string[] = [];
  const re = /\b(query|mutation)\b/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) starts.push(m.index);
  if (starts.length <= 1) return [query];
  for (let i = 0; i < starts.length; i++) ops.push(query.slice(starts[i], starts[i + 1] ?? query.length));
  return ops;
}

function execOne(store: Store, query: string, variables: Record<string, unknown>): GqlResult {
  // __type(name: "X")
  const typeMatch = query.match(/__type\s*\(\s*name:\s*"([^"]+)"/);
  if (typeMatch) {
    const t = introspectType(typeMatch[1]);
    return { data: { __type: t } };
  }

  // createPullRequest mutation
  if (/createPullRequest/.test(query)) {
    const input = (variables.input as any) ?? variables;
    const repoId = input?.repositoryId;
    const head = input?.headRefName ?? input?.head;
    const base = input?.baseRefName ?? input?.base ?? 'main';
    const repo = repoById(store, repoId);
    if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'repository not found' }] };
    const n = store.nextPullNumber(repo);
    const pull = { id: 2000 + n, number: n, title: input?.title ?? '', body: input?.body ?? '', head, base, state: 'open' as const, merged: false, mergeCommit: null, createdAt: Date.now() };
    repo.pulls.set(n, pull);
    return { data: { createPullRequest: { pullRequest: { id: `PR_${pull.id}`, number: n, headRefName: head, baseRefName: base, state: 'OPEN', merged: false } } } };
  }

  // repository(owner, name){ issues/... }
  const repoMatch = query.match(/repository\s*\(\s*owner:\s*"?([^",)]+)"?\s*,\s*name:\s*"?([^",)]+)"?/) ||
    (variables.owner && variables.name ? { 1: variables.owner, 2: variables.name } as any : null);
  if (repoMatch || /repository\s*\(/.test(query)) {
    const owner = (repoMatch?.[1] ?? variables.owner) as string;
    const name = (repoMatch?.[2] ?? variables.name) as string;
    const repo = store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };

    if (/\bissues\b/.test(query)) {
      const descending = /direction:\s*DESC/.test(query);
      const openOnly = /states:\s*\[\s*OPEN\s*\]/.test(query);
      let issues = [...repo.issues.values()];
      if (openOnly) issues = issues.filter((i) => i.state === 'open');
      issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      return { data: { repository: { id: `R_${repo.id}`, databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, issues: { nodes: issues.map((i) => ({ id: `I_${i.id}`, number: i.number, title: i.title, state: i.state.toUpperCase(), body: i.body })) } } } };
    }
    return { data: { repository: { id: `R_${repo.id}`, databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, defaultBranchRef: { name: repo.defaultBranch }, viewerPermission: 'ADMIN', hasIssuesEnabled: true } } };
  }

  // viewer { login }
  if (/\bviewer\b/.test(query)) return { data: { viewer: { login: store.login } } };

  // Unknown field -> 200 with errors naming it.
  const field = query.match(/\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/);
  return { data: null, errors: [{ message: `Field '${field?.[1] ?? 'unknown'}' doesn't exist` }] };
}

function repoById(store: Store, id: unknown): Repo | undefined {
  const num = typeof id === 'string' ? parseInt(id.replace(/^R_/, ''), 10) : (typeof id === 'number' ? id : NaN);
  for (const r of store.listRepos(store.login)) if (r.id === num) return r;
  return undefined;
}

export function graphqlExecute(store: Store, query: string, variables: Record<string, unknown>): GqlResult | GqlResult[] {
  const ops = splitOperations(query);
  if (ops.length > 1) return ops.map((o) => execOne(store, o, variables));
  return execOne(store, query, variables);
}
