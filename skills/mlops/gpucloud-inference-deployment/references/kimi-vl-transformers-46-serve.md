# Kimi-VL / legacy trust_remote_code models: serve with transformers 4.x (verified 2026-08-07)

## TL;DR
Legacy modeling files shipped inside HF model repos (e.g. Kimi-VL-A3B-Thinking-2506
`modeling_kimi_vl.py`) were written for transformers 4.x. Under transformers 5.12.1
the model LOADS and even forwards, but logits are garbage (top-1 token is a
byte-garbage vocab id) for 4-bit, 8-bit AND full bf16 — i.e. NOT a quantization
problem. Fix: serve with transformers 4.46.x in a SEPARATE venv. Works out of the
box with 4-bit + PEFT LoRA, ◁think▷ markers preserved.

## Symptom / diagnostic trail
- 4-bit generate → degenerate loops ("bonds are bonds are bonds...", "◁◁en▵◁ you
  helpful a helpful"), identical with use_cache True/False (cache is NOT the issue).
- Manual forward (no generate): logits finite, std ~1.9 (looks sane) but top-5
  tokens are garbage ('âĹ', '<<', 'âĸ') — the forward itself is wrong.
- bf16 CPU forward (no quantization): SAME garbage top-1 → rules out quantization
  definitively. This is the decisive experiment — run it early.
- Same weights via vLLM TP=2: perfectly normal → weights/config fine; it is the
  transformers-version × modeling-file mismatch.

## Why we don't patch 5.x instead
Ten API incompatibilities were patched (list in `kimi-vl-transformers5-generate-compat.md`:
is_torch_fx_available removed, rope_scaling rope_type vs ['type'], tie_weights
recompute_mapping kwarg, _supports_sdpa class attrs, seen_tokens, get_usable_length,
from_legacy_cache, get_seq_length(layer_idx=0) default trap, decode-time full-range
position_ids, _prepare_4d_causal_attention_mask sizing) — yet bf16 logits stayed
garbage. The eager MLA path in 5.x is fundamentally incompatible with this modeling
file. Switch transformers version; do not keep patching.

## Working recipe (transformers 4.46 venv)
```
uv venv ~/kimivl_infer_venv --python 3.10
uv pip install --python ~/kimivl_infer_venv/bin/python -i https://pypi.tuna.tsinghua.edu.cn/simple \
  torch==2.6.0 torchvision==0.21.0 transformers==4.46.3 peft bitsandbytes==0.45.4 \
  accelerate fastapi uvicorn tiktoken
```
- uv venv has NO pip binary — always `uv pip install --python <venv>/bin/python`.
- `tiktoken` is REQUIRED: the dynamic-module import check (`check_imports`) refuses
  to load modeling_kimi_vl.py without it (`ImportError: This modeling file requires
  ... tiktoken`).
- 4-bit load ≈ 220-280s on 3090; generation ≈ 8-11s per 64 tokens; ~8GB VRAM.
- PeftModel loads the `megatron export --to_hf --merge_lora false` adapter directly
  (HF-named keys: q_proj, kv_a_proj_with_mqa, kv_b_proj, o_proj × 27 layers).
- LoRA effect is visible: with adapter, "bond vs stock" answers in direct
  definition style; base-only falls back to ◁think▷ loops.

## Serve pattern
`templates/serve_kimivl_lora.py` — run with the 4.46 venv python:
`tmux new-session -d -s tfsrv '/home/ubuntu/kimivl_infer_venv/bin/python serve_kimivl_lora.py --port 8000 > ~/tfsrv.log 2>&1'`
- ALWAYS redirect stdout to a file: tmux pane output dies with the machine (verified 2026-08-10 — the 08-07 tfsrv serve's stdout vanished on reboot; only session-DB health/curl records and bf16_ref.log survived). Without the redirect, "did it run" questions later can only be answered from the session DB.
- Load with `AutoModel.from_pretrained(..., trust_remote_code=True)` — NOT
  `AutoModelForImageTextToText` (kimi_vl config is not registered in that Auto
  class: "Unrecognized configuration class ... for this kind of AutoModel").
- The model dir ships `chat_template.jinja` → `tok.apply_chat_template(messages,
  tokenize=False, add_generation_prompt=True)` works.
- Verify with stdout to a FILE: `python serve_kimivl_lora.py --verify > verify.log 2>&1; echo EXIT=$? >> verify.log`
  (a `timeout` kill = 124; bare pipe greps can lose output).

## vLLM side (for contrast)
vLLM 0.19.1 registers kimi_vl natively (TP=2 serve verified) but has NO LoRA
support for it (no supported_lora_modules/packed_modules_mapping; same for
deepseek_v2/v3 MLA). To serve a finetuned kimi_vl: transformers 4.46 (this file),
or merge LoRA into full weights and serve bf16 TP=2 (needs ~31GB/disk per node).
