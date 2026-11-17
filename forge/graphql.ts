// GitHub GraphQL v4: a hand-rolled parser and executor for the documents
// `gh` and `github-mcp-server` send (see sdk/conformance/checks-graphql.ts).
// No GraphQL library: the suite moves document strings and variables, and
// this file parses them, validates field names against the schema below, and
// executes them against the store.

import type { Forge, Issue, PullRequest, RepoRecord } from './store.ts';
import { b64url, b64urlDecode, parseJson } from './util.ts';

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeName: string;
  selections: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): Operation[] {
    const ops: Operation[] = [];
    while (this.skipWs(), this.pos < this.src.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private skipWs(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos])) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos += 1;
  }

  private matchWord(word: string): boolean {
    this.skipWs();
    if (!this.src.startsWith(word, this.pos)) return false;
    const after = this.src[this.pos + word.length];
    if (after && /[A-Za-z0-9_]/.test(after)) return false;
    this.pos += word.length;
    return true;
  }

  private parseName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected a name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    if (this.matchWord('mutation')) kind = 'mutation';
    else this.matchWord('query');
    let name: string | null = null;
    this.skipWs();
    if (/[A-Za-z_]/.test(this.peek())) name = this.parseName();
    this.skipWs();
    if (this.peek() === '(') this.skipVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, variables: {}, selections };
  }

  private skipVariableDefinitions(): void {
    // ($name: Type = default, ...) — the types are not needed to execute.
    this.expect('(');
    let depth = 1;
    while (this.pos < this.src.length && depth > 0) {
      const ch = this.src[this.pos++];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === '"') {
        while (this.pos < this.src.length && this.src[this.pos] !== '"') {
          if (this.src[this.pos] === '\\') this.pos += 1;
          this.pos += 1;
        }
        this.pos += 1;
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === '}') { this.pos += 1; return out; }
      if (this.pos >= this.src.length) throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    this.skipWs();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipWs();
      if (!this.matchWord('on')) throw new Error('only inline fragments are supported');
      const typeName = this.parseName();
      return { kind: 'fragment', typeName, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.parseName();
    this.skipWs();
    if (this.peek() === ':') {
      this.pos += 1;
      alias = name;
      name = this.parseName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    this.skipWs();
    if (this.peek() === '(') {
      this.pos += 1;
      for (;;) {
        this.skipWs();
        if (this.peek() === ')') { this.pos += 1; break; }
        const argName = this.parseName();
        this.skipWs();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipWs();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    this.skipWs();
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.parseName() };
    }
    if (ch === '"') {
      this.pos += 1;
      let out = '';
      while (this.pos < this.src.length) {
        const c = this.src[this.pos++];
        if (c === '"') break;
        if (c === '\\') {
          const esc = this.src[this.pos++];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        } else out += c;
      }
      return { kind: 'string', value: out };
    }
    if (ch === '[') {
      this.pos += 1;
      const values: Value[] = [];
      for (;;) {
        this.skipWs();
        if (this.peek() === ']') { this.pos += 1; break; }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: Value }> = [];
      for (;;) {
        this.skipWs();
        if (this.peek() === '}') { this.pos += 1; break; }
        const name = this.parseName();
        this.skipWs();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (this.src.startsWith('true', this.pos)) { this.pos += 4; return { kind: 'boolean', value: true }; }
    if (this.src.startsWith('false', this.pos)) { this.pos += 5; return { kind: 'boolean', value: false }; }
    if (this.src.startsWith('null', this.pos)) { this.pos += 4; return { kind: 'null' }; }
    const num = /^-?\d+(\.\d+)?/.exec(this.src.slice(this.pos));
    if (num) {
      this.pos += num[0].length;
      return num[0].includes('.') ? { kind: 'float', value: Number(num[0]) } : { kind: 'int', value: Number(num[0]) };
    }
    return { kind: 'enum', value: this.parseName() };
  }
}

function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable': return variables[v.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.values.map((x) => resolveValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ------------------------------------------------------------------ schema

// field name -> the type it returns (used for validation and introspection).
const SCHEMA: Record<string, Record<string, string>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String', id: 'ID' },
  Node: { id: 'ID' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'MergeableState',
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestConnection: { nodes: '[PullRequest]' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]' },
  PullRequestChangedFile: { path: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
};

const SCALARS = new Set(['String', 'Int', 'Boolean', 'ID', 'Float']);

function baseType(t: string): string {
  return t.replace(/^\[/, '').replace(/\]$/, '').replace(/!$/, '');
}

// ------------------------------------------------------------------ validation

class GraphQLError extends Error {}

function validateSelections(selections: Selection[], typeName: string): void {
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (!SCHEMA[sel.typeName]) throw new GraphQLError(`Cannot query fragment on unknown type "${sel.typeName}".`);
      validateSelections(sel.selections, sel.typeName);
      continue;
    }
    const fields = SCHEMA[typeName];
    if (!fields || !(sel.name in fields)) {
      throw new GraphQLError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    }
    if (sel.selections) {
      const next = baseType(fields[sel.name]);
      if (SCALARS.has(next)) throw new GraphQLError(`Field "${sel.name}" must not have a selection since type "${next}" has no subfields.`);
      validateSelections(sel.selections, next);
    }
  }
}

// ------------------------------------------------------------------ execution

interface Ctx {
  forge: Forge;
}

type AnyObj = { __typename: string; [k: string]: unknown };

function cursorFor(number: number): string {
  return b64url(`cursor:${number}`);
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  try {
    const decoded = b64urlDecode(cursor);
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObj(forge: Forge, repo: RepoRecord, issue: Issue): AnyObj {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function prObj(forge: Forge, repo: RepoRecord, pr: PullRequest): AnyObj {
  return { __typename: 'PullRequest', __repo: repo, __pr: pr };
}

function repoObj(forge: Forge, repo: RepoRecord): AnyObj {
  return { __typename: 'Repository', __repo: repo };
}

function userObj(forge: Forge): AnyObj {
  return { __typename: 'User', __forge: forge };
}

function issuesConnection(forge: Forge, repo: RepoRecord, args: Record<string, unknown>): AnyObj {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(issueState(i)));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const desc = orderBy && String(orderBy.direction ?? '').toUpperCase() === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const afterNum = cursorNumber(args.after);
  if (afterNum !== null) {
    const idx = list.findIndex((i) => i.number === afterNum);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __typename: 'IssueConnection',
    __nodes: page.map((i) => issueObj(forge, repo, i)),
    __pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function prsConnection(forge: Forge, repo: RepoRecord, args: Record<string, unknown>): AnyObj {
  const list = [...repo.pulls].sort((a, b) => a.number - b.number);
  const afterNum = cursorNumber(args.after);
  let rest = list;
  if (afterNum !== null) {
    const idx = rest.findIndex((p) => p.number === afterNum);
    if (idx >= 0) rest = rest.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : rest.length;
  const page = rest.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    __nodes: page.map((p) => prObj(forge, repo, p)),
    __pageInfo: { __typename: 'PageInfo', hasNextPage: rest.length > page.length, endCursor: page.length ? cursorFor(page[page.length - 1].number) : null },
  };
}

/** Resolve a field on an object. Returns the raw value (object, list, scalar). */
function resolveField(ctx: Ctx, obj: AnyObj, field: FieldNode, variables: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, variables);
  const type = obj.__typename;
  if (type === 'Query') {
    if (field.name === 'viewer') return userObj(forge);
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== forge.viewerLogin) return null;
      const repo = forge.getRepo(name);
      return repo ? repoObj(forge, repo) : null;
    }
    if (field.name === 'node') {
      const resolved = forge.resolveGlobalId(String(args.id ?? ''));
      if (!resolved) return null;
      if (resolved.kind === 'Repository') return repoObj(forge, resolved.repo);
      if (resolved.kind === 'Issue') return issueObj(forge, resolved.repo, resolved.issue!);
      if (resolved.kind === 'PullRequest') return prObj(forge, resolved.repo, resolved.pr!);
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      if (!SCHEMA[name] && !ENUM_VALUES[name]) return null;
      return { __typename: '__Type', __typeName: name };
    }
  }
  if (type === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = forge.resolveGlobalId(String(input.repositoryId ?? ''));
      if (!resolved || resolved.kind !== 'Repository') throw new GraphQLError('createIssue: repository not found');
      const issue = forge.createIssue(resolved.repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', __issue: issueObj(forge, resolved.repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = forge.resolveGlobalId(String(input.issueId ?? ''));
      if (!resolved || resolved.kind !== 'Issue') throw new GraphQLError('closeIssue: issue not found');
      resolved.issue!.state = 'closed';
      return { __typename: 'CloseIssuePayload', __issue: issueObj(forge, resolved.repo, resolved.issue!) };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = forge.resolveGlobalId(String(input.repositoryId ?? ''));
      if (!resolved || resolved.kind !== 'Repository') throw new GraphQLError('createPullRequest: repository not found');
      const result = forge.createPull(
        resolved.repo,
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
      );
      if ('error' in result) throw new GraphQLError(`createPullRequest: ${result.error}`);
      return { __typename: 'CreatePullRequestPayload', __pr: prObj(forge, resolved.repo, result) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = forge.resolveGlobalId(String(input.pullRequestId ?? ''));
      if (!resolved || resolved.kind !== 'PullRequest') throw new GraphQLError('mergePullRequest: pull request not found');
      const pr = resolved.pr!;
      if (pr.state !== 'open') throw new GraphQLError('mergePullRequest: pull request is not open');
      if (forge.mergeConflict(resolved.repo, pr)) throw new GraphQLError('mergePullRequest: merge conflict');
      forge.mergePull(resolved.repo, pr);
      return { __typename: 'MergePullRequestPayload', __pr: prObj(forge, resolved.repo, pr) };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = forge.resolveGlobalId(String(input.subjectId ?? ''));
      if (!resolved || resolved.kind !== 'Issue') throw new GraphQLError('addComment: issue not found');
      const comment = forge.addComment(resolved.repo, resolved.issue!.number, String(input.body ?? ''));
      if (!comment) throw new GraphQLError('addComment: issue not found');
      return {
        __typename: 'AddCommentPayload',
        __commentEdge: {
          __typename: 'IssueCommentEdge',
          __node: { __typename: 'IssueComment', __repo: resolved.repo, __issueNumber: resolved.issue!.number, __comment: comment },
        },
      };
    }
  }
  if (type === 'User') {
    if (field.name === 'login') return forge.viewerLogin;
    if (field.name === 'id') return String(forge.viewerId);
  }
  if (type === 'Node') {
    if (field.name === 'id') return (obj as unknown as { __id?: string }).__id ?? null;
  }
  if (type === 'Repository') {
    const repo = obj.__repo as RepoRecord;
    switch (field.name) {
      case 'id': return forge.repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${forge.viewerLogin}/${repo.name}`;
      case 'owner': return userObj(forge);
      case 'defaultBranchRef': return { __typename: 'Ref', __name: repo.defaultBranch };
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const issue = forge.getIssue(repo, Number(args.number));
        return issue ? issueObj(forge, repo, issue) : null;
      }
      case 'issues': return issuesConnection(forge, repo, args);
      case 'pullRequests': return prsConnection(forge, repo, args);
      case 'pullRequest': {
        const pr = forge.getPull(repo, Number(args.number));
        return pr ? prObj(forge, repo, pr) : null;
      }
    }
  }
  if (type === 'Ref') return (obj as unknown as { __name: string }).__name;
  if (type === 'Issue') {
    const issue = obj.__issue as Issue;
    const repo = obj.__repo as RepoRecord;
    switch (field.name) {
      case 'id': return forge.issueGlobalId(repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issueState(issue);
      case 'body': return issue.body;
    }
  }
  if (type === 'IssueConnection') {
    if (field.name === 'nodes') return (obj as unknown as { __nodes: unknown[] }).__nodes;
    if (field.name === 'pageInfo') return (obj as unknown as { __pageInfo: unknown }).__pageInfo;
  }
  if (type === 'PageInfo') {
    const pi = obj as unknown as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return pi.hasNextPage;
    if (field.name === 'endCursor') return pi.endCursor;
  }
  if (type === 'PullRequest') {
    const pr = obj.__pr as PullRequest;
    const repo = obj.__repo as RepoRecord;
    switch (field.name) {
      case 'id': return forge.pullGlobalId(repo, pr);
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return prState(pr);
      case 'merged': return pr.merged;
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'mergeable': return forge.mergeable(repo, pr);
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : undefined;
        const files = forge.pullFiles(repo, pr);
        const page = first === undefined ? files : files.slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          __nodes: page.map((f) => ({ __typename: 'PullRequestChangedFile', __path: f.filename })),
        };
      }
    }
  }
  if (type === 'PullRequestConnection') {
    if (field.name === 'nodes') return (obj as unknown as { __nodes: unknown[] }).__nodes;
    if (field.name === 'pageInfo') return (obj as unknown as { __pageInfo: unknown }).__pageInfo;
  }
  if (type === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') return (obj as unknown as { __nodes: unknown[] }).__nodes;
  }
  if (type === 'PullRequestChangedFile') {
    if (field.name === 'path') return (obj as unknown as { __path: string }).__path;
  }
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field.name === 'issue') return (obj as unknown as { __issue: unknown }).__issue;
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return (obj as unknown as { __pr: unknown }).__pr;
  }
  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return (obj as unknown as { __commentEdge: unknown }).__commentEdge;
  }
  if (type === 'IssueCommentEdge') {
    if (field.name === 'node') return (obj as unknown as { __node: unknown }).__node;
  }
  if (type === 'IssueComment') {
    const o = obj as unknown as { __repo: RepoRecord; __issueNumber: number; __comment: { id: number; body: string } };
    if (field.name === 'id') return forge.commentGlobalId(o.__repo, o.__issueNumber, o.__comment);
    if (field.name === 'body') return o.__comment.body;
  }
  if (type === '__Type') {
    const name = (obj as unknown as { __typeName: string }).__typeName;
    if (field.name === 'name') return name;
    if (field.name === 'kind') return ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const fields = SCHEMA[name] ?? {};
      return Object.keys(fields).map((f) => ({ __typename: '__Field', __name: f }));
    }
    if (field.name === 'enumValues') {
      return (ENUM_VALUES[name] ?? []).map((v) => ({ __typename: '__EnumValue', __name: v }));
    }
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (field.name === 'name') return (obj as unknown as { __name: string }).__name;
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${type}".`);
}

function executeSelections(
  ctx: Ctx,
  obj: AnyObj,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeName !== obj.__typename) continue;
      Object.assign(out, executeSelections(ctx, obj, sel.selections, variables));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(ctx, obj, sel, variables);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (sel.selections) {
      if (Array.isArray(value)) {
        out[key] = value.map((item) => {
          if (item && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
            return executeSelections(ctx, item as AnyObj, sel.selections!, variables);
          }
          return item;
        });
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[key] = executeSelections(ctx, value as AnyObj, sel.selections, variables);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(ctx: Ctx, op: Operation, variables: Record<string, unknown>): { data: unknown; errors: Array<{ message: string }> } {
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    validateSelections(op.selections, rootType);
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'validation error' }] };
  }
  try {
    const root: AnyObj = { __typename: rootType };
    const data = executeSelections(ctx, root, op.selections, variables);
    return { data, errors: [] };
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'execution error' }] };
  }
}

/** Handle one GraphQL HTTP request body. Returns the response object. */
export function handleGraphql(forge: Forge, body: Buffer): { status: number; json: unknown } {
  const parsed = parseJson(body);
  if (parsed === null) return { status: 400, json: { errors: [{ message: 'malformed JSON body' }] } };
  const ctx: Ctx = { forge };
  const runOne = (entry: unknown): unknown => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'expected a GraphQL operation object' }] };
    }
    const op = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof op.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    let ops: Operation[];
    try {
      ops = new Parser(op.query).parse();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
    }
    const variables = (op.variables && typeof op.variables === 'object' && !Array.isArray(op.variables))
      ? (op.variables as Record<string, unknown>)
      : {};
    let chosen: Operation | undefined;
    if (typeof op.operationName === 'string') {
      chosen = ops.find((o) => o.name === op.operationName);
      if (!chosen) return { data: null, errors: [{ message: `operation ${op.operationName} not found` }] };
    } else {
      chosen = ops[0];
    }
    if (!chosen) return { data: null, errors: [{ message: 'no operation in document' }] };
    return executeOperation(ctx, chosen, variables);
  };
  if (Array.isArray(parsed)) {
    return { status: 200, json: parsed.map(runOne) };
  }
  return { status: 200, json: runOne(parsed) };
}
