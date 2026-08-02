import { expect, test, type Locator, type Page } from '@playwright/test';

const apiVersion = 'steward.task-board/v1';
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

interface DocumentFixture {
  apiVersion: typeof apiVersion;
  documentId: string;
  projectId: string;
  title: string;
  contentType: 'text/markdown';
  content: string;
  contentVersion: number;
  penEpoch: number;
  penHolder: null | {
    actorType: 'human' | 'agent';
    actorId: string;
    clientId: string;
    acquiredAt: string;
  };
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

const editableDocument: DocumentFixture = {
  apiVersion,
  documentId: 'document-invoice-playbook',
  projectId: project.projectId,
  title: 'Invoice recovery playbook',
  contentType: 'text/markdown',
  content: '# Invoice recovery\n\nCustomers can retry safely.',
  contentVersion: 3,
  penEpoch: 4,
  penHolder: null,
  sequence: 8,
  createdAt: '2026-07-19T18:02:00.000Z',
  updatedAt: '2026-07-19T18:20:00.000Z',
};
const documentHumanToken = 'e2e-human-document-token-1234567890';
const documentAgentToken = 'e2e-agent-document-token-1234567890';

function cloneDocument(document: DocumentFixture): DocumentFixture {
  return {
    ...document,
    penHolder: document.penHolder === null ? null : { ...document.penHolder },
  };
}

function documentSummary(document: DocumentFixture) {
  const { content: _content, ...summary } = cloneDocument(document);
  return summary;
}

function documentSseFrame(document: DocumentFixture): string {
  return `id: ${document.sequence}\nevent: document\ndata: ${JSON.stringify({ document })}\n\n`;
}

async function installDocumentBoard(
  page: Page,
  initialDocument: DocumentFixture,
  broadcastContent: string,
) {
  await page.addInitScript((token) => {
    window.sessionStorage.setItem('cicada.humanToken', token);
  }, documentHumanToken);
  let current = cloneDocument(initialDocument);
  const history = [cloneDocument(initialDocument)];
  const documentRequests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const wakeRequests: string[] = [];
  const sseFrames: string[] = [];
  const documentAuthorizations: Array<string | undefined> = [];
  let initialBroadcastSent = false;

  const advance = (patch: Partial<DocumentFixture>): DocumentFixture => {
    current = {
      ...current,
      ...patch,
      penHolder: patch.penHolder === undefined
        ? current.penHolder === null ? null : { ...current.penHolder }
        : patch.penHolder === null ? null : { ...patch.penHolder },
      updatedAt: '2026-07-19T18:30:00.000Z',
    };
    history.push(cloneDocument(current));
    return cloneDocument(current);
  };

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON() as Record<string, unknown> | null;
    if (url.pathname.includes('/documents')) {
      documentAuthorizations.push(request.headers().authorization);
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
      await route.fulfill({
        json: {
          ...board(),
          tasks: [completedReferenceTask],
          documents: [documentSummary(current)],
        },
      });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${completedReferenceTask.taskId}/messages`) {
      await route.fulfill({ json: { messages: [], cursor: 0 } });
      return;
    }
    if (url.pathname === `/board-api/v1/documents/${current.documentId}/events` && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? '0');
      if (!initialBroadcastSent && after === current.sequence) {
        initialBroadcastSent = true;
        advance({
          content: broadcastContent,
          contentVersion: current.contentVersion + 1,
          sequence: current.sequence + 1,
        });
      }
      const frames = history
        .filter((document) => document.sequence > after)
        .map(documentSseFrame);
      const responseBody = frames.length > 0 ? frames.join('') : ': keepalive\n\n';
      if (frames.length > 0) sseFrames.push(...frames);
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        headers: { 'cache-control': 'no-cache' },
        body: responseBody,
      });
      return;
    }
    if (url.pathname === `/board-api/v1/documents/${current.documentId}` && method === 'GET') {
      await route.fulfill({ json: { document: cloneDocument(current) } });
      return;
    }
    if (url.pathname === `/board-api/v1/documents/${current.documentId}/pen` && method === 'POST') {
      documentRequests.push({ method, path: url.pathname, body });
      const action = body?.action;
      const clientId = String(body?.clientId ?? '');
      const expectedPenEpoch = Number(body?.expectedPenEpoch);
      if (expectedPenEpoch !== current.penEpoch) {
        await route.fulfill({ status: 409, json: { error: { code: 'DOCUMENT_PEN_EPOCH_CONFLICT', message: 'Document pen epoch changed' } } });
        return;
      }
      if (action === 'acquire') {
        if (current.penHolder !== null && body?.force !== true) {
          await route.fulfill({ status: 409, json: { error: { code: 'DOCUMENT_PEN_HELD', message: 'Document pen is held by another client' } } });
          return;
        }
        const next = advance({
          penEpoch: current.penEpoch + 1,
          penHolder: {
            actorType: 'human',
            actorId: 'human:operator',
            clientId,
            acquiredAt: '2026-07-19T18:30:00.000Z',
          },
          sequence: current.sequence + 1,
        });
        await route.fulfill({ json: { document: next } });
        return;
      }
      if (action === 'release' && current.penHolder?.clientId === clientId) {
        const next = advance({ penHolder: null, sequence: current.sequence + 1 });
        await route.fulfill({ json: { document: next } });
        return;
      }
      await route.fulfill({ status: 403, json: { error: { code: 'DOCUMENT_PEN_NOT_HELD', message: 'Only the pen holder can release it' } } });
      return;
    }
    if (url.pathname === `/board-api/v1/documents/${current.documentId}` && method === 'PATCH') {
      documentRequests.push({ method, path: url.pathname, body });
      const clientId = String(body?.clientId ?? '');
      if (
        Number(body?.penEpoch) !== current.penEpoch
        || Number(body?.contentVersion) !== current.contentVersion
        || current.penHolder?.clientId !== clientId
      ) {
        await route.fulfill({ status: 409, json: { error: { code: 'DOCUMENT_VERSION_CONFLICT', message: 'Document changed or the writer was fenced' } } });
        return;
      }
      const next = advance({
        content: String(body?.content ?? ''),
        contentVersion: current.contentVersion + 1,
        sequence: current.sequence + 1,
      });
      await route.fulfill({ json: { document: next } });
      return;
    }
    if (
      method !== 'GET'
      && (url.pathname.includes('/tasks') || url.pathname.includes('/resume') || url.pathname.includes('/interrupt'))
    ) {
      wakeRequests.push(`${method} ${url.pathname}`);
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  return {
    current: () => cloneDocument(current),
    documentRequests,
    documentAuthorizations,
    remoteUpdate: (input: { content: string; holderId: string }) => advance({
      content: input.content,
      contentVersion: current.contentVersion + 1,
      penEpoch: current.penEpoch + 1,
      penHolder: {
        actorType: 'human',
        actorId: input.holderId,
        clientId: 'document-ui-remote-tab',
        acquiredAt: '2026-07-19T18:31:00.000Z',
      },
      sequence: current.sequence + 2,
    }),
    sseFrames,
    wakeRequests,
  };
}

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
    documents: [],
  };
}

async function installDefaultBoard(page: Page): Promise<void> {
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
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });
}

async function openCompanyRail(page: Page): Promise<Locator> {
  if ((page.viewportSize()?.width ?? 1_000) < 1_024) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  const companyNavigation = page.getByRole('navigation', { name: 'Company navigation' });
  await expect(companyNavigation).toBeVisible();
  return companyNavigation.locator('../..');
}

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
  const companyRail = await openCompanyRail(page);
  await expect(companyRail.getByText('Cicada Tech Systems LLC.', { exact: true })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Task List' })).toBeVisible();
  await expect(companyRail.getByRole('button', { name: 'Documents' })).toBeVisible();
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

test('creating a task records one durable automatic work item with priority', async ({ page }) => {
  let createdRequest: Record<string, unknown> | null = null;
  let createdIdempotencyKey: string | undefined;
  let workItems: Record<string, unknown>[] = [];
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'GET') {
      await route.fulfill({ json: { workItems } });
      return;
    }
    if (url.pathname === '/board-api/v1/work-items' && request.method() === 'POST') {
      createdRequest = request.postDataJSON() as Record<string, unknown>;
      createdIdempotencyKey = request.headers()['idempotency-key'];
      const createdWorkItem = {
        apiVersion,
        workItemId: 'work-item-invoice-clarity',
        ...createdRequest,
        refinedObjective: null,
        resolvedProjectId: null,
        state: 'submitted',
        currentStage: 'refinement',
        createdBy: 'human:operator',
        version: 1,
        createdAt: '2026-07-19T18:16:00.000Z',
        updatedAt: '2026-07-19T18:16:00.000Z',
        endedAt: null,
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
  await page.getByRole('button', { name: 'Add task' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await expect(dialog.getByLabel('Priority')).toHaveValue('normal');
  await expect(dialog.getByLabel('Project')).toHaveValue('');
  await dialog.getByRole('textbox').fill('Make invoice recovery clear\nCustomers should know what to do after a failed payment.');
  await dialog.getByRole('button', { name: 'Submit task' }).click();
  await expect.poll(() => createdRequest).not.toBeNull();

  expect(createdRequest).toEqual({
    originalRequest: 'Make invoice recovery clear\nCustomers should know what to do after a failed payment.',
    priority: 'normal',
    projectTarget: { mode: 'auto' },
  });
  expect(createdIdempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
  await expect(page.getByRole('heading', { name: 'Automation intake' })).toBeVisible();
  await expect(page.getByText('Submitted · Refinement pending', { exact: true })).toBeVisible();
  await expect(page.getByText('Project: Auto', { exact: true })).toBeVisible();
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

test('adding a project asks only for its folder and creates its engineer profile automatically', async ({ page }) => {
  const importedProject = {
    ...project,
    projectId: 'project-payment-tools',
    name: 'payment-tools',
    description: '/workspace/payment-tools',
  };
  let createdProject: Record<string, unknown> | null = null;
  let createdAgent: Record<string, unknown> | null = null;
  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/board-api/v1/work-items') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects' && request.method() === 'POST') {
      createdProject = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, json: { project: importedProject } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${importedProject.projectId}/agents` && request.method() === 'POST') {
      createdAgent = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 204 });
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
  await page.getByRole('button', { name: 'Add project' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox')).toHaveCount(1);
  await dialog.getByRole('textbox').fill('/workspace/payment-tools/');
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await expect.poll(() => createdAgent).not.toBeNull();

  expect(createdProject).toEqual({ name: 'payment-tools', description: '/workspace/payment-tools' });
  expect(createdAgent).toMatchObject({
    agentId: 'payment-tools-engineer',
    role: 'engineer',
    area: 'payment-tools',
    model: agent.model,
  });
  expect(createdAgent?.mission).toContain('Research, plan, implement, test');
  expect(typeof createdAgent?.token).toBe('string');
  expect(String(createdAgent?.token)).toHaveLength(72);
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('cicada.pendingAgentToken.payment-tools-engineer'))).toBe(createdAgent?.token);
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

test('the Cicada sidebar keeps the POC as a durable chat and sends one atomic wake', async ({ page }, testInfo) => {
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
      await route.fulfill({ json: { ...board(), projects: [projectWithResources], agents: [agent, manager], tasks: [earlierQuery, projectTask] } });
      return;
    }
    if (url.pathname === `/board-api/v1/tasks/${projectTask.taskId}/messages` || url.pathname === `/board-api/v1/tasks/${earlierQuery.taskId}/messages`) {
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

  await companyRail.getByRole('button', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Documents' })).toBeVisible();
  await expect(page.getByText('No documents yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recorded references' })).toHaveCount(0);

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('navigation', { name: 'Projects and agents' }).getByRole('button', { name: 'Cicada platform', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cicada platform' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All work' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Activity history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Task completion' })).toHaveAttribute('aria-valuenow', '50');
  await expect(page.getByRole('heading', { name: 'Completed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Planned' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project setup' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Docs & links' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Resources' })).toBeVisible();
  await expect(page.getByRole('link', { name: /GitHub: https:\/\/github.com\/acme\/cicada/u })).toBeVisible();
  await expect(page.getByRole('link', { name: /Documentation: https:\/\/docs.example.com\/cicada/u })).toBeVisible();
  await expect(page.getByText('/workspace/billing', { exact: true })).toBeVisible();
  const moveGitHubLater = page.getByRole('button', { name: 'Move GitHub later' });
  await moveGitHubLater.focus();
  await moveGitHubLater.press('Enter');
  await expect(page.getByRole('button', { name: 'Move GitHub earlier' })).toBeVisible();
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
  let currentQuestion = {
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
          agents: [{ ...agent, status: 'waiting_for_human' }],
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

test('durable documents broadcast, acquire, save, and release without waking an agent', async ({ page }) => {
  const broadcastContent = '# Invoice recovery\n\nCustomers can retry safely.\n\nA watcher recorded the latest support guidance.';
  const mock = await installDocumentBoard(page, editableDocument, broadcastContent);

  await page.goto('/');
  let companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Documents' }).click();

  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Documents' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Invoice recovery playbook/u })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recorded references' })).toHaveCount(0);

  await page.getByRole('button', { name: /Invoice recovery playbook/u }).click();
  await expect(page.getByRole('button', { name: 'Back to document list' })).toBeVisible();
  const savedSnapshot = page.getByLabel('Invoice recovery playbook saved snapshot');
  await expect(savedSnapshot).toContainText('A watcher recorded the latest support guidance.');
  await expect(page.getByText(/Version 4$/u)).toBeVisible();
  await expect(page.getByText('Project links', { exact: true })).toHaveCount(0);
  await expect.poll(() => mock.sseFrames.some((frame) => frame.includes('id: 9\n'))).toBe(true);

  const initialFrame = mock.sseFrames.find((frame) => frame.includes('id: 9\n'))!;
  expect(initialFrame).toContain('event: document\n');
  const frameId = Number(/^id: (\d+)$/mu.exec(initialFrame)?.[1]);
  const frameData = JSON.parse(/^data: (.+)$/mu.exec(initialFrame)?.[1] ?? '{}') as { document?: { sequence?: number } };
  expect(frameData.document?.sequence).toBe(frameId);

  await page.getByRole('button', { name: 'Take the pen' }).click();
  await expect(page.getByText('You hold the pen', { exact: true })).toBeVisible();

  const editor = page.getByLabel('Edit Invoice recovery playbook');
  const savedContent = `${broadcastContent}\n\nHumans retain release control.`;
  await editor.fill(savedContent);
  await expect(page.getByText('Unsaved in this tab', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save snapshot' }).click();
  await expect(page.getByText(/Version 5$/u)).toBeVisible();
  await expect(editor).toHaveValue(savedContent);

  await page.getByRole('button', { name: 'Release pen' }).click();
  await expect(page.getByText('The pen is available', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Invoice recovery playbook saved snapshot')).toContainText('Humans retain release control.');

  expect(mock.documentRequests).toHaveLength(3);
  const clientId = String(mock.documentRequests[0]?.body?.clientId);
  expect(clientId).toMatch(/^document-ui-/u);
  expect(mock.documentRequests).toEqual([
    {
      method: 'POST',
      path: `/board-api/v1/documents/${editableDocument.documentId}/pen`,
      body: { action: 'acquire', clientId, expectedPenEpoch: 4, force: false },
    },
    {
      method: 'PATCH',
      path: `/board-api/v1/documents/${editableDocument.documentId}`,
      body: { clientId, penEpoch: 5, contentVersion: 4, content: savedContent },
    },
    {
      method: 'POST',
      path: `/board-api/v1/documents/${editableDocument.documentId}/pen`,
      body: { action: 'release', clientId, expectedPenEpoch: 5, force: false },
    },
  ]);
  expect(mock.current()).toMatchObject({
    content: savedContent,
    contentVersion: 5,
    penEpoch: 5,
    penHolder: null,
  });
  expect(new Set(mock.documentAuthorizations)).toEqual(new Set([`Bearer ${documentHumanToken}`]));
  expect(mock.wakeRequests).toEqual([]);

  if ((page.viewportSize()?.width ?? 1_000) < 1_024) {
    await page.getByRole('button', { name: 'Back to document list' }).click();
    const documentButton = page.getByRole('button', { name: /Invoice recovery playbook.*Available to edit/u });
    await expect(documentButton).toBeVisible();
    await expect(documentButton).toBeFocused();
  } else {
    companyRail = await openCompanyRail(page);
    await expect(companyRail.getByRole('button', { name: 'Documents' })).toBeVisible();
  }
});

test('a human force takeover fences an agent-held document epoch without touching wake routes', async ({ page }) => {
  const agentDocument: DocumentFixture = {
    ...editableDocument,
    documentId: 'document-agent-held',
    title: 'Agent research notes',
    content: '# Research notes\n\nThe agent is still writing.',
    contentVersion: 7,
    penEpoch: 11,
    penHolder: {
      actorType: 'agent',
      actorId: agent.agentId,
      clientId: 'agent-worker-old',
      acquiredAt: '2026-07-19T18:21:00.000Z',
    },
    sequence: 21,
  };
  const broadcastContent = '# Research notes\n\nThe agent saved its latest findings.';
  const mock = await installDocumentBoard(page, agentDocument, broadcastContent);

  await page.goto('/');
  const companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Documents' }).click();
  await page.getByRole('button', { name: /Agent research notes/u }).click();

  await expect(page.getByText('billing-engineer holds the pen', { exact: true })).toBeVisible();
  await expect(page.getByText(/Version 8$/u)).toBeVisible();
  await expect(page.getByLabel('Agent research notes saved snapshot')).toContainText('The agent saved its latest findings.');

  let confirmation = '';
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Take over pen' }).click();
  expect(confirmation).toContain('Take the pen from billing-engineer?');
  expect(confirmation).toContain('Their future saves will be blocked');
  await expect(page.getByText('You hold the pen', { exact: true })).toBeVisible();

  const takeover = mock.documentRequests[0];
  expect(takeover).toEqual({
    method: 'POST',
    path: `/board-api/v1/documents/${agentDocument.documentId}/pen`,
    body: {
      action: 'acquire',
      clientId: takeover?.body?.clientId,
      expectedPenEpoch: 11,
      force: true,
    },
  });

  const staleStatus = await page.evaluate(async ({ documentId, contentVersion, agentToken }) => {
    const response = await fetch(`/board-api/v1/documents/${documentId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientId: 'agent-worker-old',
        penEpoch: 11,
        contentVersion,
        content: '# Stale overwrite',
      }),
    });
    return response.status;
  }, { documentId: agentDocument.documentId, contentVersion: 8, agentToken: documentAgentToken });

  expect(staleStatus).toBe(409);
  expect(mock.current()).toMatchObject({
    content: broadcastContent,
    contentVersion: 8,
    penEpoch: 12,
    penHolder: { actorType: 'human' },
  });
  await expect(page.getByLabel('Edit Agent research notes')).toHaveValue(broadcastContent);
  expect(new Set(mock.documentAuthorizations)).toEqual(new Set([
    `Bearer ${documentHumanToken}`,
    `Bearer ${documentAgentToken}`,
  ]));
  expect(mock.wakeRequests).toEqual([]);
});

test('an unsaved document draft survives navigation and cannot overwrite a newer saved version', async ({ page }) => {
  const broadcastContent = '# Invoice recovery\n\nCustomers can retry safely.\n\nThe shared snapshot is current.';
  const mock = await installDocumentBoard(page, editableDocument, broadcastContent);

  await page.goto('/');
  let companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Documents' }).click();
  await page.getByRole('button', { name: /Invoice recovery playbook/u }).click();
  await expect(page.getByText(/Version 4$/u)).toBeVisible();
  await page.getByRole('button', { name: 'Take the pen' }).click();

  const unsavedDraft = `${broadcastContent}\n\nUnsaved operator note.`;
  const editor = page.getByLabel('Edit Invoice recovery playbook');
  await editor.fill(unsavedDraft);
  await expect(page.getByText('Unsaved in this tab', { exact: true })).toBeVisible();
  expect(mock.documentRequests.filter((request) => request.method === 'PATCH')).toEqual([]);

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Task List' }).click();
  await expect(page.getByRole('heading', { name: 'Task List', exact: true })).toBeVisible();

  const newerSavedContent = `${broadcastContent}\n\nAnother human saved a newer decision.`;
  mock.remoteUpdate({ content: newerSavedContent, holderId: 'human:release-owner' });

  companyRail = await openCompanyRail(page);
  await companyRail.getByRole('button', { name: 'Documents' }).click();
  await page.getByRole('button', { name: /Invoice recovery playbook/u }).click();

  const restoredDraft = page.getByLabel('Edit Invoice recovery playbook');
  await expect(restoredDraft).toHaveValue(unsavedDraft);
  await expect(page.getByText(/Version 5$/u)).toBeVisible();
  await expect(page.getByText('A newer saved version arrived. Your draft is preserved and cannot overwrite it.', { exact: true })).toBeVisible();
  await expect(page.getByText('Draft preserved — read-only', { exact: true })).toBeVisible();
  const discardDraft = page.getByRole('button', { name: 'Discard draft and load saved' });
  await expect(discardDraft).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save snapshot' })).toBeDisabled();

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Discard this unsaved draft');
    await dialog.dismiss();
  });
  await discardDraft.click();
  await expect(restoredDraft).toHaveValue(unsavedDraft);

  page.once('dialog', async (dialog) => dialog.accept());
  await discardDraft.click();
  await expect(page.getByLabel('Invoice recovery playbook saved snapshot')).toContainText('Another human saved a newer decision.');

  expect(mock.current()).toMatchObject({
    content: newerSavedContent,
    contentVersion: 5,
    penEpoch: 6,
    penHolder: { actorId: 'human:release-owner' },
  });
  expect(mock.documentRequests.filter((request) => request.method === 'PATCH')).toEqual([]);
  expect(mock.wakeRequests).toEqual([]);
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
  await expect(page.getByText('No demo data is being shown.')).toBeVisible();
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
  await expect(managerSelect.locator('option')).toHaveCount(1);
  await expect(managerSelect.locator('option')).toHaveText('release-manager — Release review');
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
  let savedPayload: Record<string, unknown> | null = null;
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
        savedPayload = request.postDataJSON() as Record<string, unknown>;
        currentConfiguration = {
          ...currentConfiguration,
          agentTypes: savedPayload.agentTypes,
          stages: savedPayload.stages,
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
  await expect.poll(() => savedPayload).not.toBeNull();
  await expect(page.getByText('Configuration saved. Runtime behavior remains unchanged until automation adopts it.', { exact: true })).toBeVisible();

  expect(savedPayload).toMatchObject({ version: 1 });
  expect(Object.keys(savedPayload ?? {}).sort()).toEqual(['agentTypes', 'stages', 'version']);
  const savedAgentTypes = savedPayload?.agentTypes as Array<Record<string, unknown>>;
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
  const savedStages = savedPayload?.stages as Array<Record<string, unknown>>;
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
