# Agent Note: Independent GPU experiment handoff

Status: implemented

English | [中文](2026-09-23-independent-gpu-experiment-handoff.zh.md)

## Problem

A local coding Agent can prepare a GPU experiment but cannot own its training lifetime when the operator closes the terminal or loses connectivity. SSH command lifetime, local Session lifetime, and the remote training lifetime differ. Replaying a submission after a lost acknowledgement also risks launching a second training run.

The remote worker needs file confinement and GPU access without assuming that a provider-managed container permits nested Docker or exposes a usable kernel sandbox. The existing [Goal domain](../feature/2026-07-19-persisted-same-session-goal-domain.md) records continuation in a Session but deliberately does not grant execution authority after process restart.

## Decision

The local `experiment-dispatch` profile packages current source with a digest, builds it in a separate remote release directory, probes bwrap file restrictions and allocated NVIDIA devices, and talks through a short-lived SSH tunnel to an authenticated loopback receiver. The `experiment-worker` profile is a detached DSH process with its own Session, Goal, workspace, logs, and storage-domain submission record. The SSH connection carries control traffic; it does not own the Agent lifetime.

The dispatcher persists its submission id before sending. The receiver reserves the id before creating an Agent and acknowledges takeover only after Session flush and durable acceptance. A repeated id with matching content returns the existing receipt, including a terminal one; a conflicting payload is rejected. An unfinished reservation becomes `interrupted` after restart and is never replayed as a new training run. The receiver record owns submission identity and worker lifecycle; the Session remains authoritative for Goal history, as required by [goal-owned events](2026-07-31-goal-owned-durable-events.md).

The unattended profiles reject human questions and approval requests, disable plan approval and capability expansion, and allow a blocked Goal after its first continuation round. File tools are absent from the worker profile so command execution and file effects share its bwrap policy. Private credentials live outside the source snapshot and are masked from confined commands. This extends the [sandbox decision](../feature/2026-07-06-sandbox.md) with explicitly granted GPU devices and private read masks; it does not claim network isolation.

## Alternatives considered

**Run training as an SSH command.** A disconnected control connection can end or orphan the remote command, and it provides no durable, authenticated receipt with idempotent retries.

**Give the Agent access to Docker daemon or unrestricted execution.** Docker control is broader authority than one experiment requires, and an unavailable sandbox must fail preparation rather than silently weaken file restrictions.

**Represent remote submission as a synthetic human message.** It would give machine-origin work human authority in Goal and interaction policy. The receiver creates the Goal through the service and records a plugin-sourced initial message instead.

## Consequences

One worker accepts one active experiment. A local Goal can finish at takeover while its remote Goal continues. The source release is immutable once activated; failed preparation leaves the previous usable release in place. Credentials and data are transferred separately under explicit configuration. A worker restart reports interruption without automatic training replay; recovery of a completed experiment relies on its durable record and artifact paths. The receiver's authenticated HTTP control service and model credentials remain trusted worker infrastructure, outside the model's file sandbox.
