import { isIP } from 'node:net';
import type { Connect, Plugin, ProxyOptions } from 'vite';

interface BoardProxySourceRequest {
  readonly headers: {
    readonly host?: string;
    readonly origin?: string | readonly string[];
  };
  readonly socket: {
    readonly remoteAddress?: string;
  };
}

interface ProxyHeaderRequest {
  removeHeader(name: string): void;
  setHeader(name: string, value: string): void;
}

function isLoopbackIpAddress(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === '::1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  return value !== undefined && isLoopbackIpAddress(value);
}

function loopbackRequestOrigin(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.host !== host.toLowerCase()
  ) {
    return undefined;
  }
  const hostname = parsed.hostname === '[::1]' ? '::1' : parsed.hostname;
  if (hostname !== 'localhost' && !isLoopbackIpAddress(hostname)) return undefined;
  return parsed.origin;
}

export function isTrustedBoardProxyRequest(request: BoardProxySourceRequest): boolean {
  if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) return false;
  const requestOrigin = loopbackRequestOrigin(request.headers.host);
  if (requestOrigin === undefined) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  return (
    parsedOrigin.username === '' &&
    parsedOrigin.password === '' &&
    parsedOrigin.pathname === '/' &&
    parsedOrigin.search === '' &&
    parsedOrigin.hash === '' &&
    parsedOrigin.origin === requestOrigin
  );
}

export function prepareBoardProxyRequest(
  proxyRequest: ProxyHeaderRequest,
  sourceRequest: BoardProxySourceRequest,
  humanToken: string | undefined,
): void {
  if (!isTrustedBoardProxyRequest(sourceRequest)) {
    proxyRequest.removeHeader('authorization');
    return;
  }
  proxyRequest.removeHeader('origin');
  if (humanToken !== undefined && humanToken.length > 0) {
    proxyRequest.setHeader('authorization', `Bearer ${humanToken}`);
  }
}

const requireTrustedBoardProxyClient: Connect.NextHandleFunction = (request, response, next) => {
  if (isTrustedBoardProxyRequest(request)) {
    next();
    return;
  }
  const body = JSON.stringify({
    error: {
      code: 'LOOPBACK_CLIENT_REQUIRED',
      message: 'The development board proxy is available only to a same-origin client on this machine',
    },
  });
  response.statusCode = 403;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
};

export function boardProxySecurityPlugin(): Plugin {
  const register = (middlewares: Connect.Server): void => {
    middlewares.use('/board-api', requireTrustedBoardProxyClient);
  };
  return {
    name: 'steward-board-proxy-security',
    configureServer(server) {
      register(server.middlewares);
    },
    configurePreviewServer(server) {
      register(server.middlewares);
    },
  };
}

export function createBoardProxy(humanToken: string | undefined): ProxyOptions {
  return {
    target: 'http://127.0.0.1:4318',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/board-api/, ''),
    configure(proxy) {
      proxy.on('proxyReq', (request, sourceRequest) => {
        prepareBoardProxyRequest(request, sourceRequest, humanToken);
      });
    },
  };
}
