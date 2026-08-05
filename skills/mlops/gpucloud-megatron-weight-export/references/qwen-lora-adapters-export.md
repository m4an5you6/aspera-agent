# Qwen LoRA adapter export: megatron checkpoint -> vLLM-loadable hf_lora

Session-verified 2026-08: Qwen3.5-9B-Claude-distill, swift 2.3.0 /
megatron-core 0.16.1 / mcore-bridge, TP=2 training on two RTX 3090 nodes.

## Why NOT the obvious paths

- `megatron export --to_hf --mcore_adapter <checkpoint-N>` loads the
  distributed checkpoint (`iter_N/__*.distcp`). On megatron-core 0.16.1 this
  crashed with:
  `TypeError: object of type '_io.BytesIO' has no len()` inside
  `megatron/core/dist_checkpointing/strategies/torch.py`
  (`_replace_sharded_keys_with_state_dict_keys`): `.metadata` sharded keys are
  megatron layer names and mismatch the export-rebuilt model layout.
- Multi-node distcp: `latest_checkpointed_iteration.txt`, `metadata.json` and
  `.metadata` are written ONLY on the master (rank0). A worker node loading
  via `--mcore_adapter` fails with `iter_0000000 does not exist`,
  `is not a distributed checkpoint`, then `.metadata No such file`. Copy them
  from master, or avoid distcp entirely (A2 path).
- `--ckpt_dir` is NOT a CLI flag for `megatron export` (it is an internal
  attribute; passing it fails with `remaining_argv: ['--ckpt_dir', ...]`).
- Training already saved a complete PEFT LoRA on the master node:
  `<output>/checkpoint-<N>/adapter_model.safetensors` + `adapter_config.json`.
  Use that instead of the distcp tree.

## Working single-node path (`--adapters`, TP=1)

megatron export always goes through `torch.distributed.run`, so set the env or
it dies with `ValueError: environment variable RANK expected, but not set`.

```bash
export NPROC_PER_NODE=1 NNODES=1 NODE_RANK=0 MASTER_ADDR=127.0.0.1 MASTER_PORT=29501
megatron export \
  --to_hf true \
  --model <base_hf_model_dir> \
  --model_type qwen3_5 \
  --adapters <output>/qwen35_finance_tp2/checkpoint-280 \
  --merge_lora false \
  --tuner_type lora \
  --tensor_model_parallel_size 1 \
  --pipeline_model_parallel_size 1 \
  --output_dir <output>/qwen35_finance_tp2/hf_lora_280 \
  --exist_ok true \
  --max_length 2048 \
  --padding_free false --attention_backend unfused \
  --bf16 true
```

Success markers: `hf_lora_280/{adapter_config.json, adapter_model.safetensors}`.
Take ~85s after model load.

## The adapter keeps megatron layer names — that is fine

Keys stay `base_model.model.model.language_model.layers.N.linear_attn.
in_proj_a / in_proj_b / in_proj_qkv / in_proj_z / out_proj` plus `mlp.*`.
Do NOT hand-rename to HF names. vLLM >= 0.19.1 loads them natively for
`qwen3_5` (stacked-param mapping `in_proj_qkvz <- in_proj_qkv + in_proj_z`,
`in_proj_ba <- in_proj_b + in_proj_a`, plus the `language_model` LoRA
wrapper). See gpucloud-inference-deployment
`references/qwen35-vllm-lora-multinode.md`.

## Disk / size

`--merge_lora false` keeps checkpoints at adapter size (~43 MB). The default
`--merge_lora true` writes a full model per save and `*-merged` dirs are never
rotated — see gpucloud-sft-training
`references/dual-node-training-ops-pitfalls.md` (it fills the disk and kills
training).
