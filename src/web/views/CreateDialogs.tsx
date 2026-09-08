/** Hosts the create-project and create-work-item dialogs and switches between them. */

import { type RefObject } from "react";
import { Modal } from "../components/ui";
import { type TaskBoardClient } from "../data/client";
import type { ActionError, ActionResult } from "../model/action-errors";
import type { BoardSnapshot, CreateProjectInput, CreateWorkItemInput } from "../types";
import { ProjectForm } from "./create/ProjectForm";
import { WorkItemForm } from "./create/WorkItemForm";

export type DialogName = "project" | "task" | null;
export const CREATE_DIALOG_SWITCH_TARGET = "create-dialog";

export function CreateDialogs({
  client,
  dialog,
  closeDialog,
  keepEditingDialog,
  projectRequestCloseRef,
  taskRequestCloseRef,
  projectFormDirty,
  workItemFormDirty,
  taskAnchorRef,
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
  keepEditingDialog: () => void;
  projectRequestCloseRef: RefObject<(() => void) | null>;
  taskRequestCloseRef: RefObject<(() => void) | null>;
  projectFormDirty: RefObject<boolean>;
  workItemFormDirty: RefObject<boolean>;
  taskAnchorRef: RefObject<HTMLElement | null>;
  dialogProject: BoardSnapshot["projects"][number] | undefined;
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
        open={dialog === "project"}
        onClose={closeDialog}
        onKeepEditing={keepEditingDialog}
        dialogSwitchTarget={CREATE_DIALOG_SWITCH_TARGET}
        requestCloseRef={projectRequestCloseRef}
        isDirty={() => projectFormDirty.current}
        title="Add project from disk"
        description="Pick a project folder, browse for one, or paste a path."
      >
        {(requestClose) => (
          <ProjectForm
            client={client}
            projects={snapshot?.projects ?? []}
            busy={busy || !connected}
            errors={projectCreateErrors}
            onDismissError={dismissActionError}
            onSubmit={createProject}
            onCancel={requestClose}
            onDirtyChange={(dirty) => {
              projectFormDirty.current = dirty;
            }}
          />
        )}
      </Modal>
      <Modal
        open={dialog === "task"}
        onClose={closeDialog}
        onKeepEditing={keepEditingDialog}
        dialogSwitchTarget={CREATE_DIALOG_SWITCH_TARGET}
        requestCloseRef={taskRequestCloseRef}
        isDirty={() => workItemFormDirty.current}
        variant="anchored"
        anchorRef={taskAnchorRef}
        dialogTrigger="task"
        title={dialogProject ? `Add a request to ${dialogProject.name}` : "Add a request"}
        description="Records a durable request. This step does not wake an agent yet."
      >
        {(requestClose) => (
          <WorkItemForm
            key={dialogProject?.id ?? "unselected"}
            projects={snapshot?.projects ?? []}
            defaultProjectId={dialogProject?.id ?? null}
            busy={busy || !connected}
            errors={workItemCreateErrors}
            onDismissError={dismissActionError}
            onSubmit={createWorkItem}
            onCancel={requestClose}
            onDirtyChange={(dirty) => {
              workItemFormDirty.current = dirty;
            }}
          />
        )}
      </Modal>
    </>
  );
}
