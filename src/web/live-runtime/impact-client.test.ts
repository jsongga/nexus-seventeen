import { describe, expect, it, vi } from 'vitest';
import {
  ImpactSummaryProtocolError,
  createHttpImpactSummaryGateway,
  parseImpactSnapshot,
} from './impact-client';

function validSnapshot() {
  return {
    apiVersion: 'steward.impact/v1',
    workspaceId: 'workspace-alpha',
    generatedAt: '2026-07-18T20:10:00.000Z',
    sourceSequence: 8,
    summaries: [{
      taskId: 'task-checkout',
      status: 'running',
      summary: 'Customers can retry checkout without creating a duplicate order.',
      updatedAt: '2026-07-18T20:09:00.000Z',
      sourceSequence: 7,
    }],
  };
}

describe('impact summary protocol boundary', () => {
  it('accepts and freezes a bounded snapshot for the expected workspace', () => {
    const snapshot = parseImpactSnapshot(validSnapshot(), 'workspace-alpha');
    expect(snapshot.summaries[0]?.summary).toContain('Customers');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.summaries)).toBe(true);
    expect(Object.isFrozen(snapshot.summaries[0])).toBe(true);
  });

  it('rejects workspace confusion, duplicate tasks, unknown fields, and impossible cursors', () => {
    expect(() => parseImpactSnapshot(validSnapshot(), 'workspace-other')).toThrow(/another workspace/u);
    expect(() => parseImpactSnapshot({
      ...validSnapshot(),
      summaries: [validSnapshot().summaries[0], validSnapshot().summaries[0]],
    }, 'workspace-alpha')).toThrow(/duplicate taskId/u);
    expect(() => parseImpactSnapshot({ ...validSnapshot(), secret: 'leak' }, 'workspace-alpha'))
      .toThrow(/unexpected fields/u);
    expect(() => parseImpactSnapshot({
      ...validSnapshot(),
      summaries: [{ ...validSnapshot().summaries[0], sourceSequence: 9 }],
    }, 'workspace-alpha')).toThrow(/newer than/u);
  });

  it('rejects oversized and control-character summary text', () => {
    expect(() => parseImpactSnapshot({
      ...validSnapshot(),
      summaries: [{ ...validSnapshot().summaries[0], summary: 'x'.repeat(4_001) }],
    }, 'workspace-alpha')).toThrow(ImpactSummaryProtocolError);
    expect(() => parseImpactSnapshot({
      ...validSnapshot(),
      summaries: [{ ...validSnapshot().summaries[0], summary: 'customer\nsecret' }],
    }, 'workspace-alpha')).toThrow(ImpactSummaryProtocolError);
  });
});

describe('impact summary HTTP gateway', () => {
  it('requires HTTPS for bearer credentials except on loopback', () => {
    expect(() => createHttpImpactSummaryGateway({
      origin: 'http://impact.example.test',
      workspaceId: 'workspace-alpha',
      outputToken: 'separate-read-token-0001',
    })).toThrow(/require HTTPS/u);
    expect(() => createHttpImpactSummaryGateway({
      origin: 'http://localhost:4400',
      workspaceId: 'workspace-alpha',
      outputToken: 'separate-read-token-0001',
    })).not.toThrow();
  });

  it('uses a separate in-memory bearer with no credentials, redirects, or referrer', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(validSnapshot()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const gateway = createHttpImpactSummaryGateway({
      origin: 'https://impact.example.test',
      workspaceId: 'workspace-alpha',
      outputToken: 'separate-read-token-0001',
      fetch: request as unknown as typeof fetch,
    });

    await expect(gateway.fetchSnapshot()).resolves.toMatchObject({ sourceSequence: 8 });
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://impact.example.test/v1/impact-summaries?workspaceId=workspace-alpha',
    );
    expect(init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer separate-read-token-0001');
  });

  it('rejects credential-bearing origins and bounds declared and streamed responses', async () => {
    expect(() => createHttpImpactSummaryGateway({
      origin: 'https://token@impact.example.test',
      workspaceId: 'workspace-alpha',
      outputToken: 'separate-read-token-0001',
    })).toThrow(/without credentials/u);

    const declared = createHttpImpactSummaryGateway({
      origin: 'https://impact.example.test',
      workspaceId: 'workspace-alpha',
      outputToken: 'separate-read-token-0001',
      fetch: vi.fn(async () => new Response('{}', {
        headers: { 'Content-Length': String(256 * 1024 + 1) },
      })) as unknown as typeof fetch,
    });
    await expect(declared.fetchSnapshot()).rejects.toThrow(/maximum size/u);

    const streamed = createHttpImpactSummaryGateway({
      origin: 'https://impact.example.test',
      workspaceId: 'workspace-alpha',
      outputToken: 'separate-read-token-0001',
      fetch: vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1))) as unknown as typeof fetch,
    });
    await expect(streamed.fetchSnapshot()).rejects.toThrow(/maximum size/u);
  });

  it('retains authentication as a transport failure without reading an error body', async () => {
    const gateway = createHttpImpactSummaryGateway({
      origin: 'https://impact.example.test',
      workspaceId: 'workspace-alpha',
      outputToken: 'wrong-read-token-0001',
      fetch: vi.fn(async () => new Response('credential detail must not surface', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(gateway.fetchSnapshot()).rejects.toMatchObject({
      name: 'ImpactSummaryTransportError',
      status: 401,
      message: 'Impact-observer authentication failed.',
    });
  });
});
