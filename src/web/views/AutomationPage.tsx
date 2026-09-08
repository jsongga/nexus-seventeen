/** Edits the board's automation configuration as one dormant, versioned draft. */

import { Bot, CircleAlert, LockKeyhole, Pencil, Plus, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { formatShortDateTime } from "../data/date-format";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Button, Card, Modal, Pill, inputClass } from "../components/ui";
import {
  acceptRemoteAutomationConfiguration,
  automationEditorFromConfiguration,
  automationEditorIsDirty,
  ClientOperationGate,
  discardAutomationDraft,
  reconcileAutomationConfiguration,
  type AutomationEditorState,
} from "../model/automation-model";
import { BoardApiError, type TaskBoardClient } from "../data/client";
import {
  AUTOMATION_STAGE_ORDER,
  type AutomationAgentType,
  type AutomationConfiguration,
  type WorkItemStage,
} from "../types";
import { AgentTypeForm } from "./automation/AgentTypeForm";
import { authorityForRole, evaluatorLabels, roleLabels, stageDescriptions, stageLabels } from "./automation/vocabulary";
import {
  automationExecutorFromValue,
  eligibleAgentTypes,
  executorValue,
  machineVerifyExecutorValue,
} from "./automation/executors";

export function AutomationPage({
  client,
  connected,
  editorState,
  onEditorStateChange,
}: {
  client: TaskBoardClient;
  connected: boolean;
  editorState: AutomationEditorState;
  onEditorStateChange: Dispatch<SetStateAction<AutomationEditorState>>;
}) {
  const { saved, draft, remote } = editorState;
  const [editingAgentTypeId, setEditingAgentTypeId] = useState<string | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const automationRequest = useRef<{
    client: TaskBoardClient;
    promise: Promise<AutomationConfiguration>;
  } | null>(null);
  const saveOperations = useRef(new ClientOperationGate(client));

  useLayoutEffect(() => {
    saveOperations.current.activate(client);
    loadSequence.current += 1;
    setEditingAgentTypeId(null);
    setLoading(true);
    setSaving(false);
    setError(null);
    setSaveConflict(false);
    setNotice(null);
    return () => {
      saveOperations.current.deactivate();
      loadSequence.current += 1;
    };
  }, [client]);

  const load = useCallback(
    (fresh = false) => {
      const sequence = loadSequence.current + 1;
      loadSequence.current = sequence;
      if (!connected) {
        setLoading(false);
        setSaveConflict(false);
        setError("The task board is disconnected. Reconnect before loading automation configuration.");
        return Promise.resolve();
      }
      setLoading(true);
      setError(null);
      setSaveConflict(false);
      setNotice(null);
      if (fresh || automationRequest.current?.client !== client) {
        automationRequest.current = { client, promise: client.getAutomationConfiguration() };
      }
      const request = automationRequest.current.promise;
      return request
        .then((configuration) => {
          if (sequence !== loadSequence.current) return;
          onEditorStateChange((current) => reconcileAutomationConfiguration(current, configuration));
        })
        .catch((caught: unknown) => {
          if (sequence !== loadSequence.current) return;
          setError(caught instanceof Error ? caught.message : "Automation configuration could not be loaded.");
        })
        .finally(() => {
          if (automationRequest.current?.promise === request) automationRequest.current = null;
          if (sequence === loadSequence.current) setLoading(false);
        });
    },
    [client, connected, onEditorStateChange]
  );

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  const dirty = automationEditorIsDirty(editorState);
  const editingAgentType =
    editingAgentTypeId && editingAgentTypeId !== "new"
      ? (draft?.agentTypes.find((agentType) => agentType.id === editingAgentTypeId) ?? null)
      : null;
  const editingAgentTypePersisted =
    editingAgentType !== null && (saved?.agentTypes.some((agentType) => agentType.id === editingAgentType.id) ?? false);
  const usedByStages = useMemo(() => {
    if (!editingAgentType || !draft) return [];
    return draft.stages
      .filter((entry) => entry.executor.kind === "agent_type" && entry.executor.agentTypeId === editingAgentType.id)
      .map((entry) => entry.stage);
  }, [draft, editingAgentType]);

  function updateStage(stage: WorkItemStage, agentTypeId: string) {
    onEditorStateChange((current) =>
      current.draft === null
        ? current
        : {
            ...current,
            draft: {
              ...current.draft,
              stages: current.draft.stages.map((entry) =>
                entry.stage === stage ? { stage, executor: automationExecutorFromValue(agentTypeId) } : entry
              ),
            },
          }
    );
    setError(null);
    setSaveConflict(false);
    setNotice(null);
  }

  function keepAgentType(agentType: AutomationAgentType) {
    onEditorStateChange((current) => {
      if (current.draft === null) return current;
      const agentTypes =
        editingAgentTypeId === "new"
          ? [...current.draft.agentTypes, agentType]
          : current.draft.agentTypes.map((item) => (item.id === editingAgentTypeId ? agentType : item));
      return { ...current, draft: { ...current.draft, agentTypes } };
    });
    setEditingAgentTypeId(null);
    setError(null);
    setSaveConflict(false);
    setNotice(null);
  }

  function deleteAgentType() {
    if (!editingAgentType || usedByStages.length > 0) return;
    onEditorStateChange((current) =>
      current.draft === null
        ? current
        : {
            ...current,
            draft: {
              ...current.draft,
              agentTypes: current.draft.agentTypes.filter((agentType) => agentType.id !== editingAgentType.id),
            },
          }
    );
    setEditingAgentTypeId(null);
    setError(null);
    setSaveConflict(false);
    setNotice(null);
  }

  async function saveConfiguration() {
    if (!draft || !connected || saving || !dirty) return;
    // Fence any GET that began against the version this save supersedes.
    loadSequence.current += 1;
    setLoading(false);
    const operation = saveOperations.current.begin();
    setSaving(true);
    setError(null);
    setSaveConflict(false);
    setNotice(null);
    try {
      const configuration = await client.saveAutomationConfiguration({
        version: draft.version,
        agentTypes: draft.agentTypes,
        stages: draft.stages,
      });
      if (!saveOperations.current.isCurrent(operation)) return;
      onEditorStateChange(automationEditorFromConfiguration(configuration));
      setNotice("Configuration saved. Runtime behavior remains unchanged until automation adopts it.");
    } catch (caught) {
      if (!saveOperations.current.isCurrent(operation)) return;
      const message = caught instanceof Error ? caught.message : "Automation configuration could not be saved.";
      const conflict = caught instanceof BoardApiError && caught.status === 409;
      setSaveConflict(conflict);
      setError(
        conflict
          ? `Someone else saved a newer configuration. Your draft is still here. ${message}`
          : `Your draft is still here. ${message}`
      );
    } finally {
      if (saveOperations.current.isCurrent(operation)) setSaving(false);
    }
  }

  function discardChanges() {
    if (!saved) return;
    onEditorStateChange((current) => discardAutomationDraft(current));
    setEditingAgentTypeId(null);
    setError(null);
    setSaveConflict(false);
    setNotice(remote ? "Draft discarded and the latest saved configuration loaded." : "Draft changes discarded.");
  }

  function reloadRemoteConfiguration() {
    onEditorStateChange((current) => acceptRemoteAutomationConfiguration(current));
    setEditingAgentTypeId(null);
    setError(null);
    setSaveConflict(false);
    setNotice("Latest saved configuration loaded. The previous local draft was discarded.");
  }

  return (
    <>
      <header className="border-b border-line bg-canvas px-4 py-5 sm:px-8 lg:px-12 lg:py-8">
        <div className="flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-light tracking-[0.02em] sm:text-[28px]">Automation</h1>
            <p className="mt-1.5 max-w-2xl text-sm font-light leading-6 text-muted">
              Define reusable specialist profiles and the desired handoff path for durable requests.
            </p>
          </div>
          {saved ? (
            <div className="text-left text-xs leading-5 text-muted sm:text-right">
              {saved.updatedBy === "system:steward-default" ? (
                <p>Starter configuration · version {saved.version}</p>
              ) : (
                <>
                  <p>Version {saved.version}</p>
                  <p>
                    Updated {formatShortDateTime(saved.updatedAt)} by {saved.updatedBy}
                  </p>
                </>
              )}
            </div>
          ) : null}
        </div>
      </header>

      <main className="w-full max-w-[1400px] p-4 sm:px-8 sm:py-6 lg:px-12 lg:py-8">
        <div className="max-w-6xl space-y-6">
          <Card className="border-caution-border bg-caution-soft p-4 sm:p-5" as="section">
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 shrink-0 text-caution" size={18} />
              <div>
                <h2 className="text-sm font-semibold text-ink">Saved configuration is dormant</h2>
                <p className="mt-1 text-sm leading-6 text-caution">
                  Saving does not wake agents, change running work, or control the current hard-coded runtime. It
                  records the intended configuration for later runtime integration.
                </p>
              </div>
            </div>
          </Card>

          {remote && saved ? (
            <div
              role="alert"
              className="rounded-xl border border-caution-border bg-caution-soft px-4 py-4 text-sm leading-6 text-ink"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">Saved configuration changed</p>
                  <p className="mt-1 text-caution">
                    Version {remote.version} is now saved remotely. Your draft based on version {saved.version} is
                    preserved; reload only when you are ready to discard it.
                  </p>
                </div>
                <Button className="shrink-0" size="sm" onClick={reloadRemoteConfiguration}>
                  Reload latest and discard draft
                </Button>
              </div>
            </div>
          ) : null}
          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-urgent/25 bg-urgent-soft px-4 py-3 text-sm leading-6 text-urgent"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{error}</span>
                {saveConflict ? (
                  <Button className="shrink-0" size="sm" onClick={() => void load(true)}>
                    Check latest configuration
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              className="rounded-xl border border-success-fill/50 bg-success-soft px-4 py-3 text-sm leading-6 text-success"
            >
              {notice}
            </div>
          ) : null}

          {loading && draft === null ? (
            <Card className="flex min-h-44 items-center justify-center p-6">
              <div className="text-center text-sm text-muted">
                <RefreshCw className="mx-auto mb-3 animate-spin" size={20} />
                Loading automation configuration…
              </div>
            </Card>
          ) : null}

          {!loading && draft === null ? (
            <Card className="p-6 text-center">
              <CircleAlert className="mx-auto text-caution" size={22} />
              <h2 className="mt-3 font-display text-xl font-light">Configuration unavailable</h2>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">
                No local fallback is used for automation settings.
              </p>
              <Button
                className="mt-4"
                icon={<RefreshCw size={15} />}
                disabled={!connected}
                onClick={() => void load(true)}
              >
                Try again
              </Button>
            </Card>
          ) : null}

          {draft ? (
            <>
              <Card as="section" className="overflow-hidden">
                <div className="flex flex-col gap-4 border-b border-line px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
                  <div>
                    <h2 id="agent-types-heading" className="font-display text-xl font-light tracking-[0.01em]">
                      Agent types
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                      Profiles describe desired specialization. Authority comes only from the fixed role; this page
                      never stores tools, credentials, models, or workspace paths.
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Plus size={15} />}
                    disabled={draft.agentTypes.length >= 32}
                    onClick={() => setEditingAgentTypeId("new")}
                  >
                    Add agent type
                  </Button>
                </div>

                {draft.agentTypes.length > 0 ? (
                  <div className="divide-y divide-line">
                    {draft.agentTypes.map((agentType) => {
                      const authority = authorityForRole(agentType.role);
                      const assignments = draft.stages.filter(
                        (entry) => entry.executor.kind === "agent_type" && entry.executor.agentTypeId === agentType.id
                      );
                      return (
                        <article key={agentType.id} className="px-4 py-5 sm:px-6">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-medium text-ink">{agentType.name}</h3>
                                <Pill tone={agentType.enabled ? "green" : "neutral"} dot={agentType.enabled}>
                                  {agentType.enabled ? "Enabled" : "Disabled"}
                                </Pill>
                                <Pill
                                  tone={
                                    agentType.role === "engineer"
                                      ? "blue"
                                      : agentType.role === "verifier"
                                        ? "purple"
                                        : "neutral"
                                  }
                                >
                                  {roleLabels[agentType.role]}
                                </Pill>
                              </div>
                              <p className="mt-1 break-all font-mono text-[11px] text-muted">{agentType.id}</p>
                              <p className="mt-3 max-w-3xl text-sm leading-6 text-ink">{agentType.description}</p>
                              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs leading-5 text-muted">
                                <span>
                                  <strong className="font-medium text-ink">Authority:</strong> {authority.label}
                                </span>
                                <span>
                                  <strong className="font-medium text-ink">Evaluation:</strong>{" "}
                                  {evaluatorLabels[agentType.evaluatorProfile]}
                                </span>
                                <span>
                                  <strong className="font-medium text-ink">Stages:</strong>{" "}
                                  {assignments.length || "None"}
                                </span>
                                <span>
                                  <strong className="font-medium text-ink">Skills:</strong>{" "}
                                  {agentType.skillIds.length || "None"}
                                </span>
                              </div>
                              <p className="mt-1 text-xs leading-5 text-muted">{authority.detail}</p>
                            </div>
                            <Button
                              size="sm"
                              icon={<Pencil size={14} />}
                              onClick={() => setEditingAgentTypeId(agentType.id)}
                            >
                              Edit
                            </Button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-6 py-10 text-center">
                    <Bot className="mx-auto text-muted" size={22} />
                    <p className="mt-3 text-sm text-muted">No reusable agent types yet.</p>
                  </div>
                )}
              </Card>

              <Card as="section" className="overflow-hidden">
                <div className="border-b border-line px-4 py-5 sm:px-6">
                  <h2 id="pipeline-heading" className="font-display text-xl font-light tracking-[0.01em]">
                    Pipeline
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
                    Stages stay in canonical order. An adopted runtime may hand work backward for another pass, but
                    these rows define the desired owner for each stage.
                  </p>
                </div>
                <ol className="divide-y divide-line">
                  {AUTOMATION_STAGE_ORDER.map((stage, index) => {
                    const entry = draft.stages.find((candidate) => candidate.stage === stage);
                    if (!entry) return null;
                    const locked = stage === "human_review" || stage === "deployment";
                    const eligible = eligibleAgentTypes(stage, draft.agentTypes);
                    return (
                      <li
                        key={stage}
                        className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(220px,.8fr)] sm:items-center sm:px-6"
                      >
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-[99px] bg-muted-surface text-xs font-medium text-muted">
                            {index + 1}
                          </span>
                          <div>
                            <h3 className="text-sm font-medium text-ink">{stageLabels[stage]}</h3>
                            <p className="mt-1 text-xs leading-5 text-muted">{stageDescriptions[stage]}</p>
                          </div>
                        </div>
                        {locked ? (
                          <div
                            className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-muted-surface px-3.5"
                            aria-label={`${stageLabels[stage]} executor`}
                          >
                            <span className="flex items-center gap-2 text-sm text-ink">
                              {stage === "human_review" ? <ShieldCheck size={16} /> : <LockKeyhole size={16} />}
                              {stage === "human_review" ? "Human owner" : "Disabled"}
                            </span>
                            <Pill>Locked</Pill>
                          </div>
                        ) : (
                          <div>
                            <label
                              htmlFor={`automation-stage-${stage}`}
                              className="mb-1.5 block text-xs font-medium text-ink"
                            >
                              Executor
                            </label>
                            <select
                              id={`automation-stage-${stage}`}
                              aria-label={`${stageLabels[stage]} executor`}
                              className={inputClass}
                              value={executorValue(entry.executor)}
                              onChange={(event) => updateStage(stage, event.target.value)}
                            >
                              <option value="">Disabled</option>
                              {stage === "testing" ? (
                                <option value={machineVerifyExecutorValue}>Machine verify</option>
                              ) : null}
                              {eligible.map((agentType) => (
                                <option key={agentType.id} value={agentType.id}>
                                  {agentType.name} · {roleLabels[agentType.role]}
                                </option>
                              ))}
                            </select>
                            {eligible.length === 0 ? (
                              <p className="mt-1.5 text-xs leading-5 text-muted">
                                Add an eligible enabled type to assign this stage.
                              </p>
                            ) : null}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </Card>

              <div className="sticky bottom-0 z-20 -mx-4 flex flex-col gap-3 border-t border-line bg-canvas/95 px-4 py-4 backdrop-blur sm:-mx-8 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:-mx-12 lg:px-12">
                <p className="text-xs leading-5 text-muted">
                  {remote
                    ? `Draft preserved from version ${saved?.version}; reload version ${remote.version} before saving.`
                    : dirty
                      ? "Unsaved draft changes are visible only in this browser."
                      : "Configuration matches the saved version."}
                </p>
                <div className="flex gap-2">
                  <Button disabled={!dirty || saving} onClick={discardChanges}>
                    Discard changes
                  </Button>
                  <Button
                    variant="primary"
                    icon={<Save size={15} />}
                    disabled={!dirty || saving || !connected || remote !== null}
                    onClick={() => void saveConfiguration()}
                  >
                    {saving ? "Saving…" : "Save configuration"}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </main>

      <Modal
        open={editingAgentTypeId !== null}
        onClose={() => setEditingAgentTypeId(null)}
        title={editingAgentTypeId === "new" ? "Add agent type" : "Edit agent type"}
        description="Describe specialization while keeping runtime authority explicit and role-bound."
        className="sm:max-w-2xl"
      >
        {editingAgentTypeId ? (
          <AgentTypeForm
            key={editingAgentTypeId}
            initial={editingAgentTypeId === "new" ? null : editingAgentType}
            persisted={editingAgentTypePersisted}
            existingIds={draft?.agentTypes.map((agentType) => agentType.id) ?? []}
            usedByStages={usedByStages}
            onCancel={() => setEditingAgentTypeId(null)}
            onSave={keepAgentType}
            onDelete={editingAgentTypeId !== "new" && !editingAgentTypePersisted ? deleteAgentType : undefined}
          />
        ) : null}
      </Modal>
    </>
  );
}
