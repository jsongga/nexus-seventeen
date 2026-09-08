/** Renders and edits the repositories owned by one project. */

/* —— Imports —— */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, FieldLabel, InlineActionErrors, Pill, cn, inputClass } from "../../components/ui";
import type { TaskBoardClient } from "../../data/client";
import { actionErrorMessage, useActionErrors, type ActionResult } from "../../model/action-errors";
import type { BoardRepository } from "../../types";

/* —— Repository list state —— */

const desktopRepositoriesQuery = "(min-width: 48rem)";

function repositoriesStartOpen(): boolean {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia(desktopRepositoriesQuery).matches
  );
}

export function isAbsoluteRepositoryPath(value: string): boolean {
  return value.trim().startsWith("/");
}

function actionContext(action: "add" | "rename" | "repoint", repositoryId: string): string {
  return `project-repository:${encodeURIComponent(repositoryId)}:${action}`;
}

interface RepositoryFormProps {
  disabled: boolean;
  onSaved: (repository: BoardRepository) => void;
}

function PathHelp({ id }: { id: string }) {
  return (
    <p id={id} className="mt-1.5 text-xs leading-5 text-muted">
      Repository paths must be absolute and begin with /.
    </p>
  );
}

function AddRepositoryForm({
  projectId,
  client,
  disabled,
  onMutate,
  onSaved,
}: RepositoryFormProps & {
  projectId: string;
  client: TaskBoardClient;
  onMutate: (operation: () => Promise<unknown>) => Promise<ActionResult>;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const helpId = `repository-add-path-help-${projectId}`;
  const pathIsInvalid = path.length > 0 && !isAbsoluteRepositoryPath(path);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim().length === 0 || !isAbsoluteRepositoryPath(path)) return;
    const form = event.currentTarget;
    let saved: BoardRepository | null = null;
    const result = await onMutate(async () => {
      saved = await client.addRepository(projectId, { name: name.trim(), path: path.trim() });
    });
    if (!result.ok || saved === null) return;
    onSaved(saved);
    setName("");
    setPath("");
    form.closest("details")?.removeAttribute("open");
  }

  return (
    <form className="mt-3 space-y-3 border-t border-line pt-3" onSubmit={(event) => void submit(event)}>
      <div>
        <FieldLabel htmlFor={`repository-add-name-${projectId}`}>Repository name</FieldLabel>
        <input
          id={`repository-add-name-${projectId}`}
          className={inputClass}
          required
          maxLength={256}
          disabled={disabled}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Consumer app"
        />
      </div>
      <div>
        <FieldLabel htmlFor={`repository-add-path-${projectId}`}>Absolute path</FieldLabel>
        <input
          id={`repository-add-path-${projectId}`}
          className={cn(inputClass, "font-mono text-xs")}
          required
          maxLength={4_000}
          disabled={disabled}
          aria-invalid={pathIsInvalid || undefined}
          aria-describedby={helpId}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/absolute/path/to/repository"
        />
        <PathHelp id={helpId} />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="primary"
        disabled={disabled || name.trim().length === 0 || !isAbsoluteRepositoryPath(path)}
      >
        Add repository
      </Button>
    </form>
  );
}

function RenameRepositoryForm({
  repository,
  client,
  disabled,
  onMutate,
  onSaved,
}: RepositoryFormProps & {
  repository: BoardRepository;
  client: TaskBoardClient;
  onMutate: (operation: () => Promise<unknown>) => Promise<ActionResult>;
}) {
  const [name, setName] = useState(repository.name);

  useEffect(() => setName(repository.name), [repository.name]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (nextName.length === 0) return;
    const form = event.currentTarget;
    let saved: BoardRepository | null = null;
    const result = await onMutate(async () => {
      saved = await client.updateRepository(repository.id, { version: repository.version, name: nextName });
    });
    if (!result.ok || saved === null) return;
    onSaved(saved);
    form.closest("details")?.removeAttribute("open");
  }

  return (
    <form className="mt-3 space-y-3 border-t border-line pt-3" onSubmit={(event) => void submit(event)}>
      <div>
        <FieldLabel htmlFor={`repository-rename-${repository.id}`}>Repository name</FieldLabel>
        <input
          id={`repository-rename-${repository.id}`}
          className={inputClass}
          required
          maxLength={256}
          disabled={disabled}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="primary"
        disabled={disabled || name.trim().length === 0 || name.trim() === repository.name}
      >
        Save name
      </Button>
    </form>
  );
}

function RepointRepositoryForm({
  repository,
  client,
  disabled,
  onMutate,
  onSaved,
}: RepositoryFormProps & {
  repository: BoardRepository;
  client: TaskBoardClient;
  onMutate: (operation: () => Promise<unknown>) => Promise<ActionResult>;
}) {
  const [path, setPath] = useState(repository.path);
  const helpId = `repository-repoint-help-${repository.id}`;
  const pathIsInvalid = path.length > 0 && !isAbsoluteRepositoryPath(path);

  useEffect(() => setPath(repository.path), [repository.path]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isAbsoluteRepositoryPath(path)) return;
    const form = event.currentTarget;
    let saved: BoardRepository | null = null;
    const result = await onMutate(async () => {
      saved = await client.updateRepository(repository.id, { version: repository.version, path: path.trim() });
    });
    if (!result.ok || saved === null) return;
    onSaved(saved);
    form.closest("details")?.removeAttribute("open");
  }

  return (
    <form className="mt-3 space-y-3 border-t border-line pt-3" onSubmit={(event) => void submit(event)}>
      <div>
        <FieldLabel htmlFor={`repository-repoint-${repository.id}`}>Absolute path</FieldLabel>
        <input
          id={`repository-repoint-${repository.id}`}
          className={cn(inputClass, "font-mono text-xs")}
          required
          maxLength={4_000}
          disabled={disabled}
          aria-invalid={pathIsInvalid || undefined}
          aria-describedby={helpId}
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <PathHelp id={helpId} />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="primary"
        disabled={disabled || !isAbsoluteRepositoryPath(path) || path.trim() === repository.path}
      >
        Save path
      </Button>
    </form>
  );
}

function ActionDetails({ label, disabled, children }: { label: string; disabled: boolean; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-line bg-surface px-3 py-2">
      <summary
        className="cursor-pointer select-none text-xs font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        {label}
      </summary>
      {children}
    </details>
  );
}

/* —— Project repository surface —— */

export function ProjectRepositories({
  projectId,
  repositories,
  client,
  connected,
  busy,
  onMutation,
}: {
  projectId: string;
  repositories: readonly BoardRepository[];
  client: TaskBoardClient;
  connected: boolean;
  busy: boolean;
  onMutation: (operation: () => Promise<unknown>) => Promise<ActionResult>;
}) {
  const [repositoriesOpen, setRepositoriesOpen] = useState(repositoriesStartOpen);
  const [busyContext, setBusyContext] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const errors = useActionErrors();
  const disabled = busy || busyContext !== null || !connected;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia(desktopRepositoriesQuery);
    const applyBreakpointDefault = () => setRepositoriesOpen(desktop.matches);
    desktop.addEventListener("change", applyBreakpointDefault);
    return () => desktop.removeEventListener("change", applyBreakpointDefault);
  }, []);

  function saved(repository: BoardRepository) {
    setStatus(`${repository.name} saved.`);
  }

  async function mutate(context: string, operation: () => Promise<unknown>): Promise<ActionResult> {
    errors.start(context);
    setStatus(null);
    setBusyContext(context);
    try {
      const result = await onMutation(operation);
      if (!result.ok) errors.fail(context, result.error);
      return result;
    } catch (caught) {
      const error = actionErrorMessage(caught);
      errors.fail(context, error);
      return { ok: false, error };
    } finally {
      setBusyContext(null);
    }
  }

  return (
    <details
      open={repositoriesOpen}
      onToggle={(event) => setRepositoriesOpen(event.currentTarget.open)}
      className="max-h-[32dvh] shrink-0 overflow-y-auto rounded-sm border border-line bg-card px-4 py-4 sm:px-5 md:max-h-[45dvh]"
      aria-labelledby="repositories-heading"
    >
      <summary className="cursor-pointer rounded-sm text-xs font-semibold text-ink marker:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover">
        <h2 id="repositories-heading" className="inline text-xs font-semibold text-ink">
          Repositories
        </h2>
      </summary>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="mt-1 text-xs leading-5 text-muted">
          Work without a pinned target inherits the primary repository.
        </p>
        <ActionDetails label="Add repository" disabled={disabled}>
          <AddRepositoryForm
            projectId={projectId}
            client={client}
            disabled={disabled}
            onMutate={(operation) => mutate(actionContext("add", projectId), operation)}
            onSaved={saved}
          />
        </ActionDetails>
      </div>

      {repositories.length === 0 ? (
        <p className="mt-4 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-xs text-muted">
          No repositories are available for this project.
        </p>
      ) : (
        <ul className="mt-4 grid gap-3 xl:grid-cols-2">
          {repositories.map((repository) => (
            <li key={repository.id} className="min-w-0 rounded-md border border-line bg-muted-surface px-3.5 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words text-sm font-semibold text-ink">{repository.name}</p>
                {repository.isPrimary ? <Pill tone="green">Primary</Pill> : null}
              </div>
              <p className="mt-1 break-all font-mono text-[11px] leading-5 text-muted">{repository.path}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <ActionDetails label="Rename" disabled={disabled}>
                  <RenameRepositoryForm
                    repository={repository}
                    client={client}
                    disabled={disabled}
                    onMutate={(operation) => mutate(actionContext("rename", repository.id), operation)}
                    onSaved={saved}
                  />
                </ActionDetails>
                <ActionDetails label="Re-point" disabled={disabled}>
                  <RepointRepositoryForm
                    repository={repository}
                    client={client}
                    disabled={disabled}
                    onMutate={(operation) => mutate(actionContext("repoint", repository.id), operation)}
                    onSaved={saved}
                  />
                </ActionDetails>
              </div>
            </li>
          ))}
        </ul>
      )}

      <InlineActionErrors errors={errors.errors} onDismiss={errors.dismiss} className="mt-3" />
      {busyContext ? (
        <p className="mt-3 text-xs text-muted" role="status" aria-live="polite">
          Saving repository…
        </p>
      ) : status ? (
        <p className="mt-3 text-xs text-success" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
      {!connected ? <p className="mt-3 text-xs text-muted">Reconnect the task board to edit repositories.</p> : null}
    </details>
  );
}
