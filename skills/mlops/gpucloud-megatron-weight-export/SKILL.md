---
name: gpucloud-megatron-weight-export
description: Export Megatron checkpoints to HF via proven recipes.
version: 1.1.0
author: GPUCLOUD
platforms: [linux]
metadata:
  gpucloud:
    tags: [gpucloud, megatron, export, conversion, hf, inference, distcp]
    related_skills: [gpucloud-inference-deployment, gpucloud-sft-training]
    category: mlops
    triggers:
      - megatron_checkpoints
      - export megatron to hf
      - convert distcp
      - ModelOpt export
      - SWIFT megatron export
---

# GPUCLOUD Megatron Weight Export

Playbook for turning Megatron `iter_*` / `.distcp` trees into an HF-loadable
directory on **this** GPU node. Follow the recipe order yourself with
`terminal` / file tools. This is not a platform HTTP client skill.

## When to Use

- `training_artifact_kind=megatron_checkpoints`, or path has
  `megatron_checkpoints` / `iter_*` / `*.distcp`.
- Weights are local (after `sources[]` sync) but not HF-loadable.

## Prerequisites

- Checkpoint root on disk with `iter_*`, `.metadata`, required `.distcp` shards,
  and preferably `args.json`.
- Tools: `terminal`, `read_file`, `search_files`.
- Env hints often used on platform nodes (override if different):
  - Megatron-LM checkout + python: `MEGATRON_LM_REPO`, `MEGATRON_LM_PYTHON`
  - SWIFT megatron CLI: often
    `~/.cache/gpu_platform/swift_venv/bin/megatron` (`SWIFT_MEGATRON`)

## How to Run

1. Classify family → pick recipe.
2. Run primary tool; on failure try the next step in that recipe.
3. Verify HF/LoRA markers → use that dir as serve `model_path`.

## Quick Reference

| Family | Primary | Then | Last |
|--------|---------|------|------|
| GPT-2 full weights | Megatron-LM **ModelOpt** export | Native GPT-2 distcp→HF (repo-style) | Minimal custom `load_distcp` |
| Qwen LoRA megatron | **SWIFT** `megatron export` (`--to_hf`, `--merge_lora false`) | Manual LoRA convert (non-MoE only) | Minimal custom `load_distcp` (non-MoE) |
| Already HF | Skip export | — | — |

## Procedure

### 1. Confirm inputs

Under `.../megatron_checkpoints/`:

- Resolve iter: `latest_checkpointed_iteration.txt` or newest `iter_*`
- Need `.metadata` + all shards listed therein (`__*_*`.distcp)
- Read `args.json` for base/tokenizer / architecture clues

Incomplete shards → sync from `sources[]` first; do not convert a partial tree.

### 2. Route by family

- **gpt2**: full HF under `{job_dir}/output/`
- **qwen***: LoRA adapter under `{job_dir}/hf_lora_{iter}/` (vLLM: base + adapter)
- Unknown: inspect `args.json` / `model_hint`; if unclear, fail
  `phase=ensure_artifacts` briefly (do not guess MoE manual convert)

### 3. GPT-2 recipe

**A. ModelOpt (preferred)**

1. Ensure Megatron-LM repo has
   `examples/post_training/modelopt/export.py` and `nvidia-modelopt` in that
   python env (`pip install 'nvidia-modelopt[torch]'` if needed).
2. From `args.json`, pick HF scaffold / tokenizer id (pretrained name).
3. Run ModelOpt export via `torchrun` against that script, roughly:

```bash
# Adjust MEGATRON_LM_REPO / PYTHON / paths to the node. See references/export-recipes.md.
torchrun --standalone --nproc_per_node=1 \
  "$MEGATRON_LM_REPO/examples/post_training/modelopt/export.py" \
  --load "<megatron_checkpoints_root>" \
  --use-checkpoint-args \
  --export-dir "<job_dir>/output" \
  --pretrained-model-name "<hf_scaffold>" \
  --tokenizer-model "<tokenizer_id>" \
  --tokenizer-type HuggingFaceTokenizer \
  --export-model-type GPTModel \
  --auto-detect-ckpt-format
  # plus TP/PP/batch/finetune flags from export-recipes.md / --help
```

4. Success: `<job_dir>/output/config.json` and
   `model.safetensors` or `pytorch_model.bin`.

**B. If ModelOpt fails** — use a GPT-2-aware distcp→HF mapping (transpose
Conv1D-style weights correctly). Prefer adapting known-good logic over a
blank script. See `references/export-recipes.md`.

**C. Last resort** — minimal custom `load_distcp` only after A/B fail; still
must produce the same HF markers.

### 4. Qwen LoRA recipe

**A. SWIFT megatron export (preferred)**

```bash
# Typical platform SWIFT CLI; confirm flags with: megatron export --help
"$SWIFT_MEGATRON" export \
  --model "<base_hf_model_id_from_args.json>" \
  --mcore_adapter "<checkpoint_dir>" \
  --to_hf true \
  --merge_lora false \
  --output_dir "<job_dir>/hf_lora_<iter_name>" \
  --exist_ok true \
  --torch_dtype bfloat16
```

Success: dir has `adapter_config.json` + `adapter_model.safetensors`.

**B. If SWIFT fails** — manual LoRA convert only when architecture is
supported (not MoE / attention-only LoRA). Otherwise fail with diagnostic.

**C. Last resort** — minimal custom `load_distcp` for supported LoRA only.

### 5. Verify then serve

| Kind | Ready when |
|------|------------|
| Full HF | `config.json` + (`model.safetensors` \| `pytorch_model.bin`) |
| LoRA | `adapter_config.json` + `adapter_model.safetensors` |

Then `inference_start_vllm` / health / `inference_report_ready`.

## Pitfalls

- Raw `.distcp` is not vLLM-loadable.
- Prefer ModelOpt / SWIFT over inventing parsers; custom `load_distcp` is
  **last resort** and should mirror proven GPT-2 / LoRA mapping, not random
  tensor dumps.
- GPT-2 Conv1D layout mistakes → shape errors at load time.
- Qwen MoE: if SWIFT fails, stop (manual fallback unsupported).
- Huge convert logs blow context — keep status + final paths only.
- Watch disk; export size ≈ checkpoint scale.

## Verification

- GPT-2: `output/config.json` + weight file exist.
- Qwen: `hf_lora_*/adapter_model.safetensors` exists.
- Only then start vLLM.

## See also

- `references/export-recipes.md` — ordered steps, flags, readiness checks.
- Skill `gpucloud-inference-deployment` — serve after export.