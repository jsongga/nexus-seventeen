import {
  Bot,
  CircleAlert,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { Button, Card, FieldLabel, Modal, Pill, cn, inputClass } from '../../components/ui';
import {
  acceptRemoteAutomationConfiguration,
  automationEditorFromConfiguration,
  automationEditorIsDirty,
  ClientOperationGate,
  discardAutomationDraft,
  reconcileAutomationConfiguration,
  type AutomationEditorState,
} from '../model/automation-model';
import { BoardApiError, type TaskBoardClient } from '../data/client';
import {
  AUTOMATION_STAGE_ALLOWED_ROLES,
  AUTOMATION_STAGE_ORDER,
  type AgentRole,
  type AutomationAgentType,
  type AutomationConfiguration,
  type AutomationEvaluatorProfile,
  type AutomationStageExecutor,
  type WorkItemStage,
} from '../types';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const skillIdentifierPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

const stageLabels: Record<WorkItemStage, string> = {
  refinement: 'Refinement',
  project_resolution: 'Project resolution',
  research: 'Research',
  planning: 'Planning',
  implementation: 'Implementation',
  testing: 'Testing',
  verification: 'Verification',
  human_review: 'Human review',
  deployment: 'Deployment',
};

const stageDescriptions: Record<WorkItemStage, string> = {
  refinement: 'Clarifies the original request without replacing it.',
  project_resolution: 'Selects an existing project or identifies that one must be created.',
  research: 'Collects project context and evidence before a plan is written.',
  planning: 'Turns the refined objective and research into an executable plan.',
  implementation: 'Changes the assigned workspace; only an engineer type is eligible.',
  testing: 'Exercises the implementation and records failures or evidence.',
  verification: 'Independently checks the result; only a verifier type is eligible.',
  human_review: 'Waits for a human decision before any release action.',
  deployment: 'Remains disabled until a separate, human-controlled release path exists.',
};

const evaluatorLabels: Record<AutomationEvaluatorProfile, string> = {
  tests: 'Tests',
  editorial: 'Editorial',
  visual: 'Visual',
  manual: 'Manual',
};

const roleLabels: Record<AgentRole, string> = {
  engineer: 'Engineer',
  manager: 'Manager',
  verifier: 'Verifier',
};

function authorityForRole(role: AgentRole): { label: string; detail: string } {
  if (role === 'engineer') {
    return {
      label: 'Workspace-write',
      detail: 'May modify files in the workspace assigned to a task.',
    };
  }
  return {
    label: 'Read-only',
    detail: role === 'manager'
      ? 'May inspect work and coordinate decisions, but cannot modify the workspace.'
      : 'May inspect work and verification evidence, but cannot modify the workspace.',
  };
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function eligibleAgentTypes(stage: WorkItemStage, agentTypes: AutomationAgentType[]): AutomationAgentType[] {
  const allowedRoles = AUTOMATION_STAGE_ALLOWED_ROLES[stage];
  return agentTypes.filter((agentType) => agentType.enabled && allowedRoles.includes(agentType.role));
}

function executorValue(executor: AutomationStageExecutor): string {
  return executor.kind === 'agent_type' ? executor.agentTypeId : '';
}

interface AgentTypeFormProps {
  initial: AutomationAgentType | null;
  persisted: boolean;
  existingIds: string[];
  usedByStages: WorkItemStage[];
  onCancel: () => void;
  onSave: (agentType: AutomationAgentType) => void;
  onDelete?: () => void;
}

function AgentTypeForm({
  initial,
  persisted,
  existingIds,
  usedByStages,
  onCancel,
  onSave,
  onDelete,
}: AgentTypeFormProps) {
  const [id, setId] = useState(initial?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [role, setRole] = useState<AgentRole>(initial?.role ?? 'engineer');
  const [supplementalInstructions, setSupplementalInstructions] = useState(initial?.supplementalInstructions ?? '');
  const [skillIdsText, setSkillIdsText] = useState(initial?.skillIds.join('\n') ?? '');
  const [evaluatorProfile, setEvaluatorProfile] = useState<AutomationEvaluatorProfile>(initial?.evaluatorProfile ?? 'tests');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const authority = authorityForRole(role);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanId = id.trim();
    const cleanName = name.trim();
    const cleanDescription = description.trim();
    const cleanInstructions = supplementalInstructions.trim();
    const skillIds = skillIdsText
      .split(/[\n,]/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (!identifierPattern.test(cleanId)) {
      setError('ID must start with a letter or number and use only letters, numbers, dot, underscore, colon, @, slash, or hyphen.');
      return;
    }
    if (cleanId !== initial?.id && existingIds.includes(cleanId)) {
      setError('An agent type with this ID already exists.');
      return;
    }
    if (!cleanName) {
      setError('Enter a display name.');
      return;
    }
    if (cleanName.length > 160) {
      setError('Display name cannot exceed 160 characters.');
      return;
    }
    if (!cleanDescription) {
      setError('Describe the specialist purpose of this type.');
      return;
    }
    if (cleanDescription.length > 4_000 || cleanInstructions.length > 8_000) {
      setError('Purpose or supplemental instructions are too long.');
      return;
    }
    if (enabled && !cleanInstructions) {
      setError('Enabled specialist templates require supplemental instructions.');
      return;
    }
    if (skillIds.length > 32 || skillIds.some((skillId) => !skillIdentifierPattern.test(skillId))) {
      setError('Use at most 32 lowercase skill IDs with letters, numbers, dot, underscore, colon, or hyphen. URLs and paths are not accepted.');
      return;
    }
    if (new Set(skillIds).size !== skillIds.length) {
      setError('Remove duplicate skill IDs.');
      return;
    }
    if (!enabled && usedByStages.length > 0) {
      setError(`Assign ${usedByStages.map((stage) => stageLabels[stage]).join(', ')} elsewhere before disabling this type.`);
      return;
    }

    onSave({
      id: cleanId,
      name: cleanName,
      description: cleanDescription,
      role,
      supplementalInstructions: cleanInstructions,
      skillIds,
      evaluatorProfile,
      enabled,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5 px-5 py-5 sm:px-6">
      {error ? (
        <div role="alert" className="rounded-xl border border-urgent/25 bg-urgent-soft px-4 py-3 text-sm text-urgent">
          {error}
        </div>
      ) : null}

      <div>
        <FieldLabel htmlFor="automation-agent-type-id">ID</FieldLabel>
        <input
          id="automation-agent-type-id"
          className={cn(inputClass, initial && 'bg-surface text-muted')}
          value={id}
          disabled={initial !== null}
          required
          maxLength={128}
          autoComplete="off"
          placeholder="implementation-engineer"
          onChange={(event) => setId(event.target.value)}
        />
        <p className="mt-1.5 text-xs leading-5 text-muted">
          {initial ? 'IDs are permanent after creation so pipeline references remain stable.' : 'Stable identifier used by pipeline references.'}
        </p>
      </div>

      <div>
        <FieldLabel htmlFor="automation-agent-type-name">Display name</FieldLabel>
        <input
          id="automation-agent-type-name"
          className={inputClass}
          value={name}
          required
          maxLength={160}
          autoComplete="off"
          placeholder="Implementation engineer"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div>
        <FieldLabel htmlFor="automation-agent-type-description">Purpose</FieldLabel>
        <textarea
          id="automation-agent-type-description"
          className={cn(inputClass, 'min-h-24 resize-y py-3')}
          value={description}
          required
          maxLength={4_000}
          placeholder="What this specialist contributes to the workflow"
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="automation-agent-type-role">Authority role</FieldLabel>
          <select
            id="automation-agent-type-role"
            className={cn(inputClass, initial && 'bg-surface text-muted')}
            value={role}
            disabled={initial !== null}
            onChange={(event) => setRole(event.target.value as AgentRole)}
          >
            <option value="engineer">Engineer</option>
            <option value="manager">Manager</option>
            <option value="verifier">Verifier</option>
          </select>
          {initial ? <p className="mt-1.5 text-xs leading-5 text-muted">Authority cannot change after creation.</p> : null}
        </div>
        <div>
          <FieldLabel htmlFor="automation-agent-type-evaluator">Evaluator profile</FieldLabel>
          <select
            id="automation-agent-type-evaluator"
            className={inputClass}
            value={evaluatorProfile}
            onChange={(event) => setEvaluatorProfile(event.target.value as AutomationEvaluatorProfile)}
          >
            <option value="tests">Tests</option>
            <option value="editorial">Editorial</option>
            <option value="visual">Visual</option>
            <option value="manual">Manual</option>
          </select>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-muted-surface px-4 py-3">
        <p className="text-xs font-semibold text-muted">Role-derived authority</p>
        <p className="mt-1 text-sm font-medium text-ink">{authority.label}</p>
        <p className="mt-1 text-xs leading-5 text-muted">{authority.detail}</p>
      </div>

      <div>
        <FieldLabel htmlFor="automation-agent-type-instructions">Supplemental specialist instructions</FieldLabel>
        <textarea
          id="automation-agent-type-instructions"
          className={cn(inputClass, 'min-h-28 resize-y py-3')}
          value={supplementalInstructions}
          maxLength={8_000}
          placeholder="Additional guidance layered onto the authority role"
          onChange={(event) => setSupplementalInstructions(event.target.value)}
        />
      </div>

      <div>
        <FieldLabel htmlFor="automation-agent-type-skills">Skill IDs</FieldLabel>
        <textarea
          id="automation-agent-type-skills"
          aria-describedby="automation-agent-type-skills-help"
          className={cn(inputClass, 'min-h-24 resize-y py-3 font-mono text-xs')}
          value={skillIdsText}
          placeholder={'code-review\nrelease-checklist'}
          onChange={(event) => setSkillIdsText(event.target.value)}
        />
        <p id="automation-agent-type-skills-help" className="mt-1.5 text-xs leading-5 text-muted">
          Desired references only. Saving does not install skills or create a worker.
        </p>
      </div>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line px-4 py-2.5 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4 accent-taupe"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>
          <span className="block font-medium">Enabled for pipeline selection</span>
          <span className="mt-0.5 block text-xs text-muted">Disabled types remain saved but cannot own a stage.</span>
        </span>
      </label>

      {initial && usedByStages.length > 0 ? (
        <p className="rounded-xl border border-line bg-muted-surface px-4 py-3 text-xs leading-5 text-muted">
          Used by {usedByStages.map((stage) => stageLabels[stage]).join(', ')}. Reassign those stages before disabling or deleting this type.
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {onDelete ? (
            <Button
              type="button"
              variant="danger"
              icon={<Trash2 size={15} />}
              disabled={usedByStages.length > 0}
              onClick={onDelete}
            >
              Delete type
            </Button>
          ) : persisted ? <p className="max-w-xs text-xs leading-5 text-muted">Saved IDs are retained; disable this type instead.</p> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary">Keep draft</Button>
        </div>
      </div>
    </form>
  );
}

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
  const [editingAgentTypeId, setEditingAgentTypeId] = useState<string | 'new' | null>(null);
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

  const load = useCallback((fresh = false) => {
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    if (!connected) {
      setLoading(false);
      setSaveConflict(false);
      setError('The task board is disconnected. Reconnect before loading automation configuration.');
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
        setError(caught instanceof Error ? caught.message : 'Automation configuration could not be loaded.');
      })
      .finally(() => {
        if (automationRequest.current?.promise === request) automationRequest.current = null;
        if (sequence === loadSequence.current) setLoading(false);
      });
  }, [client, connected, onEditorStateChange]);

  useEffect(() => {
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  const dirty = automationEditorIsDirty(editorState);
  const editingAgentType = editingAgentTypeId && editingAgentTypeId !== 'new'
    ? draft?.agentTypes.find((agentType) => agentType.id === editingAgentTypeId) ?? null
    : null;
  const editingAgentTypePersisted = editingAgentType !== null
    && (saved?.agentTypes.some((agentType) => agentType.id === editingAgentType.id) ?? false);
  const usedByStages = useMemo(() => {
    if (!editingAgentType || !draft) return [];
    return draft.stages
      .filter((entry) => entry.executor.kind === 'agent_type' && entry.executor.agentTypeId === editingAgentType.id)
      .map((entry) => entry.stage);
  }, [draft, editingAgentType]);

  function updateStage(stage: WorkItemStage, agentTypeId: string) {
    onEditorStateChange((current) => current.draft === null ? current : {
      ...current,
      draft: {
        ...current.draft,
        stages: current.draft.stages.map((entry) => entry.stage === stage
          ? { stage, executor: agentTypeId ? { kind: 'agent_type', agentTypeId } : { kind: 'disabled' } }
          : entry),
      },
    });
    setError(null);
    setSaveConflict(false);
    setNotice(null);
  }

  function keepAgentType(agentType: AutomationAgentType) {
    onEditorStateChange((current) => {
      if (current.draft === null) return current;
      const agentTypes = editingAgentTypeId === 'new'
        ? [...current.draft.agentTypes, agentType]
        : current.draft.agentTypes.map((item) => item.id === editingAgentTypeId ? agentType : item);
      return { ...current, draft: { ...current.draft, agentTypes } };
    });
    setEditingAgentTypeId(null);
    setError(null);
    setSaveConflict(false);
    setNotice(null);
  }

  function deleteAgentType() {
    if (!editingAgentType || usedByStages.length > 0) return;
    onEditorStateChange((current) => current.draft === null ? current : {
      ...current,
      draft: {
        ...current.draft,
        agentTypes: current.draft.agentTypes.filter((agentType) => agentType.id !== editingAgentType.id),
      },
    });
    setEditingAgentTypeId(null);
    setError(null);
    setSaveConflict(false);
    setNotice(null);
  }

  async function saveConfiguration() {
    if (!draft || !connected || saving || !dirty) return;
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
      setNotice('Configuration saved. Runtime behavior remains unchanged until automation adopts it.');
    } catch (caught) {
      if (!saveOperations.current.isCurrent(operation)) return;
      const message = caught instanceof Error ? caught.message : 'Automation configuration could not be saved.';
      const conflict = caught instanceof BoardApiError && caught.status === 409;
      setSaveConflict(conflict);
      setError(conflict
        ? `Someone else saved a newer configuration. Your draft is still here. ${message}`
        : `Your draft is still here. ${message}`);
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
    setNotice(remote ? 'Draft discarded and the latest saved configuration loaded.' : 'Draft changes discarded.');
  }

  function reloadRemoteConfiguration() {
    onEditorStateChange((current) => acceptRemoteAutomationConfiguration(current));
    setEditingAgentTypeId(null);
    setError(null);
    setSaveConflict(false);
    setNotice('Latest saved configuration loaded. The previous local draft was discarded.');
  }

  return (
    <>
      <header className="border-b border-line bg-canvas px-4 py-5 sm:px-8 lg:px-12 lg:py-8">
        <div className="flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-light tracking-[0.02em] sm:text-[28px]">Automation</h1>
            <p className="mt-1.5 max-w-2xl text-sm font-light leading-6 text-muted">
              Define reusable specialist profiles and the desired handoff path for durable task intake.
            </p>
          </div>
          {saved ? (
            <div className="text-left text-xs leading-5 text-muted sm:text-right">
              {saved.updatedBy === 'system:steward-default' ? (
                <p>Starter configuration · version {saved.version}</p>
              ) : (
                <>
                  <p>Version {saved.version}</p>
                  <p>Updated {formatUpdatedAt(saved.updatedAt)} by {saved.updatedBy}</p>
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
                  Saving does not wake agents, change running work, or control the current hard-coded runtime. It records the intended configuration for later runtime integration.
                </p>
              </div>
            </div>
          </Card>

          {remote && saved ? (
            <div role="alert" className="rounded-xl border border-caution-border bg-caution-soft px-4 py-4 text-sm leading-6 text-ink">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">Saved configuration changed</p>
                  <p className="mt-1 text-caution">Version {remote.version} is now saved remotely. Your draft based on version {saved.version} is preserved; reload only when you are ready to discard it.</p>
                </div>
                <Button className="shrink-0" size="sm" onClick={reloadRemoteConfiguration}>Reload latest and discard draft</Button>
              </div>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="rounded-xl border border-urgent/25 bg-urgent-soft px-4 py-3 text-sm leading-6 text-urgent">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{error}</span>
                {saveConflict ? <Button className="shrink-0" size="sm" onClick={() => void load(true)}>Check latest configuration</Button> : null}
              </div>
            </div>
          ) : null}
          {notice ? (
            <div role="status" className="rounded-xl border border-success-fill/50 bg-success-soft px-4 py-3 text-sm leading-6 text-success">
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
              <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">No local fallback is used for automation settings.</p>
              <Button className="mt-4" icon={<RefreshCw size={15} />} disabled={!connected} onClick={() => void load(true)}>Try again</Button>
            </Card>
          ) : null}

          {draft ? (
            <>
              <Card as="section" className="overflow-hidden">
                <div className="flex flex-col gap-4 border-b border-line px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
                  <div>
                    <h2 id="agent-types-heading" className="font-display text-xl font-light tracking-[0.01em]">Agent types</h2>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                      Profiles describe desired specialization. Authority comes only from the fixed role; this page never stores tools, credentials, models, or workspace paths.
                    </p>
                  </div>
                  <Button variant="primary" size="sm" icon={<Plus size={15} />} disabled={draft.agentTypes.length >= 32} onClick={() => setEditingAgentTypeId('new')}>Add agent type</Button>
                </div>

                {draft.agentTypes.length > 0 ? (
                  <div className="divide-y divide-line">
                    {draft.agentTypes.map((agentType) => {
                      const authority = authorityForRole(agentType.role);
                      const assignments = draft.stages.filter((entry) => entry.executor.kind === 'agent_type' && entry.executor.agentTypeId === agentType.id);
                      return (
                        <article key={agentType.id} className="px-4 py-5 sm:px-6">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-medium text-ink">{agentType.name}</h3>
                                <Pill tone={agentType.enabled ? 'green' : 'neutral'} dot={agentType.enabled}>{agentType.enabled ? 'Enabled' : 'Disabled'}</Pill>
                                <Pill tone={agentType.role === 'engineer' ? 'blue' : agentType.role === 'verifier' ? 'purple' : 'neutral'}>{roleLabels[agentType.role]}</Pill>
                              </div>
                              <p className="mt-1 break-all font-mono text-[11px] text-muted">{agentType.id}</p>
                              <p className="mt-3 max-w-3xl text-sm leading-6 text-ink">{agentType.description}</p>
                              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs leading-5 text-muted">
                                <span><strong className="font-medium text-ink">Authority:</strong> {authority.label}</span>
                                <span><strong className="font-medium text-ink">Evaluation:</strong> {evaluatorLabels[agentType.evaluatorProfile]}</span>
                                <span><strong className="font-medium text-ink">Stages:</strong> {assignments.length || 'None'}</span>
                                <span><strong className="font-medium text-ink">Skills:</strong> {agentType.skillIds.length || 'None'}</span>
                              </div>
                              <p className="mt-1 text-xs leading-5 text-muted">{authority.detail}</p>
                            </div>
                            <Button size="sm" icon={<Pencil size={14} />} onClick={() => setEditingAgentTypeId(agentType.id)}>Edit</Button>
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
                  <h2 id="pipeline-heading" className="font-display text-xl font-light tracking-[0.01em]">Pipeline</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
                    Stages stay in canonical order. An adopted runtime may hand work backward for another pass, but these rows define the desired owner for each stage.
                  </p>
                </div>
                <ol className="divide-y divide-line">
                  {AUTOMATION_STAGE_ORDER.map((stage, index) => {
                    const entry = draft.stages.find((candidate) => candidate.stage === stage);
                    if (!entry) return null;
                    const locked = stage === 'human_review' || stage === 'deployment';
                    const eligible = eligibleAgentTypes(stage, draft.agentTypes);
                    return (
                      <li key={stage} className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(220px,.8fr)] sm:items-center sm:px-6">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-[99px] bg-muted-surface text-xs font-medium text-muted">{index + 1}</span>
                          <div>
                            <h3 className="text-sm font-medium text-ink">{stageLabels[stage]}</h3>
                            <p className="mt-1 text-xs leading-5 text-muted">{stageDescriptions[stage]}</p>
                          </div>
                        </div>
                        {locked ? (
                          <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-muted-surface px-3.5" aria-label={`${stageLabels[stage]} executor`}>
                            <span className="flex items-center gap-2 text-sm text-ink">
                              {stage === 'human_review' ? <ShieldCheck size={16} /> : <LockKeyhole size={16} />}
                              {stage === 'human_review' ? 'Human owner' : 'Disabled'}
                            </span>
                            <Pill>Locked</Pill>
                          </div>
                        ) : (
                          <div>
                            <label htmlFor={`automation-stage-${stage}`} className="mb-1.5 block text-xs font-medium text-ink">Executor</label>
                            <select
                              id={`automation-stage-${stage}`}
                              aria-label={`${stageLabels[stage]} executor`}
                              className={inputClass}
                              value={executorValue(entry.executor)}
                              onChange={(event) => updateStage(stage, event.target.value)}
                            >
                              <option value="">Disabled</option>
                              {eligible.map((agentType) => (
                                <option key={agentType.id} value={agentType.id}>{agentType.name} · {roleLabels[agentType.role]}</option>
                              ))}
                            </select>
                            {eligible.length === 0 ? <p className="mt-1.5 text-xs leading-5 text-muted">Add an eligible enabled type to assign this stage.</p> : null}
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
                    : dirty ? 'Unsaved draft changes are visible only in this browser.' : 'Configuration matches the saved version.'}
                </p>
                <div className="flex gap-2">
                  <Button disabled={!dirty || saving} onClick={discardChanges}>Discard changes</Button>
                  <Button variant="primary" icon={<Save size={15} />} disabled={!dirty || saving || !connected || remote !== null} onClick={() => void saveConfiguration()}>
                    {saving ? 'Saving…' : 'Save configuration'}
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
        title={editingAgentTypeId === 'new' ? 'Add agent type' : 'Edit agent type'}
        description="Describe specialization while keeping runtime authority explicit and role-bound."
        className="sm:max-w-2xl"
      >
        {editingAgentTypeId ? (
          <AgentTypeForm
            key={editingAgentTypeId}
            initial={editingAgentTypeId === 'new' ? null : editingAgentType}
            persisted={editingAgentTypePersisted}
            existingIds={draft?.agentTypes.map((agentType) => agentType.id) ?? []}
            usedByStages={usedByStages}
            onCancel={() => setEditingAgentTypeId(null)}
            onSave={keepAgentType}
            onDelete={editingAgentTypeId !== 'new' && !editingAgentTypePersisted ? deleteAgentType : undefined}
          />
        ) : null}
      </Modal>
    </>
  );
}
