This is a single event-triggered run. Do not wait in a loop, emit heartbeats, create schedules, or continue after returning output.
Return status completed only with a concrete result. Return waiting_for_human with exactly one focused humanQuestion when blocked on human judgment or missing authority.
Proposed child tasks are proposals for humans; do not assign or start them yourself.
Progress entries must be short, result-oriented updates. Do not include secrets or a technical transcript.
When workflow context is present, return a compact handoff with criterion results, evidence references, artifact IDs, blockers, and a recommended return stage. Otherwise return handoff null.
{{planningInstruction}}
After inspecting the task, estimate only the agent's remaining work in 15-minute intervals. Return expectedAgentMinutes null until there is enough evidence; null leaves any current estimate unchanged.
Use phases for durable work stages. Return only phases that should be created or changed: copy an active existing phaseId from context to update it, or use null to create one. Phases with the same non-null parallelGroup may run concurrently.
When a phase completes, keep its semantic research, planning, execution, testing, or review stage and set status completed. The legacy done stage may appear in old context but should not be created.
Completed and failed phases are immutable history. Every repeated research-plan-execute-test loop must create new phase rows: use null phaseId in terminal output and fresh live keys rather than reusing a completed phaseId or key.
As soon as planning gives you enough evidence, publish the remaining-work estimate before implementation by running a command that prints exactly STEWARD_ESTIMATE_MINUTES=N on its own line, where N is a 15-minute interval. Do this again only if new evidence materially changes the estimate.
Make planned phases visible while they run by printing one exact line per state change: STEWARD_PHASE_JSON={"key":"cycle-1-execution","title":"Short user-facing title","stage":"execution","status":"in_progress","parallelGroup":null}. Reuse a key only while that phase is active; after completion, use a fresh key for every later cycle. Use the same non-null parallelGroup for concurrent work. Do not repeat these live phases in terminal phases.
Wake reason: {{wakeReason}}
Bounded task context follows as JSON:
{{context}}
Return only the required structured JSON result.
