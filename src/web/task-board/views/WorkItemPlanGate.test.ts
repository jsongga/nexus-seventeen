import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DetailedWorkflowPlan } from '../model/work-item-detail';
import { PlanApprovalActions, PlanRecordDetails, PlanRejectionForm } from './WorkItemDetail';

const timestamp = '2026-08-19T12:00:00.000Z';

function plan(tier: 'standard' | 'hazardous' = 'standard'): DetailedWorkflowPlan {
  return {
    planRevisionId: 'plan-one',
    workItemId: 'work-item-one',
    revision: 1,
    objective: 'Implement and verify the bounded pipeline change.',
    assumptions: ['The current contract remains compatible.'],
    acceptanceCriteria: ['The new loop is covered end to end.'],
    changeShape: 'feature',
    tier,
    declaredScope: ['src/server/task-board', 'src/web/task-board'],
    nonGoals: ['Do not add the Design stage in this campaign.'],
    mechanicalPortions: ['Add the reject request parser.'],
    blockingQuestions: [{
      question: 'Should the previous planning task remain durable?',
      recommendedDefault: 'Yes, keep it as immutable history.',
    }],
    criterionChecks: [{
      criterion: 'The plan can be revised once.',
      check: 'Run the plan revision integration test.',
    }],
    state: 'proposed',
    createdAt: timestamp,
    createdAtMs: Date.parse(timestamp),
    confirmedAt: null,
    confirmedAtMs: null,
  };
}

describe('plan approval record and controls', () => {
  it('renders every optional plan-record section and its badges', () => {
    const markup = renderToStaticMarkup(createElement(PlanRecordDetails, { plan: plan() }));

    for (const text of [
      'Feature',
      'Standard',
      'Declared scope',
      'src/server/task-board',
      'Non-goals',
      'Do not add the Design stage in this campaign.',
      'Mechanical portions',
      'Add the reject request parser.',
      'Blocking questions',
      'Should the previous planning task remain durable?',
      'Recommended default',
      'Yes, keep it as immutable history.',
      'Criterion checks',
      'The plan can be revised once.',
      'Run the plan revision integration test.',
    ]) expect(markup).toContain(text);
  });

  it('keeps reject and confirm separate and warns that hazardous confirm parks', () => {
    const markup = renderToStaticMarkup(createElement(PlanApprovalActions, {
      plan: plan('hazardous'),
      busy: false,
      confirmEnabled: true,
      rejectEnabled: true,
      onConfirm: vi.fn(),
      onReject: vi.fn(),
    }));

    expect(markup).toContain('Hazardous plans park at confirmation');
    expect(markup).toContain('Confirm plan');
    expect(markup).toContain('Reject plan');
    expect(markup).not.toContain('Cancel work item');
  });

  it('renders a bounded revision-note form with revision rather than cancellation copy', () => {
    const markup = renderToStaticMarkup(createElement(PlanRejectionForm, {
      workItemId: 'work-item-one',
      note: '',
      busy: false,
      errors: [],
      onNoteChange: vi.fn(),
      onDismissError: vi.fn(),
      onSubmit: vi.fn(),
      onKeep: vi.fn(),
    }));

    expect(markup).toContain('Revision note');
    expect(markup).toContain('maxLength="2000"');
    expect(markup).toContain('Reject and revise');
    expect(markup).toContain('Keep proposed plan');
    expect(markup).not.toContain('Reject and cancel');
  });
});
