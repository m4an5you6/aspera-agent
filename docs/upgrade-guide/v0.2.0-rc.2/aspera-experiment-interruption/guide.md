---
kind: upgrade-guide
description: "Aspera adds durable experiment interruption APIs and reconciles confirmed old task exits before controller recovery."
---

# Aspera experiment interruption

English | [中文](guide.zh.md)

## Change

`interruptExperiment(id)` acknowledges Host-owned background stopping; `experimentInterruptionStatus(id)` reads its operation. Fleet snapshots require `interruptions`. The existing `cancelExperiment` return type remains unchanged and waits for the same resource checks. Update generated Remote consumers with application resources. Files, logs, trajectories, original plans and hardware requirements remain retained.

User stops retain `cancelled` underneath and display as interrupted after confirmed release. Preparation's `repair_preparation_controller` can close a started old task whose controller exited, after confirming all original Agents, commands, services and nodes stopped. A trusted terminal result is preserved; otherwise the result is `interrupted`. Pending queued and awaiting-approval tasks require explicit user action. Preparation never stops active work or probes unselected nodes.

Independent version-1 interruption and Linux process-identity files preserve operation, original submission, node evidence and recovery state. Local fleet generation 6, submission protocol 4 and Session formats remain unchanged. Unknown exits retain allocation. [Controlled interruption](../../../../extensions/aspera/docs/state-and-api.md#experiment-interruption) defines file locations, PID/boot checks, transport recovery and cleanup.

## Migration

1. Update resources and Remote descriptors together. Read operation progress from `experimentInterruptionStatus` or snapshots; an acknowledgement does not mean stopping finished. Original EXEs support the corresponding desktop resource update.
2. Use Interrupt experiment for started work and Cancel experiment for pending work. A blocked operation exposes exit verification and retry. An operation survives page navigation and window hiding; application restart reads retained evidence before further stopping.
3. Resolve every original node before resource takeover or deletion. Linux SSH stopping requires durable identities and pidfd support. Missing legacy evidence requires the original authenticated release API or operator-confirmed exit; never clear allocation by editing records.
4. Retry preparation in its existing Session after old work is released. The preparation Agent calls `repair_preparation_controller`, reads its receipts and requests `verify_preparation_environment`. Full isolation, workspace, credential-hiding, GPU, authorization and network checks remain required. Connection checks stay read-only and limited to 20 seconds.
5. Deleted experiments use the same settlement service through their server card. Follow [remote task recovery](../aspera-remote-task-recovery/guide.md) to update the independent ownership records and generated Remote consumers; do not restore deleted list entries or clear remote allocations manually.
