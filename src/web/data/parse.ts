/** The browser's wire-record vocabulary and the parsers that produce it. Each concern lives in its own module; this is the door. */

/* —— Pass-through —— */

// Declared elsewhere; re-exported here because callers have always taken
// them from this door.
export { maximumWorkItemCursorBytes } from "./wire";
export type { JsonRecord } from "@shared/task-board-contract/validate";

/* —— Modules —— */

export {
  automationAgentTypeWire,
  automationStageWire,
  parseAutomationAgentType,
  parseAutomationConfiguration,
  parseAutomationExecutor,
  parseAutomationStage,
  validateAutomationParts,
  validateAutomationPayloadSize,
} from "./parse/automation";
export {
  parseAgent,
  parseBoardNotification,
  parseBoardPause,
  parseChildWorkItem,
  parseDeployAttestationResult,
  parseDesignRecord,
  parseEvent,
  parseFindingsLedger,
  parseGateAction,
  parseInterrupt,
  parseMessage,
  parseParkRecord,
  parseParksLedger,
  parseProject,
  parseQuestion,
  parseReviewFinding,
  parseRun,
  parseTask,
  parseWorkItem,
  parseWorkItemAudit,
  parseWorkItemDependency,
  parseWorkItemDetail,
} from "./parse/entities";
export {
  array,
  boolean,
  boundedText,
  exactRecord,
  integer,
  member,
  nullableString,
  record,
  skillIdentifier,
  string,
  timestamp,
} from "./parse/scalars";
export {
  maximumRawWorkItems,
  maximumTaskMessages,
  maximumWorkItemPages,
  type RawBoard,
  type RawBoardNotification,
  type RawBoardPause,
  type RawChildWorkItem,
  type RawEvent,
  type RawFindingsLedger,
  type RawMessage,
  type RawParksLedger,
  type RawProject,
  type RawRun,
  type RawTask,
  type RawWorkItem,
  type RawWorkItemAudit,
  type RawWorkItemDetail,
} from "./parse/types";
export {
  parsePipelineSummary,
  parseProjectArtifact,
  parseProjectWorkflow,
  parseRawBoard,
  parseWorkflowEvent,
} from "./parse/workflow";
