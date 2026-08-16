import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Button, FieldLabel, InlineActionErrors, Modal, cn, inputClass } from '../../components/ui';
import { fieldsAreDirty } from '../../components/dialog-discard';
import { BoardApiError, type TaskBoardClient } from '../data/client';
import { randomUuid } from '../data/uuid';
import type { ActionError, ActionResult } from '../model/action-errors';
import { addedWorkspacePaths, breadcrumbSegments, filterPickerEntries, pickerEntries } from '../model/project-picker';
import type { BoardSnapshot, CreateProjectInput, CreateWorkItemInput, HostDirectoryListing, HostProjectRoot } from '../types';

export type DialogName = 'project' | 'task' | null;

function normalizedWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '/' || /^[A-Za-z]:[\\/]$/u.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/u, '');
}

function projectNameFromPath(path: string): string {
  const segment = path.split(/[\\/]/u).filter(Boolean).at(-1)?.trim();
  return segment ?? '';
}

function breadcrumbIsReachable(path: string, boundary: string | null): boolean {
  if (boundary === null) return false;
  if (boundary === '/') return path.startsWith('/');
  return path === boundary || path.startsWith(`${boundary}/`);
}

function hostPathError(caught: unknown, fallback: string): string {
  if (!(caught instanceof BoardApiError)) return fallback;
  if (caught.code === 'HOST_PATH_NOT_FOUND') return 'That folder does not exist';
  if (caught.code === 'HOST_PATH_NOT_DIRECTORY') return 'That path is a file, not a folder';
  if (caught.code === 'HOST_PATH_OUTSIDE_ROOTS') return 'That folder is outside the browsable area';
  if (caught.code === 'HOST_PATH_UNREADABLE') return 'That folder cannot be read';
  return fallback;
}

function ProjectForm({
  client,
  projects,
  busy,
  errors,
  onDismissError,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  client: TaskBoardClient;
  projects: BoardSnapshot['projects'];
  busy: boolean;
  errors: readonly ActionError[];
  onDismissError: (context: string) => void;
  onSubmit: (input: CreateProjectInput) => Promise<ActionResult>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useState<'list' | 'browse'>('list');
  const [roots, setRoots] = useState<HostProjectRoot[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [discoveryUnavailable, setDiscoveryUnavailable] = useState(false);
  const [listing, setListing] = useState<HostDirectoryListing | null>(null);
  const [reachableBoundary, setReachableBoundary] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState('');
  const [browseFilter, setBrowseFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteOutsideRoots, setPasteOutsideRoots] = useState(false);
  const [validatingPaste, setValidatingPaste] = useState(false);
  const browseControllerRef = useRef<AbortController | null>(null);
  const pasteControllerRef = useRef<AbortController | null>(null);
  // Paste validation is async; read the name at submit time, not capture time,
  // so an edit made while "Checking folder…" is shown is not discarded.
  const nameRef = useRef('');
  nameRef.current = name;
  const browseInitializedRef = useRef(false);
  const pasteInputRef = useRef<HTMLInputElement>(null);

  const addedPaths = useMemo(() => addedWorkspacePaths(projects), [projects]);
  const discoveredEntries = useMemo(() => pickerEntries(roots, addedPaths), [addedPaths, roots]);
  const groupedEntries = useMemo(() => roots.map((root) => ({
    rootName: root.name,
    rootPath: root.path,
    entries: filterPickerEntries(pickerEntries([root], addedPaths), listFilter),
  })).filter((group) => group.entries.length > 0), [addedPaths, listFilter, roots]);
  const filteredDirectories = useMemo(() => {
    const needle = browseFilter.trim().toLowerCase();
    if (!listing || needle.length === 0) return listing?.entries ?? [];
    return listing.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [browseFilter, listing]);
  const breadcrumbs = useMemo(() => listing
    ? [{ label: 'Root', path: '/' }, ...breadcrumbSegments(listing.path)]
    : [], [listing]);

  const normalizedPath = normalizedWorkspacePath(workspacePath);
  const validName = name.trim().length > 0 && name.trim().length <= 160;
  const validPastePath = taskWorkspaceRefs(normalizedPath).length === 1;
  const showPathError = workspacePath.trim().length > 0 && !validPastePath;
  const pasteHelpId = 'project-folder-help';
  const pathErrorId = 'project-folder-error';
  const pasteServerErrorId = 'project-folder-server-error';
  const pasteDescribedBy = [
    pasteHelpId,
    showPathError ? pathErrorId : null,
    pasteError ? pasteServerErrorId : null,
  ].filter(Boolean).join(' ');

  const loadDirectories = useCallback(async (path?: string) => {
    browseControllerRef.current?.abort();
    const controller = new AbortController();
    browseControllerRef.current = controller;
    browseInitializedRef.current = true;
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const nextListing = await client.getHostDirectories(path, controller.signal);
      if (!controller.signal.aborted) {
        setListing(nextListing);
        if (nextListing.parent === null) setReachableBoundary(nextListing.path);
        setBrowseFilter('');
      }
    } catch (caught) {
      if (!controller.signal.aborted) setBrowseError(hostPathError(caught, 'That folder could not be opened'));
    } finally {
      if (browseControllerRef.current === controller) {
        browseControllerRef.current = null;
        setBrowseLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    setDiscoveryLoading(true);
    void client.getHostProjectRoots(controller.signal).then(
      (nextRoots) => {
        if (controller.signal.aborted) return;
        setRoots(nextRoots);
        if (!nextRoots.some((root) => root.projects.length > 0)) {
          setMode('browse');
          if (!browseInitializedRef.current) void loadDirectories();
        }
      },
      () => {
        if (controller.signal.aborted) return;
        setDiscoveryUnavailable(true);
        setMode('browse');
        if (!browseInitializedRef.current) void loadDirectories();
      },
    ).finally(() => {
      if (!controller.signal.aborted) setDiscoveryLoading(false);
    });
    return () => controller.abort();
  }, [client, loadDirectories]);

  useEffect(() => () => {
    const browseController = browseControllerRef.current;
    const pasteController = pasteControllerRef.current;
    browseControllerRef.current = null;
    pasteControllerRef.current = null;
    browseController?.abort();
    pasteController?.abort();
  }, []);

  useEffect(() => {
    if (mode === 'browse' && browseError && listing === null) {
      pasteInputRef.current?.focus({ preventScroll: true });
    }
  }, [browseError, listing, mode]);

  useEffect(() => {
    onDirtyChange(
      fieldsAreDirty([listFilter, browseFilter, name, workspacePath])
      || selectedPath !== null,
    );
  }, [browseFilter, listFilter, name, onDirtyChange, selectedPath, workspacePath]);

  const selectPath = (path: string, suggestedName: string) => {
    pasteControllerRef.current?.abort();
    pasteControllerRef.current = null;
    setValidatingPaste(false);
    setSelectedPath(path);
    setName(suggestedName);
    setWorkspacePath('');
    setPasteError(null);
    setPasteOutsideRoots(false);
  };

  const openBrowse = () => {
    setMode('browse');
    if (!listing && !browseLoading) void loadDirectories();
  };

  const openList = () => {
    setBrowseError(null);
    setMode('list');
  };

  const submitPaste = async () => {
    if (!validName || !validPastePath || busy || validatingPaste || pasteOutsideRoots) return;
    pasteControllerRef.current?.abort();
    const controller = new AbortController();
    pasteControllerRef.current = controller;
    setValidatingPaste(true);
    setPasteError(null);
    setPasteOutsideRoots(false);
    try {
      await client.getHostDirectories(normalizedPath, controller.signal);
      if (!controller.signal.aborted) {
        const latestName = nameRef.current.trim();
        if (latestName.length > 0 && latestName.length <= 160) {
          await onSubmit({ name: latestName, description: normalizedPath });
        }
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      const outsideRoots = caught instanceof BoardApiError && caught.code === 'HOST_PATH_OUTSIDE_ROOTS';
      setPasteOutsideRoots(outsideRoots);
      setPasteError(outsideRoots
        ? 'That folder is outside the browsable area — you can still add it if the path is correct'
        : hostPathError(caught, 'That folder could not be checked'));
    } finally {
      if (pasteControllerRef.current === controller) {
        pasteControllerRef.current = null;
        setValidatingPaste(false);
      }
    }
  };

  const submitProject = () => {
    if (busy || validatingPaste || pasteOutsideRoots || !validName) return;
    if (selectedPath) {
      void onSubmit({ name: name.trim(), description: selectedPath });
      return;
    }
    void submitPaste();
  };

  const pickerErrors = [
    ...(discoveryUnavailable ? [{ context: 'project-discovery', error: 'Project discovery is unavailable' }] : []),
    ...(mode === 'browse' && browseError ? [{ context: 'project-browse', error: browseError }] : []),
  ];

  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); submitProject(); }}>
      <div className="flex items-center gap-1 rounded-[99px] border border-line bg-muted-surface p-1" role="group" aria-label="Project folder source">
        <Button className="min-w-0 flex-1" size="sm" variant={mode === 'list' ? 'secondary' : 'quiet'} disabled={discoveryLoading || discoveredEntries.length === 0} aria-pressed={discoveryLoading ? undefined : mode === 'list'} onClick={openList}>
          Your projects
        </Button>
        <Button className="min-w-0 flex-1" size="sm" variant={mode === 'browse' ? 'secondary' : 'quiet'} aria-pressed={mode === 'browse'} onClick={openBrowse}>
          Browse
        </Button>
      </div>

      {pickerErrors.length > 0 ? (
        <InlineActionErrors
          errors={pickerErrors}
          onDismiss={(context) => {
            if (context === 'project-discovery') setDiscoveryUnavailable(false);
            if (context === 'project-browse') setBrowseError(null);
          }}
        />
      ) : null}

      {mode === 'list' ? (
        <div className="space-y-3">
          <div>
            <FieldLabel htmlFor="project-filter">Filter projects</FieldLabel>
            <input id="project-filter" className={inputClass} type="search" data-dialog-initial-focus value={listFilter} onChange={(event) => setListFilter(event.target.value)} placeholder="Search by project name" />
          </div>
          {discoveryLoading ? (
            <p className="rounded-xl border border-line bg-muted-surface px-4 py-5 text-center text-sm text-muted" role="status">Finding projects…</p>
          ) : groupedEntries.length > 0 ? (
            <div className="max-h-64 space-y-4 overflow-y-auto overscroll-contain pr-1">
              {groupedEntries.map(({ rootName, rootPath, entries }, groupIndex) => (
                <section key={rootPath} aria-labelledby={`project-root-${groupIndex}`}>
                  <h3 id={`project-root-${groupIndex}`} className="mb-1.5 px-1 text-[11px] font-semibold text-muted">{rootName}</h3>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                    {entries.map((entry) => (
                      <li key={entry.path}>
                        <button
                          type="button"
                          className={cn(
                            'flex min-h-12 w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-taupe-hover enabled:hover:bg-muted-surface',
                            selectedPath === entry.path && 'bg-muted-surface',
                          )}
                          disabled={busy || entry.added}
                          aria-pressed={entry.added ? undefined : selectedPath === entry.path}
                          onClick={() => selectPath(entry.path, entry.name)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-ink">{entry.name}</span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">{entry.path}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {entry.hasGit ? <span className="rounded-[6px] bg-muted-surface px-2 py-1 text-[11px] font-medium text-muted">Git</span> : null}
                            {entry.added ? <span className="rounded-[6px] bg-success-soft px-2 py-1 text-[11px] font-medium text-success">Added</span> : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-line bg-muted-surface px-4 py-5 text-center text-sm text-muted">No projects match that filter.</p>
          )}
          {roots.some((root) => root.truncated) ? <p className="text-xs text-muted">Showing the first 500 entries</p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          {listing ? (
            <nav aria-label="Folder path" className="overflow-x-auto">
              <ol className="flex min-w-max items-center gap-1 text-xs text-muted">
                {breadcrumbs.map((crumb, index) => (
                  <li key={crumb.path} className="flex items-center gap-1">
                    {index > 0 ? <span aria-hidden="true">/</span> : null}
                    {breadcrumbIsReachable(crumb.path, reachableBoundary) ? (
                      <button
                        type="button"
                        className="min-h-9 rounded-[6px] px-2 font-medium text-ink transition-colors hover:bg-muted-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                        aria-current={crumb.path === listing.path ? 'page' : undefined}
                        disabled={busy || browseLoading}
                        onClick={() => void loadDirectories(crumb.path)}
                      >
                        {crumb.label}
                      </button>
                    ) : (
                      <span className="inline-flex min-h-9 items-center px-2 text-muted" aria-current={crumb.path === listing.path ? 'page' : undefined}>
                        {crumb.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          <div>
            <FieldLabel htmlFor="folder-filter">Filter folders</FieldLabel>
            <input id="folder-filter" className={inputClass} type="search" data-dialog-initial-focus disabled={!listing || browseLoading} value={browseFilter} onChange={(event) => setBrowseFilter(event.target.value)} placeholder="Search this folder" />
          </div>
          {listing ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-muted-surface px-3.5 py-2.5">
              <p className="min-w-0 truncate font-mono text-[11px] text-muted">{listing.path}</p>
              <Button size="sm" disabled={busy || browseLoading} onClick={() => selectPath(listing.path, projectNameFromPath(listing.path))}>Use this folder</Button>
            </div>
          ) : null}
          {browseLoading && !listing ? (
            <p className="rounded-xl border border-line bg-muted-surface px-4 py-5 text-center text-sm text-muted" role="status">Loading folders…</p>
          ) : listing && filteredDirectories.length > 0 ? (
            <ul className="max-h-56 divide-y divide-line overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface">
              {filteredDirectories.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-taupe-hover"
                    disabled={busy || browseLoading}
                    onClick={() => void loadDirectories(entry.path)}
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-ink">{entry.name}</span>
                    {entry.hasGit ? <span className="shrink-0 rounded-[6px] bg-muted-surface px-2 py-1 text-[11px] font-medium text-muted">Git</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : listing ? (
            <p className="rounded-xl border border-line bg-muted-surface px-4 py-5 text-center text-sm text-muted">{browseFilter.trim() ? 'No folders match that filter.' : 'No folders here.'}</p>
          ) : !browseLoading ? (
            <Button className="w-full" size="sm" disabled={browseLoading} onClick={() => void loadDirectories()}>Try browsing again</Button>
          ) : null}
          {browseLoading && listing ? <p className="text-xs text-muted" role="status">Loading folders…</p> : null}
          {listing?.truncated ? <p className="text-xs text-muted">Showing the first 500 entries</p> : null}
        </div>
      )}

      <div>
        <FieldLabel htmlFor="project-name">Name</FieldLabel>
        <input id="project-name" className={inputClass} required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" />
      </div>
      {selectedPath ? (
        <div className="rounded-xl border border-line bg-muted-surface px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-ink">Selected path</p>
              <p className="mt-1 break-all font-mono text-[11px] leading-5 text-muted">{selectedPath}</p>
            </div>
            <Button className="shrink-0" size="sm" variant="quiet" disabled={busy} onClick={() => { setSelectedPath(null); setName(''); }}>Clear</Button>
          </div>
        </div>
      ) : null}

      <div className="border-t border-line pt-4">
        <FieldLabel htmlFor="project-folder">Project folder</FieldLabel>
        <input ref={pasteInputRef} id="project-folder" className={cn(inputClass, 'font-mono text-xs')} aria-invalid={showPathError || pasteError ? true : undefined} aria-describedby={pasteDescribedBy} value={workspacePath} onChange={(event) => {
          const nextPath = event.target.value;
          const currentSuggestedName = projectNameFromPath(normalizedWorkspacePath(workspacePath));
          pasteControllerRef.current?.abort();
          pasteControllerRef.current = null;
          setValidatingPaste(false);
          setWorkspacePath(nextPath);
          setSelectedPath(null);
          setPasteError(null);
          setPasteOutsideRoots(false);
          if (selectedPath !== null || name.length === 0 || name === currentSuggestedName) {
            setName(projectNameFromPath(normalizedWorkspacePath(nextPath)));
          }
        }} placeholder="/absolute/path/to/project" />
        <p id={pasteHelpId} className="mt-1.5 text-xs leading-5 text-muted">Paste an absolute path if the folder is not listed above.</p>
        {showPathError ? <p id={pathErrorId} className="mt-1.5 text-xs leading-5 text-urgent">Must be an absolute path, e.g. /Users/you/project</p> : null}
        {pasteError ? (
          <div id={pasteServerErrorId} className="mt-2 flex flex-col items-start gap-2 rounded-xl border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-xs leading-5 text-urgent" role="alert">
            <span>{pasteError}</span>
            {pasteOutsideRoots ? (
              <Button size="sm" disabled={busy || !validName || !validPastePath} onClick={() => { setPasteError(null); setPasteOutsideRoots(false); void onSubmit({ name: name.trim(), description: normalizedPath }); }}>Add anyway</Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="primary" disabled={busy || validatingPaste || pasteOutsideRoots || !validName || (!selectedPath && !validPastePath)}>{validatingPaste ? 'Checking folder…' : 'Add project'}</Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}


function taskWorkspaceRefs(workspacePath?: string | null): string[] {
  const path = workspacePath?.trim();
  if (!path || path.length > 512 || /[\r\n]/u.test(path)) return [];
  const absolutePosixPath = path.startsWith('/');
  const absoluteWindowsPath = /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path);
  return absolutePosixPath || absoluteWindowsPath ? [path] : [];
}

function WorkItemForm({
  projects,
  defaultProjectId,
  busy,
  errors,
  onDismissError,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  projects: BoardSnapshot['projects'];
  defaultProjectId: string | null;
  busy: boolean;
  errors: readonly ActionError[];
  onDismissError: (context: string) => void;
  onSubmit: (input: CreateWorkItemInput) => Promise<ActionResult>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState<CreateWorkItemInput['priority']>('normal');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [idempotencyKey, setIdempotencyKey] = useState(randomUuid);
  const normalizedPrompt = prompt.trim();
  const projectChosen = projects.some((project) => project.id === projectId);
  const regenerateIdempotencyKey = () => setIdempotencyKey(randomUuid());
  const initialProjectId = defaultProjectId ?? '';
  const reportDirty = (next: {
    prompt?: string;
    priority?: CreateWorkItemInput['priority'];
    projectId?: string;
  }) => {
    onDirtyChange(
      fieldsAreDirty([next.prompt ?? prompt])
      || (next.priority ?? priority) !== 'normal'
      || (next.projectId ?? projectId) !== initialProjectId,
    );
  };
  return (
    <form
      className="space-y-4 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!normalizedPrompt || !projectChosen) return;
        void onSubmit({
          originalRequest: normalizedPrompt,
          priority,
          projectId,
          idempotencyKey,
        });
      }}
    >
      <div>
        <FieldLabel htmlFor="task-prompt">Task</FieldLabel>
        <textarea
          id="task-prompt"
          className={cn(inputClass, 'min-h-32 resize-y py-3')}
          autoFocus
          required
          maxLength={16_000}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            reportDirty({ prompt: event.target.value });
            regenerateIdempotencyKey();
          }}
          placeholder="What should be done?"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="work-item-priority">Priority</FieldLabel>
          <select
            id="work-item-priority"
            className={inputClass}
            value={priority}
            onChange={(event) => {
              const nextPriority = event.target.value as CreateWorkItemInput['priority'];
              setPriority(nextPriority);
              reportDirty({ priority: nextPriority });
              regenerateIdempotencyKey();
            }}
          >
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div>
          <FieldLabel htmlFor="work-item-project">Project</FieldLabel>
          <select
            id="work-item-project"
            className={inputClass}
            required
            disabled={projects.length === 0}
            aria-describedby={projects.length === 0 ? 'work-item-project-help' : undefined}
            value={projectChosen ? projectId : ''}
            onChange={(event) => {
              setProjectId(event.target.value);
              reportDirty({ projectId: event.target.value });
              regenerateIdempotencyKey();
            }}
          >
            <option value="" disabled>Choose a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          {projects.length === 0 ? (
            <p id="work-item-project-help" className="mt-2 text-xs leading-5 text-muted">
              No projects exist yet. Close this form and choose Add project first.
            </p>
          ) : null}
        </div>
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="primary" disabled={busy || !normalizedPrompt || !projectChosen}>
          {projectChosen ? 'Submit task' : 'Choose a project'}
        </Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function CreateDialogs({
  client,
  dialog,
  closeDialog,
  projectFormDirty,
  workItemFormDirty,
  dialogProject,
  snapshot,
  busy,
  connected,
  projectCreateErrors,
  workItemCreateErrors,
  dismissActionError,
  createProject,
  createWorkItem,
}: {
  client: TaskBoardClient;
  dialog: DialogName;
  closeDialog: () => void;
  projectFormDirty: RefObject<boolean>;
  workItemFormDirty: RefObject<boolean>;
  dialogProject: BoardSnapshot['projects'][number] | undefined;
  snapshot: BoardSnapshot | null;
  busy: boolean;
  connected: boolean;
  projectCreateErrors: readonly ActionError[];
  workItemCreateErrors: readonly ActionError[];
  dismissActionError: (context: string) => void;
  createProject: (input: CreateProjectInput) => Promise<ActionResult>;
  createWorkItem: (input: CreateWorkItemInput) => Promise<ActionResult>;
}) {
  return (
    <>
      <Modal
        open={dialog === 'project'}
        onClose={closeDialog}
        isDirty={() => projectFormDirty.current}
        title="Add project from disk"
        description="Pick a project folder, browse for one, or paste a path."
      >
        {(requestClose) => <ProjectForm
          client={client}
          projects={snapshot?.projects ?? []}
          busy={busy || !connected}
          errors={projectCreateErrors}
          onDismissError={dismissActionError}
          onSubmit={createProject}
          onCancel={requestClose}
          onDirtyChange={(dirty) => { projectFormDirty.current = dirty; }}
        />}
      </Modal>
      <Modal
        open={dialog === 'task'}
        onClose={closeDialog}
        isDirty={() => workItemFormDirty.current}
        title={dialogProject ? `Add a task to ${dialogProject.name}` : 'Add a task'}
        description="Records a durable intake request. This step does not wake an agent yet."
      >
        {(requestClose) => <WorkItemForm
          key={dialogProject?.id ?? 'unselected'}
          projects={snapshot?.projects ?? []}
          defaultProjectId={dialogProject?.id ?? null}
          busy={busy || !connected}
          errors={workItemCreateErrors}
          onDismissError={dismissActionError}
          onSubmit={createWorkItem}
          onCancel={requestClose}
          onDirtyChange={(dirty) => { workItemFormDirty.current = dirty; }}
        />}
      </Modal>
    </>
  );
}
