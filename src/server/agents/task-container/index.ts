/** Exposes the container launch mode to task-fleet/worker-factory.ts as one package boundary. */

export { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "./image-tag.js";
export { buildContainerRunPlan } from "./run-plan.js";
export { ContainerAgentLauncher } from "./container-launcher.js";
export {
  assertDockerAvailable,
  ContainerInfrastructureError,
  DEFAULT_ALLOWED_HOSTS,
  ensureNetwork,
  prepareContainerInfrastructure,
} from "./infrastructure.js";
export type { ContainerInfrastructure, ContainerInfrastructureOptions } from "./infrastructure.js";
