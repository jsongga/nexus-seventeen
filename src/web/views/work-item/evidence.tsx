/** Renders the evidence a reviewer reads: pipeline summary, design record, findings and gaps. */

/* —— Imports —— */

import { RefreshCw } from "lucide-react";
import type { DesignRecordDraft, PipelineSummary, ReviewFinding } from "@shared/task-board-contract";
import { Button, Pill, cn } from "../../components/ui";
import { pipelineAssumptionReview, pipelineFindingRounds, pipelineFileReview } from "../../model/work-item-detail";
import { prettyStatus } from "../../model/work-item-labels";

/* —— Evidence panels —— */

export function GapReportSection({
  state,
  content,
  error,
  onRetry,
}: {
  state: "loading" | "ready" | "error";
  content: string | null;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section className="border-b border-line px-4 py-4 sm:px-5" aria-labelledby="onboarding-gap-report-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="onboarding-gap-report-heading" className="text-xs font-semibold text-ink">
            Gap report
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Items the onboarding pass could not complete automatically.
          </p>
        </div>
        {state === "error" ? (
          <Button size="sm" icon={<RefreshCw size={14} />} onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
      {state === "loading" ? (
        <div
          className="mt-3 flex min-h-20 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
          role="status"
        >
          <RefreshCw size={15} className="animate-spin" aria-hidden="true" /> Loading gap report…
        </div>
      ) : state === "error" ? (
        <p
          className="mt-3 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
          role="alert"
        >
          {error ?? "The gap report could not be loaded."}
        </p>
      ) : content === null ? (
        <p className="mt-3 rounded-md border border-line bg-muted-surface px-3.5 py-3 text-sm text-muted">
          No gap report has been recorded yet.
        </p>
      ) : (
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-muted-surface px-3.5 py-3 font-mono text-xs leading-6 text-ink">
          {content}
        </pre>
      )}
    </section>
  );
}

export function ReviewFindingsPanel({ findings }: { findings: readonly ReviewFinding[] }) {
  const rounds = pipelineFindingRounds(findings);
  return (
    <div className="rounded-md border border-line bg-card p-3.5">
      <h4 className="text-xs font-semibold text-ink">Review findings</h4>
      {rounds.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No review findings were recorded.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {rounds.map((round) => (
            <section key={round.round} aria-labelledby={`review-findings-round-${round.round}`}>
              <h5
                id={`review-findings-round-${round.round}`}
                className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted"
              >
                Round {round.round}
              </h5>
              <ol className="mt-2 space-y-2">
                {round.findings.map((finding) => {
                  const location = finding.file
                    ? `${finding.file}${finding.line === undefined || finding.line === null ? "" : `:${finding.line}`}`
                    : finding.line === undefined || finding.line === null
                      ? null
                      : `Line ${finding.line}`;
                  return (
                    <li key={finding.findingId} className="rounded-md border border-line bg-muted-surface p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {finding.blocking ? (
                            <Pill tone="red">
                              Blocking · {prettyStatus(finding.category)} · {prettyStatus(finding.severity)}
                            </Pill>
                          ) : (
                            <Pill>
                              {prettyStatus(finding.category)} · {prettyStatus(finding.severity)}
                            </Pill>
                          )}
                          <Pill>{prettyStatus(finding.stage)}</Pill>
                        </div>
                        {location === null ? null : (
                          <code className="break-all font-mono text-[11px] leading-5 text-muted">{location}</code>
                        )}
                      </div>
                      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div>
                          <dt className="text-[11px] font-medium text-muted">Expected</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-ink">
                            {finding.expected}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[11px] font-medium text-muted">Actual</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-ink">
                            {finding.actual}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function DesignTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <div className="mt-3">
      <h5 className="text-[11px] font-medium text-muted">{title}</h5>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs leading-5 text-muted">None recorded.</p>
      ) : (
        <div className="mt-1.5 max-w-full overflow-x-auto rounded-md border border-line">
          <table className="w-max min-w-full border-collapse text-left text-xs">
            <thead className="bg-muted-surface text-[11px] text-muted">
              <tr>
                {headers.map((header) => (
                  <th key={header} scope="col" className="whitespace-nowrap border-b border-line px-3 py-2 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row, rowIndex) => (
                <tr key={`${rowIndex}-${row.join("-")}`} className="align-top">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${cellIndex}-${cell}`}
                      className="min-w-32 whitespace-pre-wrap break-words px-3 py-2 leading-5 text-ink"
                    >
                      {cell || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DesignRecordDetails({ designRecord }: { designRecord: DesignRecordDraft }) {
  return (
    <div className="rounded-md border border-line bg-card p-3.5">
      <h4 className="text-xs font-semibold text-ink">Design record</h4>
      <div className="mt-3">
        <h5 className="text-[11px] font-medium text-muted">States</h5>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {designRecord.states.map((state) => (
            <Pill key={state}>{state}</Pill>
          ))}
        </div>
      </div>
      <DesignTable
        title="Transitions"
        headers={["From", "To", "Durable precondition", "Recovery"]}
        rows={designRecord.transitions.map((transition) => [
          transition.from,
          transition.to,
          transition.durablePrecondition ?? "",
          transition.recovery ?? "",
        ])}
      />
      <DesignTable
        title="Failure points"
        headers={["Point", "Resulting state", "Recovery"]}
        rows={designRecord.failurePoints.map((failurePoint) => [
          prettyStatus(failurePoint.point),
          failurePoint.resultingState,
          failurePoint.recovery,
        ])}
      />
      <DesignTable
        title="Idempotency keys"
        headers={["Key", "Generated", "Persisted", "Reuse"]}
        rows={designRecord.idempotencyKeys.map((key) => [key.name, key.generatedAt, key.persistedAt, key.reuse])}
      />
      <DesignTable
        title="Fault-injection cases"
        headers={["Case", "Scenario", "Expectation"]}
        rows={designRecord.faultInjectionCases.map((faultCase) => [
          faultCase.name,
          faultCase.scenario,
          faultCase.expectation,
        ])}
      />
    </div>
  );
}

export function PipelineSummaryDetails({ summary }: { summary: PipelineSummary }) {
  const files = pipelineFileReview(summary);
  const assumptions = pipelineAssumptionReview(summary);
  return (
    <div className="mt-4 space-y-4">
      {!summary.scopeOk ? (
        <div className="rounded-md border border-urgent/25 bg-urgent-soft px-3.5 py-3 text-sm text-urgent" role="alert">
          <p className="font-medium">Work outside the declared scope</p>
          <p className="mt-1 text-xs leading-5">Review each highlighted file before approving the merge.</p>
        </div>
      ) : null}

      <ReviewFindingsPanel findings={summary.findings} />

      {summary.designRecord === null ? null : <DesignRecordDetails designRecord={summary.designRecord} />}

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Commits</h4>
        {summary.commits.length > 0 ? (
          <ol className="mt-2 space-y-2">
            {summary.commits.map((commit) => (
              <li key={commit.sha} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 text-xs leading-5">
                <code className="font-mono text-muted" title={commit.sha}>
                  {commit.sha.slice(0, 8)}
                </code>
                <span className="break-words text-ink">{commit.subject}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-muted">No commits are present on the pipeline branch.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Diffstat</h4>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted-surface p-3 font-mono text-[11px] leading-5 text-ink">
          {summary.diffstat || "No file changes."}
        </pre>
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-ink">Files and declared scope</h4>
          <Pill tone={summary.scopeOk ? "green" : "red"}>{summary.scopeOk ? "Within scope" : "Scope violations"}</Pill>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted">
          Declared: {summary.declaredScope.join(", ") || "None declared"}
        </p>
        {files.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {files.map((file) => (
              <li
                key={file.file}
                className={cn(
                  "flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs",
                  file.outsideScope
                    ? "border-urgent/25 bg-urgent-soft text-urgent"
                    : "border-line bg-muted-surface text-ink"
                )}
              >
                <code className="min-w-0 break-all font-mono">{file.file}</code>
                {file.outsideScope ? (
                  <Pill tone="red">Outside declared scope</Pill>
                ) : (
                  <Pill tone="green">In scope</Pill>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted">No files changed.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Assumptions</h4>
        {assumptions.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {assumptions.map((item, index) => (
              <li
                key={`${index}-${item.assumption}`}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line bg-muted-surface px-3 py-2 text-xs leading-5 text-ink"
              >
                <span className="min-w-0 flex-1 break-words">{item.assumption}</span>
                {item.addedMidRun ? <Pill tone="amber">Added during implementation</Pill> : <Pill>Confirmed plan</Pill>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted">No assumptions recorded.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Machine verification</h4>
        {summary.verify.length > 0 ? (
          <ol className="mt-2 space-y-3">
            {summary.verify.map((attempt) => (
              <li key={attempt.verifyAttemptId} className="rounded-md border border-line bg-muted-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium text-ink">
                    Attempt {attempt.attempt} · {prettyStatus(attempt.stage)}
                  </p>
                  <Pill
                    tone={
                      attempt.state === "green"
                        ? "green"
                        : attempt.state === "running" || attempt.state === "starting"
                          ? "amber"
                          : "red"
                    }
                  >
                    {prettyStatus(attempt.state)}
                  </Pill>
                </div>
                {attempt.detail ? (
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted">{attempt.detail}</p>
                ) : null}
                {attempt.checkResults === null || attempt.checkResults.length === 0 ? (
                  <p className="mt-2 text-xs text-muted">No criterion checks were recorded.</p>
                ) : (
                  <dl className="mt-2 space-y-2">
                    {attempt.checkResults.map((check, index) => (
                      <div
                        key={`${index}-${check.criterion}`}
                        className="rounded-md border border-line bg-card px-3 py-2"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <dt className="text-xs font-medium leading-5 text-ink">{check.criterion}</dt>
                          <Pill tone={check.passed ? "green" : "red"}>{check.passed ? "Passed" : "Failed"}</Pill>
                        </div>
                        <dd className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted">
                          {check.check}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-muted">No verify attempts were recorded.</p>
        )}
      </div>

      <div className="rounded-md border border-line bg-card p-3.5">
        <h4 className="text-xs font-semibold text-ink">Human-review criteria</h4>
        {summary.criteria.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-ink">
            {summary.criteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>{criterion}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted">No prose criteria recorded.</p>
        )}
      </div>
    </div>
  );
}
