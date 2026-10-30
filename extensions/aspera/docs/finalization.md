# Stage acceptance and finalization

English | [中文](finalization.zh.md)

## Summary

The existing DSH execution Agent selects approved requirements and evidence; Aspera performs command waiting, numerical checks and finalization. No additional orchestrator or Agent-loop modification is involved. Historical review reads existing files and cannot rerun training, evaluation or inference.

## Table of Contents

- [Approved stages](#approved-stages)
- [Command waiting](#command-waiting)
- [Bounded diagnostics](#bounded-diagnostics)
- [Finish decisions](#finish-decisions)
- [Historical review](#historical-review)
- [Records and compatibility](#records-and-compatibility)

## Approved stages

Plans may include structured `stages`. Transformers/ms-swift/PEFT plans require them before approval. Each stage binds a plan step, cumulative start/end, additional optimizer steps, metric scope and logging interval, scheduler mode/horizon/warmup, explicit sample-count basis and optional saved-result requirements. Choices within an allowed range are fixed before approval. `30 + 200 = 230` means 200 new steps ending at cumulative 230; it does not require 230 new metric records. Sparse logs are checked against their declared optimizer steps, with identical duplicates deduplicated and conflicting attempts rejected.

`register_experiment_stage` binds the approved requirement to a node, attempt, command and workspace-relative effective parameters, trainer states and result paths before launch. Parameters are independently read, hashed and checked again before starting the bound command. `verify_experiment_stage` verifies the original successful released command, checkpoint endpoints, effective parameters, metric coverage, scheduler and actual sample records. Continuing a scheduler uses its original warmup and horizon; restarting it requires the approved restart mode. A missing, truncated or unsupported source remains unverified. Shell exit 0 and Agent checklists cannot replace these checks.

A failed, released command can acquire a successor through `register_experiment_stage(previousAttemptId=...)`. The Agent chooses new attempt and command IDs plus separate trainer-state, metric and result paths. Before suggesting retry identifiers or paths, the program checks the original command outcome. The program retains the original requirement and resume/optimizer/scheduler/RNG sources, rechecks effective parameters and publishes at most one successor per predecessor. Initial registrations and failed verification records remain intact. Repeated requests return the committed attempt; concurrent or stale requests cannot replace it. Running, successful and uncertain commands are ineligible. `parameters` names an existing JSON file; remaining paths name files produced by that attempt, not inline JSON.

Structured evaluation and reload evidence must contain actual sample counts, finite loss and nonempty responses, and identify the registered training checkpoint. Continuation also requires independently hashed original optimizer, scheduler and RNG files, non-weights-only effective recovery, matching checkpoint steps, numerical learning-rate continuity and sample-order evidence. Binary checkpoint code is never executed. Declared artifact paths require nonempty owned files. The parser supports bounded Transformers trainer-state/JSON/JSONL evidence; unsupported formats require explicit diagnostics rather than inferred acceptance.

Structured sources retain their full-content reads when also listed in `requiredFiles`; artifact-only binary sources use metadata reads. Reload responses accept JSON arrays, result objects or JSONL. Every response must identify the registered checkpoint and attempt, directly or through its enclosing result object; conflicting per-response identities are rejected.

A registered trainer-state snapshot may be stored in logs. Results identify an approved native endpoint only when its complete state matches the snapshot's bytes, size and SHA-256; the log directory is not a checkpoint. Preserve the actual loaded adapter path and original results. Declared native output directories also determine intermediate saving checks before launch, independently of the snapshot location.

The registration tool describes accepted evidence fields before launch: metrics use `step`/`global_step` (or formatted `global_step/max_steps`), `loss` and `learning_rate`; evaluation uses `n`/`eval_samples`/`num_samples` and `eval_loss`; responses use `response`/`output`/`generated_text`. Results identify `adapter_path`/`checkpoint`/`model_checkpoint`, with `attempt_id`/`phase` matching `attemptLabel`. A mismatch identifies the file, expected label, observed value and separate registration attempt ID; oversized or invalid values are summarized without changing acceptance. Agents preserve original logs when preparing structured projections. Continuation registration reads the original `resumeState` JSON and checks its `global_step` against the approved start before publishing; a directory or unreadable/wrong-step source is rejected while the request remains correctable.

Approved evaluation, inference, base-control and sample checks require their corresponding filenames before registration. Future outputs need not exist yet, but missing references cannot become an immutable attempt. The Agent chooses the paths and corrects a rejected request before launching training.

Declared native `checkpoint-N/trainer_state.json` files are read in full and must record cumulative step N. Intermediate points in the registered output directory require an explicit integer step-saving interval that creates them and retention that preserves them through the final checkpoint. Continuation uses the original native `TrainerState.save_steps`, which can override a new CLI interval. Before initial training, registration also checks the cadence inherited by approved continuations. Unsupported callback declarations cannot replace this pre-launch check. The Agent chooses compatible parameters before training; the program neither edits checkpoints nor accepts renamed checkpoints from another step.

Original evaluation objects with `mode: "eval"` may use `evaluatedSamples` and `meanLossPerSupervisedToken`; an explicit nonfinite-loss flag is rejected. Generation objects may place original responses under `rows` and identify their checkpoint with `adapterPath` or `adapter`. These aliases do not relax counts, attempt identity or checkpoint checks, and do not require rewriting original evidence.

## Command waiting

Approved `requiredFiles` identify native recovery groups with `trainer_state.json` and model or adapter weights. The program registers those groups before the training command starts. After that command exits successfully and releases its processes, later ordinary commands and inference services mount the groups read-only. Seals recheck workspace ownership, actual mount identity, links, directories and file identities; missing or changed evidence blocks mutation while read-only diagnostics remain available. A registered checkpoint producer requires exclusive writable access on its node; multi-node command groups still start participants before waiting.

Formatting or missing records do not authorize retraining a successful command. The Agent preserves the checkpoint and raw logs, derives corrected structured evidence at the originally registered paths, runs evaluation/reload work and requests verification again. The program does not prepare replacement training results on the Agent's behalf.

Command results return `logs.stdout` and `logs.stderr` references for `read_experiment_file`. Pass `command_id`, `stream`, `offset` and the returned `generation`; do not combine a command stream with `path`. Diagnostic streams live outside the read-only workspace, so no `logs/<run_id>.log` is implied. `finalization.commandOutputBytes` defaults to 8192 bytes per page. Reads verify experiment, node, command and stream identity, retain incomplete UTF-8 bytes for the next page, and report missing output explicitly.

`run_experiment_command` waits for the original terminal exit and cleanup. It remains an exclusive DSH tool while waiting, so periodic lightweight status reads cause no new model request. Log archive and page refresh operate independently. An empty read or file EOF only means that no additional bytes are currently available.

Waits bind the command ID to its SHA-256 and purpose (`run` or `diagnostic`). Changed retry content is rejected before replacing the original journal. Authenticated node observations independently return the original digest and purpose; a rejected submission cannot inherit a previous command's successful exit. Missing identity remains unconfirmed. Read-only waits preserve the saved request identity, and command groups check each original member.

`run_experiment_command_group` submits all scoped members before waiting, allowing distributed rendezvous. An authenticated, identity-bound `not-started` receipt ends the rejected member immediately; started or uncertain peers are stopped and their exits checked. Other HTTP errors cannot establish that launch never occurred. A lost transport response is reconciled against the original members without a replacement launch. Identical operation IDs retain their original request. Persistent inference uses the dedicated service tools.

The `finalization` configuration defaults to 1-second polling, a 30-second read timeout, a 60-second consecutive connection-recovery budget and two unsupported-reason corrections. Existing explicit command deadlines still apply; these settings add no overall training deadline. Cancellation of observation does not prove remote exit. Unknown exits retain allocation protection. Waits hold no global server lock.

## Bounded diagnostics

`run_experiment_diagnostic` runs an Agent-selected command with a read-only workspace, no GPU grants, hidden credentials/control directories and bounded private temporary storage. Verified environment/material grants are read-only; invalid grants are omitted with an explicit diagnostic, retaining base system inspection. It does not require training-capacity admission or satisfy training-stage acceptance. Fixed-placement ownership checks and actual exit confirmation still apply. `finalization.diagnostics` defaults to `timeoutMs: 60000`, `temporaryBytes: 67108864`, `logBytes: 8388608`, `evidenceFileBytes: 1048576`, and `evidenceTotalBytes: 16777216`; bubblewrap must support `--size`. Time or log limits stop the owned process and retain the specific reason. Log limits include raw stdout/stderr and serialized observation records.

Preparation tests the diagnostic launch and measures its temporary-filesystem limit before handover. An unsupported `--size` option fails at `diagnostic-isolation` with the actual stderr; the preparation Agent must configure a compatible account-owned bubblewrap and reverify. The limit is never silently removed.

`write_experiment_evidence` publishes bounded UTF-8 text or JSON under `configs/`, `reports/` or `artifacts/diagnostics/`. The program validates directory descriptors, rejects symbolic links and different existing content, and resumes an identical operation without another write. Evidence quotas include pending writes. A write receipt establishes bytes and file identity, not the truth of Agent statements.

## Finish decisions

Completion inspection, finish requests and final settlement share per-node execution, step, environment, command and stage checks. A running finalizer is awaited. A completion request with missing records returns supplementation instructions while the Goal stays active. Blocked requests can retain an unverified Agent explanation without inventing training evidence. Missing stage registrations, execution entries and step reports do not independently prove a material, network or capacity failure. Final source identities and command facts are checked again before committing an outcome.

For `reason: "requirement"`, `requirement_evidence_json` selects `{serverId,kind,id}` references of kind `storage-plan`, `material-request` or `material-operation`. The program re-reads the original receipt and verifies experiment, server, approved plan revision and Session associations. A verified decision quotes only those observations: a failed node metadata request does not establish that Host retrieval or historical reuse is impossible. Without matching evidence, the blocked result has `verified: false`. Resource release still depends on actual process and cleanup receipts.

Budget reasons distinguish actual input-limit errors, single-output `max-tokens`, configured program budgets, compaction failures and Agent reports. Only matching observed Session events establish a budget failure. Token totals and a model's declared window alone cannot establish exhaustion. Unsupported budget and requirement reports receive `finalization.reasonCorrections` opportunities, default two, to inspect existing diagnostics and choose a permitted recovery; exhaustion records incomplete Agent work with original evidence and uncertain resources preserved. Single-output truncation first resumes the same Goal and Session with a logged smaller-response instruction; `finalization.outputTokenCorrections` defaults to two consecutive recoveries and a tool result resets the count. No command, installation or training is automatically replayed.

## Historical review

[Completion review](completion-review.md) retains original outcomes. Released blocked experiments additionally require unambiguous original structured or explicitly recognized legacy continuation requirements, an original blocked finish/Goal transition, a final checkpoint at the approved endpoint, a nonempty saved adapter and confirmed original command release on every node. Eligibility does not establish success.

The restricted review Agent uses the original model in a separate Session. It can register historical stages, request numerical checks and submit step supplements referencing actual sources with a matching assessment revision. Original step reports are not changed. Not-applicable reports require a declared original conditional step whose trigger the program has ruled out. Fresh file, environment, result and release checks must all pass before a separate dated passing receipt is published. Unreachable original files remain pending even when local trajectory is readable.

## Records and compatibility

Environment failures can use `environment-operation` requirement evidence. The node checks the original plan/Session association, failed receipt, process exit and admission release. The observation describes that operation; a rejected historical candidate does not establish that every repair, material source or capacity plan is unusable. Missing completion records remain a separate condition.

Persistence acknowledgement: `command-admissions-0.1.3` and `diagnostic-evidence-0.1.3` use independent version-1, format-0.1.3 records. Command results add optional `purpose: "diagnostic"`. Wait records add optional rejection, original submit error, separate observation error and a fixed reconnect deadline; repeated calls and restart retain that deadline. A matching experiment/node/command/content rejection returns immediately without waiting for a nonexistent process. Missing identity or transport errors retain uncertain exit and allocation protection. Existing waits remain readable.

Persistence acknowledgement: [stage definitions](../packages/experiments/src/stage-requirements.ts) add optional structured stages and conditional steps to plans; existing plans remain readable. [Finalization schemas](../packages/experiments/src/finalization.ts) define independent version-1 registrations/checks in `stage-acceptance-v1`, command waits in `command-waits-v1`, immutable group requests in `command-groups-v1`, and `finish-decision.v1.json` in the private original run. Review additions use `<experimentId>.assessment-v1.json` beside existing local review receipts and `completion-assessments-v1/<operationId>.json` remotely. Original results, execution entries and step files are retained.

Persistence acknowledgement: `StageRegistrationInput` adds optional `previousAttemptId`; stored version-1 registrations keep their fields. Independent version-1 `StageAttemptTransition` records live in `stage-attempts-v1/<serverId>_<stageId>/<previousAttemptId>.json`. Each immutable predecessor slot retains the failed released command, any failed verification and its successor. Existing experiment-owned archive and cleanup include these records. Protocol 4, fleet 6 and Session formats remain unchanged.

Requirement associations use independent `version: 1`, `formatVersion: "0.1.1"` operation records; finish decisions add optional `requirementEvidence`. Older decisions remain readable and are not rewritten. The `targeted-materials-0.1.1` capability supplies the evidence endpoint; old fixed releases do not receive these operations through resource updates.

`experimentCompletionAssessment(id)` reads the separate historical assessment. `experimentFinalizationStatus(id)` reads lightweight private journals through authenticated protocol 4 or the owned read-only SSH fallback, preserving remote errors and original observation times in `$DSH_HOME/aspera-run-records/<experimentId>/finalization.v1.json`. Deletion and shutdown abort and join readers before deleting their copies; late replies cannot recreate records. UI animations stop for terminal experiments and offline observations. Fleet domain 6, submission protocol 4 and Session formats remain unchanged. All typed Remote consumers update together.

New releases declare `asperaFinalizationVersion: 2` and require `experiment-finalization-v2` during preparation and controller reuse. Old experiments retain their fixed release; Host historical review does not upgrade it. Experiment-owned cleanup includes the new private journals. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/aspera-finalization/guide.md).

`asperaStageEvidenceVersion: 4` requires `stage-evidence-reading-v1`, `stage-evidence-reading-v2`, `stage-checkpoint-evidence-v3` and `stage-checkpoint-evidence-v4` before controller reuse. Version-1 evidence fields and historical manifests declaring 1–3 remain readable. Saving-policy and native-state checks do not rewrite registrations, sources or results. Published services use [program-owned public verification](public-inference.md).

`asperaEnvironmentTools.commandOutputVersion: 1` requires `command-output-v1` before controller reuse. `ProcessLogRequest.limit` is optional transport pagination; command output references remain ordinary logged tool results. The new `finalization.commandOutputBytes` setting resolves at profile load. Existing Session, submission, command-wait and stream-file formats are unchanged.

Persistence acknowledgement: format `0.1.4` command waits add optional `requestHash` and `purpose`; the parser retains older waits without inventing missing identities. New authenticated status replies add the original command digest. `asperaEnvironmentTools.commandIdentityVersion: 1` requires `command-wait-identity-v1` before controller reuse. Submission protocol 4, fleet 6 and Session formats remain unchanged.
