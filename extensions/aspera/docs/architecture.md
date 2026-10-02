# Aspera architecture

English | [中文](architecture.zh.md)

## Summary

Aspera owns experimental work outside the Harness source tree. Published DSH supplies composition, Agents, Goals, Sessions, credentials, subprocess management and Web slots; Aspera supplies task records, scheduling, remote execution and management views.

## Table of Contents

- [Components](#components)
- [Architecture diagrams](#architecture-diagrams)
- [Execution and ownership](#execution-and-ownership)
- [Extension points](#extension-points)

-----

<a id="components"></a>
## Components

| Package | Owns | Integration |
| --- | --- | --- |
| `@aspera/experiments` | Versioned requests, whole-group scheduling, logs and artifact access | `ExperimentTable` and `ClusterExecutor` |
| `@aspera/runtime` | Persistent control roles, confined node processes, planning/execution Agents and framework guidance | Published DSH profile services |
| `@aspera/dispatch` | Server registry, input staging, release transfer, independent dispatch Sessions and generated Remotes | `ExperimentFleet` and `FleetDriver` |
| `@aspera/console` | Sidebar page, forms, record stream and per-source log cursors | Published Web slots, locale dictionaries and Remote descriptors |
| `@aspera/desktop` | Independent window, tray and local profile lifecycle | Electron and a published `dsh` profile |

Host programs compile against installed package declarations. The Typert shim in [types/typert-protocol.d.ts](../types/typert-protocol.d.ts) belongs only to the generator program and exposes the registration metadata its analysis needs. Browser wrapping in [tsdown.config.ts](../packages/console/tsdown.config.ts) contains Cordis-compatible CommonJS module loading and CSS insertion; the compiled public client declarations remain separate from the JavaScript bundle.

-----

<a id="architecture-diagrams"></a>
## Architecture diagrams

Desktop and browser share the page and task service. The remote coordinator owns execution after durable handover; the local carrier does not own GPU processes.

```mermaid
flowchart TB
  subgraph Local[Local management]
    Desktop[Aspera Electron desktop] --> Page[DSH Web + Aspera console]
    Browser[Web browser] --> Page
    Page --> Remote[Typed Remote: RPC + streams]
    Remote --> Fleet[Aspera dispatch: fleet / credentials / Sessions]
  end
  subgraph Coordinator[First server: durable coordinator]
    Queue[Aspera experiments: queue / plans / resource groups]
    Planner[Read-only planning Agent]
    Executor[Independent execution Agent]
    Queue --> Planner
    Queue --> Executor
  end
  Fleet -- SSH: pinned release / inputs / credentials --> Queue
  Queue -- receipt / state / logs / files --> Remote
  subgraph Nodes[Selected Linux GPU nodes]
    NodeA[Node A control profile] --> RunA[Isolated environment / managed commands]
    NodeB[Node B control profile] --> RunB[Isolated environment / managed commands]
    RunA --> Frameworks[Megatron / MS-SWIFT / Unsloth]
    RunB --> Frameworks
    RunA --> Service[Registered inference services]
  end
  Executor -- SSH tunnel + private HTTP --> NodeA
  Executor -- SSH tunnel + private HTTP --> NodeB
  Frameworks -- metrics / artifacts --> Queue
  Service -- health / resource occupancy --> Queue
```

Handover completes the original dispatch Goal. Confirmation, whole-group allocation, execution and inference-service lifetime remain remote experiment states.

```mermaid
sequenceDiagram
  actor User
  participant UI as Desktop / Web page
  participant Fleet as Local dispatch
  participant Queue as Remote coordinator
  participant Agent as Planning / execution Agent
  participant Node as Selected GPU nodes
  User->>UI: Submit Goal and server group
  UI->>Fleet: Create independent experiment
  Fleet-->>UI: Preparing; another Goal can be submitted
  Fleet->>Queue: Fixed release, inputs and private credentials
  Queue->>Queue: Validate and persist admission
  Queue-->>Fleet: Full handover receipt
  Fleet->>Fleet: Persist receipt; finish matching Goal ID + revision
  Fleet-->>UI: Local dispatch complete; remote experiment accepted
  Queue->>Agent: Prepare framework plan without GPU reservation
  Agent-->>Queue: Persist versioned plan
  opt Semi-automatic mode
    UI->>Fleet: Confirm this plan revision
    Fleet->>Queue: Persist confirmation
  end
  Queue->>Queue: FIFO; allocate the entire free server group
  Queue->>Agent: Start independent execution Session + Goal
  Agent->>Node: Prepare experiment environment; run scoped commands
  Node-->>Queue: Logs, metrics, artifacts and service health
  Queue-->>Fleet: Incremental state and file metadata
  Fleet-->>UI: Reconnectable streams; files downloaded on demand
  opt Semi-automatic unresolved decision
    Agent->>Queue: Save question with Session / tool call / revision
    Agent->>Agent: Pause same Goal; managed commands remain monitored
    Queue-->>UI: Saved question and attention count
    UI->>Queue: Persist validated reply
    Queue-->>Agent: Deliver to original call; resume same Goal
  end
  Note over Queue,Node: Accepted work continues after the local application quits
```

-----

<a id="execution-and-ownership"></a>
## Execution and ownership

The management Host fixes a request and transfers a content-addressed release, input digests and private credentials. The coordinator validates the materials before persisting acceptance. Preparation Agents use private per-experiment profiles without node command tools. Approval makes a task eligible for allocation; all selected nodes are assigned together before communication and input checks.

Execution Agents are separate profile processes. Their tools call authenticated node controls that own durable allocation and command identities. Each node exposes only its granted devices, hides control credentials and state, mounts the experiment workspace writable, and mounts the remaining filesystem read-only. Network access is shared for dependency downloads and training communication; this is not network isolation. Framework environments are created inside the writable experiment directory.

Registered inference processes belong to node controls rather than the execution Agent. Ending the Goal or disconnecting the browser leaves services alive and the full allocation occupied. Coordinator restart resumes service observation; ambiguous training or node-process identity becomes interrupted and retains unconfirmed allocations. Cancellation only frees a group after every node confirms cleanup.

Every release has immutable DSH/extension versions, package files and a frozen production lockfile. New deployments use new directories; profile identities reject rebinding a worker home to another release. Active control processes are reused without replacement. An incompatible control-protocol upgrade waits for old tasks to finish and the old controls to stop before activation.

The runtime extends finite Goal windows through the public Goal service, preserving one execution Session and Goal. Automatic mode rejects human waiting; semi mode persists questions, pauses new Agent operations and routes saved replies to the original tool invocation. The console refreshes the shared attention count independently of page selection; the desktop validates that count before updating Windows overlays and hidden-window tray artwork. Context compaction remains supplied by the DSH base bundle.

-----

<a id="extension-points"></a>
## Extension points

`aspera-single` is the execution preset. Coordination algorithms belong in a `ClusterExecutor` or a runtime coordination plugin; the preset selects roles and capabilities. Alternative topology, routing, evaluation, rounds and stopping rules can use DSH subagents without modifying the Agent loop. A loop replacement requires separate compatibility testing.

An RSI pipeline can consume immutable submissions, input digests, framework execution records, model artifacts, release identities and measured evaluation. Keep candidate data/model/Harness versions separate from the currently published version, evaluate candidates independently, and retain prior releases for rollback. This workspace provides records and execution; it does not implement an RSI optimizer or multi-Agent game algorithm.

See [state and API ownership](state-and-api.md) for versioning and [verification](verification.md) for the current acceptance scope.
