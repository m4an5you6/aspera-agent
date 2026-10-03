---
description: "Use the independent Aspera Web sidebar for server configuration, experiment approval, incremental logs, outputs and inference services."
kind: "package-reference"
---

# @aspera/console

English | [中文](README.zh.md)

## Summary

Manage remote experiments in a dedicated page while keeping ordinary conversations available. Add password servers, submit consecutive Goals, confirm plans and inspect progress, receipts, messages, node logs and outputs. Access and stop private inference services, with the queued experiments they block shown in context. The Host owns task state; browser unload only ends page effects.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The dispatch bundle mounts this plugin in the independent [management profile](../../README.md#start-the-management-page). Its manifest projects `./client` into the Web client; it has separate Host/client compiler programs and published client declarations. The pinned sidebar and settings-command patches are owned by the [Aspera adapter](../../docs/architecture.md#components).

[Config](src/config.ts) selects page polling, retained text length and the initial control port for new server forms. Text retention limits apply to displayed tails, not remote files. [AsperaRemote](../dispatch/src/index.ts) supplies operation defaults and validated state; typed English/Chinese dictionaries own all product labels.

The controller keeps experiment/node/source decoders and byte cursors when selection changes or the connection resets. Missing/rotated logs are indicated explicitly. Copying a submitted experiment creates a new request; approval and cancellation use the displayed experiment identity. Inference requests use managed connections and bounded responses; model outputs remain files until downloaded.

The page reuses DSH typography, light/dark tokens, Button, Input, Checkbox, Tag, Modal and portaled Menu. An optional external-inference section records the platform URL and mapped internal port; service cards separate local health and external checks. Calling keys appear only after an explicit operator action. Server dialogs keep five SSH fields visible and put automatic/manual storage, optional internal address and control port in Advanced settings. Expanded sections scroll within the window, keeping the save action reachable. Last inventory includes free space, write access and unknown durability. Experiment details show preparation stages, saved directories, network addresses and reasons alongside plan confirmation. New forms and copied experiments preserve their execution mode.

The controller refreshes pending state even when Aspera is not open. Sidebar, list and desktop receive the same distinct experiment count, including plan confirmations and open questions; reading a card does not acknowledge it. Heavy log/file reads remain limited to the selected visible experiment. Desktop-only count delivery uses its validated private bridge.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The official sidebar hosts one collapsible Aspera group without a disclosure arrow. Its gear opens Aspera model settings; the configuration entry invokes the official DSH settings command. Three-phase selection reuses the configured provider accounts. Agent records default to a trajectory with independently scrolling events/details; runtime monitoring separates node/process streams and supports bounded follow, pause and search. Reminder dismissal persists by experiment, decision kind and revision; new decisions reappear without changing the shared attention count.

<details>
<summary>Implementation internals</summary>

[client/index.ts](src/client/index.ts) owns Remote descriptors, stream disposal, locale/style registration and sidebar/page slots. [controller.ts](src/client/controller.ts) coalesces refreshes, rejects stale replies and bounds displayed text. [ExperimentsPage.tsx](src/client/ExperimentsPage.tsx) receives actions/state through injected props; [conversation.ts](src/client/conversation.ts) isolates complete Session lines by source ID/sequence. Server-side parsers and browser behavior tests enforce ownership; no presence-only invariant entry is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace start](../../README.md)
- [Host adapter](../dispatch/README.md)
- [Browser and installed verification](../../docs/verification.md)

<a id="model-experience"></a>
## Model Experience

None: this package renders management state and submits explicit operations to the shared Host service. Remote Agents receive their logged requirements through the runtime.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The Web and Desktop compositions render the same page through the existing sidebar and main-panel slots.
- Progress uses measured metrics when available and otherwise shows phase/raw logs; no training percentage is inferred.
- Retained browser output is bounded, and downloaded file generations must remain stable during transfer.

### Dev Note

None.
