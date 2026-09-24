---
description: "Authenticated loopback receiver that owns remote unattended experiment Goals and their durable receipts."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experiment-worker

English | [中文](README.zh.md)

## Summary

The `experiment-worker` profile runs as an independent DSH process on a Linux GPU target. An authenticated loopback HTTP route accepts one experiment, creates its own Session and Goal, and persists a receipt before acknowledging takeover. The process and its Agent handles do not depend on the dispatching SSH tunnel.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The dispatcher starts `dsh --profile experiment-worker` with a private Harness home, the workspace root, deployed source digest, allocated NVIDIA device paths, token file and loopback port. The profile disables human questions, interactive plan approval, plugin management and in-process file tools; its approval policy rejects escalation. The bwrap sandbox stays in `workspace-write` mode, grants only configured NVIDIA character devices, and masks the worker's secret and state directories from shell processes. Standard Python and model caches resolve inside the writable experiment workspace.

The receiver exposes authenticated health, submit, status, cancel and idle-shutdown operations under `/experiment/v1` through the existing WebServer service. The Bearer token and version-specific model credentials are read from owner-only files and never included in the Goal text. A submit request carries a content-addressed deployment identity, submission id and explicit experiment requirements. The output path and dataset references must stay inside the worker workspace.

The health response requires a SHA-256 `deploymentId`, `ready: true` and a boolean `busy`, with no additional fields. Dispatch validates these fields before reusing a preparation, activating a release or restoring a previous worker. A busy worker accepts status queries and duplicate submissions but refuses deployment replacement.

Status includes the persisted receipt, live Goal phase while its Agent runs, worker log availability, and up to 128 relative artifact file paths with sizes. A truncated marker indicates more files may exist.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A storage-domain record reserves the submission id before Agent creation. The receiver creates and arms the Goal, logs the machine-sourced initial message, flushes the Session, then acknowledges acceptance. Concurrent and repeated requests with the same id and content return the same record; changed content conflicts. Terminal Goal results are saved after the Agent becomes idle and its Session is flushed. At process startup, unfinished records become `interrupted` without rerunning their training.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [dispatcher](../experiment-dispatch/README.md) for deployment and submission, the [Goal service](../../goal/goal/README.md) for continuation state, and the [handoff decision](../../../.agents/notes/implemented/architecture/2026-09-23-independent-gpu-experiment-handoff.md) for lifecycle ownership.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Session log owns Goal state; the storage record owns submission identity and receiver lifecycle. No invariant companion is published because neither is a duplicate projection of the other.

</details>

<a id="model-experience"></a>
## Model Experience

### Experiment message

#### What the model sees

The remote Agent receives a logged `experiment-worker` plugin message containing the objective, explicit model and dataset requirements, output directory and instruction to resolve only unspecified settings. It must wait for a managed training job's real exit result before completing the Goal.

#### Token effect

The message adds task-dependent requirements to the initial remote model request and persists in its Session history.

#### KV Cache effect

Changing the experiment changes this Session's initial request prefix; retries of the same accepted submission do not append a second message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The dispatcher builds the source and probes CUDA before this receiver starts; runtime limits remain:

- One target accepts only one active experiment.
- A restarted worker reports interruption without restarting training.
- Cancellation owns managed jobs and subprocesses; a program deliberately detached outside DSH's process ownership is not tracked.
- The file sandbox does not provide complete network isolation.
