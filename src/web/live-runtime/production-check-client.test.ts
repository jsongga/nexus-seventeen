import { describe, expect, it, vi } from 'vitest';
import {
  ProductionCheckProtocolError,
  createHttpProductionCheckGateway,
  parseProductionCheckResponse,
} from './production-check-client';

const EVIDENCE_ID = '22222222-2222-4222-8222-222222222222';
const REVIEW_ID = '33333333-3333-4333-8333-333333333333';
const HANDOFF_ID = '44444444-4444-4444-8444-444444444444';

function validCheck() {
  return {
    apiVersion: 1,
    productionCheckId: `production-check:${REVIEW_ID}`,
    status: 'pending_human_review',
    workspaceId: 'workspace-alpha',
    taskId: 'task-checkout',
    reviewTaskId: 'task-review-checkout',
    evidenceId: EVIDENCE_ID,
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    completionEventId: 'completion-checkout-001',
    checkpointRef: 'checkpoint-checkout-001',
    engineerAgentId: 'engineer-patch',
    managerAgentId: 'manager-moss',
    managerRuntimeInstanceId: 'manager-runtime-moss-001',
    managerRuntimeEpoch: 3,
    managerReviewId: REVIEW_ID,
    permitId: 'permit_55555555-5555-4555-8555-555555555555',
    permitWorkspaceSequence: 27,
    resultOverview: 'Customers can retry checkout without a duplicate charge.',
    reviewSummary: 'Passing evidence covers interruption and duplicate-submit behavior.',
    remainingRisks: 'A human should verify the staged rollback before production.',
    testEvidenceDigest: `sha256:${'b'.repeat(64)}`,
    releaseArtifactDigest: `sha256:${'c'.repeat(64)}`,
    releaseManifestDigest: `sha256:${'d'.repeat(64)}`,
    targetEnvironment: 'production-us',
    completedAt: '2026-07-19T19:00:00.000Z',
    reviewedAt: '2026-07-19T19:04:00.000Z',
    handoffId: HANDOFF_ID,
    handoffRegisteredAt: '2026-07-19T19:05:00.000Z',
  };
}

describe('production-check protocol boundary', () => {
  it('accepts and deeply freezes exact lifecycle-bound checks', () => {
    const checks = parseProductionCheckResponse({ items: [validCheck()] }, 'workspace-alpha');

    expect(checks[0]?.resultOverview).toContain('Customers');
    expect(checks[0]).toMatchObject({
      reviewTaskId: 'task-review-checkout',
      permitWorkspaceSequence: 27,
    });
    expect(Object.isFrozen(checks)).toBe(true);
    expect(Object.isFrozen(checks[0])).toBe(true);
  });

  it('rejects workspace confusion, unknown fields, duplicate identities, and invalid bindings', () => {
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      workspaceId: 'workspace-other',
    }] }, 'workspace-alpha')).toThrow(/another workspace/u);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      deployNow: true,
    }] }, 'workspace-alpha')).toThrow(/unexpected or missing fields/u);
    expect(() => parseProductionCheckResponse({ items: [validCheck(), validCheck()] }, 'workspace-alpha'))
      .toThrow(/duplicate identity/u);
    expect(() => parseProductionCheckResponse({ items: [
      validCheck(),
      {
        ...validCheck(),
        productionCheckId: 'production-check:66666666-6666-4666-8666-666666666666',
        managerReviewId: '66666666-6666-4666-8666-666666666666',
        reviewTaskId: 'task-review-checkout-two',
        evidenceId: '77777777-7777-4777-8777-777777777777',
        permitId: 'permit_88888888-8888-4888-8888-888888888888',
      },
    ] }, 'workspace-alpha')).toThrow(/duplicate identity/u);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      productionCheckId: 'production-check:44444444-4444-4444-8444-444444444444',
    }] }, 'workspace-alpha')).toThrow(/does not match/u);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      status: 'handoff_registration_pending',
    }] }, 'workspace-alpha')).toThrow(/pending handoff/u);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      reviewTaskId: 'task-checkout',
    }] }, 'workspace-alpha')).toThrow(/must differ/u);
  });

  it('rejects noncanonical times, oversized text, and impossible lifecycle order', () => {
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      completedAt: '2026-07-19T19:00:00Z',
    }] }, 'workspace-alpha')).toThrow(/canonical ISO/u);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      resultOverview: 'x'.repeat(2_001),
    }] }, 'workspace-alpha')).toThrow(ProductionCheckProtocolError);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      reviewedAt: '2026-07-19T18:59:00.000Z',
    }] }, 'workspace-alpha')).toThrow(/predate task completion/u);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      managerRuntimeEpoch: 0,
    }] }, 'workspace-alpha')).toThrow(/positive safe integer/u);
    expect(() => parseProductionCheckResponse({ items: [{
      ...validCheck(),
      permitWorkspaceSequence: 0,
    }] }, 'workspace-alpha')).toThrow(/positive safe integer/u);
  });
});

describe('production-check HTTP gateway', () => {
  it('requires HTTPS except on exact loopback and rejects credential-bearing origins', () => {
    expect(() => createHttpProductionCheckGateway({
      origin: 'http://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
    })).toThrow(/require HTTPS/u);
    expect(() => createHttpProductionCheckGateway({
      origin: 'http://localhost:4402',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
    })).not.toThrow();
    expect(() => createHttpProductionCheckGateway({
      origin: 'https://token@review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
    })).toThrow(/without credentials/u);
    expect(() => createHttpProductionCheckGateway({
      origin: 'https://review.example.test/manager-review',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
    })).toThrow(/exact HTTP\(S\) origin/u);
    expect(() => createHttpProductionCheckGateway({
      origin: 'https://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'short',
    })).toThrow(/read token is invalid/u);
  });

  it('performs only a hardened GET with its dedicated bearer and supports abort', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ items: [validCheck()] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
    const gateway = createHttpProductionCheckGateway({
      origin: 'https://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
      fetch: request as unknown as typeof fetch,
    });

    await expect(gateway.fetchChecks()).resolves.toHaveLength(1);
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://review.example.test/v1/production-checks?workspaceId=workspace-alpha',
    );
    expect(init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect((init.headers as Record<string, string>).Authorization)
      .toBe('Bearer dedicated-production-read-token');

    const controller = new AbortController();
    controller.abort();
    const aborted = createHttpProductionCheckGateway({
      origin: 'https://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
      fetch: vi.fn(async (_input, options) => {
        options?.signal?.throwIfAborted();
        return new Response();
      }) as unknown as typeof fetch,
    });
    await expect(aborted.fetchChecks(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds a hung request and reports its deadline', async () => {
    const hangingFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    const gateway = createHttpProductionCheckGateway({
      origin: 'https://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
      timeoutMs: 100,
      fetch: hangingFetch as unknown as typeof fetch,
    });

    await expect(gateway.fetchChecks()).rejects.toMatchObject({
      name: 'ProductionCheckTransportError',
      status: 0,
      message: 'The production-check request timed out.',
    });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds declared and streamed JSON responses without surfacing authentication bodies', async () => {
    const declared = createHttpProductionCheckGateway({
      origin: 'https://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
      fetch: vi.fn(async () => new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(8 * 1024 * 1024 + 1),
        },
      })) as unknown as typeof fetch,
    });
    await expect(declared.fetchChecks()).rejects.toThrow(/maximum size/u);

    const streamed = createHttpProductionCheckGateway({
      origin: 'https://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'dedicated-production-read-token',
      fetch: vi.fn(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), {
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
    });
    await expect(streamed.fetchChecks()).rejects.toThrow(/maximum size/u);

    const unauthorized = createHttpProductionCheckGateway({
      origin: 'https://review.example.test',
      workspaceId: 'workspace-alpha',
      readToken: 'wrong-production-read-token',
      fetch: vi.fn(async () => new Response('sensitive detail', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(unauthorized.fetchChecks()).rejects.toMatchObject({
      name: 'ProductionCheckTransportError',
      status: 401,
      message: 'Production-check authentication failed.',
    });
  });
});
