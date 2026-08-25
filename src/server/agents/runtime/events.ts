export type RuntimeEvent =
  | { readonly type: "stage_started" }
  | { readonly type: "message_delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly name: string; readonly detail: string }
  | { readonly type: "tool_result"; readonly name: string; readonly output: string; readonly failed?: boolean }
  | { readonly type: "stage_finished" }
  | { readonly type: "error"; readonly detail: string };
