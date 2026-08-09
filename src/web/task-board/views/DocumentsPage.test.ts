import { describe, expect, it } from 'vitest';
import { documentsByUpdatedAt } from './DocumentsPage';

describe('documentsByUpdatedAt', () => {
  it('orders mixed-offset document timestamps by absolute instant', () => {
    const earlierOffset = '2026-07-19T12:00:00+02:00';
    const laterFraction = '2026-07-19T10:00:00.500Z';
    const base = {
      projectId: 'project-one',
      contentType: 'text/markdown' as const,
      contentVersion: 1,
      penEpoch: 0,
      penHolder: null,
      createdAt: earlierOffset,
      createdAtMs: Date.parse(earlierOffset),
    };
    const documents = [
      { ...base, id: 'earlier', title: 'Earlier', sequence: 1, updatedAt: earlierOffset, updatedAtMs: Date.parse(earlierOffset) },
      { ...base, id: 'later', title: 'Later', sequence: 2, updatedAt: laterFraction, updatedAtMs: Date.parse(laterFraction) },
    ];

    expect(documentsByUpdatedAt(documents).map((document) => document.id)).toEqual(['later', 'earlier']);
  });
});
