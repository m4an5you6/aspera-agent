# Kimi-VL Megatron TP=2 LoRA training

This reference covers the version-scoped path validated in 2026-08 for
`Kimi-VL-A3B-Thinking-2506`, Swift 4.4.2, mcore-bridge 1.6.1, Megatron Core
0.16.1, Transformers 5.12.1, and two 24 GB GPUs on separate nodes.

mcore-bridge recognizes `kimi_vl`, but registration alone is not an
end-to-end support guarantee. The validated path required expert sharding,
non-expert LoRA targets, and several source compatibility fixes. Re-check the
installed source before applying any patch to another version.

## Model and topology invariants

The validated model has an MLA + MoE text tower:

- 27 layers, hidden size 2048, 16 heads, vocabulary 163840;
- 64 routed experts per MoE layer, top-k 6, plus shared experts;
- about 11.1B text parameters, with most weight storage in routed experts;
- a separate MoonViT vision tower.

For text-only SFT use `--language_model_only true`.

On two 24 GB ranks:

- `--tensor_model_parallel_size 2`;
- `--expert_tensor_parallel_size 2`;
- `--micro_batch_size 1` as the conservative starting point;
- `--merge_lora false` for periodic checkpoints.

With ETP=1, routed experts are replicated and the validated model exhausted a
24 GB rank during construction. Treat ETP=TP as a measured requirement for
this profile, not a universal MoE formula.

## LoRA targets under expert parallelism

The validated mcore-bridge version rejects LoRA wrapping of routed-expert
`TEGroupedLinear` modules when ETP is greater than one. Do not use
`--target_modules all-linear` for this topology.

Use the explicit non-expert MLA targets:

```text
linear_q_proj
linear_q_down_proj
linear_q_up_proj
linear_kv_down_proj
linear_kv_up_proj
linear_proj
```

Confirm from the launch log that trainable parameters are nonzero, and inspect
the saved adapter configuration to ensure that only intended modules were
selected. Nonzero trainable parameters prove attachment, not useful learning.

## Version-scoped training fixes

Prefer a supported upstream configuration or patched package. If direct source
patches are unavoidable:

- verify the expected source context first;
- apply the same patch on every rank;
- record package versions and patched-file checksums;
- remove diagnostic prints after validation;
- repeat model construction, one forward/backward step, and checkpoint save;
- expect venv rebuilds to remove the patches.

### MLA gather when sequence parallelism is disabled

In the validated mcore-bridge source,
`multi_latent_attention.py` gathered positional keys whenever TP was greater
than one. With a complete sequence already present and sequence parallelism
disabled, that doubled the sequence dimension.

```diff
- if parallel_state.get_tensor_model_parallel_world_size() > 1:
+ if (
+     parallel_state.get_tensor_model_parallel_world_size() > 1
+     and self.config.sequence_parallel
+ ):
      k_pos_emb = gather_from_sequence_parallel_region(k_pos_emb)
```

First test whether `sequence_parallel=true` is supported by the current
pipeline; that avoids the SP-disabled path. Use the patch only when the
workflow must run without sequence parallelism and the observed shapes confirm
the same defect.

### MoE + TP without sequence parallelism

Megatron Core 0.16.1 raises on MoE training with TP enabled and sequence
parallelism disabled because that combination can be very inefficient. Do not
blindly remove this guard.

Preferred order:

1. test the supported sequence-parallel configuration;
2. measure memory, correctness, and communication behavior;
3. only if the validated pipeline requires SP=false, replace the raise with a
   narrowly documented warning in a maintained patch.

The warning must not be interpreted as evidence that performance is
acceptable.

### Kimi remote-code compatibility with Transformers 5.12.1

The model repository's `modeling_kimi_vl.py` was written against Transformers
4.x. The validated training stack needed these compatibility changes:

- provide a fallback for the removed `is_torch_fx_available` import;
- normalize the new `rope_type` representation, treating
  `rope_type=default` as no scaling;
- allow `tie_weights(*args, **kwargs)` so the newer caller can pass
  `recompute_mapping`.

Patch the model-directory source, not a generated Hugging Face cache copy.
After changing it, invalidate only that model's dynamic-module cache so other
models are unaffected. Resolve and confirm the exact cache directory before
removing it.

These changes are for the Transformers 5.12.1 **training** stack. They do not
make Transformers 5.x the preferred Kimi-VL inference runtime.

## Launch shape

Export the current assignment's torchrun variables and use the same command on
each rank, changing only `NODE_RANK`:

```bash
megatron sft \
  --model <model-dir> \
  --model_type kimi_vl \
  --template kimi_vl \
  --dataset <sharegpt-jsonl> \
  --train_iters <validated-step-count> \
  --tensor_model_parallel_size 2 \
  --expert_tensor_parallel_size 2 \
  --pipeline_model_parallel_size 1 \
  --tuner_type lora \
  --lora_rank 8 \
  --lora_alpha 32 \
  --target_modules linear_q_proj linear_q_down_proj linear_q_up_proj linear_kv_down_proj linear_kv_up_proj linear_proj \
  --micro_batch_size 1 \
  --global_batch_size <validated-global-batch> \
  --max_length <validated-length> \
  --attention_backend unfused \
  --padding_free false \
  --language_model_only true \
  --merge_lora false \
  --output_dir <output-dir>
```

Start with a bounded smoke run that writes and reopens an adapter checkpoint.
Choose sequence length and checkpoint interval from current data, memory, link
behavior, and recovery requirements.

The observed two-node low-bandwidth profile was communication-bound: MoE token
dispatch dominated step time, longer sequences increased traffic, and a larger
micro-batch did not improve throughput. Treat those observations as sizing
evidence, not fixed timing estimates.

## Adapter-only export

Export must reconstruct the same model topology. Re-pass:

- `--tensor_model_parallel_size 2`;
- `--expert_tensor_parallel_size 2`;
- the same explicit `--target_modules` list;
- `--merge_lora false`.

In the validated exporter, PEFT injection still visited routed expert modules.
A version-scoped mcore-bridge patch returned an existing
`TEGroupedLinear` unchanged instead of attempting to wrap it:

```python
if isinstance(target_base_layer, TEGroupedLinear):
    return target
```

Apply this only when the installed dispatch path reproduces the same failure.
Returning `None` is not equivalent: it allows PEFT to continue to another
dispatcher. After patching, verify that no routed-expert adapter keys were
created and that all expected attention keys were exported.

Use [mcore-export-and-merge.md](mcore-export-and-merge.md) for checkpoint
visibility, `--adapters`, and adapter validation.

## Inference handoff

The validated vLLM 0.19.1 Kimi-VL implementation did not advertise dynamic
LoRA module mappings, so it was not a supported Kimi-VL LoRA backend.

The working fallback used the model-era-compatible Transformers 4.46.3 runtime
with `AutoModel(..., trust_remote_code=True)`, PEFT, and an optional
bitsandbytes 4-bit base. Keep the adapter dynamically attached:

```text
base model + PeftModel adapter
no merge_adapter()
no merge_and_unload()
```

Do not reuse the Transformers 5.12.1 generation path merely because it was
required by the training stack; that combination produced incorrect Kimi-VL
inference in the validated environment.

For an FP8 adapter, load its scale metadata through the producing format. If
the inference runtime cannot consume it directly, dequantize and save only the
adapter as BF16, then attach it dynamically. Do not merge low-precision LoRA
deltas into a BF16 base.

Validate quality with deterministic base-vs-adapter logits or the effective
`(alpha / rank) * B(A(x))` branch. Do not use a universal absolute
`lora_B` threshold or infer adapter quality from a broken inference runtime.
