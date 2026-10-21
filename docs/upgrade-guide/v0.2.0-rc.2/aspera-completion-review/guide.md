---
kind: upgrade-guide
description: "Aspera completion requires per-node execution evidence and adds separate historical revalidation without changing original outcomes."
---

# Complete and revalidate Aspera experiments

English | [中文](guide.zh.md)

## Change

Completion tools and final settlement now share per-node checks. An execution Agent that omits `record_experiment_execution` receives missing fields while its Goal remains active. It must record existing scripts, environments, parameters and results rather than repeating settled work.

Released failures caused specifically by missing completion evidence expose Supplement and verify. A restricted standard DSH Agent uses the original execution model in a separate Session; it cannot train, install or start services. A program-verified receipt displays Revalidation passed while preserving the original failure and timestamp. Existing `pyenv` metadata can be registered read-only for this retrospective assessment.

Supplementary JSON/JSONL evidence and embedded events retain valid structure when credentials are removed. Recording diagnostics list all mismatches together. Review trajectory reads are asynchronous and use the original local DSH Session, so a damaged redacted companion file does not hide intact history or require another review.

## Migration

1. Rebuild generated Remote clients for `reviewExperimentCompletion`, `experimentCompletionReviewStatus`, `cancelExperimentCompletionReview` and `experimentCompletionReviewTrace`.
2. Retain original submissions, fixed releases, Sessions, environments, artifacts and logs. New releases declare `asperaCompletionVersion: 1` and `completion-evidence-v1`; preparation checks controller capability. Historical reviews do not replace old releases.
3. Open an eligible failed experiment, request supplementation and inspect its separate trajectory. Reconnect every original node to confirm files, command release and source hashes. Missing evidence remains blocked; cancelling affects only the review.
4. Refresh the updated application to recover an existing review trajectory from its retained Session; keep any damaged companion file for diagnosis. Do not restart an already passed review. Confirm the dated Revalidation passed receipt and retained original failure. Independent version-1 review/source/environment records are documented in [completion verification](../../../../extensions/aspera/docs/completion-review.md). Submission protocol 4, fleet domain 6, existing execution entries and Session formats remain unchanged.
