import { describe, expect, it, vi } from 'vitest';
import {
  dialogDismissalDecision,
  dialogLayersLockScroll,
  fieldsAreDirty,
} from './dialog-stack';

describe('dialog discard guard', () => {
  it('checks the current predicate value for every dismissal request', () => {
    const isDirty = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    expect(dialogDismissalDecision(isDirty)).toBe('close');
    expect(dialogDismissalDecision(isDirty)).toBe('confirm');
    expect(isDirty).toHaveBeenCalledTimes(2);
  });

  it('treats any non-empty protected field, including whitespace, as dirty', () => {
    expect(fieldsAreDirty(['', ''])).toBe(false);
    expect(fieldsAreDirty(['', ' '])).toBe(true);
    expect(fieldsAreDirty(['draft', ''])).toBe(true);
  });

  it('locks scrolling only while at least one layer opts in', () => {
    expect(dialogLayersLockScroll([])).toBe(false);
    expect(dialogLayersLockScroll([false])).toBe(false);
    expect(dialogLayersLockScroll([false, true])).toBe(true);
  });
});
