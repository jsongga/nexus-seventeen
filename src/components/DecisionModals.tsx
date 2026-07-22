import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ClipboardList,
  Fingerprint,
  GitCommitHorizontal,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import type { ApprovalItem, RiskTone } from '../data/demo';
import { Button, FieldLabel, inputClass, Modal, Pill } from './ui';

export function ProductionApprovalModal({
  approval,
  onClose,
  onConfirm,
}: {
  approval: ApprovalItem | null;
  onClose: () => void;
  onConfirm: (approval: ApprovalItem) => void;
}) {
  const [phrase, setPhrase] = useState('');

  useEffect(() => setPhrase(''), [approval?.id]);

  if (!approval || approval.kind !== 'production' || !approval.release) return null;
  const matches = phrase.trim() === approval.confirmationPhrase;

  return (
    <Modal
      open
      onClose={onClose}
      title="Simulate release authorization"
      description="This browser-local demo records a final human decision for one exact release candidate. It does not deploy."
    >
      <div className="space-y-5 px-5 py-5 sm:px-6">
        <div className="rounded-[14px] border border-ink bg-ink p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-teal-500 text-ink">
              <LockKeyhole size={17} />
            </span>
            <div>
              <p className="text-sm font-bold text-white">No deployment occurs in this demo</p>
              <p className="mt-1 text-[12px] leading-5 text-[#d7dce1]">
                The simulated approval is bound to the release digests below and can be consumed only once in this browser.
              </p>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-[14px] border border-line bg-white">
          <div className="flex items-center gap-3 border-b border-[#eef0f2] p-4">
            <GitCommitHorizontal size={17} className="text-teal-700" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">Commit</p>
              <p className="mt-0.5 break-all font-mono text-[11px] font-medium text-ink">{approval.release.commit}</p>
            </div>
            <Pill tone="green">Demo evidence</Pill>
          </div>
          <div className="flex items-center gap-3 border-b border-[#eef0f2] p-4">
            <Fingerprint size={17} className="text-teal-700" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">Build digest</p>
              <p className="mt-0.5 break-all font-mono text-[11px] font-medium text-ink">{approval.release.buildDigest}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4">
            <ShieldCheck size={17} className="text-teal-700" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">Destination</p>
              <p className="mt-0.5 text-xs font-bold text-ink">{approval.target}</p>
            </div>
          </div>
        </div>

        <div>
          <FieldLabel htmlFor="confirmation-phrase">
            Type <span className="font-mono text-teal-700">{approval.confirmationPhrase}</span> to confirm
          </FieldLabel>
          <input
            id="confirmation-phrase"
            className={`${inputClass} font-mono`}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            placeholder={approval.confirmationPhrase}
            autoComplete="off"
            autoFocus
            data-dialog-initial-focus
          />
        </div>

        <div className="flex items-center gap-2 text-[11px] font-semibold text-muted">
          <Check size={14} className="text-teal-700" />
          The demo attributes this decision to Jordan Lee and consumes it once in this browser.
        </div>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="whitespace-nowrap px-2 text-[13px] sm:px-4 sm:text-sm"
            disabled={!matches}
            onClick={() => onConfirm(approval)}
            icon={<Fingerprint size={16} />}
          >
            Record authorization
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function RequestChangesModal({
  approval,
  onClose,
  onConfirm,
}: {
  approval: ApprovalItem | null;
  onClose: () => void;
  onConfirm: (approval: ApprovalItem, note: string) => void;
}) {
  const [note, setNote] = useState('');

  useEffect(() => setNote(''), [approval?.id]);
  if (!approval) return null;

  return (
    <Modal open onClose={onClose} title="Send back with direction" description={approval.title}>
      <div className="space-y-5 px-5 py-5 sm:px-6">
        <div className="flex items-start gap-3 rounded-[14px] border border-[#e8b5af] bg-[#fff0ee] p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-urgent" />
          <p className="text-[12px] leading-5 text-urgent">
            Agents will stop this handoff, preserve its evidence, and create a new revision from your direction.
          </p>
        </div>
        <div>
          <FieldLabel htmlFor="change-note">What needs to change?</FieldLabel>
          <textarea
            id="change-note"
            className={`${inputClass} min-h-32 resize-y py-3`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Be specific about the outcome or risk the team should address…"
            autoFocus
            data-dialog-initial-focus
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={note.trim().length < 8}
            onClick={() => onConfirm(approval, note.trim())}
            icon={<ArrowRight size={16} />}
          >
            Send direction
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface NewMissionInput {
  title: string;
  goal: string;
  risk: RiskTone;
  budget: number;
}

export function NewMissionModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (mission: NewMissionInput) => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [risk, setRisk] = useState<RiskTone>('medium');
  const [budget, setBudget] = useState(8);

  useEffect(() => {
    if (!open) {
      setTitle('');
      setGoal('');
      setRisk('medium');
      setBudget(8);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start with human intent"
      description="Define the outcome. An engineering manager will return bounded scope and acceptance criteria for approval."
    >
      <form
        className="space-y-5 px-5 py-5 sm:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({ title: title.trim(), goal: goal.trim(), risk, budget });
        }}
      >
        <div>
          <FieldLabel htmlFor="mission-title">Mission name</FieldLabel>
          <input
            id="mission-title"
            className={inputClass}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Make team invites recoverable"
            autoFocus
            data-dialog-initial-focus
          />
        </div>
        <div>
          <FieldLabel htmlFor="mission-goal">Outcome and why it matters</FieldLabel>
          <textarea
            id="mission-goal"
            className={`${inputClass} min-h-28 resize-y py-3`}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Customers should be able to… so that…"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor="mission-risk">Initial risk</FieldLabel>
            <select
              id="mission-risk"
              className={inputClass}
              value={risk}
              onChange={(event) => setRisk(event.target.value as RiskTone)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="mission-budget">Token budget ($)</FieldLabel>
            <input
              id="mission-budget"
              type="number"
              min={1}
              max={100}
              className={`${inputClass} font-mono tabular-nums`}
              value={budget}
              onChange={(event) => setBudget(Number(event.target.value))}
            />
          </div>
        </div>
        <div className="rounded-[14px] border border-[#b9ddd9] bg-[#e8f5f3] p-4">
          <div className="flex items-start gap-3">
            <ClipboardList size={17} className="mt-0.5 shrink-0 text-teal-700" />
            <p className="text-[11px] leading-5 text-[#365f5b]">
              Creating this mission does not start code changes. Mira first drafts scope, acceptance criteria, risks, and a route for you to approve.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={title.trim().length < 4 || goal.trim().length < 12}
            icon={<ClipboardList size={16} />}
          >
            Draft scope
          </Button>
        </div>
      </form>
    </Modal>
  );
}
