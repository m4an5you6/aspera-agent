---
description: "Dispatch independent Goals to a durable remote queue spanning selected GPU servers."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experiment-dispatch

English | [中文](README.zh.md)

## Summary

Web experiments and model tools share one task service. Each experiment pins its servers, source release, inputs and independent dispatch Session. The coordinator acknowledges ownership after receiving the required source, inputs and private credentials; its queue continues independently of the local process. The complete receipt includes “本机派发完成，远端实验已接管”, and only the matching local Goal revision completes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Experiments → Servers → Add server** in Web. Enter a name, SSH address, port, username, password and private remote directory. Add the address reachable by other nodes for joint training. The first server remains the coordinator; it may also participate in training. Its address, control port and state directory cannot be moved through this form.

Verify the SSH host key from the DSH host before connecting. Password connections use the verified known_hosts file, preserve password whitespace, and never fall back to a key. Passwords live in the credential provider, outside server records and browser query results. A blank password on edit preserves the saved value. Model-provider credentials are separate; configure the references selected by agentCredentialRefs before submitting.

Choose **New experiment**, enter the Goal, select one or more servers, and optionally attach files or provide absolute local file paths. All selected nodes jointly execute this experiment. Submission immediately creates a preparation row and allows another Goal to be submitted. Local paths must lie under configured dataRoots; browser attachments are staged separately. Inputs with duplicate basenames are rejected.

The detail page shows queue blockers, the full receipt, execution Session, node logs, errors and output metadata. Refresh reconciles the saved experiment ID; Cancel records cancellation on its original coordinator. Downloads stream the selected file on demand through a single-use URL. Copy to new experiment creates a fresh identity and permits changes; browser attachments must be selected again.

Existing single-server settings seed the registry once. A legacy key target without an explicit username resolves its login from the local OpenSSH configuration. Historical receipts retain their targets in the legacy settings page. The ordinary conversation /goal command retains one current Goal per conversation. The experiment list creates independent Sessions to support multiple Goals.

The experiment-dispatch profile retains prepare_experiment_environment, submit_experiment, get_experiment_status and cancel_experiment for legacy single-target work. Multi-server tools list authorized server IDs and dispatch through the same fleet service as Web. Missing credentials, unknown host keys, failed builds, unusable confinement or unavailable GPUs stop preparation.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The experiment_fleet storage domain owns the fixed coordinator registry and immutable per-experiment deployment settings. A stable ID deduplicates browser retries; tool submissions also bind the caller Session, Goal ID and revision. Preparation captures a content-addressed source archive, installs immutable releases, transfers inputs and private node credentials, then submits protocol 2. Receipt persistence precedes Goal completion and Session flush. Refresh can recover a lost reply after local restart without starting a second experiment.

Credentials delegated to the coordinator stay under its owner-only secrets directory. The source snapshot excludes credentials, dependencies and build outputs. Runtime tools and browser queries expose credential references only. Existing remote control processes retain their running version; each execution uses its own release and directories. An idle legacy receiver shuts down before its node enables protocol 2; a busy receiver blocks that upgrade.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [worker](../experiment-worker/README.md) for scheduling and the [Web panel](../../client/ui-experiments/README.md) for client lifecycle.

<a id="model-experience"></a>
## Model Experience

### Dispatch requirements and receipts

#### What the model sees

The local system instruction distinguishes queued ownership from execution. It requires explicit server authorization, preserves user constraints, and reports the `handover` field verbatim. Active dispatch Goals reject questions, approval waits and agent-initiated plugin changes, including after plugin reload.

#### Token effect

Fixed tool definitions and instructions add request tokens; receipts add task-specific server and execution evidence to Session history.

#### KV Cache effect

Definitions remain stable; each receipt extends only its owning Session history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One remote coordinator owns the queue. Automatic coordinator relocation and failover are unavailable.

- Closing the local process before handover interrupts preparation. An uncertain submission must be refreshed or cancelled by its saved ID.

- Real multi-GPU training and continuation after closing the local machine require deployment acceptance on reachable GPU servers. Local tests do not establish these results.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Implementation details — click to expand</summary>

No separate runtime invariant is published: immutable receipts and the remote queue have different owners and are reconciled by experiment identity and revision.

</details>
