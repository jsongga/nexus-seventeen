import type {
  ManagerCredential,
  ManagerHandoffRegistrar,
  ManagerReviewPermitConsumer,
  ManagerRuntimeAuthorizer,
} from "./types.js";

export interface ManagerReviewServiceOptions {
  readonly workspaceId: string;
  readonly storePath: string;
  readonly evidenceIssuerToken: string;
  readonly evidenceIssuerPrincipal: string;
  readonly humanToken: string;
  readonly managers: readonly ManagerCredential[];
  readonly handoffRegistrar: ManagerHandoffRegistrar;
  readonly managerRuntimeAuthorizer: ManagerRuntimeAuthorizer;
  readonly managerReviewPermitConsumer: ManagerReviewPermitConsumer;
  readonly corsOrigins?: readonly string[];
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly handoffRetryMs?: number;
  readonly now?: () => Date;
}

export interface ManagerReviewServiceConfig {
  readonly workspaceId: string;
  readonly storePath: string;
  readonly evidenceIssuerToken: string;
  readonly evidenceIssuerPrincipal: string;
  readonly humanToken: string;
  readonly managers: readonly ManagerCredential[];
  readonly handoffRegistrar: ManagerHandoffRegistrar;
  readonly managerRuntimeAuthorizer: ManagerRuntimeAuthorizer;
  readonly managerReviewPermitConsumer: ManagerReviewPermitConsumer;
  readonly corsOrigins: ReadonlySet<string>;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly handoffRetryMs: number;
  readonly now: (() => Date) | undefined;
}
