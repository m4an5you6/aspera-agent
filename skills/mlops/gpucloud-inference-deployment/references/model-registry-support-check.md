# Model registry support check (vLLM 0.19.1 + Megatron/mcore-bridge 1.6.1)

Question: "Is model X supported in our vLLM venv / ms-swift Megatron venv?"
Verified 2026-08 on the two-node RTX 3090 cluster (vllmvenv + swiftvenv).

## 0. Get the HF architecture first

```bash
curl -sL "https://hf-mirror.com/<owner>/<repo>/resolve/main/config.json" | \
  python3 -c "import sys,json; c=json.load(sys.stdin); print(c.get('model_type')); print(c.get('architectures')); print(c.get('auto_map'))"
```

- vLLM registers on `architectures[0]`; mcore-bridge registers on `model_type`.
- Thinking vs Instruct variants of the same model share the architecture —
  a registry hit covers both (weights/chat-template differ, registration does not).

## vLLM (vllmvenv, vLLM 0.19.1)

```bash
grep -n "<Arch>" ~/vllmvenv/lib/python3.10/site-packages/vllm/model_executor/models/registry.py
ls ~/vllmvenv/lib/python3.10/site-packages/vllm/model_executor/models/ | grep -i <vendor>
```

- Registry hit = native support (no `--trust-remote-code` fallback needed).

## Megatron (swiftvenv: ms-swift 4.4.2 + megatron-core 0.16.x + mcore-bridge 1.6.1)

```bash
ls ~/swiftvenv/lib/python3.10/site-packages/mcore_bridge/model/mm_gpts/          # per-arch bridge files
grep -n "<type>" ~/swiftvenv/lib/python3.10/site-packages/mcore_bridge/model/constant.py   # ModelType enum
grep -n "register_model\|ModelType" <mm_gpts>/<arch>.py                          # registration calls
grep -n "<type>" ~/swiftvenv/lib/python3.10/site-packages/mcore_bridge/config/parser.py     # special-arch branches
```

- One bridge file can register several ModelTypes (kimi_vl.py registers
  `kimi_vl` AND `kimi_k25`).
- Transformers builtin support is NOT required: bridges load `modeling_*.py`
  via `get_class_from_dynamic_module` from the HF repo (trust-remote-code
  style). transformers 5.12.1 has no `models/kimi_vl/` dir and kimi_vl trains
  fine.

## Kimi family status 2026-08 (all registered, no patches needed)

| Model | model_type | vLLM 0.19.1 | mcore-bridge 1.6.1 |
|---|---|---|---|
| Kimi-VL-A3B(-Thinking/-2506) | kimi_vl / KimiVLForConditionalGeneration | registry hit → kimi_vl.py | ModelType.kimi_vl → mm_gpts/kimi_vl.py |
| Kimi-K2.5 | kimi_k25 | kimi_k25.py + kimi_k25_vit.py | ModelType.kimi_k25 (same kimi_vl.py file) |
| Kimi-Linear-48B-A3B | KimiLinearForCausalLM | kimi_linear.py | — (48B linear-attn, MIT) |
| Kimi-Audio-7B | MoonshotKimiaForCausalLM | kimi_audio.py | qwen3_asr.py family? check before use |

- vLLM Kimi modules present: kimi_vl, kimi_k25, kimi_k25_vit, kimi_linear,
  kimi_audio, moonvit.
- mcore-bridge mm_gpts/ inventory: gemma4, glm, internvl, kimi_vl, llama4,
  llava, minicpmv4_6, qwen, qwen3_5, qwen3_5_gdn, qwen3_asr, qwen3_omni,
  qwen3_vl (+ utils.py).
- gemma4.py is the one that required manual patches in this cluster (see
  ms-swift-megatron-training skill) — everything else is stock.
