// GitHub REST v3 surface for the forge. Routes under /api/v3.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export class RestService {
  private readonly store: Store;
  private baseUrl: string;
  constructor(store: Store, baseUrl = 'http://entry') {
    this.store = store;
    this.baseUrl = baseUrl;
  }

  send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': crypto.randomUUID(), ...extra });
    res.end(text);
  }

  json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    this.send(res, status, body, extra);
  }

  message(res: ServerResponse, status: number, message: string): void {
    this.send(res, status, { message });
  }

  noContent(res: ServerResponse): void {
    res.writeHead(204, { 'content-length': '0', 'x-github-request-id': crypto.randomUUID() });
    res.end();
  }

  private parseBody(req: IncomingMessage): unknown {
    try {
      return JSON.parse((req as any)._body ?? '');
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------ routes

  handle(req: { method: string; url: string; origin?: string }, res: ServerResponse): boolean {
    if (req.origin) this.baseUrl = req.origin;
    const url = new URL(req.url, 'http://entry');
    const path = url.pathname;
    const method = req.method;

    if (path === '/api/v3' || path === '/api/v3/') {
      if (method !== 'GET') return false;
      this.json(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }

    if (path === '/api/v3/meta') {
      if (method !== 'GET') return false;
      this.json(res, 200, { installed_version: 'forge/1.0' });
      return true;
    }

    // Require a bearer token for every other /api/v3 route.
    const auth = (req as any).headers?.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      this.message(res, 401, 'Requires authentication');
      return true;
    }

    if (path === '/api/v3/user') {
      if (method !== 'GET') return false;
      this.json(res, 200, { login: 'adaiversen', id: 1000, name: 'Ada Iversen' });
      return true;
    }

    const mUserRepos = path.match(/^\/api\/v3\/user\/repos$/);
    if (mUserRepos) {
      if (method === 'GET') return this.listUserRepos(res, url);
      if (method === 'POST') return this.createRepo(res, req as IncomingMessage);
      return false;
    }

    const mRepo = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
    if (mRepo) {
      const owner = mRepo[1];
      const name = mRepo[2];
      if (method === 'GET') return this.getRepo(res, owner, name);
      if (method === 'PATCH') return this.patchRepo(res, owner, name, req as IncomingMessage);
      if (method === 'DELETE') return this.deleteRepo(res, owner, name);
      return false;
    }

    const mBranches = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/);
    if (mBranches) {
      if (method !== 'GET') return false;
      return this.listBranches(res, mBranches[1], mBranches[2]);
    }

    const mCommits = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/);
    if (mCommits) {
      if (method !== 'GET') return false;
      return this.listCommits(res, url, mCommits[1], mCommits[2]);
    }

    const mContents = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/);
    if (mContents) {
      const owner = mContents[1];
      const name = mContents[2];
      const filePath = decodeURIComponent(mContents[3]);
      if (method === 'GET') return this.getContents(res, owner, name, filePath, url);
      if (method === 'PUT') return this.putContents(res, owner, name, filePath, req as IncomingMessage);
      if (method === 'DELETE') return this.deleteContents(res, owner, name, filePath, req as IncomingMessage);
      return false;
    }

    const mRefs = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/?$/);
    if (mRefs) {
      if (method === 'POST') return this.createRef(res, mRefs[1], mRefs[2], req as IncomingMessage);
      return false;
    }

    const mRefHead = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/(git\/refs\/heads\/|branches\/)([^/]+)$/);
    if (mRefHead) {
      if (method !== 'GET') return false;
      return this.getRef(res, mRefHead[1], mRefHead[2], mRefHead[4]);
    }

    const mIssues = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/);
    if (mIssues) {
      if (method === 'GET') return this.listIssues(res, url, mIssues[1], mIssues[2]);
      if (method === 'POST') return this.createIssue(res, mIssues[1], mIssues[2], req as IncomingMessage);
      return false;
    }

    const mIssue = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
    if (mIssue) {
      if (method === 'GET') return this.getIssue(res, mIssue[1], mIssue[2], Number(mIssue[3]));
      if (method === 'PATCH') return this.patchIssue(res, mIssue[1], mIssue[2], Number(mIssue[3]), req as IncomingMessage);
      return false;
    }

    const mComments = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/);
    if (mComments) {
      if (method === 'GET') return this.listComments(res, mComments[1], mComments[2], Number(mComments[3]));
      if (method === 'POST') return this.createComment(res, mComments[1], mComments[2], Number(mComments[3]), req as IncomingMessage);
      return false;
    }

    const mLabels = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/);
    if (mLabels) {
      if (method === 'POST') return this.createLabel(res, mLabels[1], mLabels[2], req as IncomingMessage);
      return false;
    }

    const mPulls = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (mPulls) {
      if (method === 'GET') return this.listPulls(res, url, mPulls[1], mPulls[2]);
      if (method === 'POST') return this.createPull(res, mPulls[1], mPulls[2], req as IncomingMessage);
      return false;
    }

    const mPull = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (mPull) {
      if (method === 'GET') return this.getPull(res, mPull[1], mPull[2], Number(mPull[3]));
      return false;
    }

    const mPullFiles = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/);
    if (mPullFiles) {
      if (method !== 'GET') return false;
      return this.getPullFiles(res, mPullFiles[1], mPullFiles[2], Number(mPullFiles[3]));
    }

    const mPullMerge = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
    if (mPullMerge) {
      if (method !== 'PUT') return false;
      return this.mergePull(res, mPullMerge[1], mPullMerge[2], Number(mPullMerge[3]), req as IncomingMessage);
    }

    if (path.startsWith('/api/v3')) {
      this.message(res, 404, 'Not Found');
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------------ handlers

  private listUserRepos(res: ServerResponse, url: URL): void {
    const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? '30'), 1), 100);
    const page = Math.max(Number(url.searchParams.get('page') ?? '1'), 1);
    const all = [...this.store.repos.values()].filter((r) => r.owner === 'adaiversen');
    const start = (page - 1) * perPage;
    const pageItems = all.slice(start, start + perPage);
    const body = pageItems.map((r) => ({ id: r.id, name: r.name, full_name: r.fullName, owner: { login: r.owner }, private: r.private, default_branch: r.defaultBranch }));
    if (start + perPage < all.length) {
      const next = new URL(url.pathname, this.baseUrl);
      next.searchParams.set('per_page', String(perPage));
      next.searchParams.set('page', String(page + 1));
      res.setHeader('link', `<${next.toString()}>; rel="next"`);
    }
    this.json(res, 200, body);
  }

  private createRepo(res: ServerResponse, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const name = body?.name;
    if (typeof name !== 'string') { this.message(res, 422, 'name required'); return; }
    try {
      const repo = this.store.createRepo('adaiversen', name, typeof body?.description === 'string' ? body.description : '', typeof body?.private === 'boolean' ? body.private : true);
      this.json(res, 201, { id: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch });
    } catch {
      this.message(res, 422, 'already exists');
    }
  }

  private getRepo(res: ServerResponse, owner: string, name: string): void {
    const repo = this.store.getRepo(owner, name);
    if (!repo) { this.message(res, 404, 'Not Found'); return; }
    this.json(res, 200, { id: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch });
  }

  private patchRepo(res: ServerResponse, owner: string, name: string, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const repo = this.store.getRepo(owner, name);
    if (!repo) { this.message(res, 404, 'Not Found'); return; }
    const description = typeof body?.description === 'string' ? body.description : repo.description;
    const updated: any = { ...repo, description, updatedAt: new Date().toISOString() };
    this.store.repos.set(`${owner}/${name}`, updated);
    this.json(res, 200, { id: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, description });
  }

  private deleteRepo(res: ServerResponse, owner: string, name: string): void {
    if (!this.store.repoExists(owner, name)) { this.message(res, 404, 'Not Found'); return; }
    this.store.deleteRepo(owner, name);
    this.noContent(res);
  }

  private listBranches(res: ServerResponse, owner: string, name: string): void {
    if (!this.store.repoExists(owner, name)) { this.message(res, 404, 'Not Found'); return; }
    const refs = this.store.listRefs(owner, name);
    const body = [...refs.entries()].map(([ref, oid]) => ({ name: ref.replace(/^refs\/heads\//, ''), commit: { sha: oid } }));
    this.json(res, 200, body);
  }

  private listCommits(res: ServerResponse, url: URL, owner: string, name: string): void {
    if (!this.store.repoExists(owner, name)) { this.message(res, 404, 'Not Found'); return; }
    const sha = url.searchParams.get('sha');
    let commitSha = sha ?? '';
    const SHA40 = /^[0-9a-f]{40}$/i;
    if (commitSha && !SHA40.test(commitSha)) {
      const refOid = this.store.getRef(owner, name, `refs/heads/${commitSha}`);
      if (refOid) commitSha = refOid;
    }
    if (!commitSha) commitSha = '0000000000000000000000000000000000000000';
    let message = 'seeded commit';
    const commit = this.store.getObject(commitSha);
    if (commit) message = this.store.commitInfo(commit.data).message.replace(/\n+$/, '');
    const body = [{ sha: commitSha, commit: { message } }];
    this.json(res, 200, body);
  }

  private getContents(res: ServerResponse, owner: string, name: string, filePath: string, url: URL): void {
    if (!this.store.repoExists(owner, name)) { this.message(res, 404, 'Not Found'); return; }
    const ref = url.searchParams.get('ref');
    const branch = ref ?? this.store.getRepo(owner, name)?.defaultBranch ?? 'main';
    const head = this.store.getRef(owner, name, `refs/heads/${branch}`);
    if (!head) { this.message(res, 404, 'Not Found'); return; }
    const entry = this.store.resolvePath(head, filePath);
    if (!entry) { this.message(res, 404, 'Not Found'); return; }
    if (entry.type === 'tree') {
      const tree = this.store.getObject(entry.oid);
      if (!tree) { this.message(res, 404, 'Not Found'); return; }
      const entries = this.store.treeEntries(tree.data).map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: filePath ? `${filePath}/${e.name}` : e.name,
        sha: e.oid,
      }));
      this.json(res, 200, entries);
      return;
    }
    const content = this.store.blobContent(entry.oid);
    if (!content) { this.message(res, 404, 'Not Found'); return; }
    this.json(res, 200, {
      type: 'file', encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
      sha: entry.oid,
      size: content.length,
    });
  }

  private putContents(res: ServerResponse, owner: string, name: string, filePath: string, req: IncomingMessage): void {
    const url = new URL(req.url, 'http://entry');
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const message = typeof body?.message === 'string' ? body.message : 'commit';
    const contentB64 = typeof body?.content === 'string' ? body.content : '';
    const branch = typeof body?.branch === 'string' ? body.branch : (typeof url.searchParams.get('branch') === 'string' ? url.searchParams.get('branch') : undefined);
    const sha = typeof body?.sha === 'string' ? body.sha : undefined;

    const targetBranch = branch ?? 'main';
    const head = this.store.getRef(owner, name, `refs/heads/${targetBranch}`);

    // Stale-sha check: compare provided sha against the current blob sha at this path.
    if (sha !== undefined && head) {
      const current = this.store.resolvePath(head, filePath);
      if (!current || current.type !== 'blob' || current.oid !== sha) { this.message(res, 409, 'sha mismatch'); return; }
    }

    // Determine create vs update by whether the file already exists at this path.
    const existing = head ? this.store.resolvePath(head, filePath) : undefined;
    const contentBytes = Buffer.from(contentB64, 'base64');
    const result = this.store.setFileOnBranch(owner, name, targetBranch, filePath, contentBytes, message, 'Ada Iversen <adaiversen@example.invalid>', Date.now() / 1000);

    this.json(res, existing ? 200 : 201, {
      content: { sha: result.blobOid, encoding: 'base64' },
      commit: { sha: result.commitOid },
    });
  }

  private deleteContents(res: ServerResponse, owner: string, name: string, filePath: string, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const message = typeof body?.message === 'string' ? body.message : 'commit';
    const branch = typeof body?.branch === 'string' ? body.branch : undefined;
    const targetBranch = branch ?? 'main';
    const head = this.store.getRef(owner, name, `refs/heads/${targetBranch}`);
    if (!head) { this.message(res, 404, 'Not Found'); return; }
    const current = this.store.resolvePath(head, filePath);
    if (!current || current.type !== 'blob') { this.message(res, 404, 'Not Found'); return; }
    const result = this.store.deleteFileOnBranch(owner, name, targetBranch, filePath, message, 'Ada Iversen <adaiversen@example.invalid>', Date.now() / 1000);
    if (!result) { this.message(res, 404, 'Not Found'); return; }
    this.json(res, 200, { commit: { sha: result.commitOid } });
  }

  private createRef(res: ServerResponse, owner: string, name: string, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    const oid = typeof body?.sha === 'string' ? body.sha : '';
    if (!ref || !oid) { this.message(res, 422, 'ref and sha required'); return; }
    this.store.setRef(owner, name, ref, oid);
    this.json(res, 201, { ref, object: { sha: oid } });
  }

  private getRef(res: ServerResponse, owner: string, name: string, branch: string): void {
    const oid = this.store.getRef(owner, name, `refs/heads/${branch}`);
    if (!oid) { this.message(res, 404, 'Not Found'); return; }
    this.json(res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid }, url: '' });
  }

  private listIssues(res: ServerResponse, url: URL, owner: string, name: string): void {
    if (!this.store.repoExists(owner, name)) { this.message(res, 404, 'Not Found'); return; }
    const state = url.searchParams.get('state') as 'open' | 'closed' | undefined;
    const sort = url.searchParams.get('sort') ?? undefined;
    const direction = url.searchParams.get('direction') ?? undefined;
    const issues = this.store.listIssues(owner, name, state, sort, direction);
    const body = issues.map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((l) => ({ name: l })), created_at: i.createdAt, updated_at: i.updatedAt, id: this.store.nodeId('Issue', `${owner}/${name}/${i.number}`) }));
    this.json(res, 200, body);
  }

  private createIssue(res: ServerResponse, owner: string, name: string, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const title = typeof body?.title === 'string' ? body.title : '';
    const labels = Array.isArray(body?.labels) ? body.labels.filter((l: unknown) => typeof l === 'string') : [];
    if (!title) { this.message(res, 422, 'title required'); return; }
    // Unknown label check
    for (const label of labels) {
      if (!this.store.getLabel(owner, name, label)) { this.message(res, 422, 'unknown label'); return; }
    }
    const issue = this.store.createIssue(owner, name, title, typeof body?.body === 'string' ? body.body : '', labels);
    this.json(res, 201, { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((l) => ({ name: l })), created_at: issue.createdAt, updated_at: issue.updatedAt, id: this.store.nodeId('Issue', `${owner}/${name}/${issue.number}`) });
  }

  private getIssue(res: ServerResponse, owner: string, name: string, number: number): void {
    const issue = this.store.getIssue(owner, name, number);
    if (!issue) { this.message(res, 404, 'Not Found'); return; }
    this.json(res, 200, { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((l) => ({ name: l })), created_at: issue.createdAt, updated_at: issue.updatedAt, id: this.store.nodeId('Issue', `${owner}/${name}/${issue.number}`) });
  }

  private patchIssue(res: ServerResponse, owner: string, name: string, number: number, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const issue = this.store.getIssue(owner, name, number);
    if (!issue) { this.message(res, 404, 'Not Found'); return; }
    const state = typeof body?.state === 'string' ? body.state : issue.state;
    const updated = { ...issue, state: state as 'open' | 'closed', updatedAt: new Date().toISOString() };
    this.store.issues.get(`${owner}/${name}`)!.set(number, updated as any);
    this.json(res, 200, { number: updated.number, state: updated.state });
  }

  private listComments(res: ServerResponse, owner: string, name: string, issueNumber: number): void {
    const comments = this.store.listComments(owner, name, issueNumber);
    const body = comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt }));
    this.json(res, 200, body);
  }

  private createComment(res: ServerResponse, owner: string, name: string, issueNumber: number, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const commentBody = typeof body?.body === 'string' ? body.body : '';
    const comment = this.store.createComment(owner, name, issueNumber, commentBody);
    this.json(res, 201, { id: comment.id, body: comment.body });
  }

  private createLabel(res: ServerResponse, owner: string, name: string, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const labelName = typeof body?.name === 'string' ? body.name : '';
    const color = typeof body?.color === 'string' ? body.color : 'ededed';
    if (!labelName) { this.message(res, 422, 'name required'); return; }
    const label = this.store.createLabel(owner, name, labelName, color);
    this.json(res, 201, { name: label.name, color: label.color });
  }

  private listPulls(res: ServerResponse, url: URL, owner: string, name: string): void {
    if (!this.store.repoExists(owner, name)) { this.message(res, 404, 'Not Found'); return; }
    const state = (url.searchParams.get('state') ?? 'open') as 'open' | 'closed' | 'all';
    const pulls = this.store.listPullRequests(owner, name, state === 'all' ? 'all' : state);
    const body = pulls.map((p) => ({ number: p.number, state: p.state === 'merged' ? 'closed' : p.state, title: p.title, body: p.body, head: { ref: p.headRef, sha: p.headSha }, base: { ref: p.baseRef, sha: p.baseSha }, merged: p.merged, merge_commit_sha: p.mergeCommitSha }));
    this.json(res, 200, body);
  }

  private createPull(res: ServerResponse, owner: string, name: string, req: IncomingMessage): void {
    const body = this.parseBody(req) as Record<string, unknown> | undefined;
    const title = typeof body?.title === 'string' ? body.title : '';
    const head = typeof body?.head === 'string' ? body.head : '';
    const base = typeof body?.base === 'string' ? body.base : 'main';
    if (!title || !head) { this.message(res, 422, 'title and head required'); return; }
    const repo = this.store.getRepo(owner, name);
    if (!repo) { this.message(res, 404, 'Not Found'); return; }
    const headSha = this.store.getRef(owner, name, `refs/heads/${head}`) ?? '0000000000000000000000000000000000000000';
    const baseSha = this.store.getRef(owner, name, `refs/heads/${base}`) ?? '0000000000000000000000000000000000000000';
    const pr = this.store.createPullRequest(owner, name, title, typeof body?.body === 'string' ? body.body : '', head, headSha, base, baseSha);
    this.json(res, 201, { number: pr.number, state: 'open', title: pr.title, body: pr.body, head: { ref: pr.headRef, sha: pr.headSha }, base: { ref: pr.baseRef, sha: pr.baseSha } });
  }

  private getPull(res: ServerResponse, owner: string, name: string, number: number): void {
    const pull = this.store.getPullRequest(owner, name, number);
    if (!pull) { this.message(res, 404, 'Not Found'); return; }
    this.json(res, 200, { number: pull.number, state: pull.state === 'merged' ? 'closed' : pull.state, title: pull.title, body: pull.body, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha }, merged: pull.merged, merge_commit_sha: pull.mergeCommitSha, merged_at: pull.mergedAt });
  }

  private getPullFiles(res: ServerResponse, owner: string, name: string, number: number): void {
    const pull = this.store.getPullRequest(owner, name, number);
    if (!pull) { this.message(res, 404, 'Not Found'); return; }
    const headCommit = this.store.getObject(pull.headSha);
    const baseCommit = this.store.getObject(pull.baseSha);
    if (!headCommit || !baseCommit) { this.message(res, 404, 'Not Found'); return; }
    const headMap = this.store.treeMap(this.store.commitInfo(headCommit.data).tree);
    const baseMap = this.store.treeMap(this.store.commitInfo(baseCommit.data).tree);
    const changed = new Map<string, { status: string; additions: number; deletions: number }>();
    for (const [path, oid] of headMap) {
      const baseOid = baseMap.get(path);
      if (baseOid === undefined) changed.set(path, { status: 'added', additions: 1, deletions: 0 });
      else if (baseOid !== oid) changed.set(path, { status: 'modified', additions: 1, deletions: 1 });
    }
    for (const [path] of baseMap) {
      if (!headMap.has(path)) changed.set(path, { status: 'deleted', additions: 0, deletions: 1 });
    }
    const body = [...changed.entries()].map(([path, c]) => ({ filename: path, status: c.status, additions: c.additions, deletions: c.deletions, changes: c.additions + c.deletions }));
    this.json(res, 200, body);
  }

  private mergePull(res: ServerResponse, owner: string, name: string, number: number, req: IncomingMessage): void {
    const pull = this.store.getPullRequest(owner, name, number);
    if (!pull) { this.message(res, 404, 'Not Found'); return; }
    // Conflict detection: base branch tip vs head tip diverged (neither is ancestor of the other).
    const currentBase = this.store.getRef(owner, name, `refs/heads/${pull.baseRef}`);
    if (!currentBase) { this.message(res, 404, 'Not Found'); return; }
    const headAncestorOfBase = this.store.isAncestor(currentBase, pull.headSha);
    const baseAncestorOfHead = this.store.isAncestor(pull.headSha, currentBase);
    if (!headAncestorOfBase && !baseAncestorOfHead) {
      this.message(res, 405, 'conflict');
      return;
    }
    // Squash merge: base branch receives the head branch's tree.
    const headCommit = this.store.getObject(pull.headSha);
    if (!headCommit || headCommit.type !== 'commit') { this.message(res, 405, 'conflict'); return; }
    const headTree = this.store.commitInfo(headCommit.data).tree;
    const mergeCommitOid = this.store.commit(headTree, currentBase ? [currentBase] : [], 'Ada Iversen <adaiversen@example.invalid>', 'Ada Iversen <adaiversen@example.invalid>', `Merge pull request #${number}`, Date.now() / 1000);
    this.store.setRef(owner, name, `refs/heads/${pull.baseRef}`, mergeCommitOid);
    const updated = this.store.mergePullRequest(owner, name, number, mergeCommitOid, mergeCommitOid);
    if (!updated) { this.message(res, 405, 'conflict'); return; }
    this.json(res, 200, { merged: true, sha: mergeCommitOid, message: 'merged' });
  }
}

function storePutBlob(store: Store, data: Buffer): string {
  return store.put('blob', new Uint8Array(data));
}
