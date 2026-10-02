# Verification

English | [中文](verification.zh.md)

## Summary

Run the independent workspace's checks after changing its code, generated Remote, package versions or release files. Local fixtures verify scheduling, DSH integration and service lifecycle without model credentials or GPU access. They do not establish CUDA, real framework training or multi-node collective correctness.

## Table of Contents

- [Local checks](#local-checks)
- [GPU acceptance](#gpu-acceptance)

-----

<a id="local-checks"></a>
## Local checks

Run from the workspace after a frozen install. Build before profile-based checks so they consume current published artifacts.

```text
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:api
pnpm run test:worker
pnpm run test:control
pnpm run test:web
pnpm run test:installed
pnpm run build:desktop
pnpm run test:desktop:api
pnpm run test:desktop
```

Unit tests use private state directories, managed-process doubles and OS-assigned network ports. They cover joint allocation/FIFO, restart ambiguity, immutable retry identity, server pins, edited Goal refusal, cancellation races, input size/digest checks, password transport, file confinement, download cancellation, UTF-8 cursors and service stop/health races. The symlink-escape fixture runs on Linux/macOS and skips on Windows.

`test:api` launches the production management profile with its real dispatch adapter and checks authenticated server and experiment reads against a version-1 registry. `test:desktop:api` uses the existing unpacked application, an upgraded profile and a Unicode state path outside the checkout. It verifies the same server API and saves a server through the real form. Neither check creates a release ZIP or substitutes the dispatch adapter.

`test:worker` launches the production worker profile with a keyless replay provider. It checks the actual planning/execution tool lists, denied input access, declared input reads, framework guidance, durable plan/execution records and [Session snapshot](../scripts/fixtures/worker.snapshot.json). Automatic execution Agents have no global commands, plugin installation or human waiting. Continuation replay crosses the original 128-round cap, checks every window extension is logged, and keeps the same Session and Goal.

`test:control` launches the production coordinator and a planning worker with a real storage domain. It verifies real persisted questions, no new model calls during pause, concurrent identical replies, conflict and post-cancel refusal, same-Goal resumption, and authenticated admission, complete handover, a resource-free durable plan across coordinator restart, identical retry after staged-input removal, changed-content refusal, orphaned execution refusal and cancellation. The [question Session snapshot](../scripts/fixtures/control.snapshot.json) records the saved question, answer, original tool result and Goal transitions. Fake node inventory is used only because the plan waits for approval; no GPU command is launched.

`test:web` uses the real published Web composition and generated ordinary/streaming Remotes with an explicit CPU deployment provider. It exercises password forms, attachments, independent Goals, plan confirmation, parallel/shared queues, handover text and [dispatch snapshot](../scripts/fixtures/session.snapshot.json), reconnect/rotation, conversation separation, output download, actual private HTTP service access, browser disconnect, stop, unexpected exit, cancellation and error display, together with question cards, attention counts, disconnect persistence and same-experiment continuation. The service itself is a separate `dsh` profile process. Screenshots are written to `.artifacts/`.

`test:installed` packages built release files, installs frozen production dependencies outside the checkout, typechecks a NodeNext consumer, repackages from that installed layout, and launches its official profile. It verifies client declarations, sidebar registration, username/password fields and live Remote snapshots. Tests require an installed browser and a populated pnpm store; production dispatch requires access to the configured package registry.

-----

The [desktop guide](../apps/desktop/README.md#build-and-verify) owns packaged Electron verification and the Windows application limits. Desktop reuses Web's experiment service and recorded-session projections.

-----

<a id="gpu-acceptance"></a>
## GPU acceptance

No GPU server is available for this delivery. A GPU operator performs the following acceptance with two mutually reachable Linux nodes, trusted SSH host keys and private passwords already stored in the management profile.

1. Probe both nodes and verify bubblewrap refuses outside writes/private credential reads while the granted CUDA devices execute a short computation.
2. Dispatch separate-node tasks, a shared-node queued task and one joint task. Confirm stable ranks, actual collective communication and a short version-pinned training run; inspect recorded scripts, environments, parameters and measured outputs.
3. Disconnect and then shut down the management machine after receipt. Verify the remote coordinator admits queued work, executes it and records its outcome without the management host.
4. Load the resulting training artifact into a registered loopback inference service. Confirm a real prediction, health, retained server occupation, stop cleanup and queued-task progression.
5. Restart the coordinator during queueing and service observation, then test node failure, cancellation competition and a lost receipt. Verify no duplicate training, no changed server group and no release before confirmed cleanup.

Record exact node/driver/framework versions, release identity, commands, logs and evaluation outputs. Unverified process identities remain interrupted for operator reconciliation; they are not an automatic retry acceptance path.
