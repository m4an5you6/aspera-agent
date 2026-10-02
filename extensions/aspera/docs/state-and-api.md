# State and APIs

English | [中文](state-and-api.zh.md)

## Summary

Aspera extension `0.2.0` writes protocol generation `2` and reads released generation `1` without changing its content hashes or limits. Its generated DSH Remote uses the `aspera` namespace; new authenticated control traffic uses `/aspera/v2`. Exact fields and branded IDs are declared in the [protocol](../packages/experiments/src/cluster-protocol.ts) and [dispatch types](../packages/dispatch/src/types.ts).

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
| Management Host | `aspera_fleet` / `2` | Server registry, fixed coordinator ID, pinned dispatch requirements and complete receipts |
| Remote coordinator | `aspera_queue` / `2` | Admission order, plans, approvals, allocations, execution identities, progress and services |
| Node control | `aspera_node` / `2` | Node allocation, command identity, cleanup evidence and registered service facts |

These storage domains declare version `2` with compatible reads of version `1`. Legacy optional limits remain in readers, not new requests. Old queued or approval-pending work is never executed by the new release; allocated work retains its original release until completion and confirmed cleanup. New controls refuse replacement of active incompatible processes. No DSH Session format or event payload changes are introduced: questions and replies use existing tool calls/results, and continuation uses logged Goal edits.

Submissions freeze the objective, server definitions, node grants, inputs/digests, execution mode, DSH/extension versions and release identity; dispatch records also capture the model provider, model and reasoning effort. Protocol `2` has no aggregate runtime, command, round or service budget. An experiment UUID with identical content is an idempotent retry; different content under that UUID fails. Editing server or model settings affects new experiments only. Input upload retries must contain the same bytes, and all declared upload sizes must match before commit.

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

Use [AsperaRemote](../packages/dispatch/src/index.ts) and its generated `@aspera/dispatch/remote` descriptor for the Web page or an external DSH client. Unary methods cover server/password writes, input staging, creation, query/refresh, plan approval, `answerExperimentQuestion`, cancellation, logs, files and service access/stop. `watch` streams fresh durable snapshots including questions; after reconnect the client accepts the newest snapshot and retains per-source byte cursors. Agent dispatch tools and these methods share `ExperimentFleet`. Budget defaults and budget submission parameters are not part of the new API.

`ClusterQueue` consumes a validating `ExperimentTable` and process-owning `ClusterExecutor`. `ExperimentFleet.open` accepts a complete `FleetDriver`; production uses password SSH and host-key verification. A provider owns transfer, probes, credentials and authenticated operations together. CPU test providers are explicit test fixtures and are excluded from release archives.

Control APIs require private bearer credentials and listen on loopback. The Host and coordinator access them through managed SSH connections. Password queries return only presence/writability; passwords are stored by DSH credentials and copied into restricted coordinator files for allocated-node control. No model requirement, receipt or browser query returns their plaintext.

-----

<a id="logs-outputs-and-services"></a>
## Logs, outputs and services

Reads identify an experiment, source/node, generation and byte offset. The reply includes raw base64 bytes, the next offset, EOF and a reset flag. Missing or rotated data resets the cursor and is shown explicitly; separate UTF-8 decoders reconstruct node logs. Conversation envelopes include Session ID and source, so equal sequence numbers from planning and execution remain distinct. Incomplete JSONL lines wait for continuation.

Output APIs list relative paths, node identity, size and modification time. Downloads use one-use expiring tickets and bounded reads; path traversal, symlink escape and a file generation change are rejected. A disconnected download aborts its upstream read. File contents are not synchronized by default.

Services have an independent UUID, owning experiment/node, model path, command identity, loopback port, health endpoint and cleanup state. Only legacy records carry a service deadline. Starting requires an unused port; health requires a live managed process and an actual successful HTTP check. Access supports bounded private GET/POST requests without automatic public exposure. Stop/cancel retains allocation until managed cleanup is confirmed; unexpected exit is terminal and never restarts automatically.
