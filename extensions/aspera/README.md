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

Open the URL printed by DSH, finish its initial configuration and select **Aspera** in the sidebar. The startup script creates the `aspera` profile under `.dsh-home`; `ASPERA_HOME` selects another independent state directory. Model credentials belong in that profile's DSH credential provider; the default transferred reference is `DEEPSEEK_API_KEY`. Select a provider/model available in the pinned worker profile before submitting.

The management host supports Windows; execution nodes require Linux, password SSH login, a trusted host key in the management user's `~/.ssh/known_hosts`, Node/pnpm, NVIDIA devices and usable bubblewrap. Install these prerequisites on the servers before dispatch. Multi-node experiments also need mutually reachable training addresses. Missing CUDA, confinement or communication blocks execution with a recorded error.

-----

<a id="build-the-desktop-application"></a>
## Build the desktop application

Build and verify the independent Windows application from this workspace.

```text
pnpm run build:desktop
pnpm run test:desktop
```

Run `.artifacts/desktop-0.2.0/win-unpacked/Aspera.exe` with its complete application directory. The local build carries Electron, DSH, Aspera and pnpm; the target computer needs no separate Node or pnpm installation. See the [desktop guide](apps/desktop/README.md) for settings and build limits, and the [architecture diagrams](docs/architecture.md#architecture-diagrams) for module and execution relationships.

-----

<a id="submit-an-experiment"></a>
## Submit an experiment

1. Open **Servers**, add a name, SSH address, port, username, password and dedicated absolute remote directory. Set a training address for joint experiments. The first server remains the coordinator; it may also participate in execution.
2. Save the server and test its connection. Saving records configuration and a separate write-only password; it does not launch training. A blank password on an existing server retains its saved value.
3. Open **New experiment**, enter a natural-language Goal, select one or more servers, attach inputs and choose execution mode. Automatic is the default; neither mode needs a task budget.
4. Submit and continue creating other experiments. Each experiment owns independent dispatch and execution Sessions. Semi mode prepares a plan and waits for **Confirm this plan** without reserving nodes; automatic mode proceeds within the fixed requirements.
5. After durable remote acceptance, the detail and dispatch Session show **本机派发完成，远端实验已接管**. This completes dispatch; the experiment may still be planning, queued, running or serving.
6. Use the detail tabs for plans, execution messages, node logs, output metadata and private inference requests. Download files as needed. Stop services or cancel the experiment to release its servers after confirmed cleanup.

Use **Needs attention** to find plan confirmations and saved questions. Semi mode pauses new Agent operations for unresolved choices; answer the question card to continue the original experiment. Opening a card does not clear its indicator. Automatic mode investigates and retries recoverable failures without asking for replies. Both modes retain cancellation, confinement and loop protection; [runtime](packages/runtime/README.md) defines continuation and failure behavior.

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

Browser checks use installed Chrome by default; `ASPERA_BROWSER_CHANNEL` selects another installed Playwright channel. Installed verification extracts the release outside the source checkout and uses the local pnpm store. `pack` writes a content-addressed archive to `.artifacts/`; remote dispatch uses the same packaging path.

For a DSH upgrade, update exact dependency versions and the lockfile, check the generated Remote and browser compatibility code, then run these checks and publish a new extension release. Keep existing release directories and active control processes while their experiments are in flight. State and protocol compatibility decisions belong in the [versioned data reference](docs/state-and-api.md).

See the [0.2.0 upgrade guide](../../docs/upgrade-guide/v0.2.0-rc.2/aspera-execution-v2/guide.md) for removed budgets and safe controller replacement.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Architecture and extension points](docs/architecture.md)
- [State, receipts and APIs](docs/state-and-api.md)
- [Local verification and GPU acceptance](docs/verification.md)
- [MIT license](LICENSE)
