---
kind: upgrade-guide
description: "Aspera requires an experiment coordinator, writes fleet generation 6 and exposes explicit management operations."
---

# Aspera experiment and server management

English | [中文](guide.zh.md)

## Change

Aspera `0.1.1` requires DSH `0.2.0-rc.2`. Creation and dispatch require `coordinatorId` and `coordinator_id` from selected nodes. Different coordinators cannot share unfinished nodes in one profile; same-coordinator queuing remains available. Initial confirmation does not allocate GPUs.

`aspera_fleet` writes generation `6` and reads `1`–`5`. Remote protocol, stores and Session format remain unchanged; existing tasks retain their coordinator, directories, credentials and digest. Node command keys are path-safe and experiment-scoped; public IDs remain unchanged. [State and APIs](../../../../extensions/aspera/docs/state-and-api.md) owns persistence details.

`probeServer` returns structured checks and dated hardware. Only `revealServerPassword` reveals passwords. Deletion accepts `allowUnconfirmed`; server deletion accepts `allowLinked`. Independent `aspera_removals` version `1` hides deleted objects and retains unresolved ownership. Remote cleanup requires release and directory evidence; there is no recycle bin.

`connectionCheckTimeoutMs` defaults to 20000 milliseconds. Expiry cancels probes, closes connections and saves failure independently of historical hardware and preparation timeouts.

Both modes use published DSH read-only trajectory patches; decisions stay in Overview. Versioned observation APIs provide events, attachments, logs and measured metrics. Coordinators use authenticated loopback for themselves; other nodes use SSH. Persistent Toast deduplication preserves failure and cleanup states.

Supervised installation uses independent `aspera_preparation` and remote installer versions `1`. Pinned defaults are 30 minutes total, 5 minutes without progress and two additional attempts. The preparation Agent can change verified HTTPS sources; program acceptance remains required. Upgrades never restart failed experiments. Missing or unverifiable original material blocks recovery.

## Migration

1. Install matching Host/client builds and regenerate Remotes. Supply the selected coordinator; registration order assigns no role.
2. Preserve fleet, remote and removal journals. Do not downgrade to incompatible readers. Re-added servers need new IDs.
3. Probe consumers read `status`, `checkedAt`, `configuration`, `result`, `lastSuccess`; separate failed checks from historical hardware.
4. Read `recordDeletionAvailable`, `removedServerIds`, `unconfirmedWork`. Acknowledge unconfirmed local deletion; changed cleanup policies need new operation IDs. Recheck retained work before node reuse. Server deletion preserves linked experiments.
5. Pass `connectionCheckTimeoutMs` third to `ExperimentFleet.open`, then the driver. Retain `toolTimeoutMs` for preparation. Drivers must honor cancellation and owned cleanup; follow [verification](../../../../extensions/aspera/docs/verification.md).
6. Install matching UI patches. Capture complete output before truncation. Preserve releases; control upgrades require task completion and cleanup confirmation. Retain the desktop EXE.
7. Configure installation limits in `aspera-dispatch`, passed fifth to custom fleet callers. Consume snapshot `installations` and retry `{ record, installations }`. Preserve journals, archives, caches and remote records. Explicit retry starts a new budget with history. Unconfirmed installers retain ownership after cancellation/deletion. Update existing runtime resources.
8. Consume `experimentExecutionProgress` and preserve independent `execution-progress.v1.json` files. New execution workers must report approved steps before completion; independent acceptance remains required. Old fixed releases display unrecorded steps. Do not upgrade an existing task; copy it after confirmed resource release and resolve any Goal/hardware mismatch.
