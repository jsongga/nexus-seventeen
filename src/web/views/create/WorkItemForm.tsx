/** Collects a new work item's request, project and workspace scope. */

/* —— Imports —— */

import { useState } from "react";
import { fieldsAreDirty } from "../../components/dialog-stack";
import { Button, FieldLabel, InlineActionErrors, cn, inputClass } from "../../components/ui";
import { randomUuid } from "../../data/client";
import type { ActionError, ActionResult } from "../../model/action-errors";
import type { BoardSnapshot, CreateWorkItemInput } from "../../types";

/* —— Work item form —— */

export function WorkItemForm({
  projects,
  defaultProjectId,
  busy,
  errors,
  onDismissError,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  projects: BoardSnapshot["projects"];
  defaultProjectId: string | null;
  busy: boolean;
  errors: readonly ActionError[];
  onDismissError: (context: string) => void;
  onSubmit: (input: CreateWorkItemInput) => Promise<ActionResult>;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [priority, setPriority] = useState<CreateWorkItemInput["priority"]>("normal");
  const [taskType, setTaskType] = useState<CreateWorkItemInput["taskType"]>("standard");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [idempotencyKey, setIdempotencyKey] = useState(randomUuid);
  const normalizedPrompt = prompt.trim();
  const projectChosen = projects.some((project) => project.id === projectId);
  const regenerateIdempotencyKey = () => setIdempotencyKey(randomUuid());
  const initialProjectId = defaultProjectId ?? "";
  const reportDirty = (next: {
    prompt?: string;
    priority?: CreateWorkItemInput["priority"];
    taskType?: CreateWorkItemInput["taskType"];
    projectId?: string;
  }) => {
    onDirtyChange(
      fieldsAreDirty([next.prompt ?? prompt]) ||
        (next.priority ?? priority) !== "normal" ||
        (next.taskType ?? taskType) !== "standard" ||
        (next.projectId ?? projectId) !== initialProjectId
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
          taskType,
          projectId,
          idempotencyKey,
        });
      }}
    >
      <div>
        <FieldLabel htmlFor="task-prompt">Task</FieldLabel>
        <textarea
          id="task-prompt"
          className={cn(inputClass, "min-h-32 resize-y py-3")}
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
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <FieldLabel htmlFor="work-item-task-type">Task type</FieldLabel>
          <select
            id="work-item-task-type"
            className={inputClass}
            value={taskType}
            onChange={(event) => {
              const nextTaskType = event.target.value as CreateWorkItemInput["taskType"];
              setTaskType(nextTaskType);
              reportDirty({ taskType: nextTaskType });
              regenerateIdempotencyKey();
            }}
          >
            <option value="standard">Standard</option>
            <option value="onboarding">Onboarding</option>
          </select>
        </div>
        <div>
          <FieldLabel htmlFor="work-item-priority">Priority</FieldLabel>
          <select
            id="work-item-priority"
            className={inputClass}
            value={priority}
            onChange={(event) => {
              const nextPriority = event.target.value as CreateWorkItemInput["priority"];
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
            aria-describedby={projects.length === 0 ? "work-item-project-help" : undefined}
            value={projectChosen ? projectId : ""}
            onChange={(event) => {
              setProjectId(event.target.value);
              reportDirty({ projectId: event.target.value });
              regenerateIdempotencyKey();
            }}
          >
            <option value="" disabled>
              Choose a project
            </option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
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
          {projectChosen ? "Submit task" : "Choose a project"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
