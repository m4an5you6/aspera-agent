---
description: "Operate persistent Aspera node/coordinator profiles and restricted planning or execution Agents with generic framework guidance."
kind: "package-bundle"
---

# @aspera/runtime

English | [中文](README.zh.md)

## Summary

Keep experiment control, execution Agents and managed training/inference processes in separate lifetimes. Allocate a node to one experiment, run commands with filesystem/GPU restrictions and retain process cleanup evidence. Prepare plans with read-only tools, then execute approved requirements using a single Agent. Shipped framework skills guide version selection and short verification without framework-specific parameter adapters.

[Service lifecycle tools](src/inference-service-tools.ts) let the execution Agent stop its own registered backend before loading corrected code. [Public inference](../../docs/public-inference.md) defines ownership, confirmed release and replacement IDs.

Retention reductions await explicit Host confirmation in automatic and manual modes. The [storage policy](../../docs/storage-governance.md#storage-preflight) keeps the Agent's proposed contents and independent decision history.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

[Targeted material verification](../../docs/storage-governance.md#targeted-material-verification) exposes independently callable discovery, canonical metadata, read-only verification and capacity tools. The Agent chooses their order; program checks retain ownership, content and write admission. [Finish decisions](../../docs/finalization.md#finish-decisions) separate referenced program observations from unverified blocked reports.

Environment resolution exposes verified local wheels through PEP 503/658 metadata indexes. The fixed uv resolver reads dependency metadata without unpacking cached payloads; lock hashes still identify the complete original wheels. Missing dependencies use the configured online source after local resolution, while installation retains shared payload links.

The dispatch provider installs the fixed release and initializes profiles through `setupWorkerProfile` and the sealed setup entry. Resident controls use `aspera-worker-<deploymentId>` in a stable role home; experiment Agents use `aspera-worker` in their private homes. [Controller recovery](../../docs/state-and-api.md#controller-readiness) preserves original task and Session storage across releases. The bundle is [worker.patch.yml](worker.patch.yml) over published DSH base. The [production worker check](../../scripts/test-worker.mjs) exercises the worker entry with no model key; Linux node execution requires the [GPU acceptance](../../docs/verification.md#gpu-acceptance).

Choose `coordinator`, `node`, `planner` or `agent` through role configuration. Deployment fixes the control root, token, release and experiment IDs. [Config](src/index.ts) bounds polling, cleanup, network probe lifetime, file/byte limits and documentation access. [Network probes](src/network-probes.ts) check receiver identities without allocating GPUs; timeout, cancellation and shutdown clean their listeners. The node masks the control directory and other registered experiment roots before binding the current workspace.

Control health exposes the startup identity, normalized authorization and current occupancy through `controller-readiness-v1`. Authenticated `controller-maintenance-v1` operations atomically refuse occupied roles and fence new admission. `gpuSnapshot` captures startup UUID/device mappings; node admission compares them with current NVIDIA XML identities and accessible character devices. A healthy HTTP response alone cannot authorize reuse. [Controller preparation](../../docs/state-and-api.md#controller-readiness) defines repair ownership, legacy checks and independent acceptance.

Ordinary commands cannot outlive cancellation cleanup. Protocol `4` has no aggregate lifetime or command-count cap; old allocations retain their limits. [Storage preparation](scripts/storage.mjs) checks Linux mounts, capacity, ownership and write access; unknown persistence stays unknown. Profiles and logs live on selected experiment storage, while queue state and credentials remain private. Cache/environment variables use the writable workspace. Registered services retain the full allocation, require live HTTP health and never restart automatically. [Inference gateways](src/inference-gateway.ts) own explicitly mapped public listeners and private service credentials; see [service records and access](../../docs/state-and-api.md#logs-outputs-and-services). `serviceRequestTimeoutMs` (300000) limits upstream idle time and `serviceRequestBytes` (16777216) bounds request bodies; both are node profile settings.

`goalContinuationWindow` is a deployment setting, defaulting to `128` rounds; `DSH_CLUSTER_GOAL_WINDOW` configures it in the worker patch. The continuation plugin extends the same Goal through public `Goal.edit` before its finite window is exhausted. Each extension is logged; it is not a user task budget. Connection, probe and model-operation timeouts, loop guards, confinement and cancellation remain active.

`agentContext.compaction` and `agentContext.pruning` configure the published DSH basic compactor and tool-result pruner using their validated defaults. Each created or resumed phase Agent mounts both services beside its private LLM provider; the profile's token meter retains shared projections. Summarization uses the experiment's saved phase provider and model, including any matching model-policy override; conflicting summarization settings fail before Agent creation. Root-level worker compaction is disabled. When a Host retains an outer compactor, phase-owned Cordis event filtering admits only that Agent's DSH basic compactor, leaving ordinary conversations unchanged. Summary and pruning events remain in the original Session, and cancellation aborts an active summary request without publishing a partial summary.

[Owned file cleanup](src/storage.ts) removes only the saved experiment workspace and named private transfer files after dispatch confirms resource release. It checks owner markers, canonical paths and mount identity, rejects nested mounts and never traverses directory links. Shared releases, caches and control state remain; interrupted cleanup resumes from its private quarantine directory. The optional cancellation signal closes the active SSH command without requiring local record deletion to wait for it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[owned-command.ts](src/owned-command.ts) publishes Linux command and Agent process identities under the shared admission lock before launching the unchanged sandbox or supported DSH profile. An experiment interruption fence rejects new launches while the original node-release API remains available for cleanup. Offline signal delivery requires Linux Python pidfd support; unavailable identities or unsupported builds retain allocation. [Controlled interruption](../../docs/state-and-api.md#experiment-interruption) owns receipt fields and release semantics.

[observations.ts](src/observations.ts) owns the independent version-1 source directory and bounded, redacted output records. Installation imports retain remote sequence numbers and collection times and deduplicate repeated pages, including long final records. [metrics.ts](src/metrics.ts) samples measured node resources; reported training values remain a separate series. Coordinator requests to its own pinned node use authenticated loopback; other nodes retain SSH. These reads do not release allocations or restart failed work. See [observation configuration and compatibility](../../docs/state-and-api.md#logs-outputs-and-services).

[phase-model.ts](src/phase-model.ts) mounts the standard DSH Agent driver, a separate LLM service and the selected pinned provider together for each phase, inheriting the profile's driver limits. [phase-agents.ts](src/phase-agents.ts) shares Agent publication and initiator tracking with the profile so Goals, records and cancellation retain their normal ownership. Creation and resume verify the saved configuration digest and private credential; concurrent phases can use different saved settings for the same provider name. Dispose the Agent before its model context. [records.ts](src/records.ts) pages real phase events; node commands write separate stdout/stderr files in addition to the node overview log.

[model-configuration.ts](src/model-configuration.ts) converts resolved DeepSeek settings into reusable plugin inputs and reads hash-verified legacy snapshots. Native provider validation remains active. [Snapshot compatibility](../../docs/state-and-api.md#persistent-ownership) owns the persisted fields and recovery rules.

<details>
<summary>Implementation internals</summary>

[command-output.ts](src/command-output.ts) checks identity and byte cursors for command stream reads, including diagnostics outside the workspace. [Command waiting](../../docs/finalization.md#command-waiting) owns tool parameters and output limits.

[experiment-sandbox.ts](src/experiment-sandbox.ts) owns the Linux launch shared by preparation and managed commands: user/PID/IPC/UTS namespaces, a private `/proc`, all capabilities dropped, exact device grants, masked control/storage directories, a cleared environment and workspace-local caches. Normal `TMPDIR=/tmp/aspera` resolves through a command-private link to `workspace/tmp`; temporary contents remain on the selected disk. Read-only diagnostics retain bounded private tmpfs. Preparation executes its probes inline because release directories are hidden inside the sandbox. A namespace or proc-mount refusal stops admission with the original diagnostic; the [dedicated compatibility repair](../dispatch/README.md#sandbox-compatibility-repair) preserves this confinement. Managed scope cleanup escalates TERM to KILL when needed, including launchers whose namespace supervisor ignores TERM.

`pnpm run test:sandbox:linux` builds the runtime before testing real Python local-process IPC on Linux. Set `ASPERA_TEST_BACKEND` to the verified node launcher. Tests use private temporary workspaces and no GPU devices.

[transport.ts](src/transport.ts) supports password and key SSH commands with separate stdout/stderr, exit status, timeout/cancellation and confirmed-exit evidence. `remote` retains its successful-stdout interface; `remoteResult` returns nonzero command results for diagnosis. Both accept optional UTF-8 standard input and close it after writing, independently of command arguments. Connection failures remain errors. Verified executable directories apply to every subsequent command. Losing an SSH connection does not establish that the remote process stopped.

Password commands, uploads and receiver requests can reconnect before authentication under the resolved [connection policy](src/ssh-connection.ts). Each failed client closes before another opens; attempts and backoff share one operation deadline and cancellation signal. Host-key and authentication failures are terminal. Once authenticated, a command-channel or receiver failure is never retried automatically, and missing remote exit evidence remains unconfirmed. Key-based OpenSSH operations retain their existing exit-receipt behavior.

[ssh-host-keys.ts](src/ssh-host-keys.ts) supplies local first-use public-key discovery and locked registration for dispatch. Discovery uses the bundled SSH client and disconnects before authentication; it requires no `ssh-keyscan` process and follows the caller's cancellation and deadline. Authenticated transport reads registered keys without enrolling identities; delegated node connections retain their private, preinstalled trust files. Registration stops on cancellation and preserves unrelated entries, hashed hosts and revocations.

[cluster.ts](src/cluster.ts) mounts authenticated control routes and storage lifetimes. [cluster-runtime.ts](src/cluster-runtime.ts) transfers/checks inputs, starts separate Agent profiles and observes services. [cluster-node.ts](src/cluster-node.ts) serializes claims and cleanup evidence. [cluster-agent.ts](src/cluster-agent.ts) installs tools only into the experiment's Agent scope. Private directories remain outside its writable workspace. Admission, command and file paths execute the resource/security checks; no independent service-presence invariant entry is published.

[Node record ownership](../../docs/state-and-api.md#persistent-ownership) defines the shared command key used by execution, logs and service cleanup. Node lifecycle tests use the published JSON backend, reopen durable records after simulated restart and retain unresolved process ownership.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Scheduling provider interface](../experiments/README.md)
- [Data and API versions](../../docs/state-and-api.md)

<a id="model-experience"></a>
## Model Experience

[Checkpoint retention](../../docs/finalization.md#command-waiting) protects approved successful recovery files from later commands and services. The Agent corrects evidence from original logs and checkpoints; format errors never authorize another successful training attempt.

Environment installation, operation queries and recovery expose bounded JSON and saved detail pages; [managed environment reads](../../docs/managed-environments.md#create-and-verify) retain complete package and diagnostic records.

[Account helper transport](src/python-input.ts) sends managed Python definitions and structured requests through SSH input with a fixed short entry. Preparation, offline observations, storage registration and confirmed reference release share this path; complete input parsing precedes execution.

Environment recovery preserves the original receipt and returns separate generation and cleanup diagnostics. Agents must request fresh program verification after recovery. `managed-environment-lock-receipt-v1` retains a failed receipt for package-lock refusal without installing; the node still confirms process exit before releasing admission. An existing unresolved operation is never closed by a new lock refusal. Ordinary temporary deletion failures retain verified environments; mount or identity failures remain blocking. Pending operation directories are masked in command and service sandboxes.

`inspect_experiment_environment` reads allocation-scoped environment and reuse records. `prepare_experiment_environment` always checks reuse and space before fixed-uv installation, verification or file separation. `recover_experiment_environment` reconciles original startup/process evidence; `preview_experiment_cache_cleanup` and `cleanup_experiment_cache` share the program-owned cleanup service. Ordinary commands and services load verified contents through read-only mounts. [Managed environments](../../docs/managed-environments.md) defines material retention, private entry points, linking, recovery and storage. `managedEnvironments` configures installer and observation limits.

[environment-operation.ts](src/environment-operation.ts) keeps the existing exclusive installation tool pending through authenticated lightweight status reads. The node persists the original deadline and independently verifies exit and admission release. Environment request files also retain optional `evidenceContext` with the approved plan and execution Session; the child verifier receives it unchanged, and retries reject different identities. Legacy request files remain readable. `create` merges direct requirements; `install` explicitly replaces them. A private fixed-pip installer parses and downloads dependencies without seeding training. Structured file conflicts reject unchanged retries across operation IDs. The fixed release advertises `managed-environment-install-v3`; the Agent loop remains unchanged.

Agents receive logged immutable requirements and the approved plan. Both roles read shipped guidance, paged allowlisted HTTPS documentation and declared input bytes. [Planning tools](../../docs/planning.md) expose exact types, persistent drafts and local repairs before immutable submission. Execution adds confined commands, logs/files, measured progress, version/script/environment/parameter records and registered service management. Completion requires execution evidence, completed step reports and settled successful commands or healthy owned services on every node. Missing requirements produce a persisted blocked Goal.

Execution uses `get_experiment_execution_progress` and `report_experiment_step` to report each approved step as running, completed or blocked. Worker identity and call time come from the program. Revision conflicts return diagnostics and current reports; the Agent repairs the report without rerunning settled commands. Missing step reports keep the Goal active until corrected. These reports never replace independent command, node or result acceptance. [Step persistence](../../docs/state-and-api.md#execution-step-progress) defines ownership and late-message refusal.

`stage-evidence-reading-v1` requires complete structured reads and per-response identities in [stage acceptance](../../docs/finalization.md#approved-stages), including files also declared as required artifacts. `stage-checkpoint-evidence-v4` verifies native checkpoint identities when a registered state snapshot lives in logs and checks declared native saving directories before launch.

Global tools are masked in the Agent scope and plugin-manager layers are disabled. Automatic mode rejects human waiting at the question service, including direct requests; semi mode exposes the existing question service through a persisted remote answerer. Unresolved choices pause new Agent tools while managed node processes remain cancellable. Transient provider errors rearm the same Goal; explicit blockers and unrecoverable failures persist terminal reasons. Replies cannot change submitted requirements or grant permissions. [Megatron](skills/megatron/SKILL.md), [MS-SWIFT](skills/swift/SKILL.md) and [Unsloth](skills/unsloth/SKILL.md) guidance require documented versions, isolated environments, short runs and measured evaluations rather than claiming optimal parameters.

A planning or execution turn ending with `max-tokens` receives a logged correction in the same Goal and Session. `finalization.outputTokenCorrections` defaults to two consecutive recoveries; a tool result resets the count. Exhaustion blocks with `aspera-model-token-limit` and preserves the actual output-limit event. Recovery never replays commands. Unverified blocked reports receive `finalization.reasonCorrections` opportunities before incomplete-Agent termination. The [production worker replay](../../scripts/test-worker.mjs) covers successful continuation, bounded exhaustion and a settled command launched once. Releases declare `asperaAgentRecoveryVersion: 1` and require `agent-recovery-v1` before controller reuse.

[Completion verification](../../docs/completion-review.md) owns the shared checks used by the inspect tool, completion tool and final worker settlement. Recovery observation checks the experiment and release identities in the coordinator's fixed submission. Missing node evidence keeps the original Goal active for recording existing results; no training is repeated.

[Stage acceptance and finalization](../../docs/finalization.md) defines approved optimizer-step arithmetic, exclusive command/group waiting, source-bound checks and budget evidence. `finalization` config owns polling, read/reconnect limits, evidence size and correction counts; it adds no total training deadline. These tools use the existing DSH registration and lifecycle extension points. [stage-attempts.ts](src/stage-attempts.ts) publishes failed-attempt successors without replacing original registrations; the Agent selects retries through the existing stage tool.

[Environment preflight and retention](../../docs/storage-governance.md#storage-preflight) keeps readonly source verification, editable byte estimates and approved saved contents distinct. Agents choose repair or partial-material acquisition; program admission and canonical publication remain required.

[Storage governance](../../docs/storage-governance.md) provides shared account inventory, historical environment borrowing, per-volume reservations and immutable model/data acquisition. Scoped tools use program-issued candidates and original operations; command, service and completion consumers verify read-only grants. Explicit candidates bind each verification operation; capacity selects its receipt through `materialSources`. Per-experiment publications retain their own sources. File-content locks coordinate acquisition across revisions. The runtime retains original environments and failed evidence.

Copied containers use [storage registration](../../docs/storage-governance.md#storage-registration) to retain old mount observations and reverify current ownership. [Bounded diagnostics](../../docs/finalization.md#bounded-diagnostics) permit read-only investigation without training-capacity admission; explicit identity-bound command refusal returns immediately. These capabilities belong to new fixed releases and do not restart existing experiments.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Production execution requires Linux bubblewrap and NVIDIA devices; network access is shared rather than isolated.
- Provider transfer supports DeepSeek and pi-ai key APIs. OAuth grants, cloud identity chains and arbitrary provider plugins require separate integration.
- Ambiguous node restarts require operator reconciliation; no force release or automatic training restart is provided.
- Multi-Agent algorithms and an RSI optimization pipeline are separate extensions.

### Dev Note

None.

Automatic [historical reuse](../../docs/storage-governance.md#automatic-history-reuse) prioritizes owned ready-environment manifests and uses durable node verification and saved source selection. Capacity consumes confirmed receipts; incomplete discovery stays pending. [Storage tool results](src/storage-tool-result.ts) expose bounded saved pages, and read timeouts retain diagnostics without restarting verification.

`historical-environment-precheck-v1` requires [preliminary historical eligibility checks](../../docs/storage-governance.md#historical-environments) before deep source verification.

`storage-requirement-ledger-v1` uses the published environment requirements for [capacity reassessment](../../docs/storage-governance.md#storage-preflight); unsuccessful dependency trials do not become installation requirements.

`managed-environment-repair-v1` exposes [Agent-selected repair](../../docs/storage-governance.md#agent-selected-environment-repair), source-specific diagnostics and confirmed environment-reference removal. The inspection response retains process records when storage discovery fails.

[Public inference verification](../../docs/public-inference.md) lets the execution Agent request actual Host-side authentication and fixed-prompt generation checks. Credentials stay private; operation claims and saved results prevent automatic generation replay. Published-service completion consumes those observations.
