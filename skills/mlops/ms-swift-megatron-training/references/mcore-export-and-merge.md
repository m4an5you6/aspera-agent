# `megatron export --to_hf` — merging a TP=2 LoRA checkpoint into a full HF model

Session-verified (2026-08, ms-swift 2.3.0.post1 / megatron-core 0.16.1, cross-node tp=2, Qwen3.5-9B-Claude-distill).

## Working command (run on BOTH nodes via torchrun env vars)

```bash
# rank 0 (local master) — identical on rank1 except NODE_RANK=1
source /home/ubuntu/swiftvenv/bin/activate
export CUDA_VISIBLE_DEVICES=0 NPROC_PER_NODE=1 NNODES=2 NODE_RANK=0 \
  MASTER_ADDR=<rank0_priv_ip> MASTER_PORT=29500 \
  NCCL_IB_DISABLE=1 NCCL_SOCKET_IFNAME=<iface> NCCL_DEBUG=INFO
export LD_LIBRARY_PATH="/home/ubuntu/cudatk/lib:${LD_LIBRARY_PATH}"
megatron export \
  --to_hf true \
  --model /home/ubuntu/models/Qwen3.5-9B-Claude-distill \
  --model_type qwen3_5 \
  --adapters /home/ubuntu/output/qwen35_finance_tp2/checkpoint-280 \
  --merge_lora true \
  --tuner_type lora \
  --tensor_model_parallel_size 2 --pipeline_model_parallel_size 1 \
  --output_dir /home/ubuntu/output/qwen35_finance_tp2/merged \
  --exist_ok true \
  --max_length 2048 --padding_free false --attention_backend unfused --bf16 true
```

Launch order same as training: start rank0 in tmux, poll `ss -tln | grep -q ':29500 '`,
then start rank1. Never launch rank1 before rank0's port is listening (EXIT=247, see SKILL.md).

## Why `--adapters`, not `--mcore_adapter`

- `--mcore_adapter` → `load_mcore_checkpoint(load_arg='mcore_adapter')` → megatron
  `dist_checkpointing.load_common_state_dict` → on 0.16.1 crashes:
  `TypeError: object of type '_io.BytesIO' has no len()` at
  `strategies/torch.py:_replace_sharded_keys_with_state_dict_keys`.
  Cause: sharded keys in the checkpoint `.metadata` are megatron-layer-named
  (`language_model.decoder.layers.N.self_attention.in_proj.lora_A.default.weight`,
  `..._extra_state/shard_0_1` BytesStorageMetadata entries) and the freshly built export
  model's `_generate_state_dict` layout doesn't line up → a BytesIO lands where a list
  is expected.
- `--adapters <ckpt_dir>` → `bridge.load_weights(..., peft_format=True)` reads the PEFT
  `adapter_model.safetensors` (present in every save dir; ~43MB for 9B LoRA) directly and
  handles the mcore↔HF layer-name mapping itself (see `mcore_bridge/bridge/gpt_bridge.py`
  around `load_weights`). Avoids dist_checkpointing entirely.

## The adapter's key namespace (what training actually saved)

PEFT safetensors keys are megatron-named, e.g.:
`base_model.model.model.language_model.layers.0.linear_attn.in_proj_a.lora_A.weight`
and `...mlp.down_proj.lora_A.weight` etc. (496 keys for Qwen3.5-9B, r=8, target regex in
adapter_config.json: `^(model\.language_model(?=\.).*\.(q_proj|down_proj|in_proj_qkv|...))$`).
So do NOT try to merge with vanilla `peft` + HF base model directly — the module names
don't exist in the HF checkpoint. Always go through `megatron export` (bridge does the
mapping), or write your own mcore→HF rename table.

## Error sequence without the fixes (in escalating order)

1. `ValueError: remaining_argv: ['--ckpt_dir', ...]` — `--ckpt_dir` is NOT a CLI arg of
   `megatron export` (it's an internal attr; CLI parser rejects it). Remove it; the export
   reads training args from `--adapters`' args.json.
2. `Checkpoint directory .../iter_0000000 does not exist` — non-master node lacks
   `latest_checkpointed_iteration.txt` (master-only file). `_load_iteration` reads 0 →
   looks for iter_0000000. Fix: scp the tracker file from master:
   `echo 280 > .../checkpoint-280/latest_checkpointed_iteration.txt` (or copy master's).
3. `... is not a distributed checkpoint` — non-master node lacks `iter_<N>/metadata.json`.
   Fix: scp from master's `iter_<N>/metadata.json`.
4. `FileNotFoundError: .../iter_0000280/.metadata` — non-master lacks the HIDDEN metadata
   file (666KB, torch dist Metadata pickle). Fix: `scp .../iter_<N>/.metadata` (must pass
   the hidden file explicitly to scp).
5. `NCCL error: remote process exited` / SIGABRT on rank0 — remote rank died on one of the
   above; fix the remote's files and relaunch both ranks.

## Verify

- Success = `--output_dir` contains a complete HF model dir (config.json, *.safetensors,
  tokenizer files, `args.json`).
- If `--to_hf` with `--merge_lora true`, `save_peft_format=False` → full merged weights,
  NOT adapter-only. (Export args: `merge_lora` defaults to `to_hf`.)
