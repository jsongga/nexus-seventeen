/** Decides what an anchored dialog does when its trigger is pressed again. */

/* —— Imports —— */

import { type RefObject } from "react";
import type { BoardPage } from "../routing/routing";
import { type DialogName } from "../views/CreateDialogs";

/* —— Dialog trigger policy —— */

export type DialogOpenOptions = Readonly<{
  anchor?: RefObject<HTMLElement | null>;
  projectId?: string;
}>;

type DialogTriggerState = Readonly<{
  name: Exclude<DialogName, null>;
  anchor: RefObject<HTMLElement | null> | null;
  dirty: boolean;
}>;

type DialogTriggerRequest = Readonly<{
  name: Exclude<DialogName, null>;
  anchor: RefObject<HTMLElement | null> | null;
}>;

export type DialogTriggerAction = "toggle-close" | "re-anchor" | "switch-clean" | "switch-dirty";

export function resolveDialogTriggerAction(
  current: DialogTriggerState,
  requested: DialogTriggerRequest
): DialogTriggerAction {
  if (current.name !== requested.name) {
    return current.dirty ? "switch-dirty" : "switch-clean";
  }
  return current.anchor === requested.anchor ? "toggle-close" : "re-anchor";
}

export type PendingDialogAction =
  | Readonly<{ kind: "open"; name: Exclude<DialogName, null>; options: DialogOpenOptions }>
  | Readonly<{ kind: "navigate"; page: BoardPage; mode: "push" | "replace" }>;
