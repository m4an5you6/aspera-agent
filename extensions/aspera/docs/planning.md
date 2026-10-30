---
kind: reference
description: "Version-specific planning with bounded documentation reads and persistent, locally editable drafts."
---

# Planning tools

English | [中文](planning.zh.md)

## Summary

The Agent chooses documentation, investigation order and plan contents. Aspera persists documents and drafts, validates fields and commits a complete plan before approval. These tools belong to fixed releases advertising `planning-drafts-0.1.0` and `documentation-pages-0.1.0`; an existing experiment retains its original release and tools.

## Table of Contents

- [Documentation](#documentation)
- [Drafts and submission](#drafts-and-submission)
- [Persistence and compatibility](#persistence-and-compatibility)

<a id="documentation"></a>
## Documentation

`read_framework_documentation` accepts an allowlisted HTTPS `url`. `documentationReadTimeoutMs` defaults to 30,000 ms and bounds connection, headers and the entire response body together; it does not use the installation or command deadline. `documentationPageBytes` defaults to 8,192 UTF-8 content bytes. Both settings are available in the `aspera-dispatch` profile configuration and worker configuration. The existing `documentationBytes` download limit and host list still apply. New deployments retain their limits in the private experiment snapshot even when reusing a resident coordinator; the document store captures those limits at its first read. Changing configuration does not reset that Session's saved limits.

Successful responses return original `text`, `snapshotId`, `sha256`, `readAt`, `cached` and an optional `next` request. Follow `next` to continue the same immutable snapshot; `query` locates literal text. Cursors use UTF-16 character offsets, while page limits count UTF-8 bytes. A missing search match returns `queryFound: false`. Different URLs retain separate source identities. The tool neither summarizes documents nor calls another model.

`read_experiment_input` returns submitted UTF-8 text by default. Pages use the smaller of `chunkBytes` and `documentationPageBytes`, with file-byte `offset`, `nextOffset`, `generation`, `reset` and `eof`. Continue from the returned byte offset; incomplete multibyte characters remain for the next page. Large JSON pages are text fragments that must be combined before parsing. A changed generation resets the read to byte zero. Explicit `encoding: base64` retains binary access. The tool checks immutable submitted names and needs no shell or decoding file.

`refresh: true` requests a new snapshot while preserving previous snapshots. `retry: true` explicitly starts another attempt after failure. Ordinary reads reuse completed snapshots or the original failure receipt. Concurrent readers share an active request without extending its deadline. Failures return `state: failed`, `complete: false`, URL, request identity, elapsed time, received bytes and a timeout, cancellation, HTTP, size, network or interruption category. Partial bodies remain private incomplete records and never become complete document snapshots. Redirects, credentials in URLs and hosts outside the configured list are rejected.

<a id="drafts-and-submission"></a>
## Drafts and submission

`workload` distinguishes `training` from `inference`; framework names alone do not identify new training. Pure inference plans declare `workload: "inference"` and omit training stages. Retained checkpoint proofs belong to the inference checkpoint tools, never placeholder stages or scheduler values. Missing `workload` retains legacy training checks. Declared training requirements remain mandatory and cannot be removed by choosing inference.

`get_experiment_plan_schema` returns the authoritative input schema and a valid example. Select `steps` for saved text entries, `stepEdits` for draft inputs, or sections such as `samples`, `scheduler` and `results`; follow its continuation when needed. `samples.unit` accepts `example` or `microbatch`, `samples.meaning` accepts `consumed` or `fetched`, explanatory text belongs in `basis`, and `results.baseControl` is boolean. Tool field declarations derive from the same Zod definitions as final acceptance; cross-field arithmetic and references are checked on the server.

`update_experiment_plan_draft` accepts `requestId`, `expectedRevision` and optional sections. Use revision zero for a new draft. `steps` accepts either text entries addressed from step one or patches of `{step,text}` using original one-based numbers; a request cannot mix the formats. Shorter text lists retain trailing steps. Stages merge by `stageId`, including partial `samples`, `scheduler` and `results`. Omitted fields remain unchanged. `removeSteps`, `removeStages`, `removeFields` and `removeStageFields` perform explicit removal without renumbering references. A draft may be incomplete. The tool returns its saved revision and actionable issues instead of repeating its complete text.

`read_experiment_plan_draft` returns a summary by default or a selected section and continuation. Section `issues` exposes the complete validation list when its summary is bounded. Section pages are explicit JSON text fragments and bind to one draft revision. A changed revision returns a conflict. `validate_experiment_plan_draft` checks the latest saved contents without approving or running them. Repeat a request identity only for identical edits; stale expected revisions return the current revision instead of overwriting it.

`save_experiment_plan` with `status: completed` accepts exactly one of structured `plan`, compatibility `plan_json`, or `draft_revision`. A parseable rejected complete submission remains saved as a draft. Repair only the reported fields and submit its new revision; invalid JSON returns a syntax error without replacing the draft. Final submission checks the whole plan, stage arithmetic, scheduler horizon, step references and unique identities, atomically writes the existing plan receipt, then completes the planning Goal. The saved draft is frozen. Automatic and semi-automatic approval remain separate existing operations; draft editing cannot change an approved plan. `status: blocked` retains the existing unmet-requirement outcome.

An optional declared `aspera-plan-requirements.json` fixes user-confirmed requirements before planning. Its version-1 JSON contains `stepCount`, complete `stages` and `storagePolicy`, limited to 64 KiB. The program verifies the submitted SHA-256 and regular-file identity, then compares stage IDs/references, step targets, scheduler, sample constraints, evidence-file sets, results and retention. Omitted required `samples` forbids invented counts. Narrative titles and estimation explanations remain model-authored. Read `read_experiment_plan_draft(section: "requirements")`, repair reported fields and resubmit the same draft; model edits cannot change requirements. Approval and execution independently recheck them. Undeclared inputs retain existing behavior.

Persistence acknowledgement: `planning-v1/requirements.v1.json` is an independent version-1 source capture under the original planning owner. Reopening rejects changed or omitted requirements. Manifest `asperaPlanningTools.requirementsVersion: 1` requires `planning-requirements-v1`; incompatible controllers require controlled maintenance. Original drafts, plans, submissions and Session formats remain unchanged.

<a id="persistence-and-compatibility"></a>
## Persistence and compatibility

Private `planning-v1` records use `version: 1` and `formatVersion: "0.1.0"`. They bind drafts, immutable revision history and idempotent request receipts to experiment, planning Session and fixed release. `documentation-v1` stores independent per-Session ownership, captured limits, attempts, source indexes and immutable snapshots. Reopening reads existing records; it never resumes a model or an experiment automatically. Deadlines are absolute saved times. Interrupted requests require an explicit new retry. Draft writes and final commit share the maintained atomic-file writer lock, which recovers only after the original writer has exited.

Type acknowledgement: `planDraftEditSchema.steps` also accepts text entries. Resolved drafts and final plans retain string arrays; existing numbered patches remain valid. Request identities still distinguish the original submitted representation. No durable record, approved requirement, protocol or Session format changes.

Persistence-type acknowledgement: the optional `plan.workload` field is saved by the existing plan and draft writers; absent historical values remain absent. Existing approved plans are not rewritten. `asperaPlanningTools.inferenceVersion: 1` requires `inference-plan-v1` before controller reuse. Fleet generation 6, control protocol 4 and Session event formats retain their definitions. Model-visible content and changes use ordinary logged DSH tool calls. Old releases do not gain these tools through a desktop resource update; use a new or copied experiment with the new release after its normal capability checks. Existing experiments, including their later phases, retain their original materials, Session and release.

## Dev Note

None.
