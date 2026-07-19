import { expect, test } from '@playwright/test';

const NOW = '2026-07-18T20:00:00.000Z';

function bootstrap() {
  return {
    apiVersion: 'steward.ui/v2',
    sessionId: 'session-live-e2e',
    userId: 'human-live-e2e',
    permissions: ['agents:read', 'agents:control'],
    features: ['runtime-discovery'],
    snapshot: {
      apiVersion: 'steward.ui/v2',
      workspaceId: 'workspace-alpha',
      sequence: 8,
      controlVersion: 1,
      generatedAt: NOW,
      paused: false,
      agents: [{
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        runtimeInstanceId: 'runtime-patch',
        runtimeEpoch: 1,
        displayName: 'Patch',
        role: 'engineer',
        capabilities: ['research', 'plan', 'modify_workspace', 'run_tests'],
        provider: { name: 'codex', model: 'configured-economy-model' },
        softwareVersion: '0.1.0',
        checkpointRef: 'checkpoint-patch',
        registeredAt: NOW,
        lastSeenAt: NOW,
        leaseExpiresAt: '2099-07-18T20:01:00.000Z',
        currentAction: {
          taskId: 'task-checkout',
          summary: 'Testing checkout recovery',
          startedAt: NOW,
        },
        connectionState: 'online',
        controlState: 'active',
        controlVersion: 1,
        queue: ['task-checkout'],
      }],
      tasks: [{
        taskId: 'task-checkout',
        workspaceId: 'workspace-alpha',
        agentId: 'agent-patch',
        laneId: 'lane-patch',
        title: 'Recover interrupted checkout',
        objective: 'Customers can safely retry after a connection interruption.',
        subject: { type: 'development' },
        status: 'running',
        expectedAgentMinutes: 30,
        expectedCompletedAt: '2026-07-18T20:30:00.000Z',
        startedAt: NOW,
        endedAt: null,
      }],
      progress: [],
    },
    eventStream: {
      href: '/v1/ui/events',
      afterSequence: 8,
      retentionStartsAtSequence: 1,
      heartbeatIntervalMs: 15_000,
    },
    commandEndpoint: '/v1/ui/commands',
  };
}

test('the live runtime shows separately authenticated user-impact summaries', async ({ page }) => {
  let observerAuthorization = '';
  await page.route('https://control.example.test/**', async (route) => {
    if (route.request().url().includes('/v1/ui/bootstrap')) {
      await route.fulfill({ json: bootstrap() });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ': keepalive\n\n',
    });
  });
  await page.route('https://impact.example.test/**', async (route) => {
    observerAuthorization = route.request().headers().authorization ?? '';
    await route.fulfill({
      json: {
        apiVersion: 'steward.impact/v1',
        workspaceId: 'workspace-alpha',
        generatedAt: '2026-07-18T20:00:01.000Z',
        sourceSequence: 8,
        summaries: [{
          taskId: 'task-checkout',
          status: 'running',
          summary: 'Customers can retry checkout without creating a duplicate order.',
          updatedAt: '2026-07-18T20:00:01.000Z',
          sourceSequence: 8,
        }],
      },
    });
  });

  await page.goto('/live');
  await page.getByLabel('Control-plane origin').fill('https://control.example.test');
  await page.getByLabel('Workspace ID').fill('workspace-alpha');
  await page.getByLabel('Human bearer token').fill('human-session-token-0001');
  await page.getByLabel('Observer origin').fill('https://impact.example.test');
  await page.getByLabel('Separate output token').fill('impact-output-token-0001');
  await page.getByRole('button', { name: 'Connect live' }).click();

  const overview = page.getByRole('region', { name: 'User impact overview' });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole('heading', { name: 'What this work changes for users' })).toBeVisible();
  await expect(overview.getByRole('heading', { name: 'Recover interrupted checkout' })).toBeVisible();
  await expect(overview.getByText('Customers can retry checkout without creating a duplicate order.')).toBeVisible();
  await expect(overview.getByText('Current through event #8')).toBeVisible();
  expect(observerAuthorization).toBe('Bearer impact-output-token-0001');
  await expect(page.getByLabel('Human bearer token')).toHaveCount(0);
  await expect(page.getByLabel('Separate output token')).toHaveCount(0);
});

test('the live runtime refuses to reuse the human credential for impact summaries', async ({ page }) => {
  await page.goto('/live');
  await page.getByLabel('Control-plane origin').fill('https://control.example.test');
  await page.getByLabel('Workspace ID').fill('workspace-alpha');
  await page.getByLabel('Human bearer token').fill('shared-token-must-be-rejected');
  await page.getByLabel('Observer origin').fill('https://impact.example.test');
  await page.getByLabel('Separate output token').fill('shared-token-must-be-rejected');
  await page.getByRole('button', { name: 'Connect live' }).click();

  await expect(page.getByText('Use a separate read-only token for the impact observer.')).toBeVisible();
  await expect(page.getByLabel('Human bearer token')).toBeVisible();
});

test('the live runtime presents manager-accepted work as a read-only human decision', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-07-19T20:00:00.000Z') });
  let reviewAuthorization = '';
  let reviewMethod = '';
  let failReviewRefresh = false;
  await page.route('https://control.example.test/**', async (route) => {
    if (route.request().url().includes('/v1/ui/bootstrap')) {
      await route.fulfill({ json: bootstrap() });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ': keepalive\n\n',
    });
  });
  await page.route('https://review.example.test/**', async (route) => {
    reviewAuthorization = route.request().headers().authorization ?? '';
    reviewMethod = route.request().method();
    if (failReviewRefresh) {
      await route.fulfill({ status: 503, body: 'detail must not surface' });
      return;
    }
    await route.fulfill({
      json: {
        items: [{
          apiVersion: 1,
          productionCheckId: 'production-check:33333333-3333-4333-8333-333333333333',
          status: 'pending_human_review',
          workspaceId: 'workspace-alpha',
          taskId: 'task-checkout',
          evidenceId: '22222222-2222-4222-8222-222222222222',
          evidenceDigest: `sha256:${'a'.repeat(64)}`,
          completionEventId: 'completion-checkout-001',
          checkpointRef: 'checkpoint-checkout-001',
          engineerAgentId: 'agent-patch',
          managerAgentId: 'manager-moss',
          managerRuntimeInstanceId: 'manager-runtime-moss-001',
          managerRuntimeEpoch: 3,
          managerReviewId: '33333333-3333-4333-8333-333333333333',
          reviewTaskId: 'task-review-checkout',
          permitId: 'permit-checkout-001',
          permitWorkspaceSequence: 9,
          resultOverview: 'Customers can retry checkout without creating a duplicate order.',
          reviewSummary: 'Passing evidence covers interruption and duplicate-submit behavior.',
          remainingRisks: 'A human should verify the staged rollback before production.',
          testEvidenceDigest: `sha256:${'b'.repeat(64)}`,
          releaseArtifactDigest: `sha256:${'c'.repeat(64)}`,
          releaseManifestDigest: `sha256:${'d'.repeat(64)}`,
          targetEnvironment: 'production-us',
          completedAt: '2026-07-19T19:00:00.000Z',
          reviewedAt: '2026-07-19T19:04:00.000Z',
          handoffId: '44444444-4444-4444-8444-444444444444',
          handoffRegisteredAt: '2026-07-19T19:05:00.000Z',
        }],
      },
    });
  });

  await page.goto('/live');
  await page.getByLabel('Control-plane origin').fill('https://control.example.test');
  await page.getByLabel('Workspace ID').fill('workspace-alpha');
  await page.getByLabel('Human bearer token').fill('human-session-token-0001');
  await page.getByLabel('Production-check origin').fill('https://review.example.test');
  await page.getByLabel('Dedicated production-check read token').fill('production-read-token-0001');
  await page.getByRole('button', { name: 'Connect live' }).click();

  const checks = page.getByRole('region', { name: 'Human production checks' });
  await expect(checks).toBeVisible();
  await expect(checks.getByText('Awaiting human production decision — not deployed')).toBeVisible();
  await expect(checks.getByRole('heading', { name: 'Recover interrupted checkout' })).toBeVisible();
  await expect(checks.getByText('Customers can retry checkout without creating a duplicate order.')).toBeVisible();
  await expect(checks.getByText('Passing evidence covers interruption and duplicate-submit behavior.')).toBeVisible();
  await expect(checks.getByText('A human should verify the staged rollback before production.')).toBeVisible();
  await expect(checks.getByText('production-us')).toBeVisible();
  await expect(checks.getByText('Artifact sha256:cccccccc…cccccc')).toBeVisible();
  await expect(checks.getByText('Manifest sha256:dddddddd…dddddd')).toBeVisible();
  await expect(checks.getByText('manager-runtime-moss-001 · epoch 3')).toBeVisible();
  await expect(checks.locator('time[datetime="2026-07-19T19:00:00.000Z"]')).toHaveCount(1);
  await expect(checks.locator('time[datetime="2026-07-19T19:04:00.000Z"]')).toHaveCount(1);
  await expect(checks.getByRole('button')).toHaveCount(0);
  expect(reviewAuthorization).toBe('Bearer production-read-token-0001');
  expect(reviewMethod).toBe('GET');
  await expect(page.getByLabel('Dedicated production-check read token')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);

  failReviewRefresh = true;
  await page.clock.runFor(10_001);
  await expect(checks.getByText('The last valid production-check list remains visible and may be stale.'))
    .toBeVisible();
  await expect(checks.getByRole('heading', { name: 'Recover interrupted checkout' })).toBeVisible();
  await expect(checks.getByText('detail must not surface')).toHaveCount(0);
});

test('the live runtime rejects production-check credential reuse', async ({ page }) => {
  await page.goto('/live');
  await page.getByLabel('Control-plane origin').fill('https://control.example.test');
  await page.getByLabel('Workspace ID').fill('workspace-alpha');
  await page.getByLabel('Human bearer token').fill('human-session-token-0001');
  await page.getByLabel('Production-check origin').fill('https://review.example.test');
  await page.getByLabel('Dedicated production-check read token').fill('human-session-token-0001');
  await page.getByRole('button', { name: 'Connect live' }).click();

  await expect(page.getByText('Use a production-check read token that is separate from the control-plane token.'))
    .toBeVisible();

  await page.getByLabel('Observer origin').fill('https://impact.example.test');
  await page.getByLabel('Separate output token').fill('shared-read-token-0001');
  await page.getByLabel('Dedicated production-check read token').fill('shared-read-token-0001');
  await page.getByRole('button', { name: 'Connect live' }).click();

  await expect(page.getByText('Use separate read tokens for production checks and the impact observer.'))
    .toBeVisible();
  await expect(page.getByLabel('Human bearer token')).toBeVisible();
});
