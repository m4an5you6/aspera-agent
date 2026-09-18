# Megatron LoRA export to Hugging Face

This reference covers the export behavior validated in 2026-08 with Swift,
mcore-bridge 1.6.1, and Megatron Core 0.16.1. Prefer adapter-only export.
Create a full merged model only when the user explicitly needs one and its
precision and storage tradeoffs are acceptable.

## Choose the output mode

### Adapter-only, preferred

```text
--to_hf true --merge_lora false
```

The expected output is an `hf_lora_<step>/` directory containing
`adapter_config.json` and `adapter_model.safetensors` with HF-compatible
module names. This avoids writing another full base model and supports dynamic
PEFT or vLLM loading when the architecture implements LoRA.

Adapter-only export is required when small low-precision deltas must not be
merged into a BF16 base. If an FP8 adapter requires conversion, convert the
adapter only and retain its scale semantics.

### Full merge, optional

```text
--to_hf true --merge_lora true
```

This writes full model weights and consumes base-model-scale disk space. It
also rounds the combined weights to the output dtype. Do not choose it for an
FP8 or otherwise small adapter when preserving unmerged deltas is required.

Before a merge, confirm:

- the user requested a standalone full model;
- output precision and expected loss are acceptable;
- enough temporary and final disk space exists;
- the destination is exact and does not overwrite an artifact to preserve.

## Reconstruct the training topology

Run distributed export with the topology required to construct the model.
Training checkpoint arguments are not guaranteed to restore TP, PP, ETP, or
LoRA targets automatically.

Pass explicitly as applicable:

- `tensor_model_parallel_size`;
- `pipeline_model_parallel_size`;
- `expert_tensor_parallel_size`;
- the same `target_modules`;
- model type, attention mode, and dtype.

Use current assignment values rather than addresses, ports, credentials, or
paths copied from an earlier run.

Parameterized adapter-only shape:

```bash
megatron export \
  --to_hf true \
  --model <base-model-dir> \
  --model_type <model-type> \
  --adapters <checkpoint-dir> \
  --merge_lora false \
  --tuner_type lora \
  --tensor_model_parallel_size <tp> \
  --pipeline_model_parallel_size <pp> \
  --output_dir <output-dir> \
  --exist_ok false
```

For MoE models, also pass ETP and the same non-expert target list used during
training. Start with a bounded export validation before a long or destructive
merge.

## Why `--adapters` was used in the validated stack

In Megatron Core 0.16.1, the `--mcore_adapter` path entered distributed
checkpoint loading and failed on a `BytesIO` metadata mismatch.

`--adapters <checkpoint-dir>` instead used the checkpoint's PEFT
`adapter_model.safetensors` through the mcore-to-HF bridge. This also handled
the namespace conversion from Megatron module names to HF module names.

Treat this as version-specific. Inspect current CLI help and run a small export
when using another Swift/mcore-bridge release.

Do not load a Megatron-named training adapter directly into the HF base unless
its keys have already been converted or a verified rename mapping is supplied.

## Distributed checkpoint visibility

Rank-local checkpoint layouts vary by storage and framework version. In the
observed local-disk TP=2 layout, each rank held only its own `.distcp` shards,
while PEFT files and metadata availability differed by save/export path.

Before loading or exporting:

1. inventory tracker, JSON metadata, hidden `.metadata`, `common.pt`, PEFT
   files, and all rank shard names on every node;
2. compare step numbers, file sizes, and checksums where duplicates exist;
3. determine whether the selected loader reads PEFT files only or distributed
   shards;
4. make the complete required view available through shared storage or a
   deliberate synchronization step.

Do not blindly copy or overwrite metadata based on a previous run. Stop if
ranks disagree on checkpoint step or metadata. Any synchronization is a
mutation and requires confirmed source and destination paths.

Common signals:

- `iter_0000000 does not exist`: tracker or selected iteration is missing;
- “not a distributed checkpoint”: required checkpoint metadata is absent;
- missing `.metadata` or `__<rank>_*.distcp`: the loader cannot see a
  complete checkpoint view;
- NCCL remote-process exit: inspect the failing rank's first error rather than
  treating the peer failure as the root cause.

## Inspecting adapter weights

For a PEFT export, read `adapter_model.safetensors` with `safe_open`.
Validate:

- expected A/B keys and target modules;
- rank and alpha from `adapter_config.json`;
- finite tensors;
- dtype and any FP8 scale metadata;
- consistent tensor shapes.

Do not use a fixed `lora_B.absmax` threshold. Evaluate the effective branch
`(alpha / rank) * B(A(x))` or compare deterministic base-vs-adapter logits.

For raw Megatron distributed checkpoints, use the installed Megatron
`load_plain_tensors` implementation only when all required shards are
available. Run it in a bounded, isolated process group and destroy the group
on exit. Do not parse internal pickle/zip payloads as a stable file format.
Load pickle-based checkpoint metadata only from trusted artifacts.

## Verification

Adapter-only success requires:

- `adapter_config.json` and `adapter_model.safetensors`;
- HF-compatible key names;
- expected rank, alpha, targets, dtype, and scales;
- successful unmerged load with the intended base;
- a deterministic difference between base and adapter behavior.

Full-merge success additionally requires a complete HF model directory,
successful reload in a fresh process, and comparison against the unmerged
base-plus-adapter result.

Do not mark an export successful solely because the command exited zero or the
output directory exists.
