import type { AutomationConfiguration } from '../types';

export interface ClientOperationToken<T extends object> {
  readonly client: T;
  readonly generation: number;
}

/** Rejects async completions after a newer operation, client swap, or unmount. */
export class ClientOperationGate<T extends object> {
  private client: T;
  private generation = 0;
  private active = true;

  constructor(client: T) {
    this.client = client;
  }

  setClient(client: T): void {
    if (this.client === client) return;
    this.client = client;
    this.generation += 1;
  }

  activate(client: T): void {
    this.setClient(client);
    this.active = true;
    this.generation += 1;
  }

  begin(): ClientOperationToken<T> {
    this.generation += 1;
    return { client: this.client, generation: this.generation };
  }

  isCurrent(token: ClientOperationToken<T>): boolean {
    return this.active && token.client === this.client && token.generation === this.generation;
  }

  isActiveFor(client: T): boolean {
    return this.active && client === this.client;
  }

  deactivate(): void {
    this.active = false;
    this.generation += 1;
  }
}

export interface AutomationEditorState {
  saved: AutomationConfiguration | null;
  draft: AutomationConfiguration | null;
  /** Latest incompatible remote version observed while preserving a dirty draft. */
  remote: AutomationConfiguration | null;
}

export function emptyAutomationEditorState(): AutomationEditorState {
  return { saved: null, draft: null, remote: null };
}

export function cloneAutomationConfiguration(configuration: AutomationConfiguration): AutomationConfiguration {
  return {
    ...configuration,
    agentTypes: configuration.agentTypes.map((agentType) => ({
      ...agentType,
      skillIds: [...agentType.skillIds],
    })),
    stages: configuration.stages.map((entry) => ({
      stage: entry.stage,
      executor: { ...entry.executor },
    })),
  };
}

export function automationEditablePayload(configuration: AutomationConfiguration): string {
  return JSON.stringify({
    agentTypes: configuration.agentTypes,
    stages: configuration.stages,
  });
}

export function automationEditorIsDirty(state: AutomationEditorState): boolean {
  return state.saved !== null
    && state.draft !== null
    && automationEditablePayload(state.saved) !== automationEditablePayload(state.draft);
}

export function automationEditorFromConfiguration(configuration: AutomationConfiguration): AutomationEditorState {
  return {
    saved: configuration,
    draft: cloneAutomationConfiguration(configuration),
    remote: null,
  };
}

/**
 * Reconciles an on-demand or reconnect read without replacing a local draft.
 * A newer remote value is retained separately until the human explicitly reloads it.
 */
export function reconcileAutomationConfiguration(
  current: AutomationEditorState,
  remote: AutomationConfiguration,
): AutomationEditorState {
  if (current.saved === null || current.draft === null || !automationEditorIsDirty(current)) {
    return automationEditorFromConfiguration(remote);
  }
  if (remote.version === current.saved.version) return current;
  return { ...current, remote: cloneAutomationConfiguration(remote) };
}

export function acceptRemoteAutomationConfiguration(current: AutomationEditorState): AutomationEditorState {
  return current.remote === null ? current : automationEditorFromConfiguration(current.remote);
}

export function discardAutomationDraft(current: AutomationEditorState): AutomationEditorState {
  if (current.remote !== null) return automationEditorFromConfiguration(current.remote);
  if (current.saved === null) return current;
  return { ...current, draft: cloneAutomationConfiguration(current.saved) };
}
