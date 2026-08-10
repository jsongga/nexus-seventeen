import { useState, type RefObject } from 'react';
import { Button, FieldLabel, InlineActionErrors, Modal, cn, inputClass } from '../../components/ui';
import { fieldsAreDirty } from '../../components/dialog-discard';
import { randomUuid } from '../data/uuid';
import type { ActionError, ActionResult } from '../model/action-errors';
import type { BoardSnapshot, CreateProjectInput, CreateWorkItemInput } from '../types';

export type DialogName = 'project' | 'task' | null;

function ProjectForm({
  busy,
  errors,
  onDismissError,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  busy: boolean;
  errors: readonly ActionError[];
  onDismissError: (context: string) => void;
  onSubmit: (input: CreateProjectInput) => Promise<ActionResult>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [workspacePath, setWorkspacePath] = useState('');
  const normalizedPath = workspacePath.trim().replace(/[\\/]+$/u, '');
  const projectName = normalizedPath.split(/[\\/]/u).at(-1)?.trim() ?? '';
  const validPath = projectName.length > 0 && projectName.length <= 160 && taskWorkspaceRefs(normalizedPath).length === 1;
  const showPathError = workspacePath.trim().length > 0 && !validPath;
  const pathErrorId = 'project-folder-error';
  return (
    <form className="space-y-4 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); if (validPath) void onSubmit({ name: projectName, description: normalizedPath }); }}>
      <div>
        <FieldLabel htmlFor="project-folder">Project folder</FieldLabel>
        <input id="project-folder" className={cn(inputClass, 'font-mono text-xs')} autoFocus required aria-invalid={showPathError || undefined} aria-describedby={showPathError ? pathErrorId : undefined} value={workspacePath} onChange={(event) => {
          setWorkspacePath(event.target.value);
          onDirtyChange(fieldsAreDirty([event.target.value]));
        }} placeholder="/absolute/path/to/project" />
        {showPathError ? <p id={pathErrorId} className="mt-1.5 text-xs leading-5 text-urgent">Must be an absolute path, e.g. /Users/you/project</p> : null}
      </div>
      <InlineActionErrors errors={errors} onDismiss={onDismissError} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="submit" variant="primary" disabled={busy || !validPath}>Add project</Button>
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
        description="Enter the project folder. Agent identities are created when the project receives work."
      >
        {(requestClose) => <ProjectForm
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
