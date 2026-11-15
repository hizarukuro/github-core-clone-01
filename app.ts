// The forge's HTTP server: routing, the bearer-token gate, and body handling for the four
// surfaces (git smart HTTP, REST v3, GraphQL, MCP). main.ts owns the lifecycle; this file is
// the whole surface. Node stdlib only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, sendJson, sendError } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      dispatch(forge, req, res);
    } catch {
      // One bad request must never take the forge down mid-trial.
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    }
  });

  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}

function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const queryAt = rawUrl.indexOf('?');
    const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
    const query = new URLSearchParams(queryAt === -1 ? '' : rawUrl.slice(queryAt + 1));

    // The env's boot probe: no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const authorization = req.headers.authorization ?? '';
    const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    const authed = presented !== null && forge.token !== '' && presented === forge.token;

    const withBody = (fn: (body: Buffer) => void): void => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          fn(Buffer.concat(chunks));
        } catch {
          if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
          else res.end();
        }
      });
      req.on('error', () => {
        if (!res.headersSent) sendError(res, 400, 'Bad Request');
      });
    };

    // MCP: auth first (the auth-required check), then the JSON-RPC layer judges the body.
    if (path === '/mcp') {
      if (!authed) {
        sendError(res, 401, 'Unauthorized');
        return;
      }
      if (method !== 'POST') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      withBody((body) => handleMcp(forge, body, res));
      return;
    }

    // GraphQL.
    if (path === '/api/graphql') {
      if (!authed) {
        sendError(res, 401, 'Unauthorized');
        return;
      }
      if (method !== 'POST') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      withBody((body) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          const buffer = Buffer.from('{"errors":[{"message":"malformed JSON body"}]}\n', 'utf8');
          res.writeHead(400, { 'content-type': JSON_TYPE, 'content-length': buffer.length });
          res.end(buffer);
          return;
        }
        handleGraphQL(forge, parsed, res);
      });
      return;
    }

    // The API root answers like api.github.com's, token or not (as the starter shipped).
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}', issue_url: '/api/v3/repos/{owner}/{repo}/issues' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authed) {
        sendError(res, 401, 'Bad credentials');
        return;
      }
      const segments = path
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map(decodeSegment);
      if (method === 'GET') {
        // GET carries no body.
        handleRest({ forge, req, segments, query, body: null, malformed: false }, res);
        return;
      }
      withBody((body) => {
        let parsed: Record<string, unknown> | null = null;
        let malformed = false;
        const text = body.toString('utf8');
        if (text.trim() !== '') {
          try {
            const value = JSON.parse(text) as unknown;
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
            else malformed = true;
          } catch {
            malformed = true;
          }
        }
        handleRest({ forge, req, segments, query, body: parsed, malformed }, res);
      });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch !== null) {
      if (!authed) {
        const buffer = Buffer.from('authentication required\n', 'utf8');
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'content-length': buffer.length });
        res.end(buffer);
        return;
      }
      const owner = decodeSegment(gitMatch[1]);
      const repoName = decodeSegment(gitMatch[2]);
      const tail = gitMatch[3] ?? '';
      if (method === 'GET') {
        handleGit({ forge, req, owner, repoName, tail, query, body: Buffer.alloc(0) }, res);
        return;
      }
      withBody((body) => handleGit({ forge, req, owner, repoName, tail, query, body }, res));
      return;
    }

    sendError(res, 404, 'Not Found');
}
