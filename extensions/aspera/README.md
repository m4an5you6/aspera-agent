# Aspera extensions

English | [中文](README.zh.md)

## Summary

Submit independent training or inference Goals from the Aspera sidebar, confirm plans, inspect node logs and download experiment outputs. One remote coordinator schedules complete server groups and keeps registered inference services running after the Agent finishes. This workspace depends on published DSH `0.2.0-rc.2` packages and builds independently of the Harness checkout. GPU execution requires the separate acceptance described in [verification](docs/verification.md).

## Table of Contents

- [Start the management page](#start-the-management-page)
- [Build the desktop application](#build-the-desktop-application)
- [Submit an experiment](#submit-an-experiment)
- [Develop and upgrade](#develop-and-upgrade)
- [Further Exploration](#further-exploration)

-----

<a id="start-the-management-page"></a>
## Start the management page

Use Node `^22.19.0 || >=24.0.0` and pnpm `11.7.0`. Run these commands from the repository root; dependencies and build outputs stay in this workspace.

```text
cd extensions/aspera
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:web --no-open
```

Open the URL printed by DSH, finish its initial configuration and select **Aspera** in the sidebar. The startup script creates the `aspera` profile under `.dsh-home`; `ASPERA_HOME` selects another independent state directory. Use the Aspera group gear to open **Aspera model settings** and manage the existing DSH model accounts. New experiments choose preparation, planning and execution models independently; supported API configurations and private keys are captured before submission.

The management host supports Windows; execution nodes require Linux, password SSH login, a trusted host key in the management user's `~/.ssh/known_hosts`, Node/pnpm, NVIDIA devices and usable bubblewrap. Install these prerequisites on the servers before dispatch. Multi-node experiments also need mutually reachable training addresses. Missing CUDA, confinement or communication blocks execution with a recorded error.

-----

<a id="build-the-desktop-application"></a>
## Build the desktop application

Build and verify the independent Windows application from this workspace.

```text
pnpm run build:desktop
pnpm run test:desktop
```

Aspera `0.1.1` builds into `.artifacts/desktop-0.1.1/<build-id>/`; `latest.json` identifies the latest successful build. Run `win-unpacked/Aspera.exe` and retain the complete application directory. Packaging does not generate a ZIP. Electron, DSH, Aspera and pnpm are included. See the [desktop guide](apps/desktop/README.md) for checksums and build limits, and the [architecture diagrams](docs/architecture.md#architecture-diagrams) for module and execution relationships.

-----

<a id="submit-an-experiment"></a>
## Submit an experiment

1. Open **Servers** and enter a name, SSH address, port, username and password. Advanced settings offer automatic/manual storage, an optional internal IP/hostname and the control port (default `43019`; coordinator uses the next port). Leave storage and networking automatic unless an explicit location is required. The first server remains the coordinator and may also execute experiments.
2. Save and **Check connection**. Saving only records settings and a separate write-only password; checking reads SSH, GPU, disk and network facts without a model. A blank password on an existing server retains its saved value. Unknown disk persistence does not establish cloud-volume durability.
3. Open **New experiment**, enter a short experiment name and natural-language Goal, select the three Agent models and one or more servers, attach inputs and choose execution mode. Automatic is the default; neither mode needs a task budget.
4. Submit and continue creating experiments. The dispatch Agent selects an observed disk and records its reason before directory creation. Sufficient data disks are preferred; sufficient system disks are allowed. Details show actual paths, free space and verified internal addresses. Semi mode waits for **Confirm this plan** before model downloads or training and does not reserve nodes while waiting.
5. After durable remote acceptance, the detail and dispatch Session show **本机派发完成，远端实验已接管**. This completes dispatch; the experiment may still be planning, queued, running or serving.
6. For external inference, expand **External inference access (optional)** in the server form and enter the platform HTTPS base URL and its mapped container/server port. This mapping is frozen for new experiments; request public inference in the Goal. Service details distinguish local health from external reachability and expose the service-only key through **Show calling information and key**.
7. Use **Overview** for progress and decisions, **Agent records** for phase-specific trajectory/conversation views, and **Runtime monitor** for node/process stdout and stderr. Expand the full Goal or technical details when needed. Output and service tabs expose downloads and access operations. Download files as needed. Stop services or cancel the experiment to release its servers after confirmed cleanup.

Use **Needs attention** to find plan confirmations and saved questions. Semi mode pauses new Agent operations for unresolved choices; answer the question card to continue the original experiment. Opening a card does not clear its indicator. The yellow reminder can be dismissed with ×; it stays dismissed for that decision revision across reloads, without resolving the decision or reducing the pending count. A new plan or question revision is shown again. Automatic mode investigates and retries recoverable failures without asking for replies. Both modes retain cancellation, confinement and loop protection; [runtime](packages/runtime/README.md) defines continuation and failure behavior.

Use **Copy as new experiment** to change a submitted objective, model, dataset, training method or server selection. Copying retains the original mode. Shared servers queue in remote admission order; disjoint server groups can execute together. A serving experiment retains its complete group, and the page names the queued experiments it blocks.

-----

<a id="develop-and-upgrade"></a>
## Develop and upgrade

The four packages own [records and scheduling](packages/experiments/README.md), [node and Agent execution](packages/runtime/README.md), [DSH integration](packages/dispatch/README.md), and the [Web page](packages/console/README.md). Their imports target published DSH packages, with no upstream source paths. Framework guidance ships as runtime skills; Agent-selected parameters are checked through short runs and measured evaluation.

```text
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:worker
pnpm run test:control
pnpm run test:web
pnpm run test:installed
pnpm run pack
```

Browser checks use installed Chrome by default; `ASPERA_BROWSER_CHANNEL` selects another installed Playwright channel; `ASPERA_BROWSER_EXECUTABLE` selects an explicit browser executable. Installed verification extracts the release outside the source checkout and uses the local pnpm store. `pack` writes a content-addressed archive to `.artifacts/`; remote dispatch uses the same packaging path.

For a DSH upgrade, update exact dependency versions and the lockfile, review the two pinned package patches in `patches/`, generated Remotes and browser compatibility code, then run these checks and publish a new extension release. Keep existing release directories and active control processes while their experiments are in flight. State and protocol compatibility decisions belong in the [versioned data reference](docs/state-and-api.md).

See the [model upgrade guide](../../docs/upgrade-guide/v0.2.0-rc.2/aspera-models-v4/guide.md) for generation-4 API and persistence compatibility. Failed new preparations support **Retry preparation** with the saved identity and paths; changed mounts, inputs or builds require correction or a new experiment. `aspera-ext-spike` remains a historical probe; development and packaging use this workspace.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Architecture and extension points](docs/architecture.md)
- [State, receipts and APIs](docs/state-and-api.md)
- [Local verification and GPU acceptance](docs/verification.md)
- [MIT license](LICENSE)
