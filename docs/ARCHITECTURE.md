# Steward Architecture

**Status** — working runtime alpha with explicit production limits · **Author** — Cicada · **Date** — 2026-07-18 · **Scope** — live agent control, durable execution, fixed roles, cheap-first routing, plain-language impact, manager handoff, and human production authorization; excludes the production deployer and hard multi-tenant worker isolation.

## Summary

Steward is a human-led control plane for autonomous software development. People use a responsive web console to queue outcomes, watch exact agent activity, interrupt or pause work, and understand user impact. An engineer can work unattended inside development, but no agent can turn passing tests or manager acceptance into production authority.

The frontend is disposable. A browser renders state and submits human intent; it does not own an agent process, queue, lease, checkpoint, or provider session. Independent supervisors register outbound with the control plane, and a returning browser reconstructs the workspace from one snapshot plus ordered events.

The design separates concepts that are easy to conflate:

- **Queue is not interrupt** — queueing preserves the active task; interrupt is a separate causal stop request.
- **Request is not settlement** — a click records intent; the runtime must confirm its provider process tree is absent before the UI says work stopped.
- **Progress is not proof** — a journal explains movement; diffs, tests, artifacts, and reviews remain evidence.
- **Review is not approval** — a manager may accept evidence and post a human check; only a human may create a production grant.
- **Authorization is not deployment** — the broker emits one exact, one-use authorization; an external idempotent executor owns the later side effect.
- **Role is not model** — role determines authority, while routing independently chooses the cheapest configured model justified by evidence.

## Components and trust boundaries

| Component | Owns | Does not own |
|---|---|---|
| `/live` browser | In-memory human and observer tokens, local replica, command intent | Agent lifetime, canonical task state, checkpoints, provider credentials |
| Control plane | Lane registry, role-bound workload identity, queues, leases, commands, progress, UI projection | Provider process, model credentials, production credentials |
| Lane supervisor | One fixed-role lane, server fencing epoch, checkpoint, registration intent, outbox, provider containment | Human or deployment authority |
| Provider host | One integrity-pinned adapter and bounded phase request | Control-plane token, supervisor state path, deployment token |
| CLI adapter | Phase sandbox, selected model ID, bounded structured result | Role selection, command authority, production access |
| Impact observer | Read-only event identity, redacted task facts, economy route, last safe summary | Human token, tools, workflow mutation, evidence status |
| Manager-review coordinator | Passing-evidence registry, fixed-manager decisions, pending human checks, broker handoff outbox | Provider execution, human grant, executor credential, deployment |
| Deployment broker | Accepted handoffs, human grants, one-use executor authorizations | Manager model, deploy code, production credentials |
| External executor | Production credential and target-side idempotency | Human decision or release selection |

```mermaid
flowchart LR
    human[Human operator] --> ui[/live]
    ui -->|snapshot · SSE · commands| cp[Control plane]
    sup[Lane supervisor] -->|register · lease · evidence| cp
    sup --> host[Provider host process group]
    host --> cli[Codex / Claude CLI]
    observer[Impact observer] -->|read-only| cp
    ui -->|separate output token| observer
    evidence[Trusted passing evidence] --> review[Manager-review coordinator]
    manager[Fixed manager identity] --> review
    review -->|accepted exact handoff| broker[Deployment broker]
    human -->|exact short-lived grant| broker
    executor[External executor] -->|claim once| broker
```

## Agent lane and fencing

**Stable lane, replaceable process** — a lane keeps one agent ID, role, queue, and checkpoint history. A runtime instance is a process boot that may crash or be replaced.

Every workload token is bound to workspace, agent, lane, and role before first registration. Registration is a compare-and-swap request: a first process expects no epoch; a replacement presents the last observed epoch; the control plane alone issues the next contiguous epoch. Lease renewal, event upload, and command polling all require the issued runtime identity and epoch, so an old process cannot keep writing after replacement.

The supervisor writes the exact pending registration request to a private state file before sending it. If the server commits registration and the response is lost across a process crash, the next boot retries that same runtime identity. The server's idempotent response closes the lost-acknowledgement gap without guessing or skipping an epoch.

State and workspace directories are process-locked and must be canonically disjoint. A writable project therefore cannot contain or alias the checkpoint, outbox, registration intent, or lock.

## Engineer execution loop

Only the engineer role can enter the modifying runner:

```text
Research -> Plan -> Execute -> Test --passed--> completed
   ^                              |
   +---------- failed ------------+
```

Each phase must record a non-empty outcome journal. Research and Plan are read-only. Execute receives development workspace write access. Test may run checks but the real CLI edge denies source writes. A passing Test is the only RPET completion; a failure increments the iteration and returns to Research.

The supervisor watches commands while a provider step is active. If control-plane contact is lost, it aborts the step boundary, preserves local evidence, and holds. It does not start disconnected grace work that a newer fenced runtime could duplicate.

## Human runtime control

Human commands carry a stable client command ID and a control-version precondition. Identical retries deduplicate; reuse with changed content is rejected.

| Command | Immediate durable effect | Completion condition |
|---|---|---|
| Queue | Append an agent-only outcome and 15-minute estimate | Current work is unchanged; queued task starts only at lane head |
| Interrupt | Fence later actions and record reason | Runtime acknowledges, checkpoints, terminates provider containment group, and confirms absence |
| Workspace hold | Fence all affected lanes | Each runtime settles; pre-settlement evidence may drain, later work is denied |
| Resume | Record human intent | Runtime activity confirms the requested checkpoint resumed |

On POSIX, each real provider host is a process-group leader. Timeout, failure, interrupt, and shutdown send TERM, then KILL regardless of whether the leader already exited, and poll until the group is absent. Windows real-provider execution fails closed. This contains normal descendants; a hard production boundary still needs an externally owned container, cgroup, job object, or dedicated UID.

## Provider and role boundary

The supervisor derives phase operations from the fixed role and sends them over a 256 KiB length-framed JSON channel. The child rejects unknown fields, role/phase drift, forged operations, concurrent steps, and unacknowledged current-action reports.

Real adapter loading requires:

- an absolute entrypoint outside workspace and state trees;
- a canonical regular file with no symlink alias;
- safe ownership and no group/world write bit;
- a configured SHA-256 checked by both parent and child before every launch/import; and
- a fixed environment allowlist that excludes all control-plane and supervisor variables.

The engineer CLI edge uses noninteractive, ephemeral provider modes; ignores user/project customizations; passes the prompt on stdin; bounds stdout, stderr, and time; and requires a strict final schema. Credential-shaped or high-entropy journal/result text is rejected before it enters the durable outbox. Claude additionally receives fail-closed sandbox settings, credential denial, safe mode, no MCP servers, and phase-scoped tools. Codex receives a strict shell environment and read-only or workspace-write sandbox by phase.

**Hard limit** — a same-user subprocess is not a filesystem security boundary. Codex read-only can still read broad host paths, and a hostile process may create a new session. Production must run this boundary inside external filesystem, network, credential, and process isolation.

## Token-efficient routing

[`../packages/model-routing`](../packages/model-routing) has no model IDs or prices. A caller supplies six profiles: Codex and Claude across economy, balanced, and frontier tiers, with capacity and optional rate cards.

For engineer RPET, the configured lane model must equal the catalog's Codex economy baseline. Iteration 1 starts on economy. One observed failed Test justifies balanced; repeated failed Tests justify frontier. The selected model ID drives the actual CLI invocation, and the current action records tier, model, and reason. Oversized context or provider mismatch fails closed. Task risk and complexity remain low until the authoritative task protocol carries those fields; Steward does not infer spend from prose.

The impact observer independently routes `impact_observer/summarize` to Claude economy. Its bounded input must fit that economy profile; it never escalates presentation work to frontier. The adapter receives redacted facts, selected model metadata, and `tools: []`. Routing decisions are available through a separately authenticated audit endpoint.

These policies reduce expected spend; they do not claim frontier-equivalent quality. Evaluation still needs paired accepted-task benchmarks, security-miss comparison, normalized token usage, and reopen/intervention rates.

## Impact projection

The observer uses a dedicated control-plane credential that is accepted only for UI bootstrap and event streaming. It verifies the bootstrap contains `workspace:read` and not `workspace:control`; supplying a human token therefore fails closed.

Task title, objective, and recent progress are bounded and stripped of credentials, contacts, links, implementation detail, and production claims before a model call. No source change means no repeated model spend. A cursor gap causes authoritative re-bootstrap. Invalid output or a failed refresh keeps the last safe summary visible as stale and never changes task state.

The frontend reaches summaries with a second read-only output token. It rejects token reuse and remote plaintext HTTP; tokens leave form state after connection and remain memory-only.

## Manager review and human handoff

The manager-review coordinator is a narrow bridge, not an organization engine:

1. A trusted issuer registers passing engineer evidence, including engineer identity, completion/checkpoint references, test digest, artifact digest, release-manifest digest, environment, result, and completion time.
2. A fixed manager credential reads its review queue and records `accepted` or `changes_requested` while echoing the exact evidence digest.
3. The coordinator rejects self-review and conflicting second decisions, persists the review, exposes accepted items as pending production checks to a human identity, and exposes changes-requested feedback only to the trusted engineer-evidence projection.
4. Only an accepted review enters the durable broker-handoff outbox. The coordinator authenticates to the broker with the handoff-issuer credential and has no human-grant or executor credential.

This service enforces evidence binding and separation of duty. It does not yet run the manager model. Its fixed manager credential is not bound to the control plane's current runtime epoch, lease, interrupt state, or assigned review task, so it is not yet safe to treat a direct agent call as authoritative after replacement or interruption. A dedicated read-only manager runner must submit through an active-runtime-fenced integration before production use.

## Production authorization

The broker has three globally distinct principals: manager-handoff issuer, authenticated human, and external executor.

```text
accepted manager review
  -> single-use manager handoff
  -> human grant with expiry
  -> one executor claim
  -> external idempotent deployment
```

Every transition binds workspace, task, artifact SHA-256, canonical release-manifest SHA-256, and target environment. The handoff also binds manager and review identity; the grant binds its handoff; the authorization binds its human issuer and executor claimant. Exact request hashes and idempotency keys make retries stable, while changed reuse fails closed.

The broker never deploys and never stores production credentials. A crash between claim and deployment can still strand a consumed grant, and a target can still repeat a side effect without durable `authorizationId` deduplication. Cross-system exactly-once deployment is an external responsibility.

## Failure behavior

| Failure | Behavior |
|---|---|
| Frontend restart | No runtime effect; new client bootstraps and resumes ordered events |
| Control-plane outage | Supervisor checkpoints and holds; no new authority or assignment is invented |
| Supervisor crash | Lane becomes stale/offline; replacement retries pending registration and resumes durable state |
| Provider failure | Step fails or holds; containment is confirmed before reuse |
| Observer failure | Work continues; last safe summary remains stale |
| Manager-review/broker failure | Development continues; handoff stays pending and no grant/deploy is implied |

## Storage and operational limits

The alpha control plane, observer, manager-review coordinator, and broker use owner-locked local files with fsync and strict startup validation. These are crash-recovery stores, not replicated databases or immutable audit systems. The manager-review and deployment-broker stores refuse an existing writer lock instead of guessing across PID namespaces; after an unclean exit, an operator must verify that no writer is alive before removing that exact lock. Multi-instance ownership, backups, retention, compaction, pagination, restore drills, and external audit anchoring remain production work.

Static bearer credentials are development infrastructure. Production requires an identity provider, short-lived workload credentials, token rotation/revocation, TLS termination, rate limits, audit export, and separate service accounts. Application clients already refuse remote plaintext bearer transport.

## Reference designs

**Paperclip** — durable wake/run records and its cheap read-and-report Summarizer informed Steward's separation of canonical work from a bounded operator projection. Steward keeps permanently independent supervisors and a later human-only release boundary instead of adopting Paperclip's broader company model. [Paperclip repository](https://github.com/paperclipai/paperclip)

**Paseo** — daemon-owned sessions and reconnecting clients informed the execution-plane/frontend split. Steward adds a durable multi-user registry, role-bound workload identity, queues, fencing, and production authorization above that pattern. [Paseo orchestration documentation](https://paseo.sh/docs/orchestration)

No source from either project is included in Steward.

## Growth path

1. **Current alpha** — authoritative engineer lanes, `/live`, durable control and recovery, real CLI edge, cheap routing, observer, manager-review coordinator, and human grant broker.
2. **Isolated execution** — containers/dedicated UIDs, immutable adapter bundles, scoped network, CI evidence capture, and read-only verifier/manager runners whose decisions are fenced by the active control-plane runtime.
3. **Durable service plane** — transactional database, HA ownership, identity provider, retention, backups, audit anchoring, and authoritative review/approval UI projections.
4. **Production integration** — artifact registry, canonical manifest service, idempotent executor, health checks, rollback, and operational approvals.

## Alternatives considered

- **Fork an existing orchestrator** — rejected because its broader organization model and licensing obligations add scope this control plane does not need.
- **Run agents or observer timers in the browser** — rejected because closing or redeploying the frontend must not pause work.
- **Let queued work preempt automatically** — rejected because future intent should not make current work ambiguous; interrupt remains explicit.
- **Trust a WebSocket as state** — rejected because connections are transient; sequenced durable facts remain authoritative.
- **Mark interruption when clicked** — rejected because request acceptance is not proof of provider settlement.
- **Give every role the engineer runner** — rejected because verifier/manager read-only intent would inherit write authority.
- **Give the observer transcripts or tools** — rejected because user-impact presentation needs neither and must not gain workflow authority.
- **Use all-frontier models** — retained as an evaluation baseline, rejected as the default because evidence-bounded work can start cheaper.
- **Put production credentials in an agent container** — rejected because prompt injection or tool misuse would bypass human oversight.
