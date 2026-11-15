// The forge's store: one token owner, their repositories, and inside each repository a real
// git object store (SHA-1 addressed, byte-exact git serialisation) plus the issue/pull/label
// records the REST, GraphQL and MCP surfaces share. Everything is in memory; a trial seeds a
// fresh forge and drives it for a few minutes, so nothing here touches disk.
//
// Determinism is a scoring rule (the replay pass must reproduce state.json byte for byte), so
// timestamps come from a logical clock, never from the wall clock.

import { createHash } from 'node:crypto';

/** The login the trial's bearer token names (wire.ts's seeded viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (value: string): boolean => HEX40.test(value);

// ---------------------------------------------------------------- git objects

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export const OBJ_TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const OBJ_TYPE_NAME: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.toString('utf8', at, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree order: entries sort by name, directories as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitData(tree: string, parents: readonly string[], authorLine: string, message: string): Buffer {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${authorLine}\ncommitter ${authorLine}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

// ---------------------------------------------------------------- records

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  /** Pre-serialised REST view, kept warm for the read paths. */
  json: Buffer;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  json: Buffer;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  json: Buffer;
}

export type ItemRec = IssueRec | PullRec;

export interface Repo {
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  databaseId: number;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, { type: ObjType; data: Buffer }>;
  /** Commit oid -> parsed parents, filled when a commit enters the store. */
  parentsOf: Map<string, string[]>;
  /** Commit oid -> its tree oid, filled alongside parentsOf. */
  treeOf: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  /** Bumped on every mutation of refs/objects; caches key off it. */
  version: number;
  cache: Map<string, Buffer>;
}

/** The tip of a branch ref on a repo, or null. */
export function branchTipOf(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export class Forge {
  readonly token: string;
  readonly login = VIEWER_LOGIN;
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private commentSeq = 0;
  /** Logical clock: a fixed epoch plus one second per stamp. Deterministic across replays. */
  private clockSec = 1_735_689_600; // 2025-01-01T00:00:00Z

  constructor(token: string) {
    this.token = token;
  }

  /** The next deterministic timestamp, ISO-8601. */
  stamp(): string {
    this.clockSec += 1;
    return new Date(this.clockSec * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** The git author line for commits the API itself creates. */
  authorLine(): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${this.clockSec + 1} +0000`;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      owner: this.login,
      name,
      isPrivate,
      description,
      databaseId: this.repoSeq,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      parentsOf: new Map(),
      treeOf: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      version: 1,
      cache: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Store one object in a repo (idempotent) and index commit structure. Returns the oid. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') {
        const info = parseCommit(data);
        repo.parentsOf.set(oid, info.parents);
        repo.treeOf.set(oid, info.tree);
      }
    }
    return oid;
  }

  /** Store an object whose oid is already known (a received pack entry). */
  putKnownObject(repo: Repo, oid: string, type: ObjType, data: Buffer): void {
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') {
        const info = parseCommit(data);
        repo.parentsOf.set(oid, info.parents);
        repo.treeOf.set(oid, info.tree);
      }
    }
  }

  touch(repo: Repo): void {
    repo.version += 1;
    repo.cache.clear();
  }

  /** The tip of a branch ref, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    return branchTipOf(repo, branch);
  }

  /** Resolve a ref-ish (branch name, full ref, tag name, oid) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    return resolveRefOf(repo, ref);
  }

  /** Follow tag objects to the commit they name. */
  peelToCommit(repo: Repo, oid: string): string | null {
    return peelToCommitOf(repo, oid);
  }

  /** Is `ancestor` reachable from `descendant` through parent links? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    return isAncestorOf(repo, ancestor, descendant);
  }

  /** All commits reachable from `tip`, newest first (BFS over parents). */
  reachableCommits(repo: Repo, tip: string): string[] {
    return reachableCommitsOf(repo, tip);
  }

  /** A merge base of two commits. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    return mergeBaseOf(repo, a, b);
  }

  /** Flatten a tree (recursively) to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    return flattenTreeOf(repo, treeOid, prefix, out);
  }

  /** Build (and store) nested trees for a flat path -> blob oid map. Returns the root tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
    interface Dir {
      files: Map<string, string>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let dir = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        let next = dir.dirs.get(segments[i]);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          dir.dirs.set(segments[i], next);
        }
        dir = next;
      }
      dir.files.set(segments[segments.length - 1], oid);
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of dir.files) entries.push({ mode: '100644', name, oid });
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      return this.putObject(repo, 'tree', buildTreeData(entries));
    };
    return build(root);
  }

  /** Create a commit in the repo from a flat file map. Returns the commit oid. */
  commitFiles(repo: Repo, files: Map<string, string>, parents: readonly string[], message: string): string {
    const tree = this.buildTreeFromFiles(repo, files);
    return this.putObject(repo, 'commit', buildCommitData(tree, parents, this.authorLine(), message));
  }
}

// ---------------------------------------------------------------- repo-scoped helpers

/** Follow tag objects to the commit they name. */
export function peelToCommitOf(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1];
  }
  return null;
}

/** Resolve a ref-ish (branch name, full ref, tag name, oid) to a commit oid, or null. */
export function resolveRefOf(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') return branchTipOf(repo, repo.defaultBranch);
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return peelToCommitOf(repo, oid);
  }
  if (isOid(ref) && repo.objects.has(ref)) return peelToCommitOf(repo, ref);
  return null;
}

/** Is `ancestor` reachable from `descendant` through parent links? */
export function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const stack = [descendant];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const parent of repo.parentsOf.get(current) ?? []) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** All commits reachable from `tip`, newest first (BFS over parents). */
export function reachableCommitsOf(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (!repo.objects.has(current)) continue;
    out.push(current);
    for (const parent of repo.parentsOf.get(current) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return out;
}

/** A merge base of two commits: the first commit reachable from `a` that is also reachable from `b`. */
export function mergeBaseOf(repo: Repo, a: string, b: string): string | null {
  const fromB = new Set(reachableCommitsOf(repo, b));
  const seen = new Set<string>([a]);
  const queue = [a];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (fromB.has(current)) return current;
    for (const parent of repo.parentsOf.get(current) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Flatten a tree (recursively) to path -> {oid, mode}. */
export function flattenTreeOf(
  repo: Repo,
  treeOid: string,
  prefix = '',
  out = new Map<string, { oid: string; mode: string }>(),
): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTreeOf(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}
