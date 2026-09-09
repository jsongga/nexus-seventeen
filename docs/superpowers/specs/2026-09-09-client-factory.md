# The task-board client factory (campaign 15)

**Status** Draft · **Author** Claude (controller) · **Date** 2026-09-09 · **Scope**
`src/web/data/client.ts`.

## What this is about

Every call the web app makes to the board goes through one object built by
`createTaskBoardClient`. It exposes 48 methods, and each one closes over the same private state: a
shared `request` helper and **five mutable `Map`s** that cache what the board has already told us —
an agent's role, a question's version, which agent owns a task, a task's kind and required role,
which agent owns a run.

Those caches are not decoration. They let a mutation send the right version or role without a
second round trip, so losing one does not fail loudly — it sends a stale value, or an extra
request, or the wrong role.

`client.ts` is **877 lines**; the factory is the large majority of them.

## Why campaign 13 stopped here

Campaign 13 took what was mechanical — agent-query prompts, response envelopes — and left the
factory alone, because splitting it means giving the methods an **explicit context** instead of a
closure. The roadmap states the hazard exactly:

> a mistake produces two contexts where there was one and breaks caching invisibly rather than
> failing to compile.

That is the whole difficulty. A closure guarantees one instance of each `Map` per client. An
explicit context only guarantees it if every module receives the _same_ object — and building a
second one typechecks perfectly.

## The change in one sentence

The five caches and the request helper become one context object, passed to method groups that
live in their own modules.

## Model

```ts
interface TaskBoardClientContext {
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  readonly agentRoles: Map<string, AgentRole>;
  readonly questionVersions: Map<string, number>;
  readonly taskAgents: Map<string, string>;
  readonly taskPolicies: Map<string, Readonly<{ kind: TaskKind; requiredRole: AgentRole | null }>>;
  readonly runAgents: Map<string, string>;
}
```

`createTaskBoardClient` builds **exactly one** of these and hands the same reference to every
group. The groups divide by resource — board, work items, agents, tasks, projects, automation —
matching how `client.ts`'s interface already reads.

## The invariant, and how it is enforced

**One context per client.** This cannot be left to review, because the failure is silent:

- the context is created in exactly one place, and no module may construct one;
- a test proves cache sharing across group boundaries — populate a cache through one group's
  method, read it through another's, and assert the second saw the first. That test fails if two
  contexts exist, and it is the only thing that does.

A type alone does not catch this. `TaskBoardClientContext` is structurally satisfied by a fresh
object with fresh `Map`s.

## What this does not do

- **No behaviour change**, and no change to the 48-method public interface.
- **No cache-strategy change.** Same maps, same lifetimes, same eviction (none).
- **No request-layer change.** `request` moves by reference, it is not rewritten.

## Recommendation

- **do-X — the context object and the resource groups**, with the cross-group cache test.
- **+Y — a shared-map guard**: freeze the context and assert group modules never reassign it.
- **+Z — narrow each group's context** to the maps it actually uses.

**Recommended: X only.** Z is tempting and wrong here: narrowing the type per group makes it
_easier_ to construct a satisfying object locally, which is the exact failure mode. One wide
context that is obviously meant to be passed, not built, is safer than five precise ones.

**Exit:** `client.ts` under 600 lines; a test proves a cache written through one group is read
through another; `test:all` and Playwright green.

## Alternatives considered

**A class with private fields.** Genuinely solves the one-instance problem — `#agentRoles` cannot
be duplicated by accident. Rejected because it changes the public shape from a plain object to an
instance, and 48 call sites plus every test fixture treat the client as a structural type.
Worth revisiting if a second cache bug appears.

**Leave it at 877 lines.** Defensible: it works, it is one file, and the caches are safe precisely
because they are closed over. The ratchet now stops it growing. This is the option to take if the
cross-group cache test proves awkward to write — the test is the point, and a split without it is
worse than no split.
