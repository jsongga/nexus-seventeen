import { expect, test } from '@playwright/test';

const NOW = '2026-07-18T20:00:00.000Z';

function bootstrap() {
  return {
    apiVersion: 'steward.ui/v1',
    sessionId: 'session-live-e2e',
    userId: 'human-live-e2e',
    permissions: ['agents:read', 'agents:control'],
    features: ['runtime-discovery'],
    snapshot: {
      apiVersion: 'steward.ui/v1',
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
