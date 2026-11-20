// Model Context Protocol streamable-HTTP endpoint at /mcp.
// Supports the modern 2026-07-28 era (server/discover) and falls back to
// initialize/legacy. Six required tools: create_repo, get_repo, create_issue,
// list_issues, create_pull_request, merge_pull_request.

import type { ServerResponse } from 'node:http';
import type { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const MCP_PREFERRED_REVISION = '2026-07-28';

export class McpService {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extra });
    res.end(text);
  }

  rpcError(code: number, message: string, id: unknown): { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } } {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  rpcResult(id: unknown, result: unknown): { jsonrpc: '2.0'; id: unknown; result: unknown } {
    return { jsonrpc: '2.0', id, result };
  }

  // ------------------------------------------------------------------ routing

  handle(req: { method: string; url: string; headers: { get(name: string): string | null }; body?: string }, res: ServerResponse): boolean {
    const url = new URL(req.url, 'http://entry');
    if (url.pathname !== '/mcp') return false;

    if (req.method === 'DELETE') {
      // Session close (legacy) - best effort, 200
      res.writeHead(200, { 'content-length': '0' });
      res.end();
      return true;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-length': '0' });
      res.end();
      return true;
    }

    // Auth: require bearer token
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      this.send(res, 401, { message: 'Requires authentication' });
      return true;
    }

    // Non-JSON body -> HTTP 400 with JSON-RPC -32700
    const rawBody = req.body ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return true;
    }

    const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).id : null;
    const method = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? String((parsed as Record<string, unknown>).method ?? '') : '';
    const params = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).params ?? {} : {};

    // Detect era: modern requests declare revision in _meta or mcp-protocol-version header.
    const protoVersion = req.headers['mcp-protocol-version'] ?? (params && typeof params === 'object' && '_meta' in params && typeof (params as Record<string, unknown>)._meta === 'object' ? String(((params as Record<string, unknown>)._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] ?? MCP_PREFERRED_REVISION) : MCP_PREFERRED_REVISION);

    // server/discover
    if (method === 'server/discover') {
      const supportedVersions = [MCP_PREFERRED_REVISION];
      const result = {
        protocolVersion: MCP_PREFERRED_REVISION,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
        supportedVersions,
      };
      this.send(res, 200, this.rpcResult(id, result));
      return true;
    }

    // initialize (legacy handshake)
    if (method === 'initialize') {
      const revision = protoVersion === MCP_PREFERRED_REVISION ? MCP_PREFERRED_REVISION : '2025-11-25';
      const result = {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      };
      this.send(res, 200, this.rpcResult(id, result));
      return true;
    }

    // notifications/initialized (legacy) - no content needed
    if (method === 'notifications/initialized') {
      res.writeHead(204, { 'content-length': '0' });
      res.end();
      return true;
    }

    // tools/list
    if (method === 'tools/list') {
      const tools = [
        { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
        { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
        { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
        { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
        { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
        { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
      ];
      this.send(res, 200, this.rpcResult(id, { tools }));
      return true;
    }

    // tools/call
    if (method === 'tools/call') {
      const toolName = typeof params === 'object' && params !== null ? String((params as Record<string, unknown>).name ?? '') : '';
      const args = typeof params === 'object' && params !== null && (params as Record<string, unknown>).arguments ? (params as Record<string, unknown>).arguments as Record<string, unknown> : {};

      const result = this.dispatchTool(toolName, args);
      if (result instanceof Error) {
        if (result.message.startsWith('Unknown tool')) {
          this.send(res, 200, this.rpcError(-32601, result.message, id));
          return true;
        }
        this.send(res, 200, this.rpcResult(id, { isError: true, content: [{ type: 'text', text: result.message }] }));
        return true;
      }
      this.send(res, 200, this.rpcResult(id, result));
      return true;
    }

    // Unknown method
    this.send(res, 200, this.rpcError(-32601, `Method not found: ${method}`, id));
    return true;
  }

  // ------------------------------------------------------------------ tool dispatch

  private dispatchTool(name: string, args: Record<string, unknown>): { structuredContent?: unknown; content?: Array<{ type: string; text: string }> } | Error {
    const viewerLogin = 'adaiversen';

    switch (name) {
      case 'create_repo': {
        const repoName = typeof args.name === 'string' ? args.name : undefined;
        if (!repoName) return new Error('missing name');
        const description = typeof args.description === 'string' ? args.description : '';
        const private_ = typeof args.private === 'boolean' ? args.private : true;
        try {
          const repo = this.store.createRepo(viewerLogin, repoName, description, private_);
          return {
            structuredContent: { id: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch },
            content: [{ type: 'text', text: JSON.stringify({ id: repo.id, name: repo.name, full_name: repo.fullName }) }],
          };
        } catch {
          return new Error(`repository ${repoName} already exists`);
        }
      }
      case 'get_repo': {
        const owner = typeof args.owner === 'string' ? args.owner : viewerLogin;
        const repoName = typeof args.repo === 'string' ? args.repo : (typeof args.full_name === 'string' ? args.full_name.split('/')[1] : undefined);
        if (!repoName) return new Error('missing repo');
        const repo = this.store.getRepo(owner, repoName);
        if (!repo) return new Error('not found');
        return { structuredContent: { id: repo.id, name: repo.name, full_name: repo.fullName } };
      }
      case 'create_issue': {
        const owner = typeof args.owner === 'string' ? args.owner : viewerLogin;
        const repoName = typeof args.repo === 'string' ? args.repo : undefined;
        const title = typeof args.title === 'string' ? args.title : undefined;
        const body = typeof args.body === 'string' ? args.body : '';
        if (!repoName || !title) return new Error('missing required arguments');
        const repo = this.store.getRepo(owner, repoName);
        if (!repo) return new Error('repository not found');
        const issue = this.store.createIssue(owner, repoName, title, body, []);
        return { structuredContent: { number: issue.number, id: this.store.nodeId('Issue', `${owner}/${repoName}/${issue.number}`) }, content: [{ type: 'text', text: JSON.stringify({ number: issue.number }) }] };
      }
      case 'list_issues': {
        const owner = typeof args.owner === 'string' ? args.owner : viewerLogin;
        const repoName = typeof args.repo === 'string' ? args.repo : undefined;
        if (!repoName) return new Error('missing repo');
        const repo = this.store.getRepo(owner, repoName);
        if (!repo) return new Error('repository not found');
        const issues = this.store.listIssues(owner, repoName);
        const text = JSON.stringify({ issues: issues.map((i) => ({ number: i.number, title: i.title, state: i.state })) });
        return { content: [{ type: 'text', text }] };
      }
      case 'create_pull_request': {
        const owner = typeof args.owner === 'string' ? args.owner : viewerLogin;
        const repoName = typeof args.repo === 'string' ? args.repo : undefined;
        const title = typeof args.title === 'string' ? args.title : undefined;
        const head = typeof args.head === 'string' ? args.head : undefined;
        const base = typeof args.base === 'string' ? args.base : 'main';
        if (!repoName || !title || !head) return new Error('missing required arguments');
        const repo = this.store.getRepo(owner, repoName);
        if (!repo) return new Error('repository not found');
        const headSha = this.store.getRef(owner, repoName, `refs/heads/${head}`) ?? '0000000000000000000000000000000000000000';
        const baseSha = this.store.getRef(owner, repoName, `refs/heads/${base}`) ?? '0000000000000000000000000000000000000000';
        const pr = this.store.createPullRequest(owner, repoName, title, '', head, headSha, base, baseSha);
        return { structuredContent: { number: pr.number, id: this.store.nodeId('PullRequest', `${owner}/${repoName}/${pr.number}`) }, content: [{ type: 'text', text: JSON.stringify({ number: pr.number }) }] };
      }
      case 'merge_pull_request': {
        const owner = typeof args.owner === 'string' ? args.owner : viewerLogin;
        const repoName = typeof args.repo === 'string' ? args.repo : undefined;
        const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        if (!repoName || !pullNumber) return new Error('missing required arguments');
        const pr = this.store.getPullRequest(owner, repoName, pullNumber);
        if (!pr) return new Error('pull request not found');
        const mergeSha = '0000000000000000000000000000000000000000';
        this.store.mergePullRequest(owner, repoName, pullNumber, mergeSha, mergeSha);
        return { structuredContent: { merged: true }, content: [{ type: 'text', text: JSON.stringify({ merged: true }) }] };
      }
      default:
        return new Error(`Unknown tool: ${name}`);
    }
  }
}
