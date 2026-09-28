---
description: "Local DSH tools that deploy a source snapshot to a GPU worker and hand off one unattended experiment."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experiment-dispatch

English | [中文](README.zh.md)

## Summary

The `experiment-dispatch` profile and Web Goal flow package the local DSH source, build an immutable release on a configured Linux GPU server, check sandbox and CUDA access, and submit one experiment to an independent worker. An accepted receipt saves the handover notice, completes the same local Goal revision, and records the remote Session, Goal, artifacts, and worker log. The submit tool returns the notice in the local Session. The remote run continues when the local process exits.

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

Configure `DSH_EXPERIMENT_TARGET` as an SSH host with a known host key, `DSH_EXPERIMENT_REMOTE_ROOT` as an absolute private directory, and `DSH_EXPERIMENT_TOKEN` through the DSH credential provider. Optional settings are `DSH_EXPERIMENT_SSH_PORT`, `DSH_EXPERIMENT_PORT`, `DSH_EXPERIMENT_SSH_IDENTITY`, `DSH_EXPERIMENT_DATA_ROOTS` (semicolon-separated local roots), `DSH_EXPERIMENT_SYSTEM_PACKAGES` (the comma-separated package allowlist, default `bubblewrap`), and `DSH_EXPERIMENT_SETUP_TIMEOUT_MS`. The installer extracts an allowed bubblewrap package into its private tools directory when no usable copy is available. `DSH_EXPERIMENT_AGENT_CREDENTIAL_REFS` selects comma-separated model-provider credential references; it defaults to `DEEPSEEK_API_KEY`, while an empty value selects none. Their resolved values are copied to a private per-version credential file, outside the source archive and Goal text.

Select exactly one SSH login method: `DSH_EXPERIMENT_SSH_AUTH_MODE=password` with `DSH_EXPERIMENT_SSH_USERNAME`, or the default `key` method using OpenSSH identities. Legacy `user@host` addresses remain supported. Password mode uses the SSH password method for commands, SFTP uploads and receiver requests on Windows, macOS and Linux, and never tries a saved key. Web stores passwords separately by server, port and username, preserving spaces and special characters. For a headless profile, `DSH_EXPERIMENT_SSH_PASSWORD_REF` may explicitly select a credential reference such as `GPU_PASSWORD`; supply its value through the credential provider. Passwords never enter deployment settings, preparation records, tool arguments or source archives.

Verify the server's host key with OpenSSH on the machine running DSH before dispatching. Password mode reads that user's `~/.ssh/known_hosts`, or `DSH_EXPERIMENT_KNOWN_HOSTS_FILE` when configured; it supports hashed entries and nondefault ports. Unknown, changed or revoked keys stop the connection before password authentication. Password mode requires a directly reachable server address and the SSH password method; SSH aliases, proxy commands and interactive challenges use no implicit fallback.

`DSH_EXPERIMENT_SETUP_TIMEOUT_MS` sets the preparation/submission tool deadline and the process timeout for source archiving, SSH commands and SCP transfers; the default is 1,800,000 ms. Increasing it permits longer remote installs and builds. Individual receiver HTTP requests retain a separate 15-second deadline.

Run `pnpm dsh --profile experiment-dispatch "<experiment goal>"` from the repository root. The local agent calls `prepare_experiment_environment`, then `submit_experiment` with its returned preparation id. `get_experiment_status` and `cancel_experiment` accept the returned submission id. The model, dataset, method, GPU count and other explicit requirements travel to the remote Goal. Local dataset files must be under an explicitly configured data root; without one, no local file is eligible for transfer. They are staged before the acceptance receipt. Other dataset references must already exist relative to the remote workspace.

In Web, open **Plugins → GPU experiment dispatch**, choose **Password**, and fill in the server address, SSH username, port, server password and remote directory. Configure the receiver token and model credentials separately; the server password does not replace them. Save, then enter `/goal` followed by the experiment requirements in a conversation. Saving configures the target; the Goal starts preparation and dispatch. After handover, the same page shows the saved handover notice, receipt, and remote state; **Refresh** and **Cancel** use the server, account and login method saved with that submission even after the configured server changes. A changed local Goal revision is left open when an older submission receives its receipt.

Cancelling a local submission stops automatic retries and preserves its saved submission id. The receiver may already have accepted the experiment; query that id before deciding whether to cancel the remote run with `cancel_experiment`.

An active Goal rejects human questions, approval requests, and agent-initiated plugin changes in both Web and the unattended profile; that rule is recovered after plugin reload. The SSH target, paths and secret reference come from deployment configuration rather than tool arguments. A missing credential, unknown SSH host, failed build, unusable sandbox or failed CUDA allocation stops preparation.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The source snapshot includes current regular tracked and untracked files, excluding credentials, dependencies, build outputs and common model artifacts. Its content digest and the selected server configuration identify a preparation. The worker's authenticated loopback receiver is reached through a short-lived SSH tunnel. A local storage-domain record pins one submission id to one Session, exact Goal revision, experiment description, and server configuration before transport; retrying after a lost reply uses the same id and target. The complete receiver receipt is saved before the local Goal is completed. Records from older versions remain readable, but a submission without a saved server cannot be contacted or bound to a later Goal.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [worker](../experiment-worker/README.md) for receiver lifecycle and the [sandbox subsystem](../../../docs/subsystems/sandbox.md) for file limits.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The authenticated receiver owns the durable idempotency record; the local record only preserves a retry identity. No separate runtime invariant is published because neither value is an independently maintained view of the other.

</details>

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The local Agent receives the dispatch instruction below in its system context.

##### Dispatch instruction

```markdown
For a requested remote training experiment, prepare the environment, then submit explicit requirements only when preparation returns state ready. Preserve the user's chosen model, data, method and constraints. Choose missing details within authorized resources and record them. After submit returns accepted, the remote Goal owns execution; include the handover field verbatim when reporting its identifiers and status lookup. Never wait for a human response or claim the training finished from the acceptance receipt.
```

#### Token effect

The fixed instruction adds a small amount to each local model request.

#### KV Cache effect

The instruction is prefix-stable while this plugin's configuration remains active.

### Experiment tools

#### What the model sees

The local Agent can call `prepare_experiment_environment`, `submit_experiment`, `get_experiment_status` and `cancel_experiment`; their [generated schemas](../../../docs/tool-catalog.md#deepseek-aidsh-experiment-dispatch) define the parameters. Results contain JSON preparation reports or durable receiver records; remote model history stays in a separate Session.

#### Token effect

Four fixed definitions enter the local tool catalog; each result costs tokens in proportion to its returned report.

#### KV Cache effect

Definitions stay stable across requests, while variable receipts and status responses enter only later history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Local file staging and existing remote workspace inputs are supported within these limits.

- One worker runs one active experiment; the dispatcher does not schedule multiple targets.
- A successful receipt completes the submitted local Goal only while its id and revision still match; an edited Goal needs a new submission.
- Worker restart retains an interruption record but does not automatically resume GPU training.
- Independent Verify assessment of training quality belongs to a later stage.
