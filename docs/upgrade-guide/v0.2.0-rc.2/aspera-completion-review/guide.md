---
kind: upgrade-guide
description: "Aspera completion requires per-node execution evidence and adds separate historical revalidation without changing original outcomes."
---

# Complete and revalidate Aspera experiments

English | [中文](guide.zh.md)

## Change

Completion tools and final settlement now share per-node checks. An execution Agent that omits `record_experiment_execution` receives missing fields while its Goal remains active. It must record existing scripts, environments, parameters and results rather than repeating settled work.

Released failures caused specifically by missing completion evidence expose Supplement and verify. A restricted standard DSH Agent uses the original execution model in a separate Session; it cannot train, install or start services. A program-verified receipt displays Revalidation passed while preserving the original failure and timestamp. Existing `pyenv` metadata can be registered read-only for this retrospective assessment.

Supplementary JSON/JSONL evidence and embedded events retain valid structure during credential removal. Recording diagnostics list mismatches together. Trajectory pages use the original local DSH Session and locate its latest events when count metadata is absent; damaged companion files do not hide intact history.

Historical stage file references can be corrected before successful verification. The Agent reads `assessment.revision` and supplies it as the tool's `expected_revision`; command, attempt and approved requirements cannot change. Corrected references require fresh verification. Unused paths are omitted; passed bindings remain fixed. Retained invalid registrations need no manual ledger edit, retraining or new review identity.

Review tools distinguish current acceptance from retained historical failure. An associated exact-checkpoint serving proof may satisfy the original public-serving step after independent verification, without changing the old blocked report. Unresolved step indices appear first; completed reports need no repetition. Refresh the application and resume the same review Session to use these explanations; no original training or inference needs repeating. Blocked retries resume the same Goal with its remaining round budget.

## Migration

1. Rebuild generated Remote clients for `reviewExperimentCompletion`, `experimentCompletionReviewStatus`, `cancelExperimentCompletionReview` and `experimentCompletionReviewTrace`.
2. Retain original submissions, fixed releases, Sessions, environments, artifacts and logs. New releases declare `asperaCompletionVersion: 1` and `completion-evidence-v1`; preparation checks controller capability. Historical reviews do not replace old releases.
3. Open an eligible failed experiment, request supplementation and inspect its separate trajectory. Reconnect every original node to confirm files, command release and source hashes. Missing evidence remains blocked; cancelling affects only the review.
4. Refresh the updated application to recover an existing review trajectory from its retained Session; keep any damaged companion file for diagnosis. Do not restart an already passed review. Confirm the dated Revalidation passed receipt and retained original failure. Independent version-1 review/source/environment records are documented in [completion verification](../../../../extensions/aspera/docs/completion-review.md). Submission protocol 4, fleet domain 6, existing execution entries and Session formats remain unchanged.
