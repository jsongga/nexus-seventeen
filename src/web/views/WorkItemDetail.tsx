/** Renders work-item status, context, evidence, and human approval actions. */

import { Archive, Check, CirclePause, HelpCircle, RefreshCw, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PipelineSummary } from "@shared/task-board-contract";
import { fieldsAreDirty } from "../components/dialog-stack";
import { Button, Card, FieldLabel, InlineActionErrors, Modal, Pill, cn, inputClass } from "../components/ui";
import { BoardApiError, type TaskBoardClient } from "../data/client";
import type { RawWorkItemAudit } from "../data/parse";
import {
  deriveWorkItemDetailAffordances,
  contractApprovalIsReady,
  contractDependencyStatuses,
  deriveDecompositionAffordances,
  nodesForPlan,
  proposedPlanForWorkItem,
} from "../model/work-item-detail";
import { prettyStatus, unknownStateLabel, workItemStateTone, workItemStatusLabel } from "../model/work-item-labels";
import { actionErrorContexts, useActionErrors, type ActionResult } from "../model/action-errors";
import type {
  BoardChildWorkItem,
  BoardProject,
  BoardQuestion,
  BoardRepository,
  BoardTask,
  BoardWorkItem,
  BoardWorkItemDependency,
  ProjectWorkflow,
} from "../types";
import { FinalApprovalActions, FinalRejectionForm, WorkItemFooterActions } from "./work-item/approval";
import { AttestDeploymentForm, ContractAttestationGate } from "./work-item/deployment";
import { GapReportSection, PipelineSummaryDetails } from "./work-item/evidence";
import {
  ChildrenSection,
  type InitialWorkItemFamily,
  ParentWorkItemLink,
  familyNotParentAfterSnapshot,
  initialFamilyState,
} from "./work-item/family";
import { AuditSection, StatusTimeline } from "./work-item/observability";
import {
  PlanApprovalActions,
  PlanRecordDetails,
  PlanRejectionForm,
  WorkflowNodeCard,
  repositoryTargetLabel,
} from "./work-item/plan";

interface WorkItemDetailProps {
  workItem: BoardWorkItem;
  snapshotRevision: number;
  familyVersionKey?: string;
  familyRefreshRevision?: number;
  knownParent?: boolean;
  initialFamily?: InitialWorkItemFamily;
  projectName: string | null;
  projects: readonly BoardProject[];
  repositories: readonly BoardRepository[];
  parentWorkItem: BoardWorkItem | null;
  planningTask: BoardTask | null;
  openQuestion: BoardQuestion | null;
  client: TaskBoardClient;
  busy: boolean;
  onClose: () => void;
  onOpenWorkItem?: (workItemId: string) => void;
  onAnswer: (questionId: string, answer: string) => Promise<ActionResult>;
  onConfirm: (planRevisionId: string) => Promise<ActionResult>;
  onReject?: (planRevisionId: string, note: string) => Promise<ActionResult>;
  onApproveMerge?: () => Promise<ActionResult>;
  onRejectFinal?: (note: string) => Promise<ActionResult>;
  onAttestDeploy: (workItemId: string, note?: string) => Promise<ActionResult>;
  onResumeCoordination: () => Promise<ActionResult>;
  onCancel: (reason: string) => Promise<ActionResult>;
  onArchive: () => Promise<ActionResult>;
}

export function WorkItemDetail({
  workItem,
  snapshotRevision,
  familyVersionKey = `${workItem.id}:${workItem.version}`,
  familyRefreshRevision = 0,
  knownParent = false,
  initialFamily,
  projectName,
  projects,
  repositories,
  parentWorkItem,
  planningTask,
  openQuestion,
  client,
  busy,
  onClose,
  onOpenWorkItem,
  onAnswer,
  onConfirm,
  onReject,
  onApproveMerge,
  onRejectFinal,
  onAttestDeploy,
  onResumeCoordination,
  onCancel,
  onArchive,
}: WorkItemDetailProps) {
  const seededFamily = initialFamilyState(workItem, knownParent, initialFamily);
  const [answer, setAnswer] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [rejectionNote, setRejectionNote] = useState("");
  const [finalChangeNote, setFinalChangeNote] = useState("");
  const [attestationNote, setAttestationNote] = useState("");
  const [attestationWorkItemId, setAttestationWorkItemId] = useState(workItem.id);
  const [rejecting, setRejecting] = useState(false);
  const [finalActionBusy, setFinalActionBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "cancel" | "reject" | "merge" | "requestChanges" | "archive" | "attest" | "resume" | null
  >(null);
  const actionErrors = useActionErrors();
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [workflowState, setWorkflowState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowAttempt, setWorkflowAttempt] = useState(0);
  const [pipelineSummary, setPipelineSummary] = useState<PipelineSummary | null>(null);
  const [pipelineSummaryState, setPipelineSummaryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pipelineSummaryError, setPipelineSummaryError] = useState<string | null>(null);
  const [pipelineSummaryAttempt, setPipelineSummaryAttempt] = useState(0);
  const [audit, setAudit] = useState<RawWorkItemAudit | null>(null);
  const [auditState, setAuditState] = useState<"loading" | "ready" | "error">("loading");
  const [gapReportContent, setGapReportContent] = useState<string | null>(null);
  const [gapReportState, setGapReportState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [gapReportError, setGapReportError] = useState<string | null>(null);
  const [gapReportAttempt, setGapReportAttempt] = useState(0);
  const [familyChildren, setFamilyChildren] = useState<BoardChildWorkItem[]>(() => seededFamily.children);
  const [familyDependencies, setFamilyDependencies] = useState<BoardWorkItemDependency[]>(
    () => seededFamily.dependencies
  );
  const [familyState, setFamilyState] = useState<"loading" | "ready" | "error">(() => seededFamily.state);
  const [familyError, setFamilyError] = useState<string | null>(() => seededFamily.error);
  const [familyAttempt, setFamilyAttempt] = useState(0);
  const familyHasLastGoodRef = useRef(seededFamily.children.length > 0);
  const familyNotParentRef = useRef(seededFamily.parentAbsent);
  const pipelineSummaryWorkItemIdRef = useRef(workItem.id);
  const auditWorkItemIdRef = useRef(workItem.id);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const mergeConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const archiveConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const attestationConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const resumeConfirmationAnchorRef = useRef<HTMLButtonElement>(null);
  const detailHeadingId = `work-item-detail-heading-${workItem.id}`;
  const actionContexts = {
    rejectPlan: actionErrorContexts.workItemRejectPlan(workItem.id),
    approveMerge: `work-item:${encodeURIComponent(workItem.id)}:approve-merge`,
    rejectFinal: `work-item:${encodeURIComponent(workItem.id)}:reject-final`,
    attestDeploy: `work-item:${encodeURIComponent(attestationWorkItemId)}:attest-deploy`,
    resumeCoordination: `work-item:${encodeURIComponent(workItem.id)}:resume-coordination`,
    cancel: actionErrorContexts.workItemCancel(workItem.id),
    archive: actionErrorContexts.workItemArchive(workItem.id),
  } as const;

  const affordances = deriveWorkItemDetailAffordances({
    workItemState: workItem.state,
    planningTaskState: planningTask?.status ?? null,
    archived: workItem.archivedAt !== null,
  });
  const familyParentCandidate =
    workItem.parentWorkItemId === null &&
    ["coordinating", "final_approval", "parked", "merged", "abandoned", "dead_letter"].includes(workItem.state);
  const familyRelevant = workItem.parentWorkItemId !== null || familyParentCandidate;
  const hasChildren = workItem.parentWorkItemId === null && familyChildren.length > 0;
  const phasedFamily = familyChildren.some((child) => child.phase !== null);
  const childFailed = familyChildren.some((child) => child.state === "abandoned" || child.state === "dead_letter");
  const isDecomposedParent = hasChildren;
  const loadedChild = familyChildren.find((child) => child.id === workItem.id);
  const deployAttested = loadedChild?.deployAttested ?? false;
  const decompositionAffordances = deriveDecompositionAffordances({
    workItemState: workItem.state,
    parentWorkItemId: workItem.parentWorkItemId,
    phase: workItem.phase,
    hasChildren,
    phasedFamily,
    childFailed,
    deployAttested,
    parkCategory: workItem.parkCategory,
  });
  const resumeAfterBaseChange = decompositionAffordances.resumeAfterBaseChange;
  const phasedChildFailure =
    workItem.parentWorkItemId === null && workItem.state === "parked" && phasedFamily && childFailed;
  const dependencyStatuses =
    workItem.phase === "contract" ? contractDependencyStatuses(workItem.id, familyChildren, familyDependencies) : [];
  const contractApprovalEnabled = contractApprovalIsReady(workItem.phase, familyState, dependencyStatuses);
  const archiveRequiresAttestation =
    workItem.parentWorkItemId !== null &&
    (workItem.phase === "expand" || workItem.phase === "migrate") &&
    workItem.state === "merged" &&
    !deployAttested;
  const archiveHintId = `work-item-archive-hint-${workItem.id}`;
  const pipelineSummaryVisible =
    ["reviewing", "fixing", "final_approval"].includes(workItem.state) && !isDecomposedParent;
  const pipelineSummaryBelongsToWorkItem = pipelineSummaryWorkItemIdRef.current === workItem.id;
  const renderedPipelineSummary = pipelineSummaryBelongsToWorkItem ? pipelineSummary : null;
  const renderedPipelineSummaryState = pipelineSummaryBelongsToWorkItem ? pipelineSummaryState : "loading";
  const renderedPipelineSummaryError = pipelineSummaryBelongsToWorkItem ? pipelineSummaryError : null;
  const auditBelongsToWorkItem = auditWorkItemIdRef.current === workItem.id;
  const renderedAudit = auditBelongsToWorkItem ? audit : null;
  const renderedAuditState = auditBelongsToWorkItem ? auditState : "loading";

  useEffect(() => {
    setAnswer("");
    setCancelReason("");
    setRejectionNote("");
    setFinalChangeNote("");
    setAttestationNote("");
    setAttestationWorkItemId(workItem.id);
    setRejecting(false);
    setFinalActionBusy(false);
    setConfirmation(null);
  }, [workItem.id]);

  useEffect(() => {
    familyNotParentRef.current = familyNotParentAfterSnapshot(familyNotParentRef.current, knownParent);
  }, [knownParent, workItem.id]);

  useEffect(() => {
    if (!familyRelevant) {
      familyHasLastGoodRef.current = false;
      familyNotParentRef.current = false;
      setFamilyChildren([]);
      setFamilyDependencies([]);
      setFamilyError(null);
      setFamilyState("ready");
      return;
    }
    const controller = new AbortController();
    const parentId = workItem.parentWorkItemId ?? workItem.id;
    const hasLastGood = familyHasLastGoodRef.current;
    if (!hasLastGood) {
      setFamilyState("loading");
      setFamilyError(null);
    }
    const dependencies =
      workItem.phase === "contract"
        ? client.getWorkItemDependencies(workItem.id, controller.signal)
        : Promise.resolve([]);
    void Promise.all([client.getWorkItemChildren(parentId, controller.signal), dependencies])
      .then(([children, nextDependencies]) => {
        if (controller.signal.aborted) return;
        setFamilyChildren(children);
        setFamilyDependencies(nextDependencies);
        setFamilyError(null);
        setFamilyState("ready");
        familyHasLastGoodRef.current = children.length > 0;
        familyNotParentRef.current = workItem.parentWorkItemId === null && children.length === 0;
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        const parentNotFound =
          workItem.parentWorkItemId === null && caught instanceof BoardApiError && caught.status === 404;
        if (parentNotFound) {
          familyHasLastGoodRef.current = false;
          familyNotParentRef.current = true;
          setFamilyChildren([]);
          setFamilyDependencies([]);
          setFamilyError(null);
          setFamilyState("ready");
          return;
        }
        const knownFamily =
          workItem.parentWorkItemId !== null || hasLastGood || (knownParent && !familyNotParentRef.current);
        if (!knownFamily) {
          setFamilyChildren([]);
          setFamilyDependencies([]);
          setFamilyError(null);
          setFamilyState("ready");
          return;
        }
        setFamilyError(caught instanceof Error ? caught.message : "The decomposition family could not be loaded.");
        if (!hasLastGood) {
          setFamilyChildren([]);
          setFamilyDependencies([]);
          setFamilyState("error");
        }
      });
    return () => controller.abort();
  }, [
    client,
    familyAttempt,
    familyRefreshRevision,
    familyRelevant,
    familyVersionKey,
    knownParent,
    workItem.id,
    workItem.parentWorkItemId,
    workItem.phase,
  ]);

  useEffect(() => {
    pipelineSummaryWorkItemIdRef.current = workItem.id;
    setPipelineSummary(null);
    setPipelineSummaryError(null);
    setPipelineSummaryState("idle");
  }, [workItem.id]);

  useEffect(() => {
    auditWorkItemIdRef.current = workItem.id;
    setAudit(null);
    setAuditState("loading");
  }, [workItem.id]);

  useEffect(() => {
    if (workItem.taskType !== "onboarding") {
      setGapReportContent(null);
      setGapReportError(null);
      setGapReportState("idle");
      return;
    }
    const controller = new AbortController();
    setGapReportContent(null);
    setGapReportError(null);
    setGapReportState("loading");
    void client
      .getWorkItem(workItem.id, controller.signal)
      .then(async (detail) => {
        if (controller.signal.aborted) return;
        if (detail.gapReportArtifactId === null) {
          setGapReportState("ready");
          return;
        }
        const blob = await client.getArtifactBlob(detail.gapReportArtifactId, controller.signal);
        const content = await blob.text();
        if (controller.signal.aborted) return;
        setGapReportContent(content);
        setGapReportState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setGapReportError(caught instanceof Error ? caught.message : "The gap report could not be loaded.");
        setGapReportState("error");
      });
    return () => controller.abort();
  }, [client, gapReportAttempt, workItem.id, workItem.taskType, workItem.version]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(max-width: 1279px)").matches) detailHeadingRef.current?.focus();
  }, [workItem.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAuditState(renderedAudit === null ? "loading" : "ready");
    void client
      .getWorkItemAudit(workItem.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setAudit(next);
        setAuditState("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAuditState("error");
      });
    return () => controller.abort();
  }, [client, snapshotRevision, workItem.id, workItem.version]);

  useEffect(() => {
    if (workItem.state !== "plan_approval" || workItem.resolvedProjectId === null) {
      setWorkflow(null);
      setWorkflowError(null);
      setWorkflowState("idle");
      return;
    }
    const controller = new AbortController();
    setWorkflow(null);
    setWorkflowError(null);
    setWorkflowState("loading");
    void client
      .getProjectWorkflow(workItem.resolvedProjectId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setWorkflow(next);
        setWorkflowState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setWorkflowError(caught instanceof Error ? caught.message : "The proposed plan could not be loaded");
        setWorkflowState("error");
      });
    return () => controller.abort();
  }, [client, workItem.id, workItem.resolvedProjectId, workItem.state, workflowAttempt]);

  useEffect(() => {
    if (!pipelineSummaryVisible) {
      return;
    }
    const controller = new AbortController();
    setPipelineSummaryError(null);
    setPipelineSummaryState(renderedPipelineSummary === null ? "loading" : "ready");
    void client
      .getPipelineSummary(workItem.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setPipelineSummary(next);
        setPipelineSummaryState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setPipelineSummaryError(caught instanceof Error ? caught.message : "The pipeline summary could not be loaded");
        setPipelineSummaryState("error");
      });
    return () => controller.abort();
  }, [client, pipelineSummaryAttempt, pipelineSummaryVisible, workItem.id, workItem.state, workItem.version]);

  const proposedPlan = useMemo(
    () => (workflow === null ? null : proposedPlanForWorkItem(workflow, workItem.id)),
    [workflow, workItem.id]
  );
  const planNodes = useMemo(
    () => (proposedPlan === null || workflow === null ? [] : nodesForPlan(workflow, proposedPlan.planRevisionId)),
    [proposedPlan, workflow]
  );
  const answerContext = openQuestion === null ? null : actionErrorContexts.workItemAnswer(workItem.id, openQuestion.id);
  const confirmPlanContext =
    proposedPlan === null ? null : actionErrorContexts.workItemConfirmPlan(workItem.id, proposedPlan.planRevisionId);

  async function save(context: string, operation: () => Promise<ActionResult>, onSaved?: () => void) {
    actionErrors.start(context);
    const result = await operation();
    if (result.ok) onSaved?.();
    else actionErrors.fail(context, result.error);
  }

  async function submitCancellation() {
    const reason = cancelReason.trim();
    if (reason.length === 0 || confirmation !== "cancel") return;
    await save(
      actionContexts.cancel,
      () => onCancel(reason),
      () => {
        setCancelReason("");
        closeConfirmation();
      }
    );
  }

  async function submitRejection() {
    const note = rejectionNote.trim();
    if (note.length === 0 || confirmation !== "reject" || proposedPlan === null || onReject === undefined) return;
    await save(
      actionContexts.rejectPlan,
      async () => {
        setRejecting(true);
        try {
          return await onReject(proposedPlan.planRevisionId, note);
        } finally {
          setRejecting(false);
        }
      },
      () => {
        setRejectionNote("");
        closeConfirmation();
      }
    );
  }

  async function submitFinalRejection() {
    const note = finalChangeNote.trim();
    if (note.length === 0 || confirmation !== "requestChanges" || onRejectFinal === undefined) return;
    await save(
      actionContexts.rejectFinal,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onRejectFinal(note);
        } finally {
          setFinalActionBusy(false);
        }
      },
      () => {
        setFinalChangeNote("");
        closeConfirmation();
      }
    );
  }

  async function submitMergeApproval() {
    if (confirmation !== "merge" || onApproveMerge === undefined) return;
    await save(
      actionContexts.approveMerge,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onApproveMerge();
        } finally {
          setFinalActionBusy(false);
        }
      },
      closeConfirmation
    );
  }

  async function submitDeploymentAttestation() {
    if (confirmation !== "attest") return;
    const note = attestationNote.trim();
    await save(
      actionContexts.attestDeploy,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onAttestDeploy(attestationWorkItemId, note.length === 0 ? undefined : note);
        } finally {
          setFinalActionBusy(false);
        }
      },
      () => {
        setAttestationNote("");
        setFamilyAttempt((value) => value + 1);
        closeConfirmation();
      }
    );
  }

  async function submitResumeCoordination() {
    if (confirmation !== "resume") return;
    await save(
      actionContexts.resumeCoordination,
      async () => {
        setFinalActionBusy(true);
        try {
          return await onResumeCoordination();
        } finally {
          setFinalActionBusy(false);
        }
      },
      closeConfirmation
    );
  }

  function confirmationContext(next: typeof confirmation): string | null {
    if (next === "reject") return actionContexts.rejectPlan;
    if (next === "merge") return actionContexts.approveMerge;
    if (next === "requestChanges") return actionContexts.rejectFinal;
    if (next === "cancel") return actionContexts.cancel;
    if (next === "archive") return actionContexts.archive;
    if (next === "attest") return actionContexts.attestDeploy;
    if (next === "resume") return actionContexts.resumeCoordination;
    return null;
  }

  function openConfirmation(next: Exclude<typeof confirmation, null>) {
    actionErrors.dismiss(confirmationContext(next)!);
    if (next === "cancel") setCancelReason("");
    if (next === "reject") setRejectionNote("");
    if (next === "requestChanges") setFinalChangeNote("");
    if (next === "attest") setAttestationNote("");
    setConfirmation(next);
  }

  function openDeploymentAttestation(targetWorkItemId: string, anchor?: HTMLButtonElement) {
    const context = `work-item:${encodeURIComponent(targetWorkItemId)}:attest-deploy`;
    actionErrors.dismiss(context);
    if (anchor !== undefined) attestationConfirmationAnchorRef.current = anchor;
    setAttestationWorkItemId(targetWorkItemId);
    setAttestationNote("");
    setConfirmation("attest");
  }

  function closeConfirmation() {
    const context = confirmationContext(confirmation);
    if (context !== null) actionErrors.dismiss(context);
    setConfirmation(null);
  }

  const takeoverOpen = confirmation === "cancel" || confirmation === "reject" || confirmation === "requestChanges";

  return (
    <>
      <div
        className="min-w-0 max-w-full"
        role="region"
        aria-labelledby={detailHeadingId}
        aria-hidden={takeoverOpen ? true : undefined}
      >
        <Card className="min-w-0 max-w-full overflow-hidden" as="article">
          <header className="border-b border-line px-4 py-5 sm:px-5">
            <div className="flex items-start justify-between gap-4">
              <div role="group" aria-label="Current status">
                <p className="mb-1.5 text-xs font-medium text-muted">Current status</p>
                <Pill tone={workItemStateTone[workItem.state]} dot>
                  {workItemStatusLabel(workItem)}
                </Pill>
              </div>
              <button
                type="button"
                className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-muted-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                onClick={onClose}
                aria-label="Close request details"
              >
                <X size={18} />
              </button>
            </div>
            <h2
              ref={detailHeadingRef}
              id={detailHeadingId}
              tabIndex={-1}
              className="mt-4 break-words font-display text-xl font-light tracking-[0.01em] text-ink"
            >
              Request details
            </h2>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted">Request type</dt>
                <dd className="mt-1 break-words text-ink">{workItem.taskType}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Resolved project</dt>
                <dd className="mt-1 break-words text-ink">
                  {projectName ??
                    (workItem.resolvedProjectId === null ? "Not resolved yet" : workItem.resolvedProjectId)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Repository</dt>
                <dd className="mt-1 break-words text-ink">
                  {repositoryTargetLabel(repositories, workItem.resolvedProjectId, workItem.repositoryId)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Planning task</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-ink">
                  <span className="break-words">{planningTask?.title ?? "Not linked yet"}</span>
                  {planningTask ? (
                    <Pill>
                      {planningTask.status === "unrecognized" ? unknownStateLabel : prettyStatus(planningTask.status)}
                    </Pill>
                  ) : null}
                </dd>
              </div>
              {workItem.parentWorkItemId === null ? null : (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-muted">Parent request</dt>
                  <dd className="mt-1">
                    <ParentWorkItemLink
                      parentWorkItemId={workItem.parentWorkItemId}
                      parentWorkItem={parentWorkItem}
                      onOpenWorkItem={onOpenWorkItem}
                    />
                  </dd>
                </div>
              )}
            </dl>
          </header>

          <StatusTimeline
            workItem={workItem}
            transitions={renderedAudit?.transitions ?? []}
            state={renderedAuditState}
          />

          <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="original-request-heading">
            <h3 id="original-request-heading" className="text-xs font-semibold text-ink">
              Original request
            </h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">
              {workItem.originalRequest}
            </p>
          </section>

          {familyParentCandidate && (isDecomposedParent || familyState === "error") ? (
            <ChildrenSection
              children={familyChildren}
              projects={projects}
              state={familyState}
              error={familyError}
              onRetry={() => setFamilyAttempt((value) => value + 1)}
              onOpenChild={onOpenWorkItem}
              onAttestChild={openDeploymentAttestation}
              attestationBusy={busy || finalActionBusy}
            />
          ) : null}

          {workItem.parentWorkItemId !== null &&
          (workItem.phase === "expand" || workItem.phase === "migrate") &&
          workItem.state === "merged" ? (
            <section
              className="min-w-0 border-b border-line px-4 py-4 sm:px-5"
              aria-labelledby="deployment-attestation-heading"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 id="deployment-attestation-heading" className="text-xs font-semibold text-ink">
                    Deployment
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    The merge is complete. Human attestation records that this phase is deployed.
                  </p>
                </div>
                {familyState === "ready" && deployAttested ? <Pill tone="green">Deployment attested</Pill> : null}
              </div>
              {familyState === "ready" && familyError !== null ? (
                <div
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-urgent"
                  role="alert"
                >
                  <span>{familyError} The last loaded deployment status remains visible.</span>
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setFamilyAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {familyState === "error" ? (
                <div
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-urgent"
                  role="alert"
                >
                  <span>{familyError ?? "Deployment attestation status could not be loaded."}</span>
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setFamilyAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                </div>
              ) : familyState === "loading" ? (
                <p className="mt-3 text-xs text-muted" role="status">
                  Loading deployment attestation…
                </p>
              ) : decompositionAffordances.attestDeployment ? (
                <Button
                  ref={attestationConfirmationAnchorRef}
                  className="mt-3 scroll-mt-14 lg:scroll-mt-0"
                  variant="mint"
                  disabled={busy || finalActionBusy}
                  onClick={() => openDeploymentAttestation(workItem.id)}
                >
                  Attest deployed
                </Button>
              ) : null}
            </section>
          ) : null}

          {workItem.taskType === "onboarding" ? (
            <GapReportSection
              state={gapReportState === "idle" ? "loading" : gapReportState}
              content={gapReportContent}
              error={gapReportError}
              onRetry={() => setGapReportAttempt((value) => value + 1)}
            />
          ) : null}

          {workItem.cancelledReason !== null ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="cancellation-reason-heading">
              <h3 id="cancellation-reason-heading" className="text-xs font-semibold text-ink">
                Abandonment reason
              </h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                {workItem.cancelledReason}
              </p>
            </section>
          ) : null}

          {workItem.state === "parked" && !isDecomposedParent && openQuestion !== null ? (
            <form
              className="border-b border-caution-fill/30 bg-caution-soft/55 px-4 py-4 sm:px-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (answer.trim().length === 0) return;
                void save(
                  actionErrorContexts.workItemAnswer(workItem.id, openQuestion.id),
                  () => onAnswer(openQuestion.id, answer.trim()),
                  () => setAnswer("")
                );
              }}
            >
              <div className="flex items-center gap-2 text-caution">
                <HelpCircle size={17} />
                <h3 className="text-xs font-semibold">Planning needs your input</h3>
              </div>
              {affordances.answerQuestion ? (
                <>
                  <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-ink">
                    {openQuestion.prompt}
                  </p>
                  <div className="mt-3">
                    <FieldLabel htmlFor={`work-item-answer-${workItem.id}`}>Your answer</FieldLabel>
                    <textarea
                      id={`work-item-answer-${workItem.id}`}
                      className={cn(inputClass, "min-h-24 resize-y py-3")}
                      placeholder="Give the missing context…"
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                    />
                  </div>
                  <Button
                    className="mt-3 w-full"
                    type="submit"
                    variant="primary"
                    icon={<Send size={16} />}
                    disabled={busy || answer.trim().length === 0}
                  >
                    Answer and resume planning
                  </Button>
                </>
              ) : (
                <div className="mt-3 rounded-md border border-line bg-card px-3.5 py-3 text-sm text-muted">
                  The linked planning task has not published an open question. Refresh to check for its latest state.
                </div>
              )}
            </form>
          ) : workItem.state === "parked" && !isDecomposedParent ? (
            <section className="border-b border-line px-4 py-4 sm:px-5">
              <div
                className="rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted"
                role="status"
              >
                Parked — no open question. Retry or reassign from the task view.
              </div>
            </section>
          ) : null}

          {decompositionAffordances.approveAndMergeChildren &&
          onApproveMerge !== undefined &&
          onRejectFinal !== undefined ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="parent-final-approval-heading">
              <h3 id="parent-final-approval-heading" className="text-xs font-semibold text-ink">
                Final approval
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted">
                Every remaining child is verified and ready. One approval merges them in dependency order.
              </p>
              <FinalApprovalActions
                busy={busy || finalActionBusy}
                approveAnchorRef={mergeConfirmationAnchorRef}
                mode="parent"
                onApprove={() => openConfirmation("merge")}
                onRequestChanges={() => openConfirmation("requestChanges")}
              />
            </section>
          ) : null}

          {workItem.state === "plan_approval" ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="proposed-plan-heading">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="proposed-plan-heading" className="text-xs font-semibold text-ink">
                    Proposed plan
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Review the stages and dependencies before workflow execution begins.
                  </p>
                </div>
                {workflowState === "error" ? (
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setWorkflowAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
              {workflowState === "loading" ? (
                <div
                  className="mt-4 flex min-h-28 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
                  role="status"
                >
                  <RefreshCw size={16} className="animate-spin" /> Loading proposed plan…
                </div>
              ) : workflowState === "error" ? (
                <div
                  className="mt-4 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
                  role="alert"
                >
                  {workflowError ?? "The proposed plan could not be loaded."}
                </div>
              ) : workflowState === "ready" && proposedPlan === null ? (
                <div className="mt-4 flex min-h-28 flex-col items-center justify-center rounded-md border border-line bg-muted-surface px-5 text-center">
                  <CirclePause size={18} className="text-muted" />
                  <p className="mt-2 text-sm font-medium text-ink">No proposed plan</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    The workflow snapshot has no proposed revision for this request.
                  </p>
                </div>
              ) : proposedPlan ? (
                <div className="mt-4">
                  <PlanRecordDetails plan={proposedPlan} repositories={repositories} />
                  {planNodes.length > 0 ? (
                    <ol className="mt-3 space-y-3">
                      {planNodes.map((node) => (
                        <WorkflowNodeCard key={node.nodeId} node={node} allNodes={planNodes} />
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-3 rounded-md border border-line bg-muted-surface p-3.5 text-sm text-muted">
                      This proposed plan contains no work nodes.
                    </p>
                  )}
                  <PlanApprovalActions
                    plan={proposedPlan}
                    busy={busy || rejecting}
                    confirmEnabled={affordances.confirmPlan}
                    rejectEnabled={affordances.rejectPlan && onReject !== undefined}
                    onConfirm={() => {
                      void save(actionErrorContexts.workItemConfirmPlan(workItem.id, proposedPlan.planRevisionId), () =>
                        onConfirm(proposedPlan.planRevisionId)
                      );
                    }}
                    onReject={() => openConfirmation("reject")}
                  />
                </div>
              ) : workflowState === "idle" ? (
                <div className="mt-4 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
                  The resolved project is unavailable, so the plan cannot be loaded.
                </div>
              ) : null}
            </section>
          ) : null}

          {pipelineSummaryVisible ? (
            <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="pipeline-summary-heading">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="pipeline-summary-heading" className="text-xs font-semibold text-ink">
                    {workItem.state === "final_approval" ? "Final approval" : "Pipeline review"}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {workItem.state === "final_approval"
                      ? "Review the committed changes, declared scope, assumptions, and verify evidence before merging locally."
                      : "Track review findings, design decisions, committed changes, and verification evidence while the pipeline is active."}
                  </p>
                </div>
                {renderedPipelineSummaryState === "error" ? (
                  <Button
                    size="sm"
                    icon={<RefreshCw size={14} />}
                    onClick={() => setPipelineSummaryAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
              {renderedPipelineSummaryState === "loading" ? (
                <div
                  className="mt-4 flex min-h-28 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
                  role="status"
                >
                  <RefreshCw size={16} className="animate-spin" /> Loading pipeline summary…
                </div>
              ) : renderedPipelineSummaryState === "error" ? (
                <div
                  className="mt-4 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
                  role="alert"
                >
                  {renderedPipelineSummaryError ?? "The pipeline summary could not be loaded."}
                </div>
              ) : renderedPipelineSummaryState === "ready" && renderedPipelineSummary !== null ? (
                <>
                  <PipelineSummaryDetails summary={renderedPipelineSummary} />
                  {(workItem.phase === "contract" || workItem.phase === "unrecognized") &&
                  workItem.state === "final_approval" ? (
                    <ContractAttestationGate
                      statuses={dependencyStatuses}
                      phase={workItem.phase}
                      state={familyState}
                      error={familyError}
                      onRetry={() => setFamilyAttempt((value) => value + 1)}
                    />
                  ) : null}
                  {workItem.state === "final_approval" &&
                  onApproveMerge !== undefined &&
                  onRejectFinal !== undefined ? (
                    <FinalApprovalActions
                      busy={busy || finalActionBusy}
                      approveAnchorRef={mergeConfirmationAnchorRef}
                      approveDisabled={
                        (workItem.phase === "contract" || workItem.phase === "unrecognized") && !contractApprovalEnabled
                      }
                      onApprove={() => openConfirmation("merge")}
                      onRequestChanges={() => openConfirmation("requestChanges")}
                    />
                  ) : null}
                </>
              ) : (
                <div className="mt-4 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
                  {workItem.state === "final_approval"
                    ? "The pipeline summary is unavailable. Refresh before making a final decision."
                    : "The pipeline summary is unavailable. Refresh to check the latest review evidence."}
                </div>
              )}
            </section>
          ) : null}

          {renderedAuditState === "ready" && renderedAudit !== null ? <AuditSection audit={renderedAudit} /> : null}

          <InlineActionErrors
            className={
              actionErrors.errors.some(
                (entry) => entry.context === answerContext || entry.context === confirmPlanContext
              )
                ? "border-b border-line px-4 py-3 sm:px-5"
                : undefined
            }
            errors={actionErrors.errors.filter(
              (entry) => entry.context === answerContext || entry.context === confirmPlanContext
            )}
            onDismiss={actionErrors.dismiss}
          />

          {affordances.cancel || affordances.archive ? (
            <WorkItemFooterActions
              busy={busy}
              finalActionBusy={finalActionBusy}
              showResume={decompositionAffordances.resumeCoordination || resumeAfterBaseChange}
              resumeLabel={resumeAfterBaseChange ? "Resume after base change" : "Resume coordination"}
              showCancel={affordances.cancel}
              showArchive={affordances.archive}
              archiveDisabled={archiveRequiresAttestation}
              archiveHintId={archiveHintId}
              cancelHint={phasedChildFailure ? "A phase stopped — abandon the coordination request" : null}
              resumeAnchorRef={resumeConfirmationAnchorRef}
              archiveAnchorRef={archiveConfirmationAnchorRef}
              onResume={() => openConfirmation("resume")}
              onCancel={() => openConfirmation("cancel")}
              onArchive={() => openConfirmation("archive")}
            />
          ) : null}
        </Card>
      </div>

      <Modal
        open={confirmation === "cancel"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([cancelReason])}
        title="Abandon request"
        description="This abandons the request and stops its live planning task. This action cannot be undone."
      >
        {(requestClose) => (
          <form
            className="space-y-4 p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCancellation();
            }}
          >
            <div>
              <FieldLabel htmlFor={`work-item-cancel-reason-${workItem.id}`}>Reason</FieldLabel>
              <textarea
                id={`work-item-cancel-reason-${workItem.id}`}
                className={cn(inputClass, "min-h-24 resize-y py-3")}
                autoFocus
                required
                maxLength={16_000}
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder="Why is this request being abandoned?"
              />
            </div>
            <InlineActionErrors
              errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.cancel)}
              onDismiss={actionErrors.dismiss}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="submit" variant="danger" disabled={busy || cancelReason.trim().length === 0}>
                Abandon request
              </Button>
              <Button disabled={busy} onClick={requestClose}>
                Keep request
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={confirmation === "reject"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([rejectionNote])}
        title="Reject proposed plan"
        description="Send one bounded revision note back to planning. Rejecting a second proposed revision parks the request."
      >
        {(requestClose) => (
          <PlanRejectionForm
            workItemId={workItem.id}
            note={rejectionNote}
            busy={busy || rejecting}
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.rejectPlan)}
            onNoteChange={setRejectionNote}
            onDismissError={actionErrors.dismiss}
            onSubmit={() => {
              void submitRejection();
            }}
            onKeep={requestClose}
          />
        )}
      </Modal>

      <Modal
        open={confirmation === "merge"}
        onClose={closeConfirmation}
        variant="anchored"
        anchorRef={mergeConfirmationAnchorRef}
        title={isDecomposedParent ? "Approve and merge children" : "Approve and merge pipeline"}
        description={
          isDecomposedParent
            ? "This merges every unmerged child in dependency order, then completes the parent. A conflict returns that child to implementation."
            : "This creates a local no-fast-forward merge commit on the clean checked-out merge target. It does not push anything. A conflict returns the request to implementation with conflict details."
        }
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button
            variant="mint"
            icon={<Check size={15} />}
            disabled={busy || finalActionBusy}
            onClick={() => {
              void submitMergeApproval();
            }}
          >
            {isDecomposedParent ? "Approve and merge" : "Approve & merge"}
          </Button>
          <Button disabled={busy || finalActionBusy} onClick={closeConfirmation}>
            {isDecomposedParent ? "Keep in final approval" : "Keep in final review"}
          </Button>
          <InlineActionErrors
            className="sm:col-span-2"
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.approveMerge)}
            onDismiss={actionErrors.dismiss}
          />
        </div>
      </Modal>

      <Modal
        open={confirmation === "requestChanges"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([finalChangeNote])}
        title={isDecomposedParent ? "Send back to coordination" : "Request implementation changes"}
        description={
          isDecomposedParent
            ? "Every unmerged child in final approval returns to implementation with this note. The parent returns to coordination."
            : "The request returns to implementation with this note attached to the next engineering round."
        }
      >
        {(requestClose) => (
          <FinalRejectionForm
            workItemId={workItem.id}
            note={finalChangeNote}
            busy={busy || finalActionBusy}
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.rejectFinal)}
            onNoteChange={setFinalChangeNote}
            onDismissError={actionErrors.dismiss}
            onSubmit={() => {
              void submitFinalRejection();
            }}
            onKeep={requestClose}
            parent={isDecomposedParent}
          />
        )}
      </Modal>

      <Modal
        open={confirmation === "attest"}
        onClose={closeConfirmation}
        isDirty={() => fieldsAreDirty([attestationNote])}
        variant="anchored"
        anchorRef={attestationConfirmationAnchorRef}
        title="Attest deployment"
        description="Record that this merged phase is deployed. The optional note is stored with the human gate action."
      >
        {(requestClose) => (
          <AttestDeploymentForm
            workItemId={attestationWorkItemId}
            note={attestationNote}
            busy={busy || finalActionBusy}
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.attestDeploy)}
            onNoteChange={setAttestationNote}
            onDismissError={actionErrors.dismiss}
            onSubmit={() => {
              void submitDeploymentAttestation();
            }}
            onCancel={requestClose}
          />
        )}
      </Modal>

      <Modal
        open={confirmation === "resume"}
        onClose={closeConfirmation}
        variant="anchored"
        anchorRef={resumeConfirmationAnchorRef}
        title={
          resumeAfterBaseChange
            ? workItem.parentWorkItemId === null
              ? "Resume request"
              : "Resume child"
            : "Resume coordination"
        }
        description={
          resumeAfterBaseChange
            ? "Refresh the pipeline base to the current repository head, resolve the base-diverged park, and return to implementation."
            : "Return this parked decomposed parent to coordination and continue the remaining child work."
        }
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button
            variant="primary"
            disabled={busy || finalActionBusy}
            onClick={() => {
              void submitResumeCoordination();
            }}
          >
            Resume
          </Button>
          <Button disabled={busy || finalActionBusy} onClick={closeConfirmation}>
            Cancel
          </Button>
          <InlineActionErrors
            className="sm:col-span-2"
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.resumeCoordination)}
            onDismiss={actionErrors.dismiss}
          />
        </div>
      </Modal>

      <Modal
        open={confirmation === "archive"}
        onClose={closeConfirmation}
        variant="anchored"
        anchorRef={archiveConfirmationAnchorRef}
        title="Archive request"
        description="Archived requests leave the default request list but remain stored and retrievable."
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button
            variant="primary"
            icon={<Archive size={15} />}
            disabled={busy}
            onClick={() => void save(actionContexts.archive, onArchive, closeConfirmation)}
          >
            Archive request
          </Button>
          <Button disabled={busy} onClick={closeConfirmation}>
            Keep visible
          </Button>
          <InlineActionErrors
            className="sm:col-span-2"
            errors={actionErrors.errors.filter((entry) => entry.context === actionContexts.archive)}
            onDismiss={actionErrors.dismiss}
          />
        </div>
      </Modal>
    </>
  );
}
