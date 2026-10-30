# Completion evidence and retrospective verification

English | [中文](completion-review.zh.md)

## Summary

Aspera checks completion before ending an execution Goal and again before settling the worker result. Released experiments that failed specifically because completion evidence was missing can request a separate, read-only evidence review. Training, environments, original results, logs, Sessions and fixed releases remain retained.

## Table of Contents

- [Normal completion](#normal-completion)
- [Review an existing result](#review-an-existing-result)
- [Verification and ownership](#verification-and-ownership)
- [Recover acceptance on the original experiment](#recover-acceptance-on-the-original-experiment)
- [Persistence and API](#persistence-and-api)
- [Validation](#validation)

## Normal completion

`inspect_experiment_completion`, `finish_experiment(completed)` and final settlement use the same [completion checks](../packages/runtime/src/completion-check.ts). They require matching completed reports for the approved plan and execution Session, execution entries on every selected node, effective parameters, verified environments, settled successful commands or registered healthy services, readable scripts and declared artifacts. Optional source references are independently hashed and rechecked. Entry write failures retain an uncommitted marker and block completion.

Missing evidence returns the affected node, failed check and recording instruction while the original Goal remains active. The execution Agent records actual framework, version, script, environment, parameters, artifacts and evaluation with `record_experiment_execution`, then requests completion again. A Markdown report, `plan_json`, finish detail or completed step report does not save an execution entry. Settled commands must not be repeated to repair missing records.

## Review an existing result

Open an eligible experiment and select **Supplement and verify**. Evidence-omission failures require the approved plan, original completed-Goal/finish-call evidence, confirmed command exits and release of all original resources. Released blocked continuations additionally require independently confirmed training endpoints and original blocked finish evidence under the [stage review rules](finalization.md#historical-review). Other training failures, cancellation and interruption are ineligible. An error string alone is insufficient. All original nodes must remain verifiable.

The Host starts a standard DSH Agent with the original execution model in a separate review Session. Its tools read original requirements, plan reports, command results, files and trajectory, inspect completion, record supplementary execution evidence and request verification. It has no command, installation, training, inference, service or deletion tools. Cancelling stops only this Agent and its reads; hiding the window or changing pages does not stop it. Restarting Aspera resumes the saved operation and Session. Blocked retries resume the existing review Goal through DSH's revision-checked API, preserving identity and round budget; the original training Goal stays stopped. Repeated requests share the operation.

The overview and list display **Revalidation passed** only after the program commits a valid review receipt. The original failed or blocked result and timestamp remain available. Blocked reviews show missing evidence and retry; their animations stop. Review Agent records have their own read-only trajectory selector and are available locally. Review attachments that are not cached are unavailable offline.

## Verification and ownership

Review identity binds the experiment, original submission digest, plan revision, execution Session, result revision and selected nodes. Each source must be an original workspace file with independently observed generation, size and SHA-256. Parameters and evaluation values must match saved structured evidence; scripts and artifacts require their actual paths. Nonempty result evidence is required. Reports or model claims cannot replace source reads. Verification repeats source, environment, original outcome, node allocation and command-release checks before committing a separate receipt. Changed files and conflicting identities block publication.

The Agent can correct unverified historical stage file references through `register_experiment_stage`, supplying the current `assessment.revision` as `expected_revision`. Original attempt, command and approved requirements stay fixed. Corrections invalidate prior checks and require fresh verification; passed bindings cannot change. Unused file fields are omitted, never `false` or empty paths. Original failed checks remain in the supplementary Session.

An existing `pyenv` can be registered as a historical environment by reading its interpreter identity, `pyvenv.cfg` and dependency metadata. Framework versions must match. This operation does not execute experiment code, import packages, install, modify or copy dependencies. The record is usable only for the original experiment review; it does not enter the shared package store or replace new experiments' managed environment requirements.

Protocol-4 authenticated history reads remain available. An offline or older controller uses the program-owned [SSH evidence reader](../packages/dispatch/src/completion-reader.ts), which verifies run ownership, original allocation release and fixed release identity. Reads reject traversal, symlinks and nested mounts. The reader neither replaces releases nor edits original task ledgers. An unreachable node or missing original file remains unverified even when local history is readable. Review never reruns training, evaluation or inference to manufacture evidence.

Credential removal preserves parsed JSON and complete JSONL records, including embedded tool-result documents; null credential fields remain null. Parameters retain their exact saved keys and values. A recording rejection lists all parameter, evaluation and artifact mismatches together with available source values and keys. Invalid or incomplete structured evidence remains unverified. Each source path is read once within a recording or final recheck even when it supports several evidence purposes; final verification still reads fresh source identities.

## Recover acceptance on the original experiment

`recoverExperimentAcceptance(id, recoveryId?)` associates an existing inference-only execution with a released trained result. The program matches selected nodes, the approved native endpoint, successful producer exit, checkpoint file identities and hashes, and the original public model URL. The original remains the top-level task. When earlier inference is blocked with confirmed release, the Host starts a subordinate inference-only runtime with a separate Session and fixed submission; original configuration text and program reuse hints are inputs for the Agent's own repairs. Original Goal and submissions remain unchanged. The original detail page shows recovery progress, its execution trajectory and associated services. `experimentAcceptanceRecoveryStatus(id)` reads the retained observation time and diagnostics.

Recovery source entries retain `sha256` for original bytes and add `textSha256` for supplied UTF-8 text plus `textRedacted` for credential masking. The supplied-text digest is computed after masking; changed previews are references for Agent-reviewed scripts, not byte-identical executable originals. Existing source inputs remain immutable.

Observation timeouts retry within `finalization.reconnectTimeoutMs`, retaining prior observations until fresh results are available. Exhaustion leaves recovery blocked without stopping remote work. Experiment or release identity differences fail immediately; observation retries never restart Agents, services or generation.

Recovery requires the exact protected adapter as the healthy service's `modelPath`, a finished inference Goal and program-issued checks for service identity, absent/invalid credentials, model listing and real public generation. It then starts the restricted original completion review. Original stage, environment, execution and step checks still apply; recording a missing step cannot replace public generation. The review Agent can cite the program's independent recovery proof for repaired serving evidence without rerunning training or inference.

Supplementary acceptance describes current satisfaction of the original requirements. An independently verified associated recovery can complete the public-serving step in this assessment while its original blocked report remains unchanged. The recovery's own Session and release are verified association fields, not a requirement to restart the failed original process. Current serving failures still block acceptance. Review tools place unresolved step indices and associated-serving conclusions before historical records, so completed original reports need not be submitted again.

Persistence acknowledgement: [acceptance-recovery.ts](../packages/experiments/src/acceptance-recovery.ts) defines independent version-1 records under `$DSH_HOME/aspera-acceptance-recoveries/<experimentId>.v1.json`, bound to both submissions and original result, plan, Session and checkpoint identities. Original workspace `reports/acceptance-recovery/<operationId>.json` is a separate immutable proof. Host restart resumes observations; deleting the original first awaits observation shutdown and pending writes. Related inference work retains its own lifetime. Original blocked outcomes, releases, steps, logs, fleet 6, protocol 4 and Session formats remain unchanged.

## Persistence and API

Persistence acknowledgement: [completion schemas](../packages/experiments/src/completion.ts) add independent version-1 review, source and historical-environment records. `$DSH_HOME/aspera-completion-reviews/<experimentId>.v1.json` retains operation status, source identities, entries, original failure and verification time; a companion operation JSONL contains redacted Session events. The standard supplementary Session is also persisted by DSH. Local review workspaces reside under `$DSH_HOME/aspera-run-records/<experimentId>/review/<operationId>`. The remote run receives only `completion-reviews-v1/<operationId>.json`. Normal execution adds `execution-sources.v1.jsonl` and an uncommitted `execution-record-pending.v1.json` marker beside the unchanged `executions.jsonl` format. Fleet domain 6, submission protocol 4, original step files and released Session formats are unchanged.

`reviewExperimentCompletion(id)` acknowledges background review; `experimentCompletionReviewStatus(id)` reads its saved status; `cancelExperimentCompletionReview(id)` stops supplementary work. `experimentCompletionReviewTrace(id, operationId, request)` provides bounded, operation-bound local pages. Generated Remote consumers include these methods. Original fleet persistence and remote failed outcomes stay unchanged; the Host projects the independent assessment for status, filtering and counts. Deletion first stops and awaits the review, then removes its local records. Tombstones reject late writes. Disk errors block the review without changing training results.

Review trajectory pages read the original local DSH Session and redact parsed events before publication. An older damaged supplementary JSONL copy cannot hide an intact Session; reading it does not restart the Agent, rerun verification or rewrite either history. The validated supplementary copy remains a fallback when the original Session is absent. A failed Session read is reported rather than replaced with an apparently complete trajectory.

New releases advertise `completion-evidence-v1`, selected through manifest `asperaCompletionVersion: 1`. Preparation verifies this capability before reusing a controller. Existing experiments keep their original release; retrospective reading does not upgrade it.

When event counts are unavailable in Session metadata, single-event probes locate the logical tail for the default trajectory page. Older pages and continuation cursors read their requested ranges directly.

## Validation

`test:worker` replays the shipped execution profile with an omitted execution entry, recoverable completion checks and a single settled command. `test:completion` runs the standard restricted review Agent and real Remote/Web views with CPU evidence, including missing-source blocking, cancellation, retained failure, read-only historical metadata and supplementary trajectory. Unit tests cover ownership, hashing, identity conflicts and lifecycle recovery. These local checks do not establish real Linux mount isolation, historical remote file authenticity or GPU/CUDA acceptance; those require the original available nodes.
