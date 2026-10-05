---
kind: upgrade-guide
description: "Aspera requires an experiment coordinator, writes fleet generation 6 and exposes explicit management operations."
---

# Aspera experiment and server management

English | [中文](guide.zh.md)

## Change

Aspera remains `0.1.1` with DSH `0.2.0-rc.2`. New experiment requests and the dispatch tool require `coordinatorId` and `coordinator_id` respectively, identifying a selected node. Servers no longer inherit a permanent coordinator role from registration order. Unfinished experiments with different coordinators cannot share nodes within one management profile; same-coordinator queuing remains available. Initial plan confirmation does not allocate GPUs.

The local `aspera_fleet` domain writes generation `6` and reads generations `1`–`5`. It retains configuration-bound checks, deletion progress and tombstones. Remote protocol, remote stores and Session format remain unchanged. Existing tasks retain their original coordinator, directories, credentials and request digest. [State and APIs](../../../../extensions/aspera/docs/state-and-api.md) owns the persistence acknowledgment.

`probeServer` returns a structured check with a separate dated successful observation. The explicit editor method `revealServerPassword` can return the saved password; normal queries never return it. Deletion previews and batch operations permanently remove eligible records, with optional owned-file cleanup. There is no recycle bin. Custom `FleetDriver` providers must implement `cleanupServerStorage`.

Connection checks use an independent total deadline instead of the preparation command timeout. The adapter's `connectionCheckTimeoutMs` defaults to 20000 milliseconds. Expiry cancels active probes, closes their connections and stores a failed result while retaining historical hardware information.

Both modes use the patched published DSH read-only trajectory; decisions and replies stay in Overview. Observation APIs provide complete events, attachments, registered logs, bounded history/downloads and measured metrics. Observations and error notices have separate storage versions. Coordinators access themselves through authenticated loopback using saved server identity; other nodes retain SSH. Persistent Toast deduplication preserves failure and cleanup states.

## Migration

1. Install matching Host and client builds and regenerate Remote consumers. Supply the selected coordinator in every create request and tool call; do not infer it from registry order.
2. Keep the existing fleet and remote directories. Confirm historical experiments still show their original coordinator. Do not downgrade a management profile after it writes generation `6`.
3. Update probe consumers to read `status`, `checkedAt`, `configuration`, `result` and `lastSuccess`. Display failed or interrupted checks independently of historical hardware results.
4. Confirm processes and resources are released before deletion. Preview cleanup directories. Retry partial cleanup with the saved operation identity, or choose record-only deletion with a new identity. Original files, ordinary DSH Sessions and shared remote state remain.
5. Pass `connectionCheckTimeoutMs` third to `ExperimentFleet.open`, before the optional driver. Configure this deadline in `cordis.yml`; retain `toolTimeoutMs` for preparation. Custom drivers must honor cancellation, await connection cleanup and validate owned-directory cleanup. Follow the [local verification workflow](../../../../extensions/aspera/docs/verification.md).
6. Install matching conversation, trajectory and attachment patches with the console and generated Remotes. Preparation transports forward complete stdout/stderr to the optional capture callback before truncation. Preserve task releases and directories; old runtimes expose supported history. Control upgrades require finished tasks and confirmed cleanup. Desktop resource updates retain the EXE.
