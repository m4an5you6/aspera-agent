# State and APIs

English | [中文](state-and-api.zh.md)

## Summary

Aspera extension `0.1.1` uses remote protocol `4` and local fleet storage generation `6`, retaining compatible reads of released records without changing their identities, hashes or limits. Generated DSH Remote methods use the `aspera` namespace; authenticated control traffic uses `/aspera/v4`. Fields and branded IDs are declared in the [protocol](../packages/experiments/src/cluster-protocol.ts), [storage observations](../packages/experiments/src/storage-protocol.ts) and [dispatch types](../packages/dispatch/src/types.ts).

## Table of Contents

- [Persistent ownership](#persistent-ownership)
- [Receipts and Goals](#receipts-and-goals)
- [Controller readiness and recovery](#controller-readiness)
- [API consumers](#api-consumers)
- [Execution step progress](#execution-step-progress)
- [Logs, outputs and services](#logs-outputs-and-services)

-----

<a id="persistent-ownership"></a>
## Persistent ownership

| Owner | Domain/version | Durable records |
| --- | --- | --- |
| Management Host | `aspera_fleet` / `6` | Server preferences, SSH/environment observations, verified program paths, node stages, pending commands, storage decisions, requirements and receipts |
| Remote coordinator | `aspera_queue` / `4` | Admission order, plans, approvals, allocations, execution identities, progress and services |
| Node control | `aspera_node` / `4` | Node allocation, command identity, cleanup evidence and registered service facts |
| Experiment observation directory | `observations-v1` / `1` | Source ownership, redacted stream records and measured-resource/training history |
| Management notifications | `aspera_error_notices` / `1` | First-display fingerprints and timestamps, independent of failed task state |
| Local removal ownership | `aspera_removals` / `1` | Deletion identities, resumable local cleanup, removed servers and unresolved remote work |
| Local preparation | `aspera_preparation` / `1` | Frozen limits, original archive/hash, per-node recovery budgets, attempts and measured source changes |
| Remote installer | `.aspera-installations` / `1` | Boot/start-tick process identities, real progress, exit receipts and full stdout/stderr |
| Experiment coordinator run directory | `execution-progress.v1.json` / `1` | Exact-plan Agent step reports, execution Session, record revision and program timestamps |

The local fleet domain reads generations `1`–`5`; remote domains remain generation `4` with compatible reads of `1`–`3`. Protocol `1` retains extension version `0.1.0` and optional limits; protocol `2` retains `0.2.0`, and protocol `3` retains `0.1.1`. Pending work stays on its original runtime; incompatible controllers wait for task completion and confirmed cleanup. Environment diagnostics, preparation tools, storage choices and receipts use existing Session messages/tool events and Goal operations, without changing the Session format.

Node command records use `${experimentId}_${commandId}` as one path-safe filename key. The UUID prefix keeps identical run IDs in different experiments distinct; both original IDs remain separate record fields. Command launch, output lookup, service health/stop and cleanup use the same key resolver. `aspera_node` values and generation `4` remain unchanged, and run IDs still reject path separators. A local update cannot repair a submitted experiment's pinned remote release; create a copied experiment on the repaired release after resolving its requirements and retained node ownership.

Server preferences and resolved deployments are separate. Creation freezes the name, objective, selected coordinator, servers, phase models, credential references, mode and policy; preparation saves input hashes, mounts, directories, executable paths, storage reasons and network addresses. Protocol `4` has no aggregate task budget. Retry checks remote acceptance before configuration and retains the UUID, Session and original release after a local upgrade. Missing Sessions require a copied experiment. Original material must match its retained hash or reconstructed release digest; missing/unverifiable archives block recovery instead of substituting the current release. Changed mounts or inputs fail explicitly. Pending commands require exit evidence before further mutations. Generation-1–3 unfinished preparations must be copied.

Installation persistence acknowledgment: [installation schemas](../packages/dispatch/src/installation-model.ts) define independent local and remote version-1 records without changing fleet `6`, remote task/control `4` or Session event generations. Recovery retains all user-started budgets and attempts. Download bytes, package changes and measured compiler CPU/I/O count as progress; heartbeats and retry messages do not. Total time includes Agent diagnosis and repair. The installer enforces remaining limits independently of SSH and seals the original stage only after fixed-version/file checks; environment acceptance remains mandatory. Stopping requires matching boot, PID and start ticks plus confirmed child-group exit. Unknown exits retain node ownership through cancellation and offline deletion. Settled local deletion removes unreferenced archives; unresolved deletion retains the private journal.

The Agent probes HTTPS candidates on the selected node before switching. Child-only source settings preserve the lockfile, TLS, package integrity and official Node-header checksums; user registry credentials are excluded. Source changes consume retries and retain measured evidence. Active preparation resumes its original journal after management restart; failed experiments require explicit Retry preparation, which retains history and begins a new budget. Creation-time limits do not change when profile configuration changes.

Phase snapshots record the provider, model, reasoning choice, pinned adapter version and a digest/reference for private API configuration. Only supported key APIs are transferable: official DeepSeek and pi-ai key providers, including OpenAI-compatible Qwen. Unsupported authentication is refused before admission. Each Agent mounts its own provider scope; global settings changes and retries cannot replace it. Keys and raw headers remain outside public records.

The coordinator writes ownership before scheduling. A queue-record loss with retained execution evidence requires operator reconciliation rather than resubmission. After restart, verified drained commands can release a node; any unverified managed range retains it. Inspect and stop uncertain processes on the affected node before repairing its allocation records; the page does not offer a force-release button.

Generation-6 persistence acknowledgment: the frozen [generation-5 reader](../packages/dispatch/src/fleet-schema-v5.ts) retains earlier requests and remote submissions. New local requests require a selected `coordinatorId`; `registry.checks`, `deletions` and `deleted` store management observations and removal identities. Remote payload hashes and released records are never rewritten. Fleet behavior and storage tests exercise legacy reads, interrupted checks, cleanup retries, ownership rejection and tombstone deduplication.

Observation persistence acknowledgment: [observation schemas](../packages/experiments/src/observations.ts) introduce independent version-1 files; [error notices](../packages/dispatch/src/error-notices.ts) introduce a separate version-1 domain. Fleet generation `6`, remote generation `4`, released Session event definitions and submitted digests remain unchanged. Missing directories indicate unavailable history. Observation, record, attachment and error-notice tests cover source/cursor ownership, bounded history, incomplete output, rotation, exact attachment references and persistent deduplication.

Local record deletion works in every state without SSH or remote cancellation; unfinished work requires explicit `allowUnconfirmed`. Server deletion with `allowLinked` retains linked experiments and pinned connections. A saved tombstone immediately hides the record and prevents late control replies, input commits and Goal completion. Local upload/observation cleanup resumes after restart. Deletion never claims that remote processes stopped or resources were released.

Removal persistence acknowledgment: [removal schemas](../packages/dispatch/src/removals.ts) define independent `aspera_removals` version `1`; fleet generation `6`, remote generation `4` and frozen readers remain unchanged. Unresolved records retain connection references, deployment identities, submission digests and pending-command locations; credentials remain private. Re-adding the same SSH endpoint, even with another username, cannot bypass unresolved ownership. Read-only checks clear it only after matching terminal, process and service release evidence; missing records and offline responses retain it. Removed server IDs cannot be reused.

Remote cleanup requires terminal state and confirmed process/resource release. Its durable operation identity fixes the cleanup choice; saved node progress supports retry. Cleanup verifies mounts and owners, refuses nested mounts, quarantines the exact run directory and unlinks symlinks without following them. Outside that run, only registered private transfer files are removed. Shared releases, control state, user originals and ordinary DSH Sessions remain. Partial failure retains the experiment; a new record-only operation completes immediately, including during pending SSH cleanup.

-----

<a id="receipts-and-goals"></a>
## Receipts and Goals

`receipt` preserves the complete initial acceptance; `latest` tracks the current remote record. Both contain the exact `handover` value **本机派发完成，远端实验已接管**. Acceptance means source, inputs and required credentials were transferred and the coordinator owns the task; it does not promise that training started. Execution Session/Goal IDs are added after allocation and Agent startup.

The Host persists the complete receipt before appending the handover message and finishing the dispatch Goal. Goal completion compares the saved ID and revision; an edited or replaced Goal is not completed by an old response. Browser experiments create separate Sessions, leaving ordinary conversation `/goal` semantics intact.

Semi-mode confirmation references the displayed plan revision. Duplicate confirmation of that revision is idempotent; a different revision fails. Submitted requirements cannot be edited in place. New requirements use a new experiment and approval. Automatic policy confirmation is stored separately from user confirmation.

A semi-mode question binds its experiment, Session, tool call and immutable question revision. The coordinator persists it before the Goal pauses; active managed processes remain monitored. A reply is validated and saved before delivery to the original call and resumption of the same Goal. Identical reply retries are idempotent; conflicts, expired questions and cancelled or interrupted tasks cannot resume execution. Restart reports pending questions as interrupted and expires them rather than replaying the tool.

-----

<a id="controller-readiness"></a>
## Controller readiness and recovery

The preparation Agent calls environment inspection, `repair_preparation_controller` and verification in its original Session. Program checks compare actual GPU UUIDs, accessible character devices and the controller's startup authorization; sorted sets avoid order-dependent differences. Handover rechecks every accepted controller identity and policy digest, and new node allocation independently probes hardware again. A changed submitted GPU requirement requires a copied experiment rather than rewritten records.

Authenticated health advertises `controller-readiness-v1` and `controller-maintenance-v1`. Maintenance checks queued and active coordinator tasks, node allocations, commands and inference services, then atomically fences admission. The repair tool derives the PID, Linux start identity, host boot identity, paths and fixed release itself. It waits for identity-bound process exit and port release before starting that release. Busy, unknown and legacy maintenance cases retain concrete blockers. Whitelisted legacy process settings allow read-only reuse only when startup GPU evidence and the original release match; missing evidence never counts as compatibility.

Repair receipts live under `$DSH_HOME/aspera-controller-repairs/<experiment>/<server>-<role>.v1.json`; remote stop and exit evidence belongs to the experiment's run directory. Version 1 pins the default two-attempt limit from `controllerRepairMaxAttempts`, process identities, stages, outcomes and timestamped acceptance. Recovery checks these receipts before another mutation; a confirmed stop or verified replacement can resume, while ambiguous outcomes remain blocked. Local deletion retains unresolved ownership journals until release is confirmed; optional remote cleanup removes stop receipts with the owned run. This independent format leaves fleet generation 6, remote protocol 4 and Session format unchanged. `FleetDriver` implementations provide authenticated `inspectController` alongside existing deployment operations.

-----

<a id="api-consumers"></a>
## API consumers

`experimentExecutionProgress` reads the pinned coordinator's current plan reports and explicitly marks unsupported old releases. It validates experiment, plan and execution Session ownership without updating the remote release.

`experimentSnapshot` and reconnect snapshots include `installations`, with current per-node progress and previous recovery rounds. Attempts retain delivered source-warning categories, original sequence numbers and collection times; replay and application restart do not repeat their diagnosis. `retryPreparation` returns `{ record, installations }`. Custom `ExperimentFleet.open` callers may pass validated installation limits after the complete driver; omission resolves the published defaults. The preparation Agent uses scoped inspect, probe and switch-source tools followed by program verification. Normal polling reads saved state without waking a model.

Use [AsperaRemote](../packages/dispatch/src/index.ts) and generated `@aspera/dispatch/remote` descriptors. `previewExperimentDeletion` separates `recordDeletionAvailable` from remote `eligible`/`cleanupAvailable`; `previewServerRemoval` lists retained work. `deleteExperiments` and `removeServer` accept explicit acknowledgements for unfinished local removal. `experimentSnapshot`/`watch` include `deletedIds`, `removedServerIds` and `unconfirmedWork`; reconnect retains these identities and source cursors. `reconcileRemovedWork` performs a bounded read-only ownership check; `probeServer` includes it within the shared connection deadline. Checks retain dated status, configuration, results and last success; SSH, GPU and control readiness remain separate. Other methods cover models, credentials, staging, creation, retries, decisions, cancellation, logs, files and services. Agent tools share `ExperimentFleet` preparation.

`ClusterQueue` consumes a validating `ExperimentTable` and process-owning `ClusterExecutor`. `ExperimentFleet.open` accepts a connection-check deadline and a complete `FleetDriver`; production uses password SSH and host-key verification. A provider owns transfer, probes, credentials and authenticated operations together. CPU test providers are explicit test fixtures and are excluded from release archives.

Control APIs require private bearer credentials and listen on loopback. The Host accesses remote controls through managed SSH connections. When a node's fixed identity equals the coordinator identity, the coordinator uses its authenticated loopback node endpoint directly; other nodes retain SSH transport. Password queries return only presence/writability; passwords are stored by DSH credentials and copied into restricted coordinator files for allocated-node control. No model requirement, receipt or ordinary browser query returns plaintext. Only `revealServerPassword(id)` explicitly reads it for the current editor, without logging or browser persistence.

-----

<a id="execution-step-progress"></a>
## Execution step progress

Persistence type acknowledgment: [execution progress schemas](../packages/experiments/src/execution-progress.ts) add an independent version-1 file in the coordinator's owned experiment run directory. Reports bind experiment ID, approved plan revision, one-based step and execution Session. The file stores its own revision, per-step state, short detail, call ID and program timestamp. Existing plans, `progress.json`, fleet generation `6`, remote protocol/storage `4` and Session events remain unchanged. Experiment-owned cleanup removes this file with its run directory.

An absent file reads as pending steps at revision zero without writing. Authenticated execution workers report running, completed or blocked through the coordinator; the model cannot select experiment, Session, call identity or coordinator generation. Synchronous validation and atomic rename reject concurrent overwrites, old plans, wrong Sessions and paused or ended work. Identical retries do not increment revisions. Blocked steps may resume; completed steps cannot reopen. Conflicts return the current readable revision for repair. Corrupt or mismatched saved files fail explicitly and remain retained.

Tools and diagnostics use existing Session messages and tool events. Completion requires all approved steps reported completed plus the existing independent command, node and result checks. Old experiments keep their fixed release; a missing API displays unrecorded progress rather than changing the release or inferring completion. A missing remote experiment is a read failure, not an unsupported API. The console retains the last successful read and its time after errors, distinguishes first-read failure, ignores replies after selection changes or deletion and stops activity animation when the experiment stops.

-----

<a id="logs-outputs-and-services"></a>
## Logs, outputs and services

`experimentTrace` binds pages to experiment, phase, Session and original sequence. Preparation reads the local dispatch Session; planning/execution read their saved remote Sessions. Large remote events use digest-checked fragments before reaching the official assembler. `experimentTraceEvent` and `experimentTraceAttachment` require exact event ownership; attachments must be referenced by that event and pass the published attachment provider's content checks. Missing or truncated legacy payloads are identified explicitly and never parsed as complete events. The read-only factory does not register remote experiments as ordinary editable Sessions.

`experimentLogSources`, `experimentLog`, `downloadExperimentLog` and `experimentMetrics` expose actual registered sources and measurements. New source manifests and JSONL records retain experiment/node/source identities, output stream, collection time and sequence. Cursors also bind file generation; incomplete tails wait, and replacement/missing files are explicit. Preparation and Agent output is captured before tool-result truncation. Registered managed commands capture stdout/stderr independently; old mixed files keep unknown times and streams. Known credentials and labeled secrets are redacted before publication. Download tickets expire, are consumed once and reject generation changes; displayed history and incoming tails are bounded separately.

Node `observations` settings default to `intervalMs: 2000`, `historyMs: 900000`, `readBytes: 65536` and `metricSamples: 1000`. Console polling, chart retention and read/cache limits are independently configurable in [Config](../packages/console/src/config.ts). Resource samples use OS counters and `nvidia-smi`; training values come only from `report_experiment_progress`. Absent data stays absent. Disconnects retain the last dated values and leave chart gaps. Unsupported pinned runtimes expose their available legacy logs without creating new measurements. Error fingerprints persist independently of task and source health; a successful local snapshot cannot clear a remote failure.

Output APIs list relative paths, node identity, size and modification time. Downloads use one-use expiring tickets and bounded reads; path traversal, symlink escape and a file generation change are rejected. A disconnected download aborts its upstream read. File contents are not synchronized by default.

Services have an independent UUID, owning experiment/node, model path, command identity, loopback port, health endpoint and cleanup state. Only legacy records carry a service deadline. Starting requires an unused port; health requires a live managed process and an actual successful HTTP check. Private access supports bounded GET/POST requests. Optional `inferenceMapping` settings freeze the platform HTTPS base URL and mapped port in the server snapshot. `start_inference_service(publish=true)` opens a Bearer-authenticated listener on that mapped port and forwards GET/HEAD/POST streams to the loopback model; the model port must differ from the mapping and control ports. The node checks the external URL using the service/experiment identity and a fresh nonce, and stores `external.state` independently from local health. Redirects are rejected. These node-origin checks do not guarantee reachability from every caller network. Service keys live in private node files outside the Agent workspace, never in receipts, logs or Agent tool results. Only the explicit operator Remote `serviceAccessInfo` returns the service key. Stopping, cancellation and process exit close the public listener. Node restart never recreates an unverified listener. Stop/cancel retains allocation until managed cleanup is confirmed; unexpected exit is terminal and never restarts automatically.
