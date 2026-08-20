import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PipelineSummary } from '@shared/task-board-contract';
import { pipelineFileReview, pipelineAssumptionReview } from '../model/work-item-detail';
import {
  DesignRecordDetails,
  FinalApprovalActions,
  FinalRejectionForm,
  PipelineSummaryDetails,
  ReviewFindingsPanel,
} from './WorkItemDetail';

const summary: PipelineSummary = {
  commits: [{ sha: '0123456789abcdef0123456789abcdef01234567', subject: 'Add the approval view' }],
  diffstat: ' src/web/task-board/views/WorkItemDetail.tsx | 80 +++++++++++++++++',
  filesTouched: [
    'src/web/task-board/views/WorkItemDetail.tsx',
    'docs/unplanned.md',
  ],
  declaredScope: ['src/web/task-board'],
  scopeOk: false,
  assumptions: ['The existing detail card remains the primary review surface.'],
  midRunAssumptions: ['The diffstat can remain plain text in v1.'],
  verify: [{
    verifyAttemptId: 'verify-one',
    nodeId: 'node-one',
    stage: 'testing',
    attempt: 1,
    verifyRunId: 'run-one',
    workspacePath: null,
    state: 'green',
    checkResults: [{ criterion: 'The web suite passes.', check: 'npm run test:web', passed: true }],
    detail: 'Machine verify and criterion checks passed.',
    createdAt: '2026-08-19T12:00:00.000Z',
    endedAt: '2026-08-19T12:01:00.000Z',
  }],
  criteria: ['The operator can distinguish planned and unplanned files.'],
  criterionChecks: [{ criterion: 'The web suite passes.', check: 'npm run test:web' }],
  findings: [{
    findingId: 'finding-round-one',
    nodeId: 'node-one',
    stage: 'verification',
    round: 1,
    file: null,
    line: null,
    category: 'docs',
    severity: 'minor',
    expected: 'The operator notes are present.',
    actual: 'The notes were absent.',
    blocking: false,
    createdAt: '2026-08-19T12:02:00.000Z',
  }, {
    findingId: 'finding-round-two',
    nodeId: 'node-one',
    stage: 'verification',
    round: 2,
    file: 'src/web/task-board/views/WorkItemDetail.tsx',
    line: 321,
    category: 'correctness',
    severity: 'major',
    expected: 'Retries reuse the durable key.',
    actual: 'Retries create a new key.',
    blocking: true,
    createdAt: '2026-08-19T12:03:00.000Z',
  }],
  designRecord: {
    states: ['pending', 'sent', 'committed'],
    transitions: [{
      from: 'pending',
      to: 'sent',
      durablePrecondition: 'requestId is persisted',
      recovery: 'Reuse requestId',
    }],
    failurePoints: [{
      point: 'crash_after_send_before_response',
      resultingState: 'sent',
      recovery: 'Retry with requestId',
    }],
    idempotencyKeys: [{
      name: 'requestId',
      generatedAt: 'Before send',
      persistedAt: 'With pending state',
      reuse: 'Every retry',
    }],
    faultInjectionCases: [{
      name: 'Lost response',
      scenario: 'Crash after send',
      expectation: 'One durable write',
    }],
  },
};

describe('final approval summary and controls', () => {
  it('derives file and assumption review flags from the server summary', () => {
    expect(pipelineFileReview(summary)).toEqual([
      { file: 'src/web/task-board/views/WorkItemDetail.tsx', outsideScope: false },
      { file: 'docs/unplanned.md', outsideScope: true },
    ]);
    expect(pipelineAssumptionReview(summary)).toEqual([
      { assumption: 'The existing detail card remains the primary review surface.', addedMidRun: false },
      { assumption: 'The diffstat can remain plain text in v1.', addedMidRun: true },
    ]);
  });

  it('renders commits, scope violations, assumptions, verify checks, and prose criteria', () => {
    const markup = renderToStaticMarkup(createElement(PipelineSummaryDetails, { summary }));

    for (const text of [
      'Add the approval view',
      '01234567',
      'Work outside the declared scope',
      'docs/unplanned.md',
      'Outside declared scope',
      'The existing detail card remains the primary review surface.',
      'The diffstat can remain plain text in v1.',
      'Added during implementation',
      'Machine verify and criterion checks passed.',
      'The web suite passes.',
      'npm run test:web',
      'Passed',
      'Human-review criteria',
      'The operator can distinguish planned and unplanned files.',
    ]) expect(markup).toContain(text);
  });

  it('renders findings by round and badges blocking findings with category and severity', () => {
    const markup = renderToStaticMarkup(createElement(ReviewFindingsPanel, { findings: summary.findings }));

    for (const text of [
      'Review findings',
      'Round 1',
      'Round 2',
      'The operator notes are present.',
      'Retries create a new key.',
      'Blocking · correctness · major',
      'src/web/task-board/views/WorkItemDetail.tsx:321',
    ]) expect(markup).toContain(text);
  });

  it('renders an explicit empty state when no review findings were recorded', () => {
    const markup = renderToStaticMarkup(createElement(ReviewFindingsPanel, { findings: [] }));

    expect(markup).toContain('No review findings were recorded.');
  });

  it('renders the design record failure-point table and recovery contract', () => {
    const markup = renderToStaticMarkup(createElement(DesignRecordDetails, {
      designRecord: summary.designRecord!,
    }));

    for (const text of [
      'Design record',
      'States',
      'Transitions',
      'Failure points',
      'crash after send before response',
      'Retry with requestId',
      'Idempotency keys',
      'Fault-injection cases',
      'One durable write',
    ]) expect(markup).toContain(text);
    expect(markup).toContain('<table');
  });

  it('omits design record details when the summary has no design record', () => {
    const markup = renderToStaticMarkup(createElement(PipelineSummaryDetails, {
      summary: { ...summary, designRecord: null },
    }));

    expect(markup).not.toContain('Design record');
  });

  it('presents merge as the primary confirmed action and changes as a separate path', () => {
    const markup = renderToStaticMarkup(createElement(FinalApprovalActions, {
      busy: false,
      onApprove: vi.fn(),
      onRequestChanges: vi.fn(),
    }));

    expect(markup).toContain('Approve &amp; merge');
    expect(markup).toContain('Request changes');
    expect(markup).toContain('returns the work item to implementation with conflict details');
    expect(markup).not.toContain('parked');
  });

  it('renders a required bounded change note without cancellation language', () => {
    const markup = renderToStaticMarkup(createElement(FinalRejectionForm, {
      workItemId: 'work-item-one',
      note: '',
      busy: false,
      errors: [],
      onNoteChange: vi.fn(),
      onDismissError: vi.fn(),
      onSubmit: vi.fn(),
      onKeep: vi.fn(),
    }));

    expect(markup).toContain('Change note');
    expect(markup).toContain('maxLength="2000"');
    expect(markup).toContain('Send back to implementation');
    expect(markup).toContain('Keep in final review');
    expect(markup).not.toContain('Cancel work item');
  });
});
