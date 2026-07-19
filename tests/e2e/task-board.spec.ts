import { expect, test } from '@playwright/test';

const apiVersion = 'steward.task-board/v1';
const project = {
  apiVersion,
  projectId: 'project-cicada',
  name: 'Cicada platform',
  description: 'Agents own defined parts of the system and improve customer outcomes.',
  version: 1,
  createdAt: '2026-07-19T18:00:00.000Z',
  updatedAt: '2026-07-19T18:15:00.000Z',
};
const task = {
  apiVersion,
  taskId: 'task-recovery',
  projectId: project.projectId,
  parentTaskId: null,
  title: 'Improve invoice recovery',
  objective: 'Customers can recover from a failed invoice without support.',
  acceptanceCriteria: 'The focused recovery tests pass and the result is recorded for humans.',
  workspaceRefs: ['/workspace/billing'],
  status: 'backlog',
  assignedAgentId: null,
  assignedRole: null,
  expectedAgentMinutes: 30,
  startedAt: null,
  expectedCompletedAt: null,
  endedAt: null,
  result: null,
  version: 1,
  createdAt: '2026-07-19T18:10:00.000Z',
  updatedAt: '2026-07-19T18:10:00.000Z',
};
const agent = {
  apiVersion,
  agentId: 'billing-engineer',
  projectId: project.projectId,
  role: 'engineer',
  area: 'Billing and subscriptions',
  mission: 'Keep billing reliable and understandable for customers.',
  model: 'configured-coding-model',
  status: 'idle',
  createdAt: '2026-07-19T18:05:00.000Z',
};

function board() {
  return {
    apiVersion,
    project,
    agents: [agent],
    tasks: [task],
    openQuestions: [],
    recentQuestions: [],
    recentRuns: [],
    recentInterrupts: [],
    recentEvents: [],
  };
}

test('the default app reads real board state and assignment is an explicit human wake', async ({ page }) => {
  let assignment: Record<string, unknown> | null = null;
  await page.route('**/board-api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: board() });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${task.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${task.taskId}` && route.request().method() === 'PATCH') {
      assignment = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { task: { ...task, ...assignment, version: 2 } } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await expect(page.getByLabel('Project')).toHaveValue('project-cicada');
  await expect(page.getByRole('heading', { name: 'Shared todo list' })).toBeVisible();
  await expect(page.getByText('Improve invoice recovery', { exact: true }).first()).toBeVisible();
  if ((page.viewportSize()?.width ?? 1_000) < 1_024) {
    await page.getByRole('button', { name: 'Agents 1' }).click();
    await expect(page.getByText('Billing and subscriptions').first()).toBeVisible();
    await page.getByRole('button', { name: 'Tasks 1' }).click();
  } else {
    await expect(page.getByText('Billing and subscriptions').first()).toBeVisible();
  }
  await page.getByRole('button', { name: /Improve invoice recovery/u }).click();
  await page.getByRole('button', { name: 'Assign and wake agent' }).click();

  expect(assignment).toEqual({
    version: 1,
    assignedAgentId: 'billing-engineer',
    assignedRole: 'engineer',
    expectedAgentMinutes: 30,
    status: 'queued',
  });
});

test('a failed authoritative read never falls back to demo agents', async ({ page }) => {
  await page.route('**/board-api/v1/projects', (route) => route.fulfill({
    status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'Board is offline' } },
  }));
  await page.goto('/');
  await expect(page.getByText('Task board unavailable')).toBeVisible();
  await expect(page.getByText('No demo data is being shown.')).toBeVisible();
  await expect(page.getByText('Patch')).toHaveCount(0);
});
