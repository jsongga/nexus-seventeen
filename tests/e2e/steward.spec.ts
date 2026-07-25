import { expect, test, type Page } from '@playwright/test';

async function installPausedClock(page: Page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 60_000));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/demo');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect.poll(() => page.evaluate(
    () => window.localStorage.getItem('steward-demo-state-v8') !== null,
  )).toBe(true);
});

test('the current browser-local data source is disclosed', async ({ page, isMobile }) => {
  await expect(page).toHaveTitle('Nexus Seventeen — Agent oversight');
  const visibleShell = isMobile ? page.locator('header').first() : page.locator('aside').first();
  await expect(visibleShell.getByText('cicada', { exact: true })).toBeVisible();
  await expect(visibleShell.getByText('Steward', { exact: true })).toBeVisible();
  await expect(
    page.getByText(isMobile ? 'Demo data' : 'Demo · browser-local', { exact: true }),
  ).toBeVisible();
});

test('prototype-only boundaries and event history are labeled as browser-local', async ({ page, isMobile }) => {
  await expect(page.getByText('Human release authorization is required')).toBeVisible();
  await expect(page.getByText('Simulation only', { exact: true })).toBeVisible();
  await expect(page.getByText(/browser demo records decisions but cannot release to customers/iu)).toBeVisible();

  const navigation = page.getByRole('navigation', {
    name: isMobile ? 'Mobile navigation' : 'Main navigation',
  });
  await navigation
    .getByRole('button', { name: isMobile ? 'Runs' : 'Live runs', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Prototype boundary model' })).toBeVisible();
  await expect(page.getByText(/browser demo does not create a sandbox or inspect production credentials/iu)).toBeVisible();
  await expect(page.getByText('Development sandbox', { exact: true })).toHaveCount(0);

  if (isMobile) await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Event history', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser-local event timeline' })).toBeVisible();
  await expect(page.getByText(/not a tamper-resistant audit ledger/iu)).toBeVisible();
  await expect(page.getByText('Immutable history', { exact: true })).toHaveCount(0);
});

test('the browser demo records one exact release authorization without claiming deployment', async ({ page, isMobile }) => {
  const mutationRequests: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutationRequests.push(request.url());
  });
  await expect(page.getByRole('heading', { name: /decisions need you\./ })).toBeVisible();
  await expect(page.getByText('Human release authorization is required')).toBeVisible();

  await page.getByRole('button', { name: /Promote SSO session hardening/ }).click();
  const evidenceDrawer = page.getByRole('dialog', {
    name: /Promote SSO session hardening approval details/,
  });
  await expect(evidenceDrawer).toBeVisible();
  await expect(
    evidenceDrawer.getByText('7f83b1657ff1fc53b92dc18148a1d65dfa13514d'),
  ).toBeVisible();
  await expect(evidenceDrawer.getByRole('heading', { name: 'Manager assessment' })).toBeVisible();
  await expect(
    evidenceDrawer.getByText('Vale reviewed this work to the best of their ability'),
  ).toBeVisible();
  await expect(evidenceDrawer.getByText('Engineer loops checked')).toBeVisible();
  await expect(evidenceDrawer.getByText('Prototype policy: managers cannot authorize or deploy production')).toBeVisible();
  await expect(evidenceDrawer.getByText('Migrations')).toBeVisible();
  await expect(evidenceDrawer.getByText('Opened', { exact: true })).toBeVisible();
  await expect(evidenceDrawer.getByText('Resolved', { exact: true })).toBeVisible();
  await expect(evidenceDrawer.getByText('Awaiting human', { exact: true })).toBeVisible();
  await expect(evidenceDrawer.getByText('No ETA for people', { exact: true })).toBeVisible();
  await expect(evidenceDrawer.getByText('Expected by', { exact: true })).toHaveCount(0);
  await expect(evidenceDrawer.getByText(/agent time/i)).toHaveCount(0);

  await evidenceDrawer.getByRole('button', { name: 'Review authorization' }).click();
  const confirmation = page.getByRole('dialog').filter({ hasText: 'Simulate release authorization' });
  await expect(confirmation.getByText('It does not deploy.')).toBeVisible();
  await confirmation.getByLabel(/Type AUTHORIZE STW-482/).fill('AUTHORIZE STW-482');
  await confirmation.getByRole('button', { name: 'Record authorization' }).click();

  await expect(page.getByRole('status')).toContainText('Demo authorization recorded');
  await expect(page.getByRole('status')).toContainText('No artifact was deployed');
  await page.getByRole('button', { name: /^(?:\d+ )?Approvals(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: /Promote SSO session hardening/ }).click();
  const closedDrawer = page.getByRole('dialog', {
    name: /Promote SSO session hardening approval details/,
  });
  await expect(closedDrawer.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  await expect(closedDrawer.getByRole('button', { name: 'Authorization recorded' })).toBeDisabled();
  await page.keyboard.press('Escape');
  if (isMobile) await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Event history', exact: true }).click();
  await expect(page.getByText('simulated single-use approval consumption')).toBeVisible();
  await expect(page.getByText('recorded release authorization').first()).toBeVisible();
  expect(mutationRequests).toEqual([]);
});

test('stacked human-decision dialogs keep keyboard focus and close only the top layer', async ({ page }) => {
  const approvalCard = page.getByRole('button', { name: /Promote SSO session hardening/ });
  await approvalCard.click();
  const drawer = page.getByRole('dialog', {
    name: /Promote SSO session hardening approval details/,
  });
  const reviewButton = drawer.getByRole('button', { name: 'Review authorization' });
  await reviewButton.click();

  const productionDialog = page.getByRole('dialog', { name: /Simulate release authorization/ });
  await expect(productionDialog).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(productionDialog.getByLabel(/Type AUTHORIZE STW-482/)).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(productionDialog).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(reviewButton).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(1);

  const requestChanges = drawer.getByRole('button', { name: 'Request changes' });
  await requestChanges.click();
  const changesDialog = page.getByRole('dialog', { name: /Send back with direction/ });
  await expect(changesDialog).toBeVisible();
  await expect(changesDialog.getByLabel('What needs to change?')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(changesDialog).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(requestChanges).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(approvalCard).toBeFocused();
});

test('new mission dialog traps focus and restores its opener', async ({ page, isMobile }) => {
  const opener = page.getByRole('button', {
    name: isMobile ? 'Create a new mission' : 'New mission',
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: /Start with human intent/ });
  const missionName = dialog.getByLabel('Mission name');
  await expect(missionName).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const focusStayedInside = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest('[role="dialog"]') !== null;
  });
  expect(focusStayedInside).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test('mobile oversight stays usable without horizontal page overflow', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile-only responsive assertion.');

  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a new mission' })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Approvals' }).click();
  await expect(page.getByRole('heading', { name: 'Decisions, with the proof attached.' })).toBeVisible();
  await page.getByRole('button', { name: /Promote SSO session hardening/ }).click();
  await expect(page.getByText('Exact release candidate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review authorization' })).toBeVisible();
});

test('mobile system navigation is keyboard reachable and restores focus', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile-only system navigation');

  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  const systemNavigation = page.getByRole('dialog', { name: 'System' });
  await expect(systemNavigation).toBeVisible();
  await expect(systemNavigation.getByRole('button', { name: 'Close system navigation' })).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(systemNavigation.getByRole('button', { name: 'Role team' })).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(systemNavigation).not.toBeVisible();
  await expect(more).toBeFocused();
});

test('the live inspector exposes the exact action, heartbeat, completion loop, and progress journal', async ({ page, isMobile }) => {
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();

  const inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText('Editing the mobile command bar', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Codex patch', { exact: true })).toBeVisible();
  await expect(
    inspector.getByText('src/components/navigation/MobileCommandBar.tsx', { exact: true }).first(),
  ).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Research → Plan → Execute → Test' })).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Progress journal' })).toBeVisible();
  await expect(inspector.getByText('Mobile browser check failed')).toBeVisible();
  await expect(inspector.getByText('Iteration 2').first()).toBeVisible();
  await expect(inspector.getByText('8 sec ago').nth(isMobile ? 1 : 0)).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Actual timing and agent forecast' })).toBeVisible();
  await expect(inspector.getByText('Actual start', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Expected by', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Actual end', { exact: true })).toBeVisible();
  await expect(inspector.getByText('In progress', { exact: true })).toBeVisible();
  await expect(inspector.getByText('45 min agent time', { exact: true })).toBeVisible();

  await inspector.getByRole('button', { name: 'Close live run inspector' }).click();
  await expect(inspector).not.toBeVisible();
});

test('standing-by agents have no fabricated task timing or human ETA', async ({ page, isMobile }) => {
  const navigation = page.getByRole('navigation', {
    name: isMobile ? 'Mobile navigation' : 'Main navigation',
  });
  await navigation
    .getByRole('button', { name: isMobile ? 'Runs' : 'Live runs', exact: true })
    .click();
  await page.getByRole('button', { name: 'Open human controls for Mira' }).click();
  const inspector = page.getByRole('dialog', { name: 'Mira · QUEUE-MIRA' });
  await expect(inspector.getByText('Lane idle', { exact: true }).first()).toBeVisible();
  await expect(inspector.getByText('No agent task active', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Expected by', { exact: true })).toHaveCount(0);
  await expect(inspector.getByText(/No estimate is assigned to a person/)).toBeVisible();
});

test('a human can queue, interrupt, and resume Patch while preserving outcome context', async ({ page }) => {
  await installPausedClock(page);
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();

  const inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector.getByRole('heading', { name: 'Human controls' })).toBeVisible();
  await expect(inspector.getByText('Plain-language summary', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Updates automatically as the work progresses')).toBeVisible();
  await expect(inspector.getByText(/not a test result or release evidence/)).toBeVisible();
  await inspector.getByText('Details', { exact: true }).click();
  await expect(inspector.getByText('Revision 5')).toBeVisible();
  await expect(inspector.getByText(/Sources: STW-471/)).toBeVisible();
  await expect(inspector.getByText('What changes for users')).toBeVisible();
  await expect(
    inspector.getByText(
      'People on smaller phones should navigate without sideways scrolling or awkward stretches.',
    ),
  ).toBeVisible();
  await expect(inspector.getByText(/Intended outcome: Make the most-used mobile actions/)).toBeVisible();

  await inspector.getByRole('button', { name: 'Queue work' }).click();
  const queueDialog = page.getByRole('dialog', { name: 'Queue work for Patch' });
  await expect(queueDialog).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(queueDialog.getByLabel('Short title')).toBeFocused();

  const queuedTitle = 'Clarify offline recovery';
  const desiredOutcome = 'People can tell when their saved work is safe after reconnecting.';
  await queueDialog.getByLabel('Short title').fill(queuedTitle);
  await queueDialog.getByLabel('Desired user outcome').fill(desiredOutcome);
  await expect(queueDialog.getByLabel('Expected agent work time')).toHaveValue('30');
  await expect(queueDialog.getByText(/Human review, waiting, and deployment time are not included/)).toBeVisible();
  await queueDialog.getByLabel('Expected agent work time').selectOption('45');
  await queueDialog.getByRole('radio', { name: /Next-up queue/ }).check();
  await queueDialog.getByRole('button', { name: "Add to Patch's queue" }).click();

  await expect(queueDialog).not.toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Queue work' })).toBeFocused();
  await expect(page.getByRole('status')).toContainText('Work queued for Patch');
  await expect(page.getByRole('status')).toContainText('stored on the agent lane');

  const orderedQueue = inspector.locator('ol').first().getByRole('listitem');
  await expect(orderedQueue).toHaveCount(2);
  await expect(orderedQueue.nth(0)).toContainText('Check keyboard-only navigation');
  await expect(orderedQueue.nth(1)).toContainText(queuedTitle);
  await expect(orderedQueue.nth(1)).toContainText(desiredOutcome);
  await expect(orderedQueue.nth(1)).toContainText('Next up');
  await expect(orderedQueue.nth(1)).toContainText('Queued by Jordan Lee');
  await expect(orderedQueue.nth(1)).toContainText('Agent estimate · 45 min agent time');
  await expect(inspector.getByText('Stable queue for Patch')).toBeVisible();
  await expect(inspector.getByText(/Lane lane-patch · queue survives run replacement/)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((title) => {
        const raw = window.localStorage.getItem('steward-demo-state-v8');
        if (!raw) return null;
        const state = JSON.parse(raw) as {
          runControls: Record<string, {
            queue: Array<{ title: string; expectedAgentMinutes: number }>;
            signals: Array<{ queuedWorkId?: string; expectedAgentMinutes?: number }>;
          }>;
        };
        const control = state.runControls['lane-patch'];
        const item = control?.queue.find((candidate) => candidate.title === title);
        const signal = control?.signals.find((candidate) => candidate.queuedWorkId?.includes('queue-lane-patch'));
        return { item: item?.expectedAgentMinutes, signal: signal?.expectedAgentMinutes };
      }, queuedTitle),
    )
    .toEqual({ item: 45, signal: 45 });

  await inspector.getByRole('button', { name: 'Interrupt now' }).click();
  await expect(page.getByRole('status')).toContainText('Interrupt requested for Patch');
  await expect(inspector.getByText('Interrupt requested')).toBeVisible();
  await expect(inspector.getByText(/not yet claiming the process stopped/i)).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Waiting for worker' })).toBeDisabled();

  await page.clock.runFor(351);
  await expect(inspector.getByText('Worker acknowledged', { exact: true })).toBeVisible();
  await expect(inspector.getByText(/settling the active process/i)).toBeVisible();

  await page.clock.runFor(351);
  await expect(page.getByRole('status')).toContainText('Patch interrupted');
  await expect(inspector.getByText('Agent interrupted')).toBeVisible();
  await expect(inspector.getByText('Human interrupted')).toBeVisible();
  await expect(inspector.getByText('Forecast paused', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Paused during human wait', { exact: true })).toBeVisible();
  await expect(
    inspector.getByText(/worker confirmed the process stopped\. Workspace, checkpoint, progress journal, and stable agent queue are preserved/i),
  ).toBeVisible();
  await expect(inspector.getByText('Preserved action at interruption')).toBeVisible();
  await expect(inspector.getByText('Editing the mobile command bar', { exact: true })).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Progress journal' })).toBeVisible();
  await expect(inspector.getByText('Narrow layout fix in progress')).toBeVisible();
  await expect(orderedQueue).toHaveCount(2);
  await expect(orderedQueue.nth(1)).toContainText(queuedTitle);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  await inspector.getByRole('button', { name: 'Resume agent' }).click();
  await expect(page.getByRole('status')).toContainText('Patch resumed');
  await expect(inspector.getByText('Live agent view')).toBeVisible();
  await expect(inspector.getByText('Agent working')).toBeVisible();
  await expect(inspector.getByText('Forecast paused', { exact: true })).not.toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Interrupt now' })).toBeVisible();
  await expect(inspector.getByText('Right now')).toBeVisible();
  await expect(orderedQueue).toHaveCount(2);
  await expect(inspector.getByText('Narrow layout fix in progress')).toBeVisible();
});

test('queue direction survives a parent rerender and restores focus to the inspector', async ({ page }) => {
  await installPausedClock(page);
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();
  const inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await inspector.getByRole('button', { name: 'Interrupt now' }).click();

  const queueButton = inspector.getByRole('button', { name: 'Queue work' });
  await queueButton.click();
  const queueDialog = page.getByRole('dialog', { name: 'Queue work for Patch' });
  const title = queueDialog.getByLabel('Short title');
  const outcome = queueDialog.getByLabel('Desired user outcome');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(title).toBeFocused();

  await title.fill('Keep typed human direction');
  await outcome.fill('People receive the requested result even when live worker state changes.');
  await expect(outcome).toBeFocused();

  await page.clock.fastForward(351);
  await expect(outcome).toBeFocused();
  await expect(title).toHaveValue('Keep typed human direction');
  await expect(outcome).toHaveValue(
    'People receive the requested result even when live worker state changes.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(queueDialog).not.toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(queueButton).toBeFocused();
});

test('pausing the workspace preserves an already interrupted agent action', async ({ page }) => {
  await installPausedClock(page);
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();
  let inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await inspector.getByRole('button', { name: 'Interrupt now' }).click();
  await page.clock.runFor(702);
  await expect(inspector.getByText('Agent interrupted')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await inspector.getByRole('button', { name: 'Close live run inspector' }).click();

  await page.getByRole('button', { name: /Pause all(?: agents)?/, exact: true }).click();
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();
  inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector.getByText('Agent interrupted')).toBeVisible();
  await expect(inspector.getByText('Preserved action at interruption')).toBeVisible();
  await expect(inspector.getByText('Editing the mobile command bar', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Paused by human owner', { exact: true })).not.toBeVisible();
});

test('a product decision requires, persists, and audits an explicit human choice', async ({ page }) => {
  await page.getByRole('button', { name: /^(?:\d+ )?Approvals(?: \d+)?$/ }).click();
  await page.getByRole('button', { name: /Choose retry behavior for imports/ }).click();
  let drawer = page.getByRole('dialog', {
    name: /Choose retry behavior for imports approval details/,
  });
  const recordDecision = drawer.getByRole('button', { name: 'Record decision' });
  await expect(recordDecision).toBeDisabled();

  const chosenOption = drawer.getByRole('radio', { name: /Resume completed steps/ });
  await chosenOption.check();
  await expect(recordDecision).toBeEnabled();
  await recordDecision.click();
  await expect(page.getByRole('status')).toContainText('Decision recorded');

  const persistedDecision = await page.evaluate(() => {
    const raw = window.localStorage.getItem('steward-demo-state-v8');
    if (!raw) return null;
    const state = JSON.parse(raw) as {
      approvals: Array<{
        id: string;
        status: string;
        decision?: { optionId: string; label: string; decidedBy: string };
      }>;
      audit: Array<{ detail: string }>;
    };
    const approval = state.approvals.find((item) => item.id === 'APR-021');
    return {
      status: approval?.status,
      decision: approval?.decision,
      audited: state.audit.some((item) => item.detail.includes('Resume completed steps')),
    };
  });
  expect(persistedDecision).toMatchObject({
    status: 'approved',
    decision: {
      optionId: 'option-a',
      label: 'Resume completed steps',
      decidedBy: 'Jordan Lee',
    },
    audited: true,
  });

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: /Choose retry behavior for imports/ }).click();
  drawer = page.getByRole('dialog', {
    name: /Choose retry behavior for imports approval details/,
  });
  await expect(drawer.getByRole('radio', { name: /Resume completed steps/ })).toBeChecked();
  await expect(drawer.getByRole('radio', { name: /Resume completed steps/ })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Already approved' })).toBeDisabled();
});

test('reload reconciles unfinished worker and observer jobs without losing the last good summary', async ({ page }) => {
  await installPausedClock(page);
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();

  let inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await inspector.getByRole('button', { name: 'Queue work' }).click();
  const queueDialog = page.getByRole('dialog', { name: 'Queue work for Patch' });
  await queueDialog.getByLabel('Short title').fill('Retain reload evidence');
  await queueDialog
    .getByLabel('Desired user outcome')
    .fill('People never see an unfinished background job reported as complete.');
  await queueDialog.getByRole('button', { name: "Add to Patch's queue" }).click();
  await inspector.getByRole('button', { name: 'Interrupt now' }).click();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('steward-demo-state-v8');
        if (!raw) return null;
        const persisted = JSON.parse(raw) as {
          runControls: Record<string, { status: string }>;
          runs: Array<{ id: string; impactSummary: { freshness: string } }>;
        };
        return {
          control: persisted.runControls['lane-patch']?.status,
          observer: persisted.runs.find((run) => run.id === 'RUN-882')?.impactSummary.freshness,
        };
      }),
    )
    .toEqual({ control: 'interrupt_requested', observer: 'refreshing' });

  await page.reload();
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();
  inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });

  await expect(inspector.getByText('Worker state unknown')).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Retry interrupt' })).toBeVisible();
  await expect(inspector.getByText('Refresh failed')).toBeVisible();
  await expect(inspector.getByText(/last good user-impact revision remains visible/i)).toBeVisible();
  await inspector.getByText('Details', { exact: true }).click();
  await expect(inspector.getByText('Revision 5')).toBeVisible();
  await expect(inspector.getByText('Retain reload evidence')).toBeVisible();

  const reconciled = await page.evaluate(() => {
    const raw = window.localStorage.getItem('steward-demo-state-v8');
    if (!raw) return null;
    const persisted = JSON.parse(raw) as {
      runControls: Record<string, { status: string }>;
      impactSlots: Record<
        string,
        { activeRequest?: unknown; freshness: string; lastGenerationError?: unknown }
      >;
    };
    const slot = persisted.impactSlots['lane-patch'];
    return {
      control: persisted.runControls['lane-patch']?.status,
      observer: slot?.freshness,
      hasActiveRequest: slot?.activeRequest !== undefined,
      hasRecordedFailure: slot?.lastGenerationError !== undefined,
    };
  });
  expect(reconciled).toEqual({
    control: 'interrupt_unknown',
    observer: 'error',
    hasActiveRequest: false,
    hasRecordedFailure: true,
  });
});

test('invalid persisted state resets safely instead of blanking the app', async ({ page }) => {
  await page.evaluate(() => {
    const key = 'steward-demo-state-v8';
    const raw = window.localStorage.getItem(key);
    if (!raw) throw new Error('Expected the demo state to be persisted.');
    const persisted = JSON.parse(raw) as {
      runs: Array<{ id: string; impactSummary?: unknown }>;
    };
    const patch = persisted.runs.find((run) => run.id === 'RUN-882');
    if (!patch) throw new Error('Expected the Patch demo run.');
    delete patch.impactSummary;
    window.localStorage.setItem(key, JSON.stringify(persisted));
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: /decisions need you\./ })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();
  const resetInspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await resetInspector.getByText('Details', { exact: true }).click();
  await expect(resetInspector.getByText('Revision 5')).toBeVisible();
});

test('persisted task forecasts reject non-quarter-hour estimates', async ({ page }) => {
  const storageKey = 'steward-demo-state-v8';
  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) throw new Error('Expected the demo state to be persisted.');
    const state = JSON.parse(raw) as {
      agentTasks: Record<string, { expectedAgentMinutes: number; expectedCompletedAt: string }>;
    };
    state.agentTasks['lane-patch'].expectedAgentMinutes = 20;
    state.agentTasks['lane-patch'].expectedCompletedAt = '2026-07-19T00:07:00.000Z';
    window.localStorage.setItem(key, JSON.stringify(state));
  }, storageKey);

  await page.reload();
  await expect(page.getByRole('heading', { name: /decisions need you\./ })).toBeVisible();
  const restored = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const state = JSON.parse(raw) as {
      agentTasks: Record<string, { expectedAgentMinutes: number; expectedCompletedAt: string }>;
    };
    return state.agentTasks['lane-patch'];
  }, storageKey);
  expect(restored).toMatchObject({
    expectedAgentMinutes: 45,
    expectedCompletedAt: '2026-07-19T00:00:00.000Z',
  });
});

test('malformed run and observer links are rejected at the storage boundary', async ({ page }) => {
  const storageKey = 'steward-demo-state-v8';

  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) throw new Error('Expected the demo state to be persisted.');
    const persisted = JSON.parse(raw) as {
      runControls: Record<string, {
        activeRunId: string;
        status: string;
        signals: Array<Record<string, unknown>>;
        interruption?: Record<string, unknown>;
      }>;
    };
    const control = persisted.runControls['lane-patch'];
    control.status = 'interrupt_requested';
    control.signals.push({
      id: 'malformed-request',
      laneId: 'lane-patch',
      runId: 'RUN-OLD',
      action: 'interrupt_requested',
      issuedBy: 'user-jordan-lee',
      issuerKind: 'human',
      issuedAt: '2026-07-18T23:00:00.000Z',
      note: 'This syntactically valid request is linked to the wrong run.',
    });
    control.interruption = {
      runId: 'RUN-OLD',
      requestSignalId: 'malformed-request',
      requestedBy: 'user-jordan-lee',
      requestedAt: '2026-07-18T23:00:00.000Z',
      reason: 'This link must be rejected.',
    };
    window.localStorage.setItem(key, JSON.stringify(persisted));
  }, storageKey);

  await page.reload();
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();
  let inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector.getByText('Live agent view')).toBeVisible();
  await expect(inspector.getByText('Worker state unknown')).not.toBeVisible();
  await inspector.getByRole('button', { name: 'Close live run inspector' }).click();

  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) throw new Error('Expected reset demo state to be persisted.');
    const persisted = JSON.parse(raw) as {
      runs: Array<{ id: string; impactSummary: Record<string, unknown> }>;
      impactSlots: Record<string, Record<string, unknown>>;
    };
    const run = persisted.runs.find((item) => item.id === 'RUN-882');
    const slot = persisted.impactSlots['lane-patch'];
    if (!run || !slot) throw new Error('Expected the Patch summary slot.');
    const sourceSequence = Number(slot.latestSourceEventSequence) + 1;
    const sourceAt = '2026-07-18T23:01:00.000Z';
    slot.latestSourceEventSequence = sourceSequence;
    slot.latestSourceEventAt = sourceAt;
    slot.freshness = 'stale';
    slot.activeRequest = {
      id: 'malformed-impact-request',
      slotId: 'slot-for-a-different-run',
      baseRevision: run.impactSummary.revision,
      firstSourceEventSequence: sourceSequence,
      sourceEventSequence: sourceSequence,
      sourceEventAt: sourceAt,
      requestedAt: sourceAt,
      coalescedEventCount: 0,
      state: 'queued',
    };
    run.impactSummary.freshness = 'refreshing';
    run.impactSummary.pendingSourceEvents = 1;
    window.localStorage.setItem(key, JSON.stringify(persisted));
  }, storageKey);

  await page.reload();
  await page.getByRole('button', { name: 'Inspect live run RUN-882 for Patch' }).click();
  inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector.getByText('Current')).toBeVisible();
  await expect(inspector.getByText('Refresh failed')).not.toBeVisible();
  const slotAfterReset = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const persisted = JSON.parse(raw) as {
      impactSlots: Record<string, { activeRequest?: unknown; freshness: string }>;
    };
    return persisted.impactSlots['lane-patch'];
  }, storageKey);
  expect(slotAfterReset).toMatchObject({ freshness: 'fresh' });
  expect(slotAfterReset?.activeRequest).toBeUndefined();
});

test('stable lanes survive replacement, natural completion, idle queueing, and a new attempt', async ({ page }) => {
  const storageKey = 'steward-demo-state-v8';
  const replacementRunId = 'RUN-REPLACED';
  const nextRunId = 'RUN-NEXT';

  await page.evaluate(
    ({ key, replacementId }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error('Expected persisted demo state.');
      const persisted = JSON.parse(raw) as {
        runControls: Record<string, {
          activeRunId?: string;
          activeRunStartedAt?: string;
          status: string;
          signals: Array<Record<string, unknown>>;
          interruption?: unknown;
        }>;
      };
      const control = persisted.runControls['lane-patch'];
      const replacedAt = '2026-07-18T23:30:00.000Z';
      control.activeRunId = replacementId;
      control.activeRunStartedAt = replacedAt;
      control.status = 'running';
      delete control.interruption;
      control.signals.push({
        id: 'lifecycle-replace',
        laneId: 'lane-patch',
        runId: replacementId,
        action: 'run_replaced',
        issuedBy: 'orchestration-worker',
        issuerKind: 'service',
        issuedAt: replacedAt,
        note: 'A fresh provider attempt took over the same stable lane.',
        replacedRunId: 'RUN-882',
      });
      window.localStorage.setItem(key, JSON.stringify(persisted));
    },
    { key: storageKey, replacementId: replacementRunId },
  );

  await page.reload();
  await page
    .getByRole('button', { name: `Inspect live run ${replacementRunId} for Patch` })
    .click();
  let inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector.getByText('Live agent view')).toBeVisible();
  await expect(inspector.getByText(/queue survives run replacement/)).toBeVisible();
  const timingAfterReplacement = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const state = JSON.parse(raw) as {
      agentTasks: Record<string, { startedAt: string; endedAt?: string; expectedAgentMinutes: number }>;
    };
    return state.agentTasks['lane-patch'];
  }, storageKey);
  expect(timingAfterReplacement).toMatchObject({
    startedAt: '2026-07-18T23:04:00.000Z',
    expectedAgentMinutes: 45,
  });
  expect(timingAfterReplacement?.endedAt).toBeUndefined();
  await inspector.getByRole('button', { name: 'Close live run inspector' }).click();

  await page.evaluate(
    ({ key, replacementId }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error('Expected persisted replacement state.');
      const persisted = JSON.parse(raw) as {
        runControls: Record<string, Record<string, unknown> & {
          signals: Array<Record<string, unknown>>;
        }>;
      };
      const control = persisted.runControls['lane-patch'];
      const completedAt = '2026-07-18T23:31:00.000Z';
      const note = 'The provider reported natural completion before another attempt began.';
      const providerEvidence = 'provider-event:patch-completed-2031';
      control.signals.push({
        id: 'lifecycle-complete',
        laneId: 'lane-patch',
        runId: replacementId,
        action: 'run_completed',
        issuedBy: 'orchestration-worker',
        issuerKind: 'service',
        issuedAt: completedAt,
        note,
        completionRelation: 'without_interruption',
        completionFromStatus: 'running',
        providerEvidence,
      });
      delete control.activeRunId;
      delete control.activeRunStartedAt;
      delete control.interruption;
      control.status = 'idle';
      control.lastCompletion = {
        runId: replacementId,
        signalId: 'lifecycle-complete',
        completedAt,
        relationToInterruption: 'without_interruption',
        priorControlStatus: 'running',
        note,
        providerEvidence,
      };
      window.localStorage.setItem(key, JSON.stringify(persisted));
    },
    { key: storageKey, replacementId: replacementRunId },
  );

  await page.reload();
  await page
    .getByRole('button', { name: `Inspect live run ${replacementRunId} for Patch` })
    .click();
  inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector.getByText('Lane idle')).toBeVisible();
  await expect(inspector.getByText('No active run', { exact: true }).first()).toBeVisible();
  await expect(inspector.getByText('Paused during human wait', { exact: true })).toBeVisible();
  const timingAfterRunCompletion = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const state = JSON.parse(raw) as {
      agentTasks: Record<string, { startedAt: string; endedAt?: string }>;
    };
    return state.agentTasks['lane-patch'];
  }, storageKey);
  expect(timingAfterRunCompletion?.startedAt).toBe('2026-07-18T23:04:00.000Z');
  expect(timingAfterRunCompletion?.endedAt).toBeUndefined();
  await inspector.getByRole('button', { name: 'Queue work' }).click();
  const queueDialog = page.getByRole('dialog', { name: 'Queue work for Patch' });
  await queueDialog.getByLabel('Short title').fill('Carry context into the next attempt');
  await queueDialog
    .getByLabel('Desired user outcome')
    .fill('The next provider attempt receives the human outcome without losing completed evidence.');
  await queueDialog.getByRole('button', { name: "Add to Patch's queue" }).click();
  await expect(inspector.getByText('Carry context into the next attempt')).toBeVisible();

  await page.evaluate(
    ({ key, nextId }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) throw new Error('Expected persisted idle queue state.');
      const persisted = JSON.parse(raw) as {
        runControls: Record<string, Record<string, unknown> & {
          signals: Array<Record<string, unknown>>;
        }>;
      };
      const control = persisted.runControls['lane-patch'];
      const lastSignalAt = String(control.signals.at(-1)?.issuedAt ?? new Date().toISOString());
      const startedAt = new Date(Math.max(Date.now(), Date.parse(lastSignalAt)) + 1).toISOString();
      control.activeRunId = nextId;
      control.activeRunStartedAt = startedAt;
      control.status = 'running';
      control.signals.push({
        id: 'lifecycle-start-next',
        laneId: 'lane-patch',
        runId: nextId,
        action: 'run_started',
        issuedBy: 'orchestration-worker',
        issuerKind: 'service',
        issuedAt: startedAt,
        note: 'A globally new provider attempt started on the stable lane.',
      });
      window.localStorage.setItem(key, JSON.stringify(persisted));
    },
    { key: storageKey, nextId: nextRunId },
  );

  await page.reload();
  await page.getByRole('button', { name: `Inspect live run ${nextRunId} for Patch` }).click();
  inspector = page.getByRole('dialog', { name: 'Patch · STW-471' });
  await expect(inspector.getByText('Live agent view')).toBeVisible();
  await expect(inspector.getByText('Carry context into the next attempt')).toBeVisible();
});

test('mobile Runs navigation is tappable and opens agent sessions', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile-only navigation assertion.');

  const mobileNavigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  const runsButton = mobileNavigation.getByRole('button', { name: 'Runs', exact: true });
  await expect(runsButton).toBeVisible();
  await expect(runsButton).toBeEnabled();

  const tapTarget = await runsButton.boundingBox();
  expect(tapTarget?.height ?? 0).toBeGreaterThanOrEqual(48);

  await runsButton.click();
  await expect(page.getByRole('heading', { name: 'Agent sessions' })).toBeVisible();
  await page.getByRole('button', { name: 'Open human controls for Patch' }).click();
  await expect(page.getByRole('dialog', { name: 'Patch · STW-471' })).toBeVisible();
});

test('a manager live run shows completed engineering evidence before human handoff', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), 'Desktop exposes all three overview run cards without mobile scrolling ambiguity.');

  await page.getByRole('button', { name: 'Inspect live run RUN-879 for Vale' }).click();
  const inspector = page.getByRole('dialog', { name: 'Vale · STW-479' });
  await expect(inspector.getByText('Manager checking')).toBeVisible();
  await expect(inspector.getByText('Engineering loop complete')).toBeVisible();
  await expect(inspector.getByText('State invariants checked')).toBeVisible();
  await expect(inspector.getByText('src/imports/recovery-machine.ts', { exact: true }).first()).toBeVisible();
  await expect(inspector.getByText(/post a human production-check task/i)).toBeVisible();
});

test('the visible route simulator uses the tested canonical policy', async ({ page, isMobile }) => {
  if (isMobile) await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Model policy' }).click();
  await expect(page.getByText('GPT-5.6 Terra').last()).toBeVisible();

  await page.locator('#sim-risk').selectOption('low');
  await expect(page.getByText('GPT-5.4 mini').last()).toBeVisible();

  await page.locator('#sim-failures').fill('2');
  await expect(page.getByText('GPT-5.6 Sol').last()).toBeVisible();
  await expect(page.getByText('Frontier route')).toBeVisible();
});
