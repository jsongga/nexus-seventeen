import type { AgentLauncher, AgentLaunchRequest, AgentRunHandle, AgentRunOutcome } from "#server/agents/task-worker/types";
import { TaskWorkspaceError } from "./manager.js";
import type { TaskWorkspaceManager } from "./manager.js";

export class WorkspaceScopedLauncher implements AgentLauncher {
  readonly #inner: AgentLauncher;
  readonly #manager: TaskWorkspaceManager;

  constructor(inner: AgentLauncher, manager: TaskWorkspaceManager) {
    this.#inner = inner;
    this.#manager = manager;
  }

  async launch(request: AgentLaunchRequest): Promise<AgentRunHandle> {
    const key = request.context.workflow?.workspaceKey ?? request.context.taskId;
    const path = await this.#manager.create(key);
    let handle: AgentRunHandle;
    try {
      handle = await this.#inner.launch({ ...request, workspace: { path } });
    } catch (error) {
      await this.#manager.retain(key);
      throw error;
    }
    const completion = handle.completion.then(
      async (outcome: AgentRunOutcome) => {
        if (outcome.status === "completed") {
          try {
            await this.#manager.harvest(key);
          } catch (error) {
            await this.#manager.retain(key);
            throw new TaskWorkspaceError("Run completed but its branch could not be harvested", { cause: error });
          }
          let hasUncommittedChanges: boolean;
          try {
            hasUncommittedChanges = await this.#manager.hasUncommittedChanges(key);
          } catch (error) {
            await this.#manager.retain(key);
            throw new TaskWorkspaceError(
              "Run completed but its workspace cleanliness could not be verified",
              { cause: error },
            );
          }
          if (hasUncommittedChanges) await this.#manager.retain(key);
          else await this.#manager.remove(key);
        } else {
          await this.#manager.retain(key);
        }
        return outcome;
      },
      async (error: unknown) => {
        await this.#manager.retain(key);
        throw error;
      },
    );
    return Object.freeze({ completion, activity: handle.activity, interrupt: (reason: string) => handle.interrupt(reason) });
  }
}
