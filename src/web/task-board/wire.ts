/**
 * The web app's single doorway to the shared task-board contract.
 *
 * Only this file imports `@shared/*`. Everything else in src/web imports from
 * here, which keeps two hazards in one place:
 *
 *  1. Wire types collide by name with the view types in ./types.ts —
 *     TaskStatus, AgentStatus and RunStatus mean different things on each
 *     side. Wire versions are re-exported with a `Wire` prefix.
 *  2. Two names differ across the boundary: the contract calls them
 *     WakeupReason and AgentTypeEvaluatorProfile; the web calls them
 *     WakeReason and AutomationEvaluatorProfile.
 */
import {
  AUTOMATION_CONFIGURATION_MAX_BYTES,
  TASK_BOARD_API_VERSION,
  WORK_ITEM_PAGE_SIZE,
} from '@shared/task-board-contract';

export const apiVersion = TASK_BOARD_API_VERSION;
export const maximumAutomationConfigurationBytes = AUTOMATION_CONFIGURATION_MAX_BYTES;
export const workItemPageSize = WORK_ITEM_PAGE_SIZE;
