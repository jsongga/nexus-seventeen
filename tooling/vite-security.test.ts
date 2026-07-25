import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  isLoopbackRemoteAddress,
  isTrustedBoardProxyRequest,
  prepareBoardProxyRequest,
} from './vite-security';

function sourceRequest(options: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
} = {}): IncomingMessage {
  return {
    headers: {
      host: options.host ?? '127.0.0.1:4173',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

describe('development board proxy security', () => {
  it.each(['127.0.0.1', '127.23.45.67', '::1', '::ffff:127.0.0.1'])(
    'recognizes loopback client address %s',
    (address) => {
      expect(isLoopbackRemoteAddress(address)).toBe(true);
    },
  );

  it.each([undefined, '10.0.0.8', '192.168.1.4', '::ffff:192.168.1.4', '2001:db8::1'])(
    'rejects non-loopback client address %s',
    (address) => {
      expect(isLoopbackRemoteAddress(address)).toBe(false);
    },
  );

  it('accepts a same-origin request received on loopback', () => {
    expect(isTrustedBoardProxyRequest(sourceRequest({
      host: 'localhost:4173',
      origin: 'http://localhost:4173',
    }))).toBe(true);
  });

  it.each([
    sourceRequest({ remoteAddress: '100.72.64.97' }),
    sourceRequest({ host: '100.72.64.97:4173' }),
    sourceRequest({ origin: 'https://attacker.example' }),
    sourceRequest({ host: 'localhost.example:4173' }),
  ])('rejects remote, non-loopback-host, and cross-origin requests', (request) => {
    expect(isTrustedBoardProxyRequest(request)).toBe(false);
  });

  it('adds the configured human token only to a trusted request', () => {
    const trustedProxyRequest = {
      removeHeader: vi.fn(),
      setHeader: vi.fn(),
    };
    prepareBoardProxyRequest(trustedProxyRequest, sourceRequest(), 'private-human-token');
    expect(trustedProxyRequest.removeHeader).toHaveBeenCalledWith('origin');
    expect(trustedProxyRequest.setHeader).toHaveBeenCalledWith(
      'authorization',
      'Bearer private-human-token',
    );

    const remoteProxyRequest = {
      removeHeader: vi.fn(),
      setHeader: vi.fn(),
    };
    prepareBoardProxyRequest(
      remoteProxyRequest,
      sourceRequest({ remoteAddress: '100.72.64.97' }),
      'private-human-token',
    );
    expect(remoteProxyRequest.removeHeader).toHaveBeenCalledWith('authorization');
    expect(remoteProxyRequest.setHeader).not.toHaveBeenCalled();
  });

  it('does not synthesize an authorization header when no human token is configured', () => {
    const proxyRequest = {
      removeHeader: vi.fn(),
      setHeader: vi.fn(),
    };
    prepareBoardProxyRequest(proxyRequest, sourceRequest(), undefined);
    expect(proxyRequest.removeHeader).toHaveBeenCalledWith('origin');
    expect(proxyRequest.removeHeader).not.toHaveBeenCalledWith('authorization');
    expect(proxyRequest.setHeader).not.toHaveBeenCalled();
  });
});
