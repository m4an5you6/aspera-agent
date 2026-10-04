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

Lint uses the extension's own configuration and checks both TypeScript sources and maintenance scripts.

Management tests cover serialized coordinator conflicts, disjoint admission, explicit password reveal, successful checks followed by failure, stale configuration replies and interrupted checks. Deletion tests cover active batches, unconfirmed releases, partial-node retries, restart recovery, tombstones and delayed replies. Storage cleanup runs against real CPU files with synthetic Linux mount facts, rejecting wrong owners, changed mounts, nested bind mounts and path escape; directory links retain their external contents. The Web management replay verifies light/dark/narrow layout A, masked/revealed passwords, dated historical hardware, coordinator selection, cleanup failure and record-only recovery. It writes `management-*.png` screenshots and records outcomes in the dispatch snapshot.

Preparation tests cover missing programs, release engine ranges and pinned pnpm, namespace denial, nonzero commands, SSH authentication, timeout/cancellation, unconfirmed exits, durable progress failure and unauthorized servers. Completion requires provider verification. Retry cases retain protocol-4 Sessions and original releases after local upgrades, recover remote receipts and serialize shared-server preparation. The Web replay drives the standard preparation Agent through diagnostic tools, a failed download, repair and verification, recording the tool sequence in the dispatch snapshot.

Model fixtures create and resume concurrent standard DSH Agents, sending real published provider HTTP requests to CPU loopback endpoints with independent phase keys and models. A same-named global provider stays unchanged; Agent publication, initiator tracking and disposal remain visible to the profile. Admission tests cover configuration changes, unsupported authentication, missing credentials and private/public separation. Record and process cases cover source-bound cursors, partial tails, rotation, pagination and isolation. Browser verification covers model selection, dismissed-decision persistence and tool-to-process navigation.

Unit tests use private state directories, managed-process doubles and OS-assigned ports. Coverage includes data/system disks, unknown durability, manual paths, write/space refusal, mount changes, directory ownership, preparation retry, immutable IDs, Goal revision checks, multi-interface selection, one-way failures, wrong receiver proofs and listener cleanup. Queue, input, file, cursor and service races remain covered. The symlink-escape fixture runs on Linux/macOS and skips on Windows.

`test:api` launches the production management profile with its real dispatch adapter and checks authenticated server and experiment reads against a version-1 registry. `test:desktop:api` uses the existing unpacked application, an upgraded profile and a Unicode state path outside the checkout. It verifies the same server API and saves a server through the real form. Neither check creates a release ZIP or substitutes the dispatch adapter.

`test:worker` launches the production worker profile. Planning and execution use the published pi-ai adapter against a loopback HTTP fixture, checking saved authentication and actual provider requests; continuation and recovery use stream replay. It checks the actual planning/execution tool lists, denied input access, declared input reads, framework guidance, durable plan/execution records and [Session snapshot](../scripts/fixtures/worker.snapshot.json). Automatic execution Agents have no global commands, plugin installation or human waiting. Continuation replay crosses the original 128-round cap, checks every window extension is logged, and keeps the same Session and Goal.

`test:control` launches the production coordinator and a planning worker with a real storage domain. It verifies real persisted questions, no new model calls during pause, concurrent identical replies, conflict and post-cancel refusal, same-Goal resumption, and authenticated admission, complete handover, a resource-free durable plan across coordinator restart, identical retry after staged-input removal, changed-content refusal, orphaned execution refusal and cancellation. Coordinator startup, question persistence and post-reply planning each have a separate 60-second test deadline. The [question Session snapshot](../scripts/fixtures/control.snapshot.json) records the saved question, answer, original tool result and Goal transitions. Fake node inventory is used only because the plan waits for approval; no GPU command is launched.

`test:web` uses published Web composition and generated Remotes with an explicit CPU provider. It checks SSH-only server saving, model-free connection inventory, logged Agent storage choice, saved paths and plan confirmation, attachments, independent Goals, queues, handover and the [dispatch snapshot](../scripts/fixtures/session.snapshot.json). It also covers reconnect/rotation, conversation separation, downloads, actual profile-hosted HTTP services, disconnect, stop, failure, cancellation and persisted questions. Public-inference cases exercise the real authenticated gateway, streaming responses, identity mismatch, cancelled listeners, optional form fields and operator-only calling information. Overview checks cover all four phases, pending retry across navigation, paused decisions, saved node evidence, expandable errors, and light/dark layouts at desktop and narrow widths. Screenshots are written to `.artifacts/`.

`test:installed` packages built release files, installs frozen production dependencies outside the checkout, typechecks a NodeNext consumer, repackages from that installed layout, and launches its official profile. It verifies client declarations, sidebar registration, username/password fields and live Remote snapshots. Tests require an installed browser and a populated pnpm store; production dispatch requires access to the configured package registry.

-----

The [desktop guide](../apps/desktop/README.md#build-and-verify) owns packaged Electron verification and the Windows application limits. Desktop reuses Web's experiment service and recorded-session projections.

-----

<a id="gpu-acceptance"></a>
## GPU acceptance

No GPU server is available for this delivery. The CPU replay verifies Agent orchestration with injected command results; it does not install Linux dependencies or establish sandbox/CUDA readiness. A GPU operator performs the following acceptance with two mutually reachable Linux nodes, trusted SSH host keys and private passwords already stored in the management profile.

Start with a disposable login environment missing Node, pnpm, Python or bubblewrap. Confirm that the preparation Agent installs the release-required versions, preserves installation diagnostics and passes actual workspace, isolation, credential-hiding, CUDA and network probes. Repeat with denied namespaces, unavailable downloads and interrupted installation; record the platform action or reconciled exit rather than bypassing checks. Retry a failed protocol-4 experiment after updating only the local application, and verify its original remote release is reused.

1. Probe both nodes, verify the selected mount and cloud-volume persistence with the provider, and test saved paths after unmount/remount. Check bidirectional internal communication and bubblewrap refusal of outside writes, control credentials and other experiment reads while granted CUDA devices execute a short computation.
2. Dispatch separate-node tasks, a shared-node queued task and one joint task. Confirm stable ranks, actual collective communication and a short version-pinned training run; inspect recorded scripts, environments, parameters and measured outputs.
3. Disconnect and then shut down the management machine after receipt. Verify the remote coordinator admits queued work, executes it and records its outcome without the management host.
4. Load the resulting training artifact into a registered loopback inference service. Confirm a real prediction, health, retained server occupation, stop cleanup and queued-task progression.
5. Restart the coordinator during queueing and service observation, then test node failure, cancellation competition and a lost receipt. Verify no duplicate training, no changed server group and no release before confirmed cleanup.

Record exact node/driver/framework versions, release identity, commands, logs and evaluation outputs. Unverified process identities remain interrupted for operator reconciliation; they are not an automatic retry acceptance path.
