# Gemma4 Unified TP=2 LoRA training

This recipe was validated in 2026-08 for `google/gemma-4-12B` with Swift
4.4.2, mcore-bridge 1.6.1, Megatron Core 0.16.1, Transformer Engine 1.12.0,
torch 2.6.0+cu124, and two RTX 3090 GPUs on separate nodes. Treat its numbers
and patches as version-scoped evidence, not defaults for every cluster.

## Preconditions

- Confirm `model_type=gemma4_unified` and
  `Gemma4UnifiedForConditionalGeneration` in the local model config.
- Use identical package versions, model files, and patches on every rank.
- Confirm the selected torch CUDA runtime is supported by each node's driver.
- Verify the dataset and choose `max_length` from tokenized length statistics.
- Check disk and GPU capacity without deleting or stopping anything.

Text-only SFT uses `--language_model_only true`. The validated plain-chat
template is `gemma4_nothinking`.

## Required fixes for the validated stack

Apply these only after checking that the installed
`mcore_bridge/model/mm_gpts/gemma4.py` still contains the expected source.
Prefer a maintained patched package; direct site-packages edits are a fallback
and disappear when the venv is rebuilt.

### 1. Split mixed QKV along dimension 3

```diff
- qkv = SplitAlongDim(mixed_qkv, len(split_arg_list), split_arg_list)
+ qkv = SplitAlongDim(mixed_qkv, 3, split_arg_list)
```

`SplitAlongDim` receives `split_dim` as its second argument. The
`attention_k_eq_v` path has two split sizes but the tensor is still split on
dimension 3. Passing the list length selects the wrong axis.

### 2. Make the TP-sliced query contiguous

```diff
- query = self.q_layernorm(query)
+ query = self.q_layernorm(query.contiguous())
```

The query slice can have non-contiguous strides. TE RMSNorm flattens it with
`.view()`, which requires a contiguous layout.

### 3. Save mixed-head layers with heterogeneous checkpoint keys

At the start of `Gemma4Loader.get_transformer_layer_spec`, set the
configuration field used by this mcore-bridge version:

```python
self.config.hetereogenous_dist_checkpoint = True
```

Verify the exact field spelling against the installed package. The flag keeps
layers with different projection dimensions from being packed into one
incompatible LoRA tensor at checkpoint save.

After patching, record a checksum and compare it across ranks. Validate model
construction, one training step, and a checkpoint save before a long run.

## Parameterized launch shape

Export distributed variables in each rank's environment:

```bash
export MASTER_ADDR=<rank0-address>
export MASTER_PORT=<free-port>
export NPROC_PER_NODE=1
export NNODES=2
export NODE_RANK=<0-or-1>
export NCCL_SOCKET_IFNAME=<assigned-interface>
export NCCL_IB_DISABLE=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
```

Use the same training command on every rank:

```bash
megatron sft \
  --model <model-dir> \
  --model_type gemma4_unified \
  --template gemma4_nothinking \
  --dataset <sharegpt-jsonl> \
  --train_iters <validated-step-count> \
  --global_batch_size 8 \
  --micro_batch_size 1 \
  --max_length <validated-length> \
  --tensor_model_parallel_size 2 \
  --pipeline_model_parallel_size 1 \
  --tuner_type lora \
  --lora_rank 8 \
  --lora_alpha 32 \
  --lora_dropout 0.05 \
  --target_modules all-linear \
  --output_dir <output-dir> \
  --save_strategy steps \
  --save_steps <checkpoint-interval> \
  --save_total_limit 3 \
  --merge_lora false \
  --save_safetensors true \
  --add_version false \
  --attention_backend unfused \
  --padding_free false \
  --recompute_granularity selective \
  --recompute_modules core_attn \
  --bf16 true \
  --language_model_only true \
  --lr <validated-learning-rate> \
  --logging_steps 1
```

Do not combine `num_train_epochs` and `train_iters` until precedence has
been checked in the installed Swift version. Start with a bounded smoke run.
Confirm both ranks joined the same distributed world and that a real checkpoint
can be reopened.

## Memory observations

On the validated two-card profile:

- `max_length=2048` approached the physical limit and later failed on a small
  allocation.
- `max_length=1024` stayed around 20–22 GiB per GPU for the observed dataset.

These are measurements, not guarantees. Recalculate for the current dataset,
GPU processes, package versions, batch size, and sequence lengths. A slow run
on a low-bandwidth TP link is communication-bound, not compute-bound.

## Checkpoints and continuation

With `--merge_lora false`, periodic checkpoints remain adapter-oriented.
Distributed rank shards and metadata may not all be written to the same local
filesystem. Before a load or export, verify that every rank can see the complete
required checkpoint and PEFT adapter files. Prefer shared storage or an
explicitly verified synchronization step.

For the validated stack:

- `--mcore_model <lora-checkpoint>` is invalid because it expects a full model.
- `--mcore_adapter <lora-checkpoint>` fails in the distributed-checkpoint
  loader.
- `--adapters <checkpoint> --no_finetune` can reload PEFT adapter weights and
  continue with fresh optimizer and RNG state.

The last option is an **adapter warm-start**, not an exact resume. Report this
distinction and expect optimization dynamics to change. Do not silently copy
metadata or shards between nodes; validate the source, destination, and
checkpoint consistency first.

## Export and inference verification

Export the adapter without merging:

```text
megatron export --to_hf --merge_lora false
```

Validate the resulting PEFT metadata and tensor set, then compare the same
deterministic prompts with:

1. the base model only;
2. the base plus dynamically loaded adapter.

Do not use a fixed `lora_B.absmax` threshold. Check A/B keys, finite values,
rank, alpha, scales, and the effective adapter branch or logits difference.

The validated vLLM 0.19.1 profile is not a supported TP=2 Gemma4 Unified LoRA
backend. Use a compatible Transformers + PEFT verification path and keep the
adapter separate.

For FP8 adapters, apply their saved scale metadata when dequantizing. If the
runtime cannot consume FP8 directly, convert only the adapter to BF16 and load
it dynamically. Never merge a low-precision adapter into the BF16 base merely
to satisfy the serving backend.
