// GraphQL v4: a small parser + executor covering exactly the documents gh and
// github-mcp-server send (see checks-graphql.ts's document list): viewer, repository reads,
// issue/pull connections with cursor pagination, the five mutations, node(id:), __type
// introspection, aliases, inline fragments, variables, input objects, enum lists, null
// variables, operation names, and batched operations (a JSON array body).

import type { ServerResponse } from 'node:http';
import { branchTipOf, type Forge, type Repo, type IssueRec, type PullRec, type ItemRec } from './store.ts';
import {
  createIssueRec, createPullRec, addCommentRec, mergePull, pullChanges, pullMergeable, refreshItemJson,
} from './rest.ts';

// ---------------------------------------------------------------- global ids

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`R:${repo.databaseId}`, 'utf8').toString('base64url');
}
export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`I:${repo.databaseId}:${number}`, 'utf8').toString('base64url');
}
export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`P:${repo.databaseId}:${number}`, 'utf8').toString('base64url');
}
export function commentGlobalId(id: number): string {
  return Buffer.from(`C:${id}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token = { kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        tokens.push({ kind: 'string', value: source.slice(at + 3, end === -1 ? source.length : end) });
        at = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const esc = source[at + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (at < source.length && /[0-9.eE+-]/.test(source[at])) {
        value += source[at];
        at += 1;
      }
      tokens.push({ kind: value.includes('.') || value.includes('e') || value.includes('E') ? 'float' : 'int', value });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (at < source.length && /[_0-9A-Za-z]/.test(source[at])) {
        value += source[at];
        at += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private at = 0;
  constructor(source: string) {
    this.tokens = lex(source);
  }
  private peek(): Token {
    return this.tokens[this.at];
  }
  private next(): Token {
    const token = this.tokens[this.at];
    this.at += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}', got '${token.value}'`);
  }
  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated block');
      if (token.kind === 'punct' && token.value === open) depth += 1;
      if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalanced('(', ')');
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalanced('(', ')');
        this.skipDirectives();
        operations.push({ operation: token.value as 'query' | 'mutation', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.next(); // 'on'
        this.next(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token '${token.value}'`);
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      const first = this.next();
      if (first.kind !== 'name') throw new Error(`expected a field name, got '${first.value}'`);
      let alias: string | null = null;
      let name = first.value;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args: FieldNode['args'] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          const argName = this.next().value;
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.next();
      }
      this.skipDirectives();
      let selection: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.next();
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token '${token.value}'`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema (for introspection + validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'createdAt', 'updatedAt', 'author', 'mergedAt',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'createdAt', 'author'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  State: ['OPEN', 'CLOSED'],
};

const OBJECT_TYPES = new Set(Object.keys(TYPE_FIELDS));

// ---------------------------------------------------------------- execution

interface Tagged {
  __type: string;
  [key: string]: unknown;
}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

class GqlError extends Error {}

function tag(type: string, fields: Record<string, unknown>): Tagged {
  return { __type: type, ...fields };
}

function userTag(forge: Forge): Tagged {
  return tag('User', { login: forge.login });
}

function repoTag(repo: Repo): Tagged {
  return tag('Repository', { repo });
}
function issueTag(repo: Repo, item: IssueRec): Tagged {
  return tag('Issue', { repo, item });
}
function pullTag(repo: Repo, item: PullRec): Tagged {
  return tag('PullRequest', { repo, item });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}
function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

type Resolver = (source: Tagged, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_s, _a, ctx) => userTag(ctx.forge),
    repository: (_s, args, ctx) => {
      if (args.owner !== ctx.forge.login) return null;
      const repo = ctx.forge.repos.get(String(args.name));
      return repo === undefined ? null : repoTag(repo);
    },
    node: (_s, args, ctx) => nodeById(ctx, String(args.id ?? '')),
    __type: (_s, args) => typeTag(String(args.name ?? '')),
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new GqlError('repository not found');
      const item = createIssueRec(ctx.forge, repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
      });
      return tag('CreateIssuePayload', { issue: issueTag(repo, item) });
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemByGlobalId(ctx, String(input.issueId ?? ''));
      if (found === null || found.item.kind !== 'issue') throw new GqlError('issue not found');
      found.item.state = 'closed';
      found.item.updatedAt = ctx.forge.stamp();
      refreshItemJson(found.repo, found.item);
      return tag('CloseIssuePayload', { issue: issueTag(found.repo, found.item as IssueRec) });
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new GqlError('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (branchTipOf(repo, head) === null || branchTipOf(repo, base) === null) {
        throw new GqlError('head and base must name existing branches');
      }
      const item = createPullRec(ctx.forge, repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head,
        base,
      });
      return tag('CreatePullRequestPayload', { pullRequest: pullTag(repo, item) });
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (found === null || found.item.kind !== 'pull') throw new GqlError('pull request not found');
      const pull = found.item as PullRec;
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const sha = mergePull(ctx.forge, found.repo, pull, method);
      if (sha === null) throw new GqlError('pull request is not mergeable');
      return tag('MergePullRequestPayload', { pullRequest: pullTag(found.repo, pull) });
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = itemByGlobalId(ctx, String(input.subjectId ?? ''));
      if (found === null) throw new GqlError('subject not found');
      const comment = addCommentRec(ctx.forge, found.repo, found.item, String(input.body ?? ''));
      return tag('AddCommentPayload', {
        commentEdge: tag('CommentEdge', { node: tag('Comment', { repo: found.repo, comment }), cursor: cursorOf(comment.id) }),
      });
    },
  },
  User: {
    login: (s) => s.login,
    id: () => Buffer.from('U:1000', 'utf8').toString('base64url'),
    name: () => 'ada iversen',
    email: () => 'adaiversen@example.invalid',
  },
  Repository: {
    id: (s) => repoGlobalId(s.repo as Repo),
    databaseId: (s) => (s.repo as Repo).databaseId,
    name: (s) => (s.repo as Repo).name,
    nameWithOwner: (s) => `${(s.repo as Repo).owner}/${(s.repo as Repo).name}`,
    owner: (s, _a, ctx) => userTag(ctx.forge),
    defaultBranchRef: (s) => tag('Ref', { name: (s.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (s) => (s.repo as Repo).description,
    isPrivate: (s) => (s.repo as Repo).isPrivate,
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
    issue: (s, args) => {
      const repo = s.repo as Repo;
      const item = repo.items.get(Number(args.number));
      return item !== undefined && item.kind === 'issue' ? issueTag(repo, item as IssueRec) : null;
    },
    issues: (s, args) => issuesConnection(s.repo as Repo, args),
    pullRequest: (s, args) => {
      const repo = s.repo as Repo;
      const item = repo.items.get(Number(args.number));
      return item !== undefined && item.kind === 'pull' ? pullTag(repo, item as PullRec) : null;
    },
    pullRequests: (s, args) => {
      const repo = s.repo as Repo;
      const first = typeof args.first === 'number' ? args.first : 100;
      const pulls = [...repo.items.values()].filter((item) => item.kind === 'pull') as PullRec[];
      pulls.sort((a, b) => a.number - b.number);
      const nodes = pulls.slice(0, first).map((item) => pullTag(repo, item));
      return tag('PullRequestConnection', {
        nodes,
        pageInfo: tag('PageInfo', { hasNextPage: pulls.length > nodes.length, endCursor: nodes.length > 0 ? cursorOf(pulls[nodes.length - 1].number) : null }),
        totalCount: pulls.length,
      });
    },
  },
  Ref: {
    name: (s) => s.name,
    target: () => null,
  },
  Issue: {
    id: (s) => issueGlobalId(s.repo as Repo, (s.item as IssueRec).number),
    number: (s) => (s.item as IssueRec).number,
    title: (s) => (s.item as IssueRec).title,
    state: (s) => ((s.item as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (s) => (s.item as IssueRec).body,
    createdAt: (s) => (s.item as IssueRec).createdAt,
    updatedAt: (s) => (s.item as IssueRec).updatedAt,
    author: (_s, _a, ctx) => userTag(ctx.forge),
  },
  PullRequest: {
    id: (s) => pullGlobalId(s.repo as Repo, (s.item as PullRec).number),
    number: (s) => (s.item as PullRec).number,
    title: (s) => (s.item as PullRec).title,
    body: (s) => (s.item as PullRec).body,
    state: (s) => {
      const item = s.item as PullRec;
      return item.merged ? 'MERGED' : item.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (s) => (s.item as PullRec).merged,
    mergedAt: (s) => (s.item as PullRec).mergedAt,
    headRefName: (s) => (s.item as PullRec).head,
    baseRefName: (s) => (s.item as PullRec).base,
    mergeable: (s) => pullMergeable(s.repo as Repo, s.item as PullRec),
    createdAt: (s) => (s.item as PullRec).createdAt,
    updatedAt: (s) => (s.item as PullRec).updatedAt,
    author: (_s, _a, ctx) => userTag(ctx.forge),
    files: (s, args) => {
      const repo = s.repo as Repo;
      const first = typeof args.first === 'number' ? args.first : 100;
      const changes = pullChanges(repo, s.item as PullRec);
      const nodes = changes.slice(0, first).map((change) => tag('PullRequestChangedFile', { path: change.filename }));
      return tag('PullRequestChangedFileConnection', {
        nodes,
        pageInfo: tag('PageInfo', { hasNextPage: changes.length > nodes.length, endCursor: null }),
        totalCount: changes.length,
      });
    },
  },
  IssueConnection: {
    nodes: (s) => s.nodes,
    pageInfo: (s) => s.pageInfo,
    totalCount: (s) => s.totalCount,
  },
  PullRequestConnection: {
    nodes: (s) => s.nodes,
    pageInfo: (s) => s.pageInfo,
    totalCount: (s) => s.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (s) => s.nodes,
    pageInfo: (s) => s.pageInfo,
    totalCount: (s) => s.totalCount,
  },
  PullRequestChangedFile: {
    path: (s) => s.path,
  },
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage,
    hasPreviousPage: () => false,
    startCursor: (s) => s.endCursor ?? null,
    endCursor: (s) => s.endCursor ?? null,
  },
  Comment: {
    id: (s) => commentGlobalId((s.comment as { id: number }).id),
    body: (s) => (s.comment as { body: string }).body,
    createdAt: (s) => (s.comment as { createdAt: string }).createdAt,
    author: (_s, _a, ctx) => userTag(ctx.forge),
  },
  CreateIssuePayload: { issue: (s) => s.issue, clientMutationId: () => null },
  CloseIssuePayload: { issue: (s) => s.issue, clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (s) => s.pullRequest, clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (s) => s.pullRequest, clientMutationId: () => null },
  AddCommentPayload: { commentEdge: (s) => s.commentEdge, subject: () => null, clientMutationId: () => null },
  CommentEdge: { node: (s) => s.node, cursor: (s) => s.cursor },
  __Type: {
    name: (s) => s.name,
    kind: (s) => s.kind,
    description: () => null,
    fields: (s) => {
      const fields = TYPE_FIELDS[String(s.name)];
      return fields === undefined ? null : fields.map((name) => tag('__Field', { name }));
    },
    enumValues: (s) => {
      const values = TYPE_ENUMS[String(s.name)];
      return values === undefined ? null : values.map((name) => tag('__EnumValue', { name }));
    },
  },
  __Field: { name: (s) => s.name, description: () => null, type: () => null },
  __EnumValue: { name: (s) => s.name, description: () => null },
};

function typeTag(name: string): Tagged | null {
  if (TYPE_FIELDS[name] !== undefined) return tag('__Type', { name, kind: 'OBJECT' });
  if (TYPE_ENUMS[name] !== undefined) return tag('__Type', { name, kind: 'ENUM' });
  if (name === 'String' || name === 'Int' || name === 'ID' || name === 'Boolean') return tag('__Type', { name, kind: 'SCALAR' });
  return null;
}

function repoByGlobalId(ctx: ExecCtx, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  const databaseId = Number(decoded.parts[0]);
  for (const repo of ctx.forge.repos.values()) if (repo.databaseId === databaseId) return repo;
  return null;
}

function itemByGlobalId(ctx: ExecCtx, id: string): { repo: Repo; item: ItemRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || (decoded.kind !== 'I' && decoded.kind !== 'P')) return null;
  const databaseId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of ctx.forge.repos.values()) {
    if (repo.databaseId !== databaseId) continue;
    const item = repo.items.get(number);
    return item === undefined ? null : { repo, item };
  }
  return null;
}

function nodeById(ctx: ExecCtx, id: string): Tagged | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'R') {
    const repo = repoByGlobalId(ctx, id);
    return repo === null ? null : repoTag(repo);
  }
  if (decoded.kind === 'I' || decoded.kind === 'P') {
    const found = itemByGlobalId(ctx, id);
    if (found === null) return null;
    return found.item.kind === 'issue' ? issueTag(found.repo, found.item as IssueRec) : pullTag(found.repo, found.item as PullRec);
  }
  if (decoded.kind === 'U') return userTag(ctx.forge);
  return null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Tagged {
  let items = [...repo.items.values()].filter((item) => item.kind === 'issue') as IssueRec[];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((item) => wanted.has(item.state));
  }
  let descending = false;
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy !== undefined && orderBy !== null && typeof orderBy === 'object') {
    descending = String(orderBy.direction ?? 'ASC') === 'DESC';
  }
  items.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const total = items.length;
  const afterNumber = numberOfCursor(args.after);
  let startIndex = 0;
  if (afterNumber !== null) {
    const at = items.findIndex((item) => item.number === afterNumber);
    if (at !== -1) startIndex = at + 1;
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < total;
  return tag('IssueConnection', {
    nodes: page.map((item) => issueTag(repo, item)),
    pageInfo: tag('PageInfo', {
      hasNextPage,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1].number) : null,
    }),
    totalCount: total,
  });
}

// ---------------------------------------------------------------- validation + execution

function validateSelections(selections: SelectionNode[], typeName: string, ctx: ExecCtx, errors: { message: string }[]): void {
  const fields = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      validateSelections(selection.selection, selection.typeCondition ?? typeName, ctx, errors);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(fragment, typeName, ctx, errors);
      continue;
    }
    if (selection.name === '__typename' || selection.name === '__schema' || selection.name === '__type') continue;
    if (fields === undefined || !fields.includes(selection.name)) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      continue;
    }
    if (selection.selection !== null) {
      const childType = childTypeOf(typeName, selection.name);
      if (childType !== null) validateSelections(selection.selection, childType, ctx, errors);
    }
  }
}

/** The object type a field returns, for validation of nested selections (best-effort table). */
function childTypeOf(parent: string, field: string): string | null {
  const table: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository', __type: '__Type' },
    Mutation: {
      createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    },
    Issue: { author: 'User' },
    PullRequest: { author: 'User', files: 'PullRequestChangedFileConnection' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue' },
    CommentEdge: { node: 'Comment' },
    Comment: { author: 'User' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return table[parent]?.[field] ?? null;
}

function executeSelections(
  selections: SelectionNode[],
  source: Tagged,
  typeName: string,
  ctx: ExecCtx,
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === source.__type) {
        executeSelections(selection.selection, source, source.__type, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) executeSelections(fragment, source, typeName, ctx, out);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[selection.name];
    if (resolver === undefined) {
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection, ctx);
  }
}

function completeValue(value: unknown, selection: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const tagged = value as Tagged;
    if (selection.selection === null) return null;
    const out: Record<string, unknown> = {};
    executeSelections(selection.selection, tagged, tagged.__type, ctx, out);
    return out;
  }
  return value;
}

export function executeGraphQL(forge: Forge, body: unknown): Record<string, unknown> {
  const request = (body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  const queryText = typeof request.query === 'string' ? request.query : '';
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  let document: { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> };
  try {
    document = new Parser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  let operation = document.operations[0];
  if (typeof request.operationName === 'string') {
    operation = document.operations.find((op) => op.name === request.operationName) ?? operation;
  }
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const validationErrors: { message: string }[] = [];
  validateSelections(operation.selection, rootType, ctx, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors };
  }
  const root = tag(rootType, {});
  const data: Record<string, unknown> = {};
  executeSelections(operation.selection, root, rootType, ctx, data);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

export function handleGraphQL(forge: Forge, body: unknown, res: ServerResponse): void {
  const send = (payload: unknown): void => {
    const buffer = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buffer.length, 'x-github-request-id': 'FORGE-GRAPHQL' });
    res.end(buffer);
  };
  if (Array.isArray(body)) {
    send(body.map((entry) => executeGraphQL(forge, entry)));
    return;
  }
  send(executeGraphQL(forge, body));
}
