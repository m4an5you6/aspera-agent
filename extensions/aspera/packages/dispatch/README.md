---
description: "Configure servers and dispatch immutable Aspera experiments through shared DSH tools, generated Remotes and fixed releases."
kind: "package-bundle"
---

# @aspera/dispatch

English | [中文](README.zh.md)

## Summary

Submit multiple independent Goals, stage inputs and transfer complete experiment materials before returning remote ownership. Preserve server settings, credentials references and release identity across retries. Share the same task service between the Aspera page and Agent tools. Store the full receipt before completing a matching dispatch Goal.

Original trained experiments can associate existing inference work through [acceptance recovery](../../docs/completion-review.md#recover-acceptance-on-the-original-experiment). The Host verifies native checkpoint and public service proofs before original completion review; it does not copy or reactivate training. Source previews distinguish original-file and supplied-text digests while retaining credential masking.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Preparation command recovery](#preparation-command-recovery)
- [Remote task settlement](#remote-task-settlement)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The management Host synchronizes accepted experiments without a visible page and serves committed copies through the existing trajectory, command, log, step and metric Remotes. Before the queue saves an active phase's Session id, its experiment/node-owned Agent source declaration can identify the trace; absent or ambiguous declarations cannot. `experimentArchiveStatus` and `syncExperimentArchive` expose read-only copy health and immediate backfill. [Local running records](../../docs/state-and-api.md#local-running-records) owns the version-1 index, SSH fallback, configurable limits and deletion lifecycle; exiting the profile stops and awaits its readers while remote execution continues independently.

Archive opening validates committed intervals against one directory listing per experiment and checks that the directory identity remains unchanged. Missing blocks, non-file entries and symbolic links are rejected. Reading a block rechecks its path and content digest; startup verification does not replace read-time integrity checks or remove historical records.

The generated `experimentExecutionProgress` Remote reads approved-plan Agent reports from each experiment's original coordinator. Unsupported pinned releases return explicit availability; failures preserve diagnostics rather than substituting a new runtime. [Step progress](../../docs/state-and-api.md#execution-step-progress) defines ownership and compatible persistence.

The [workspace startup](../../README.md#start-the-management-page) creates an `aspera` profile over published DSH base/Web bundles and this package's [cordis.patch.yml](cordis.patch.yml). It mounts the adapter and management page. Built artifacts can be installed without the Harness source checkout; [installed verification](../../scripts/test-installed.mjs) exercises the same profile and public declarations.

`extensionRoot` selects the fixed release, `dataRoots` allows local input files, and phase snapshots identify private model credentials. `minimumFreeBytes` configures the storage reserve (default 1 GiB); `preparationOutputChars` bounds each command's model-visible stdout and stderr (default 65536). Preparation uses the selected SSH account's existing permissions, without a system-package allowlist. Operation, polling and download settings are validated [Config](src/index.ts) fields. The patch reads `ASPERA_DATA_ROOTS` and retains legacy `ASPERA_MODEL_CREDENTIAL_REFS` reads. Connection checks read remote state without invoking a model or configuring dependencies; they distinguish SSH reachability from missing dependencies and may omit disk inventory.

`documentationReadTimeoutMs` (default 30,000 ms) and `documentationPageBytes` (default 8,192 UTF-8 content bytes) are captured in new deployment settings for [planning documentation and drafts](../../docs/planning.md). Existing experiments retain absent historical settings and their fixed release.

`connectionCheckTimeoutMs` sets one deadline for the complete connection check, defaulting to 20000 milliseconds. Host-key discovery, environment inspection, disk, GPU and control probes share its cancellation signal. Expiry closes active SSH connections and records a failed check before another check can start; dated successful observations remain available. Foreground preparation commands retain `toolTimeoutMs`. Custom fleet callers pass the check deadline to `ExperimentFleet.open` before the optional driver; drivers must honor probe cancellation and await connection cleanup.

Password SSH connections use `sshHandshakeTimeoutMs` (default 15000), `sshHandshakeMaxRetries` (default 2) and `sshHandshakeRetryDelayMs` (default 500). A transient timeout, reset or disconnect before authentication can reconnect within the original operation deadline; the delay is multiplied by the retry number. Authentication and host-key failures, or any failure after authentication, stop without replaying the operation. These local settings apply when existing preparation is retried and do not rewrite its saved release, submission or installation receipts. Custom fleet callers can pass the resolved policy after the controller-repair policy to `ExperimentFleet.open`.

Configure supervised installation in the profile's `aspera-dispatch` entry. Each experiment freezes these finite integer limits; the idle limit cannot exceed the total limit.

| Configuration | Default | Scope |
| --- | ---: | --- |
| `installationTotalTimeoutMs` | 1800000 | Per-node installation recovery, including diagnosis, repairs, reconnection and verification |
| `installationIdleTimeoutMs` | 300000 | Time without measured download, package or compiler progress |
| `installationMaxRetries` | 2 | Additional installer launches after the first attempt, including source changes |

The preparation Agent diagnoses stalled installs and autonomously probes HTTPS npm/header sources. Saved pnpm slow-download and request-retry notices wake diagnosis once per category and attempt; the Agent can keep waiting for the same process or switch sources. A detached, identity-checked installer reuses the original material and cache; only program verification publishes a usable release. Explicit Retry preparation starts a new budget with retained history; failed experiments never restart merely because the application upgrades. [Installation ownership](../../docs/state-and-api.md#persistent-ownership) describes journals and unconfirmed exits.

Servers use password login with a separate username. Each create request selects `coordinatorId` from its `serverIds`; the submitted snapshot remains fixed when registrations change. Different coordinators cannot have unfinished experiments on overlapping nodes within one management profile. Same-coordinator requests keep remote queue order; initial approval does not allocate GPUs. Acknowledged server removal retains linked experiments, remote files and credentials needed by unresolved work. The node uses its configured control port, and its coordinator uses the following port. See [management state and cleanup](../../docs/state-and-api.md) for offline record deletion, ownership checks and compatibility.

Local connection checks and preparation automatically register previously unseen host keys in the selected `known_hosts` file, defaulting to `~/.ssh/known_hosts`. Discovery sends no password and runs no remote command; registration uses trust on first use and a cross-process file lock. Existing, revoked or unsupported identities are never overwritten. Password login then verifies the registered key; delegated remote connections require their preinstalled keys. `FleetDriver` providers implement `prepareSshHostKey` and verified `cleanupServerStorage`; the browser and host share removal checks through `@aspera/dispatch/server-usage`.

Retries read requirements from the original release. If both its application and DSH manifests omit `engines`, the recorded Aspera `0.1.1` / DSH `0.2.0-rc.2` / pnpm `11.7.0` combination requires Node `^22.19.0 || >=24.0.0`. The release receipt, dependency declaration and installed DSH version must agree. Unknown combinations or invalid declared requirements stop preparation; the current application's Node range never substitutes for the saved release.

Desktop resources retain the sealed deployment archive. Dispatch verifies its content identity, installed package files and runtime requirements before reuse, without resolving packages from the user's npm cache. Source builds prefer cached metadata and fetch missing metadata for pinned dependencies. A preparation that failed before capturing any release or remote placement can retry with its existing experiment and Session; a captured release still requires its original material. Local command failures include bounded stderr, or stdout when stderr is empty.

`AsperaRemote` publishes typed unary methods and a reconnectable snapshot stream. `ExperimentFleet` owns identical tool/Web dispatch behavior; `FleetDriver` supplies the complete deployment provider. Input writes are bounded/idempotent, downloads are one-use and effect cleanup joins local work without cancelling remotely accepted tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

[interruption.ts](src/interruption.ts) owns Host background operations and durable version-1 receipts; [interruption-remote.ts](src/interruption-remote.ts) resolves the original submission, credentials and fixed SSH operations. Task settlement and controller recovery use the same server-side admission lock. Host preparation queues retain their own lifetimes, so stopping old work remains available during Agent diagnosis. Controller repair reconciles authorized, exited old tasks before startup and returns receipts to the preparation Agent; full verification still follows. [Controlled interruption](../../docs/state-and-api.md#experiment-interruption) defines original-result preservation, missing legacy identities, multi-node confirmation, blocked retry and API compatibility.

[controller-script.ts](src/controller-script.ts) sends the complete helper and original authorization through SSH standard input with a short Python launcher. Parsing completes before helper execution. Repair checks this read-only path before stopping an online controller. A confirmed stop resumes under its original operation and fixed release; repeated recovery neither stops the controller again nor spends another attempt. Replacement process ownership is checked before releasing maintenance, and successful receipts retain earlier failure diagnostics.

[Environment verification](src/deploy.ts) runs workspace writes, directory isolation, credential hiding and CUDA access through the complete execution sandbox. Shell inspection exercises its required namespaces before Node installation. A confirmed refusal returns its check, exit code and unchanged stdout/stderr through [preparation tools](src/environment-preparation.ts); the original Agent requests repair and program revalidation. See [sandbox compatibility repair](#sandbox-compatibility-repair) for proc-mount failures. Removing isolation flags, binding the host `/proc` into the final sandbox or an Agent's completion statement cannot establish readiness.

[Controller recovery](../../docs/state-and-api.md#controller-readiness) covers online maintenance and SSH recovery of an exited controller. `repair_preparation_controller` retains the original home, verifies resource release and publishes a separate fixed-release profile. An unavailable control port does not establish an account or cloud-policy blocker.

<a id="sandbox-compatibility-repair"></a>
### Sandbox compatibility repair

`repair_preparation_sandbox` accepts only the active server id. The program discovers native bubblewrap, util-linux `unshare`/`setpriv`, `env` and `sha256sum`, then measures a private PID/proc parent using privileges the account already holds. The launcher restores default TERM/INT handling after namespace creation; preparation verifies child termination. The inner user/PID/mount/IPC/UTS isolation, private `/proc`, exact device grants and credential/directory masks remain required; `no_new_privs` and an empty capability set prevent privilege gain. A successful local probe supplies the dedicated tool in the logged diagnosis instead of inferring a host-policy blocker from `EPERM` alone. Missing utilities, insufficient existing privilege and failed probes retain distinct evidence. Connection checks never perform this repair probe or call a model.

The tool installs an owner-only, content-addressed launcher and version-1 descriptor below the selected control root's `tools/sandbox`. A native binary without bounded tmpfs support can be compiled from the sealed `sandbox-native.json` recipe in private `tools/sandbox-native` generations. Fixed source/tool hashes and signed account package metadata verify build inputs; only private libcap headers are extracted, with no OS package installation. Reuse verifies binary and runtime-library digests; independent version-1 indexes and attempt receipts retain unresolved exits. `sandboxNativeBuildTimeoutMs` defaults to 300000 and `sandboxNativeBuildBytes` to 67108864; the existing free-space reserve also applies.

The resolved executable directory takes precedence during verification and is saved through the existing executable-path fields for deployment, controller startup and actual commands. Manifest `sandboxVersion: 1` requires `bounded-sandbox-launch-v1` before controller reuse. Already running controls keep their configuration; changing their backend still requires the separately checked idle maintenance flow. Configuration alone cannot establish readiness: the Agent must call `verify_preparation_environment`, and every node's full checks must pass before handover. Diagnostic workspace and hidden-directory mounts are established before their parents become read-only; namespaces, credentials, devices and bounded temporary storage remain checked. An available repair cannot be skipped by reporting account-level exhaustion.

`sandboxRepairProbeTimeoutMs` defaults to 15000, `sandboxRepairCleanupTimeoutMs` to 1000, `sandboxRepairPollIntervalMs` to 20 and `sandboxRepairMaxAttempts` to two installations per experiment/server. Custom fleet callers pass the resolved policy after the SSH policy. Reusing installed matching material does not consume another attempt. Foreground repair commands use the existing preparation pending-command ownership; independent version-1 receipts bind experiment, server, Session, tool call and exit. Probe cleanup escalates TERM to KILL and checks process identities and private PID namespaces before writing an exit receipt. Cancelled, disconnected or unresolved work must be reconciled before another mutation; no host sysctl, AppArmor policy or driver is changed. A confirmed lack of compatible account permissions requires specific cloud-platform action.

Read-only observations validate experiment, node and Session ownership before returning complete events, registered logs, attachments or measured samples. Preparation captures full command output before limiting tool results. Notice fingerprints persist per management profile; dismissing a Toast leaves failure and cleanup state intact. [Observation APIs](../../docs/state-and-api.md#logs-outputs-and-services) define cursors and legacy availability. Installation and release transfer verify the fixed published DSH rendering adapters through `@aspera/dispatch/compatibility`.

`RunArchives` owns page-independent copies, coalesces manual requests and delays each next round from the previous completion. Ordinary, backlog, waiting and retry intervals are configurable; terminal resource release triggers a final copy, and confirmed drained records stop polling. Historical gaps remain distinct from pending tails. [Local running records](../../docs/state-and-api.md#local-running-records) defines settings, saved timestamps and finalization requirements.

Model admission resolves the three explicit choices through the DSH provider directory. [models.ts](src/models.ts) stores private API settings and independent credential references; retries load those snapshots. DeepSeek captures complete resolved settings as reusable plugin inputs through the runtime's [snapshot conversion](../runtime/src/model-configuration.ts). DeepSeek and supported pi-ai key routes use pinned adapters. Legacy `agentCredentialRefs` remains a configuration-read field; generation 4 transfers only credentials referenced by the admitted phase snapshots.

`agentContext.compaction` and `agentContext.pruning` configure preparation's private phase Agent through the [shared DSH context services](../runtime/README.md#use-this-package). Remote planner and execution profiles resolve the same settings in `aspera-runtime`; the coordinator forwards them to its worker children. No context settings are added to submitted experiment or Session records.

<details>
<summary>Implementation internals</summary>

[fleet.ts](src/fleet.ts) owns registry, preparation, Goal checks and receipts. [environment-preparation.ts](src/environment-preparation.ts) adds scoped SSH inspection, commands, verification and blocker reporting to the existing standard DSH Agent. [environment.ts](src/environment.ts) checks observed programs against release requirements before Node-dependent inventory. [storage-selection.ts](src/storage-selection.ts) owns candidate selection; [network-selection.ts](src/network-selection.ts) validates reachability and joins cleanup. [snapshot.ts](src/snapshot.ts) packages releases; [cluster-deploy.ts](src/cluster-deploy.ts) verifies original releases and retains active controls. Preparation serializes each server and persists pending command ownership before execution. Owned relationships are checked by operations; no service-presence invariant is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Execution roles](../runtime/README.md)
- [State and API ownership](../../docs/state-and-api.md)

<a id="model-experience"></a>
## Model Experience

Fixed release requirements include exact uv when declared. The preparation Agent installs basic tools; execution owns dependency requests through the node environment service. The Host's storage and cleanup Remotes use saved node ownership, preserve offline check times and wait for I/O before local deletion. `ExperimentFleet.open` accepts optional `ManagedEnvironmentPolicy` after `agentContext`; [managed environments](../../docs/managed-environments.md) owns configuration and recovery details.

GPU and controller checks use actual identities, the selected fixed release and startup authorization. The preparation Agent can request the scoped controller repair tool; program verification and final handover checks establish readiness. Idle maintenance fences new tasks before an identity-bound restart. `controllerRepairMaxAttempts` defaults to two and is retained in independent recovery receipts. [Controller readiness](../../docs/state-and-api.md#controller-readiness) defines occupancy, unknown exits and original-release compatibility. Custom `FleetDriver` providers implement `inspectController`.

Dispatch tools list non-secret servers, submit an explicit server group and read experiment status. The selected preparation model repairs failed checks through logged tools in the same Session; SSH credentials stay outside model input. Nonzero commands return diagnostics, while unconfirmed exits block repeated mutations. Agent text cannot replace workspace-write, isolation, credential-hiding, GPU and network verification. Passed checks enter the Agent inbox without waking the model; the loop admits their context after its initial system message. Requirements and receipts use existing Session events. **本机派发完成，远端实验已接管** appears only after receipt persistence; ID/revision comparison prevents completing an edited Goal.

<a id="preparation-command-recovery"></a>
## Preparation command recovery

`run_preparation_command` supervises Python-equipped nodes independently of SSH. Its short launcher receives complete UTF-8 input and checks length and SHA-256 before creating the command. Each command shares `toolTimeoutMs` with its downloads and retries, capped by the installation round's remaining deadline. Logs and version-1 request, process, status and event records remain in the original preparation directory. Reconnection reads that command instead of launching another; only confirmed exit clears its pending marker. Unknown legacy exits remain blocked. Shell-only Python bootstrap retains direct log files and uses the system `timeout` utility.

The preparation Agent calls `prepare_preparation_tool` for the release's exact uv. The program reuses an existing matching executable, validated wheel or partial material in the server cache before acquisition. It checks Python/platform tags and SHA-256, resumes supported ranges and returns executable directories for `verify_preparation_environment`. Training dependencies remain separate. Current SSH paths are used for the controller; cached uv paths join the verified toolchain.

Host settings `preparationCommandReadTimeoutMs`, `preparationCommandRecoveryTimeoutMs` and `preparationCommandStopGraceMs` default to 30000, 60000 and 5000 milliseconds. Polling uses `pollIntervalMs`, capped at 10000 milliseconds. Process-group termination verifies boot and start identity; missing evidence preserves the pending marker. Diagnostics and recovered results use existing Session tool events. [Persistent records](../../docs/state-and-api.md) defines compatibility.

<a id="remote-task-settlement"></a>
## Remote task settlement

The Host retains minimal [remote task identities](src/remote-task.ts) independently of visible experiments. Deletion saves the original submission digest and pinned node connections before the tombstone. It preserves unresolved interruption receipts and required SSH credential references. Original submissions are read through authenticated control or account-owned SSH, checked against the digest and node assignment, and never replaced by a new Goal.

`remoteTaskStatus(id)` reads committed progress. `settleRemoteTask({taskId, mode})` starts Host-owned `reconcile` or explicit `interrupt` work. Existing interruption and controller repair use the same exit verification, fencing and release implementation. Automatic settlement requires an exited original coordinator or a trusted terminal outcome and confirmation of all original Agents, commands and services. Unknown nodes and active work retain occupancy. Server cards expose deleted-task progress and retry; connection checks perform no settlement. [Persistence and recovery](../../docs/state-and-api.md#remote-task-settlement) defines compatibility and retained files.

[Completion reviews](../../docs/completion-review.md) run a restricted standard DSH Agent in an independent Session with the original execution model. The Host owns background reads, source verification, separate receipts, cancellation and deletion; original failed outcomes remain unchanged. Model views distinguish current assessment from historical outcomes and expose unresolved steps and independently checked associated serving first. The Agent can correct unverified stage paths with the current assessment revision; training identity and verified bindings stay fixed. JSON evidence retains its structure during credential removal, recording returns all field mismatches together, and local trajectory pages use the original persisted review Session.

[Storage governance](../../docs/storage-governance.md) uses the same preparation Session and selected SSH accounts before controller startup. The Host supplies canonical metadata when remote access fails, manages cancellable reads and exposes saved capacity plans plus explicit bounded inventory refresh. Storage selection and retry commit assignments with matching observations; fixed identities and capacity remain checked. Observations preserve their times and connection failures; cleanup selections bind program-issued candidates.

[Input transfer](src/input-transfer.ts) uses the configured `managedEnvironments.governance.materialTimeoutMs` for the whole upload batch. Retry skips only complete, owner-matched files with the submitted digest; incomplete files require replacement and full verification before handover. Password SFTP uses the library's parallel uploader, sets private permissions before data writes and never replays an authenticated transfer automatically.

Preparation verifies bounded read-only diagnostics before handover. The Host can attest ModelScope dataset commits through official Git objects; [material verification](../../docs/storage-governance.md) defines its executable requirement, limits and file checks.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Public server configuration supports passwords only; there is no password/key priority selection.
- Host keys must already be trusted in `known_hosts`; an unknown or changed key fails.
- Released generation-1–3 records remain readable without rewriting hashes; old unfinished preparations use Copy as new experiment.
- Incompatible control upgrades wait for existing tasks and controls to finish.

### Dev Note

None.
