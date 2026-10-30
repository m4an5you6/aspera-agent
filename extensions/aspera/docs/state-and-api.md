# State and APIs

English | [中文](state-and-api.zh.md)

## Summary

[Storage persistence and APIs](storage-governance.md#records-and-compatibility) acknowledges independent version-1 catalogs, loans, reservations and material operations, optional observation/cleanup fields, `experimentStoragePlan` and `refreshExperimentStorage`. Generated Host/Client consumers update together; existing fleet, Session and original fixed-release data remain unchanged.

[Completion evidence and retrospective verification](completion-review.md) owns the supplementary status, source and historical-environment schemas, independent version-1 persistence acknowledgement and generated review Remote APIs. Raw failed receipts remain unchanged.

Aspera extension `0.1.1` uses remote protocol `4` and local fleet storage generation `6`, retaining compatible reads of released records without changing their identities, hashes or limits. Generated DSH Remote methods use the `aspera` namespace; authenticated control traffic uses `/aspera/v4`. Fields and branded IDs are declared in the [protocol](../packages/experiments/src/cluster-protocol.ts), [storage observations](../packages/experiments/src/storage-protocol.ts) and [dispatch types](../packages/dispatch/src/types.ts).

## Table of Contents

- [Persistent ownership](#persistent-ownership)
- [Receipts and Goals](#receipts-and-goals)
- [Controller readiness and recovery](#controller-readiness)
- [API consumers](#api-consumers)
- [Execution step progress](#execution-step-progress)
- [Controlled interruption](#experiment-interruption)
- [Remote task settlement](#remote-task-settlement)
- [Local running records](#local-running-records)
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
| Independent remote task identity | `aspera_remote_tasks` / `1` | Original submission digest, pinned nodes and connection references, retained terminal-release evidence |
| Local preparation | `aspera_preparation` / `1` | Frozen limits, original archive/hash, per-node recovery budgets, attempts and measured source changes |
| Remote installer | `.aspera-installations` / `1` | Boot/start-tick process identities, real progress, exit receipts and full stdout/stderr |
| Experiment coordinator run directory | `execution-progress.v1.json` / `1` | Exact-plan Agent step reports, execution Session, record revision and program timestamps |
| Management Host archive | `aspera-run-records` / `1` | Complete redacted events, command output, training logs, step reports, retained measurements and durable read positions |
| Host and original run directory | `interruption.v1.json` / `1` | Operation identity, original submission hash, node exit evidence, release result and verification recovery |

The local fleet domain reads generations `1`–`5`; remote domains remain generation `4` with compatible reads of `1`–`3`. Protocol `1` retains extension version `0.1.0` and optional limits; protocol `2` retains `0.2.0`, and protocol `3` retains `0.1.1`. Pending work stays on its original runtime; incompatible controllers wait for task completion and confirmed cleanup. Environment diagnostics, preparation tools, storage choices and receipts use existing Session messages/tool events and Goal operations, without changing the Session format.

Node command records use `${experimentId}_${commandId}` as one path-safe filename key. The UUID prefix keeps identical run IDs in different experiments distinct; both original IDs remain separate record fields. Command launch, output lookup, service health/stop and cleanup use the same key resolver. `aspera_node` values and generation `4` remain unchanged, and run IDs still reject path separators. A local update cannot repair a submitted experiment's pinned remote release; create a copied experiment on the repaired release after resolving its requirements and retained node ownership.

Server preferences and resolved deployments are separate. Creation freezes the name, objective, selected coordinator, servers, phase models, credential references, mode and policy; preparation saves input hashes, mounts, directories, executable paths, storage reasons and network addresses. Protocol `4` has no aggregate task budget. Retry checks remote acceptance before configuration and retains the UUID, Session and original release after a local upgrade. Missing Sessions require a copied experiment. Original material must match its retained hash or reconstructed release digest; missing/unverifiable archives block recovery instead of substituting the current release. Changed mounts or inputs fail explicitly. Pending commands require exit evidence before further mutations. Generation-1–3 unfinished preparations must be copied.

Installation persistence acknowledgment: [installation schemas](../packages/dispatch/src/installation-model.ts) define independent local and remote version-1 records without changing fleet `6`, remote task/control `4` or Session event generations. Recovery retains all user-started budgets and attempts. Download bytes, package changes and measured compiler CPU/I/O count as progress; heartbeats and retry messages do not. Total time includes Agent diagnosis and repair. The installer enforces remaining limits independently of SSH and seals the original stage only after fixed-version/file checks; environment acceptance remains mandatory. Stopping requires matching boot, PID and start ticks plus confirmed child-group exit. Unknown exits retain node ownership through cancellation and offline deletion. Settled local deletion removes unreferenced archives; unresolved deletion retains the private journal.

The Agent probes HTTPS candidates on the selected node before switching. Child-only source settings preserve the lockfile, TLS, package integrity and official Node-header checksums; user registry credentials are excluded. Source changes consume retries and retain measured evidence. Active preparation resumes its original journal after management restart; failed experiments require explicit Retry preparation, which retains history and begins a new budget. Creation-time limits do not change when profile configuration changes.

Phase snapshots record the provider, model, reasoning choice, pinned adapter version and a digest/reference for private API configuration. Only supported key APIs are transferable: official DeepSeek and pi-ai key providers, including OpenAI-compatible Qwen. Unsupported authentication is refused before admission. Each Agent mounts its own provider scope; global settings changes and retries cannot replace it. Keys and raw headers remain outside public records.

DeepSeek snapshots store plugin inputs with explicit resolved defaults: retry delays belong under `retryPolicy.backoff`, while thinking and file settings use the provider's configuration fields. After checking the original receipt hash, the reader converts earlier version-1 resolved snapshots in memory without rewriting private bytes, references or hashes. Malformed or mixed layouts fail validation. [Snapshot upgrade](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-model-snapshots/guide.md) defines restart and fixed-release recovery.

The coordinator writes ownership before scheduling. A queue-record loss with retained execution evidence requires operator reconciliation rather than resubmission. After restart, verified drained commands can release a node; any unverified managed range retains it. Inspect and stop uncertain processes on the affected node before repairing its allocation records; the page does not offer a force-release button.

Generation-6 persistence acknowledgment: the frozen [generation-5 reader](../packages/dispatch/src/fleet-schema-v5.ts) retains earlier requests and remote submissions. New local requests require a selected `coordinatorId`; `registry.checks`, `deletions` and `deleted` store management observations and removal identities. Remote payload hashes and released records are never rewritten. Fleet behavior and storage tests exercise legacy reads, interrupted checks, cleanup retries, ownership rejection and tombstone deduplication.

Observation persistence acknowledgment: [observation schemas](../packages/experiments/src/observations.ts) introduce independent version-1 files; [error notices](../packages/dispatch/src/error-notices.ts) introduce a separate version-1 domain. Fleet generation `6`, remote generation `4`, released Session event definitions and submitted digests remain unchanged. Missing directories indicate unavailable history. Observation, record, attachment and error-notice tests cover source/cursor ownership, bounded history, incomplete output, rotation, exact attachment references and persistent deduplication.

Local record deletion works in every state without SSH or remote cancellation; unfinished work requires explicit `allowUnconfirmed`. Server deletion with `allowLinked` retains linked experiments and pinned connections. A saved tombstone immediately hides the record and prevents late control replies, input commits and Goal completion. Local upload/observation cleanup resumes after restart. Deletion never claims that remote processes stopped or resources were released.

Removal persistence acknowledgment: [removal schemas](../packages/dispatch/src/removals.ts) define independent `aspera_removals` version `1`; fleet generation `6`, remote generation `4` and frozen readers remain unchanged. Unresolved records retain connection references, deployment identities, submission digests and pending-command locations; credentials remain private. Re-adding the same SSH endpoint, even with another username, cannot bypass unresolved ownership. [Task settlement](#remote-task-settlement) verifies matching terminal, process and service release evidence; connection checks remain read-only. Removed server IDs cannot be reused.

Remote cleanup requires terminal state and confirmed process/resource release. Its durable operation identity fixes the cleanup choice; saved node progress supports retry. Cleanup verifies mounts and owners, refuses nested mounts, quarantines the exact run directory and unlinks symlinks without following them. Outside that run, only registered private transfer files are removed. Shared releases, control state, user originals and ordinary DSH Sessions remain. Partial failure retains the experiment; a new record-only operation completes immediately, including during pending SSH cleanup.

-----

<a id="receipts-and-goals"></a>
Preparation command persistence acknowledgment: [command supervision](../packages/dispatch/src/preparation-command.ts) and its [Linux provider](../packages/dispatch/scripts/preparation-command.py) add independent version-1 requests, process identities, status and log cursors within the original preparation directory. Their experiment, node, command, Session and tool-call identities are checked before importing logs. Existing numeric exit receipts remain readable; missing identity never authorizes replay or termination. Verified uv material and partial downloads use a server cache with version-1 indexes. Fleet generation `6`, protocol `4`, pinned releases and Session formats remain unchanged. [Preparation command recovery](../packages/dispatch/README.md#preparation-command-recovery) owns tools and limits.

## Receipts and Goals

`receipt` preserves the complete initial acceptance; `latest` tracks the current remote record. Both contain the exact `handover` value **本机派发完成，远端实验已接管**. Acceptance means source, inputs and required credentials were transferred and the coordinator owns the task; it does not promise that training started. Execution Session/Goal IDs are added after allocation and Agent startup.

The Host persists the complete receipt before appending the handover message and finishing the dispatch Goal. Goal completion compares the saved ID and revision; an edited or replaced Goal is not completed by an old response. Browser experiments create separate Sessions, leaving ordinary conversation `/goal` semantics intact.

Planning and execution workers persist `blocked` when a turn reaches `max-tokens` before finishing, with Goal reason `aspera-model-token-limit`. The coordinator consumes the terminal outcome and reconciles managed processes instead of keeping an idle Agent marked running. Completed commands are not repeated. [Phase context services](../packages/runtime/README.md#use-this-package) retain compaction events, private model selection and existing Session ownership.

Semi-mode confirmation references the displayed plan revision. Duplicate confirmation of that revision is idempotent; a different revision fails. Submitted requirements cannot be edited in place. New requirements use a new experiment and approval. Automatic policy confirmation is stored separately from user confirmation.

A semi-mode question binds its experiment, Session, tool call and immutable question revision. The coordinator persists it before the Goal pauses; active managed processes remain monitored. A reply is validated and saved before delivery to the original call and resumption of the same Goal. Identical reply retries are idempotent; conflicts, expired questions and cancelled or interrupted tasks cannot resume execution. Restart reports pending questions as interrupted and expires them rather than replaying the tool.

-----

<a id="controller-readiness"></a>
## Controller readiness and recovery

The preparation Agent calls environment inspection, `repair_preparation_controller` and verification in its original Session. Program checks require the controller's fixed release to match the selected experiment, then compare actual GPU UUIDs, accessible character devices and startup authorization; sorted sets avoid order-dependent differences. Matching features alone do not permit another release. Handover rechecks every accepted controller identity and policy digest, and new node allocation independently probes hardware again. A changed submitted GPU requirement requires a copied experiment rather than rewritten records.

Authenticated health advertises `controller-readiness-v1` and `controller-maintenance-v1`. Maintenance checks queued and active coordinator tasks, node allocations, commands and inference services, then atomically fences admission. The repair tool derives the PID, Linux start identity, host boot identity, paths and fixed release itself. It waits for identity-bound process exit and port release before starting that release. Busy, unknown and legacy maintenance cases retain concrete blockers. Whitelisted legacy process settings allow read-only reuse only when startup GPU evidence and the original release match; missing evidence never counts as compatibility.

An offline control endpoint uses SSH evidence rather than an online maintenance request to the dead role. The program reads both role homes, original profile bindings, process identities and persisted task, command, allocation and service records. Active processes, unreadable identities, pending launches, queued tasks or unconfirmed exits block recovery. Confirmed local terminal tasks and released commands may settle stale resource flags while retaining original results; multi-node release without complete evidence remains blocked. The program pauses any online counterpart through authenticated maintenance before changing state, and retains the admission fence until verified recovery completes.

Controllers use release-specific `aspera-worker-<deploymentId>` profiles in the original role home. The sealed release's setup initializes a private staging profile, which the program verifies and atomically publishes under the derived name. The old profile, `node_modules` binding, task storage and Sessions are preserved. A confirmed recovery starts only the selected fixed release with its verified GPU policy; ordinary preparation shell commands cannot perform this operation. The Agent must request full revalidation before handover.

Controller repair persistence acknowledgment: version-2 receipts under `$DSH_HOME/aspera-controller-repairs/<experiment>/<server>-<role>.v2.json` retain online process or offline ownership evidence, the original two-attempt limit, stages and acceptance. Version-1 receipts remain unchanged and initialize the successor's prior attempts and limits. Remote recovery fences and exit evidence are independent version-1 files in owned control and experiment directories. Recovery reconciles the same operation before another mutation, adopts an identity-matched launch without starting it twice and keeps unknown outcomes blocked. Deletion retains unresolved ownership journals until release is confirmed. Fleet generation 6, remote protocol 4, queue/node record generations and Session formats remain unchanged. `FleetDriver.ensureClusterRole` accepts an optional program-owned recovery id.

-----

<a id="api-consumers"></a>
## API consumers

Independent version-1 `input-sharing-v1` receipts bind released input compaction to the current experiment/node, authenticated content, original identities and completed replacements. Cleanup adds `input-duplicate`, enabled by `inputSharingVersion: 1` and `managed-input-sharing-v1`. Independent `release-asset-sharing-v1` records and `release-asset-duplicate` cover known immutable idle release resources, requiring `releaseAssetSharingVersion: 1`/`managed-release-asset-sharing-v1`. Paths/bytes remain; original file times are retained in the receipt. No Session or protocol generation changes.

Wheel/cache persistence acknowledgment: independent version-1 `input-verifications-v1`, `wheel-derivations-v1` and `cache-maintenance-v1` records bind input digests, derived builds, unchanged payloads and manager exits to their owning node/operation. Operation-local proofs and manager receipts enter the archive. Optional `PrepareExperimentEnvironment.repairWheelMetadata` requires an explicit repair plan; cleanup adds `manager-cache`. Older records remain readable. Manifest `wheelMetadataRepairVersion: 2` and `managerCacheVersion: 1` require `managed-wheel-metadata-v1`/`managed-wheel-metadata-v2` and `managed-manager-cache-v1` before reuse/handover. Protocol 4, fleet 6 and Session formats remain fixed.

Tool-snapshot persistence acknowledgment: `storage-tool-observations-v1/<serverId>/<snapshotId>.json` accepts existing node inspections plus complete `EnvironmentOperationStatus` and `EnvironmentOperation` values. Readers distinguish operation identities, retain old inspection reads, verify allocation ownership and page the saved original without changing receipts. The version-1 envelope and prior files remain intact; protocol 4, fleet 6 and Session formats are unchanged.

Persistence acknowledgment: optional `EnvironmentOperation.cleanup`/`recovery` and `EnvironmentStorageNode.cleanups`/`recoveries` reference independent version-1 cleanup and recovery files. Prior records without these fields remain readable; original failed receipts and times are retained. Current mount IDs appear only in diagnostics. Manifest `asperaEnvironmentTools.cleanupVersion: 1` requires `managed-environment-cleanup-v1` before controller reuse. All schema and generated Remote consumers update together; protocol 4, fleet generation 6 and Session formats remain unchanged.

Installer persistence acknowledgment: optional `EnvironmentOperation.failure` references independent version-1 `EnvironmentFailure` evidence stored beside its original receipt. Request, environment and node identities must match; retry rejections additionally name the original operation. Optional `EnvironmentReusePlan.installerTemporaryBytes` records private tooling allocation. Earlier records omit both fields and remain readable. Manifest installer version 3 requires fixed pip and the corresponding controller capability; protocol 4, fleet generation 6 and Session formats remain fixed.

`experimentStorageUsage`, `previewExperimentCacheCleanup` and `cleanupExperimentCache` expose [managed environment observations and candidate-bound cleanup](managed-environments.md). Persistence acknowledgment: [environment schemas](../packages/experiments/src/managed-environment.ts) define independent version-1 manifests, references, receipts and Host observations; optional `reusePlans` and `materials` add plans and dated material descriptors, with separate material/resolution indexes and startup journals. Cleanup adds the `material` candidate kind. `ControllerStatus.features` and `PreparedEnvironment.requiredFeatures` are optional capability fields; a selected manifest with `asperaEnvironmentTools.reuseVersion: 1` requires `managed-environment-reuse-v1` before controller reuse or handover. Old observations remain readable and fleet generation 6, protocol 4, Session events and fixed submissions remain unchanged. Generated Remote consumers update together.

`experimentExecutionProgress` reads the pinned coordinator's current plan reports and explicitly marks unsupported old releases. It validates experiment, plan and execution Session ownership without updating the remote release.

`experimentSnapshot` and reconnect snapshots include `installations`, with current per-node progress and previous recovery rounds. Attempts retain delivered source-warning categories, original sequence numbers and collection times; replay and application restart do not repeat their diagnosis. `retryPreparation` returns `{ record, installations }`. Custom `ExperimentFleet.open` callers may pass validated installation limits after the complete driver; omission resolves the published defaults. The preparation Agent uses scoped inspect, probe and switch-source tools followed by program verification. Normal polling reads saved state without waking a model.

Use [AsperaRemote](../packages/dispatch/src/index.ts) and generated `@aspera/dispatch/remote` descriptors. `previewExperimentDeletion` separates `recordDeletionAvailable` from remote `eligible`/`cleanupAvailable`; `previewServerRemoval` lists retained work. `deleteExperiments` and `removeServer` accept explicit acknowledgements for unfinished local removal. `experimentSnapshot`/`watch` include `deletedIds`, `removedServerIds` and `unconfirmedWork`; reconnect retains these identities and source cursors. `reconcileRemovedWork` performs a bounded read-only ownership check; `probeServer` includes it within the shared connection deadline. Checks retain dated status, configuration, results and last success; SSH, GPU and control readiness remain separate. Other methods cover models, credentials, staging, creation, retries, decisions, cancellation, logs, files and services. Agent tools share `ExperimentFleet` preparation.

`ClusterQueue` consumes a validating `ExperimentTable` and process-owning `ClusterExecutor`. `ExperimentFleet.open` accepts a connection-check deadline and a complete `FleetDriver`; production uses password SSH and host-key verification. A provider owns transfer, probes, credentials and authenticated operations together. CPU test providers are explicit test fixtures and are excluded from release archives.

Control APIs require private bearer credentials and listen on loopback. The Host accesses remote controls through managed SSH connections. When a node's fixed identity equals the coordinator identity, the coordinator uses its authenticated loopback node endpoint directly; other nodes retain SSH transport. Password queries return only presence/writability; passwords are stored by DSH credentials and copied into restricted coordinator files for allocated-node control. No model requirement, receipt or ordinary browser query returns plaintext. Only `revealServerPassword(id)` explicitly reads it for the current editor, without logging or browser persistence.

-----

<a id="execution-step-progress"></a>
## Execution step progress

Checkpoint persistence acknowledgment: [retention records](../packages/runtime/src/checkpoint-protection.ts) add private version-1 `checkpoint-protection-v1/registrations` and `sealed` files in each node run. They bind the original experiment/node, approved stage, attempt, command, required recovery directory and observed file identities. Read-only archive discovery includes both record kinds; experiment-owned deletion removes them with the run. Mount IDs are checked live and never retained as restart authorization. Protocol 4, fleet 6, Session formats and original stage records remain unchanged; older fixed releases have no implied checkpoint protection.

Persistence type acknowledgment: [execution progress schemas](../packages/experiments/src/execution-progress.ts) add an independent version-1 file in the coordinator's owned experiment run directory. Reports bind experiment ID, approved plan revision, one-based step and execution Session. The file stores its own revision, per-step state, short detail, call ID and program timestamp. Existing plans, `progress.json`, fleet generation `6`, remote protocol/storage `4` and Session events remain unchanged. Experiment-owned cleanup removes this file with its run directory.

An absent file reads as pending steps at revision zero without writing. Authenticated execution workers report running, completed or blocked through the coordinator; the model cannot select experiment, Session, call identity or coordinator generation. Synchronous validation and atomic rename reject concurrent overwrites, old plans, wrong Sessions and paused or ended work. Identical retries do not increment revisions. Blocked steps may resume; completed steps cannot reopen. Conflicts return the current readable revision for repair. Corrupt or mismatched saved files fail explicitly and remain retained.

Tools and diagnostics use existing Session messages and tool events. Completion requires all approved steps reported completed plus the existing independent command, node and result checks. Old experiments keep their fixed release; a missing API displays unrecorded progress rather than changing the release or inferring completion. A missing remote experiment is a read failure, not an unsupported API. The console retains the last successful read and its time after errors, distinguishes first-read failure, ignores replies after selection changes or deletion and stops activity animation when the experiment stops.

-----

<a id="experiment-interruption"></a>
## Controlled interruption

Interruption persistence acknowledgment: [interruption schemas](../packages/experiments/src/interruption.ts) define independent version-1 journals at `$DSH_HOME/aspera-interruptions/<experimentId>.v1.json` and each original run directory's `interruption.v1.json`. They bind the operation, original submission hash, trigger, phases, node exit evidence, failures and confirmed result. Fleet generation 6, submission protocol 4, Session events, releases, plans and hardware requirements remain unchanged. Linux command launch writes a private `process-identities/<commandId>.v1.json` before executing the existing sandbox arguments; PID, process-group, start ticks and host boot identity support account-owned stopping without invented exit codes.

`interruptExperiment(id)` commits the request before Host-owned work begins. `experimentInterruptionStatus(id)` is read-only; snapshots include `interruptions`. Duplicate requests reuse the operation. Blocked retries recheck actual evidence. Transport interruption, timeout and Host shutdown retain `resumeVerification`; restart reads remote receipts and actual exits before further stopping. Confirmed remote release is reused without another stop. Shutdown waits for reads and writes; deletion waits for the operation and retains unresolved recovery journals. Tombstones reject late replies. Switching pages or hiding the window does not stop the operation. `cancelExperiment` keeps its return type and waits for the same release checks.

Online interruption uses the original authenticated cancellation and node-release APIs after fencing new work for that experiment. Offline SSH checks the fixed submission, owned directories, exact process identities, all original commands and service listeners. Only confirmed experiment processes can receive TERM and configured escalation. Missing legacy identities, unavailable nodes, PID reuse or unreadable evidence retain ownership. Complete node release precedes overall release. A user's stop uses `cancelled`; automatic recovery of an exited controller's started task uses `interrupted`. Trusted terminal outcomes are retained. Queued and awaiting-approval tasks require manual interruption; automatic preparation recovery cannot stop active work or operate on unselected servers.

Preparation keeps `repair_preparation_controller`: the program selects eligible old tasks, reports their receipts and requires complete revalidation before handover. No tool accepts model-selected process IDs or ledger edits. The console shows interruption progress, blocked exit verification and retry, while keeping logs, trajectory, files and copying available. Read-only connection checks remain model-free and limited to 20 seconds.

-----

<a id="remote-task-settlement"></a>
## Remote task settlement

Persistence acknowledgment: [remote-task schemas](../packages/dispatch/src/remote-task.ts) add independent `aspera_remote_tasks` version `1`, without rewriting fleet generation 6, deletion journals, submission protocol 4 or Session events. Minimal identities retain the submission digest, node connections and confirmed terminal-release metadata. Full Goals and model credential values are not copied into these identities. Existing interruption journals supply the operation and exit evidence after local experiment deletion.

`remoteTaskStatus(id)` returns credential-free progress without transport. `settleRemoteTask({taskId, mode})` commits `reconcile` or explicit `interrupt` intent before background work. Preparation's existing controller repair resolves visible and deleted tasks through the same interruption module. Historical deletion markers can recover an account-owned original submission only after checking its coordinator, allocation, digest, release and registered node accounts. Missing evidence retains occupancy. All original nodes must be verified; preparation cannot expand its selected server scope.

Reconciliation never stops active work. A started task can become `interrupted` only when the original coordinator exited and all original work is confirmed stopped; a trusted terminal result is preserved. Explicit interruption can stop only verified owned processes and retains `cancelled`. Complete node evidence and durable receipts precede overall release. Shared environments, models, data, logs and fixed releases remain retained. No training restarts automatically. Deleted rows stay deleted, while server cards expose pending release, verification, interruption and retry.

<a id="local-running-records"></a>
## Local running records

The management profile copies accepted protocol-4 experiments independently of page visibility. Hiding the window or changing pages leaves synchronization active. Exiting Aspera stops local reads and awaits committed writes; opening it resumes from the durable cursor. No separate operating-system service is installed. Preparation retains its existing local Session and installation records.

Archive persistence acknowledgment: [public status schemas](../packages/experiments/src/archive.ts) and the [private version-1 index](../packages/dispatch/src/run-archive-store.ts) introduce `$DSH_HOME/aspera-run-records/<experimentId>/manifest.v1.json` and immutable SHA-256 JSON blocks. The index binds the fixed submission, nodes, phases, Sessions, source generations, original sequences, remote byte positions and separate local page positions. Blocks are verified and durably written before atomic index publication. Partial JSON waits for completion; duplicates retain their original identities. Replacement and truncation preserve earlier copies and record gaps. Fleet generation 6, protocol 4, existing step files and released Session formats remain unchanged.

Authenticated fixed-release reads are preferred. If control is unavailable, the [read-only SSH helper](../packages/dispatch/scripts/read-archive.mjs) verifies the run owner and saved submission, then reads corresponding regular files without following symlinks. It never starts controllers, repairs or training. The configured login for the same selected server can change; the original release, directories, hardware requirements and submission cannot. Credentials and labeled secrets are removed before writing copies. Missing remote history and expired measurement windows remain gaps; missing values are never fabricated.

`experimentArchiveStatus(id)` reports overall/source state, last attempt and successful round, saved/pending bytes, gaps and redacted errors. A successful check updates `lastSyncedAt` even when no new bytes exist; an in-progress check retains the previous result. `syncExperimentArchive(id)` schedules an immediate read-only retry, coalesces an active round and never resumes execution. Trace, command, log, metric and step APIs prefer committed copies; uncopied content retains remote access. Offline attachments require reconnection. Saved state retains its original timestamp. Successful local reads cannot clear remote connection failures.

Configure `aspera-dispatch` in the management profile. The [resolved policy](../packages/dispatch/src/run-archive-reader.ts) validates these settings; custom `ExperimentFleet.open` callers can pass it after the SSH connection policy.

| Settings | Defaults | Purpose |
| --- | --- | --- |
| `archiveEnabled`, `archiveIntervalMs` | `true`, `15000` | Enable copying and delay after an ordinary successful round |
| `archiveBacklogIntervalMs`, `archiveWaitingIntervalMs` | `5000`, `30000` | Delay with unread tails, or while caught up and awaiting approval/reply |
| `archiveReadBytes`, `archiveBatchPages` | `65536`, `16` | Bounded pages and continuous catch-up rounds |
| `archiveRetryMinMs`, `archiveRetryMaxMs` | `10000`, `60000` | Failed-read exponential backoff |
| `archiveRequestTimeoutMs`, `archiveMetricGapMs` | `20000`, `900000` | Read deadline and missing-metric interval threshold |
| `archiveMinimumFreeBytes` | `1073741824` | Reserve before each block/index write |
| `archiveCatalogEntries`, `archiveCatalogBytes` | `10000`, `8388608` | Discovery and response limits |
| `archiveLogPatterns` | `**/*.log`, `**/logs/**/*.txt`, `**/logs/**/*.jsonl` | Workspace training-text selection |
| `archiveExcludeDirectories` | Dependencies, environments, models, datasets and caches | Directory names skipped during scanning |

Each delay starts after its round finishes. Unread tails take precedence over the waiting interval. Failures retry after 10, 20, 40 and then 60 seconds by default; a successful round resets backoff. Reads serialize per server. Disk exhaustion or write errors pause synchronization without changing results or removing existing data; recovery resumes from the committed index. A terminal resource release requests a final round. Automatic reads stop only after all nodes have been read, current tails are copied and all known commands are confirmed released. Missing history remains visible and does not cause endless attempts to recover unavailable data. Reopening the Host rechecks final records once; explicit synchronization remains available. EOF means caught up, not training success or complete evidence. Copies persist until experiment deletion. Deletion saves its tombstone, aborts and awaits all owned reads, then removes the copy; late replies cannot publish data. [Archive regressions](../packages/dispatch/tests/run-archive.spec.ts) cover these timings and ownership rules.

-----

<a id="logs-outputs-and-services"></a>
## Logs, outputs and services

`experimentTrace` binds pages to experiment, phase, Session and original sequence. Preparation reads the local dispatch Session; planning/execution read their saved remote Sessions. Large remote events use digest-checked fragments before reaching the official assembler. `experimentTraceEvent` and `experimentTraceAttachment` require exact event ownership; attachments must be referenced by that event and pass the published attachment provider's content checks. Missing or truncated legacy payloads are identified explicitly and never parsed as complete events. The read-only factory does not register remote experiments as ordinary editable Sessions.

`experimentLogSources`, `experimentLog`, `downloadExperimentLog` and `experimentMetrics` expose actual registered sources and measurements. New source manifests and JSONL records retain experiment/node/source identities, output stream, collection time and sequence. Cursors also bind file generation; incomplete tails wait, and replacement/missing files are explicit. Preparation and Agent output is captured before tool-result truncation. Registered managed commands capture stdout/stderr independently; old mixed files keep unknown times and streams. Known credentials and labeled secrets are redacted before publication. Download tickets expire, are consumed once and reject generation changes; displayed history and incoming tails are bounded separately.

Node `observations` settings default to `intervalMs: 2000`, `historyMs: 900000`, `readBytes: 65536` and `metricSamples: 1000`. Console polling, chart retention and read/cache limits are independently configurable in [Config](../packages/console/src/config.ts). Resource samples use OS counters and `nvidia-smi`; training values come only from `report_experiment_progress`. Absent data stays absent. Disconnects retain the last dated values and leave chart gaps. Unsupported pinned runtimes expose their available legacy logs without creating new measurements. Error fingerprints persist independently of task and source health; a successful local snapshot cannot clear a remote failure.

Output APIs list relative paths, node identity, size and modification time. Downloads use one-use expiring tickets and bounded reads; path traversal, symlink escape and a file generation change are rejected. A disconnected download aborts its upstream read. Ordinary output files and binary attachments remain on-demand downloads.

Services have an independent UUID, owning experiment/node, model path, command identity, loopback port, health endpoint and cleanup state. Only legacy records carry a service deadline. Starting requires an unused port; health requires a live managed process and an actual successful HTTP check. Private access supports bounded GET/POST requests. Optional `inferenceMapping` settings freeze the platform HTTPS base URL and mapped port in the server snapshot. `start_inference_service(publish=true)` opens a Bearer-authenticated listener on that mapped port and forwards GET/HEAD/POST streams to the loopback model; the model port must differ from the mapping and control ports. The node checks the external URL using the service/experiment identity and a fresh nonce, and stores `external.state` independently from local health. Redirects are rejected. These node-origin checks do not guarantee reachability from every caller network. Service keys live in private node files outside the Agent workspace, never in receipts, logs or Agent tool results. Only the explicit operator Remote `serviceAccessInfo` returns the service key. Stopping, cancellation and process exit close the public listener. Node restart never recreates an unverified listener. Stop/cancel retains allocation until managed cleanup is confirmed; unexpected exit is terminal and never restarts automatically.
