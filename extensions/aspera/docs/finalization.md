# Stage acceptance and finalization

English | [中文](finalization.zh.md)

## Summary

The existing DSH execution Agent selects approved requirements and evidence; Aspera performs command waiting, numerical checks and finalization. No additional orchestrator or Agent-loop modification is involved. Historical review reads existing files and cannot rerun training, evaluation or inference.

## Table of Contents

- [Approved stages](#approved-stages)
- [Command waiting](#command-waiting)
- [Finish decisions](#finish-decisions)
- [Historical review](#historical-review)
- [Records and compatibility](#records-and-compatibility)

## Approved stages

Plans may include structured `stages`. Transformers/ms-swift/PEFT plans require them before approval. Each stage binds a plan step, cumulative start/end, additional optimizer steps, metric scope and logging interval, scheduler mode/horizon/warmup, explicit sample-count basis and optional saved-result requirements. Choices within an allowed range are fixed before approval. `30 + 200 = 230` means 200 new steps ending at cumulative 230; it does not require 230 new metric records. Sparse logs are checked against their declared optimizer steps, with identical duplicates deduplicated and conflicting attempts rejected.

`register_experiment_stage` binds the approved requirement to a node, attempt, command and workspace-relative effective parameters, trainer states and result paths before launch. Parameters are independently read, hashed and checked again before starting the bound command. `verify_experiment_stage` verifies the original successful released command, checkpoint endpoints, effective parameters, metric coverage, scheduler and actual sample records. Continuing a scheduler uses its original warmup and horizon; restarting it requires the approved restart mode. A missing, truncated or unsupported source remains unverified. Shell exit 0 and Agent checklists cannot replace these checks.

Structured evaluation and reload evidence must contain actual sample counts, finite loss and nonempty responses, and identify the registered training checkpoint. Continuation also requires independently hashed original optimizer, scheduler and RNG files, non-weights-only effective recovery, matching checkpoint steps, numerical learning-rate continuity and sample-order evidence. Binary checkpoint code is never executed. Declared artifact paths require nonempty owned files. The parser supports bounded Transformers trainer-state/JSON/JSONL evidence; unsupported formats require explicit diagnostics rather than inferred acceptance.

## Command waiting

`run_experiment_command` waits for the original terminal exit and cleanup. It remains an exclusive DSH tool while waiting, so periodic lightweight status reads cause no new model request. Log archive and page refresh operate independently. An empty read or file EOF only means that no additional bytes are currently available.

`run_experiment_command_group` submits all scoped members before waiting, allowing distributed rendezvous. An authenticated launch rejection stops only matching started members and verifies their exits. A lost transport response is reconciled against the original members without a replacement launch. Identical operation IDs retain their original request. Persistent inference uses the dedicated service tools.

The `finalization` configuration defaults to 1-second polling, a 30-second read timeout, a 60-second consecutive connection-recovery budget and two unsupported-reason corrections. Existing explicit command deadlines still apply; these settings add no overall training deadline. Cancellation of observation does not prove remote exit. Unknown exits retain allocation protection. Waits hold no global server lock.

## Finish decisions

Completion inspection, finish requests and final settlement share per-node execution, step, environment, command and stage checks. A running finalizer is awaited. Missing records return specific supplementation instructions while the Goal stays active. Actual unmet requirements can finish blocked without pretending every step completed. Final source identities and command facts are checked again before committing an outcome.

Budget reasons distinguish actual input-limit errors, single-output `max-tokens`, configured program budgets, compaction failures and Agent reports. Only matching observed Session events establish a budget failure. Token totals and a model's declared window alone cannot establish exhaustion. Unsupported claims receive bounded corrections; unresolved finalization is recorded as incomplete Agent work, with original evidence and uncertain resources preserved.

## Historical review

[Completion review](completion-review.md) retains original outcomes. Released blocked experiments additionally require unambiguous original structured or explicitly recognized legacy continuation requirements, an original blocked finish/Goal transition, a final checkpoint at the approved endpoint, a nonempty saved adapter and confirmed original command release on every node. Eligibility does not establish success.

The restricted review Agent uses the original model in a separate Session. It can register historical stages, request numerical checks and submit step supplements referencing actual sources with a matching assessment revision. Original step reports are not changed. Not-applicable reports require a declared original conditional step whose trigger the program has ruled out. Fresh file, environment, result and release checks must all pass before a separate dated passing receipt is published. Unreachable original files remain pending even when local trajectory is readable.

## Records and compatibility

Persistence acknowledgement: [stage definitions](../packages/experiments/src/stage-requirements.ts) add optional structured stages and conditional steps to plans; existing plans remain readable. [Finalization schemas](../packages/experiments/src/finalization.ts) define independent version-1 registrations/checks in `stage-acceptance-v1`, command waits in `command-waits-v1`, immutable group requests in `command-groups-v1`, and `finish-decision.v1.json` in the private original run. Review additions use `<experimentId>.assessment-v1.json` beside existing local review receipts and `completion-assessments-v1/<operationId>.json` remotely. Original results, execution entries and step files are retained.

`experimentCompletionAssessment(id)` reads the separate historical assessment. `experimentFinalizationStatus(id)` reads lightweight private journals through authenticated protocol 4 or the owned read-only SSH fallback, preserving remote errors and original observation times in `$DSH_HOME/aspera-run-records/<experimentId>/finalization.v1.json`. Deletion and shutdown abort and join readers before deleting their copies; late replies cannot recreate records. UI animations stop for terminal experiments and offline observations. Fleet domain 6, submission protocol 4 and Session formats remain unchanged. All typed Remote consumers update together.

New releases declare `asperaFinalizationVersion: 2` and require `experiment-finalization-v2` during preparation and controller reuse. Old experiments retain their fixed release; Host historical review does not upgrade it. Experiment-owned cleanup includes the new private journals. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-finalization/guide.md).
