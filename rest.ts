// REST v3: the views every surface shares, the domain operations (create issue/pull, merge,
// comments) that REST, GraphQL and MCP all funnel into, and the /api/v3 route handlers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_ID, parseCommit, parseTree, buildCommitData, branchTipOf,
  flattenTreeOf, mergeBaseOf, resolveRefOf, reachableCommitsOf,
  type Forge, type Repo, type IssueRec, type PullRec, type ItemRec, type CommentRec,
} from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** Answer with a JSON body (or a pre-serialised buffer) plus the headers every reply carries. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buffer.length,
    'x-github-request-id': `FORGE-${requestSeq}`,
    ...headers,
  });
  res.end(buffer);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

// ---------------------------------------------------------------- views

export function userView(forge: Forge): Record<string, unknown> {
  return { login: forge.login, id: VIEWER_ID, type: 'User', site_admin: false };
}

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
  };
}

export function labelView(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', default: false, description: null };
}

function itemId(repo: Repo, number: number): number {
  return repo.databaseId * 1_000_000 + number;
}

export function issueView(repo: Repo, item: IssueRec): Record<string, unknown> {
  return {
    id: itemId(repo, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => labelView(repo, name)),
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.state === 'closed' ? item.updatedAt : null,
    pull_request: undefined,
  };
}

export function pullView(repo: Repo, item: PullRec): Record<string, unknown> {
  return {
    id: itemId(repo, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => labelView(repo, name)),
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    head: { ref: item.head, sha: branchTipOf(repo, item.head) ?? '', label: `${repo.owner}:${item.head}` },
    base: { ref: item.base, sha: branchTipOf(repo, item.base) ?? '', label: `${repo.owner}:${item.base}` },
    merged: item.merged,
    merged_at: item.mergedAt,
    merge_commit_sha: item.mergeCommitSha,
    draft: false,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.state === 'closed' ? item.updatedAt : null,
  };
}

export function itemView(repo: Repo, item: ItemRec): Record<string, unknown> {
  return item.kind === 'issue' ? issueView(repo, item) : pullView(repo, item);
}

export function commentView(repo: Repo, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

/** Keep an item's pre-serialised single-read body warm (the read workload hammers one issue). */
export function refreshItemJson(repo: Repo, item: ItemRec): void {
  item.json = Buffer.from(`${JSON.stringify(itemView(repo, item))}\n`, 'utf8');
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: '2025-01-01T00:00:00Z' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z') };
}

export function commitView(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: info.message,
      author: parseAuthorLine(info.author),
      committer: parseAuthorLine(info.committer),
      tree: { sha: info.tree },
    },
    author: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    committer: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    parents: info.parents.map((sha) => ({ sha })),
  };
}

// ---------------------------------------------------------------- domain operations

export function createIssueRec(forge: Forge, repo: Repo, input: { title: string; body: string; labels?: string[] }): IssueRec {
  const now = forge.stamp();
  const item: IssueRec = {
    kind: 'issue',
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
    createdAt: now,
    updatedAt: now,
    json: Buffer.alloc(0),
  };
  repo.nextNumber += 1;
  repo.items.set(item.number, item);
  refreshItemJson(repo, item);
  return item;
}

export function createPullRec(forge: Forge, repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRec {
  const now = forge.stamp();
  const item: PullRec = {
    kind: 'pull',
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
    head: input.head,
    base: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    json: Buffer.alloc(0),
  };
  repo.nextNumber += 1;
  repo.items.set(item.number, item);
  refreshItemJson(repo, item);
  return item;
}

export function addCommentRec(forge: Forge, repo: Repo, item: ItemRec, body: string): CommentRec {
  const comment: CommentRec = {
    id: forge.nextCommentId(),
    body,
    createdAt: forge.stamp(),
    json: Buffer.alloc(0),
  };
  comment.json = Buffer.from(`${JSON.stringify(commentView(repo, comment))}\n`, 'utf8');
  item.comments.push(comment);
  item.updatedAt = comment.createdAt;
  refreshItemJson(repo, item);
  return comment;
}

/** The flat file map at a commit (empty map for null). */
export function filesAt(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  if (commitOid === null) return new Map();
  const tree = repo.treeOf.get(commitOid);
  if (tree === undefined) return new Map();
  return flattenTreeOf(repo, tree);
}

export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp = new Uint32Array(newLines.length + 1);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const saved = dp[j + 1];
      dp[j + 1] = oldLines[i] === newLines[j] ? prev + 1 : Math.max(dp[j + 1], dp[j]);
      prev = saved;
    }
  }
  const lcs = dp[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

function blobText(repo: Repo, oid: string | undefined): string {
  if (oid === undefined) return '';
  const object = repo.objects.get(oid);
  return object === undefined ? '' : object.data.toString('utf8');
}

/** The changes a pull request introduces (merge-base -> head), GitHub's three-dot view. */
export function pullChanges(repo: Repo, pull: PullRec): FileChange[] {
  const headTip = branchTipOf(repo, pull.head);
  const baseTip = branchTipOf(repo, pull.base);
  if (headTip === null || baseTip === null) return [];
  const mergeBase = mergeBaseOf(repo, baseTip, headTip);
  const from = filesAt(repo, mergeBase);
  const to = filesAt(repo, headTip);
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const { additions, deletions } = lineDiff(blobText(repo, before?.oid), blobText(repo, after?.oid));
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? before?.oid ?? '',
    });
  }
  changes.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return changes;
}

/**
 * Three-way merge of head into base. Returns the merged flat file map, or null on conflict
 * (both sides changed the same path differently since the merge base, delete-vs-modify included).
 */
export function mergeTrees(
  repo: Repo,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const mergeBase = mergeBaseOf(repo, baseTip, headTip);
  const baseFiles = filesAt(repo, mergeBase);
  const ours = filesAt(repo, baseTip);
  const theirs = filesAt(repo, headTip);
  const merged = new Map(ours);
  const paths = new Set([...baseFiles.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path)?.oid;
    const our = ours.get(path)?.oid;
    const their = theirs.get(path);
    if (their?.oid === base) continue; // head did not change it
    if (our === base) {
      // only head changed it: take head's version (or its deletion)
      if (their === undefined) merged.delete(path);
      else merged.set(path, their);
    } else if (our !== their?.oid) {
      return null; // both changed it, differently
    }
  }
  return merged;
}

export function pullMergeable(repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = branchTipOf(repo, pull.head);
  const baseTip = branchTipOf(repo, pull.base);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  return mergeTrees(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Merge a pull request into its base branch. Returns the merge commit sha, or null on conflict. */
export function mergePull(forge: Forge, repo: Repo, pull: PullRec, method: string): string | null {
  const headTip = branchTipOf(repo, pull.head);
  const baseTip = branchTipOf(repo, pull.base);
  if (headTip === null || baseTip === null) return null;
  const mergedFiles = mergeTrees(repo, baseTip, headTip);
  if (mergedFiles === null) return null;
  const flat = new Map<string, string>();
  for (const [path, entry] of mergedFiles) flat.set(path, entry.oid);
  let sha: string;
  if (method === 'merge') {
    const tree = forge.buildTreeFromFiles(repo, flat);
    sha = forge.putObject(repo, 'commit', buildCommitData(tree, [baseTip, headTip], forge.authorLine(), `Merge pull request #${pull.number} from ${pull.head}\n`));
  } else {
    sha = forge.commitFiles(repo, flat, [baseTip], `${pull.title}\n`);
  }
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.stamp();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  refreshItemJson(repo, pull);
  forge.touch(repo);
  return sha;
}

// ---------------------------------------------------------------- HTTP handlers

export interface RestContext {
  forge: Forge;
  req: IncomingMessage;
  /** Path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** Raw body text (for the malformed-JSON verdict the caller already made). */
  malformed: boolean;
}

function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function pageSlice<T>(items: T[], query: URLSearchParams): { slice: T[]; perPage: number; page: number; pages: number } {
  const { perPage, page } = pagination(query);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  return { slice: items.slice((page - 1) * perPage, page * perPage), perPage, page, pages };
}

export function handleRest(ctx: RestContext, res: ServerResponse): void {
  const { forge, segments, query } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (ctx.malformed) {
    sendError(res, 400, 'Malformed JSON in request body');
    return;
  }
  const body = ctx.body ?? {};

  // /api/v3/user, /api/v3/meta
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userView(forge));
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: 'forge-1.0.0', verifiable_password_authentication: false });
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || name.includes('/')) {
        sendError(res, 422, 'Repository creation failed: name is invalid');
        return;
      }
      if (forge.repos.has(name)) {
        sendError(res, 422, `Repository creation failed: a repository named '${name}' already exists for this account`);
        return;
      }
      const repo = forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      sendJson(res, 201, repoView(repo));
      return;
    }
    if (method === 'GET') {
      const all = [...forge.repos.values()].map((repo) => repoView(repo));
      const { slice, perPage, page, pages } = pageSlice(all, query);
      const headers: Record<string, string> = {};
      if (page < pages) {
        const origin = `http://${ctx.req.headers.host ?? 'localhost'}`;
        headers.link = `<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", <${origin}/api/v3/user/repos?per_page=${perPage}&page=${pages}>; rel="last"`;
      }
      sendJson(res, 200, slice, headers);
      return;
    }
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1];
    const repo = owner === forge.login ? forge.repos.get(segments[2]) : undefined;
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    handleRepo(ctx, res, repo, segments.slice(3));
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleRepo(ctx: RestContext, res: ServerResponse, repo: Repo, rest: string[]): void {
  const { forge, query } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      requestSeq += 1;
      res.writeHead(204, { 'x-github-request-id': `FORGE-${requestSeq}` });
      res.end();
      return;
    }
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, `Reference already exists: ${ref}`);
        return;
      }
      repo.refs.set(ref, sha);
      forge.touch(repo);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        sendJson(res, 200, all);
        return;
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
  }

  // branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const name = rest.slice(1).join('/');
      const sha = branchTipOf(repo, name);
      if (sha === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name, commit: { sha }, protected: false });
      return;
    }
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? 'HEAD';
    const tip = resolveRefOf(repo, ref);
    if (tip === null) {
      sendError(res, 409, 'Git Repository is Empty');
      return;
    }
    const all = reachableCommitsOf(repo, tip)
      .map((oid) => commitView(repo, oid))
      .filter((view) => view !== null);
    const { slice } = pageSlice(all, query);
    sendJson(res, 200, slice);
    return;
  }

  // contents/{path...}
  if (rest[0] === 'contents') {
    handleContents(ctx, res, repo, rest.slice(1).join('/'));
    return;
  }

  // labels
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      sendError(res, 422, 'Label name is required');
      return;
    }
    if (repo.labels.has(name)) {
      sendError(res, 422, `Label '${name}' already exists`);
      return;
    }
    repo.labels.set(name, { name, color: typeof body.color === 'string' ? body.color : 'ededed' });
    sendJson(res, 201, labelView(repo, name));
    return;
  }

  // issues
  if (rest[0] === 'issues') {
    handleIssues(ctx, res, repo, rest.slice(1));
    return;
  }

  // pulls
  if (rest[0] === 'pulls') {
    handlePulls(ctx, res, repo, rest.slice(1));
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleContents(ctx: RestContext, res: ServerResponse, repo: Repo, path: string): void {
  const { forge, query } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};
  const cleanPath = path.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRefOf(repo, ref);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const files = filesAt(repo, tip);
    if (cleanPath !== '' && files.has(cleanPath)) {
      const entry = files.get(cleanPath) as { oid: string; mode: string };
      const object = repo.objects.get(entry.oid);
      if (object === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        name: cleanPath.split('/').pop(),
        path: cleanPath,
        sha: entry.oid,
        size: object.data.length,
        encoding: 'base64',
        content: object.data.toString('base64'),
      });
      return;
    }
    // Directory listing: entries directly under cleanPath.
    const prefix = cleanPath === '' ? '' : `${cleanPath}/`;
    const seen = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
    let treeOid: string | null = null;
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash === -1) {
        seen.set(remainder, { type: 'file', name: remainder, path: filePath, sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
      } else {
        const dirName = remainder.slice(0, slash);
        if (!seen.has(dirName)) seen.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: '', size: 0 });
      }
    }
    // Fill directory shas from the actual tree objects.
    const rootTree = repo.treeOf.get(tip);
    if (rootTree !== undefined) {
      let current: string | undefined = rootTree;
      if (cleanPath !== '') {
        for (const segment of cleanPath.split('/')) {
          const object = current === undefined ? undefined : repo.objects.get(current);
          if (object === undefined || object.type !== 'tree') {
            current = undefined;
            break;
          }
          current = parseTree(object.data).find((entry) => entry.name === segment && entry.mode === '40000')?.oid;
        }
      }
      treeOid = current ?? null;
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object !== undefined && object.type === 'tree') {
          const listing = parseTree(object.data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: prefix + entry.name,
            sha: entry.oid,
            size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          }));
          sendJson(res, 200, listing);
          return;
        }
      }
    }
    if (cleanPath !== '' && seen.size === 0) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, [...seen.values()]);
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    if (cleanPath === '') {
      sendError(res, 422, 'A file path is required');
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let tip = branchTipOf(repo, branch);
    if (tip === null && typeof body.branch === 'string' && body.branch !== '') {
      // A contents write to a branch that does not exist yet forks it from the default branch.
      tip = branchTipOf(repo, repo.defaultBranch);
    }
    const files = new Map<string, string>();
    for (const [filePath, entry] of filesAt(repo, tip)) files.set(filePath, entry.oid);
    const existing = files.get(cleanPath);
    const message = typeof body.message === 'string' ? body.message : '';
    if (method === 'PUT') {
      const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0);
      const blobOid = forge.putObject(repo, 'blob', content);
      if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing) {
        sendError(res, 409, `${cleanPath} has changed since it was read (sha mismatch)`);
        return;
      }
      if (existing === undefined && typeof body.sha === 'string' && body.sha !== '' && body.sha !== blobOid) {
        sendError(res, 409, `${cleanPath} does not exist at the given sha`);
        return;
      }
      files.set(cleanPath, blobOid);
      const commit = forge.commitFiles(repo, files, tip === null ? [] : [tip], message);
      repo.refs.set(`refs/heads/${branch}`, commit);
      forge.touch(repo);
      sendJson(res, existing === undefined ? 201 : 200, {
        content: { name: cleanPath.split('/').pop(), path: cleanPath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message },
      });
      return;
    }
    // DELETE
    if (existing === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (typeof body.sha === 'string' && body.sha !== existing) {
      sendError(res, 409, `${cleanPath} has changed since it was read (sha mismatch)`);
      return;
    }
    files.delete(cleanPath);
    const commit = forge.commitFiles(repo, files, tip === null ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    forge.touch(repo);
    sendJson(res, 200, { content: null, commit: { sha: commit, message } });
    return;
  }

  sendError(res, 404, 'Not Found');
}

function labelNamesOf(repo: Repo, raw: unknown): { names: string[] } | { error: string } {
  if (raw === undefined) return { names: [] };
  if (!Array.isArray(raw)) return { error: 'labels must be an array' };
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : '');
    if (name === '') return { error: 'labels must name labels' };
    if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist on this repository` };
    names.push(name);
  }
  return { names };
}

function handleIssues(ctx: RestContext, res: ServerResponse, repo: Repo, rest: string[]): void {
  const { forge, query } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};

  if (rest.length === 0) {
    if (method === 'POST') {
      const labels = labelNamesOf(repo, body.labels);
      if ('error' in labels) {
        sendError(res, 422, labels.error);
        return;
      }
      const item = createIssueRec(forge, repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        labels: labels.names,
      });
      sendJson(res, 201, item.json);
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice } = pageSlice(items, query);
      sendJson(res, 200, slice.map((item) => issueView(repo, item as IssueRec)));
      return;
    }
  }

  const number = Number(rest[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;

  if (rest.length === 1 && item !== undefined && item.kind === 'issue') {
    if (method === 'GET') {
      sendJson(res, 200, item.json);
      return;
    }
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') item.state = body.state;
      if (typeof body.title === 'string') item.title = body.title;
      if (typeof body.body === 'string') item.body = body.body;
      if (body.labels !== undefined) {
        const labels = labelNamesOf(repo, body.labels);
        if ('error' in labels) {
          sendError(res, 422, labels.error);
          return;
        }
        item.labels = labels.names;
      }
      item.updatedAt = forge.stamp();
      refreshItemJson(repo, item);
      sendJson(res, 200, item.json);
      return;
    }
  }

  if (rest.length === 2 && rest[1] === 'comments' && item !== undefined) {
    if (method === 'POST') {
      const comment = addCommentRec(forge, repo, item, typeof body.body === 'string' ? body.body : '');
      sendJson(res, 201, comment.json);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, item.comments.map((comment) => commentView(repo, comment)));
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

function branchNameOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let name = raw;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.indexOf(':');
  if (colon !== -1 && !name.includes('/')) name = name.slice(colon + 1);
  else if (colon !== -1) {
    // owner:branch form
    const before = name.slice(0, colon);
    if (!before.includes('/')) name = name.slice(colon + 1);
  }
  return name;
}

function handlePulls(ctx: RestContext, res: ServerResponse, repo: Repo, rest: string[]): void {
  const { forge, query } = ctx;
  const method = ctx.req.method ?? 'GET';
  const body = ctx.body ?? {};

  if (rest.length === 0) {
    if (method === 'POST') {
      const head = branchNameOf(body.head);
      const base = branchNameOf(body.base);
      if (head === '' || base === '' || branchTipOf(repo, head) === null || branchTipOf(repo, base) === null) {
        sendError(res, 422, 'Validation Failed: head and base must name existing branches');
        return;
      }
      const existing = [...repo.items.values()].find(
        (item) => item.kind === 'pull' && item.state === 'open' && (item as PullRec).head === head && (item as PullRec).base === base,
      );
      if (existing !== undefined) {
        sendError(res, 422, `A pull request already exists for ${head} into ${base}`);
        return;
      }
      const item = createPullRec(forge, repo, {
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        head,
        base,
      });
      sendJson(res, 201, item.json);
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'pull') as PullRec[];
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      const { slice } = pageSlice(items, query);
      sendJson(res, 200, slice.map((item) => pullView(repo, item)));
      return;
    }
  }

  const number = Number(rest[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (item === undefined || item.kind !== 'pull') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const pull = item as PullRec;

  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, pull.json);
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pullChanges(repo, pull).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      sha: change.sha,
    })));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged || pull.state !== 'open') {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    const methodName = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const sha = mergePull(forge, repo, pull, methodName);
    if (sha === null) {
      sendError(res, 405, 'Pull Request is not mergeable');
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(res, 404, 'Not Found');
}
