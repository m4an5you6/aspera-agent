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

## Migration

1. Install matching Host and client builds and regenerate Remote consumers. Supply the selected coordinator in every create request and tool call; do not infer it from registry order.
2. Keep the existing fleet and remote directories. Confirm historical experiments still show their original coordinator. Do not downgrade a management profile after it writes generation `6`.
3. Update probe consumers to read `status`, `checkedAt`, `configuration`, `result` and `lastSuccess`. Display failed or interrupted checks independently of historical hardware results.
4. Stop experiments and confirm process/resource release before deletion. Preview the exact node directories before selecting remote cleanup. Retry partial cleanup using the saved operation identity, or explicitly choose record-only deletion with a new identity. Original files, ordinary DSH Sessions and shared remote state are retained.
5. Implement the validated owned-directory cleanup operation in custom drivers. Verify checks, password reveal, record deletion and per-experiment coordinator selection with the [local verification workflow](../../../../extensions/aspera/docs/verification.md).
