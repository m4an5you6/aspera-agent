---
name: ms-swift-megatron-training
description: Run and diagnose direct ModelScope Swift Megatron training on one or more Linux GPU nodes. Use for the `megatron` CLI, mcore-bridge model routing, distributed launch, LoRA checkpoints, export, or post-training verification; use the GPUCLOUD worker skill for platform-managed task YAML.
metadata:
  gpucloud:
    tags: [ms-swift, swift, megatron, mcore-bridge, transformer-engine, sft, lora, distributed, tp, fp8]
    triggers:
      - ms-swift megatron training
      - swift megatron framework
      - megatron sft
      - qwen3.5 training
      - kimi-vl megatron
      - gemma4 megatron
      - transformer_engine install
      - mcore-bridge
      - megatron fp8
      - megatron communication quantization
      - megatron 通信量化
---

# Direct ms-swift Megatron training

Use this skill for training on nodes controlled directly through SSH. Do not use
node-specific addresses, credentials, process IDs, or old output paths from a
previous run. Obtain topology and authentication from the current assignment.

## Safety and scope

- Start with read-only inspection. Confirm the requested model, nodes, GPUs,
  dataset, output directory, and installed stack before changing an environment.
- Do not search shell history or unrelated files for credentials. Never put a
  password in documentation, logs, process arguments, or committed scripts.
- Killing processes, changing cron/watchdogs, deleting checkpoints, replacing a
  venv, or patching installed packages requires explicit authorization and exact
  targets. A status request does not authorize any of these actions.
- Do not automatically delete checkpoints when disk is low. Report exact paths
  and sizes, then let the user choose what is disposable.
- Keep training and inference environments separate when their dependency
  requirements differ.

## Establish the environment profile

The validated 2026-08 profile used Swift 4.4.2, mcore-bridge 1.6.1,
Megatron Core 0.16.x, Transformer Engine 1.12.0, and torch 2.6.0+cu124.
Treat this as a tested combination, not a universal latest-version requirement.

Before launch:

1. Inspect installed package versions and their declared constraints.
2. Check that every rank uses the same torch, Swift, Megatron, mcore-bridge,
   Transformer Engine, model files, and source patches.
3. Check driver compatibility with the CUDA runtime bundled in the selected
   torch wheel. Version strings do not need to be identical; the driver must
   satisfy the runtime's minimum requirement.
4. Verify `transformer_engine` imports in the actual training interpreter.

The direct CLI is `megatron sft|pt|rlhf|export`. The CLI must run under its
torchrun wrapper; export `NPROC_PER_NODE`, `NNODES`, `NODE_RANK`,
`MASTER_ADDR`, and `MASTER_PORT` as required by the installed Swift version.

## Model routing

- **Qwen3.5:** use the explicit model type when auto-detection is ambiguous.
  Text-only VLM training uses `--language_model_only true`. Validate required
  architecture dependencies with a small smoke run.
- **Gemma4 Unified:** mcore-bridge recognizes `gemma4_unified`, but the
  validated stack requires three source fixes for mixed attention dimensions.
  Read [references/gemma4-megatron-notes.md](references/gemma4-megatron-notes.md)
  and [references/gemma4-unified-training.md](references/gemma4-unified-training.md).
- **Kimi-VL:** registration alone is insufficient. The validated TP=2 path
  requires expert sharding, non-expert LoRA targets, and version-specific
  patches. Read
  [references/kimivl-megatron-training.md](references/kimivl-megatron-training.md)
  before changing or launching that stack.

Do not describe a registry hit as proof that TP, LoRA, quantization, checkpoint
save, or export works. Confirm the exact combination with a bounded smoke run.

## Launch workflow

1. Validate model and dataset completeness. For sharded weights, compare the
   index `weight_map` with files present on every node.
2. Choose `max_length` from tokenized dataset statistics and available memory.
3. Run a small single-node configuration when the architecture supports it.
   This validates imports, argument names, model construction, one forward and
   backward step, and checkpoint writing.
4. For multi-node runs, use assignment-provided addresses and interfaces. Do
   not perform extra connectivity or bandwidth probes without authorization.
5. Start ranks with the same command and configuration, changing only
   rank-local values. Confirm the distributed world from logs before treating
   the run as active.
6. Write logs to per-attempt files so a restart cannot overwrite the original
   failure. Use process start time, log/checkpoint timestamps, and the latest
   completed iteration when reporting progress.

For time-boxed runs, use either `train_iters` or `num_train_epochs`, not both,
after confirming precedence in the installed Swift version. Prefer
`--merge_lora false` during training so periodic saves remain adapter-sized;
export an adapter-only HF artifact after training.

## Checkpoints and recovery

- A process/GPU check only says whether training is running now. Determine
  completed, failed, or never-started state from task status, exit markers,
  logs, and checkpoint metadata.
- On distributed checkpoints, verify that all required rank shards and metadata
  are visible before loading or exporting. Prefer shared storage or an explicit
  verified synchronization step.
- In the validated stack, `--mcore_model` is not a LoRA-checkpoint resume path,
  and `--mcore_adapter` hits a distributed-checkpoint loader failure.
- `--adapters <checkpoint> --no_finetune` can continue from PEFT adapter
  weights, but it starts with fresh optimizer/RNG state. Call this an
  **adapter warm-start**, not an exact resume.
- Restarting both ranks, changing watchdogs, or removing stale processes is a
  mutation. Diagnose first and request approval before acting.

For unstable-link symptoms and bounded recovery criteria, read
[references/unstable-link-recovery.md](references/unstable-link-recovery.md).
Do not enable an automatic kill/restart watchdog unless the user explicitly
requests it and its targets and retry limit are narrowly scoped.

## FP8 and LoRA precision

- A Megatron/Transformer Engine FP8 flag normally controls selected GEMMs. It
  does not by itself mean that trainable LoRA tensors or exported adapters are
  stored as FP8.
- In the validated Megatron Core 0.16.x profile, TP/SP activation collectives
  remain BF16; FP8 parameter gather is a separate distributed-optimizer feature.
  Read [references/mcore-fp8-communication.md](references/mcore-fp8-communication.md)
  before promising communication savings.
- Validate a LoRA structurally (finite tensors, expected A/B keys, rank, alpha,
  targets, and any FP8 scales) and functionally. Do not use a universal
  `lora_B.absmax` threshold.
- Measure the effective branch
  `(alpha / rank) * B(A(x))` or compare deterministic base-vs-adapter logits.
  A nonzero B tensor is not proof of useful learning.
- For an FP8 adapter, interpret its scale metadata and dequantize through the
  producing format. Do not cast a raw payload without applying its scales.
- Keep low-precision adapters separate at inference. If the backend cannot
  consume FP8 adapters directly, convert the **adapter only** to BF16 and load
  it dynamically. Do not merge it into a BF16 base, where small deltas can be
  absorbed by BF16 rounding.

## Export and verification

The default handoff for LoRA is an adapter-only HF directory containing
`adapter_config.json` and `adapter_model.safetensors`:

```text
megatron checkpoint
  -> megatron export --to_hf --merge_lora false
  -> validate adapter metadata and tensors
  -> load base + adapter without merge
  -> compare base and adapter outputs
```

Run export with the same TP/ETP topology required to construct the model unless
the installed exporter documents otherwise. For the validated loader details,
read [references/mcore-export-and-merge.md](references/mcore-export-and-merge.md).

Use vLLM dynamic LoRA only when the exact model implementation advertises LoRA
support. Otherwise use a compatible Transformers + PEFT path. In both cases,
keep the adapter unmerged. A reusable vLLM offline smoke template is available
at [templates/vllm_lora_smoke.py](templates/vllm_lora_smoke.py).

## References

- [Transformer Engine installation](references/transformer-engine-install.md):
  read when constructing or repairing the validated environment.
- [Training progress status](references/training-progress-status.md): read for
  read-only “where is the run?” investigations.
- [mcore FP8 communication](references/mcore-fp8-communication.md): read for
  FP8 compute versus communication capability.
- [Kimi-VL Megatron training](references/kimivl-megatron-training.md): read only
  for Kimi-VL training or export.
- [Gemma4 notes](references/gemma4-megatron-notes.md) and
  [Gemma4 Unified training](references/gemma4-unified-training.md): read only
  for Gemma4-family work.
