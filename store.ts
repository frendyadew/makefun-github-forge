// The forge's in-memory data store: repositories, refs, git objects, issues, pull
// requests, comments and labels. One store per server process; each trial runs a
// fresh server so state never leaks between runs.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RefEntry {
  readonly name: string;
  readonly oid: string;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequest {
  readonly number: number;
  readonly state: 'open' | 'closed' | 'merged';
  readonly title: string;
  readonly body: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

const ZERO_OID = '0000000000000000000000000000000000000000';

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export class Store {
  /** Repositories by full name `owner/name`. */
  readonly repos = new Map<string, Repo>();
  /** Git objects by oid: `oid -> {type, data}`. */
  readonly objects = new Map<string, GitObject>();
  /** Refs per repo key `owner/name`: `ref name -> oid`. */
  readonly refs = new Map<string, Map<string, string>>();
  /** Issues per repo key `owner/name`: `number -> Issue`. */
  readonly issues = new Map<string, Map<number, Issue>>();
  /** Issue number cursor per repo. */
  readonly issueCursor = new Map<string, number>();
  /** Pull requests per repo key `owner/name`: `number -> PullRequest`. */
  readonly pulls = new Map<string, Map<number, PullRequest>>();
  /** Pull request number cursor per repo. */
  readonly pullCursor = new Map<string, number>();
  /** Comments per issue key `owner/name/number`: `id -> Comment`. */
  readonly comments = new Map<string, Map<number, Comment>>();
  /** Comment id cursor per issue key. */
  readonly commentCursor = new Map<string, number>();
  /** Labels per repo key `owner/name`: `name -> Label`. */
  readonly labels = new Map<string, Map<string, Label>>();
  /** Users: id -> {id, login, name, email}. */
  readonly users = new Map<number, { id: number; login: string; name: string; email: string }>();
  /** Global id -> object: used for GraphQL node(id:) resolution. */
  readonly nodeIds = new Map<string, { type: 'Repository' | 'Issue' | 'PullRequest'; key: string }>();

  nextRepoId = 5000;

  // ------------------------------------------------------------------ git objects

  hashObject(type: GitObjectType, data: Uint8Array): string {
    const header = new TextEncoder().encode(`${type} ${data.length}\0`);
    return sha1Hex(concat(header, data));
  }

  put(type: GitObjectType, data: Uint8Array): string {
    const oid = this.hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: new Uint8Array(data) });
    return oid;
  }

  blob(data: Uint8Array | string): string {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return this.put('blob', bytes);
  }

  treeFromEntries(entries: { mode: string; name: string; oid: string }[]): string {
    const sorted = [...entries].sort((a, b) => {
      const left = new TextEncoder().encode(a.mode === '40000' ? `${a.name}/` : a.name);
      const right = new TextEncoder().encode(b.mode === '40000' ? `${b.name}/` : b.name);
      return left.compare ? left.compare(right) : Buffer.compare(left, right);
    });
    const parts: Uint8Array[] = [];
    const enc = new TextEncoder();
    for (const entry of sorted) {
      if (!/^[0-9a-f]{40}$/.test(entry.oid)) throw new Error(`bad oid ${entry.oid}`);
      parts.push(enc.encode(`${entry.mode} ${entry.name}\0`));
      parts.push(hexToBytes(entry.oid));
    }
    return this.put('tree', concat(...parts));
  }

  commit(tree: string, parents: string[], author: string, committer: string, message: string, timestamp: number): string {
    const stamp = `${timestamp} +0000`;
    const lines: string[] = [];
    lines.push(`tree ${tree}`);
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${author} ${stamp}`);
    lines.push(`committer ${committer} ${stamp}`);
    lines.push('');
    lines.push(message.endsWith('\n') ? message : `${message}\n`);
    const data = new TextEncoder().encode(lines.join('\n'));
    return this.put('commit', data);
  }

  tag(object: string, type: GitObjectType, tag: string, tagger: string, message: string, timestamp: number): string {
    const stamp = `${timestamp} +0000`;
    const lines = [
      `object ${object}`,
      `type ${type}`,
      `tag ${tag}`,
      `tagger ${tagger} ${stamp}`,
      '',
      message.endsWith('\n') ? message : `${message}\n`,
    ];
    const data = new TextEncoder().encode(lines.join('\n'));
    return this.put('tag', data);
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Parse a tree object into entries. */
  treeEntries(data: Uint8Array): { mode: string; name: string; oid: string }[] {
    const buffer = Buffer.from(data);
    const entries: { mode: string; name: string; oid: string }[] = [];
    let offset = 0;
    while (offset < buffer.length) {
      const space = buffer.indexOf(0x20, offset);
      if (space < 0) break;
      const nul = buffer.indexOf(0x00, space + 1);
      if (nul < 0) break;
      if (nul + 21 > buffer.length) break;
      entries.push({
        mode: buffer.subarray(offset, space).toString('ascii'),
        name: buffer.subarray(space + 1, nul).toString('utf8'),
        oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
      });
      offset = nul + 21;
    }
    return entries;
  }

  /** Parse a commit object. */
  commitInfo(data: Uint8Array): { tree: string; parents: string[]; message: string } {
    const buffer = Buffer.from(data);
    const blank = buffer.indexOf('\n\n');
    const headerEnd = blank < 0 ? buffer.length : blank;
    const headerText = buffer.subarray(0, headerEnd).toString('utf8');
    const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
    let tree = '';
    const parents: string[] = [];
    for (const line of headerText.split('\n')) {
      if (!line) continue;
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      if (key === 'tree') tree = value;
      else if (key === 'parent') parents.push(value);
    }
    return { tree, parents, message };
  }

  /** Resolve a path relative to a commit: walk trees to find the entry. */
  resolvePath(commitOid: string, filePath: string): { oid: string; type: 'blob' | 'tree'; mode: string } | undefined {
    const commit = this.getObject(commitOid);
    if (!commit || commit.type !== 'commit') return undefined;
    const info = this.commitInfo(commit.data);
    let treeOid = info.tree;
    const segments = filePath.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const tree = this.getObject(treeOid);
      if (!tree || tree.type !== 'tree') return undefined;
      const entry = this.treeEntries(tree.data).find((e) => e.name === segments[i]);
      if (!entry) return undefined;
      if (i === segments.length - 1) return { oid: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob', mode: entry.mode };
      treeOid = entry.oid;
    }
    return undefined;
  }

  /** Blob content by oid. */
  blobContent(oid: string): Uint8Array | undefined {
    const obj = this.getObject(oid);
    if (!obj || obj.type !== 'blob') return undefined;
    return obj.data;
  }

  /** Whether `ancestor` is an ancestor of `oid` in the commit graph. */
  isAncestor(ancestorOid: string, oid: string): boolean {
    if (ancestorOid === oid) return true;
    const visited = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ancestorOid) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const commit = this.getObject(cur);
      if (!commit) continue;
      for (const p of this.commitInfo(commit.data).parents) stack.push(p);
    }
    return false;
  }

  /** Collect objects reachable from tips, limiting commit traversal depth. When depth is set, only
   *  that many commit generations are traversed; trees and blobs of included commits are always added. */
  collectReachableWithDepth(tips: string[], depth: number): { oids: string[]; boundaries: string[] } {
    const seen = new Set<string>();
    const boundaries: string[] = [];
    const stack: { oid: string; d: number }[] = tips.filter((t) => t !== ZERO_OID).map((t) => ({ oid: t, d: depth }));
    while (stack.length > 0) {
      const { oid, d } = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = this.getObject(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const info = this.commitInfo(obj.data);
        // Always traverse the commit's tree (blobs/subtrees are not depth-limited)
        const treeStack: string[] = [info.tree];
        while (treeStack.length > 0) {
          const t = treeStack.pop()!;
          if (seen.has(t)) continue;
          const tobj = this.getObject(t);
          if (!tobj || tobj.type !== 'tree') continue;
          seen.add(t);
          for (const entry of this.treeEntries(tobj.data)) {
            if (!seen.has(entry.oid)) treeStack.push(entry.oid);
          }
        }
        if (d > 1) {
          for (const p of info.parents) stack.push({ oid: p, d: d - 1 });
        } else {
          boundaries.push(oid);
        }
      } else if (obj.type === 'tree') {
        for (const entry of this.treeEntries(obj.data)) {
          if (!seen.has(entry.oid)) stack.push({ oid: entry.oid, d });
        }
      } else if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})\n/m.exec(text);
        if (m) stack.push({ oid: m[1], d });
      }
    }
    return { oids: [...seen], boundaries };
  }

  /** Walk a tree, returning a map of full path -> oid for every entry (files and trees). */
  treeMap(treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const tree = this.getObject(treeOid);
    if (!tree || tree.type !== 'tree') return out;
    for (const e of this.treeEntries(tree.data)) {
      const full = prefix ? `${prefix}/${e.name}` : e.name;
      out.set(full, e.oid);
      if (e.mode === '40000') {
        for (const [p, o] of this.treeMap(e.oid, full)) out.set(p, o);
      }
    }
    return out;
  }

  /** Create/update a file on a branch: build blob, nested trees, commit, update ref. */
  setFileOnBranch(owner: string, name: string, branch: string, filePath: string, contentBytes: Uint8Array, message: string, author: string, timestamp: number): { commitOid: string; blobOid: string } {
    const currentHead = this.getRef(owner, name, 'refs/heads/' + branch);
    let parentTreeOid: string | null = null;
    let parentCommits: string[] = [];
    if (currentHead) {
      const commit = this.getObject(currentHead);
      if (commit) {
        const info = this.commitInfo(commit.data);
        parentTreeOid = info.tree;
        parentCommits = [currentHead];
      }
    }

    const blobOid = this.put('blob', contentBytes);
    const segments = filePath.split('/');
    const newTreeOid = this.buildTreeWithFile(parentTreeOid, segments, 0, blobOid, segments[segments.length - 1]);

    const commitOid = this.commit(newTreeOid, parentCommits ? parentCommits : [], author, author, message, timestamp);
    this.setRef(owner, name, 'refs/heads/' + branch, commitOid);
    return { commitOid, blobOid };
  }

  /** Recursively build/replace a tree so that segments[idx] points at fileOid (a blob) at the last segment. */
  private buildTreeWithFile(treeOid: string | null, segments: string[], idx: number, fileOid: string, fileName: string): string {
    const existing: { mode: string; name: string; oid: string }[] = treeOid ? this.treeEntries(this.getObject(treeOid)!.data) : [];
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const e of existing) {
      if (e.name === segments[idx]) continue;
      entries.push(e);
    }
    if (idx === segments.length - 1) {
      entries.push({ mode: '100644', name: fileName, oid: fileOid });
    } else {
      const subName = segments[idx];
      let subTreeOid: string | null = null;
      for (const e of existing) {
        if (e.name === subName && e.mode === '40000') { subTreeOid = e.oid; break; }
      }
      const newSubTree = this.buildTreeWithFile(subTreeOid, segments, idx + 1, fileOid, fileName);
      entries.push({ mode: '40000', name: subName, oid: newSubTree });
    }
    return this.treeFromEntries(entries);
  }

  /** Delete a file from a branch's tree: rebuild trees without the file entry, commit, update ref. */
  deleteFileOnBranch(owner: string, name: string, branch: string, filePath: string, message: string, author: string, timestamp: number): { commitOid: string } | null {
    const currentHead = this.getRef(owner, name, 'refs/heads/' + branch);
    if (!currentHead) return null;
    const commit = this.getObject(currentHead);
    if (!commit) return null;
    const info = this.commitInfo(commit.data);
    const segments = filePath.split('/');
    const newTreeOid = this.buildTreeWithoutFile(info.tree, segments, 0);
    if (newTreeOid === null) return null;
    const commitOid = this.commit(newTreeOid, info.parents, author, author, message, timestamp);
    this.setRef(owner, name, 'refs/heads/' + branch, commitOid);
    return { commitOid };
  }

  /** Recursively rebuild a tree removing the entry at segments[idx]. Returns null if not found. */
  private buildTreeWithoutFile(treeOid: string | null, segments: string[], idx: number): string | null {
    if (!treeOid) return null;
    const tree = this.getObject(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entries = this.treeEntries(tree.data);
    const target = segments[idx];
    let found = false;
    const newEntries: { mode: string; name: string; oid: string }[] = [];
    for (const e of entries) {
      if (e.name === target) {
        found = true;
        if (idx === segments.length - 1) continue;
        if (e.mode !== '40000') return null;
        const newSub = this.buildTreeWithoutFile(e.oid, segments, idx + 1);
        if (newSub === null) return null;
        newEntries.push({ mode: '40000', name: target, oid: newSub });
      } else {
        newEntries.push(e);
      }
    }
    if (!found) return null;
    return this.treeFromEntries(newEntries);
  }

  // ------------------------------------------------------------------ repos

  repoKey(owner: string, name: string): string {
    return owner + '/' + name;
  }

  createRepo(owner: string, name: string, description: string, private_: boolean, defaultBranch = 'main'): Repo {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) throw new Error('repository ' + key + ' already exists');
    const id = this.nextRepoId++;
    const now = nowIso();
    const repo: Repo = {
      id,
      owner,
      name,
      fullName: key,
      description,
      private: private_,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(key, repo);
    this.refs.set(key, new Map());
    this.issues.set(key, new Map());
    this.issueCursor.set(key, 0);
    this.pulls.set(key, new Map());
    this.pullCursor.set(key, 0);
    this.labels.set(key, new Map());
    for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      this.labels.get(key)!.set(label, { name: label, color: 'ededed' });
    }
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  repoExists(owner: string, name: string): boolean {
    return this.repos.has(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    if (!this.repos.has(key)) return false;
    this.repos.delete(key);
    this.refs.delete(key);
    this.issues.delete(key);
    this.issueCursor.delete(key);
    this.pulls.delete(key);
    this.pullCursor.delete(key);
    this.comments.delete(key);
    this.commentCursor.delete(key);
    this.labels.delete(key);
    return true;
  }

  // ------------------------------------------------------------------ refs

  refMap(owner: string, name: string): Map<string, string> {
    const key = this.repoKey(owner, name);
    let m = this.refs.get(key);
    if (m === undefined) {
      m = new Map();
      this.refs.set(key, m);
    }
    return m;
  }

  setRef(owner: string, name: string, ref: string, oid: string): void {
    this.refMap(owner, name).set(ref, oid);
  }

  deleteRef(owner: string, name: string, ref: string): boolean {
    return this.refMap(owner, name).delete(ref);
  }

  getRef(owner: string, name: string, ref: string): string | undefined {
    return this.refMap(owner, name).get(ref);
  }

  listRefs(owner: string, name: string): Map<string, string> {
    return this.refMap(owner, name);
  }

  // ------------------------------------------------------------------ issues

  issueMapKey(owner: string, name: string): string {
    return owner + '/' + name;
  }

  issueMap(owner: string, name: string): Map<number, Issue> {
    const key = this.issueMapKey(owner, name);
    let m = this.issues.get(key);
    if (m === undefined) {
      m = new Map();
      this.issues.set(key, m);
    }
    return m;
  }

  nextIssueNumber(owner: string, name: string): number {
    const key = this.issueMapKey(owner, name);
    const cur = this.issueCursor.get(key) ?? 0;
    const next = cur + 1;
    this.issueCursor.set(key, next);
    return next;
  }

  createIssue(owner: string, name: string, title: string, body: string, labels: string[]): Issue {
    const number = this.nextIssueNumber(owner, name);
    const now = nowIso();
    const issue: Issue = { number, title, body, state: 'open', labels: [...labels], createdAt: now, updatedAt: now };
    this.issueMap(owner, name).set(number, issue);
    return issue;
  }

  getIssue(owner: string, name: string, number: number): Issue | undefined {
    return this.issueMap(owner, name).get(number);
  }

  listIssues(owner: string, name: string, state?: 'open' | 'closed' | 'all', sort?: string, direction?: string): Issue[] {
    let out = [...this.issueMap(owner, name).values()];
    if (state === 'open' || state === 'closed') out = out.filter((i) => i.state === state);
    if (sort === 'created') {
      out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (direction === 'desc') out.reverse();
    }
    return out;
  }

  closeIssue(owner: string, name: string, number: number): Issue | undefined {
    const issue = this.getIssue(owner, name, number);
    if (!issue) return undefined;
    const updated: Issue = { ...issue, state: 'closed', updatedAt: nowIso() };
    this.issueMap(owner, name).set(number, updated);
    return updated;
  }

  // ------------------------------------------------------------------ pull requests

  pullMap(owner: string, name: string): Map<number, PullRequest> {
    const key = this.issueMapKey(owner, name);
    let m = this.pulls.get(key);
    if (m === undefined) {
      m = new Map();
      this.pulls.set(key, m);
    }
    return m;
  }

  nextPullNumber(owner: string, name: string): number {
    const key = this.issueMapKey(owner, name);
    const cur = this.pullCursor.get(key) ?? 0;
    const next = cur + 1;
    this.pullCursor.set(key, next);
    return next;
  }

  createPullRequest(owner: string, name: string, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): PullRequest {
    const number = this.nextPullNumber(owner, name);
    const now = nowIso();
    const pr: PullRequest = {
      number,
      state: 'open',
      title,
      body,
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    this.pullMap(owner, name).set(number, pr);
    return pr;
  }

  getPullRequest(owner: string, name: string, number: number): PullRequest | undefined {
    return this.pullMap(owner, name).get(number);
  }

  listPullRequests(owner: string, name: string, state?: 'open' | 'closed' | 'all'): PullRequest[] {
    let out = [...this.pullMap(owner, name).values()];
    if (state === 'open') out = out.filter((p) => p.state === 'open');
    else if (state === 'closed') out = out.filter((p) => p.state === 'closed' || p.state === 'merged');
    return out;
  }

  mergePullRequest(owner: string, name: string, number: number, mergeSha: string, mergeCommitSha: string | null): PullRequest | undefined {
    const pr = this.getPullRequest(owner, name, number);
    if (!pr) return undefined;
    const now = nowIso();
    const updated: PullRequest = {
      ...pr,
      state: 'merged',
      merged: true,
      mergedAt: now,
      mergeCommitSha,
    };
    this.pullMap(owner, name).set(number, updated);
    return updated;
  }

  closePullRequest(owner: string, name: string, number: number): PullRequest | undefined {
    const pr = this.getPullRequest(owner, name, number);
    if (!pr) return undefined;
    const updated: PullRequest = { ...pr, state: 'closed', updatedAt: nowIso() };
    this.pullMap(owner, name).set(number, updated);
    return updated;
  }

  // ------------------------------------------------------------------ comments

  commentMapKey(owner: string, name: string, number: number): string {
    return owner + '/' + name + '/' + number;
  }

  commentMap(owner: string, name: string, number: number): Map<number, Comment> {
    const key = this.commentMapKey(owner, name, number);
    let m = this.comments.get(key);
    if (m === undefined) {
      m = new Map();
      this.comments.set(key, m);
    }
    return m;
  }

  nextCommentId(owner: string, name: string, number: number): number {
    const key = this.commentMapKey(owner, name, number);
    const cur = this.commentCursor.get(key) ?? 0;
    const next = cur + 1;
    this.commentCursor.set(key, next);
    return next;
  }

  createComment(owner: string, name: string, issueNumber: number, body: string): Comment {
    const id = this.nextCommentId(owner, name, issueNumber);
    const now = nowIso();
    const comment: Comment = { id, body, createdAt: now };
    this.commentMap(owner, name, issueNumber).set(id, comment);
    return comment;
  }

  listComments(owner: string, name: string, issueNumber: number): Comment[] {
    return [...this.commentMap(owner, name, issueNumber).values()];
  }

  // ------------------------------------------------------------------ labels

  labelMap(owner: string, name: string): Map<string, Label> {
    const key = this.issueMapKey(owner, name);
    let m = this.labels.get(key);
    if (m === undefined) {
      m = new Map();
      this.labels.set(key, m);
    }
    return m;
  }

  getLabel(owner: string, name: string, labelName: string): Label | undefined {
    return this.labelMap(owner, name).get(labelName);
  }

  createLabel(owner: string, name: string, labelName: string, color: string): Label {
    const label: Label = { name: labelName, color };
    this.labelMap(owner, name).set(labelName, label);
    return label;
  }

  // ------------------------------------------------------------------ users

  createUser(id: number, login: string, name: string, email: string): void {
    this.users.set(id, { id, login, name, email });
  }

  getUserByLogin(login: string): { id: number; login: string; name: string; email: string } | undefined {
    for (const u of this.users.values()) if (u.login === login) return u;
    return undefined;
  }

  // ------------------------------------------------------------------ global node ids

  nodeId(type: 'Repository' | 'Issue' | 'PullRequest', key: string): string {
    const id = 'gid_' + type + '_' + key;
    this.nodeIds.set(id, { type, key });
    return id;
  }

  resolveNodeId(id: string): { type: 'Repository' | 'Issue' | 'PullRequest'; key: string } | undefined {
    return this.nodeIds.get(id);
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}
