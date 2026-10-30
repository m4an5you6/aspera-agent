---
kind: upgrade-guide
description: "Aspera documentation tool results become paged records, and plans support typed inputs and persistent draft repair."
---

# Aspera planning tools

English | [中文](guide.zh.md)

## Change

Plans accept optional `workload: training|inference`. Inference forbids training stages; omission retains training checks. Draft tools accept, read and remove this field. `asperaPlanningTools.inferenceVersion: 1` requires `inference-plan-v1`; existing approved plans remain unchanged. See [planning compatibility](../../../../extensions/aspera/docs/planning.md#persistence-and-compatibility).

`asperaPlanningTools.requirementsVersion: 1` requires `planning-requirements-v1`. The optional declared input name `aspera-plan-requirements.json` is reserved for version-1 user requirements: `stepCount`, `stages` and `storagePolicy`, maximum 64 KiB. SHA-256 and file identity authenticate it. Draft submission, approval and execution reject changed targets, scheduler, evidence or retention; Agents repair drafts through existing tools. Read the `requirements` draft section. Independent `planning-v1/requirements.v1.json` rejects omitted or changed sources on reopen. Existing input declarations, plans, protocol and Sessions keep their formats; old fixed releases do not implement this input's new meaning.

New fixed releases advertise `planning-drafts-0.1.0` and `documentation-pages-0.1.0`. `read_framework_documentation` returns a JSON record with bounded original text, snapshot identity, continuation and explicit failure state instead of a complete raw page. Its default total network deadline is 30 seconds. Saved failed requests require explicit retry; existing command and installation deadlines are unaffected.

`read_experiment_input` now returns paged UTF-8 `text` by default, bounded by the smaller of `chunkBytes` and `documentationPageBytes`. Follow its file-byte `nextOffset` and `generation`; restart assembly on `reset`. Combine JSON fragments before parsing. Binary callers must request `encoding: base64` to obtain `data`. Original input bytes, digests and submission formats remain unchanged; older fixed releases retain base64 defaults.

`save_experiment_plan` accepts structured `plan`, compatibility `plan_json`, or `draft_revision`. Parseable rejected submissions remain repairable drafts. New schema, draft read/edit and validation tools expose exact types and partial repairs. Final approval requirements remain unchanged. Private planning records use independent version 1, business format `0.1.0`; fleet, control protocol and Session formats are unchanged.

Draft `steps` also accepts the text entries exposed by the final-plan schema, addressed from step one. Numbered `{step,text}` patches remain supported; do not mix formats. Shorter lists retain trailing steps and removal stays explicit. `get_experiment_plan_schema(section: "stepEdits")` exposes draft inputs. Persisted steps, approval rules and request-identity checks remain unchanged; existing fixed releases retain their original input definitions.

## Migration

1. Update Host and runtime resources together using the existing resource updater, retaining the original EXE and resource backup. Configure optional `documentationReadTimeoutMs` and `documentationPageBytes` in `aspera-dispatch`; defaults are 30,000 and 8,192.
2. Update consumers of documentation results to inspect `state`, use `text` and follow `next`; use `retry: true` or `refresh: true` only for an intentional new attempt. Do not treat incomplete reads as full documents.
3. Use a new or copied experiment with the new fixed release. Existing experiments retain their original release, tools, parameters and later phases; this update never reruns them or upgrades their remote controller automatically.
4. Confirm nested plan enums and boolean fields with `get_experiment_plan_schema`. Repair rejected fields with `update_experiment_plan_draft`, then commit its revision. See [planning tools](../../../../extensions/aspera/docs/planning.md) for persisted identity, concurrency and paging rules.
