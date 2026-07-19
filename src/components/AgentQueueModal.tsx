import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, Clock3, ListEnd, ListPlus, Target, X } from 'lucide-react';
import { isInterruptPending, isInterruptSettled, isRunStateUncertain, type DemoRun } from '../data/demo';
import { useDialogLayer } from './dialog-stack';
import { Button, cn, inputClass, Pill } from './ui';

export interface AgentQueueModalProps {
  run: DemoRun | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    desiredOutcome: string;
    position: 'next' | 'backlog';
    expectedAgentMinutes: number;
  }) => void;
}

export function AgentQueueModal({ run, open, onClose, onSubmit }: AgentQueueModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const titleInputId = useId();
  const outcomeInputId = useId();
  const estimateInputId = useId();
  const positionLegendId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [desiredOutcome, setDesiredOutcome] = useState('');
  const [position, setPosition] = useState<'next' | 'backlog'>('next');
  const [expectedAgentMinutes, setExpectedAgentMinutes] = useState(30);
  const [submitted, setSubmitted] = useState(false);
  const [visualViewportTop, setVisualViewportTop] = useState(0);
  const agentLaneId = run?.agentLaneId;
  const { isTopmost } = useDialogLayer({
    open: open && run !== null,
    onClose,
    containerRef: dialogRef,
  });

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDesiredOutcome('');
    setPosition('next');
    setExpectedAgentMinutes(30);
    setSubmitted(false);
  }, [agentLaneId, open]);

  useEffect(() => {
    if (!open || !run) return;

    const visualViewport = window.visualViewport;
    const syncVisualViewport = () => setVisualViewportTop(Math.max(0, visualViewport?.offsetTop ?? 0));

    syncVisualViewport();
    visualViewport?.addEventListener('resize', syncVisualViewport);
    visualViewport?.addEventListener('scroll', syncVisualViewport);

    return () => {
      visualViewport?.removeEventListener('resize', syncVisualViewport);
      visualViewport?.removeEventListener('scroll', syncVisualViewport);
    };
  }, [agentLaneId, open]);

  if (!open || !run) return null;

  const titleMissing = submitted && title.trim().length === 0;
  const outcomeMissing = submitted && desiredOutcome.trim().length === 0;
  const nextUpCount = run.queue.filter((item) => item.position === 'next').length;
  const runUnavailable =
    isInterruptSettled(run.controlState) ||
    isInterruptPending(run.controlState) ||
    isRunStateUncertain(run.controlState);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);

    if (!title.trim()) {
      titleInputRef.current?.focus();
      return;
    }
    if (!desiredOutcome.trim()) {
      document.getElementById(outcomeInputId)?.focus();
      return;
    }

    onSubmit({
      title: title.trim(),
      desiredOutcome: desiredOutcome.trim(),
      position,
      expectedAgentMinutes,
    });
  };

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-[80] flex items-end justify-center bg-ink/60 backdrop-blur-[3px] sm:items-center sm:p-5',
        !isTopmost && 'pointer-events-none',
      )}
      style={{ top: visualViewportTop }}
      role="presentation"
      aria-hidden={isTopmost ? undefined : true}
      onMouseDown={(event) => {
        if (isTopmost && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal={isTopmost ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-[1.5rem] border border-line bg-paper shadow-[0_24px_70px_rgba(23,28,36,.24)] sm:max-w-[540px] sm:rounded-3xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line bg-white px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-teal-500 text-ink">
                <ListPlus size={16} />
              </span>
              <div>
                <h2 id={titleId} className="font-display text-xl font-bold tracking-[-0.03em] text-ink">Queue work for {run.agent}</h2>
                <p className="mt-0.5 text-[10px] font-semibold text-teal-700">Human direction</p>
              </div>
            </div>
            <p id={descriptionId} className="mt-2 max-w-md text-[11px] leading-5 text-muted">
              {runUnavailable
                ? 'Add a result to this stable agent lane. It remains queued across interruption, reconnection, resume, or a replacement run.'
                : 'Add a result to this stable agent lane. Queuing work does not interrupt the action already in progress.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-11 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-[#eef0f2] hover:text-ink"
            aria-label="Close queue work dialog"
          >
            <X size={19} />
          </button>
        </header>

        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" noValidate onSubmit={handleSubmit}>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor={titleInputId} className="text-xs font-bold text-[#404a54]">Short title</label>
                <span className="font-mono text-[10px] font-medium tabular-nums text-[#66707a]">{title.length}/80</span>
              </div>
              <input
                ref={titleInputRef}
                data-dialog-initial-focus
                id={titleInputId}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className={cn(inputClass, titleMissing && 'border-[#a01c14] focus:border-[#a01c14]')}
                placeholder="For example, check keyboard navigation"
                maxLength={80}
                aria-invalid={titleMissing}
                aria-describedby={titleMissing ? `${titleInputId}-error` : undefined}
              />
              {titleMissing ? (
                <p id={`${titleInputId}-error`} className="mt-1.5 text-[11px] font-semibold text-urgent">Give this work a short title.</p>
              ) : null}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor={outcomeInputId} className="text-xs font-bold text-[#404a54]">Desired user outcome</label>
                <span className="font-mono text-[10px] font-medium tabular-nums text-[#66707a]">{desiredOutcome.length}/320</span>
              </div>
              <textarea
                id={outcomeInputId}
                value={desiredOutcome}
                onChange={(event) => setDesiredOutcome(event.target.value)}
                className={cn(inputClass, 'min-h-28 resize-y py-3 leading-5', outcomeMissing && 'border-[#a01c14] focus:border-[#a01c14]')}
                placeholder="Describe what should be better for users when this is finished."
                maxLength={320}
                aria-invalid={outcomeMissing}
                aria-describedby={outcomeMissing ? `${outcomeInputId}-error` : `${outcomeInputId}-hint`}
              />
              {outcomeMissing ? (
                <p id={`${outcomeInputId}-error`} className="mt-1.5 text-[11px] font-semibold text-urgent">Describe the result this work should produce.</p>
              ) : (
                <p id={`${outcomeInputId}-hint`} className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-4 text-muted">
                  <Target size={12} className="mt-0.5 shrink-0 text-teal-700" /> Focus on the user-visible result, not implementation steps.
                </p>
              )}
            </div>

            <div>
              <label htmlFor={estimateInputId} className="text-xs font-bold text-[#404a54]">
                Expected agent work time
              </label>
              <div className="relative mt-2">
                <Clock3
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-teal-700"
                  aria-hidden="true"
                />
                <select
                  id={estimateInputId}
                  value={expectedAgentMinutes}
                  onChange={(event) => setExpectedAgentMinutes(Number(event.target.value))}
                  className={cn(inputClass, 'appearance-none pl-9 font-mono tabular-nums')}
                >
                  {[15, 30, 45, 60, 90, 120].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-muted">
                Agent working time only, in 15-minute increments. Human review, waiting, and deployment time are not included.
              </p>
            </div>

            <fieldset aria-labelledby={positionLegendId}>
              <legend id={positionLegendId} className="text-xs font-bold text-[#404a54]">When should the agent take this on?</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-colors',
                  position === 'next'
                    ? 'border-[#237a72] bg-[#e8f5f3]'
                    : 'border-line bg-white hover:border-[#237a72]/45',
                )}>
                  <input
                    type="radio"
                    name="queue-position"
                    value="next"
                    checked={position === 'next'}
                    onChange={() => setPosition('next')}
                    className="mt-0.5 size-4 accent-[#237a72]"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-ink"><ArrowDownToLine size={14} /> Next-up queue</span>
                    <span className="mt-1 block text-[10px] leading-4 text-muted">
                      {runUnavailable
                        ? 'Run after this lane is available again, its current task, and any results already next up.'
                        : 'Run after the current task and any results people have already marked next up.'}
                    </span>
                  </span>
                </label>
                <label className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-colors',
                  position === 'backlog'
                    ? 'border-[#237a72] bg-[#e8f5f3]'
                    : 'border-line bg-white hover:border-[#237a72]/45',
                )}>
                  <input
                    type="radio"
                    name="queue-position"
                    value="backlog"
                    checked={position === 'backlog'}
                    onChange={() => setPosition('backlog')}
                    className="mt-0.5 size-4 accent-[#237a72]"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-ink"><ListEnd size={14} /> Add to backlog</span>
                    <span className="mt-1 block text-[10px] leading-4 text-muted">Keep it behind work that people have already queued.</span>
                  </span>
                </label>
              </div>
            </fieldset>

            <div className="flex items-center gap-2 rounded-xl border border-[#b9ddd9] bg-[#e8f5f3] px-3 py-2.5 text-[10px] leading-4 text-[#365f5b]">
              <Pill tone="green"><span className="font-mono tabular-nums">{run.queue.length}</span> queued</Pill>
              <span>
                {position === 'next'
                  ? nextUpCount === 0
                    ? 'This becomes the next queued result.'
                    : `This joins behind ${nextUpCount} ${nextUpCount === 1 ? 'result' : 'results'} already next up.`
                  : 'This will be added after existing queued work.'}
              </span>
            </div>
          </div>

          <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-line bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:flex-row sm:justify-end sm:px-6 sm:pb-5">
            <Button type="button" variant="quiet" onClick={onClose} className="w-full sm:w-auto">Cancel</Button>
            <Button type="submit" variant="primary" icon={<ListPlus size={15} />} className="w-full sm:w-auto">Add to {run.agent}&apos;s queue</Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
