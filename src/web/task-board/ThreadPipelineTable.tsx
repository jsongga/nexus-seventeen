import { Pill } from '../components/ui';
import type { BoardAgent, BoardTask, TaskStatus } from './types';

type PipelineStage = {
  label: 'Queued' | 'Agent Working' | 'Awaiting Review' | 'Changes Requested' | 'Merged';
  tone: 'purple' | 'blue' | 'amber' | 'red' | 'green';
};

const pipelineStageByStatus: Record<TaskStatus, PipelineStage> = {
  queued: { label: 'Queued', tone: 'purple' },
  backlog: { label: 'Queued', tone: 'purple' },
  proposed: { label: 'Queued', tone: 'purple' },
  running: { label: 'Agent Working', tone: 'blue' },
  waiting_for_human: { label: 'Awaiting Review', tone: 'amber' },
  blocked: { label: 'Changes Requested', tone: 'red' },
  failed: { label: 'Changes Requested', tone: 'red' },
  interrupted: { label: 'Changes Requested', tone: 'red' },
  completed: { label: 'Merged', tone: 'green' },
};

const updatedDateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function pipelineStageForStatus(status: TaskStatus): PipelineStage {
  return pipelineStageByStatus[status];
}

function updatedLabel(value: string | null): string {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : updatedDateTime.format(parsed);
}

export function ThreadPipelineTable({
  tasks,
  agentById,
  onTask,
}: {
  tasks: BoardTask[];
  agentById: ReadonlyMap<string, BoardAgent>;
  onTask: (taskId: string) => void;
}) {
  return (
    /* Keep the pipeline viewport-capped so the activity feed and both workspace actions remain reachable; dvh is viewport-relative by design. */
    <section className="flex max-h-[20dvh] min-h-0 min-w-0 shrink-0 flex-col overflow-hidden md:max-h-[40dvh]" aria-labelledby="active-thread-pipeline-heading">
      <h2 id="active-thread-pipeline-heading" className="mb-4 text-xs font-semibold tracking-[0.2px] text-ink">Active Thread Pipeline</h2>
      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-taupe-hover [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-[99px] [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-track]:bg-transparent"
        role="region"
        aria-label="Active thread pipeline rows"
        tabIndex={0}
      >
        <table className="w-full table-fixed border-collapse text-left" aria-labelledby="active-thread-pipeline-heading">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[20%]" />
          <col className="w-[25%]" />
          <col className="w-[15%]" />
        </colgroup>
        <thead>
          <tr>
            {['Task Objective', 'Assigned Agent', 'Stage', 'Updated'].map((heading) => (
              <th key={heading} scope="col" className="border-b border-line pb-2 text-[11px] font-medium leading-tight text-muted">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.length > 0 ? tasks.map((task) => {
            const stage = pipelineStageForStatus(task.status);
            return (
              <tr key={task.id} className="[&:last-child>td]:border-b-0">
                <td className="border-b border-line py-2.5 align-middle text-[13px]">
                  <button
                    type="button"
                    className="inline-flex max-w-full items-center gap-2 rounded-[6px] bg-muted-surface px-2.5 py-1.5 text-left text-ink hover:bg-line-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                    onClick={() => onTask(task.id)}
                  >
                    <span className="min-w-0 break-words">{task.title}</span>
                  </button>
                </td>
                <td className="break-words border-b border-line py-2.5 align-middle text-[11px] text-muted">
                  {task.assignedAgentId ? agentById.get(task.assignedAgentId)?.name ?? task.assignedAgentId : '-'}
                </td>
                <td className="border-b border-line py-2.5 align-middle text-[13px]">
                  <Pill className="max-w-full justify-center whitespace-normal text-center" tone={stage.tone}>{stage.label}</Pill>
                </td>
                <td className="break-words border-b border-line py-2.5 align-middle text-[11px] text-muted">
                  <time dateTime={task.updatedAt || undefined}>{updatedLabel(task.updatedAt)}</time>
                </td>
              </tr>
            );
          }) : (
            <tr>
              <td colSpan={4} className="py-6 text-center text-xs text-muted">No tasks are in this project pipeline.</td>
            </tr>
          )}
        </tbody>
        </table>
      </div>
    </section>
  );
}
