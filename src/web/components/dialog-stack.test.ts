import { describe, expect, it, vi } from 'vitest';
import {
  dialogDismissalDecision,
  dialogLayersLockScroll,
  dialogSwitchWasHandledForLayer,
  deferDialogOutsideDismissal,
  fieldsAreDirty,
  markDialogSwitchEvent,
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

  it('marks only the click event whose trigger already routed a dialog action', () => {
    const handled = new Event('click');
    const unrelated = new Event('click');

    expect(dialogSwitchWasHandledForLayer(handled, 'create-dialog')).toBe(false);
    markDialogSwitchEvent(handled, 'create-dialog');
    expect(dialogSwitchWasHandledForLayer(handled, 'create-dialog')).toBe(true);
    expect(dialogSwitchWasHandledForLayer(handled, 'dialog-merge')).toBe(false);
    expect(dialogSwitchWasHandledForLayer(unrelated, 'create-dialog')).toBe(false);
  });

  it('defers outside dismissal until a trigger handler can mark its owning layer', async () => {
    const createDialogClick = new Event('click');
    const unrelatedDialogClick = new Event('click');
    const dismiss = vi.fn();

    deferDialogOutsideDismissal(createDialogClick, 'create-dialog', dismiss);
    markDialogSwitchEvent(createDialogClick, 'create-dialog');
    deferDialogOutsideDismissal(unrelatedDialogClick, 'dialog-merge', dismiss);
    markDialogSwitchEvent(unrelatedDialogClick, 'create-dialog');
    await Promise.resolve();

    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
