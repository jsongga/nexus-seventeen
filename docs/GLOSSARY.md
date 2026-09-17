# Glossary

One page for the words this system uses inconsistently. It is the source of truth for the naming
work in [roadmap 9.7](../orchestrator-roadmap.md); where a term has more than one sense, the sense
is scoped rather than renamed, because the values are persisted in SQL `CHECK` constraints.

Read this before adding a term. Most confusion here is one word meaning two things, not two words
meaning one.

## The core nouns

| Term          | What it is                                                                                     | Where it lives                |
| ------------- | ---------------------------------------------------------------------------------------------- | ----------------------------- |
| **Request**   | What a human files. The user-facing word for a work item.                                      | UI copy only                  |
| **Work item** | The record a Request becomes. Has a state machine, can be decomposed into children.            | `WorkItem`, `work_items`      |
| **Task**      | One unit of agent execution inside a work item's workflow. **Not** a Request.                  | `BoardTask`, `tasks`          |
| **Agent**     | A durable identity on the board that work is routed to. Belongs to a project and a repository. | `AgentProfile`, `agents`      |
| **Worker**    | A process that authenticates _as_ an agent and runs a model. Holds one checkout.               | `task-worker/`, `task-fleet/` |
| **Lane**      | One worker's slot in the fleet — its config entry, its state file, its serial execution.       | `fleet.json` `agents[]`       |
| **Run**       | One model invocation for one task, by one agent.                                               | `AgentRun`, `runs`            |

**Request vs Work item is the one that used to be wrong.** The UI called a work item a "task",
while the board's own `BoardTask` is a different record entirely. The UI says Request; code says
`WorkItem`; `task` means only `BoardTask`.

**Agent vs Worker vs Lane.** The board knows agents; the fleet runs workers; a lane is the
configuration and serialization around one worker. A claim names an agent, never a worker — which
is why an agent carries the repository (roadmap 17) rather than the worker declaring it.

## Project, repository, workspace

| Term           | What it is                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------- |
| **Project**    | Groups a product's work: its threads, agents and automation. Owns one or more repositories.   |
| **Repository** | A working tree on disk. A work item resolves to exactly one. `repositories`, `repository_id`. |
| **Workspace**  | A scratch checkout created _for one task_, cloned from a repository and disposed after.       |

A repository is durable and shared; a workspace is per-task and disposable. `repoPath` on a
project is a compatibility mirror of its **primary** repository's path, kept so a pre-v27 worker
still resolves a checkout.

## Stage — three scopes, deliberately

Three different vocabularies use the word. They are scoped by type, not renamed, because each set
is compiled into a SQL `CHECK`.

| Type            | Values                                                                                                                      | Means                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `NodeStage`     | research · planning · implementation · testing · verification                                                               | a **workflow node's** stage        |
| `WorkItemStage` | refinement · project_resolution · research · planning · implementation · testing · verification · human_review · deployment | a **work item's** position overall |
| `PhaseStep`     | research · planning · execution · testing · review · done                                                                   | a **task phase's** step            |

They overlap without matching: `implementation` is a `NodeStage` and a `WorkItemStage` but not
a `PhaseStep`, which calls it `execution`. **Always name the scope** when a parameter or a
label says "stage".

## Phase — two senses

| Sense           | Values                      | Means                                                  |
| --------------- | --------------------------- | ------------------------------------------------------ |
| `WorkItemPhase` | expand · migrate · contract | a **decomposition** phase: the order children merge in |
| Task phase      | a `PhaseStep` sequence      | steps within one task                                  |

The decomposition sense is the load-bearing one — it encodes the expand/migrate/contract rollout
that lets children in different repositories merge independently.

## Runtime, provider, launch mode

| Term                           | Sense                                          | Note                                                                           |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| **Runtime**                    | which model CLI runs (`codex`, `claude`)       | the operator-facing word                                                       |
| **Launch mode**                | local process vs container                     | was also called `runtime` in fleet config — a real collision                   |
| **Provider** (interface sense) | the _upstream_ side of a cross-repo dependency | **correct as-is** — `decomposition-readiness.ts`, `CrossRepoContext.provider*` |

The interface sense is not a mistake and needs no rename: a provider publishes an interface that a
consumer migrates onto. It is unrelated to model runtimes, and the pairing with **consumer** makes
it unambiguous in context.

`runtime` also appears in `build:runtime`, `tsconfig.runtime.json` and the Dockerfile stage. That
is the standard Node sense — compiled server output — and never sits next to the model sense.

## Ending a work item

Three distinct endings, often conflated in copy:

| Term            | Means                                                     | Reversible      |
| --------------- | --------------------------------------------------------- | --------------- |
| **Parked**      | paused pending something — an open question, a failed run | yes, it resumes |
| **Abandoned**   | deliberately stopped by a human                           | no              |
| **Dead letter** | stopped by the system after exhausting its options        | no              |

Parked is **not** terminal; `WORK_ITEM_TERMINAL_STATES` is `merged`, `abandoned`, `dead_letter`.
A park has a category (`PARK_CATEGORIES`) naming what it waits on.

## Terms to avoid

- **"Thread"** — used in copy for a work item's conversation, but nothing is named `thread`. Say
  Request, or the specific record.
- **"Intake"** as a noun — the act of filing a Request. As a bare noun it reads like a record type
  and there is no such record. `onboarding` is a distinct, real work-item task type.
