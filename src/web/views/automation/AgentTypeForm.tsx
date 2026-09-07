/** Edits one agent type within the automation draft. */

/* —— Imports —— */

const skillIdentifierPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, FieldLabel, cn, inputClass } from "../../components/ui";
import { identifierPattern } from "../../data/wire";
import {
  type AgentRole,
  type AutomationAgentType,
  type AutomationEvaluatorProfile,
  type WorkItemStage,
} from "../../types";
import { authorityForRole, stageLabels } from "./vocabulary";

/* —— Agent type form —— */

interface AgentTypeFormProps {
  initial: AutomationAgentType | null;
  persisted: boolean;
  existingIds: string[];
  usedByStages: WorkItemStage[];
  onCancel: () => void;
  onSave: (agentType: AutomationAgentType) => void;
  onDelete?: () => void;
}

export function AgentTypeForm({
  initial,
  persisted,
  existingIds,
  usedByStages,
  onCancel,
  onSave,
  onDelete,
}: AgentTypeFormProps) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [role, setRole] = useState<AgentRole>(initial?.role ?? "engineer");
  const [supplementalInstructions, setSupplementalInstructions] = useState(initial?.supplementalInstructions ?? "");
  const [skillIdsText, setSkillIdsText] = useState(initial?.skillIds.join("\n") ?? "");
  const [evaluatorProfile, setEvaluatorProfile] = useState<AutomationEvaluatorProfile>(
    initial?.evaluatorProfile ?? "tests"
  );
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
      setError(
        "ID must start with a letter or number and use only letters, numbers, dot, underscore, colon, @, slash, or hyphen."
      );
      return;
    }
    if (cleanId !== initial?.id && existingIds.includes(cleanId)) {
      setError("An agent type with this ID already exists.");
      return;
    }
    if (!cleanName) {
      setError("Enter a display name.");
      return;
    }
    if (cleanName.length > 160) {
      setError("Display name cannot exceed 160 characters.");
      return;
    }
    if (!cleanDescription) {
      setError("Describe the specialist purpose of this type.");
      return;
    }
    if (cleanDescription.length > 4_000 || cleanInstructions.length > 8_000) {
      setError("Purpose or supplemental instructions are too long.");
      return;
    }
    if (enabled && !cleanInstructions) {
      setError("Enabled specialist templates require supplemental instructions.");
      return;
    }
    if (skillIds.length > 32 || skillIds.some((skillId) => !skillIdentifierPattern.test(skillId))) {
      setError(
        "Use at most 32 lowercase skill IDs with letters, numbers, dot, underscore, colon, or hyphen. URLs and paths are not accepted."
      );
      return;
    }
    if (new Set(skillIds).size !== skillIds.length) {
      setError("Remove duplicate skill IDs.");
      return;
    }
    if (!enabled && usedByStages.length > 0) {
      setError(
        `Assign ${usedByStages.map((stage) => stageLabels[stage]).join(", ")} elsewhere before disabling this type.`
      );
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
          className={cn(inputClass, initial && "bg-surface text-muted")}
          value={id}
          disabled={initial !== null}
          required
          maxLength={128}
          autoComplete="off"
          placeholder="implementation-engineer"
          onChange={(event) => setId(event.target.value)}
        />
        <p className="mt-1.5 text-xs leading-5 text-muted">
          {initial
            ? "IDs are permanent after creation so pipeline references remain stable."
            : "Stable identifier used by pipeline references."}
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
          className={cn(inputClass, "min-h-24 resize-y py-3")}
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
            className={cn(inputClass, initial && "bg-surface text-muted")}
            value={role}
            disabled={initial !== null}
            onChange={(event) => setRole(event.target.value as AgentRole)}
          >
            <option value="engineer">Engineer</option>
            <option value="manager">Manager</option>
            <option value="verifier">Verifier</option>
          </select>
          {initial ? (
            <p className="mt-1.5 text-xs leading-5 text-muted">Authority cannot change after creation.</p>
          ) : null}
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
          className={cn(inputClass, "min-h-28 resize-y py-3")}
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
          className={cn(inputClass, "min-h-24 resize-y py-3 font-mono text-xs")}
          value={skillIdsText}
          placeholder={"code-review\nrelease-checklist"}
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
          Used by {usedByStages.map((stage) => stageLabels[stage]).join(", ")}. Reassign those stages before disabling
          or deleting this type.
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
          ) : persisted ? (
            <p className="max-w-xs text-xs leading-5 text-muted">Saved IDs are retained; disable this type instead.</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Keep draft
          </Button>
        </div>
      </div>
    </form>
  );
}
