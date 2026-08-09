import { WORK_ITEM_PRIORITIES } from "#shared/task-board-contract";

export function workItemPriorityCases(indentation: string): string {
  return WORK_ITEM_PRIORITIES
    .map((priority, rank) => `WHEN '${priority}' THEN ${rank}`)
    .join(`\n${indentation}`);
}
