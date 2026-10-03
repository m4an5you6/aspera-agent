# State and APIs

English | [中文](state-and-api.zh.md)

## Summary

Aspera extension `0.1.1` writes protocol and storage generation `4` and reads released generations `1`–`3` without changing their versions, hashes or limits. Generated DSH Remote methods use the `aspera` namespace; authenticated control traffic uses `/aspera/v4`. Fields and branded IDs are declared in the [protocol](../packages/experiments/src/cluster-protocol.ts), [storage observations](../packages/experiments/src/storage-protocol.ts) and [dispatch types](../packages/dispatch/src/types.ts).

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
| Management Host | `aspera_fleet` / `4` | Server preferences, last SSH inventory, fixed coordinator, saved storage decisions, dispatch requirements and receipts |
| Remote coordinator | `aspera_queue` / `4` | Admission order, plans, approvals, allocations, execution identities, progress and services |
| Node control | `aspera_node` / `4` | Node allocation, command identity, cleanup evidence and registered service facts |

These domains declare version `4` with compatible reads of `1`–`3`. Protocol `1` retains its `0.1.0` extension version and optional limits; protocol `2` retains `0.2.0`, and protocol `3` retains `0.1.1`. Old pending work stays on its original runtime, and incompatible controllers are replaced only after tasks end and cleanup is confirmed. No DSH Session format or event changes are introduced: inventory, storage selections, handover, questions and replies use existing logged messages/tools and Goal operations.

Server preferences and resolved deployments are separate. A new request freezes its short name, objective, servers, three phase model configurations, private credential references, mode and policy; preparation freezes input hashes, observed mount identities, control/release/workspace paths, selection reasons and verified network addresses. Protocol `4` has no aggregate task budget. Identical UUID/content is an idempotent retry; changed content fails. Interrupted generation-4 preparation resumes its saved paths, while missing Sessions, changed mounts, inputs or releases fail explicitly. Old unfinished preparation must be copied.

Phase snapshots record the provider, model, reasoning choice, pinned adapter version and a digest/reference for private API configuration. Only supported key APIs are transferable: official DeepSeek and pi-ai key providers, including OpenAI-compatible Qwen. Unsupported authentication is refused before admission. Each Agent mounts its own provider scope; global settings changes and retries cannot replace it. Keys and raw headers remain outside public records.

The coordinator writes ownership before scheduling. A queue-record loss with retained execution evidence requires operator reconciliation rather than resubmission. After restart, verified drained commands can release a node; any unverified managed range retains it. Inspect and stop uncertain processes on the affected node before repairing its allocation records; the page does not offer a force-release button.

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

Use [AsperaRemote](../packages/dispatch/src/index.ts) and generated `@aspera/dispatch/remote` descriptors. Unary methods cover server/password writes, `probeServer` inventory without model use, input staging, creation, the model directory and submission validation, `retryPreparation`, refresh, approval, questions, cancellation, logs, files and services. `watch` streams saved inventories, preparation stages, placements and remote receipts; reconnect starts with current records and retains per-source byte cursors. Agent tools use the same `ExperimentFleet` preparation service.

`ClusterQueue` consumes a validating `ExperimentTable` and process-owning `ClusterExecutor`. `ExperimentFleet.open` accepts a complete `FleetDriver`; production uses password SSH and host-key verification. A provider owns transfer, probes, credentials and authenticated operations together. CPU test providers are explicit test fixtures and are excluded from release archives.

Control APIs require private bearer credentials and listen on loopback. The Host and coordinator access them through managed SSH connections. Password queries return only presence/writability; passwords are stored by DSH credentials and copied into restricted coordinator files for allocated-node control. No model requirement, receipt or browser query returns their plaintext.

-----

<a id="logs-outputs-and-services"></a>
## Logs, outputs and services

Reads identify an experiment, source/node, generation and byte offset. The reply includes raw base64 bytes, the next offset, EOF and a reset flag. Missing or rotated data resets the cursor and is shown explicitly; separate UTF-8 decoders reconstruct node logs. Agent pages bind experiment, phase, Session and sequence. Preparation reads the local dispatch Session; planning/execution read their saved remote Sessions. Missing historical events are reported explicitly. Process cursors additionally bind node, command and stdout/stderr; tools link to that command. Conversation envelopes retain Session ID and source, so equal sequence numbers remain distinct. Incomplete JSONL lines wait for continuation.

Output APIs list relative paths, node identity, size and modification time. Downloads use one-use expiring tickets and bounded reads; path traversal, symlink escape and a file generation change are rejected. A disconnected download aborts its upstream read. File contents are not synchronized by default.

Services have an independent UUID, owning experiment/node, model path, command identity, loopback port, health endpoint and cleanup state. Only legacy records carry a service deadline. Starting requires an unused port; health requires a live managed process and an actual successful HTTP check. Private access supports bounded GET/POST requests. Optional `inferenceMapping` settings freeze the platform HTTPS base URL and mapped port in the server snapshot. `start_inference_service(publish=true)` opens a Bearer-authenticated listener on that mapped port and forwards GET/HEAD/POST streams to the loopback model; the model port must differ from the mapping and control ports. The node checks the external URL using the service/experiment identity and a fresh nonce, and stores `external.state` independently from local health. Redirects are rejected. These node-origin checks do not guarantee reachability from every caller network. Service keys live in private node files outside the Agent workspace, never in receipts, logs or Agent tool results. Only the explicit operator Remote `serviceAccessInfo` returns the service key. Stopping, cancellation and process exit close the public listener. Node restart never recreates an unverified listener. Stop/cancel retains allocation until managed cleanup is confirmed; unexpected exit is terminal and never restarts automatically.
