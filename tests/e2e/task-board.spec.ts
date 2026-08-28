import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  HumanQuestion,
  UpdateAutomationConfigurationRequest,
} from '@shared/task-board-contract';

const apiVersion = 'steward.task-board/v1' as const;
const pocConversationContextMarker = '\n\nRecent POC conversation (context only; newest request is above):\n';
const pocRoutingContextMarker = '\n\nCompany routing map (use this only to identify the best project or agent):\n';
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
  requiresReview: true,
  title: 'Improve invoice recovery',
  objective: 'Customers can recover from a failed invoice without support.',
  acceptanceCriteria: 'The focused recovery tests pass and the result is recorded for humans.',
  workspaceRefs: ['/workspace/billing'],
  status: 'backlog',
  assignedAgentId: null,
  assignedRole: null,
  expectedAgentMinutes: null,
  estimateRecordedAt: null,
  orderKey: 2_000,
  phases: [],
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
  version: 1,
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

const completedReferenceTask = {
  ...task,
  taskId: 'task-recovery-reference',
  title: 'Invoice recovery outcome',
  workspaceRefs: ['/workspace/billing', 'https://docs.example.com/invoice-recovery'],
  status: 'completed',
  assignedAgentId: agent.agentId,
  assignedRole: 'engineer',
  expectedAgentMinutes: 30,
  estimateRecordedAt: '2026-07-19T18:12:00.000Z',
  startedAt: '2026-07-19T18:10:00.000Z',
  expectedCompletedAt: '2026-07-19T18:40:00.000Z',
  endedAt: '2026-07-19T18:28:00.000Z',
  result: 'Customers can retry a failed invoice without contacting support.',
  version: 2,
  updatedAt: '2026-07-19T18:28:00.000Z',
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

async function installDefaultBoard(
  page: Page,
  options: { pauseConflictOnce?: boolean } = {},
): Promise<{ pauseOnNextRead: () => void }> {
  let pauseConflictOnce = options.pauseConflictOnce ?? false;
  let pauseOnNextRead = false;
  let boardPause = {
    paused: false,
    reason: null as string | null,
    version: 1,
    updatedAt: '2026-07-19T18:00:00.000Z',
    updatedBy: 'system:steward-default',
  };
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/board/pause' && request.method() === 'GET') {
      if (pauseOnNextRead) {
        pauseOnNextRead = false;
        boardPause = {
          paused: true,
          reason: 'Paused by another operator.',
          version: boardPause.version + 1,
          updatedAt: '2026-07-19T18:29:00.000Z',
          updatedBy: 'human:another-operator',
        };
      }
      await route.fulfill({ json: boardPause });
      return;
    }
    if (url.pathname === '/board-api/v1/board/pause' && request.method() === 'POST') {
      const body = request.postDataJSON() as { reason: string | null; version: number };
      if (pauseConflictOnce || body.version !== boardPause.version) {
        pauseConflictOnce = false;
        await route.fulfill({ status: 409, json: { error: { code: 'BOARD_PAUSE_VERSION_CONFLICT', message: 'Pause state changed' } } });
        return;
      }
      boardPause = {
        paused: true,
        reason: body.reason,
        version: boardPause.version + 1,
        updatedAt: '2026-07-19T18:30:00.000Z',
        updatedBy: 'human:operator',
      };
      await route.fulfill({ json: boardPause });
      return;
    }
    if (url.pathname === '/board-api/v1/board/resume' && request.method() === 'POST') {
      const body = request.postDataJSON() as { version: number };
      if (body.version !== boardPause.version) {
        await route.fulfill({ status: 409, json: { error: { code: 'BOARD_PAUSE_VERSION_CONFLICT', message: 'Pause state changed' } } });
        return;
      }
      boardPause = {
        paused: false,
        reason: null,
        version: boardPause.version + 1,
        updatedAt: '2026-07-19T18:31:00.000Z',
        updatedBy: 'human:operator',
      };
      await route.fulfill({ json: boardPause });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
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
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  return {
    pauseOnNextRead: () => { pauseOnNextRead = true; },
  };
}

test('the board control pauses with a reason and resumes orchestration', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  const pause = companyRail.getByRole('button', { name: 'Pause board', exact: true });
  await expect(pause).toBeVisible();

  await pause.click();
  const pausePopover = companyRail.getByRole('dialog', { name: 'Pause board', exact: true });
  await pausePopover.getByRole('textbox', { name: 'Reason', exact: true }).fill('Database maintenance window.');
  await pausePopover.getByRole('button', { name: 'Confirm pause', exact: true }).click();
  await expect(page.getByText('Board paused', { exact: true })).toBeVisible();
  await expect(page.getByText('Database maintenance window.', { exact: true })).toBeVisible();

  await companyRail.getByRole('button', { name: 'Resume board', exact: true }).click();
  await expect(companyRail.getByRole('button', { name: 'Pause board', exact: true })).toBeVisible();
  await expect(page.getByText('Board paused', { exact: true })).toHaveCount(0);
});

test('Escape closes the pause popover and returns focus to its trigger', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  const pause = companyRail.getByRole('button', { name: 'Pause board', exact: true });

  await pause.click();
  const pausePopover = companyRail.getByRole('dialog', { name: 'Pause board', exact: true });
  await expect(pausePopover).toBeVisible();
  await pausePopover.getByRole('textbox', { name: 'Reason', exact: true }).press('Escape');

  await expect(pausePopover).toHaveCount(0);
  await expect(pause).toBeFocused();
});

test('a pause version conflict keeps the reason and error in the popover', async ({ page }) => {
  await installDefaultBoard(page, { pauseConflictOnce: true });
  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  const pause = companyRail.getByRole('button', { name: 'Pause board', exact: true });

  await pause.click();
  const pausePopover = companyRail.getByRole('dialog', { name: 'Pause board', exact: true });
  const reason = pausePopover.getByRole('textbox', { name: 'Reason', exact: true });
  await reason.fill('Database maintenance window.');
  await pausePopover.getByRole('button', { name: 'Confirm pause', exact: true }).click();

  await expect(pausePopover).toBeVisible();
  await expect(pausePopover.getByRole('alert')).toContainText('Pause state changed');
  await expect(reason).toHaveValue('Database maintenance window.');
});

test('a remote pause closes the open pause popover without reopening it after resume', async ({ page }) => {
  const boardStub = await installDefaultBoard(page);
  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  const pause = companyRail.getByRole('button', { name: 'Pause board', exact: true });

  await pause.click();
  const pausePopover = companyRail.getByRole('dialog', { name: 'Pause board', exact: true });
  await expect(pausePopover).toBeVisible();

  boardStub.pauseOnNextRead();
  await triggerVisiblePoll(page);
  await expect(companyRail.getByRole('button', { name: 'Resume board', exact: true })).toBeVisible();
  await expect(pausePopover).toHaveCount(0);

  await companyRail.getByRole('button', { name: 'Resume board', exact: true }).click();
  await expect(pause).toBeVisible();
  await expect(pausePopover).toHaveCount(0);
});

async function openCompanyRail(page: Page): Promise<Locator> {
  if ((page.viewportSize()?.width ?? 1_000) < 1_024) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  const companyNavigation = page.getByRole('navigation', { name: 'Company navigation' });
  await expect(companyNavigation).toBeVisible();
  return companyNavigation.locator('../..');
}

async function triggerVisiblePoll(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.visibilityState !== 'visible') throw new Error('The board must be visible before triggering a poll');
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function renderedSnapshotRevision(taskDetail: Locator): Promise<number> {
  const text = await taskDetail.textContent();
  return Number(/Snapshot revision (\d+)/u.exec(text ?? '')?.[1] ?? 0);
}

async function discardDirtyDialog(page: Page): Promise<void> {
  const confirmation = page.getByRole('dialog', { name: 'Discard draft?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
}

test('the first-run board leads with project creation in the board and project rail', async ({ page }) => {
  await page.route('**/board-api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  const taskList = page.getByRole('main');
  await expect(taskList.getByRole('heading', { name: 'Start with a project', exact: true })).toBeVisible();
  await expect(taskList).toContainText('Agents arrive on demand for that project; then submit work.');
  await taskList.getByRole('button', { name: 'Add project', exact: true }).click();

  let projectDialog = page.getByRole('dialog', { name: 'Add project from disk', exact: true });
  const projectFolder = projectDialog.getByLabel('Project folder', { exact: true });
  await projectFolder.fill('relative/project');
  await expect(projectDialog.getByText('Must be an absolute path, e.g. /Users/you/project', { exact: true })).toBeVisible();
  await expect(projectDialog.getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  await projectDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await discardDirtyDialog(page);

  const companyRail = await openCompanyRail(page);
  const projectNavigation = companyRail.getByRole('navigation', { name: 'Projects and agents', exact: true });
  await expect(projectNavigation.getByText('No projects yet', { exact: true })).toBeVisible();
  await projectNavigation.getByRole('button', { name: 'Add project', exact: true }).click();
  projectDialog = page.getByRole('dialog', { name: 'Add project from disk', exact: true });
  await expect(projectDialog).toBeVisible();
  if ((page.viewportSize()?.width ?? 1_000) < 1_024) {
    await expect(projectDialog.getByLabel('Project folder', { exact: true })).toBeFocused();
  }
});

test('interrupting every active project agent confirms the count and preserves runs on cancel', async ({ page }) => {
  const secondAgent = {
    ...manager,
    agentId: 'operations-manager',
    status: 'running',
    workerConnection: 'watching_run',
  };
  const firstActiveTask = {
    ...task,
    status: 'in_progress',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    startedAt: '2026-07-19T18:12:00.000Z',
  };
  const secondActiveTask = {
    ...task,
    taskId: 'task-operations-review',
    kind: 'manager_review',
    requiredRole: 'manager',
    requiresReview: false,
    title: 'Review operations readiness',
    status: 'queued',
    assignedAgentId: secondAgent.agentId,
    assignedRole: 'manager',
    orderKey: 3_000,
  };
  const activeRuns = [
    {
      apiVersion,
      runId: 'run-invoice-recovery',
      claimId: 'claim-invoice-recovery',
      projectId: project.projectId,
      agentId: agent.agentId,
      wakeupId: 'wakeup-invoice-recovery',
      taskId: firstActiveTask.taskId,
      status: 'active',
      startedAt: '2026-07-19T18:12:00.000Z',
      endedAt: null,
      result: null,
      heartbeatAt: null,
      runtime: null,
      runtimeVersion: null,
      model: null,
      promptsSha: null,
    },
    {
      apiVersion,
      runId: 'run-operations-review',
      claimId: 'claim-operations-review',
      projectId: project.projectId,
      agentId: secondAgent.agentId,
      wakeupId: 'wakeup-operations-review',
      taskId: secondActiveTask.taskId,
      status: 'active',
      startedAt: '2026-07-19T18:13:00.000Z',
      endedAt: null,
      result: null,
      heartbeatAt: null,
      runtime: null,
      runtimeVersion: null,
      model: null,
      promptsSha: null,
    },
  ];
  const interruptRequests: string[] = [];

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          agents: [{ ...agent, status: 'running', workerConnection: 'watching_run' }, secondAgent],
          tasks: [firstActiveTask, secondActiveTask],
          recentRuns: activeRuns,
        },
      });
      return;
    }
    if (/^\/board-api\/v1\/agents\/[^/]+\/interrupt$/u.test(url.pathname) && request.method() === 'POST') {
      interruptRequests.push(url.pathname);
      const requestedAgentId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      const requestedRun = activeRuns.find((run) => run.agentId === requestedAgentId);
      await route.fulfill({
        json: {
          interrupt: {
            apiVersion,
            sequence: interruptRequests.length,
            agentId: requestedAgentId,
            runId: requestedAgentId === secondAgent.agentId ? null : requestedRun?.runId ?? null,
            requestedAt: '2026-07-19T18:14:00.000Z',
          },
          duplicate: false,
        },
      });
      return;
    }
    if (/^\/board-api\/v1\/tasks\/[^/]+\/messages$/u.test(url.pathname)) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents', exact: true })
    .getByRole('button', { name: project.name, exact: true }).click();

  const interruptAll = page.getByRole('button', { name: 'Interrupt all agents', exact: true });
  await expect(interruptAll).toBeEnabled();
  await interruptAll.click();
  let confirmation = page.getByRole('dialog', { name: 'Interrupt 2 agents?', exact: true });
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await expect(page.getByTestId('modal-scrim')).toHaveCount(0);
    const cancelIntersectsHeader = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .find((candidate) => candidate.querySelector('h2')?.textContent === 'Interrupt 2 agents?');
      const header = dialog?.querySelector<HTMLElement>(':scope > header');
      const cancel = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Cancel');
      if (!header || !cancel) throw new Error('Expected the interrupt dialog header and Cancel button');
      const headerBounds = header.getBoundingClientRect();
      const cancelBounds = cancel.getBoundingClientRect();
      return cancelBounds.left < headerBounds.right
        && cancelBounds.right > headerBounds.left
        && cancelBounds.top < headerBounds.bottom
        && cancelBounds.bottom > headerBounds.top;
    });
    expect(cancelIntersectsHeader).toBe(false);
  }
  await expect(confirmation).toContainText('2 active agents');
  await expect(confirmation).toContainText('recoverable via Retry');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(interruptRequests).toEqual([]);
  await expect(interruptAll).toBeEnabled();

  await interruptAll.click();
  confirmation = page.getByRole('dialog', { name: 'Interrupt 2 agents?', exact: true });
  await confirmation.getByRole('button', { name: 'Interrupt all agents', exact: true }).click();
  await expect.poll(() => interruptRequests).toHaveLength(2);
  await expect(page.getByRole('status')).toHaveText('Interrupted 1 agent; 1 had already finished.');
  await expect(confirmation).toHaveCount(0);
  await expect(interruptAll).toBeDisabled();
});

test('a project deep link survives a reload and the back button returns to it', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/');
  let companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' })
    .getByRole('button', { name: project.name, exact: true }).click();

  // Navigating updates the URL.
  await expect(page).toHaveURL(/#\/project\/project-cicada$/u);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  const deepLink = page.url();

  // The URL alone restores the same view.
  await page.reload();
  await expect(page).toHaveURL(deepLink);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();

  // Going elsewhere and back returns to it.
  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Task List' }).click();
  await expect(page).toHaveURL(/#\/tasks$/u);
  await page.goBack();
  await expect(page).toHaveURL(deepLink);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
});

test('an unknown hash falls back to the task list instead of blanking the page', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/#/nonsense/value');
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Improve invoice recovery/u })).toBeVisible();
});

test('a deep link to a project missing from the snapshot does not trap Back', async ({ page }) => {
  await installDefaultBoard(page);
  await page.route('**/outside-board', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Outside board</title><h1>Outside board</h1>',
    });
  });
  await page.goto('/outside-board');
  const historyLengthBeforeBoard = await page.evaluate(() => window.history.length);

  await page.goto('/#/project/project-missing-from-snapshot');
  await expect(page).toHaveURL(/#\/tasks$/u);
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  const historyLengthAfterReconciliation = await page.evaluate(() => window.history.length);

  await page.goBack();
  await expect(page).toHaveURL(/\/outside-board$/u);
  await expect(page.getByRole('heading', { name: 'Outside board' })).toBeVisible();
  expect(historyLengthAfterReconciliation).toBe(historyLengthBeforeBoard + 1);
});

test('a cold task deep link that was never observed canonicalizes to the task list', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/#/tasks/task-never-observed');

  await expect(page).toHaveURL(/#\/tasks$/u);
  await expect(page.getByRole('heading', { name: 'Task List', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Task removed', exact: true })).toHaveCount(0);
});

test('task routes preserve operator context across polling, removal, and dirty-dialog dismissal', async ({ page }) => {
  const routedTask = {
    ...task,
    taskId: 'task-c6-question',
    title: 'Preserve operator context',
    objective: 'An operator supplies context without polling destroying the draft.',
    status: 'blocked',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    orderKey: 1_000,
  };
  const routedQuestion = {
    apiVersion,
    questionId: 'question-c6-context',
    projectId: project.projectId,
    taskId: routedTask.taskId,
    agentId: agent.agentId,
    runId: 'run-c6-context',
    question: 'Which release evidence should the agent retain?',
    status: 'open',
    answer: null,
    askedAt: '2026-07-19T18:20:00.000Z',
    answeredAt: null,
    answeredBy: null,
    version: 1,
  };
  let reassigned = false;
  let removed = false;
  let projectReads = 0;
  await page.clock.install({ time: new Date('2026-07-19T18:30:00.000Z') });
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      projectReads += 1;
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      const currentRoutedTask = reassigned
        ? { ...routedTask, assignedAgentId: manager.agentId, assignedRole: 'manager', version: 2 }
        : routedTask;
      await route.fulfill({
        json: {
          ...board(),
          agents: [agent, manager],
          tasks: removed ? [completedReferenceTask] : [currentRoutedTask, completedReferenceTask],
          openQuestions: removed ? [] : [routedQuestion],
        },
      });
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/#/tasks/task-c6-question');
  await expect(page).toHaveURL(/#\/tasks\/task-c6-question$/u);
  const taskPane = page.getByRole('region', { name: 'Task details: Preserve operator context' });
  const taskHeading = taskPane.getByRole('heading', { name: 'Preserve operator context', exact: true });
  const belowXl = (page.viewportSize()?.width ?? 1_280) < 1_280;
  await expect(taskHeading).toBeVisible();
  if (belowXl) await expect(taskHeading).toBeFocused();

  const deepLink = page.url();
  await page.reload();
  await expect(page).toHaveURL(deepLink);
  await expect(taskHeading).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#/tasks';
  });
  await expect(page).toHaveURL(/#\/tasks$/u);
  const routedRow = page.getByRole('button', { name: /Preserve operator context/u });
  await routedRow.click();
  await expect(page).toHaveURL(/#\/tasks\/task-c6-question$/u);
  if (belowXl) await expect(taskHeading).toBeFocused();
  else await expect(routedRow).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/#\/tasks$/u);
  if (belowXl) await expect(routedRow).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(deepLink);

  const answerDraft = taskPane.getByLabel('Your answer', { exact: true });
  await answerDraft.fill('Retain the focused test results and the customer-impact review.');
  const readsBeforeReassignment = projectReads;
  reassigned = true;
  await page.clock.runFor(5_100);
  await expect.poll(() => projectReads).toBeGreaterThan(readsBeforeReassignment);
  await expect(answerDraft).toHaveValue('Retain the focused test results and the customer-impact review.');

  const readsBeforeRemoval = projectReads;
  removed = true;
  await page.clock.runFor(5_100);
  await expect.poll(() => projectReads).toBeGreaterThan(readsBeforeRemoval);
  const removedState = page.getByRole('status').filter({ has: page.getByRole('heading', { name: 'Task removed', exact: true }) });
  await expect(removedState).toContainText('Your view has not switched to another task.');
  await expect(page).toHaveURL(/#\/tasks\/task-c6-question$/u);
  await expect(page.getByRole('region', { name: `Task details: ${completedReferenceTask.title}` })).toHaveCount(0);

  const readsBeforeRestoration = projectReads;
  removed = false;
  await page.clock.runFor(5_100);
  await expect.poll(() => projectReads).toBeGreaterThan(readsBeforeRestoration);
  await expect(taskHeading).toBeVisible();
  await expect(answerDraft).toHaveValue('Retain the focused test results and the customer-impact review.');

  if (belowXl) {
    await page.getByRole('button', { name: 'Back to task list', exact: true }).click();
  } else {
    await page.goBack();
  }
  await expect(page).toHaveURL(/#\/tasks$/u);

  const addTask = page.getByRole('button', { name: 'Add task', exact: true });
  await expect(addTask).toHaveCount(1);
  await addTask.click();
  const taskDialog = page.getByRole('dialog', { name: 'Add a task', exact: true });
  const prompt = taskDialog.getByLabel('Task', { exact: true });
  await prompt.fill('Keep this draft through the discard decision.');
  await page.keyboard.press('Escape');
  const discardConfirmation = page.getByRole('dialog', { name: 'Discard draft?', exact: true });
  await expect(discardConfirmation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(discardConfirmation).toHaveCount(0);
  await expect(prompt).toHaveValue('Keep this draft through the discard decision.');
  await expect(prompt).toBeFocused();
  await page.keyboard.press('Escape');
  await discardDirtyDialog(page);
  await expect(taskDialog).toHaveCount(0);
});

test('desktop outside-click on a dirty add-task draft asks for confirmation', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, 'anchored add-task is desktop-only');
  await installDefaultBoard(page);
  await page.goto('/');

  const taskListActions = page.getByRole('group', { name: 'Task list actions' });
  await taskListActions.getByRole('button', { name: 'Add task' }).click();
  const taskDialog = page.getByRole('dialog', { name: 'Add a task', exact: true });
  await taskDialog.getByLabel('Task', { exact: true }).fill('Protect this outside-click draft.');

  await page.getByRole('heading', { name: 'Task List', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Discard draft?', exact: true })).toBeVisible();
});

test('an add-task draft survives desktop and mobile layout transitions', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, 'responsive transition starts on desktop');
  const initialViewport = page.viewportSize();
  if (!initialViewport) throw new Error('Expected a configured desktop viewport');
  await installDefaultBoard(page);
  await page.goto('/');

  await page.getByRole('group', { name: 'Task list actions' })
    .getByRole('button', { name: 'Add task', exact: true }).click();
  const taskDialog = page.getByRole('dialog', { name: 'Add a task', exact: true });
  const prompt = taskDialog.getByLabel('Task', { exact: true });
  await prompt.fill('Keep this prompt while the dialog changes layouts.');

  await page.setViewportSize({ width: 500, height: initialViewport.height });
  await expect(page.getByTestId('modal-scrim')).toBeVisible();
  await expect(prompt).toHaveValue('Keep this prompt while the dialog changes layouts.');

  await page.setViewportSize({ width: 1_440, height: initialViewport.height });
  await expect(page.getByTestId('modal-scrim')).toHaveCount(0);
  await expect(prompt).toHaveValue('Keep this prompt while the dialog changes layouts.');
});

test('a token-rotation dialog stays inside a short desktop viewport', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 640, 'anchored token rotation is desktop-only');
  const importedProject = {
    ...project,
    projectId: 'project-payment-tools',
    name: 'payment-tools',
    description: '/workspace/payment-tools',
  };
  let createdProject: Record<string, unknown> | null = null;
  let projectCreated = false;
  let projectCreateAttempts = 0;
  let taskSubmitted = false;
  let agentCreateRequests = 0;
  let managerVersion = 1;
  let rotationAttempts = 0;
  let createdWorkItemRequest: Record<string, unknown> | null = null;
  const rotatedToken = 'rotated-payment-tools-manager-token-012345678901';
  const lazyManager = {
    ...agent,
    agentId: 'payment-tools-manager',
    projectId: importedProject.projectId,
    role: 'manager',
    area: importedProject.name,
    mission: 'Refine incoming payment-tools work and plan durable workflows.',
    model: 'auto',
    status: 'ready',
    workerConnection: null,
    lastError: null,
    version: managerVersion,
    createdAt: '2026-08-09T20:01:00.000Z',
  };
  const planningTask = {
    ...task,
    taskId: 'task-plan-payment-tools',
    projectId: importedProject.projectId,
    title: 'Plan workflow: Add a health check to payment tools',
    objective: 'Add a health check to payment tools',
    acceptanceCriteria: 'Return a concise workflow plan.',
    workspaceRefs: [],
    status: 'queued',
    assignedAgentId: lazyManager.agentId,
    assignedRole: 'manager',
    requiresReview: false,
    version: 1,
    createdAt: '2026-08-09T20:01:00.000Z',
    updatedAt: '2026-08-09T20:01:00.000Z',
  };
  const createdWorkItem = {
    apiVersion,
    workItemId: 'work-item-payment-tools-first',
    originalRequest: 'Add a health check to payment tools',
    refinedObjective: null,
    priority: 'normal',
    taskType: 'standard',
    projectTarget: { mode: 'explicit', projectId: importedProject.projectId },
    resolvedProjectId: importedProject.projectId,
    planningTaskId: planningTask.taskId,
    state: 'planning',
    currentStage: 'planning',
    createdBy: 'human:operator',
    version: 2,
    createdAt: '2026-08-09T20:01:00.000Z',
    updatedAt: '2026-08-09T20:01:00.000Z',
    endedAt: null,
    cancelledReason: null,
    archivedAt: null,
    transitions: [{
      fromState: null,
      toState: 'queued',
      actorType: 'human',
      actorId: 'human:operator',
      createdAt: '2026-08-09T20:01:00.000Z',
    }, {
      fromState: 'queued',
      toState: 'planning',
      actorType: 'system',
      actorId: 'system:planning',
      createdAt: '2026-08-09T20:01:00.000Z',
    }],
  };
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/host/project-roots' && request.method() === 'GET') {
      await route.fulfill({ json: { roots: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/host/directories' && request.method() === 'GET' && !url.searchParams.has('path')) {
      await route.fulfill({
        json: { listing: { path: '/workspace', parent: null, entries: [], truncated: false } },
      });
      return;
    }
    if (url.pathname === '/board-api/v1/host/directories' && request.method() === 'GET' && url.searchParams.get('path') === '/workspace/payment-tools') {
      await route.fulfill({
        status: 403,
        json: { error: { code: 'HOST_PATH_OUTSIDE_ROOTS', message: 'The folder is outside the browsable area' } },
      });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'GET') {
      await route.fulfill({ json: { workItems: taskSubmitted ? [createdWorkItem] : [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'POST') {
      createdWorkItemRequest = request.postDataJSON() as Record<string, unknown>;
      taskSubmitted = true;
      await route.fulfill({ status: 201, json: { workItem: createdWorkItem } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects' && request.method() === 'POST') {
      projectCreateAttempts += 1;
      if (projectCreateAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'PROJECT_PATH_CONFLICT', message: 'Project path changed' } },
        });
        return;
      }
      createdProject = request.postDataJSON() as Record<string, unknown>;
      projectCreated = true;
      await route.fulfill({ status: 201, json: { project: importedProject } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${importedProject.projectId}/agents` && request.method() === 'POST') {
      agentCreateRequests += 1;
      await route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_AGENT_CREATE', message: 'Identity must be lazy' } } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: projectCreated ? [project, importedProject] : [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: board() });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${importedProject.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          project: importedProject,
          agents: taskSubmitted ? [{ ...lazyManager, version: managerVersion }] : [],
          tasks: taskSubmitted ? [planningTask] : [],
          recentEvents: taskSubmitted ? [{
            apiVersion,
            eventId: 'event-payment-tools-manager-created',
            projectId: importedProject.projectId,
            taskId: null,
            actorType: 'system',
            actorId: 'system:lazy-agent-identity',
            eventType: 'agent_profile_created',
            data: { agentId: lazyManager.agentId, role: 'manager' },
            createdAt: lazyManager.createdAt,
          }] : [],
        },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${planningTask.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/agents/${lazyManager.agentId}/rotate-token` && request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({ version: managerVersion });
      rotationAttempts += 1;
      if (rotationAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'AGENT_VERSION_CONFLICT', message: 'Agent version changed' } },
        });
        return;
      }
      managerVersion += 1;
      await route.fulfill({
        json: { agent: { ...lazyManager, version: managerVersion }, token: rotatedToken },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${task.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Add project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project folder' }).fill('/workspace/payment-tools/');
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await dialog.getByRole('button', { name: 'Add anyway' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The board changed in another session. Refresh before trying again.');
  await expect(dialog.getByRole('button', { name: 'Dismiss error' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await discardDirtyDialog(page);
  await expect(page.getByRole('alert').filter({ hasText: 'The board changed in another session. Refresh before trying again.' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Project folder' }).fill('/workspace/payment-tools/');
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await dialog.getByRole('button', { name: 'Add anyway' }).click();
  await expect.poll(() => createdProject).not.toBeNull();

  expect(createdProject).toEqual({ name: 'payment-tools', description: '/workspace/payment-tools' });
  expect(agentCreateRequests).toBe(0);

  await page.getByRole('button', { name: 'Add task' }).click();
  const taskDialog = page.getByRole('dialog', { name: 'Add a task' });
  await taskDialog.getByRole('textbox', { name: 'Task', exact: true }).fill(createdWorkItem.originalRequest);
  await taskDialog.getByLabel('Project').selectOption(importedProject.projectId);
  await taskDialog.getByRole('button', { name: 'Submit task' }).click();
  await expect.poll(() => createdWorkItemRequest).not.toBeNull();
  expect(createdWorkItemRequest).toEqual({
    originalRequest: createdWorkItem.originalRequest,
    priority: 'normal',
    taskType: 'standard',
    projectTarget: { mode: 'explicit', projectId: importedProject.projectId },
  });

  const companyRail = await openCompanyRail(page);
  const lazyManagerButton = companyRail
    .getByRole('navigation', { name: 'Projects and agents' })
    .getByRole('button', { name: /^payment-tools-manager\b/u });
  await expect(lazyManagerButton).toBeVisible();
  await lazyManagerButton.click();
  await expect(page.getByRole('heading', { name: 'Lane configuration' })).toBeVisible();
  const laneConfig = page.getByLabel(`Fleet lane configuration for ${lazyManager.agentId}`);
  await expect(laneConfig).toContainText('"agentId": "payment-tools-manager"');
  await expect(laneConfig).toContainText('"workingDirectory": "/absolute/path/to/repository"');
  await expect(laneConfig).toContainText('"provider": "<codex or claude>"');
  await expect(laneConfig).toContainText('<rotate token to reveal>');
  await expect(page.getByText(/replace the working-directory and provider placeholders/u)).toBeVisible();

  const rotateToken = page.getByRole('button', { name: 'Rotate token', exact: true });
  await expect(rotateToken).toBeVisible();
  await page.setViewportSize({ width: 1_440, height: 420 });
  await rotateToken.scrollIntoViewIfNeeded();
  await rotateToken.click();

  const rotationDialog = page.getByRole('dialog', { name: 'Rotate agent token?', exact: true });
  const closeDialog = rotationDialog.getByRole('button', { name: 'Close dialog', exact: true });
  await expect(closeDialog).toBeVisible();
  const bounds = await rotationDialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);

  await page.keyboard.press('Escape');
  await expect(rotationDialog).toHaveCount(0);
  await expect(rotateToken).toBeFocused();
});

test('mobile Back from a task opened on a project focuses the project heading', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1_280) >= 1_280, 'below-xl focus behavior');
  await installDefaultBoard(page);
  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' })
    .getByRole('button', { name: project.name, exact: true }).click();
  const projectHeading = page.getByRole('heading', { name: project.name, exact: true });
  await expect(projectHeading).toBeVisible();

  await page.getByRole('table', { name: 'Active Thread Pipeline' })
    .getByRole('button', { name: task.title, exact: true }).click();
  await expect(page).toHaveURL(/#\/tasks\/task-recovery$/u);
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/#\/project\/project-cicada$/u);
  await expect(projectHeading).toBeFocused();
});

test('editing the hash directly updates the view', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();

  await page.evaluate((projectId) => {
    window.location.hash = `#/project/${encodeURIComponent(projectId)}`;
  }, project.projectId);

  await expect(page).toHaveURL(/#\/project\/project-cicada$/u);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
});

test('canonicalising an unknown hash preserves backward and forward history', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' })
    .getByRole('button', { name: project.name, exact: true }).click();
  await expect(page).toHaveURL(/#\/project\/project-cicada$/u);

  const historyLengthBeforeHashEdit = await page.evaluate(() => window.history.length);
  await page.evaluate(() => {
    window.location.hash = '#/garbage';
  });

  await expect(page).toHaveURL(/#\/tasks$/u);
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  const historyLengthAfterCanonicalisation = await page.evaluate(() => window.history.length);
  expect(historyLengthAfterCanonicalisation).toBe(historyLengthBeforeHashEdit + 1);

  await page.goBack();
  await expect(page).toHaveURL(/#\/project\/project-cicada$/u);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLengthAfterCanonicalisation);

  await page.goForward();
  await expect(page).toHaveURL(/#\/tasks$/u);
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
});

test('a missing project route is corrected immediately against the loaded snapshot', async ({ page }) => {
  await installDefaultBoard(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = '#/project/project-absent-from-loaded-snapshot';
  });

  await expect(page).toHaveURL(/#\/tasks$/u, { timeout: 1_000 });
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toHaveCount(0);
});

test('the default app reads real board state and assignment is an explicit human wake', async ({ page }) => {
  let assignment: Record<string, unknown> | null = null;
  await page.route('**/board-api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
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
  let companyRail = await openCompanyRail(page);
  await expect(companyRail.getByText('Cicada Tech Systems LLC.', { exact: true })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Task List' })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Automation' })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Ledgers' })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Documents' })).toHaveCount(0);
  await expect(companyRail.getByRole('button', { name: /billing-engineer/u })).toBeVisible();
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /billing-engineer/u })).toHaveCount(0);
  await companyRail.getByRole('button', { name: 'Task List' }).click();
  await page.getByRole('button', { name: /Improve invoice recovery/u }).click();
  await page.getByRole('button', { name: 'Assign and wake agent' }).click();

  expect(assignment).toEqual({
    version: 1,
    assignedAgentId: 'billing-engineer',
    assignedRole: 'engineer',
    status: 'queued',
  });
});

test('a failed assignment stays actionable while successful polls keep the board connected', async ({ page }) => {
  let projectReads = 0;
  let boardReads = 0;
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      projectReads += 1;
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      boardReads += 1;
      await route.fulfill({
        json: {
          ...board(),
          tasks: [{ ...task, objective: `${task.objective}\n\nSnapshot revision ${boardReads}` }],
        },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${task.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${task.taskId}` && request.method() === 'PATCH') {
      await route.fulfill({
        status: 409,
        json: { error: { code: 'TASK_VERSION_CONFLICT', message: 'Task version changed' } },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Task List', exact: true })).toBeVisible();
  await expect.poll(() => projectReads).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: /Improve invoice recovery backlog/u }).click();

  const taskDetail = page.getByRole('region', { name: 'Task details: Improve invoice recovery' });
  await taskDetail.getByRole('button', { name: 'Assign and wake agent' }).click();
  const actionError = taskDetail.getByRole('alert');
  await expect(actionError).toContainText('This task changed in another session. Refresh before trying again.');
  await expect(page.getByText('Task board unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Action errors')).toHaveCount(0);

  const readsBeforePolling = projectReads;
  const firstVisibleRevision = await renderedSnapshotRevision(taskDetail);
  await triggerVisiblePoll(page);
  await expect.poll(() => projectReads).toBeGreaterThanOrEqual(readsBeforePolling + 1);
  await expect.poll(() => renderedSnapshotRevision(taskDetail)).toBeGreaterThan(firstVisibleRevision);

  const readsBeforeSecondPoll = projectReads;
  const secondVisibleRevision = await renderedSnapshotRevision(taskDetail);
  await triggerVisiblePoll(page);
  await expect.poll(() => projectReads).toBeGreaterThan(readsBeforeSecondPoll);
  await expect.poll(() => renderedSnapshotRevision(taskDetail)).toBeGreaterThan(secondVisibleRevision);
  await expect(actionError).toContainText('This task changed in another session. Refresh before trying again.');
  await expect(page.getByText('Task board unavailable', { exact: true })).toHaveCount(0);

  await taskDetail.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(taskDetail.getByRole('alert')).toHaveCount(0);
});

test('creating a task requires and records one explicit project with priority', async ({ page }) => {
  let createdRequest: Record<string, unknown> | null = null;
  let createdIdempotencyKey: string | undefined;
  let createAttempts = 0;
  let workItems: Record<string, unknown>[] = [];
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'GET') {
      await route.fulfill({ json: { workItems } });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'POST') {
      createAttempts += 1;
      if (createAttempts === 1) {
        await route.fulfill({
          status: 400,
          json: { error: { code: 'PROJECT_REQUIRED', message: 'Choose the project again.' } },
        });
        return;
      }
      createdRequest = request.postDataJSON() as Record<string, unknown>;
      createdIdempotencyKey = request.headers()['idempotency-key'];
      const createdWorkItem = {
        apiVersion,
        workItemId: 'work-item-invoice-clarity',
        ...createdRequest,
        refinedObjective: null,
        resolvedProjectId: project.projectId,
        planningTaskId: null,
        state: 'queued',
        currentStage: 'refinement',
        createdBy: 'human:operator',
        version: 1,
        createdAt: '2026-07-19T18:16:00.000Z',
        updatedAt: '2026-07-19T18:16:00.000Z',
        endedAt: null,
        cancelledReason: null,
        archivedAt: null,
        transitions: [{
          fromState: null,
          toState: 'queued',
          actorType: 'human',
          actorId: 'human:operator',
          createdAt: '2026-07-19T18:16:00.000Z',
        }],
      };
      workItems = [createdWorkItem];
      await route.fulfill({ status: 201, json: { workItem: createdWorkItem } });
      return;
    }
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
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  const taskListActions = page.getByRole('group', { name: 'Task list actions' });
  await taskListActions.getByRole('button', { name: 'Add task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a task' });
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await expect(taskListActions).toBeVisible();
    await expect(page.getByTestId('modal-scrim')).toHaveCount(0);
  }
  const taskPrompt = dialog.getByRole('textbox', { name: 'Task', exact: true });
  const taskType = dialog.getByLabel('Task type', { exact: true });
  await expect(taskPrompt).toHaveCount(1);
  await expect(taskType).toHaveCount(1);
  await expect(taskType).toHaveValue('standard');
  await expect(dialog.getByLabel('Priority')).toHaveValue('normal');
  await expect(dialog.getByLabel('Project')).toHaveValue('');
  await expect(dialog.getByRole('option', { name: 'Auto' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Choose a project' })).toBeDisabled();
  await taskPrompt.fill('Make invoice recovery clear\nCustomers should know what to do after a failed payment.');
  await expect(dialog.getByRole('button', { name: 'Choose a project' })).toBeDisabled();
  await dialog.getByLabel('Project').selectOption(project.projectId);
  await dialog.getByRole('button', { name: 'Submit task' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Check this change: Choose the project again.');
  await expect(dialog.getByRole('button', { name: 'Dismiss error' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await discardDirtyDialog(page);
  await expect(page.getByRole('alert').filter({ hasText: 'Check this change: Choose the project again.' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);

  await taskListActions.getByRole('button', { name: 'Add task' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await taskPrompt.fill('Make invoice recovery clear\nCustomers should know what to do after a failed payment.');
  await dialog.getByLabel('Project').selectOption(project.projectId);
  await dialog.getByRole('button', { name: 'Submit task' }).click();
  await expect.poll(() => createdRequest).not.toBeNull();

  expect(createdRequest).toEqual({
    originalRequest: 'Make invoice recovery clear\nCustomers should know what to do after a failed payment.',
    priority: 'normal',
    taskType: 'standard',
    projectTarget: { mode: 'explicit', projectId: project.projectId },
  });
  expect(createdIdempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
  await expect(page.getByRole('heading', { name: 'Automation intake' })).toBeVisible();
  const intakeRow = page.getByRole('button', { name: /Make invoice recovery clear/u });
  await expect(intakeRow.getByText('Queued', { exact: true })).toBeVisible();
  await expect(intakeRow.getByText(project.name, { exact: true })).toBeVisible();
});

test('work-item detail resolves planning input, confirms a workflow, archives completion, and cancels another intake', async ({ page }) => {
  const planningTaskId = 'task-plan-work-item-detail';
  const questionId = 'question-plan-work-item-detail';
  const planRevisionId = 'plan-work-item-detail';
  let primaryWorkItem: Record<string, unknown> | null = null;
  let cancellableWorkItem: Record<string, unknown> | null = null;
  let createCount = 0;
  let planningAnswered = false;
  let planConfirmed = false;
  let workflowCompleted = false;
  let answerAttempts = 0;
  let confirmAttempts = 0;
  let workItemListRequests = 0;
  let answerRequest: Record<string, unknown> | null = null;
  let confirmRequest: Record<string, unknown> | null = null;
  let rejectRequest: Record<string, unknown> | null = null;
  let archiveRequest: Record<string, unknown> | null = null;
  let cancelRequest: Record<string, unknown> | null = null;
  let rejectAttempts = 0;
  let archiveAttempts = 0;
  let cancelAttempts = 0;
  let primaryTransitions: Record<string, unknown>[] = [];
  let cancellableTransitions: Record<string, unknown>[] = [];

  const planningTask = () => ({
    ...task,
    taskId: planningTaskId,
    title: 'Plan workflow: Prepare a customer recovery workflow',
    objective: 'Prepare a customer recovery workflow with an operator-approved plan.',
    acceptanceCriteria: 'Return a concise workflow plan with explicit dependencies.',
    requiresReview: false,
    status: planningAnswered ? 'completed' : 'blocked',
    assignedAgentId: manager.agentId,
    assignedRole: 'manager',
    expectedAgentMinutes: 15,
    estimateRecordedAt: '2026-07-19T18:17:00.000Z',
    orderKey: 1_000,
    startedAt: '2026-07-19T18:17:00.000Z',
    expectedCompletedAt: null,
    endedAt: planningAnswered ? '2026-07-19T18:19:00.000Z' : null,
    result: planningAnswered ? 'Proposed a two-node customer recovery workflow.' : null,
    version: planningAnswered ? 3 : 2,
    createdAt: '2026-07-19T18:17:00.000Z',
    updatedAt: planningAnswered ? '2026-07-19T18:19:00.000Z' : '2026-07-19T18:18:00.000Z',
  });
  const question = () => ({
    apiVersion,
    questionId,
    projectId: project.projectId,
    taskId: planningTaskId,
    agentId: manager.agentId,
    runId: 'run-plan-work-item-detail',
    question: 'Should the recovery workflow preserve the current customer-facing retry copy?',
    status: planningAnswered ? 'answered' : 'open',
    answer: planningAnswered ? 'Yes, preserve the current retry copy.' : null,
    askedAt: '2026-07-19T18:18:00.000Z',
    answeredAt: planningAnswered ? '2026-07-19T18:19:00.000Z' : null,
    answeredBy: planningAnswered ? 'human:operator' : null,
    version: planningAnswered ? 2 : 1,
  });
  const plan = () => ({
    apiVersion,
    planRevisionId,
    workItemId: String(primaryWorkItem?.workItemId),
    revision: 1,
    objective: 'Preserve retry copy while making recovery observable.',
    assumptions: ['The existing retry copy remains approved.'],
    acceptanceCriteria: ['Recovery behavior is tested and independently verified.'],
    projectId: project.projectId,
    skillDigests: {},
    state: planConfirmed ? 'confirmed' : 'proposed',
    createdBy: manager.agentId,
    confirmedBy: planConfirmed ? 'human:operator' : null,
    createdAt: '2026-07-19T18:19:00.000Z',
    confirmedAt: planConfirmed ? '2026-07-19T18:20:00.000Z' : null,
  });
  const workflowNodes = () => [{
    apiVersion,
    nodeId: 'node-research-recovery',
    planRevisionId,
    projectId: project.projectId,
    title: 'Research recovery failures',
    objective: 'Trace the failed-payment recovery path.',
    acceptanceCriteria: ['The failure path is documented.'],
    dependencyNodeIds: [],
    stageTemplate: ['research', 'verification'],
    currentStage: planConfirmed ? 'research' : null,
    state: planConfirmed ? 'active' : 'pending',
    version: planConfirmed ? 2 : 1,
    createdAt: '2026-07-19T18:19:00.000Z',
    updatedAt: planConfirmed ? '2026-07-19T18:20:00.000Z' : '2026-07-19T18:19:00.000Z',
  }, {
    apiVersion,
    nodeId: 'node-implement-recovery',
    planRevisionId,
    projectId: project.projectId,
    title: 'Implement recovery guidance',
    objective: 'Make the retry path clear and observable.',
    acceptanceCriteria: ['Focused checks pass.'],
    dependencyNodeIds: ['node-research-recovery'],
    stageTemplate: ['implementation', 'testing', 'verification'],
    currentStage: null,
    state: 'pending',
    version: 1,
    createdAt: '2026-07-19T18:19:00.000Z',
    updatedAt: '2026-07-19T18:19:00.000Z',
  }];
  const workflow = () => ({ plans: [plan()], nodes: workflowNodes(), handoffs: [], events: [] });

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === '/board-api/v1/work-items' && method === 'GET') {
      workItemListRequests += 1;
      if (
        workflowCompleted
        && primaryWorkItem
        && primaryWorkItem.archivedAt === null
        && primaryWorkItem.state !== 'merged'
      ) {
        primaryTransitions = [...primaryTransitions, {
          fromState: 'planning',
          toState: 'plan_approval',
          actorType: 'agent',
          actorId: manager.agentId,
          createdAt: '2026-07-19T18:25:00.000Z',
        }, {
          fromState: 'plan_approval',
          toState: 'implementing',
          actorType: 'system',
          actorId: 'system:workflow',
          createdAt: '2026-07-19T18:26:00.000Z',
        }, {
          fromState: 'implementing',
          toState: 'verifying',
          actorType: 'system',
          actorId: 'system:workflow',
          createdAt: '2026-07-19T18:27:00.000Z',
        }, {
          fromState: 'verifying',
          toState: 'reviewing',
          actorType: 'system',
          actorId: 'system:workflow',
          createdAt: '2026-07-19T18:28:00.000Z',
        }, {
          fromState: 'reviewing',
          toState: 'merged',
          actorType: 'system',
          actorId: 'system:workflow',
          createdAt: '2026-07-19T18:30:00.000Z',
        }];
        primaryWorkItem = {
          ...primaryWorkItem,
          state: 'merged',
          currentStage: null,
          version: 11,
          updatedAt: '2026-07-19T18:30:00.000Z',
          endedAt: '2026-07-19T18:30:00.000Z',
          transitions: primaryTransitions,
        };
      }
      const workItems = [primaryWorkItem, cancellableWorkItem]
        .filter((item): item is Record<string, unknown> => item !== null && item.archivedAt === null);
      await route.fulfill({ json: { workItems } });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items' && method === 'POST') {
      createCount += 1;
      const input = request.postDataJSON() as Record<string, unknown>;
      const common = {
        apiVersion,
        originalRequest: input.originalRequest,
        refinedObjective: null,
        priority: input.priority,
        taskType: input.taskType,
        projectTarget: input.projectTarget,
        resolvedProjectId: project.projectId,
        currentStage: 'planning',
        createdBy: 'human:operator',
        createdAt: '2026-07-19T18:16:00.000Z',
        updatedAt: '2026-07-19T18:18:00.000Z',
        endedAt: null,
        cancelledReason: null,
        archivedAt: null,
      };
      if (createCount === 1) {
        primaryTransitions = [{
          fromState: null,
          toState: 'queued',
          actorType: 'human',
          actorId: 'human:operator',
          createdAt: '2026-07-19T18:16:00.000Z',
        }, {
          fromState: 'queued',
          toState: 'planning',
          actorType: 'system',
          actorId: 'system:planning',
          createdAt: '2026-07-19T18:17:00.000Z',
        }, {
          fromState: 'planning',
          toState: 'parked',
          actorType: 'agent',
          actorId: manager.agentId,
          createdAt: '2026-07-19T18:18:00.000Z',
        }];
        primaryWorkItem = {
          ...common,
          workItemId: 'work-item-detail-primary',
          planningTaskId,
          refinedObjective: 'Preserve retry copy while making recovery observable.',
          state: 'parked',
          version: 3,
          transitions: primaryTransitions,
        };
        await route.fulfill({ status: 201, json: { workItem: primaryWorkItem } });
      } else {
        cancellableTransitions = [{
          fromState: null,
          toState: 'queued',
          actorType: 'human',
          actorId: 'human:operator',
          createdAt: '2026-07-19T18:32:00.000Z',
        }];
        cancellableWorkItem = {
          ...common,
          workItemId: 'work-item-detail-cancel',
          planningTaskId: null,
          state: 'queued',
          currentStage: 'refinement',
          version: 1,
          createdAt: '2026-07-19T18:32:00.000Z',
          updatedAt: '2026-07-19T18:32:00.000Z',
          transitions: cancellableTransitions,
        };
        await route.fulfill({ status: 201, json: { workItem: cancellableWorkItem } });
      }
      return;
    }
    if (url.pathname === `/board-api/v1/plans/${planRevisionId}/reject` && method === 'POST') {
      rejectAttempts += 1;
      rejectRequest = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 409,
        json: { error: { code: 'WORK_ITEM_VERSION_CONFLICT', message: 'Work item changed' } },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/work-items/work-item-detail-primary` && method === 'PATCH') {
      const input = request.postDataJSON() as Record<string, unknown>;
      archiveAttempts += 1;
      if (archiveAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'WORK_ITEM_VERSION_CONFLICT', message: 'Work item changed' } },
        });
        return;
      }
      archiveRequest = input;
      primaryWorkItem = {
        ...primaryWorkItem!,
        version: 12,
        updatedAt: '2026-07-19T18:31:00.000Z',
        archivedAt: '2026-07-19T18:31:00.000Z',
      };
      await route.fulfill({ json: { workItem: primaryWorkItem } });
      return;
    }
    if (url.pathname === `/board-api/v1/work-items/work-item-detail-cancel` && method === 'PATCH') {
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'WORK_ITEM_VERSION_CONFLICT', message: 'Work item changed' } },
        });
        return;
      }
      cancelRequest = request.postDataJSON() as Record<string, unknown>;
      cancellableTransitions = [...cancellableTransitions, {
        fromState: 'queued',
        toState: 'abandoned',
        actorType: 'human',
        actorId: 'human:operator',
        createdAt: '2026-07-19T18:34:00.000Z',
      }];
      cancellableWorkItem = {
        ...cancellableWorkItem!,
        state: 'abandoned',
        currentStage: null,
        version: 2,
        updatedAt: '2026-07-19T18:34:00.000Z',
        endedAt: '2026-07-19T18:34:00.000Z',
        cancelledReason: String(cancelRequest.reason),
        transitions: cancellableTransitions,
      };
      await route.fulfill({ json: { workItem: cancellableWorkItem } });
      return;
    }
    if (url.pathname === `/board-api/v1/questions/${questionId}/answer` && method === 'POST') {
      answerAttempts += 1;
      answerRequest = request.postDataJSON() as Record<string, unknown>;
      if (answerAttempts === 1) {
        await route.fulfill({
          status: 503,
          json: { error: { code: 'BOARD_UNAVAILABLE', message: 'The planning answer could not be saved.' } },
        });
        return;
      }
      planningAnswered = true;
      primaryTransitions = [...primaryTransitions, {
        fromState: 'parked',
        toState: 'planning',
        actorType: 'human',
        actorId: 'human:operator',
        createdAt: '2026-07-19T18:19:00.000Z',
      }, {
        fromState: 'planning',
        toState: 'plan_approval',
        actorType: 'agent',
        actorId: manager.agentId,
        createdAt: '2026-07-19T18:19:00.000Z',
      }];
      primaryWorkItem = {
        ...primaryWorkItem!,
        state: 'plan_approval',
        currentStage: 'planning',
        version: 5,
        updatedAt: '2026-07-19T18:19:00.000Z',
        transitions: primaryTransitions,
      };
      await route.fulfill({ json: { question: question(), duplicate: false } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/workflow` && method === 'GET') {
      await route.fulfill({ json: { workflow: workflow() } });
      return;
    }
    if (url.pathname === `/board-api/v1/plans/${planRevisionId}/confirm` && method === 'POST') {
      confirmAttempts += 1;
      confirmRequest = request.postDataJSON() as Record<string, unknown>;
      if (confirmAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'WORK_ITEM_ENDED', message: 'Work item has ended' } },
        });
        return;
      }
      planConfirmed = true;
      // Research-first confirmation keeps plan_approval (server's collapse rule):
      // stage/version move, no state transition row is recorded.
      primaryWorkItem = {
        ...primaryWorkItem!,
        state: 'plan_approval',
        currentStage: 'research',
        version: 6,
        updatedAt: '2026-07-19T18:20:00.000Z',
        transitions: primaryTransitions,
      };
      await route.fulfill({ json: { workflow: workflow() } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      const openQuestions = planningAnswered ? [] : primaryWorkItem ? [question()] : [];
      await route.fulfill({
        json: {
          ...board(),
          agents: [agent, manager],
          tasks: primaryWorkItem ? [planningTask()] : [],
          openQuestions,
          recentQuestions: planningAnswered ? [question()] : [],
        },
      });
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  const taskListActions = page.getByRole('group', { name: 'Task list actions' });
  await taskListActions.getByRole('button', { name: 'Add task' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add a task' });
  await dialog.getByLabel('Task', { exact: true }).fill('Prepare a customer recovery workflow');
  await dialog.getByLabel('Project').selectOption(project.projectId);
  await dialog.getByRole('button', { name: 'Submit task' }).click();

  const primaryRow = page.getByRole('article', { name: 'Work item: Preserve retry copy while making recovery observable.' });
  const primaryRowButton = primaryRow.getByRole('button', { name: /Parked/u });
  await primaryRowButton.click();
  await expect(page).toHaveURL(/#\/intake\/work-item-detail-primary$/u);
  const pane = page.getByRole('region', { name: 'Work-item details' });
  const paneHeading = pane.getByRole('heading', { name: 'Work-item details' });
  const belowXl = (page.viewportSize()?.width ?? 1_280) < 1_280;
  if (belowXl) await expect(paneHeading).toBeFocused();
  else await expect(primaryRowButton).toBeFocused();
  await expect(paneHeading).toBeVisible();
  await expect(pane.getByText('Should the recovery workflow preserve the current customer-facing retry copy?', { exact: true })).toBeVisible();
  await expect(pane.getByText(project.name, { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/#\/tasks$/u);
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  if (belowXl) await expect(primaryRowButton).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(/#\/intake\/work-item-detail-primary$/u);

  const answer = pane.getByLabel('Your answer');
  await answer.fill('Yes, preserve the current retry copy.');
  await pane.getByRole('button', { name: 'Answer and resume planning' }).click();
  await expect(pane.getByRole('alert').filter({ hasText: 'The planning answer could not be saved.' })).toBeVisible();
  await expect(answer).toHaveValue('Yes, preserve the current retry copy.');
  await pane.getByRole('button', { name: 'Answer and resume planning' }).click();
  await expect.poll(() => answerRequest).toEqual({ answer: 'Yes, preserve the current retry copy.', version: 1 });
  await expect.poll(() => answerAttempts).toBe(2);
  await expect(answer).toHaveCount(0);
  await expect(pane.getByRole('heading', { name: 'Proposed plan' })).toBeVisible();
  const researchNode = pane.getByRole('article', { name: 'Research recovery failures' });
  const implementationNode = pane.getByRole('article', { name: 'Implement recovery guidance' });
  await expect(researchNode.getByText('Research recovery failures', { exact: true })).toBeVisible();
  await expect(implementationNode.getByText('Implement recovery guidance', { exact: true })).toBeVisible();
  await expect(implementationNode.getByText('Research recovery failures', { exact: true })).toBeVisible();

  await pane.getByRole('button', { name: 'Reject plan' }).click();
  dialog = page.getByRole('dialog', { name: 'Reject proposed plan' });
  await dialog.getByLabel('Revision note').fill('The dependency ordering needs another pass.');
  await dialog.getByRole('button', { name: 'Reject and revise' }).click();
  await expect(dialog.getByRole('alert')).toContainText('This work item or plan changed in another session. Refresh before trying again.');
  await expect.poll(() => rejectRequest).toEqual({
    note: 'The dependency ordering needs another pass.',
    expectedState: 'proposed',
  });
  await expect.poll(() => rejectAttempts).toBe(1);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await discardDirtyDialog(page);
  await expect(page.getByRole('alert').filter({ hasText: 'This work item or plan changed in another session. Refresh before trying again.' })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Reject plan' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Keep proposed plan' }).click();

  const requestsBeforeConflict = workItemListRequests;
  await pane.getByRole('button', { name: 'Confirm plan' }).click();
  await expect(pane.getByRole('alert').filter({ hasText: 'This work item ended before the plan could be confirmed.' })).toBeVisible();
  await expect.poll(() => workItemListRequests).toBeGreaterThan(requestsBeforeConflict);
  await pane.getByRole('button', { name: 'Confirm plan' }).click();
  await expect.poll(() => confirmRequest).toEqual({ expectedState: 'proposed' });
  await expect.poll(() => confirmAttempts).toBe(2);
  await expect(pane.getByRole('group', { name: 'Current status' }).getByText('Plan review', { exact: true })).toBeVisible();

  workflowCompleted = true;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(pane.getByRole('group', { name: 'Current status' }).getByText('Done', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Archive', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Archive work item' });
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await expect(page.getByTestId('modal-scrim')).toHaveCount(0);
  }
  await dialog.getByRole('button', { name: 'Archive work item' }).click();
  await expect(dialog.getByRole('alert')).toContainText('This work item or plan changed in another session. Refresh before trying again.');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This work item or plan changed in another session. Refresh before trying again.' })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Archive work item' }).click();
  await expect.poll(() => archiveRequest).toEqual({ version: 11, action: 'archive' });
  await expect(page).toHaveURL(/#\/tasks$/u);
  await expect(primaryRow).toHaveCount(0);

  await taskListActions.getByRole('button', { name: 'Add task' }).click();
  dialog = page.getByRole('dialog', { name: 'Add a task' });
  await dialog.getByLabel('Task', { exact: true }).fill('Cancel this superseded intake');
  await dialog.getByLabel('Project').selectOption(project.projectId);
  await dialog.getByRole('button', { name: 'Submit task' }).click();
  const cancellableRow = page.getByRole('article', { name: 'Work item: Cancel this superseded intake' });
  await cancellableRow.getByRole('button', { name: /Queued/u }).click();
  await pane.getByRole('button', { name: 'Cancel work item' }).click();
  dialog = page.getByRole('dialog', { name: 'Cancel work item' });
  await dialog.getByLabel('Reason').fill('A newer request supersedes this intake.');
  await dialog.getByRole('button', { name: 'Cancel work item' }).click();
  await expect(dialog.getByRole('alert')).toContainText('This work item or plan changed in another session. Refresh before trying again.');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await discardDirtyDialog(page);
  await expect(page.getByRole('alert').filter({ hasText: 'This work item or plan changed in another session. Refresh before trying again.' })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Cancel work item' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByLabel('Reason').fill('A newer request supersedes this intake.');
  await dialog.getByRole('button', { name: 'Cancel work item' }).click();
  await expect.poll(() => cancelRequest).toEqual({
    version: 1,
    action: 'cancel',
    reason: 'A newer request supersedes this intake.',
  });
  await expect(pane.getByRole('group', { name: 'Current status' }).getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Cancellation reason' })).toBeVisible();
  await expect(pane.getByText('A newer request supersedes this intake.', { exact: true })).toBeVisible();
});

test('task details stay concise while showing a long description, agent estimate, and parallel phases', async ({ page }) => {
  const longDescription = [
    'Customers sometimes see an invoice fail after their bank has already approved a replacement payment method.',
    'Research the failure path across the billing UI and recovery API. Preserve the exact customer-facing explanation, even when it needs several paragraphs and detailed reproduction context.',
    'Plan the change, implement the recovery experience, run focused coverage in parallel where useful, and leave the final result ready for review.',
  ].join('\n\n');
  const phasedTask = {
    ...task,
    taskId: 'task-phased-recovery',
    title: 'Coordinate the invoice recovery rollout',
    objective: longDescription,
    status: 'in_progress',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    expectedAgentMinutes: 90,
    estimateRecordedAt: '2026-07-19T18:20:00.000Z',
    orderKey: 1_000,
    phases: [
      {
        apiVersion,
        phaseId: 'phase-research',
        projectId: project.projectId,
        taskId: 'task-phased-recovery',
        title: 'Trace the customer recovery path',
        stage: 'research',
        status: 'blocked',
        parallelGroup: null,
        orderKey: 1_000,
        startedAt: '2026-07-19T18:15:00.000Z',
        endedAt: null,
        version: 2,
        createdAt: '2026-07-19T18:15:00.000Z',
        updatedAt: '2026-07-19T18:25:00.000Z',
      },
      {
        apiVersion,
        phaseId: 'phase-plan',
        projectId: project.projectId,
        taskId: 'task-phased-recovery',
        title: 'Write the rollout plan',
        stage: 'planning',
        status: 'pending',
        parallelGroup: null,
        orderKey: 2_000,
        startedAt: null,
        endedAt: null,
        version: 1,
        createdAt: '2026-07-19T18:15:00.000Z',
        updatedAt: '2026-07-19T18:35:00.000Z',
      },
      {
        apiVersion,
        phaseId: 'phase-execution',
        projectId: project.projectId,
        taskId: 'task-phased-recovery',
        title: 'Implement the recovery experience',
        stage: 'execution',
        status: 'in_progress',
        parallelGroup: 'build-and-check',
        orderKey: 3_000,
        startedAt: '2026-07-19T18:35:00.000Z',
        endedAt: null,
        version: 2,
        createdAt: '2026-07-19T18:15:00.000Z',
        updatedAt: '2026-07-19T18:35:00.000Z',
      },
      {
        apiVersion,
        phaseId: 'phase-testing',
        projectId: project.projectId,
        taskId: 'task-phased-recovery',
        title: 'Run focused recovery coverage',
        stage: 'testing',
        status: 'in_progress',
        parallelGroup: 'build-and-check',
        orderKey: 4_000,
        startedAt: '2026-07-19T18:35:00.000Z',
        endedAt: null,
        version: 2,
        createdAt: '2026-07-19T18:15:00.000Z',
        updatedAt: '2026-07-19T18:35:00.000Z',
      },
      {
        apiVersion,
        phaseId: 'phase-review',
        projectId: project.projectId,
        taskId: 'task-phased-recovery',
        title: 'Review the customer impact',
        stage: 'review',
        status: 'pending',
        parallelGroup: null,
        orderKey: 5_000,
        startedAt: null,
        endedAt: null,
        version: 1,
        createdAt: '2026-07-19T18:15:00.000Z',
        updatedAt: '2026-07-19T18:15:00.000Z',
      },
    ],
    startedAt: '2026-07-19T18:15:00.000Z',
    expectedCompletedAt: '2026-07-19T19:50:00.000Z',
    version: 3,
    updatedAt: '2026-07-19T18:35:00.000Z',
  };

  await page.route('**/board-api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: { ...board(), tasks: [task, phasedTask, completedReferenceTask] } });
      return;
    }
    if (/^\/board-api\/v1\/tasks\/[^/]+\/messages$/u.test(url.pathname)) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  const estimatedRow = page.getByRole('button', { name: /Coordinate the invoice recovery rollout running/u });
  const unestimatedRow = page.getByRole('button', { name: /Improve invoice recovery backlog/u });
  const completedRow = page.getByRole('button', { name: /Invoice recovery outcome completed/u });
  await expect(estimatedRow).toBeVisible();
  await expect(unestimatedRow).not.toContainText('agent min');
  await expect(unestimatedRow).not.toContainText('Due');
  await expect(completedRow).not.toContainText('Due');
  expect(await unestimatedRow.evaluate((element) => Number.parseFloat(getComputedStyle(element).marginInlineStart))).toBeGreaterThan(0);
  const estimatedBox = await estimatedRow.boundingBox();
  const unestimatedBox = await unestimatedRow.boundingBox();
  expect(estimatedBox?.y).toBeLessThan(unestimatedBox?.y ?? 0);

  await estimatedRow.click();
  await expect(page.getByRole('heading', { name: phasedTask.title, exact: true })).toBeVisible();
  await expect(page.getByText('Current status', { exact: true })).toBeVisible();
  await expect(page.getByText('running', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Description', { exact: true })).toBeVisible();
  await expect(page.getByText(longDescription, { exact: true })).toBeVisible();
  await expect(page.getByText('About 90 agent min', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Phases', exact: true })).toBeVisible();
  await expect(page.getByText('Trace the customer recovery path', { exact: true })).toBeVisible();
  await expect(page.getByText('planning', { exact: true })).toBeVisible();
  await expect(page.getByText('execution', { exact: true })).toBeVisible();
  await expect(page.getByText('testing', { exact: true })).toBeVisible();
  await expect(page.getByText('review', { exact: true })).toBeVisible();
  await expect(page.getByText('Parallel', { exact: true })).toHaveCount(2);
  await expect(page.getByLabel('Expected agent time')).toHaveCount(0);
  await expect(page.getByText('Progress record', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Allowed workspace scope', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Agent estimate', { exact: true })).toHaveCount(0);
  await expect(page.getByText(task.acceptanceCriteria, { exact: true })).toHaveCount(0);
});

test('project intake lazily creates a manager whose lane token can be rotated and shown once', async ({ page }) => {
  const importedProject = {
    ...project,
    projectId: 'project-payment-tools',
    name: 'payment-tools',
    description: '/workspace/payment-tools',
  };
  let createdProject: Record<string, unknown> | null = null;
  let projectCreated = false;
  let projectCreateAttempts = 0;
  let taskSubmitted = false;
  let agentCreateRequests = 0;
  let managerVersion = 1;
  let rotationAttempts = 0;
  let createdWorkItemRequest: Record<string, unknown> | null = null;
  const rotatedToken = 'rotated-payment-tools-manager-token-012345678901';
  const lazyManager = {
    ...agent,
    agentId: 'payment-tools-manager',
    projectId: importedProject.projectId,
    role: 'manager',
    area: importedProject.name,
    mission: 'Refine incoming payment-tools work and plan durable workflows.',
    model: 'auto',
    status: 'ready',
    workerConnection: null,
    lastError: null,
    version: managerVersion,
    createdAt: '2026-08-09T20:01:00.000Z',
  };
  const planningTask = {
    ...task,
    taskId: 'task-plan-payment-tools',
    projectId: importedProject.projectId,
    title: 'Plan workflow: Add a health check to payment tools',
    objective: 'Add a health check to payment tools',
    acceptanceCriteria: 'Return a concise workflow plan.',
    workspaceRefs: [],
    status: 'queued',
    assignedAgentId: lazyManager.agentId,
    assignedRole: 'manager',
    requiresReview: false,
    version: 1,
    createdAt: '2026-08-09T20:01:00.000Z',
    updatedAt: '2026-08-09T20:01:00.000Z',
  };
  const createdWorkItem = {
    apiVersion,
    workItemId: 'work-item-payment-tools-first',
    originalRequest: 'Add a health check to payment tools',
    refinedObjective: null,
    priority: 'normal',
    taskType: 'standard',
    projectTarget: { mode: 'explicit', projectId: importedProject.projectId },
    resolvedProjectId: importedProject.projectId,
    planningTaskId: planningTask.taskId,
    state: 'planning',
    currentStage: 'planning',
    createdBy: 'human:operator',
    version: 2,
    createdAt: '2026-08-09T20:01:00.000Z',
    updatedAt: '2026-08-09T20:01:00.000Z',
    endedAt: null,
    cancelledReason: null,
    archivedAt: null,
    transitions: [{
      fromState: null,
      toState: 'queued',
      actorType: 'human',
      actorId: 'human:operator',
      createdAt: '2026-08-09T20:01:00.000Z',
    }, {
      fromState: 'queued',
      toState: 'planning',
      actorType: 'system',
      actorId: 'system:planning',
      createdAt: '2026-08-09T20:01:00.000Z',
    }],
  };
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/host/project-roots' && request.method() === 'GET') {
      await route.fulfill({ json: { roots: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/host/directories' && request.method() === 'GET' && !url.searchParams.has('path')) {
      await route.fulfill({
        json: { listing: { path: '/workspace', parent: null, entries: [], truncated: false } },
      });
      return;
    }
    if (url.pathname === '/board-api/v1/host/directories' && request.method() === 'GET' && url.searchParams.get('path') === '/workspace/payment-tools') {
      await route.fulfill({
        status: 403,
        json: { error: { code: 'HOST_PATH_OUTSIDE_ROOTS', message: 'The folder is outside the browsable area' } },
      });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'GET') {
      await route.fulfill({ json: { workItems: taskSubmitted ? [createdWorkItem] : [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'POST') {
      createdWorkItemRequest = request.postDataJSON() as Record<string, unknown>;
      taskSubmitted = true;
      await route.fulfill({ status: 201, json: { workItem: createdWorkItem } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects' && request.method() === 'POST') {
      projectCreateAttempts += 1;
      if (projectCreateAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'PROJECT_PATH_CONFLICT', message: 'Project path changed' } },
        });
        return;
      }
      createdProject = request.postDataJSON() as Record<string, unknown>;
      projectCreated = true;
      await route.fulfill({ status: 201, json: { project: importedProject } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${importedProject.projectId}/agents` && request.method() === 'POST') {
      agentCreateRequests += 1;
      await route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_AGENT_CREATE', message: 'Identity must be lazy' } } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: projectCreated ? [project, importedProject] : [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: board() });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${importedProject.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          project: importedProject,
          agents: taskSubmitted ? [{ ...lazyManager, version: managerVersion }] : [],
          tasks: taskSubmitted ? [planningTask] : [],
          recentEvents: taskSubmitted ? [{
            apiVersion,
            eventId: 'event-payment-tools-manager-created',
            projectId: importedProject.projectId,
            taskId: null,
            actorType: 'system',
            actorId: 'system:lazy-agent-identity',
            eventType: 'agent_profile_created',
            data: { agentId: lazyManager.agentId, role: 'manager' },
            createdAt: lazyManager.createdAt,
          }] : [],
        },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${planningTask.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/agents/${lazyManager.agentId}/rotate-token` && request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({ version: managerVersion });
      rotationAttempts += 1;
      if (rotationAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'AGENT_VERSION_CONFLICT', message: 'Agent version changed' } },
        });
        return;
      }
      managerVersion += 1;
      await route.fulfill({
        json: { agent: { ...lazyManager, version: managerVersion }, token: rotatedToken },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${task.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Add project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project folder' }).fill('/workspace/payment-tools/');
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await dialog.getByRole('button', { name: 'Add anyway' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The board changed in another session. Refresh before trying again.');
  await expect(dialog.getByRole('button', { name: 'Dismiss error' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await discardDirtyDialog(page);
  await expect(page.getByRole('alert').filter({ hasText: 'The board changed in another session. Refresh before trying again.' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add project' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Project folder' }).fill('/workspace/payment-tools/');
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await dialog.getByRole('button', { name: 'Add anyway' }).click();
  await expect.poll(() => createdProject).not.toBeNull();

  expect(createdProject).toEqual({ name: 'payment-tools', description: '/workspace/payment-tools' });
  expect(agentCreateRequests).toBe(0);

  await page.getByRole('button', { name: 'Add task' }).click();
  const taskDialog = page.getByRole('dialog', { name: 'Add a task' });
  await taskDialog.getByRole('textbox', { name: 'Task', exact: true }).fill(createdWorkItem.originalRequest);
  await taskDialog.getByLabel('Project').selectOption(importedProject.projectId);
  await taskDialog.getByRole('button', { name: 'Submit task' }).click();
  await expect.poll(() => createdWorkItemRequest).not.toBeNull();
  expect(createdWorkItemRequest).toEqual({
    originalRequest: createdWorkItem.originalRequest,
    priority: 'normal',
    taskType: 'standard',
    projectTarget: { mode: 'explicit', projectId: importedProject.projectId },
  });

  const companyRail = await openCompanyRail(page);
  const lazyManagerButton = companyRail
    .getByRole('navigation', { name: 'Projects and agents' })
    .getByRole('button', { name: /^payment-tools-manager\b/u });
  await expect(lazyManagerButton).toBeVisible();
  await lazyManagerButton.click();
  await expect(page.getByRole('heading', { name: 'Lane configuration' })).toBeVisible();
  const laneConfig = page.getByLabel(`Fleet lane configuration for ${lazyManager.agentId}`);
  await expect(laneConfig).toContainText('"agentId": "payment-tools-manager"');
  await expect(laneConfig).toContainText('"workingDirectory": "/absolute/path/to/repository"');
  await expect(laneConfig).toContainText('"provider": "<codex or claude>"');
  await expect(laneConfig).toContainText('<rotate token to reveal>');
  await expect(page.getByText(/replace the working-directory and provider placeholders/u)).toBeVisible();

  await page.getByRole('button', { name: 'Rotate token', exact: true }).click();
  const rotationDialog = page.getByRole('dialog', { name: 'Rotate agent token?' });
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await expect(page.getByTestId('modal-scrim')).toHaveCount(0);
  }
  await expect(rotationDialog).toContainText('disconnects any worker using the current token');
  await rotationDialog.getByRole('button', { name: 'Rotate token', exact: true }).click();
  await expect(rotationDialog.getByRole('alert')).toContainText('The board changed in another session. Refresh before trying again.');
  await expect(rotationDialog.getByRole('button', { name: 'Dismiss error' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);
  await rotationDialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The board changed in another session. Refresh before trying again.' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Action errors' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Rotate token', exact: true }).click();
  await expect(rotationDialog.getByRole('alert')).toHaveCount(0);
  await rotationDialog.getByRole('button', { name: 'Rotate token', exact: true }).click();
  await expect(laneConfig).toContainText(rotatedToken);
  await expect(page.getByText('Token visible for this page session only.')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.startsWith('cicada.pendingAgentToken.')))).toEqual([]);

  await page.getByRole('textbox', { name: `Message ${lazyManager.agentId}` }).fill('Trigger an unanchored mutation error');
  await page.getByRole('button', { name: 'Send message' }).click();
  const toastViewport = page.getByRole('region', { name: 'Action errors' });
  await expect(toastViewport.getByRole('alert')).toContainText('Not found');
  const viewportBounds = await toastViewport.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      maxHeight: Number.parseFloat(styles.maxHeight),
      overflowY: styles.overflowY,
      viewportHeight: window.innerHeight,
    };
  });
  expect(viewportBounds.overflowY).toBe('auto');
  expect(viewportBounds.maxHeight).toBeLessThanOrEqual(viewportBounds.viewportHeight - 32);
});

test('agent pages stay chat-first while unavailable assignments remain durable', async ({ page }) => {
  const pointOfContactAgent = {
    ...agent,
    agentId: 'steward-poc',
    area: 'Company routing',
    mission: 'Act as the point of contact for every project.',
  };
  const readyAgent = {
    ...agent,
    agentId: 'ready-engineer',
    area: 'Invoice recovery',
    workerConnection: 'waiting_for_wake',
  };
  const workingAgent = {
    ...agent,
    agentId: 'working-engineer',
    area: 'Payment retries',
    status: 'running',
    workerConnection: 'watching_run',
  };
  const unavailableAgent = {
    ...agent,
    agentId: 'unavailable-engineer',
    area: 'Billing notifications',
    workerConnection: null,
  };
  const unavailableQueuedAgent = {
    ...agent,
    agentId: 'queued-unavailable-engineer',
    area: 'Billing exports',
    status: 'ready',
    workerConnection: null,
  };
  const workingTask = {
    ...task,
    taskId: 'task-payment-retries',
    title: 'Improve payment retry feedback',
    status: 'in_progress',
    assignedAgentId: workingAgent.agentId,
    assignedRole: 'engineer',
    startedAt: '2026-07-19T18:15:00.000Z',
    expectedCompletedAt: '2026-07-19T18:45:00.000Z',
    version: 2,
    updatedAt: '2026-07-19T18:15:00.000Z',
  };
  const unavailableQueuedTask = {
    ...task,
    taskId: 'task-billing-exports',
    title: 'Improve billing exports',
    status: 'queued',
    assignedAgentId: unavailableQueuedAgent.agentId,
    assignedRole: 'engineer',
    version: 2,
    updatedAt: '2026-07-19T18:14:00.000Z',
  };
  let assignableTask = { ...task };
  const taskPatches: Record<string, unknown>[] = [];
  const requestedPaths: string[] = [];

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requestedPaths.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          agents: [pointOfContactAgent, readyAgent, workingAgent, unavailableAgent, unavailableQueuedAgent],
          tasks: [assignableTask, workingTask, unavailableQueuedTask],
          recentRuns: [{
            apiVersion,
            runId: 'run-payment-retries',
            claimId: 'claim-payment-retries',
            projectId: project.projectId,
            agentId: workingAgent.agentId,
            wakeupId: 'wakeup-payment-retries',
            taskId: workingTask.taskId,
            status: 'active',
            startedAt: workingTask.startedAt,
            endedAt: null,
            result: null,
            heartbeatAt: null,
            runtime: null,
            runtimeVersion: null,
            model: null,
            promptsSha: null,
          }],
        },
      });
      return;
    }
    if (/^\/board-api\/v1\/tasks\/[^/]+\/messages$/u.test(url.pathname)) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${assignableTask.taskId}` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      taskPatches.push(body);
      assignableTask = {
        ...assignableTask,
        ...body,
        version: assignableTask.version + 1,
        updatedAt: '2026-07-19T18:16:00.000Z',
      };
      await route.fulfill({ json: { task: assignableTask } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');

  let companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /ready-engineer/u }).click();
  await expect(page.getByRole('heading', { name: 'ready-engineer', exact: true })).toBeVisible();
  await expect(page.getByText('No current task', { exact: true })).toBeVisible();
  await expect(page.getByText('No active phase', { exact: true })).toBeVisible();
  await expect(page.getByRole('log', { name: 'Chat history with ready-engineer' })).toBeVisible();
  await expect(page.getByText('Worker ready', { exact: true })).toHaveCount(0);

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /working-engineer/u }).click();
  await expect(page.getByRole('heading', { name: 'working-engineer', exact: true })).toBeVisible();
  await expect(page.getByText('Implementing', { exact: true })).toBeVisible();
  await expect(page.getByText('Phase not reported', { exact: true })).toBeVisible();
  await expect(page.getByText('Improve payment retry feedback', { exact: true })).toBeVisible();
  await expect(page.getByText('Worker connected', { exact: true })).toHaveCount(0);

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /^unavailable-engineer\b/u }).click();
  await expect(page.getByRole('heading', { name: 'unavailable-engineer', exact: true })).toBeVisible();
  await expect(page.getByText('No current task', { exact: true })).toBeVisible();

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: /^queued-unavailable-engineer\b/u }).click();
  await expect(page.getByRole('heading', { name: 'queued-unavailable-engineer', exact: true })).toBeVisible();
  await expect(page.getByText('Implementing', { exact: true })).toBeVisible();
  await expect(page.getByText('Improve billing exports', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Improve billing exports' }).click();
  await expect(page.getByText('Current status', { exact: true })).toBeVisible();
  await expect(page.getByText('queued', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Task List' }).click();
  await page.getByRole('button', { name: /Improve invoice recovery backlog/u }).click();
  await page.getByLabel('Assign agent').selectOption(workingAgent.agentId);
  await page.getByLabel('Assign agent').selectOption(unavailableAgent.agentId);
  await expect(page.getByRole('button', { name: 'Assign and wake agent' })).toBeEnabled();
  await page.getByRole('button', { name: 'Assign and wake agent' }).click();

  await expect.poll(() => taskPatches).toHaveLength(1);
  expect(taskPatches[0]).toEqual({
    version: 1,
    assignedAgentId: unavailableAgent.agentId,
    assignedRole: 'engineer',
    status: 'queued',
  });
  expect(requestedPaths.filter((path) => /heartbeat|readiness|presence|connections?/iu.test(path))).toEqual([]);
});

test('a project agent shows persistent chat with current stage, phase, and repeated loop', async ({ page }) => {
  const pointOfContactAgent = {
    ...agent,
    agentId: 'steward-poc',
    area: 'Company routing',
    mission: 'Act as the point of contact for every project.',
  };
  const projectAgent = {
    ...agent,
    agentId: 'recovery-engineer',
    area: 'Invoice recovery',
    status: 'running',
    workerConnection: 'watching_run',
  };
  const activeTask = {
    ...task,
    taskId: 'task-active-recovery',
    title: 'Make payment recovery self-service',
    status: 'in_progress',
    assignedAgentId: projectAgent.agentId,
    assignedRole: 'engineer',
    startedAt: '2026-07-19T18:10:00.000Z',
    version: 3,
    phases: [
      {
        apiVersion,
        phaseId: 'phase-execution-one',
        projectId: project.projectId,
        taskId: 'task-active-recovery',
        title: 'Implement recovery',
        stage: 'execution',
        status: 'in_progress',
        parallelGroup: null,
        orderKey: 1_000,
        startedAt: '2026-07-19T18:10:00.000Z',
        endedAt: null,
        version: 2,
        createdAt: '2026-07-19T18:10:00.000Z',
        updatedAt: '2026-07-19T18:20:00.000Z',
      },
      {
        apiVersion,
        phaseId: 'phase-review-one',
        projectId: project.projectId,
        taskId: 'task-active-recovery',
        title: 'Review recovery',
        stage: 'review',
        status: 'in_progress',
        parallelGroup: null,
        orderKey: 2_000,
        startedAt: '2026-07-19T18:20:00.000Z',
        endedAt: null,
        version: 2,
        createdAt: '2026-07-19T18:20:00.000Z',
        updatedAt: '2026-07-19T18:25:00.000Z',
      },
      {
        apiVersion,
        phaseId: 'phase-execution-two',
        projectId: project.projectId,
        taskId: 'task-active-recovery',
        title: 'Apply review feedback',
        stage: 'execution',
        status: 'in_progress',
        parallelGroup: null,
        orderKey: 3_000,
        startedAt: '2026-07-19T18:25:00.000Z',
        endedAt: null,
        version: 1,
        createdAt: '2026-07-19T18:25:00.000Z',
        updatedAt: '2026-07-19T18:25:00.000Z',
      },
    ],
    updatedAt: '2026-07-19T18:25:00.000Z',
  };
  const earlierPrompt = 'What did the first review find?';
  const earlierResult = 'The review found that recovery guidance needed a clearer next step.';
  const systemReviewPrompt = 'Check the first recovery implementation before the next iteration.';
  const hiddenSystemReviewContext = 'Hidden parent conversation must never render in the review bubble.';
  const systemReview = {
    ...task,
    taskId: 'task-system-review-history',
    kind: 'manager_review',
    requiredRole: 'manager',
    requiresReview: false,
    title: 'Review the initial recovery implementation',
    objective: `${systemReviewPrompt}${pocConversationContextMarker}Human: ${hiddenSystemReviewContext}${pocRoutingContextMarker}- Hidden project routing data`,
    status: 'completed',
    assignedAgentId: projectAgent.agentId,
    assignedRole: 'manager',
    orderKey: 500,
    createdAt: '2026-07-19T18:04:00.000Z',
    endedAt: '2026-07-19T18:04:30.000Z',
    version: 2,
    updatedAt: '2026-07-19T18:04:30.000Z',
  };
  const reassignedPrompt = 'Summarize the retry behavior inherited from the previous owner.';
  const hiddenReassignedContext = 'Hidden conversation from the previous owner must not render.';
  const reassignedQuery = {
    ...task,
    taskId: 'agent-query-reassigned-history',
    requiresReview: false,
    title: `Request for former-engineer: ${reassignedPrompt}`,
    objective: `${reassignedPrompt}${pocConversationContextMarker}Agent: ${hiddenReassignedContext}${pocRoutingContextMarker}- Hidden former-owner route`,
    status: 'completed',
    assignedAgentId: projectAgent.agentId,
    assignedRole: 'engineer',
    orderKey: 750,
    createdAt: '2026-07-19T18:04:45.000Z',
    endedAt: '2026-07-19T18:04:50.000Z',
    version: 2,
    updatedAt: '2026-07-19T18:04:50.000Z',
  };
  const earlierQuery = {
    ...task,
    taskId: 'agent-query-recovery-history',
    title: `Request for ${projectAgent.agentId}: ${earlierPrompt}`,
    requiresReview: false,
    objective: earlierPrompt,
    status: 'completed',
    assignedAgentId: projectAgent.agentId,
    assignedRole: 'engineer',
    createdAt: '2026-07-19T18:05:00.000Z',
    endedAt: '2026-07-19T18:09:00.000Z',
    result: earlierResult,
    version: 2,
    updatedAt: '2026-07-19T18:09:00.000Z',
  };
  const mutations: Record<string, unknown>[] = [];

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          agents: [pointOfContactAgent, projectAgent],
          tasks: [systemReview, reassignedQuery, earlierQuery, activeTask],
        },
      });
      return;
    }
    if (/^\/board-api\/v1\/tasks\/[^/]+\/messages$/u.test(url.pathname)) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/tasks` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      mutations.push(body);
      await route.fulfill({ status: 201, json: { task: { ...task, ...body, taskId: 'agent-query-recovery-next' } } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /recovery-engineer/u }).click();

  await expect(page.getByRole('heading', { name: 'recovery-engineer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: activeTask.title })).toBeVisible();
  await expect(page.getByText('Implementing', { exact: true })).toBeVisible();
  await expect(page.getByText('Phase · Apply review feedback', { exact: true })).toBeVisible();
  await expect(page.getByText('Loop 2', { exact: true })).toBeVisible();
  const history = page.getByRole('log', { name: 'Chat history with recovery-engineer' });
  await expect(history.getByText(earlierPrompt, { exact: true })).toBeVisible();
  await expect(history.getByText(earlierResult, { exact: true })).toBeVisible();
  await expect(history.getByText(activeTask.objective, { exact: true })).toBeVisible();
  await expect(history.getByText(systemReviewPrompt, { exact: true })).toBeVisible();
  await expect(history.getByText(reassignedPrompt, { exact: true })).toBeVisible();
  await expect(history.getByText(hiddenSystemReviewContext, { exact: false })).toHaveCount(0);
  await expect(history.getByText(hiddenReassignedContext, { exact: false })).toHaveCount(0);
  await expect(history.getByText('Hidden project routing data', { exact: false })).toHaveCount(0);
  await expect(history.getByText('Hidden former-owner route', { exact: false })).toHaveCount(0);
  await expect(history.getByText('System', { exact: true })).toBeVisible();
  await expect(page.getByText('Agent details', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Assigned tasks', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Worker connected', { exact: true })).toHaveCount(0);

  const nextPrompt = 'How are you addressing that review feedback?';
  const composer = page.getByLabel('Message recovery-engineer');
  await expect(composer).toHaveAttribute('placeholder', 'Message recovery-engineer…');
  await composer.fill(nextPrompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({
    title: `Request for ${projectAgent.agentId}: ${nextPrompt}`,
    requiresReview: false,
    objective: `${nextPrompt}${pocConversationContextMarker}Human: ${reassignedPrompt}\nHuman: ${earlierPrompt}\nAgent: ${earlierResult}\nHuman: ${activeTask.objective}`,
    workspaceRefs: activeTask.workspaceRefs,
    assignedAgentId: projectAgent.agentId,
  });
});

test('queued work can be reassigned or returned to backlog before claim without resume or interrupt', async ({ page }) => {
  const alternateAgent = {
    ...agent,
    agentId: 'recovery-engineer',
    area: 'Invoice recovery',
    mission: 'Keep failed invoice recovery clear and dependable.',
  };
  let currentTask = {
    ...task,
    status: 'queued',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    version: 2,
    updatedAt: '2026-07-19T18:12:00.000Z',
  };
  const taskPatches: Record<string, unknown>[] = [];
  const runCommands: string[] = [];

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          agents: [
            { ...agent, status: currentTask.assignedAgentId === agent.agentId ? 'ready' : 'idle' },
            { ...alternateAgent, status: currentTask.assignedAgentId === alternateAgent.agentId ? 'ready' : 'idle' },
          ],
          tasks: [currentTask],
          recentRuns: [],
        },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${currentTask.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${currentTask.taskId}` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      taskPatches.push(body);
      currentTask = {
        ...currentTask,
        ...body,
        version: currentTask.version + 1,
        updatedAt: '2026-07-19T18:13:00.000Z',
      };
      await route.fulfill({ json: { task: currentTask } });
      return;
    }
    if (url.pathname.includes('/resume') || url.pathname.includes('/interrupt')) {
      runCommands.push(`${request.method()} ${url.pathname}`);
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Improve invoice recovery queued/u }).click();
  await expect(page.getByText('Current status', { exact: true })).toBeVisible();
  await expect(page.getByText('queued', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);

  await page.getByLabel('Assign agent').selectOption(alternateAgent.agentId);
  await page.getByRole('button', { name: 'Reassign and wake agent' }).click();
  await expect.poll(() => taskPatches).toHaveLength(1);
  expect(taskPatches[0]).toEqual({
    version: 2,
    assignedAgentId: alternateAgent.agentId,
    assignedRole: 'engineer',
    status: 'queued',
  });
  await expect(page.getByRole('button', { name: 'Reassign and wake agent' })).toBeDisabled();

  await page.getByRole('button', { name: 'Return to backlog' }).click();
  await expect.poll(() => taskPatches).toHaveLength(2);
  expect(taskPatches[1]).toEqual({
    version: 3,
    assignedAgentId: null,
    assignedRole: null,
    status: 'backlog',
  });
  await expect(page.getByRole('button', { name: 'Assign and wake agent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to backlog' })).toHaveCount(0);
  expect(runCommands).toEqual([]);
});

test('a failed task offers retry, reassign, and an explained backlog rejection', async ({ page }) => {
  const alternateAgent = {
    ...agent,
    agentId: 'recovery-engineer',
    area: 'Invoice recovery',
    mission: 'Keep failed invoice recovery clear and dependable.',
  };
  const selectedAfterPollAgent = {
    ...agent,
    agentId: 'poll-safe-recovery-engineer',
    area: 'Webhook recovery',
    mission: 'Preserve explicit recovery choices while the board refreshes.',
  };
  let currentTask = {
    ...task,
    status: 'failed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    version: 4,
    updatedAt: '2026-07-19T18:12:00.000Z',
  };
  let reassignTask = {
    ...task,
    taskId: 'task-reassign-me',
    title: 'Restore webhook retries',
    status: 'failed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    version: 6,
    updatedAt: '2026-07-19T18:12:00.000Z',
  };
  const retryPosts: Record<string, unknown>[] = [];
  const backlogPosts: Record<string, unknown>[] = [];
  const reassignPatches: Record<string, unknown>[] = [];
  let backlogRejections = 0;
  let reorderAgentsOnPoll = false;
  let projectReads = 0;

  await page.clock.install({ time: new Date('2026-07-19T18:30:00.000Z') });
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      projectReads += 1;
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          agents: reorderAgentsOnPoll
            ? [
                { ...agent, status: 'idle' },
                { ...selectedAfterPollAgent, status: 'idle' },
                { ...alternateAgent, status: 'idle' },
              ]
            : [
                { ...agent, status: 'idle' },
                { ...alternateAgent, status: 'idle' },
                { ...selectedAfterPollAgent, status: 'idle' },
              ],
          tasks: [currentTask, reassignTask],
          recentRuns: [],
        },
      });
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${reassignTask.taskId}` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      reassignPatches.push(body);
      reassignTask = {
        ...reassignTask,
        ...body,
        version: reassignTask.version + 1,
        updatedAt: '2026-07-19T18:14:00.000Z',
      };
      await route.fulfill({ json: { task: reassignTask } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${currentTask.taskId}/retry` && request.method() === 'POST') {
      retryPosts.push(request.postDataJSON() as Record<string, unknown>);
      currentTask = { ...currentTask, status: 'queued', version: currentTask.version + 1, updatedAt: '2026-07-19T18:13:00.000Z' };
      await route.fulfill({ json: { task: currentTask } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${currentTask.taskId}/backlog` && request.method() === 'POST') {
      backlogPosts.push(request.postDataJSON() as Record<string, unknown>);
      backlogRejections += 1;
      await route.fulfill({
        status: 409,
        json: { error: { code: 'TASK_WORKFLOW_BOUND', message: 'Workflow stage tasks cannot return to the backlog.' } },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Improve invoice recovery failed/u }).click();
  const recovery = page.getByRole('region', { name: 'Task recovery actions' });
  await expect(recovery.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Reassign', exact: true })).toBeVisible();

  await recovery.getByRole('button', { name: 'Return to backlog' }).click();
  await expect.poll(() => backlogRejections).toBe(1);
  expect(backlogPosts[0]).toEqual({ version: 4 });
  await expect(page.getByText('Workflow stage tasks cannot return to backlog. Retry or reassign this task instead.')).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();

  await recovery.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => retryPosts).toHaveLength(1);
  expect(retryPosts[0]).toEqual({ version: 4 });
  await expect(page.getByRole('region', { name: 'Task recovery actions' })).toHaveCount(0);
  const belowXl = (page.viewportSize()?.width ?? 1_280) < 1_280;
  if (belowXl) await page.getByRole('button', { name: 'Back to task list' }).click();
  await expect(page.getByRole('button', { name: /Improve invoice recovery queued/u })).toBeVisible();

  await page.getByRole('button', { name: /Restore webhook retries failed/u }).click();
  const reassignRecovery = page.getByRole('region', { name: 'Task recovery actions' });
  const replacementPicker = reassignRecovery.getByLabel('Replacement agent');
  await replacementPicker.selectOption(selectedAfterPollAgent.agentId);
  const readsBeforePoll = projectReads;
  reorderAgentsOnPoll = true;
  await page.clock.runFor(5_100);
  await expect.poll(() => projectReads).toBeGreaterThan(readsBeforePoll);
  await expect(replacementPicker).toHaveValue(selectedAfterPollAgent.agentId);
  await reassignRecovery.getByRole('button', { name: 'Reassign', exact: true }).click();
  await expect.poll(() => reassignPatches).toHaveLength(1);
  expect(reassignPatches[0]).toEqual({
    version: 6,
    assignedAgentId: selectedAfterPollAgent.agentId,
    assignedRole: 'engineer',
    status: 'queued',
  });
  if (belowXl) await page.getByRole('button', { name: 'Back to task list' }).click();
  await expect(page.getByRole('button', { name: /Restore webhook retries queued/u })).toBeVisible();
});

test('the Cicada sidebar keeps the POC as a durable chat and sends one atomic wake', async ({ page }, testInfo) => {
  const explicitPointOfContactAgent = {
    ...agent,
    mission: 'Act as the point of contact for every project.',
  };
  const projectWithResources = {
    ...project,
    description: 'Summary: Agents own defined parts of the system and improve customer outcomes.\nGitHub: https://github.com/acme/cicada\nDocs: https://docs.example.com/cicada\nWorkspace: /workspace/billing',
  };
  const projectTask = {
    ...task,
    workspaceRefs: ['/workspace/billing', 'https://docs.example.com/invoice-recovery'],
  };
  const earlierPrompt = 'Which project owns failed invoice recovery?';
  const earlierResult = 'The Cicada platform billing engineer owns that customer recovery path.';
  const hiddenOlderPrompt = 'This older prompt should not be rendered inside the newer chat bubble.';
  const hiddenOlderResult = 'This older result is context, not the visible prompt for this task.';
  const earlierQuery = {
    ...task,
    taskId: 'agent-query-history',
    title: `Request for ${agent.agentId}: ${earlierPrompt}`,
    requiresReview: false,
    objective: `${earlierPrompt}${pocConversationContextMarker}Human: ${hiddenOlderPrompt}\nAgent: ${hiddenOlderResult}\n\nCompany routing map (use this only to identify the best project or agent):\n- Cicada platform: billing-engineer`,
    status: 'completed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    orderKey: 1_000,
    endedAt: '2026-07-19T18:14:00.000Z',
    result: earlierResult,
    version: 2,
    updatedAt: '2026-07-19T18:14:00.000Z',
  };
  const accumulatedTasks = Array.from({ length: 30 }, (_, index) => ({
    ...projectTask,
    taskId: `completed-pipeline-task-${index}`,
    title: `Completed customer workflow validation ${index + 1} with deliberately wrapping objective text`,
    status: 'completed',
    assignedAgentId: null,
    assignedRole: null,
    orderKey: 2_100 + index,
    endedAt: '2026-07-19T18:28:00.000Z',
    result: `Validation ${index + 1} completed.`,
    version: 2,
    updatedAt: '2026-07-19T18:28:00.000Z',
  }));
  const projectTasks = [earlierQuery, projectTask, ...accumulatedTasks];
  const mutations: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (request.method() !== 'GET') {
      mutations.push({
        method: request.method(),
        path: url.pathname,
        body: request.postDataJSON() as Record<string, unknown> | null,
      });
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [projectWithResources] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({ json: { ...board(), projects: [projectWithResources], agents: [explicitPointOfContactAgent, manager], tasks: projectTasks } });
      return;
    }
    if (url.pathname.startsWith('/board-api/v1/tasks/') && url.pathname.endsWith('/messages')) {
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
  await expect(companyRail.getByText('Cicada Tech Systems LLC.', { exact: true })).toBeVisible();
  await expect(companyRail.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(companyRail.getByText('Agent', { exact: true })).toBeVisible();
  await expect(companyRail.getByText('Point of contact', { exact: true })).toHaveCount(0);
  await expect(companyRail.getByRole('button', { name: /Board connection/u })).toHaveCount(0);
  await expect(companyRail.getByRole('button', { name: /billing-engineer/u })).toBeVisible();
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /billing-engineer/u })).toHaveCount(0);
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /release-manager/u })).toBeVisible();
  await companyRail.getByRole('button', { name: 'Collapse Cicada platform agents' }).click();
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /release-manager/u })).toHaveCount(0);
  await companyRail.getByRole('button', { name: 'Expand Cicada platform agents' }).click();
  await expect(companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: /release-manager/u })).toBeVisible();

  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: 'Cicada platform', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cicada platform' })).toBeVisible();
  const contextSidebar = page.getByRole('heading', { name: 'Context & Materials' }).locator('..');
  await expect(contextSidebar).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active Thread Pipeline' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent Activity & Visuals' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team' })).toHaveCount(0);
  const threadPipeline = page.getByRole('table', { name: 'Active Thread Pipeline' });
  await expect(threadPipeline.getByRole('columnheader', { name: 'Task Objective' })).toBeVisible();
  await expect(threadPipeline.getByText('completed', { exact: true }).first()).toBeVisible();
  await expect(threadPipeline.getByText('backlog', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project setup' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Docs & links' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Important Documents' })).toBeVisible();
  await expect(contextSidebar.getByRole('link')).toHaveCount(2);
  await expect(contextSidebar.getByRole('link', { name: /GitHub: https:\/\/github.com\/acme\/cicada/u })).toBeVisible();
  await expect(contextSidebar.getByRole('link', { name: /Documentation: https:\/\/docs.example.com\/cicada/u })).toBeVisible();
  await expect(contextSidebar.getByText('/workspace/billing', { exact: true })).toBeVisible();
  await expect(contextSidebar.getByRole('button', { name: /^Open /u })).toHaveCount(0);
  const moveGitHubLater = page.getByRole('button', { name: 'Move GitHub later' });
  await moveGitHubLater.focus();
  await moveGitHubLater.press('Enter');
  await expect(page.getByRole('button', { name: 'Move GitHub earlier' })).toBeVisible();
  const pipelineRows = page.getByRole('region', { name: 'Active thread pipeline rows' });
  await expect(pipelineRows).toBeVisible();
  expect(await pipelineRows.evaluate((element) => element.scrollHeight)).toBeGreaterThan(await pipelineRows.evaluate((element) => element.clientHeight));
  await expect(page.getByRole('button', { name: 'Interrupt all agents' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Compile Report' })).toBeInViewport({ ratio: 1 });
  const projectViewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(projectViewport.scrollWidth).toBeLessThanOrEqual(projectViewport.clientWidth);
  if (process.env.CAPTURE_UI === '1') {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('project-dashboard.png'), fullPage: true });
  }

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: /billing-engineer/u }).click();
  await expect(page.getByRole('heading', { name: 'Chat with billing-engineer', exact: true })).toBeVisible();
  const history = page.getByRole('log', { name: 'Chat history with billing-engineer' });
  await expect(history).toBeVisible();
  await expect(history.getByText(earlierPrompt, { exact: true })).toHaveCount(1);
  await expect(history.getByText(earlierResult, { exact: true })).toBeVisible();
  await expect(history.getByText(hiddenOlderPrompt, { exact: true })).toHaveCount(0);
  await expect(history.getByText(hiddenOlderResult, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Talk to billing-engineer' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No current task' })).toHaveCount(0);
  await expect(page.getByText('Worker ready', { exact: true })).toHaveCount(0);

  const prompt = 'Summarize what customers gain from the invoice recovery work.';
  const message = page.getByLabel('Message billing-engineer');
  await message.fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => mutations).toHaveLength(1);
  await expect(message).toHaveValue('');

  expect(mutations).toEqual([{
    method: 'POST',
    path: `/board-api/v1/projects/${project.projectId}/tasks`,
    body: {
      parentTaskId: null,
      title: `Request for ${agent.agentId}: ${prompt}`,
      requiresReview: false,
      objective: `${prompt}${pocConversationContextMarker}Human: ${earlierPrompt}\nAgent: ${earlierResult}\n\nCompany routing map (use this only to identify the best project or agent):\n- Cicada platform: billing-engineer (engineer, Billing and subscriptions), release-manager (manager, Release review)`,
      acceptanceCriteria: 'Return a concise answer or result. If more work is needed, propose child tasks for human approval; do not assign agents or deploy.',
      workspaceRefs: [],
      assignedAgentId: agent.agentId,
      assignedRole: 'engineer',
    },
  }]);
});

test('the POC chat answers its current task question before starting another query', async ({ page }) => {
  const explicitPointOfContactAgent = {
    ...agent,
    mission: 'Act as the point of contact for every project.',
  };
  const answeredPrompt = 'Confirm who should review the customer wording.';
  const answeredQuery = {
    ...task,
    taskId: 'agent-query-answered',
    title: `Request for ${agent.agentId}: Review the recovery wording`,
    requiresReview: false,
    objective: 'Review the recovery wording',
    status: 'completed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    orderKey: 1_000,
    endedAt: '2026-07-19T18:12:00.000Z',
    result: 'The wording is ready for customers.',
    version: 3,
    updatedAt: '2026-07-19T18:12:00.000Z',
  };
  const currentQuery = {
    ...task,
    taskId: 'agent-query-current',
    title: `Request for ${agent.agentId}: Prepare the recovery summary`,
    requiresReview: false,
    objective: 'Prepare the recovery summary',
    status: 'blocked',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    orderKey: 2_000,
    startedAt: '2026-07-19T18:13:00.000Z',
    version: 2,
    updatedAt: '2026-07-19T18:14:00.000Z',
  };
  const answeredQuestion = {
    apiVersion,
    questionId: 'question-answered',
    projectId: project.projectId,
    taskId: answeredQuery.taskId,
    agentId: agent.agentId,
    runId: 'run-answered',
    question: answeredPrompt,
    status: 'answered',
    answer: 'The release manager should review it.',
    askedAt: '2026-07-19T18:10:00.000Z',
    answeredAt: '2026-07-19T18:11:00.000Z',
    answeredBy: 'human:operator',
    version: 2,
  };
  let currentQuestion: HumanQuestion = {
    ...answeredQuestion,
    questionId: 'question-current',
    taskId: currentQuery.taskId,
    runId: 'run-current',
    question: 'Should the summary lead with the customer impact?',
    status: 'open',
    answer: null,
    askedAt: '2026-07-19T18:14:00.000Z',
    answeredAt: null,
    answeredBy: null,
    version: 1,
  };
  const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/board`) {
      await route.fulfill({
        json: {
          ...board(),
          agents: [{ ...explicitPointOfContactAgent, status: 'waiting_for_human' }],
          tasks: [answeredQuery, currentQuery],
          openQuestions: currentQuestion.status === 'open' ? [currentQuestion] : [],
          recentQuestions: [currentQuestion, answeredQuestion],
        },
      });
      return;
    }
    if (/^\/board-api\/v1\/tasks\/agent-query-(?:answered|current)\/messages$/u.test(url.pathname)) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/questions/${currentQuestion.questionId}/answer` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      mutations.push({ path: url.pathname, body });
      currentQuestion = {
        ...currentQuestion,
        status: 'answered',
        answer: String(body.answer),
        answeredAt: '2026-07-19T18:15:00.000Z',
        answeredBy: 'human:operator',
        version: 2,
      };
      await route.fulfill({ status: 201, json: { question: currentQuestion, duplicate: false } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${project.projectId}/tasks` && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      mutations.push({ path: url.pathname, body });
      await route.fulfill({ status: 201, json: { task: { ...task, ...body, taskId: 'agent-query-next' } } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: /billing-engineer/u }).click();

  const history = page.getByRole('log', { name: 'Chat history with billing-engineer' });
  await expect(history.getByText(answeredPrompt, { exact: true })).toBeVisible();
  await expect(history.getByText('The release manager should review it.', { exact: true })).toBeVisible();
  await expect(history.getByText(currentQuestion.question, { exact: true })).toBeVisible();

  const composer = page.getByLabel('Message billing-engineer');
  await expect(composer).toHaveAttribute('placeholder', 'Reply to the agent’s question…');
  await composer.fill('Yes, lead with the customer impact.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => mutations).toHaveLength(1);
  expect(mutations[0]).toEqual({
    path: '/board-api/v1/questions/question-current/answer',
    body: { answer: 'Yes, lead with the customer impact.', version: 1 },
  });
  await expect(history.getByText('Yes, lead with the customer impact.', { exact: true })).toBeVisible();
  await expect(composer).toHaveAttribute('placeholder', 'Ask a question or describe what you need…');

  await composer.fill('Now summarize the finished recommendation.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => mutations).toHaveLength(2);
  expect(mutations[1]?.path).toBe(`/board-api/v1/projects/${project.projectId}/tasks`);
});

test('a failed authoritative read never falls back to demo agents', async ({ page }) => {
  await page.route('**/board-api/v1/projects', (route) => route.fulfill({
    status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'Board is offline' } },
  }));
  await page.route('**/board-api/v1/work-items', (route) => route.fulfill({
    status: 503,
    json: { error: { code: 'UNAVAILABLE', message: 'Board is offline' } },
  }));
  await page.goto('/');
  await expect(page.getByText('Task board unavailable')).toBeVisible();
  await expect(page.getByText('The board service is not reachable.')).toBeVisible();
  await expect(page.getByText('No demo data is being shown.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Configure' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connection settings' })).toHaveCount(0);
  await expect(page.getByText('Patch')).toHaveCount(0);
});

test('an automatic manager review can only be assigned to a manager by a human', async ({ page }) => {
  const completedWork = {
    ...task,
    status: 'completed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    expectedAgentMinutes: 30,
    estimateRecordedAt: '2026-07-19T18:12:00.000Z',
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
    requiresReview: false,
    title: 'Manager review: Improve invoice recovery',
    objective: 'Check the engineer result before asking a human for a release decision.',
    expectedAgentMinutes: null,
    estimateRecordedAt: null,
    expectedCompletedAt: null,
    updatedAt: '2026-07-19T18:28:00.000Z',
  };
  let assignment: Record<string, unknown> | null = null;
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
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
  await expect(page.getByRole('heading', { name: 'Manager review: Improve invoice recovery', exact: true })).toBeVisible();
  await expect(page.getByText('Current status', { exact: true })).toBeVisible();
  const managerSelect = page.getByLabel('Assign manager');
  const managerOption = managerSelect.locator('option');
  await expect(managerOption).toHaveCount(1);
  await expect(managerOption).toHaveText('release-manager — Release review — Worker not detected');
  await expect(managerOption).toHaveText(/ — Worker (?:ready|connected|not detected)$/u);
  await expect(managerSelect).not.toContainText('billing-engineer');
  await page.getByRole('button', { name: 'Assign manager and wake' }).click();
  await expect.poll(() => assignment).not.toBeNull();

  expect(assignment).toEqual({
    version: 1,
    assignedAgentId: manager.agentId,
    assignedRole: 'manager',
    status: 'queued',
  });
});

test('a human check records approval without exposing any agent wake or deployment control', async ({ page }) => {
  const completedWork = {
    ...task,
    status: 'completed',
    assignedAgentId: agent.agentId,
    assignedRole: 'engineer',
    expectedAgentMinutes: 30,
    estimateRecordedAt: '2026-07-19T18:12:00.000Z',
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
    requiresReview: false,
    title: 'Manager review: Improve invoice recovery',
    assignedAgentId: manager.agentId,
    assignedRole: 'manager',
    expectedAgentMinutes: 15,
    estimateRecordedAt: '2026-07-19T18:28:00.000Z',
    result: 'Focused checks and the user impact are ready for human review.',
    updatedAt: '2026-07-19T18:29:00.000Z',
  };
  const humanCheck = {
    ...task,
    taskId: 'task-recovery-human-check',
    parentTaskId: completedReview.taskId,
    kind: 'human_check',
    requiredRole: null,
    requiresReview: false,
    title: 'Human check: Improve invoice recovery',
    objective: 'A human decides whether the reviewed result can move to the external release step.',
    expectedAgentMinutes: null,
    estimateRecordedAt: null,
    expectedCompletedAt: null,
    updatedAt: '2026-07-19T18:30:00.000Z',
  };
  let decision: Record<string, unknown> | null = null;
  const agentWakeRequests: string[] = [];
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
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
  await expect(page.getByText('awaiting human', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Human release decision', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /deploy/iu })).toHaveCount(0);
  await expect(page.getByLabel('Assign agent')).toHaveCount(0);
  await expect(page.getByLabel('Assign manager')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Resume assigned/u })).toHaveCount(0);
  const approve = page.getByRole('button', { name: 'Approve' });
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

test('automation configuration is edited as one dormant, versioned draft on desktop and mobile', async ({ page }) => {
  const automationRequests: string[] = [];
  const savedPayload: { value: UpdateAutomationConfigurationRequest | null } = { value: null };
  let currentConfiguration: Record<string, unknown> = {
    apiVersion,
    configurationId: 'company-default',
    agentTypes: [{
      agentTypeId: 'independent-verifier',
      name: 'Independent verifier',
      description: 'Checks implementation evidence without modifying files.',
      role: 'verifier',
      supplementalInstructions: 'Inspect the result independently and report concrete evidence.',
      skillIds: ['verification-checklist'],
      evaluatorProfile: 'manual',
      enabled: true,
    }],
    stages: [
      { stage: 'refinement', executor: { kind: 'disabled' } },
      { stage: 'project_resolution', executor: { kind: 'disabled' } },
      { stage: 'research', executor: { kind: 'disabled' } },
      { stage: 'planning', executor: { kind: 'disabled' } },
      { stage: 'implementation', executor: { kind: 'disabled' } },
      { stage: 'testing', executor: { kind: 'disabled' } },
      { stage: 'verification', executor: { kind: 'agent_type', agentTypeId: 'independent-verifier' } },
      { stage: 'human_review', executor: { kind: 'human' } },
      { stage: 'deployment', executor: { kind: 'disabled' } },
    ],
    version: 1,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    updatedBy: 'system:steward-default',
  };

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
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
    if (url.pathname === '/board-api/v1/automation-configuration') {
      automationRequests.push(`${request.method()} ${url.pathname}`);
      if (request.method() === 'PATCH') {
        const payload = request.postDataJSON() as UpdateAutomationConfigurationRequest;
        savedPayload.value = payload;
        currentConfiguration = {
          ...currentConfiguration,
          agentTypes: payload.agentTypes,
          stages: payload.stages,
          version: 2,
          updatedAt: '2026-07-19T18:40:00.000Z',
          updatedBy: 'human:operator',
        };
      }
      await route.fulfill({ json: { configuration: currentConfiguration } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  expect(automationRequests).toEqual([]);

  let companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
  await expect.poll(() => automationRequests).toEqual(['GET /board-api/v1/automation-configuration']);
  await expect(page.getByText('Starter configuration · version 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saved configuration is dormant' })).toBeVisible();
  await expect(page.getByText(/Saving does not wake agents, change running work, or control the current hard-coded runtime/u)).toBeVisible();
  await expect(page.getByLabel('Refinement executor').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Project resolution executor').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Research executor').locator('option[value="independent-verifier"]')).toHaveCount(1);
  await expect(page.getByLabel('Planning executor').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Implementation executor').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Testing executor').locator('option[value="independent-verifier"]')).toHaveCount(1);
  await expect(page.getByLabel('Verification executor').locator('option[value="independent-verifier"]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Edit' }).click();
  const savedTypeDialog = page.getByRole('dialog', { name: 'Edit agent type' });
  await expect(savedTypeDialog.getByLabel('ID', { exact: true })).toBeDisabled();
  await expect(savedTypeDialog.getByLabel('Authority role')).toBeDisabled();
  await expect(savedTypeDialog.getByText('Saved IDs are retained; disable this type instead.', { exact: true })).toBeVisible();
  await expect(savedTypeDialog.getByRole('button', { name: 'Delete type' })).toHaveCount(0);
  await savedTypeDialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'Add agent type' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add agent type' });
  await dialog.getByLabel('ID', { exact: true }).fill('implementation-engineer');
  await dialog.getByLabel('Display name').fill('Implementation engineer');
  await dialog.getByLabel('Purpose').fill('Implements scoped workspace changes and proves them with focused tests.');
  await expect(dialog.getByLabel('Authority role')).toHaveValue('engineer');
  await dialog.getByLabel('Supplemental specialist instructions').fill('Make the smallest safe change, then record focused test evidence.');
  await dialog.getByLabel('Skill IDs').fill('code-review\nfocused-tests');
  await dialog.getByRole('button', { name: 'Keep draft' }).click();

  await expect(page.getByText('Implementation engineer', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Implementation executor').selectOption('implementation-engineer');
  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Task List' }).click();
  await expect(page.getByRole('heading', { name: 'Task List' })).toBeVisible();
  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
  await expect.poll(() => automationRequests.filter((request) => request.startsWith('GET '))).toHaveLength(2);
  await expect(page.getByText('Implementation engineer', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Implementation executor')).toHaveValue('implementation-engineer');
  await expect(page.getByLabel('Refinement executor').locator('option[value="implementation-engineer"]')).toHaveCount(0);
  await expect(page.getByLabel('Planning executor').locator('option[value="implementation-engineer"]')).toHaveCount(1);
  await expect(page.getByLabel('Research executor').locator('option[value="implementation-engineer"]')).toHaveCount(1);
  const humanReviewOwner = page.getByLabel('Human review executor');
  const deploymentOwner = page.getByLabel('Deployment executor');
  await expect(humanReviewOwner).toContainText('Human owner');
  await expect(humanReviewOwner).toContainText('Locked');
  await expect(deploymentOwner).toContainText('Disabled');
  await expect(deploymentOwner).toContainText('Locked');
  await expect(humanReviewOwner.locator('select')).toHaveCount(0);
  await expect(deploymentOwner.locator('select')).toHaveCount(0);

  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect.poll(() => savedPayload.value).not.toBeNull();
  await expect(page.getByText('Configuration saved. Runtime behavior remains unchanged until automation adopts it.', { exact: true })).toBeVisible();

  expect(savedPayload.value).toMatchObject({ version: 1 });
  expect(Object.keys(savedPayload.value ?? {}).sort()).toEqual(['agentTypes', 'stages', 'version']);
  const savedAgentTypes = savedPayload.value?.agentTypes ?? [];
  expect(savedAgentTypes.find((agentType) => agentType.agentTypeId === 'implementation-engineer')).toEqual({
    agentTypeId: 'implementation-engineer',
    name: 'Implementation engineer',
    description: 'Implements scoped workspace changes and proves them with focused tests.',
    role: 'engineer',
    supplementalInstructions: 'Make the smallest safe change, then record focused test evidence.',
    skillIds: ['code-review', 'focused-tests'],
    evaluatorProfile: 'tests',
    enabled: true,
  });
  const savedStages = savedPayload.value?.stages ?? [];
  expect(savedStages.find((entry) => entry.stage === 'implementation')).toEqual({
    stage: 'implementation',
    executor: { kind: 'agent_type', agentTypeId: 'implementation-engineer' },
  });
  expect(savedStages.find((entry) => entry.stage === 'human_review')).toEqual({ stage: 'human_review', executor: { kind: 'human' } });
  expect(savedStages.find((entry) => entry.stage === 'deployment')).toEqual({ stage: 'deployment', executor: { kind: 'disabled' } });

  const implementationArticle = page.locator('article').filter({ hasText: 'Implementation engineer' });
  await implementationArticle.getByRole('button', { name: 'Edit' }).click();
  const localPurpose = 'A newer local purpose that must survive a remote version check.';
  await page.getByRole('dialog', { name: 'Edit agent type' }).getByLabel('Purpose').fill(localPurpose);
  await page.getByRole('dialog', { name: 'Edit agent type' }).getByRole('button', { name: 'Keep draft' }).click();
  currentConfiguration = {
    ...currentConfiguration,
    version: 3,
    updatedAt: '2026-07-19T18:45:00.000Z',
    updatedBy: 'human:another-operator',
  };
  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Task List' }).click();
  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Automation' }).click();
  await expect(page.getByText('Saved configuration changed', { exact: true })).toBeVisible();
  await expect(page.getByText(/Version 3 is now saved remotely. Your draft based on version 2 is preserved/u)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  await page.locator('article').filter({ hasText: 'Implementation engineer' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit agent type' }).getByLabel('Purpose')).toHaveValue(localPurpose);
  await page.getByRole('dialog', { name: 'Edit agent type' }).getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Reload latest and discard draft' }).click();
  await expect(page.getByText('Saved configuration changed', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Version 3', { exact: true })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});

test('an expired sign-in offers one explicit retry and never reloads on its own', async ({ page }) => {
  let boardRequests = 0;
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

  await page.route('**/board-api/v1/**', async (route) => {
    boardRequests += 1;
    await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: 'no session' } } });
  });

  await page.goto('/');
  await expect(page.getByText('Your sign-in has expired').first()).toBeVisible();

  // The loop this guards against: a module-level "already reloaded" flag is reset
  // by the reload itself, so the page reloads forever. Settle, then prove the
  // navigation count is not climbing on its own.
  const settled = navigations;
  await page.waitForTimeout(3_000);
  expect(navigations).toBe(settled);

  // Re-authentication is available, but only when the operator asks for it.
  const retry = page.getByRole('button', { name: 'Sign in again' }).first();
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => navigations).toBeGreaterThan(settled);
  expect(boardRequests).toBeGreaterThan(0);
});

test('a signed-in account without the operator group is told so, with no retry offered', async ({ page }) => {
  await page.route('**/board-api/v1/**', async (route) => {
    await route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'wrong group' } } });
  });

  await page.goto('/');
  await expect(page.getByText(/not a board operator/u).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
});
