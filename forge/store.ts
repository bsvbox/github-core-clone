// The in-memory store: repositories, refs, objects, issues, pull requests,
// labels and comments. No disk, no clock, no randomness in any served state.

import {
  type GitObject,
  type ObjectStore,
  buildCommit,
  buildTree,
  diffTrees,
  flattenTree,
  getPathOid,
  hashObject,
  lineCounts,
  mergeBase,
  parseCommit,
  parseTag,
  setPath,
  storeObject,
} from './gitcore.ts';
import { FORGE_AUTHOR, FORGE_EPOCH, FORGE_MERGED_AT, b64url, isSha } from './util.ts';
import { VIEWER } from './scenario.ts';

export interface Issue {
  number: number;
  id: number; // REST id (global counter)
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface PullRequest {
  number: number;
  id: number; // REST id (global counter)
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface RepoRecord {
  name: string;
  id: number; // databaseId, sequential from 1 in creation order
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>; // 'refs/heads/main' -> oid; 'refs/tags/x' -> oid
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, IssueComment[]>; // issue number -> comments
  issueSeq: number; // next shared issue/PR number
  seq: number; // creation order, for stable listing
}

export class Forge {
  readonly viewerLogin = VIEWER.login;
  readonly viewerId = VIEWER.id;
  readonly viewerName = VIEWER.name;
  readonly viewerEmail = VIEWER.email;
  readonly token: string;
  readonly repos = new Map<string, RepoRecord>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  nextSeq = 1;
  requestSeq = 1;

  constructor(token: string) {
    this.token = token;
  }

  nextRequestId(): string {
    return `req-${this.requestSeq++}`;
  }

  // ---------------------------------------------------------- repositories

  createRepo(name: string, description = '', isPrivate = false): RepoRecord | null {
    if (this.repos.has(name)) return null;
    const repo: RepoRecord = {
      name,
      id: this.nextRepoId++,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      issueSeq: 1,
      seq: this.nextSeq++,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): RepoRecord | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): RepoRecord[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ---------------------------------------------------------- git state

  tip(repo: RepoRecord, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** All branch tips, sorted by branch name. */
  branches(repo: RepoRecord): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** All refs (branches + tags) for advertisements, sorted by name. */
  allRefs(repo: RepoRecord): Array<{ name: string; oid: string; peeled?: string }> {
    const out: Array<{ name: string; oid: string; peeled?: string }> = [];
    for (const [ref, oid] of repo.refs) {
      const entry: { name: string; oid: string; peeled?: string } = { name: ref, oid };
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        // Peeled: the commit the tag points at (one level).
        entry.peeled = parseTag(obj.data).object;
      }
      out.push(entry);
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // ---------------------------------------------------------- contents

  /** Commit a file change on a branch (creating the branch from the default
   *  tip when it does not exist yet). Returns the new commit sha, the blob
   *  sha, and whether the file is new on that branch. Throws an Error with
   *  a `status` property (404/409/422) for client errors. */
  commitFile(
    repo: RepoRecord,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; contentSha: string; created: boolean } {
    let tip = this.tip(repo, branch);
    if (tip === undefined) {
      const defaultTip = this.tip(repo, repo.defaultBranch);
      if (branch === repo.defaultBranch) {
        tip = undefined; // unborn default branch: first commit
      } else if (defaultTip === undefined) {
        throw Object.assign(new Error('cannot create a branch in an empty repository'), { status: 422 });
      } else {
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const treeOid = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
    const current = getPathOid(repo.objects, treeOid, path);
    if (expectedSha !== undefined) {
      if (current === null) throw Object.assign(new Error('file does not exist'), { status: 404 });
      if (current !== expectedSha) throw Object.assign(new Error('sha does not match the current file'), { status: 409 });
    }
    const created = current === null;
    const blobSha = storeObject(repo.objects, 'blob', content);
    const newTree = setPath(repo.objects, treeOid, path, blobSha);
    const commitData = buildCommit({
      tree: newTree,
      parents: tip ? [tip] : [],
      author: `${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`,
      committer: `${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`,
      message,
    });
    const commitSha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: blobSha, created };
  }

  /** Delete a file on a branch. Returns the new commit sha. */
  deleteFile(
    repo: RepoRecord,
    branch: string,
    path: string,
    message: string,
    expectedSha?: string,
  ): { commitSha: string } {
    const tip = this.tip(repo, branch);
    if (tip === undefined) throw Object.assign(new Error('branch not found'), { status: 404 });
    const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const current = getPathOid(repo.objects, treeOid, path);
    if (current === null) throw Object.assign(new Error('file does not exist'), { status: 404 });
    if (expectedSha !== undefined && current !== expectedSha) {
      throw Object.assign(new Error('sha does not match the current file'), { status: 409 });
    }
    const newTree = setPath(repo.objects, treeOid, path, null);
    const commitData = buildCommit({
      tree: newTree,
      parents: [tip],
      author: `${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`,
      committer: `${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`,
      message,
    });
    const commitSha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  // ---------------------------------------------------------- issues

  createIssue(repo: RepoRecord, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      number: repo.issueSeq++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq++,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: RepoRecord, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  addComment(repo: RepoRecord, issueNumber: number, body: string): IssueComment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const comment: IssueComment = { id: this.nextCommentId++, body, createdSeq: this.nextSeq++ };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // ---------------------------------------------------------- pull requests

  createPull(
    repo: RepoRecord,
    head: string,
    base: string,
    title: string,
    body: string,
  ): PullRequest | { error: string } {
    const headTip = this.tip(repo, head);
    const baseTip = this.tip(repo, base);
    if (headTip === undefined) return { error: `head branch ${head} not found` };
    if (baseTip === undefined) return { error: `base branch ${base} not found` };
    const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (dup) return { error: 'a pull request already exists for this head and base' };
    const pr: PullRequest = {
      number: repo.issueSeq++,
      id: this.nextPullId++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      createdSeq: this.nextSeq++,
    };
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: RepoRecord, number: number): PullRequest | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  /** The base branch's current tip: a merge is computed against where the
   *  base is now, not where it was when the pull request was opened (a
   *  sibling pull request may have advanced it in between). */
  baseTip(repo: RepoRecord, pr: PullRequest): string {
    return this.tip(repo, pr.baseRef) ?? pr.baseSha;
  }

  /** The 3-way merge conflict test: a path changed on both sides of the
   *  merge-base with different resulting content conflicts. */
  mergeConflict(repo: RepoRecord, pr: PullRequest): boolean {
    const baseTip = this.baseTip(repo, pr);
    const base = mergeBase(repo.objects, pr.headSha, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(pr.headSha)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headDiff = diffTrees(repo.objects, baseTree, headTree);
    const baseDiff = diffTrees(repo.objects, baseTree, baseTipTree);
    const headMap = new Map(headDiff.map((d) => [d.path, d.newOid]));
    for (const d of baseDiff) {
      const h = headMap.get(d.path);
      if (h !== undefined && h !== d.newOid) return true;
    }
    return false;
  }

  /** Mergeable state for GraphQL. */
  mergeable(repo: RepoRecord, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    return this.mergeConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge an open PR onto its base branch. Returns the squash commit
   *  sha, or null when the merge conflicts. */
  mergePull(repo: RepoRecord, pr: PullRequest): string | null {
    if (pr.state !== 'open') return null;
    if (this.mergeConflict(repo, pr)) return null;
    const baseTip = this.baseTip(repo, pr);
    const base = mergeBase(repo.objects, pr.headSha, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(pr.headSha)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    // Start from the base tip's tree, apply the head's changes.
    const merged = flattenTree(repo.objects, baseTipTree);
    for (const d of diffTrees(repo.objects, baseTree, headTree)) {
      if (d.status === 'removed') merged.delete(d.path);
      else if (d.newOid) {
        const obj = repo.objects.get(d.newOid)!;
        merged.set(d.path, { oid: d.newOid, mode: obj.type === 'tree' ? '40000' : '100644' });
      }
    }
    let treeOid = storeObject(repo.objects, 'tree', Buffer.alloc(0));
    // Rebuild the tree bottom-up from the flat map.
    const paths = [...merged.keys()].sort();
    const buildLevel = (prefix: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const seen = new Set<string>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          if (seen.has(rest)) continue;
          seen.add(rest);
          entries.push({ mode: '100644', name: rest, oid: merged.get(path)!.oid });
        } else {
          const dir = rest.slice(0, slash);
          if (seen.has(dir)) continue;
          seen.add(dir);
          entries.push({ mode: '40000', name: dir, oid: buildLevel(prefix + dir + '/') });
        }
      }
      return storeObject(repo.objects, 'tree', buildTree(entries));
    };
    treeOid = buildLevel('');
    const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: `${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`,
      committer: `${FORGE_AUTHOR} ${FORGE_EPOCH} +0000`,
      message,
    });
    const commitSha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FORGE_MERGED_AT;
    pr.mergeCommitSha = commitSha;
    return commitSha;
  }

  /** Files changed by a PR (merge-base -> head), with line counts. */
  pullFiles(repo: RepoRecord, pr: PullRequest): Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const baseTip = this.baseTip(repo, pr);
    const base = mergeBase(repo.objects, pr.headSha, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(pr.headSha)!.data).tree;
    return diffTrees(repo.objects, baseTree, headTree).map((d) => {
      const counts = lineCounts(repo.objects, d);
      const status = d.status === 'added' ? 'added' : d.status === 'removed' ? 'removed' : 'modified';
      return {
        filename: d.path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      };
    });
  }

  // ---------------------------------------------------------- global ids

  repoGlobalId(repo: RepoRecord): string {
    return b64url(`Repository:${repo.id}`);
  }

  issueGlobalId(repo: RepoRecord, issue: Issue): string {
    return b64url(`Issue:${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: RepoRecord, pr: PullRequest): string {
    return b64url(`PullRequest:${repo.id}:${pr.number}`);
  }

  commentGlobalId(repo: RepoRecord, issueNumber: number, comment: IssueComment): string {
    return b64url(`IssueComment:${repo.id}:${issueNumber}:${comment.id}`);
  }

  /** Resolve an opaque global id. Returns the kind and the located record. */
  resolveGlobalId(id: string): { kind: string; repo: RepoRecord; issue?: Issue; pr?: PullRequest; comment?: IssueComment } | null {
    let decoded: string;
    try {
      decoded = Buffer.from(id, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId)) return null;
    const repo = [...this.repos.values()].find((r) => r.id === repoId);
    if (!repo) return null;
    if (parts[0] === 'Repository' && parts.length === 2) return { kind: 'Repository', repo };
    if (parts[0] === 'Issue' && parts.length === 3) {
      const issue = this.getIssue(repo, Number(parts[2]));
      return issue ? { kind: 'Issue', repo, issue } : null;
    }
    if (parts[0] === 'PullRequest' && parts.length === 3) {
      const pr = this.getPull(repo, Number(parts[2]));
      return pr ? { kind: 'PullRequest', repo, pr } : null;
    }
    if (parts[0] === 'IssueComment' && parts.length === 4) {
      const issue = this.getIssue(repo, Number(parts[2]));
      const comment = (repo.comments.get(Number(parts[2])) ?? []).find((c) => c.id === Number(parts[3]));
      return issue && comment ? { kind: 'IssueComment', repo, issue, comment } : null;
    }
    return null;
  }
}

// The store module's public re-exports for the router.
export { hashObject, isSha };
