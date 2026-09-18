/** Exposes per-task Git workspace management and the launcher wrapper used by fleet worker construction. */

export { TaskWorkspaceManager, TaskWorkspaceError, removeRecordedTaskWorkspace } from "./manager.js";
export { WorkspaceScopedLauncher } from "./scoped-launcher.js";
