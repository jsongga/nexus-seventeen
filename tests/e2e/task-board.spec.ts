import { expect, test, type Locator, type Page } from '@playwright/test';

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
  kind: 'work',
  requiredRole: null,
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
const manager = {
  ...agent,
  agentId: 'release-manager',
  role: 'manager',
  area: 'Release review',
  mission: 'Check completed work before a human release decision.',
  status: 'idle',
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

async function openCompanyRail(page: Page): Promise<Locator> {
  if ((page.viewportSize()?.width ?? 1_000) < 1_024) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  const companyNavigation = page.getByRole('navigation', { name: 'Company navigation' });
  await expect(companyNavigation).toBeVisible();
  return companyNavigation.locator('../..');
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
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  await expect(page.getByText('Improve invoice recovery', { exact: true }).first()).toBeVisible();
  const companyRail = await openCompanyRail(page);
  await expect(companyRail.getByText('Cicada', { exact: true })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Task List' })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Documents' })).toBeVisible();
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /billing-engineer/u })).toBeVisible();
  await companyRail.getByRole('button', { name: 'Task List' }).click();
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

test('the Cicada sidebar navigates company work and an agent message is one atomic 15-minute wake', async ({ page }) => {
  const projectTask = {
    ...task,
    workspaceRefs: ['/workspace/billing', 'https://docs.example.com/invoice-recovery'],
  };
  const mutations: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      mutations.push({
        method: request.method(),
        path: url.pathname,
        body: request.postDataJSON() as Record<string, unknown> | null,
      });
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: { ...board(), agents: [agent, manager], tasks: [projectTask] } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${projectTask.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/tasks` && request.method() === 'POST') {
      await route.fulfill({
        status: 201,
        json: {
          task: {
            ...projectTask,
            ...request.postDataJSON(),
            taskId: 'agent-query-one',
            status: 'queued',
            version: 1,
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  let companyRail = await openCompanyRail(page);
  await expect(companyRail.getByText('Cicada', { exact: true })).toBeVisible();
  await expect(companyRail.getByText('Point of contact', { exact: true })).toBeVisible();
  await expect(companyRail.getByText('Acting POC · ask or route work', { exact: true })).toBeVisible();
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /billing-engineer/u })).toBeVisible();
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /release-manager/u })).toBeVisible();

  await companyRail.getByRole('button', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  await expect(page.getByText('Project brief', { exact: true })).toBeVisible();
  await expect(page.getByText('docs.example.com', { exact: true })).toBeVisible();

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /Cicada platform/u }).click();
  await expect(page.getByRole('heading', { name: 'Cicada platform' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent updates' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project setup' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Docs & links' })).toBeVisible();
  await expect(page.getByText('/workspace/billing', { exact: true })).toBeVisible();

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /billing-engineer/u }).click();
  await expect(page.getByRole('heading', { name: 'billing-engineer', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Talk to billing-engineer' })).toBeVisible();
  await expect(page.getByText('Ready for a task', { exact: true })).toBeVisible();

  const prompt = 'Summarize what customers gain from the invoice recovery work.';
  const message = page.getByLabel('Message billing-engineer');
  await message.fill(prompt);
  await page.getByRole('button', { name: 'Send and wake agent' }).click();
  await expect.poll(() => mutations).toHaveLength(1);
  await expect(message).toHaveValue('');

  expect(mutations).toEqual([{
    method: 'POST',
    path: `/board-api/v1/projects/${project.projectId}/tasks`,
    body: {
      parentTaskId: null,
      title: `Request for ${agent.agentId}: ${prompt}`,
      objective: `${prompt}\n\nCompany routing map (use this only to identify the best project or agent):\n- Cicada platform: billing-engineer (engineer, Billing and subscriptions), release-manager (manager, Release review)`,
      acceptanceCriteria: 'Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.',
      workspaceRefs: [],
      assignedAgentId: agent.agentId,
      assignedRole: 'engineer',
      expectedAgentMinutes: 15,
    },
  }]);
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

test('a human can promote an agent proposal from a completed task without waking an agent', async ({ page }) => {
  const completedParent = {
    ...task,
    taskId: 'task-completed-parent',
    status: 'completed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    startedAt: '2026-07-19T18:10:00.000Z',
    expectedCompletedAt: '2026-07-19T18:40:00.000Z',
    endedAt: '2026-07-19T18:28:00.000Z',
    result: 'Invoice recovery is now dependable for customers.',
    version: 2,
    updatedAt: '2026-07-19T18:28:00.000Z',
  };
  const proposal = {
    apiVersion,
    messageId: 'proposal-one',
    sequence: 1,
    projectId: project.projectId,
    taskId: completedParent.taskId,
    runId: 'run-completed',
    actorType: 'agent',
    actorId: agent.agentId,
    kind: 'proposal',
    body: JSON.stringify({
      title: 'Explain invoice recovery failures',
      objective: 'Customers understand what happened and what to do next.',
      acceptanceCriteria: ['The failure state explains the next step.', 'Focused recovery tests pass.'],
    }),
    createdAt: '2026-07-19T18:27:00.000Z',
  };
  let createdTask: Record<string, unknown> | null = null;
  const wakeRequests: string[] = [];
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: { ...board(), tasks: [completedParent] } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${completedParent.taskId}/messages`) {
      await route.fulfill({ json: { messages: [proposal], cursor: 1 } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/tasks` && request.method() === 'POST') {
      createdTask = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, json: { task: { ...completedParent, ...createdTask, taskId: 'promoted-child', version: 1 } } });
      return;
    }
    if (url.pathname.includes('/resume') || url.pathname.includes('/interrupt') || request.method() === 'PATCH') {
      wakeRequests.push(`${request.method()} ${url.pathname}`);
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Improve invoice recovery completed/u }).click();
  await expect(page.getByText('Agent proposal', { exact: true })).toBeVisible();
  await expect(page.getByText('Explain invoice recovery failures', { exact: true })).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('will not wake an agent');
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Add unassigned child todo' }).click();
  await expect.poll(() => createdTask).not.toBeNull();

  expect(createdTask).toEqual({
    parentTaskId: completedParent.taskId,
    title: 'Explain invoice recovery failures',
    objective: 'Customers understand what happened and what to do next.',
    acceptanceCriteria: '- The failure state explains the next step.\n- Focused recovery tests pass.',
    workspaceRefs: ['/workspace/billing'],
    expectedAgentMinutes: 30,
    assignedAgentId: null,
    assignedRole: null,
  });
  expect(wakeRequests).toEqual([]);
});

test('a malformed agent proposal is shown safely and cannot be promoted', async ({ page }) => {
  const malformed = {
    apiVersion,
    messageId: 'proposal-malformed',
    sequence: 1,
    projectId: project.projectId,
    taskId: task.taskId,
    runId: 'run-one',
    actorType: 'agent',
    actorId: agent.agentId,
    kind: 'proposal',
    body: '{"title":"Missing objective and criteria"}',
    createdAt: '2026-07-19T18:12:00.000Z',
  };
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
      await route.fulfill({ json: { messages: [malformed], cursor: 1 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Improve invoice recovery/u }).click();
  await expect(page.getByText('Agent proposal unavailable')).toBeVisible();
  await expect(page.getByText('This proposal was malformed and was not added to the todo list.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add unassigned child todo' })).toHaveCount(0);
  await expect(page.getByText('Missing objective and criteria')).toHaveCount(0);
});

test('an automatic manager review can only be assigned to a manager by a human', async ({ page }) => {
  const completedWork = {
    ...task,
    status: 'completed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    startedAt: '2026-07-19T18:10:00.000Z',
    expectedCompletedAt: '2026-07-19T18:40:00.000Z',
    endedAt: '2026-07-19T18:27:00.000Z',
    result: 'Customers can recover failed invoices without support.',
    version: 2,
    updatedAt: '2026-07-19T18:27:00.000Z',
  };
  const reviewTask = {
    ...task,
    taskId: 'task-recovery-manager-review',
    parentTaskId: completedWork.taskId,
    kind: 'manager_review',
    requiredRole: 'manager',
    title: 'Manager review: Improve invoice recovery',
    objective: 'Check the engineer result before asking a human for a release decision.',
    expectedAgentMinutes: 15,
    updatedAt: '2026-07-19T18:28:00.000Z',
  };
  let assignment: Record<string, unknown> | null = null;
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: { ...board(), agents: [agent, manager], tasks: [completedWork, reviewTask] } });
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${reviewTask.taskId}` && request.method() === 'PATCH') {
      assignment = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { task: { ...reviewTask, ...assignment, version: 2 } } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Manager review: Improve invoice recovery/u }).click();
  await expect(page.getByText('manager review', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('This review stays asleep until a human assigns a manager. Assignment creates one durable human wake-up.')).toBeVisible();
  const managerSelect = page.getByLabel('Assign manager');
  await expect(managerSelect.locator('option')).toHaveCount(1);
  await expect(managerSelect.locator('option')).toHaveText('release-manager — Release review');
  await expect(managerSelect).not.toContainText('billing-engineer');
  await page.getByRole('button', { name: 'Assign manager and wake' }).click();
  await expect.poll(() => assignment).not.toBeNull();

  expect(assignment).toEqual({
    version: 1,
    assignedAgentId: manager.agentId,
    assignedRole: 'manager',
    expectedAgentMinutes: 15,
    status: 'queued',
  });
});

test('a human check records approval without exposing any agent wake or deployment control', async ({ page }) => {
  const completedWork = {
    ...task,
    status: 'completed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    startedAt: '2026-07-19T18:10:00.000Z',
    expectedCompletedAt: '2026-07-19T18:40:00.000Z',
    endedAt: '2026-07-19T18:27:00.000Z',
    result: 'Customers can recover failed invoices without support.',
    version: 2,
    updatedAt: '2026-07-19T18:27:00.000Z',
  };
  const completedReview = {
    ...completedWork,
    taskId: 'task-recovery-manager-review',
    parentTaskId: completedWork.taskId,
    kind: 'manager_review',
    requiredRole: 'manager',
    title: 'Manager review: Improve invoice recovery',
    assignedAgentId: manager.agentId,
    assignedRole: 'manager',
    expectedAgentMinutes: 15,
    result: 'Focused checks and the user impact are ready for human review.',
    updatedAt: '2026-07-19T18:29:00.000Z',
  };
  const humanCheck = {
    ...task,
    taskId: 'task-recovery-human-check',
    parentTaskId: completedReview.taskId,
    kind: 'human_check',
    requiredRole: null,
    title: 'Human check: Improve invoice recovery',
    objective: 'A human decides whether the reviewed result can move to the external release step.',
    expectedAgentMinutes: 15,
    updatedAt: '2026-07-19T18:30:00.000Z',
  };
  let decision: Record<string, unknown> | null = null;
  const agentWakeRequests: string[] = [];
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: { ...board(), agents: [agent, manager], tasks: [completedWork, completedReview, humanCheck] } });
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${humanCheck.taskId}` && request.method() === 'PATCH') {
      decision = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { task: { ...humanCheck, ...decision, endedAt: '2026-07-19T18:35:00.000Z', version: 2 } } });
      return;
    }
    if (url.pathname.includes('/resume') || url.pathname.includes('/interrupt')) {
      agentWakeRequests.push(`${request.method()} ${url.pathname}`);
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Human check: Improve invoice recovery/u }).click();
  await expect(page.getByText('human check', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('awaiting human', { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/Approval does not deploy to production/u)).toBeVisible();
  await expect(page.getByLabel('Assign agent')).toHaveCount(0);
  await expect(page.getByLabel('Assign manager')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Resume assigned/u })).toHaveCount(0);
  const approve = page.getByRole('button', { name: 'Approve for external release step' });
  const requestChanges = page.getByRole('button', { name: 'Request changes' });
  await expect(approve).toBeDisabled();
  await expect(requestChanges).toBeDisabled();
  const rationale = 'The focused recovery checks passed and the customer impact is clear.';
  const rationaleInput = page.getByLabel('Decision rationale');
  await rationaleInput.fill(rationale);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rationaleInput).toHaveValue(rationale);
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => decision).not.toBeNull();

  expect(decision).toEqual({
    version: 1,
    status: 'completed',
    result: 'Approved for an external human-controlled release step.\n\nRationale: The focused recovery checks passed and the customer impact is clear.',
  });
  expect(agentWakeRequests).toEqual([]);
});
