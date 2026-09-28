---
description: "Web server management and independent experiment list, details, logs and artifact downloads."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-experiments

English | [中文](README.zh.md)

## Summary

This Web plugin adds Experiments to the sidebar. Users manage password-authenticated servers, submit independent Goals to selected nodes, and inspect each experiment’s receipt, queue state, logs, errors and output files. The Host task service owns persistence and execution.

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

Open Experiments, add servers, then choose New experiment. Multiple selections mean joint execution. A submitted task can be cancelled or copied into a new draft. File contents download on demand; selecting an experiment fetches metadata and bounded log tails.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The controller binds generated Remote methods to a snapshot store. Visibility gates polling; durable-change events and connection resets trigger refresh. Byte cursors and UTF-8 decoders belong to an experiment and source. Disposal ignores late replies. The page receives effects through its inject face and product copy through typed locale dictionaries.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [dispatch service](../../workflow/experiment-dispatch/README.md) for credentials and handover semantics.

<a id="model-experience"></a>
## Model Experience

### User-authored goals

#### What the model sees

The browser sends user-authored `Goal` values to the dispatch service. It adds no model instructions or tool definitions.

#### Token effect

None from this presentation package.

#### KV Cache effect

Rendering adds no model request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Local browser attachments must be selected again when copying a task. Poll and retained-text limits are configurable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Implementation details — click to expand</summary>

No runtime invariant companion is published: the controller renders Host records and owns no independent execution state.

</details>
