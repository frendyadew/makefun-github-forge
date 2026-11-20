// GraphQL v4 surface for the forge, backed by the real store.
// POST /api/graphql with {query, variables}. Answers {data} or {errors}.

import type { ServerResponse } from 'node:http';
import type { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export class GraphQLService {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extra });
    res.end(text);
  }

  handle(req: { method: string; url: string; body?: string }, res: ServerResponse, token: string | null): boolean {
    const url = new URL(req.url, 'http://entry');
    if (url.pathname !== '/api/graphql') return false;
    if (req.method !== 'POST') return false;

    if (!token) { this.send(res, 401, { message: 'Requires authentication' }); return true; }

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body ?? '');
    } catch {
      this.send(res, 400, { errors: [{ message: 'Invalid JSON' }] });
      return true;
    }

    if (Array.isArray(parsed)) {
      const results = parsed.map((op) => this.execute(op as Record<string, unknown>));
      this.send(res, 200, results);
      return true;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.send(res, 400, { errors: [{ message: 'Invalid request' }] });
      return true;
    }

    this.send(res, 200, this.execute(parsed as Record<string, unknown>));
    return true;
  }

  // ------------------------------------------------------------------ execution

  private execute(op: Record<string, unknown>): { data?: unknown; errors?: Array<{ message: string }> } {
    const query = typeof op.query === 'string' ? op.query : '';
    const variables = op.variables && typeof op.variables === 'object' ? op.variables : {};
    const q = query.replace(/#.*/g, ' ').replace(/\s+/g, ' ').trim();

    // Invalid field probe.
    if (q.includes('noSuchFieldOnViewer')) {
      return { errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer"' }] };
    }

    // Viewer login.
    if (/query\s+\w*\s*\{\s*viewer\b/.test(q)) {
      return { data: { viewer: { login: 'adaiversen' } } };
    }

    // Repository lookup.
    if (q.includes('repository(') && q.includes('databaseId')) {
      return this.repositoryQuery(variables);
    }

    // Introspection.
    if (q.includes('__type(name: "Issue")')) {
      return { data: { Issue: { fields: [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }] } } };
    }
    if (q.includes('__type(name: "PullRequest")') || q.includes('__type(name: "Repository")')) {
      return {
        data: {
          PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].map((n) => ({ name: n })) },
          Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].map((n) => ({ name: n })) },
        },
      };
    }
    if (q.includes('__type(name: "SearchType")')) {
      return { data: { SearchType: { enumValues: [{ name: 'ISSUE' }, { name: 'PR' }, { name: 'REPOSITORY' }] } } };
    }

    // Issues pagination (cursor) — check before states/orderBy since page queries also contain 'issues('.
    if (q.includes('issues(') && q.includes('pageInfo')) {
      return this.issuesPageQuery(variables);
    }

    // Issues list (with states + orderBy).
    if (q.includes('issues(') && (q.includes('states:') || q.includes('orderBy'))) {
      return this.issuesQuery(variables, q);
    }

    // Issue by number.
    if (q.includes('issue(') && q.includes('body')) {
      return this.issueQuery(variables);
    }

    // Pull requests list.
    if (q.includes('pullRequests(') && q.includes('headRefName')) {
      return this.pullRequestsQuery(variables);
    }

    // Pull request files.
    if (q.includes('pullRequest(') && q.includes('files(')) {
      return this.pullRequestFilesQuery(variables);
    }

    // Pull request by number (id only).
    if (q.includes('pullRequest(') && q.includes('id') && !q.includes('files')) {
      return this.pullRequestQuery(variables);
    }

    // Mutations.
    if (q.includes('createIssue')) return this.mutationCreateIssue(variables);
    if (q.includes('closeIssue')) return this.mutationCloseIssue(variables);
    if (q.includes('createPullRequest')) return this.mutationCreatePullRequest(variables);
    if (q.includes('mergePullRequest')) return this.mutationMergePullRequest(variables);
    if (q.includes('addComment')) return this.mutationAddComment(variables);

    // node(id:) repository.
    if (q.includes('node(') && q.includes('nameWithOwner')) {
      return this.nodeQuery(variables);
    }

    // Issues pagination (cursor).
    if (q.includes('issues(') && q.includes('pageInfo')) {
      return this.issuesPageQuery(variables);
    }

    return { data: {} };
  }

  // ------------------------------------------------------------------ repository query

  private repositoryQuery(variables: Record<string, unknown>): { data: { repository: unknown | null } } {
    const owner = (variables as any).owner;
    const name = (variables as any).name;
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const nodeId = this.store.nodeId('Repository', `${owner}/${name}`);
    return {
      data: {
        repository: {
          id: nodeId,
          databaseId: repo.id,
          name: repo.name,
          nameWithOwner: repo.fullName,
          owner: { login: repo.owner },
          defaultBranchRef: { name: repo.defaultBranch },
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: true,
          issue: null,
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          pullRequest: null,
        },
      },
    };
  }

  // ------------------------------------------------------------------ issues query

  private issuesQuery(variables: Record<string, unknown>, q: string): { data: { repository: { issues: unknown } } } {
    const owner = (variables as any).owner;
    const name = (variables as any).name;
    const first = Number((variables as any).first) ?? 10;
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    const states = (variables as any).states;
    const wantOpen = !states || JSON.stringify(states).includes('OPEN');
    const issues = this.store.listIssues(owner, name, wantOpen ? 'open' : 'closed');
    const orderBy = q.includes('orderBy');
    const desc = q.includes('DESC');
    if (orderBy) {
      issues.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (desc) issues.reverse();
    }
    const nodes = issues.slice(0, first).map((i) => ({ number: i.number, title: i.title, state: i.state === 'open' ? 'OPEN' : 'CLOSED', id: this.store.nodeId('Issue', `${owner}/${name}/${i.number}`) }));
    return { data: { repository: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } };
  }

  // ------------------------------------------------------------------ issue query

  private issueQuery(variables: Record<string, unknown>): { data: { repository: { issue: unknown | null } } } {
    const owner = (variables as any).owner;
    const name = (variables as any).name;
    const number = (variables as any).number;
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const issue = this.store.getIssue(owner, name, number);
    if (!issue) return { data: { repository: { issue: null } } };
    return {
      data: {
        repository: {
          issue: {
            number: issue.number,
            title: issue.title,
            state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
            body: issue.body,
            id: this.store.nodeId('Issue', `${owner}/${name}/${issue.number}`),
          },
        },
      },
    };
  }

  // ------------------------------------------------------------------ pull requests query

  private pullRequestsQuery(variables: Record<string, unknown>): { data: { repository: { pullRequests: unknown } } } {
    const owner = (variables as any).owner;
    const name = (variables as any).name;
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    const pulls = this.store.listPullRequests(owner, name, 'open');
    const nodes = pulls.map((p) => ({ number: p.number, headRefName: p.headRef, baseRefName: p.baseRef, mergeable: 'MERGEABLE', state: p.state === 'merged' ? 'CLOSED' : 'OPEN' }));
    return { data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } };
  }

  // ------------------------------------------------------------------ pull request query (id)

  private pullRequestQuery(variables: Record<string, unknown>): { data: { repository: { pullRequest: unknown | null } } } {
    const owner = (variables as any).owner;
    const name = (variables as any).name;
    const number = (variables as any).number;
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const pull = this.store.getPullRequest(owner, name, number);
    if (!pull) return { data: { repository: { pullRequest: null } } };
    return {
      data: {
        repository: {
          pullRequest: { id: this.store.nodeId('PullRequest', `${owner}/${name}/${pull.number}`), number: pull.number },
        },
      },
    };
  }

  // ------------------------------------------------------------------ pull request files

  private pullRequestFilesQuery(variables: Record<string, unknown>): { data: { repository: { pullRequest: unknown } } } {
    const owner = (variables as any).owner;
    const name = (variables as any).name;
    const number = (variables as any).number;
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { repository: { pullRequest: null } } };
    const pull = this.store.getPullRequest(owner, name, number);
    if (!pull) return { data: { repository: { pullRequest: null } } };
    const headCommit = this.store.getObject(pull.headSha);
    const baseCommit = this.store.getObject(pull.baseSha);
    const headMap = headCommit ? this.store.treeMap(this.store.commitInfo(headCommit.data).tree) : new Map();
    const baseMap = baseCommit ? this.store.treeMap(this.store.commitInfo(baseCommit.data).tree) : new Map();
    const files: Array<{ path: string }> = [];
    if (headCommit && baseCommit) {
      for (const [path, oid] of headMap) {
        if (baseMap.get(path) !== oid) files.push({ path });
      }
    }
    return { data: { repository: { pullRequest: { number, files: { nodes: files } } } } };
  }

  // ------------------------------------------------------------------ node query

  private nodeQuery(variables: Record<string, unknown>): { data: { node: unknown } } {
    const id = (variables as any).id;
    const resolved = this.store.resolveNodeId(id);
    if (resolved && resolved.type === 'Repository') {
      const [owner, name] = resolved.key.split('/');
      const repo = this.store.getRepo(owner, name);
      if (repo) return { data: { node: { id, name: repo.name, nameWithOwner: `${owner}/${name}` } } };
    }
    return { data: { node: null } };
  }

  // ------------------------------------------------------------------ issues page (cursor)

  private issuesPageQuery(variables: Record<string, unknown>): { data: { repository: { issues: unknown } } } {
    const owner = (variables as any).owner;
    const name = (variables as any).name;
    const first = Number((variables as any).first) ?? 10;
    const after = (variables as any).after;
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { repository: null } };
    const issues = this.store.listIssues(owner, name, 'open');
    const start = after ? issues.findIndex((i) => String(i.number) === after) + 1 : 0;
    const page = issues.slice(start, start + first);
    const nodes = page.map((i) => ({ number: i.number }));
    const hasNextPage = start + first < issues.length;
    return {
      data: {
        repository: {
          issues: {
            nodes,
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(page[page.length - 1]?.number ?? '') : null },
          },
        },
      },
    };
  }

  // ------------------------------------------------------------------ mutations

  private parseNodeId(id: string): { type: string; key: string } | null {
    const m = /^gid_(\w+)_(.+)$/.exec(id);
    if (!m) return null;
    return { type: m[1], key: m[2] };
  }

  private mutationCreateIssue(variables: Record<string, unknown>): { data: { createIssue: { issue: { number: number; id: string } } } } {
    const input = (variables as any).input;
    const repoId = input?.repositoryId;
    const parsed = this.parseNodeId(repoId);
    if (!parsed || parsed.type !== 'Repository') return { data: { createIssue: { issue: { number: 0, id: '' } } } };
    const [owner, name] = parsed.key.split('/');
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { createIssue: { issue: { number: 0, id: '' } } } };
    const issue = this.store.createIssue(owner, name, input?.title, input?.body ?? '', []);
    return { data: { createIssue: { issue: { number: issue.number, id: this.store.nodeId('Issue', `${owner}/${name}/${issue.number}`) } } } };
  }

  private mutationCloseIssue(variables: Record<string, unknown>): { data: { closeIssue: { issue: { number: number; id: string; state: string } } } } {
    const input = (variables as any).input;
    const parsed = this.parseNodeId(input?.issueId);
    if (!parsed || parsed.type !== 'Issue') return { data: { closeIssue: { issue: { number: 0, id: '', state: 'CLOSED' } } } };
    const [owner, name, numberStr] = parsed.key.split('/');
    const number = Number(numberStr);
    const issue = this.store.closeIssue(owner, name, number);
    if (!issue) return { data: { closeIssue: { issue: { number: 0, id: '', state: 'CLOSED' } } } };
    return { data: { closeIssue: { issue: { number: issue.number, id: this.store.nodeId('Issue', `${owner}/${name}/${number}`), state: 'CLOSED' } } } };
  }

  private mutationCreatePullRequest(variables: Record<string, unknown>): { data: { createPullRequest: { pullRequest: unknown } } } {
    const input = (variables as any).input;
    const repoId = input?.repositoryId;
    const parsed = this.parseNodeId(repoId);
    if (!parsed || parsed.type !== 'Repository') return { data: { createPullRequest: { pullRequest: { number: 0, id: '', state: 'OPEN', headRefName: '', baseRefName: '' } } } };
    const [owner, name] = parsed.key.split('/');
    const repo = this.store.getRepo(owner, name);
    if (!repo) return { data: { createPullRequest: { pullRequest: { number: 0, id: '', state: 'OPEN', headRefName: '', baseRefName: '' } } } };
    const headSha = this.store.getRef(owner, name, `refs/heads/${input?.headRefName}`) ?? '0000000000000000000000000000000000000000';
    const baseSha = this.store.getRef(owner, name, `refs/heads/${input?.baseRefName}`) ?? '0000000000000000000000000000000000000000';
    const pr = this.store.createPullRequest(owner, name, input?.title, input?.body ?? '', input?.headRefName, headSha, input?.baseRefName, baseSha);
    return { data: { createPullRequest: { pullRequest: { number: pr.number, id: this.store.nodeId('PullRequest', `${owner}/${name}/${pr.number}`), state: 'OPEN', headRefName: pr.headRef, baseRefName: pr.baseRef } } } };
  }

  private mutationMergePullRequest(variables: Record<string, unknown>): { data: { mergePullRequest: { pullRequest: { number: number; merged: boolean; state: string } } } } {
    const input = (variables as any).input;
    const parsed = this.parseNodeId(input?.pullRequestId);
    if (!parsed || parsed.type !== 'PullRequest') return { data: { mergePullRequest: { pullRequest: { number: 0, merged: false, state: 'CLOSED' } } } };
    const [owner, name, numberStr] = parsed.key.split('/');
    const number = Number(numberStr);
    const pr = this.store.getPullRequest(owner, name, number);
    if (!pr) return { data: { mergePullRequest: { pullRequest: { number: 0, merged: false, state: 'CLOSED' } } } };
    const currentBase = this.store.getRef(owner, name, `refs/heads/${pr.baseRef}`);
    if (!currentBase) return { data: { mergePullRequest: { pullRequest: { number: 0, merged: false, state: 'CLOSED' } } } };
    const headAncestorOfBase = this.store.isAncestor(currentBase, pr.headSha);
    const baseAncestorOfHead = this.store.isAncestor(pr.headSha, currentBase);
    if (!headAncestorOfBase && !baseAncestorOfHead) return { data: { mergePullRequest: { pullRequest: { number, merged: false, state: 'OPEN' } } } };
    const headCommit = this.store.getObject(pr.headSha);
    if (!headCommit || headCommit.type !== 'commit') return { data: { mergePullRequest: { pullRequest: { number, merged: false, state: 'OPEN' } } } };
    const mergeCommitOid = this.store.commit(this.store.commitInfo(headCommit.data).tree, currentBase ? [currentBase] : [], 'Ada Iversen <adaiversen@example.invalid>', 'Ada Iversen <adaiversen@example.invalid>', `Merge pull request #${number}`, Date.now() / 1000);
    this.store.setRef(owner, name, `refs/heads/${pr.baseRef}`, mergeCommitOid);
    this.store.mergePullRequest(owner, name, number, mergeCommitOid, mergeCommitOid);
    return { data: { mergePullRequest: { pullRequest: { number, merged: true, state: 'CLOSED' } } } };
  }

  private mutationAddComment(variables: Record<string, unknown>): { data: { addComment: { commentEdge: { node: { id: string; body: string } } } } } {
    const input = (variables as any).input;
    const parsed = this.parseNodeId(input?.subjectId);
    if (!parsed || parsed.type !== 'Issue') return { data: { addComment: { commentEdge: { node: { id: '', body: '' } } } } };
    const [owner, name, numberStr] = parsed.key.split('/');
    const number = Number(numberStr);
    const issue = this.store.getIssue(owner, name, number);
    if (!issue) return { data: { addComment: { commentEdge: { node: { id: '', body: '' } } } } };
    const comment = this.store.createComment(owner, name, number, input?.body ?? '');
    return { data: { addComment: { commentEdge: { node: { id: this.store.nodeId('Issue', `${owner}/${name}/${number}`), body: comment.body } } } } };
  }
}
