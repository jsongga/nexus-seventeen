/** Renders one agent's chat-first page. */

/* —— Imports —— */

import { KeyRound, MessageSquareText, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, InlineActionErrors, Modal, Pill, cn } from "../../components/ui";
import type {
  AgentQueryConversationTurn,
  BoardAgent,
  BoardQuestion,
  BoardSnapshot,
  RotateAgentTokenResult,
} from "../../types";
import { agentPipelineFocus } from "../../model/workspace-model";
import { laneConfigurationState } from "../../model/lane-config";
import { actionErrorContexts, type ActionError, type ActionResult } from "../../model/action-errors";
import { agentChatHistory, agentChatTasks, formatTime, latestByAskedAt, latestByUpdatedAt } from "./agent-chat";

interface AgentPageProps {
  agent: BoardAgent;
  snapshot: BoardSnapshot;
  isPointOfContact: boolean;
  explicitPointOfContact: boolean;
  busy: boolean;
  rotationErrors: readonly ActionError[];
  onDismissActionError: (context: string) => void;
  onTask: (taskId: string) => void;
  onSend: (
    prompt: string,
    workspaceRefs: string[],
    routingContext?: string,
    recentConversation?: AgentQueryConversationTurn[]
  ) => Promise<ActionResult>;
  onAnswer: (questionId: string, answer: string) => Promise<ActionResult>;
  onRotateToken: () => Promise<RotateAgentTokenResult | null>;
}

export function agentPageUsesPointOfContactMode(isPointOfContact: boolean, explicitPointOfContact: boolean): boolean {
  return isPointOfContact && explicitPointOfContact;
}

function AgentChat({
  agent,
  snapshot,
  isPointOfContact,
  busy,
  onTask,
  onSend,
  onAnswer,
  onRotateToken,
  rotationErrors,
  onDismissActionError,
}: Pick<
  AgentPageProps,
  | "agent"
  | "snapshot"
  | "isPointOfContact"
  | "busy"
  | "onTask"
  | "onSend"
  | "onAnswer"
  | "onRotateToken"
  | "rotationErrors"
  | "onDismissActionError"
>) {
  const [draft, setDraft] = useState("");
  const [visibleLaneToken, setVisibleLaneToken] = useState<string | null>(null);
  const [confirmRotation, setConfirmRotation] = useState(false);
  const [rotating, setRotating] = useState(false);
  const rotationContext = actionErrorContexts.agentRotateToken(agent.id);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const rotationAnchorRef = useRef<HTMLButtonElement>(null);
  const history = useMemo(
    () => agentChatHistory(agent, snapshot, isPointOfContact),
    [agent, isPointOfContact, snapshot]
  );
  const focus = useMemo(() => agentPipelineFocus(agent, snapshot.tasks), [agent, snapshot.tasks]);
  const recentConversation = useMemo(
    () =>
      history.flatMap((entry): AgentQueryConversationTurn[] =>
        entry.contextRole === null ? [] : [{ role: entry.contextRole, body: entry.body }]
      ),
    [history]
  );
  const laneConfiguration = useMemo(() => laneConfigurationState(agent, visibleLaneToken), [agent, visibleLaneToken]);
  const currentOpenQuestion = useMemo(() => {
    const chatTasks = agentChatTasks(agent, snapshot, isPointOfContact);
    const currentQuery =
      chatTasks.find((task) => task.id === agent.currentTaskId) ??
      latestByUpdatedAt(
        chatTasks.filter(
          (task) =>
            task.status === "waiting_for_human" ||
            task.status === "running" ||
            task.status === "blocked" ||
            task.status === "queued"
        )
      );
    if (!currentQuery) return null;
    return (
      latestByAskedAt(
        snapshot.questions.filter(
          (question): question is BoardQuestion => question.taskId === currentQuery.id && question.status === "open"
        )
      ) ?? null
    );
  }, [agent, isPointOfContact, snapshot]);
  const routingMap = useMemo(
    () =>
      !isPointOfContact
        ? ""
        : snapshot.projects
            .slice(0, 20)
            .map((project) => {
              const owners = snapshot.agents
                .filter((owner) => owner.projectId === project.id)
                .slice(0, 8)
                .map((owner) => `${owner.name} (${owner.role}, ${owner.area})`)
                .join(", ");
              return `- ${project.name}: ${owners || "no agents yet"}`;
            })
            .join("\n")
            .slice(0, 2_000),
    [isPointOfContact, snapshot.agents, snapshot.projects]
  );

  useEffect(() => {
    historyEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [history.length]);

  async function send() {
    const prompt = draft.trim();
    if (!prompt) return;
    const sent = currentOpenQuestion
      ? await onAnswer(currentOpenQuestion.id, prompt)
      : await onSend(
          prompt,
          isPointOfContact ? [] : (focus.task?.workspaceRefs ?? []),
          routingMap || undefined,
          recentConversation
        );
    if (sent.ok) setDraft("");
  }

  async function rotateToken() {
    setRotating(true);
    const rotated = await onRotateToken();
    if (rotated !== null) {
      setVisibleLaneToken(rotated.token);
      closeRotationDialog();
    }
    setRotating(false);
  }

  function openRotationDialog() {
    onDismissActionError(rotationContext);
    setConfirmRotation(true);
  }

  function closeRotationDialog() {
    onDismissActionError(rotationContext);
    setConfirmRotation(false);
  }

  return (
    <>
      <main className="h-[calc(100dvh-4rem)] overflow-hidden bg-canvas lg:h-dvh">
        <section
          aria-labelledby="agent-chat-heading"
          className="mx-auto flex h-full w-full max-w-4xl flex-col px-4 sm:px-8 lg:px-10"
        >
          {isPointOfContact ? (
            <header className="shrink-0 border-b border-line py-4 sm:py-5 lg:py-7">
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Point of contact</p>
              <h1
                id="agent-chat-heading"
                data-page-heading
                tabIndex={-1}
                className="mt-1.5 font-display text-2xl font-light tracking-[0.01em] text-ink sm:text-[28px]"
              >
                Chat with {agent.name}
              </h1>
            </header>
          ) : (
            <header
              aria-label={`${agent.name} current focus`}
              className="shrink-0 border-b border-line py-4 sm:py-5 lg:py-6"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
                <div className="min-w-0">
                  <h1
                    id="agent-chat-heading"
                    data-page-heading
                    tabIndex={-1}
                    className="font-display text-xl font-light tracking-[0.01em] text-ink sm:text-2xl"
                  >
                    {agent.name}
                  </h1>
                  <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Current focus</p>
                  {focus.task ? (
                    <button
                      type="button"
                      className="mt-1 max-w-full rounded-[8px] text-left text-sm font-medium leading-5 text-ink underline decoration-transparent underline-offset-4 transition-[color,text-decoration-color,transform] duration-150 ease-out hover:text-teal-700 hover:decoration-current motion-safe:active:scale-[0.99]"
                      onClick={() => onTask(focus.task!.id)}
                    >
                      {focus.task.title}
                    </button>
                  ) : (
                    <p className="mt-1 text-sm leading-5 text-muted">No current task</p>
                  )}
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-1.5 sm:justify-end">
                  {focus.stage ? (
                    <Pill tone={focus.stage === "Reviewing" ? "amber" : "green"} dot>
                      {focus.stage}
                    </Pill>
                  ) : null}
                  <Pill className="max-w-full" tone="neutral">
                    <span className="block max-w-[18rem] truncate">
                      {focus.phase
                        ? `Phase · ${focus.phase.title}`
                        : focus.task
                          ? "Phase not reported"
                          : "No active phase"}
                    </span>
                  </Pill>
                  {focus.loop ? <Pill tone="blue">Loop {focus.loop}</Pill> : null}
                </div>
              </div>
            </header>
          )}

          <section aria-labelledby="lane-configuration-heading" className="shrink-0 border-b border-line py-4 sm:py-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <KeyRound size={15} strokeWidth={1.6} aria-hidden="true" />
                  <h2 id="lane-configuration-heading" className="text-sm font-medium text-ink">
                    Lane configuration
                  </h2>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Paste this agent object into the fleet config’s <code>agents</code> array and replace the
                  working-directory and provider placeholders.
                </p>
              </div>
              <Button
                ref={rotationAnchorRef}
                className="shrink-0"
                size="sm"
                disabled={busy || rotating}
                onClick={openRotationDialog}
              >
                {rotating ? "Rotating…" : laneConfiguration.tokenVisible ? "Rotate again" : "Rotate token"}
              </Button>
            </div>
            <pre
              aria-label={`Fleet lane configuration for ${agent.name}`}
              className="mt-3 max-h-48 overflow-auto rounded-xl border border-line bg-muted-surface p-3 font-mono text-[11px] leading-5 text-ink"
            >
              {laneConfiguration.snippet}
            </pre>
            <p
              className="mt-2 text-[11px] leading-4 text-muted"
              role={laneConfiguration.tokenVisible ? "status" : undefined}
            >
              {laneConfiguration.tokenVisible
                ? "Token visible for this page session only. It will be masked after you leave or reload."
                : "No token is stored in the board snapshot. Rotate it to reveal a new value once."}
            </p>
          </section>

          <div
            role="log"
            aria-label={`Chat history with ${agent.name}`}
            aria-live="polite"
            aria-relevant="additions"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-5 sm:py-7"
          >
            {history.length > 0 ? (
              <ol className="space-y-4">
                {history.map((entry) => (
                  <li
                    key={entry.id}
                    className={cn(
                      "flex",
                      entry.sender === "human"
                        ? "justify-end"
                        : entry.sender === "system"
                          ? "justify-center"
                          : "justify-start"
                    )}
                  >
                    <article
                      className={cn(
                        "max-w-[88%] rounded-[18px] px-4 py-3 text-sm leading-6 shadow-none sm:max-w-[76%]",
                        entry.sender === "human"
                          ? "rounded-br-[6px] bg-taupe text-white"
                          : entry.sender === "system"
                            ? "bg-muted-surface text-muted"
                            : "rounded-bl-[6px] border border-line bg-muted-surface text-ink"
                      )}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[10px] leading-4 opacity-70">
                        <span className="font-medium">{entry.author}</span>
                        <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
                      </div>
                      <p className="whitespace-pre-wrap break-words">{entry.body}</p>
                    </article>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="flex h-full min-h-44 flex-col items-center justify-center text-center text-muted">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted-surface">
                  <MessageSquareText size={17} strokeWidth={1.5} />
                </span>
                <p className="mt-3 text-sm">No messages yet.</p>
              </div>
            )}
            <div ref={historyEndRef} aria-hidden="true" />
          </div>

          <form
            className="shrink-0 border-t border-line bg-canvas py-4 sm:py-5"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label htmlFor={`agent-message-${agent.id}`} className="sr-only">
              Message {agent.name}
            </label>
            <div className="flex items-end gap-2 rounded-[18px] border border-line bg-surface p-2 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-taupe-hover focus-within:shadow-[0_0_0_3px_rgba(213,200,186,.2)]">
              <textarea
                id={`agent-message-${agent.id}`}
                className="min-h-11 max-h-40 flex-1 resize-y bg-transparent px-2 py-2 text-sm leading-6 text-ink outline-none placeholder:text-muted"
                maxLength={8_000}
                placeholder={
                  currentOpenQuestion
                    ? "Reply to the agent’s question…"
                    : isPointOfContact
                      ? "Ask a question or describe what you need…"
                      : `Message ${agent.name}…`
                }
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button
                className="size-11 min-h-0 shrink-0 rounded-full p-0"
                variant="primary"
                type="submit"
                icon={<Send size={16} />}
                aria-label="Send message"
                disabled={busy || draft.trim().length === 0}
              />
            </div>
          </form>
        </section>
      </main>
      <Modal
        open={confirmRotation}
        onClose={closeRotationDialog}
        variant="anchored"
        anchorRef={rotationAnchorRef}
        title="Rotate agent token?"
        description="Rotating immediately disconnects any worker using the current token."
      >
        <div className="space-y-4 p-5 sm:p-6">
          <p className="text-sm leading-6 text-muted">
            The old token will stop authenticating as soon as rotation succeeds. Update the fleet lane with the new
            token before reconnecting it.
          </p>
          <InlineActionErrors errors={rotationErrors} onDismiss={onDismissActionError} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={rotating} onClick={closeRotationDialog}>
              Cancel
            </Button>
            <Button variant="danger" disabled={rotating} onClick={() => void rotateToken()}>
              Rotate token
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function AgentPage(props: AgentPageProps) {
  const pointOfContactMode = agentPageUsesPointOfContactMode(props.isPointOfContact, props.explicitPointOfContact);
  return (
    <AgentChat
      agent={props.agent}
      snapshot={props.snapshot}
      isPointOfContact={pointOfContactMode}
      busy={props.busy}
      rotationErrors={props.rotationErrors}
      onDismissActionError={props.onDismissActionError}
      onTask={props.onTask}
      onSend={props.onSend}
      onAnswer={props.onAnswer}
      onRotateToken={props.onRotateToken}
    />
  );
}
