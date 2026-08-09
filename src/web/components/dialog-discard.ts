export type DialogDismissalDecision = 'close' | 'confirm';

export function fieldsAreDirty(values: readonly string[]): boolean {
  return values.some((value) => value.length > 0);
}

/** Evaluates lazily so a dialog always protects the text visible at dismissal time. */
export function dialogDismissalDecision(isDirty?: () => boolean): DialogDismissalDecision {
  return isDirty?.() ? 'confirm' : 'close';
}
