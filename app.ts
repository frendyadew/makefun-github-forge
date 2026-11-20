// The forge server: healthz, git smart HTTP, REST v3, GraphQL v4, MCP.
// Binds nothing; main.ts listens on the ephemeral port.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { GitService, writePack, FLUSH, encodePktLine } from './git.ts';
import { RestService } from './rest.ts';
import { GraphQLService } from './graphql.ts';
import { McpService } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  const git = new GitService(store);
  const rest = new RestService(store);
  const graphql = new GraphQLService(store);
  const mcp = new McpService(store);

  // Pre-seed the scenario viewer user so GraphQL/MCP resolve a login.
  store.createUser(1000, 'adaiversen', 'Ada Iversen', 'adaiversen@example.invalid');

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // Boot probe: 200 {"ok":true}, twice within budget.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs?service=...
    const mGit = path.match(/^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)(?:\?.*|$)/);
    if (mGit) {
      const owner = mGit[1];
      const repo = mGit[2];
      const tail = mGit[3];
      console.error(`[git] ${method} ${path}`);

      if (tail === 'info/refs') {
        const service = new URL(req.url, 'http://entry').searchParams.get('service') ?? 'git-upload-pack';
        if (method !== 'GET') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        if (!store.repoExists(owner, repo)) {
          res.writeHead(404, { 'content-type': 'text/plain', 'content-length': '0' });
          res.end();
          return;
        }
        const gitProto = req.headers['git-protocol'];
        const isV2 = typeof gitProto === 'string' && gitProto.includes('version=2');
        if (service === 'git-upload-pack' && isV2) {
          const adv = git.advertiseV2(owner, repo);
          const lines: Buffer[] = [encodePktLine('version 2\n')];
          for (const [cap, val] of adv.capabilities) lines.push(encodePktLine(`${cap}${val ? '=' + val : ''}\n`));
          lines.push(FLUSH);
          const body = Buffer.concat(lines);
          console.error(`[git-v2] body=${body.toString('latin1')}`);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
          res.end(body);
          return;
        }
        const body = git.advertiseV0(owner, repo, service as 'git-upload-pack' | 'git-receive-pack');
        const ct = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
        res.writeHead(200, { 'content-type': ct, 'content-length': body.length });
        res.end(body);
        return;
      }

      if (tail === 'git-upload-pack' || tail === 'git-receive-pack') {
        if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
        if (!store.repoExists(owner, repo)) {
          res.writeHead(404, { 'content-type': 'text/plain', 'content-length': '0' });
          res.end();
          return;
        }
        const body = await readBody(req);
        if (tail === 'git-upload-pack') {
          // v2 fetch if the first packet is 'command=fetch\n', else v0
          const text = body.toString('utf8');
          if (text.includes('command=ls-refs')) {
            const result = git.handleLsRefs(owner, repo, body);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': result.body.length });
            res.end(result.body);
            return;
          }
          if (text.startsWith('command=fetch\n') || text.includes('command=fetch')) {
            const result = git.handleV2Fetch(owner, repo, body);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': result.body.length });
            res.end(result.body);
            return;
          }
          const result = git.handleV0Fetch(owner, repo, body);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': result.body.length });
          res.end(result.body);
          return;
        }
        // receive-pack
        const result = git.handleReceivePack(owner, repo, body);
        res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': result.body.length });
        res.end(result.body);
        return;
      }
    }

    // GraphQL
    if (path === '/api/graphql') {
      const body = await readBody(req);
      const auth = req.headers.authorization;
      const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
      graphql.handle({ method, url: req.url ?? '/', body: body.toString('utf8') }, res, token);
      return;
    }

    // MCP
    if (path === '/mcp') {
      const body = await readBody(req);
      mcp.handle({ method, url: req.url ?? '/', headers: req.headers, body: body.toString('utf8') }, res);
      return;
    }

    // REST v3 - needs body for POST/PUT/PATCH/DELETE-with-body
    if (path.startsWith('/api/v3')) {
      let bodyStr = '';
      if (method !== 'GET' && method !== 'HEAD') {
        const b = await readBody(req);
        bodyStr = b.toString('utf8');
      }
      // Attach body to req for RestService handlers that need it.
      (req as any)._body = bodyStr;

      // A non-empty body that isn't valid JSON is a 400 (malformed-body check).
      if (bodyStr.trim() !== '') {
        try {
          JSON.parse(bodyStr);
        } catch {
          sendJson(res, 400, { message: 'Malformed JSON' });
          return;
        }
      }

      const origin = req.headers.host ? `http://${req.headers.host}` : 'http://entry';
      const handled = rest.handle({ method, url: req.url ?? '/', _body: bodyStr, headers: req.headers, origin }, res);
      if (handled === false) sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // Unknown route -> JSON 404
    sendJson(res, 404, { message: 'Not Found' });
  });
}
