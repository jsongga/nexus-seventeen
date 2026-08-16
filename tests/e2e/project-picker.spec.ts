import { expect, test, type Locator, type Page } from '@playwright/test';

const apiVersion = 'steward.task-board/v1' as const;
const existingProject = {
  apiVersion,
  projectId: 'project-older',
  name: 'older',
  description: '/home/u/WebstormProjects/older',
  version: 1,
  createdAt: '2026-08-15T12:00:00.000Z',
  updatedAt: '2026-08-15T12:00:00.000Z',
};

const projectRoots = [{
  name: 'WebstormProjects',
  path: '/home/u/WebstormProjects',
  projects: [
    {
      name: 'older',
      path: '/home/u/WebstormProjects/older',
      hasGit: true,
      modifiedAtMs: 100,
    },
    {
      name: 'newer',
      path: '/home/u/WebstormProjects/newer',
      hasGit: false,
      modifiedAtMs: 200,
    },
  ],
  truncated: false,
}];

function board() {
  return {
    apiVersion,
    project: existingProject,
    agents: [],
    tasks: [],
    openQuestions: [],
    recentQuestions: [],
    recentRuns: [],
    recentInterrupts: [],
    recentEvents: [],
    documents: [],
  };
}

async function installProjectPickerApi(page: Page): Promise<{ projectRequests: Array<Record<string, unknown>> }> {
  const projectRequests: Array<Record<string, unknown>> = [];

  await page.route('**/board-api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/board-api/v1/host/project-roots' && method === 'GET') {
      await route.fulfill({ json: { roots: projectRoots } });
      return;
    }
    if (url.pathname === '/board-api/v1/host/directories' && method === 'GET') {
      const path = url.searchParams.get('path');
      if (path === null) {
        await route.fulfill({
          json: {
            listing: {
              path: '/home/u',
              parent: null,
              entries: [{ name: 'WebstormProjects', path: '/home/u/WebstormProjects', hasGit: false }],
              truncated: false,
            },
          },
        });
        return;
      }
      if (path === '/home/u/WebstormProjects') {
        await route.fulfill({
          json: {
            listing: {
              path,
              parent: '/home/u',
              entries: [
                { name: 'older', path: `${path}/older`, hasGit: true },
                { name: 'newer', path: `${path}/newer`, hasGit: false },
              ],
              truncated: true,
            },
          },
        });
        return;
      }
      if (path === '/home/u/nope') {
        await route.fulfill({
          status: 404,
          json: { error: { code: 'HOST_PATH_NOT_FOUND', message: 'The folder does not exist' } },
        });
        return;
      }
      if (path === '/outside/team/repository') {
        await route.fulfill({
          status: 403,
          json: { error: { code: 'HOST_PATH_OUTSIDE_ROOTS', message: 'The folder is outside the browsable area' } },
        });
        return;
      }
    }
    if (url.pathname === '/board-api/v1/work-items' && method === 'GET') {
      await route.fulfill({ json: { workItems: [] } });
      return;
    }
    if (url.pathname === '/board-api/v1/projects' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      projectRequests.push(body);
      await route.fulfill({
        status: 201,
        json: {
          project: {
            ...existingProject,
            projectId: `project-created-${projectRequests.length}`,
            name: body.name,
            description: body.description,
            createdAt: '2026-08-15T13:00:00.000Z',
            updatedAt: '2026-08-15T13:00:00.000Z',
          },
        },
      });
      return;
    }
    if (url.pathname === '/board-api/v1/projects' && method === 'GET') {
      await route.fulfill({ json: { projects: [existingProject] } });
      return;
    }
    if (url.pathname === `/board-api/v1/projects/${existingProject.projectId}/board` && method === 'GET') {
      await route.fulfill({ json: board() });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });

  return { projectRequests };
}

async function openProjectPicker(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project from disk', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('adds a discovered project and marks an existing Git project as already added', async ({ page }) => {
  const { projectRequests } = await installProjectPickerApi(page);
  const dialog = await openProjectPicker(page);
  const source = dialog.getByRole('group', { name: 'Project folder source', exact: true });

  await expect(source.getByRole('button', { name: 'Your projects', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(source.getByRole('button', { name: 'Browse', exact: true })).toHaveAttribute('aria-pressed', 'false');

  const group = dialog.getByRole('heading', { name: 'WebstormProjects', exact: true }).locator('..');
  const rows = group.getByRole('button');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('newer');
  await expect(rows.nth(1)).toContainText('older');

  const older = group.getByRole('button', { name: /^older\b/u });
  await expect(older).toBeDisabled();
  await expect(older).toContainText('Git');
  await expect(older).toContainText('Added');

  const filter = dialog.getByRole('searchbox', { name: 'Filter projects', exact: true });
  await filter.fill('new');
  await expect(group.getByRole('button', { name: /^older\b/u })).toHaveCount(0);

  await group.getByRole('button', { name: /^newer\b/u }).click();
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('newer');
  await expect(dialog.getByRole('paragraph').filter({ hasText: '/home/u/WebstormProjects/newer' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();

  await expect.poll(() => projectRequests.length).toBe(1);
  expect(projectRequests).toEqual([{
    name: 'newer',
    description: '/home/u/WebstormProjects/newer',
  }]);
  await expect(dialog).toHaveCount(0);
});

test('browses from the reachable boundary and adds the current folder with an edited name', async ({ page }) => {
  const { projectRequests } = await installProjectPickerApi(page);
  const dialog = await openProjectPicker(page);
  const source = dialog.getByRole('group', { name: 'Project folder source', exact: true });

  await source.getByRole('button', { name: 'Browse', exact: true }).click();
  await expect(source.getByRole('button', { name: 'Browse', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const breadcrumbs = dialog.getByRole('navigation', { name: 'Folder path', exact: true });
  await expect(breadcrumbs.getByText('Root', { exact: true })).toBeVisible();
  await expect(breadcrumbs.getByRole('button', { name: 'Root', exact: true })).toHaveCount(0);
  await expect(breadcrumbs.getByRole('button', { name: 'home', exact: true })).toHaveCount(0);
  await expect(breadcrumbs.getByRole('button', { name: 'u', exact: true })).toHaveAttribute('aria-current', 'page');

  const filter = dialog.getByRole('searchbox', { name: 'Filter folders', exact: true });
  await filter.fill('web');
  await dialog.getByRole('button', { name: 'WebstormProjects', exact: true }).click();

  await expect(breadcrumbs.getByRole('button', { name: 'u', exact: true })).not.toHaveAttribute('aria-current', 'page');
  await expect(breadcrumbs.getByRole('button', { name: 'WebstormProjects', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(dialog.getByText('Showing the first 500 entries', { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toHaveValue('WebstormProjects');
  await name.fill('Everything');
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();

  await expect.poll(() => projectRequests.length).toBe(1);
  expect(projectRequests).toEqual([{
    name: 'Everything',
    description: '/home/u/WebstormProjects',
  }]);
  await expect(dialog).toHaveCount(0);
});

test('shows an inline error and does not post when a pasted folder is missing', async ({ page }) => {
  const { projectRequests } = await installProjectPickerApi(page);
  const dialog = await openProjectPicker(page);

  await dialog.getByRole('textbox', { name: 'Project folder', exact: true }).fill('/home/u/nope');
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();

  await expect(dialog.getByRole('alert')).toContainText('That folder does not exist');
  await expect(dialog.getByRole('button', { name: 'Add anyway', exact: true })).toHaveCount(0);
  expect(projectRequests).toEqual([]);
});

test('allows an explicit override for a pasted folder outside the browsable area', async ({ page }) => {
  const { projectRequests } = await installProjectPickerApi(page);
  const dialog = await openProjectPicker(page);

  await dialog.getByRole('textbox', { name: 'Project folder', exact: true }).fill('/outside/team/repository');
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();

  await expect(dialog.getByRole('alert')).toContainText('outside the browsable area');
  await expect(dialog.getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Add anyway', exact: true }).click();

  await expect.poll(() => projectRequests.length).toBe(1);
  expect(projectRequests).toEqual([{
    name: 'repository',
    description: '/outside/team/repository',
  }]);
  await expect(dialog).toHaveCount(0);
});
