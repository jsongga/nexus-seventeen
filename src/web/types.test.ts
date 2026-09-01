import { describe, expect, it } from "vitest";
import { automationStageAllowedRoles, workItemStageValues } from "./data/wire";
import { AUTOMATION_STAGE_ALLOWED_ROLES, AUTOMATION_STAGE_ORDER } from "./types";

describe("automation stage policy", () => {
  it("exposes the shared contract objects by construction", () => {
    expect(AUTOMATION_STAGE_ALLOWED_ROLES).toBe(automationStageAllowedRoles);
    expect(AUTOMATION_STAGE_ORDER).toBe(workItemStageValues);
    expect(Object.isFrozen(AUTOMATION_STAGE_ALLOWED_ROLES)).toBe(true);
    for (const roles of Object.values(AUTOMATION_STAGE_ALLOWED_ROLES)) expect(Object.isFrozen(roles)).toBe(true);
  });
});
