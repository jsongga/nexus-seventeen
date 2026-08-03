import { describe, expect, it } from 'vitest';
import { completionPercent } from './project-metrics';

describe('completionPercent', () => {
  it('is zero when there are no tasks, rather than dividing by zero', () => {
    expect(completionPercent([])).toBe(0);
  });

  it('rounds to the nearest whole percent', () => {
    const tasks = [
      { status: 'completed' }, { status: 'completed' }, { status: 'running' },
    ] as Parameters<typeof completionPercent>[0];
    expect(completionPercent(tasks)).toBe(67);
  });
});
