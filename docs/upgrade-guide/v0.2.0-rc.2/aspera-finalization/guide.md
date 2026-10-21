---
kind: upgrade-guide
description: "Aspera commands wait for cleanup, training stages use approved arithmetic, and historical blocked results support restricted supplementation."
---

# Aspera stage acceptance and finalization

English | [中文](guide.zh.md)

## Change

Ordinary command tools wait for terminal exit and cleanup. Distributed participants use `run_experiment_command_group` so all members launch before waiting. No additional model request is required to poll logs. Observation cancellation and transport failure do not prove process exit.

Training plans declare structured stages before approval. Register effective parameters and evidence paths before launch, then request program verification. Additional and cumulative optimizer steps, metric coverage, sample counts and restored schedulers use separate checks. All finish requests inspect real work and records; unsupported budget claims request correction.

Released blocked experiments with independently confirmed original training and finalization evidence can request restricted supplementation. Original outcomes and step files remain unchanged; only a verified independent receipt displays Revalidation passed. Review cannot train, evaluate or run inference.

## Migration

1. Rebuild Remote consumers for `experimentCompletionAssessment` and `experimentFinalizationStatus`. Configure `finalization` polling, read/reconnect budgets and correction limits through the profile when defaults do not fit deployment requirements.
2. Use new releases declaring `asperaFinalizationVersion: 2` and `experiment-finalization-v2`; preparation checks controller compatibility. Keep original experiments and releases fixed.
3. Plan Transformers/ms-swift/PEFT stages with explicit cumulative/additional steps and scheduler semantics. Replace model log polling with waiting command tools; use dedicated tools for resident services.
4. Review eligible historical results using original files, commands and Session evidence. Preserve checkpoints, logs and the original result; do not rerun completed work to fill missing reports. Independent version-1 records and persistence acknowledgements are documented in [stage acceptance](../../../../extensions/aspera/docs/finalization.md). Submission protocol 4, fleet 6 and Session formats remain unchanged.
