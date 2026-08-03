export const RETIRED_WAKEUP_EVENT_PREFIX = "retired-wakeup:";

export function retiredWakeupEventId(wakeupId: string): string {
  return RETIRED_WAKEUP_EVENT_PREFIX + wakeupId;
}
