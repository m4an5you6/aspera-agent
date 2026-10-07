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

Node lifecycle tests use the published per-record JSON backend to verify accepted run IDs, cross-experiment separation, duplicate requests, stream lookup, service stop and confirmed/unconfirmed restart recovery. `test:worker` also records production `run_experiment_command` calls through authenticated loopback routes, with CPU-only process handles and actual durable records; duplicate calls launch one process and Agent tools read its complete node output.

Installation recovery checks use `installation.spec.ts`, preparation/fleet/controller tests and `python3 packages/dispatch/tests/installation_executor_test.py` on Linux. The Python fixture runs the shipped supervisor with owned temporary archives and fake package-manager/compiler processes. It covers progressing downloads, silent compilation, ineffective heartbeats, idle/total expiry, checkpoint reuse, original-material checks, complete final output and identity-safe cancellation. It uses no model account, SSH server or GPU. The real Web replay also covers autonomous source probes/switches, verification, fixed budgets, once-only non-shifting Toasts and light/dark/narrow progress screenshots named `web-installation-recovery-*.png`.

`pnpm run test:observations:web` uses real recorded CPU Sessions to verify official trajectory rendering, automatic history, phase search restoration, linked scrolling, tool-to-log navigation, continued receiving while reading history, complete downloads and persistent Toast deduplication without layout movement. It writes `observations-*.png` screenshots. Focused observation tests cover full events, attachments, output redaction, cursor ownership, rotation, missing files, real sample gaps and authenticated coordinator loopback.

An existing desktop can receive a resource-only update after these checks. Run `pnpm run update:desktop:resources --prepare`, then `pnpm run update:desktop:resources --apply <prepared-directory>`. Preparation verifies frozen dependencies and the published rendering patches. Apply refuses a changed carrier or runtime, saves a backup, replaces `runtime.asar` and changed unpacked resources, and records hashes in the existing build metadata. It preserves `Aspera.exe`, the desktop application files, user data and submitted experiments. It does not run `build:desktop`, create a desktop delivery directory or produce a ZIP. Restart the application normally to load the new resources; no user process is terminated by the updater.

Management tests cover serialized coordinator conflicts, disjoint admission, password reveal, dated checks and stale replies. Deletion tests cover acknowledged offline removal, retained server snapshots, unresolved endpoint ownership, pending-cleanup switching, local cleanup recovery, tombstones and late replies. Storage cleanup uses real CPU files and synthetic Linux mount facts to reject wrong owners, changed/nested mounts and path escape; external link contents remain. Real-file legacy log tests cover truncation in both read directions without bypassing redaction. The Web replay verifies light/dark/narrow compact dialogs, offline deletion, retained linked experiments, return filters, passwords, hardware history and coordinator selection. It writes `management-*.png` and records outcomes in the dispatch snapshot.

Preparation tests cover missing programs, release engine ranges and pinned pnpm, namespace denial, nonzero commands, SSH authentication, timeout/cancellation, unconfirmed exits, durable progress failure and unauthorized servers. Completion requires provider verification. Retry cases retain protocol-4 Sessions and original releases after local upgrades, recover remote receipts and serialize shared-server preparation. The Web replay drives the standard preparation Agent through diagnostic tools, a failed download, repair and verification, recording the tool sequence in the dispatch snapshot.

Model fixtures create and resume concurrent standard DSH Agents, sending real published provider HTTP requests to CPU loopback endpoints with independent phase keys and models. A same-named global provider stays unchanged; Agent publication, initiator tracking and disposal remain visible to the profile. Admission tests cover configuration changes, unsupported authentication, missing credentials and private/public separation. Record and process cases cover source-bound cursors, partial tails, rotation, pagination and isolation. Browser verification covers model selection, dismissed-decision persistence and tool-to-process navigation.

Unit tests use private state directories, managed-process doubles and OS-assigned ports. Coverage includes data/system disks, unknown durability, manual paths, write/space refusal, mount changes, directory ownership, preparation retry, immutable IDs, Goal revision checks, multi-interface selection, one-way failures, wrong receiver proofs and listener cleanup. Queue, input, file, cursor and service races remain covered. The symlink-escape fixture runs on Linux/macOS and skips on Windows.

`test:api` launches the production management profile with its real dispatch adapter and checks authenticated server and experiment reads against a version-1 registry. `test:desktop:api` uses the existing unpacked application, an upgraded profile and a Unicode state path outside the checkout. It verifies the same server API and saves a server through the real form. Neither check creates a release ZIP or substitutes the dispatch adapter.

`test:worker` launches the production worker profile. Planning and execution use the published pi-ai adapter against a loopback HTTP fixture, checking saved authentication and actual provider requests; continuation and recovery use stream replay. It checks the actual planning/execution tool lists, denied input access, declared input reads, framework guidance, durable plan/execution records and [Session snapshot](../scripts/fixtures/worker.snapshot.json). Automatic execution Agents have no global commands, plugin installation or human waiting. Continuation replay crosses the original 128-round cap, checks every window extension is logged, and keeps the same Session and Goal. Step-report replay drives the actual tools through missing reports, revision conflict, blocked-step recovery and restart reads; completed reports without successful commands still fail independent acceptance.

`test:control` launches the production coordinator and a planning worker with a real storage domain. It verifies real persisted questions, no new model calls during pause, concurrent identical replies, conflict and post-cancel refusal, same-Goal resumption, and authenticated admission, complete handover, a resource-free durable plan across coordinator restart, identical retry after staged-input removal, changed-content refusal, orphaned execution refusal and cancellation. Coordinator startup, question persistence and post-reply planning each have a separate 60-second test deadline. The [question Session snapshot](../scripts/fixtures/control.snapshot.json) records the saved question, answer, original tool result and Goal transitions. Fake node inventory is used only because the plan waits for approval; no GPU command is launched.

`test:web` uses published Web composition and generated Remotes with an explicit CPU provider. It checks SSH-only server saving, model-free connection inventory, logged Agent storage choice, saved paths and plan confirmation, attachments, independent Goals, queues, handover and the [dispatch snapshot](../scripts/fixtures/session.snapshot.json). It also covers reconnect/rotation, conversation separation, downloads, actual profile-hosted HTTP services, disconnect, stop, failure, cancellation and persisted questions. Public-inference cases exercise the real authenticated gateway, streaming responses, identity mismatch, cancelled listeners, optional form fields and operator-only calling information. Overview checks cover all four phases, pending retry across navigation, paused decisions, saved node evidence, expandable errors, and light/dark layouts at desktop and narrow widths. Screenshots are written to `.artifacts/`.

[Overview checks](../scripts/test-overview.mjs) use production components and an explicit CPU display fixture. They cover the actual saved plan, two nodes, bounded error summaries, collapsed localized/unknown diagnostics, three core metrics, missing values, valid/invalid step totals, retained reports after read failures, stopped animations, old releases, keyboard disclosures, both locales and responsive light/dark columns. `test:web -- --keep-preview` retains this isolated profile for review; it uses test data and never establishes real GPU acceptance.

`test:installed` packages built release files, installs frozen production dependencies outside the checkout, typechecks a NodeNext consumer, repackages from that installed layout, and launches its official profile. It verifies client declarations, sidebar registration, username/password fields and live Remote snapshots. Tests require an installed browser and a populated pnpm store; production dispatch requires access to the configured package registry.

-----

The [desktop guide](../apps/desktop/README.md#build-and-verify) owns packaged Electron verification and the Windows application limits. Desktop reuses Web's experiment service and recorded-session projections.

-----

<a id="gpu-acceptance"></a>
## GPU acceptance

No GPU server is available for this delivery. The CPU replay verifies Agent orchestration with injected command results; it does not install Linux dependencies or establish sandbox/CUDA readiness. A GPU operator performs the following acceptance with two mutually reachable Linux nodes, trusted SSH host keys and private passwords already stored in the management profile.

Record detected hardware separately from Goal requirements. A T4 requirement on an RTX 4090 node requires an explicit decision before copying or executing the task. A copied task may use the repaired command-record release and step reporting only after the original task's node ownership and process cleanup are confirmed; its pinned release is never replaced in place.

Start with a disposable login environment missing Node, pnpm, Python or bubblewrap. Confirm that the preparation Agent installs the release-required versions, preserves installation diagnostics and passes actual workspace, isolation, credential-hiding, CUDA and network probes. Repeat with denied namespaces, unavailable downloads and interrupted installation; record the platform action or reconciled exit rather than bypassing checks. Retry a failed protocol-4 experiment after updating only the local application, and verify its original remote release is reused.

1. Probe both nodes, verify the selected mount and cloud-volume persistence with the provider, and test saved paths after unmount/remount. Check bidirectional internal communication and bubblewrap refusal of outside writes, control credentials and other experiment reads while granted CUDA devices execute a short computation.
2. Dispatch separate-node tasks, a shared-node queued task and one joint task. Confirm stable ranks, actual collective communication and a short version-pinned training run; inspect recorded scripts, environments, parameters and measured outputs.
3. Disconnect and then shut down the management machine after receipt. Verify the remote coordinator admits queued work, executes it and records its outcome without the management host.
4. Load the resulting training artifact into a registered loopback inference service. Confirm a real prediction, health, retained server occupation, stop cleanup and queued-task progression.
5. Restart the coordinator during queueing and service observation, then test node failure, cancellation competition and a lost receipt. Verify no duplicate training, no changed server group and no release before confirmed cleanup.

Record exact node/driver/framework versions, release identity, commands, logs and evaluation outputs. Unverified process identities remain interrupted for operator reconciliation; they are not an automatic retry acceptance path.
