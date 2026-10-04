# State and APIs

English | [中文](state-and-api.zh.md)

## Summary

Aspera extension `0.1.1` uses remote protocol `4` and local fleet storage generation `6`, retaining compatible reads of released records without changing their identities, hashes or limits. Generated DSH Remote methods use the `aspera` namespace; authenticated control traffic uses `/aspera/v4`. Fields and branded IDs are declared in the [protocol](../packages/experiments/src/cluster-protocol.ts), [storage observations](../packages/experiments/src/storage-protocol.ts) and [dispatch types](../packages/dispatch/src/types.ts).

## Table of Contents

- [Persistent ownership](#persistent-ownership)
- [Receipts and Goals](#receipts-and-goals)
- [API consumers](#api-consumers)
- [Logs, outputs and services](#logs-outputs-and-services)

-----

<a id="persistent-ownership"></a>
## Persistent ownership

| Owner | Domain/version | Durable records |
| --- | --- | --- |
| Management Host | `aspera_fleet` / `6` | Server preferences, SSH/environment observations, verified program paths, node stages, pending commands, storage decisions, requirements and receipts |
| Remote coordinator | `aspera_queue` / `4` | Admission order, plans, approvals, allocations, execution identities, progress and services |
| Node control | `aspera_node` / `4` | Node allocation, command identity, cleanup evidence and registered service facts |

The local fleet domain reads generations `1`–`5`; remote domains remain generation `4` with compatible reads of `1`–`3`. Protocol `1` retains extension version `0.1.0` and optional limits; protocol `2` retains `0.2.0`, and protocol `3` retains `0.1.1`. Pending work stays on its original runtime; incompatible controllers wait for task completion and confirmed cleanup. Environment diagnostics, preparation tools, storage choices and receipts use existing Session messages/tool events and Goal operations, without changing the Session format.

Server preferences and resolved deployments are separate. Creation freezes the name, objective, selected coordinator, servers, phase models, credential references, mode and policy; preparation saves input hashes, mounts, directories, executable paths, storage reasons and network addresses. Protocol `4` has no aggregate task budget. Retry checks remote acceptance before configuration and retains the UUID, Session and original release after a local upgrade. Missing Sessions, missing/mismatched remote manifests or entrypoints require a copied experiment; changed mounts or inputs fail explicitly. Pending commands require exit evidence before further mutations. Generation-1–3 unfinished preparations must be copied.

Phase snapshots record the provider, model, reasoning choice, pinned adapter version and a digest/reference for private API configuration. Only supported key APIs are transferable: official DeepSeek and pi-ai key providers, including OpenAI-compatible Qwen. Unsupported authentication is refused before admission. Each Agent mounts its own provider scope; global settings changes and retries cannot replace it. Keys and raw headers remain outside public records.

The coordinator writes ownership before scheduling. A queue-record loss with retained execution evidence requires operator reconciliation rather than resubmission. After restart, verified drained commands can release a node; any unverified managed range retains it. Inspect and stop uncertain processes on the affected node before repairing its allocation records; the page does not offer a force-release button.

Generation-6 persistence acknowledgment: the frozen [generation-5 reader](../packages/dispatch/src/fleet-schema-v5.ts) retains earlier requests and remote submissions. New local requests require a selected `coordinatorId`; `registry.checks`, `deletions` and `deleted` store management observations and removal identities. Remote payload hashes and released records are never rewritten. Fleet behavior and storage tests exercise legacy reads, interrupted checks, cleanup retries, ownership rejection and tombstone deduplication.

Deletion first requires terminal state and confirmed process/resource release. Its durable operation identity fixes the cleanup choice. Node progress retains successful removals across retries; an interrupted job is marked failed and can resume on request. Optional cleanup verifies the saved mount and owner, refuses nested mounts, quarantines the exact run directory and unlinks nested symlinks without following them. Only registered private transfer files are removed outside that run. Shared releases, control state, user originals and ordinary DSH Sessions remain. After cleanup, local uploaded copies and unreferenced owned credentials are removed; a minimal tombstone prevents late RPCs or reused Goal identities from restoring the record. A failed cleanup retains the experiment and permits a new explicit record-only operation.

-----

<a id="receipts-and-goals"></a>
## Receipts and Goals

`receipt` preserves the complete initial acceptance; `latest` tracks the current remote record. Both contain the exact `handover` value **本机派发完成，远端实验已接管**. Acceptance means source, inputs and required credentials were transferred and the coordinator owns the task; it does not promise that training started. Execution Session/Goal IDs are added after allocation and Agent startup.

The Host persists the complete receipt before appending the handover message and finishing the dispatch Goal. Goal completion compares the saved ID and revision; an edited or replaced Goal is not completed by an old response. Browser experiments create separate Sessions, leaving ordinary conversation `/goal` semantics intact.

Semi-mode confirmation references the displayed plan revision. Duplicate confirmation of that revision is idempotent; a different revision fails. Submitted requirements cannot be edited in place. New requirements use a new experiment and approval. Automatic policy confirmation is stored separately from user confirmation.

A semi-mode question binds its experiment, Session, tool call and immutable question revision. The coordinator persists it before the Goal pauses; active managed processes remain monitored. A reply is validated and saved before delivery to the original call and resumption of the same Goal. Identical reply retries are idempotent; conflicts, expired questions and cancelled or interrupted tasks cannot resume execution. Restart reports pending questions as interrupted and expires them rather than replaying the tool.

-----

<a id="api-consumers"></a>
## API consumers

Use [AsperaRemote](../packages/dispatch/src/index.ts) and generated `@aspera/dispatch/remote` descriptors. Unary methods include `experimentSnapshot`, `previewExperimentDeletion`, `deleteExperiments`, explicit password reveal, server/password writes, read-only `probeServer` without model use, input staging, creation, model selection, `retryPreparation`, refresh, approval, questions, cancellation, logs, files and services. Checks return `status`, `configuration`, start/finish times, `result` and dated `lastSuccess`. Successful SSH can report `result.environmentReady: false` or omit `result.inventory`; GPU and control readiness remain separate. A failed check does not present historical hardware as current connectivity. `watch` includes node environment phases, program paths, diagnostics, placements and receipts; reconnect starts with saved records and retains source cursors. Agent tools share `ExperimentFleet` preparation.

`ClusterQueue` consumes a validating `ExperimentTable` and process-owning `ClusterExecutor`. `ExperimentFleet.open` accepts a complete `FleetDriver`; production uses password SSH and host-key verification. A provider owns transfer, probes, credentials and authenticated operations together. CPU test providers are explicit test fixtures and are excluded from release archives.

Control APIs require private bearer credentials and listen on loopback. The Host and coordinator access them through managed SSH connections. Password queries return only presence/writability; passwords are stored by DSH credentials and copied into restricted coordinator files for allocated-node control. No model requirement, receipt or ordinary browser query returns plaintext. Only `revealServerPassword(id)` explicitly reads it for the current editor, without logging or browser persistence.

-----

<a id="logs-outputs-and-services"></a>
## Logs, outputs and services

Reads identify an experiment, source/node, generation and byte offset. The reply includes raw base64 bytes, the next offset, EOF and a reset flag. Missing or rotated data resets the cursor and is shown explicitly; separate UTF-8 decoders reconstruct node logs. Agent pages bind experiment, phase, Session and sequence. Preparation reads the local dispatch Session; planning/execution read their saved remote Sessions. Missing historical events are reported explicitly. Process cursors additionally bind node, command and stdout/stderr; tools link to that command. Conversation envelopes retain Session ID and source, so equal sequence numbers remain distinct. Incomplete JSONL lines wait for continuation.

Output APIs list relative paths, node identity, size and modification time. Downloads use one-use expiring tickets and bounded reads; path traversal, symlink escape and a file generation change are rejected. A disconnected download aborts its upstream read. File contents are not synchronized by default.

Services have an independent UUID, owning experiment/node, model path, command identity, loopback port, health endpoint and cleanup state. Only legacy records carry a service deadline. Starting requires an unused port; health requires a live managed process and an actual successful HTTP check. Private access supports bounded GET/POST requests. Optional `inferenceMapping` settings freeze the platform HTTPS base URL and mapped port in the server snapshot. `start_inference_service(publish=true)` opens a Bearer-authenticated listener on that mapped port and forwards GET/HEAD/POST streams to the loopback model; the model port must differ from the mapping and control ports. The node checks the external URL using the service/experiment identity and a fresh nonce, and stores `external.state` independently from local health. Redirects are rejected. These node-origin checks do not guarantee reachability from every caller network. Service keys live in private node files outside the Agent workspace, never in receipts, logs or Agent tool results. Only the explicit operator Remote `serviceAccessInfo` returns the service key. Stopping, cancellation and process exit close the public listener. Node restart never recreates an unverified listener. Stop/cancel retains allocation until managed cleanup is confirmed; unexpected exit is terminal and never restarts automatically.
