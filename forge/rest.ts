// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are JSON {message}. The client in the kit
// (sdk/conformance/rest-client.ts) is the authority for the shapes.

import { getPathOid, getTreeOid, parseCommit, parseTree } from './gitcore.ts';
import type { Forge, Issue, PullRequest, RepoRecord } from './store.ts';
import { b64decode, b64encode, isSha, parseJson } from './util.ts';

export interface RestContext {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: Buffer | null;
  baseUrl: string; // e.g. http://127.0.0.1:PORT
}

export interface RestResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, json: body, headers });
const error = (status: number, message: string): RestResult => json(status, { message });

function repoShape(forge: Forge, repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${forge.viewerLogin}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: forge.viewerLogin, id: forge.viewerId, type: 'User' },
    html_url: `${forge.viewerLogin}/${repo.name}`,
    url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}`,
    has_issues: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function issueShape(forge: Forge, repo: RepoRecord, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: forge.viewerLogin, id: forge.viewerId, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/issues/${issue.number}`,
    html_url: `${forge.viewerLogin}/${repo.name}/issues/${issue.number}`,
  };
}

function pullShape(forge: Forge, repo: RepoRecord, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: forge.pullGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${forge.viewerLogin}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${forge.viewerLogin}:${pr.baseRef}` },
    user: { login: forge.viewerLogin, id: forge.viewerId, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/pulls/${pr.number}`,
    html_url: `${forge.viewerLogin}/${repo.name}/pull/${pr.number}`,
  };
}

/** Resolve /repos/{owner}/{repo} — owner must be the viewer, else 404. */
function resolveRepo(forge: Forge, owner: string, name: string): RepoRecord | null {
  if (owner !== forge.viewerLogin) return null;
  return forge.getRepo(name) ?? null;
}

function parseBody(ctx: RestContext): Record<string, unknown> | null {
  if (ctx.body === null || ctx.body.length === 0) return {};
  const parsed = parseJson(ctx.body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function pageParams(ctx: RestContext): { perPage: number; page: number } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  return { perPage, page };
}

function paginate<T>(items: T[], ctx: RestContext, urlPath: string): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const makeUrl = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${ctx.baseUrl}${urlPath}?${q.toString()}`;
  };
  if (page < totalPages) {
    links.push(`<${makeUrl(page + 1)}>; rel="next"`);
    links.push(`<${makeUrl(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${makeUrl(1)}>; rel="first"`);
    links.push(`<${makeUrl(page - 1)}>; rel="prev"`);
  }
  return { page: pageItems, headers: links.length ? { Link: links.join(', ') } : {} };
}

export function handleRest(forge: Forge, ctx: RestContext): RestResult {
  const [first, ...rest] = ctx.segments;
  try {
    // API root and meta.
    if (ctx.segments.length === 0) {
      if (ctx.method === 'GET') {
        return json(200, {
          current_user_url: `${ctx.baseUrl}/api/v3/user`,
          rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
        });
      }
      return error(404, 'Not Found');
    }
    if (first === 'meta' && ctx.segments.length === 1) {
      if (ctx.method === 'GET') return json(200, { installed_version: '1.0.0' });
      return error(404, 'Not Found');
    }
    if (first === 'user' && ctx.segments.length === 1) {
      if (ctx.method === 'GET') {
        return json(200, { login: forge.viewerLogin, id: forge.viewerId, name: forge.viewerName, email: forge.viewerEmail, type: 'User' });
      }
      return error(404, 'Not Found');
    }
    if (first === 'user' && rest[0] === 'repos' && ctx.segments.length === 2) {
      if (ctx.method === 'GET') {
        const { page, headers } = paginate(forge.listRepos(), ctx, '/api/v3/user/repos');
        return json(200, page.map((r) => repoShape(forge, r)), headers);
      }
      if (ctx.method === 'POST') {
        const body = parseBody(ctx);
        if (body === null) return error(400, 'malformed JSON body');
        const name = body.name;
        if (typeof name !== 'string' || name.length === 0 || /[/\s]/.test(name)) {
          return error(422, 'name is required');
        }
        if (forge.getRepo(name)) return error(422, 'name already exists on this account');
        const repo = forge.createRepo(
          name,
          typeof body.description === 'string' ? body.description : '',
          body.private === true,
        )!;
        return json(201, repoShape(forge, repo));
      }
      return error(404, 'Not Found');
    }
    if (first === 'repos') return handleRepo(forge, ctx, rest);
    return error(404, 'Not Found');
  } catch (e) {
    if (e instanceof Error && (e as Error & { status?: number }).status) {
      return error((e as Error & { status: number }).status, e.message);
    }
    return error(500, e instanceof Error ? e.message : 'internal error');
  }
}

function handleRepo(forge: Forge, ctx: RestContext, rest: string[]): RestResult {
  // rest = [owner, repo, ...tail]
  const [owner, repoName, ...tail] = rest;
  if (!owner || !repoName) return error(404, 'Not Found');
  const repo = resolveRepo(forge, owner, repoName);
  if (!repo) return error(404, 'Not Found');
  const urlPath = `/api/v3/repos/${owner}/${repoName}`;

  if (tail.length === 0) {
    if (ctx.method === 'GET') return json(200, repoShape(forge, repo));
    if (ctx.method === 'PATCH') {
      const body = parseBody(ctx);
      if (body === null) return error(400, 'malformed JSON body');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return json(200, repoShape(forge, repo));
    }
    if (ctx.method === 'DELETE') {
      forge.deleteRepo(repoName);
      return { status: 204 };
    }
    return error(404, 'Not Found');
  }

  const [section, ...sub] = tail;

  if (section === 'branches') {
    if (sub.length === 0 && ctx.method === 'GET') {
      return json(200, forge.branches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } })));
    }
    if (sub.length === 1 && ctx.method === 'GET') {
      const tip = forge.tip(repo, decodeURIComponent(sub[0]));
      if (tip === undefined) return error(404, 'Branch not found');
      return json(200, { name: decodeURIComponent(sub[0]), commit: { sha: tip } });
    }
    return error(404, 'Not Found');
  }

  if (section === 'commits') {
    if (ctx.method !== 'GET') return error(404, 'Not Found');
    const shaParam = ctx.query.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      if (isSha(shaParam)) tip = repo.objects.has(shaParam) ? shaParam : undefined;
      else tip = forge.tip(repo, shaParam);
    } else {
      tip = forge.tip(repo, repo.defaultBranch);
    }
    if (tip === undefined) return error(404, 'Commit not found');
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({
        sha: oid,
        commit: {
          message: c.message,
          author: { name: 'Forge', email: 'forge@localhost' },
          committer: { name: 'Forge', email: 'forge@localhost' },
        },
      });
      for (const p of c.parents) queue.push(p);
    }
    return json(200, out);
  }

  if (section === 'git' && sub[0] === 'refs') {
    if (sub.length === 1) {
      if (ctx.method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        return json(200, refs);
      }
      if (ctx.method === 'POST') {
        const body = parseBody(ctx);
        if (body === null) return error(400, 'malformed JSON body');
        const ref = body.ref;
        const sha = body.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/')) return error(422, 'ref is required');
        if (typeof sha !== 'string' || !isSha(sha) || !repo.objects.has(sha)) return error(422, 'sha is not a known object');
        if (repo.refs.has(ref)) return error(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: 'commit' } });
      }
      return error(404, 'Not Found');
    }
    if (sub.length === 3 && sub[1] === 'heads' && ctx.method === 'GET') {
      const branch = decodeURIComponent(sub[2]);
      const tip = forge.tip(repo, branch);
      if (tip === undefined) return error(404, 'Reference does not exist');
      return json(200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
    }
    return error(404, 'Not Found');
  }

  if (section === 'contents') {
    const path = sub.map((s) => decodeURIComponent(s)).join('/');
    return handleContents(forge, ctx, repo, path, urlPath);
  }

  if (section === 'labels') {
    if (ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return error(400, 'malformed JSON body');
      const name = body.name;
      if (typeof name !== 'string' || name.length === 0) return error(422, 'name is required');
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      return json(201, { name, color, description: '' });
    }
    if (ctx.method === 'GET') {
      return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
    }
    return error(404, 'Not Found');
  }

  if (section === 'issues') return handleIssues(forge, ctx, repo, sub, urlPath);
  if (section === 'pulls') return handlePulls(forge, ctx, repo, sub, urlPath);
  return error(404, 'Not Found');
}

function handleContents(forge: Forge, ctx: RestContext, repo: RepoRecord, path: string, urlPath: string): RestResult {
  if (path.length === 0) return error(404, 'Not Found');
  if (ctx.method === 'GET') {
    const refName = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = forge.tip(repo, refName);
    if (tip === undefined) return error(404, 'Not Found');
    const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const blobOid = getPathOid(repo.objects, treeOid, path);
    if (blobOid) {
      const blob = repo.objects.get(blobOid)!;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        content: b64encode(blob.data),
        sha: blobOid,
      });
    }
    const dirTreeOid = getTreeOid(repo.objects, treeOid, path);
    if (!dirTreeOid) return error(404, 'Not Found');
    const entries = parseTree(repo.objects.get(dirTreeOid)!.data);
    const out = entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
    }));
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, out);
  }
  if (ctx.method === 'PUT') {
    const body = parseBody(ctx);
    if (body === null) return error(400, 'malformed JSON body');
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : null;
    if (contentB64 === null) return error(422, 'content is required');
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    try {
      const result = forge.commitFile(repo, branch, path, b64decode(contentB64), message, sha);
      return json(result.created ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: result.contentSha, size: b64decode(contentB64).length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha, message },
      });
    } catch (e) {
      if (e instanceof Error && (e as Error & { status?: number }).status) {
        return error((e as Error & { status: number }).status, e.message);
      }
      return error(500, e instanceof Error ? e.message : 'internal error');
    }
  }
  if (ctx.method === 'DELETE') {
    const body = parseBody(ctx);
    if (body === null) return error(400, 'malformed JSON body');
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    try {
      const result = forge.deleteFile(repo, branch, path, message, sha);
      return json(200, { commit: { sha: result.commitSha, message } });
    } catch (e) {
      if (e instanceof Error && (e as Error & { status?: number }).status) {
        return error((e as Error & { status: number }).status, e.message);
      }
      return error(500, e instanceof Error ? e.message : 'internal error');
    }
  }
  return error(404, 'Not Found');
}

function handleIssues(forge: Forge, ctx: RestContext, repo: RepoRecord, sub: string[], urlPath: string): RestResult {
  if (sub.length === 0) {
    if (ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return error(400, 'malformed JSON body');
      const title = body.title;
      if (typeof title !== 'string' || title.length === 0) return error(422, 'title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const l of labels) {
        if (!repo.labels.has(l)) return error(422, `label ${l} does not exist`);
      }
      const issue = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      return json(201, issueShape(forge, repo, issue));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, headers } = paginate(list, ctx, `${urlPath}/issues`);
      return json(200, page.map((i) => issueShape(forge, repo, i)), headers);
    }
    return error(404, 'Not Found');
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
  const issue = forge.getIssue(repo, number);
  if (!issue) return error(404, 'Not Found');
  if (sub.length === 1) {
    if (ctx.method === 'GET') return json(200, issueShape(forge, repo, issue));
    if (ctx.method === 'PATCH') {
      const body = parseBody(ctx);
      if (body === null) return error(400, 'malformed JSON body');
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return json(200, issueShape(forge, repo, issue));
    }
    return error(404, 'Not Found');
  }
  if (sub[1] === 'comments' && sub.length === 2) {
    if (ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return error(400, 'malformed JSON body');
      if (typeof body.body !== 'string') return error(422, 'body is required');
      const comment = forge.addComment(repo, number, body.body)!;
      return json(201, { id: comment.id, node_id: forge.commentGlobalId(repo, number, comment), body: comment.body, user: { login: forge.viewerLogin, id: forge.viewerId } });
    }
    if (ctx.method === 'GET') {
      const list = repo.comments.get(number) ?? [];
      return json(200, list.map((c) => ({ id: c.id, node_id: forge.commentGlobalId(repo, number, c), body: c.body, user: { login: forge.viewerLogin, id: forge.viewerId } })));
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}

function handlePulls(forge: Forge, ctx: RestContext, repo: RepoRecord, sub: string[], urlPath: string): RestResult {
  if (sub.length === 0) {
    if (ctx.method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return error(400, 'malformed JSON body');
      const head = typeof body.head === 'string' ? body.head : null;
      const base = typeof body.base === 'string' ? body.base : null;
      const title = typeof body.title === 'string' ? body.title : null;
      if (!head || !base || !title) return error(422, 'head, base and title are required');
      const result = forge.createPull(repo, head, base, title, typeof body.body === 'string' ? body.body : '');
      if ('error' in result) return error(422, result.error);
      return json(201, pullShape(forge, repo, result));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(list, ctx, `${urlPath}/pulls`);
      return json(200, page.map((p) => pullShape(forge, repo, p)), headers);
    }
    return error(404, 'Not Found');
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
  const pr = forge.getPull(repo, number);
  if (!pr) return error(404, 'Not Found');
  if (sub.length === 1) {
    if (ctx.method === 'GET') return json(200, pullShape(forge, repo, pr));
    return error(404, 'Not Found');
  }
  if (sub[1] === 'files' && sub.length === 2 && ctx.method === 'GET') {
    return json(200, forge.pullFiles(repo, pr));
  }
  if (sub[1] === 'merge' && sub.length === 2 && ctx.method === 'PUT') {
    const body = parseBody(ctx);
    if (body === null) return error(400, 'malformed JSON body');
    if (pr.state !== 'open') return error(404, 'Not Found');
    if (forge.mergeConflict(repo, pr)) return error(405, 'merge conflict');
    const sha = forge.mergePull(repo, pr)!;
    return json(200, { sha, merged: true, message: `Merge pull request #${pr.number} from ${pr.headRef}` });
  }
  return error(404, 'Not Found');
}
