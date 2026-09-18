# Kimi-VL (kimi_vl) transformers 5.12.1 generate-path attention-mask bug

Found 2026-08-07 while verifying the finetuned Kimi-VL-A3B-Thinking-2506 LoRA
(export_66) via transformers 5.12.1 4-bit + PEFT (`serve_kimivl_lora.py
--verify`). The training-path patches for this model (documented in
ms-swift-megatron-training `references/kimivl-megatron-training.md`) do NOT
cover this: it is in the INFERENCE / generate path.

## Symptom

Model loads fine (base 4-bit ~271s, adapter OK), first prefill OK, then
generate() crashes at the 2nd decode step:

```
ValueError: Attention mask should be of size (1, 1, 1, 28), but is torch.Size([1, 1, 1, 27])
```

raised in `DeepseekV3Attention.forward` (modeling_kimi_vl.py ~line 1428, the
eager-attention shape assertion `attention_mask.size() != (bsz, 1, q_len, kv_seq_len)`).
A `[DBG-ROPE] q_len=1 kv_seq_len=28 position_ids.shape=(1, 28)` debug line
(already present in the cached file from earlier training-patch work) shows the
context: q_len=1 (decode), kv_seq_len=28 (= 27 past + 1 new token), so the
4D mask's key dim is short by exactly the just-appended token.

## Root cause (transformers 5.12.1 `modeling_attn_mask_utils.py`, source-verified)

The chain in `DeepseekV3Model.forward`:

```python
attention_mask = _prepare_4d_causal_attention_mask(
    attention_mask, (batch_size, seq_length), inputs_embeds, past_key_values_length)
```

Inside `_prepare_4d_causal_attention_mask` (5.12.1), when the incoming
attention_mask is a **2D** mask, it routes to `AttentionMaskConverter.to_4d`,
which builds:

```python
expanded_attn_mask = self._expand_mask(attention_mask_2d, dtype, tgt_len=input_shape[-1])
```

- `tgt_len` is the **QUERY length** (1 at a decode step).
- `_expand_mask` derives the key dim from the 2D mask's **own column count**,
  NOT from the `key_value_length` argument the helper was given
  (`key_value_length = seq_length + past_key_values_length` is computed but
  only used for the causal branch).
- The causal branch (`_make_causal_mask`) is skipped entirely when
  `query_length == 1` (`if (input_shape[-1] > 1 or sliding_window) and
  is_causal` in `to_4d`).

Net: with a 2D mask present, the 4D mask's key dim == the 2D mask's column
count. If the generate loop hands the model a 2D mask that is NOT padded with
the new token (stale mask of the prefill length), the 4D mask comes out short
by exactly the missing columns. (transformers <5 generate loops concatenated
the new token's 1s onto the 2D mask every step; on 5.12.1 + this remote-code
forward the mask can lag one step.)

## Isolation test (one model load, three forwards)

Write a manual prefill+decode script instead of guessing:
1. prefill with (1,27) 2D mask + `use_cache=True` → expect OK.
2. decode with **extended** mask `cat(mask27, ones(1,1))` = (1,28) → if OK, the
   model forward is sound when handed a correct mask.
3. decode with the **stale** (1,27) mask → reproduces the crash.

Result split tells you where the bug lives: (2) OK + (3) fails = generate is
passing a stale 2D mask (model-side padding fix is still the right fix);
both fail = deeper forward problem. Pattern:
`/home/ubuntu/remote_work/test_mask.py` (also prints cache_len after each step).

Debug injection: add `print(f'[DBG-MASK] in2d={...} seq={seq_length}
past={past_key_values_length}')` right before the
`_prepare_4d_causal_attention_mask` call in the cached file, delete
`__pycache__` under that dir, rerun — confirms exactly what 2D mask + past
length reach the converter.

## Fix (APPLIED model-side — fixes every caller, not just generate)

Patch goes in the **model-dir source file**
`~/models/Kimi-VL-A3B-Thinking-2506/modeling_kimi_vl.py`
(`DeepseekV3Model.forward`), NOT the cache (see cache gotchas below).
Applied 2026-08-07: replace the `_prepare_4d_causal_attention_mask` call in
the non-flash `else` branch with a manual 4D causal mask whose kv dim is
always `seq_length + past_key_values_length`:

```python
else:
    # 4d mask is passed through the layers
    # transformers 5.x _prepare_4d_causal_attention_mask sizes the mask
    # from the 2D mask width instead of key_value_length; build it here
    # (legacy 4.x logic) so the mask always covers seq + past.
    bsz = batch_size
    q_len = seq_length
    kv_len = q_len + past_key_values_length
    causal_mask = torch.full(
        (bsz, 1, q_len, kv_len),
        torch.finfo(inputs_embeds.dtype).min,
        device=inputs_embeds.device,
    )
    rows = torch.arange(q_len, device=inputs_embeds.device).unsqueeze(1)
    cols = torch.arange(kv_len, device=inputs_embeds.device).unsqueeze(0)
    causal_mask[..., :, :] = torch.where(
        cols <= (rows + past_key_values_length),
        torch.zeros((), dtype=inputs_embeds.dtype, device=inputs_embeds.device),
        causal_mask,
    )
    if attention_mask is not None and attention_mask.dim() == 2:
        am = attention_mask.to(inputs_embeds.dtype)  # [bsz, kv_len]
        if am.shape[1] < kv_len:
            pad = torch.ones(
                (bsz, kv_len - am.shape[1]),
                dtype=am.dtype, device=am.device,
            )
            am = torch.cat([pad, am], dim=1)  # left-pad: causal mask already gates
        am = am.unsqueeze(1).unsqueeze(2)  # [bsz,1,1,kv_len]
        causal_mask = causal_mask.masked_fill(am == 0.0, torch.finfo(inputs_embeds.dtype).min)
    attention_mask = causal_mask
```

(Pads on the LEFT because the causal half already gates future positions;
a minimal right-pad variant that keeps `_prepare_4d_causal_attention_mask`
also works but was superseded by this.)

STATUS: RESOLVED 2026-08-07 (afternoon). Isolation test ran and split
decisively — prefill OK, decode with EXTENDED mask (1,28) OK, decode with
STALE mask (1,27) failed → the forward is sound, generate feeds a stale 2D
mask. The applied fix above was confirmed present in the model-dir source
and an end-to-end `--verify` re-run was launched (still generating at
session close).

## Cache mechanics gotchas (bit us during this debug)

- The remote-code cache is
  `~/.cache/huggingface/modules/transformers_modules/Kimi_hyphen_VL_hyphen_A3B_hyphen_Thinking_hyphen_2506/<hash>/modeling_kimi_vl.py`.
  **It is regenerated from the model-dir source file on load** — the
  `<hash>` directory changes between loads (observed 9bc941b4dac64c33 →
  fd350487943a9dfc, later a fresh set of dirs) and **edits to the cached
  file silently vanish**. THE PATCH GOES IN THE MODEL DIR
  (`~/models/Kimi-VL-A3B-Thinking-2506/modeling_kimi_vl.py`); then clear the
  whole `transformers_modules/` tree (or at least the hash dir + its
  `__pycache__`) before verify/serve so the new code is re-imported.
- Never hardcode the hash; locate with
  `find ~/.cache/huggingface/modules -name modeling_kimi_vl.py`.
- The cached file may carry debug prints from earlier sessions' patch work
  (`[DBG-ROPE]`, `[DBG-MASK]` were there) — the model-dir source should be
  kept clean of them.
- Multiple hash dirs accumulating under `transformers_modules/` = repeated
  regenerations from source edits; a concurrent session actively patching +
  relaunching will churn these — re-stat before assuming which file is live.
