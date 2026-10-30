---
description: "Use the independent Aspera Web sidebar for server configuration, experiment approval, incremental logs, outputs and inference services."
kind: "package-reference"
---

# @aspera/console

English | [中文](README.zh.md)

## Summary

Manage remote experiments in a dedicated page while keeping ordinary conversations available. Add password servers, submit consecutive Goals, confirm plans and inspect progress, receipts, messages, node logs and outputs. Access and stop private inference services, with the queued experiments they block shown in context. The Host owns task state; browser unload only ends page effects.

[Original-task recovery](../../docs/completion-review.md#recover-acceptance-on-the-original-experiment) keeps recovery progress, its Agent trajectory and associated inference services on the original detail page. Service actions use the associated execution identity; the original blocked result remains visible.

The inference page prioritizes connection information and separately dated process/public status. Original and recovery aliases share one service entry; unreleased failures remain current and released services collapse into history. Per-service request fields and results survive navigation in client memory; keys stay outside that store and clear on service or page changes. [Calling examples and managed requests](../../docs/public-inference.md#use-the-inference-page) explain the default PowerShell example, optional copying with a key, cURL and confirmed stops.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Overview keeps its four-phase header and work/resource columns. Execution steps show a short heading and one result excerpt; completed and remaining steps collapse by default while current blockers stay visible. Search includes full hidden requirements and reports; expansion retains approved text, evidence and the Agent-record entry. Reading preferences are keyed by experiment, plan revision and execution Session. Agent completion counts remain separate from program acceptance. Storage uses per-node summaries and a shared-data detail Modal with allocations, capacity, history, scans and cleanup; failed reads retain the previous measurement and time. [Storage governance](../../docs/storage-governance.md) owns placement and fallback behavior.

The dispatch bundle mounts this plugin in the independent [management profile](../../README.md#start-the-management-page). Its manifest projects `./client` into the Web client; it has separate Host/client compiler programs and published client declarations. The pinned sidebar and settings-command patches are owned by the [Aspera adapter](../../docs/architecture.md#components).

[Config](src/config.ts) selects page polling, retained text length and the initial control port for new server forms. Text retention limits apply to displayed tails, not saved local or remote files. [AsperaRemote](../dispatch/src/index.ts) supplies operation defaults and validated state; typed English/Chinese dictionaries own all product labels.

[Record saving](../../docs/state-and-api.md#local-running-records) sits below execution resources in Overview's right column. The card shows the last successful check and local size, with historical gaps in a separate disclosure. Ordinary background checks retain a static result; only an explicit synchronization request shows a pending button. Detail-owned status reads continue across tabs, independently of the card. Agent records initially select the current phase and retain manual selection; uncopied offline attachments request reconnection. Monitoring paginates saved measurements using their recorded time. A locally readable copy does not establish current remote execution or clear its connection error.

Overview displays each node's saved installation step, sources, elapsed budget, retries and previous recovery history, with an installation-log link. Actual source switches produce a dismissible official floating Toast with a reason action. The management profile persists each switch identity before display, so refresh, navigation and restart do not repeat it. Closing the notice does not erase history or change preparation state.

The controller keeps experiment/node/source decoders and byte cursors when selection changes or the connection resets. Missing/rotated logs are indicated explicitly. Copying a submitted experiment creates a new request; approval and cancellation use the displayed experiment identity. Inference requests use managed connections and bounded responses; model outputs remain files until downloaded.

The compact experiment table offers multi-selection, filters, a short name and semantic status colors shared with detail pages. Needs-attention filtering includes failures and blockers; the decision badge counts only plans and questions. Row, detail and batch dialogs separate local deletion from optional remote cleanup. Local deletion stays available offline; pending or failed cleanup can switch to record-only removal. Dialogs retain node progress and collapsed error details. Deleted identities suppress delayed replies and reconnect snapshots; the return button preserves list filters and reading position.

Server cards separate the current dated check from historical hardware. Failed or interrupted checks cannot appear healthy. Busy requests survive navigation, and changed configuration invalidates old replies. Server deletion lists linked experiments and retains their snapshots. Deleted tasks with unconfirmed release expose Verify and release and explicit Interrupt remote task; progress, blockers and retries remain available without restoring a deleted experiment. These operations preserve remote environments, models and logs. Check connection remains read-only. An editor initially masks the saved password and fetches it only after an eye-button action; unchanged reveals are never submitted as updates. Closing the form clears plaintext. [Dispatch](../dispatch/README.md#use-this-package) owns SSH trust and per-experiment coordinator selection.

Connection status distinguishes reachable SSH from missing dependencies. Overview shows four phases: prepare environment, create plan, execute plan and view results. The left column contains current activity, actual plan steps and collapsed diagnostics; the right contains saved nodes/GPU evidence, independent preparation acceptance, models, storage, network and Goal. Narrow windows stack these columns. Running work and pending retries animate; confirmation, resource waits and stopped work do not. Retry survives navigation and repeated clicks share its request. Full errors, internal metrics and raw data expand below the work area. Known metrics have localized labels; unknown names remain readable.

Execution steps use the saved plan version and explicitly label Agent reports. The controller reads the selected experiment's [step progress](../../docs/state-and-api.md#execution-step-progress), retains dated reports after read failures and discards replies after selection changes or deletion. Old releases display the original plan with unrecorded progress; completion and internal metrics never manufacture step reports. Plans retain framework links and manual confirmation, while open questions keep their existing reply flow. Preparation records retain program paths, isolation/GPU acceptance and installation history.

The page reuses DSH typography, light/dark tokens, Button, Input, Checkbox, Tag, Modal and portaled Menu. An optional external-inference section records the platform URL and mapped internal port; service cards separate local health and external checks. Calling keys appear only after an explicit operator action. Server dialogs keep five SSH fields visible and put automatic/manual storage, optional internal address and control port in Advanced settings. Expanded sections scroll within the window, keeping the save action reachable. Last inventory includes free space, write access and unknown durability. Experiment details show preparation stages, saved directories, network addresses and reasons alongside plan confirmation. New forms and copied experiments preserve their execution mode.

The controller refreshes pending state even when the Aspera page is not open. Sidebar, list and desktop receive the same distinct experiment count, including plan confirmations and open questions; reading a card does not acknowledge it. Page reads follow the selected experiment; background copying belongs to the Host profile. Desktop-only count delivery uses its validated private bridge.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Running experiments expose Interrupt experiment in the detail page and list menu; pending tasks expose Cancel experiment. [InterruptionProgress](src/client/InterruptionProgress.tsx) shows program-owned node exit and release checks. A blocked operation stops animation and offers retry; confirmed release preserves history. Steps retain their last running report as unverified until program-confirmed resource release permits a stopped label. Navigation keeps Host work active, and deleted or older replies cannot restore records or running state. See [interruption APIs](../../docs/state-and-api.md#experiment-interruption).

The official sidebar hosts one collapsible Aspera group whose leading icon becomes a disclosure triangle on hover or keyboard focus. Its gear opens Aspera model settings; the configuration entry invokes the official DSH settings command. Three-phase selection reuses the configured provider accounts. Selector labels stay on one line with ellipsis, and DSH tooltips show their complete names on hover or keyboard focus; menu options wrap within the card. Reminder dismissal persists by experiment, decision kind and revision; new decisions reappear without changing the shared attention count.

Agent records use the published DSH trajectory assembler, timeline, turn/call folding, search and inspector through the read-only factory patch. Phase selectors share its toolbar; each phase keeps its search, selection and reading position. The timeline uses recorded clock times and links horizontal scrolling to visible events. Near the history edge, pages load automatically. Both execution modes use this read-only view; decisions remain in Overview. Missing or truncated historical events are labeled rather than reconstructed.

Runtime monitoring shows measured resources, reported training metrics and a resizable log ledger. Defaults are two-second polling and a fifteen-minute chart window. Reading older output stops scrolling while receiving continues; Back to latest rejoins the live window. Registered sources, output streams, search, history and complete-log downloads share bounded cursors. Floating DSH Toasts show each scoped error once, with close and technical-detail actions; failed experiment and disconnected-source states remain visible. [State and APIs](../../docs/state-and-api.md#logs-outputs-and-services) owns storage, secrecy and compatibility details.

<details>
<summary>Implementation internals</summary>

[client/index.ts](src/client/index.ts) owns Remote descriptors, stream disposal, locale/style registration and sidebar/page slots. [controller.ts](src/client/controller.ts) coalesces refreshes and retains independent source failures. [AgentRecords.tsx](src/client/AgentRecords.tsx) feeds complete events to the official renderer; [RuntimeMonitor.tsx](src/client/RuntimeMonitor.tsx) separates retained history from incoming output. Server-side parsers and browser behavior tests enforce ownership; no presence-only invariant entry is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Host adapter](../dispatch/README.md)
- [Browser and installed verification](../../docs/verification.md)

<a id="model-experience"></a>
## Model Experience

Environment status distinguishes verified publication with pending temporary cleanup from failed verification. Cleanup and recovery details expand separately and retain their original timestamps. Safety failures continue to display the blocking diagnostic.

The training-environment card displays program-owned reuse stages, downloaded/reused bytes, added space, dated materials and cleanup eligibility. Stopped or offline experiments keep their original times and stop activity animations. Read errors retain the last copy and connection diagnostics. Preview and cleanup use Host-owned operations; selection changes and deletion ignore late replies. [Storage and cleanup](../../docs/managed-environments.md#space-and-cleanup) defines retention and offline behavior.

None: this package renders management state and submits explicit operations to the shared Host service. Remote Agents receive their logged requirements through the runtime.

The [completion-review view](../../docs/completion-review.md) exposes supplementation, retry, cancellation and a separate read-only trajectory. A verified receipt displays Revalidation passed while retaining the original failure and time; display status is shared by detail, list and filters.

The existing storage card exposes account-side volume categories, incomplete scan continuation, saved capacity status, read-only historical borrowing and material progress. Cleanup requires checked candidates and displays the retained-copy diagnostic. Polling reads saved state; explicit refresh triggers bounded inventory. [Storage behavior](../../docs/storage-governance.md) defines ownership and offline semantics.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The Web and Desktop compositions render the same page through the existing sidebar and main-panel slots.
- Overview shows at most three reported metrics: step, loss and throughput. Missing values remain absent; a training percentage requires valid reported `step/total_steps`.
- Retained browser output is bounded, and downloaded file generations must remain stable during transfer.

### Dev Note

None.
