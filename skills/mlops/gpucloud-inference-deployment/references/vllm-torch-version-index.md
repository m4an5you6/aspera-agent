# vLLM / Torch Version Index

Decision aid for `compat_chain` pins. Use as **floors and landmines**, not a
frozen “always install this triple” matrix. Tables go stale; **verify** with
registry + driver probe before pip.

Companion: `torch-cuda-version-drift.md` (why loose `vllm>=…` destroys cu124).

## Decision order (mandatory)

Do **not** start from “venv already has vllm 0.7.3 → reuse.” Wrong order caused
Qwen3.6 MoE deploys to stay on an unsupported engine.

1. **Arch first** — read `config.json` `architectures` + `model_type` (and
   `auto_map` if present). Map to a row in **Arch → min vLLM** below.
2. **Native support required for large MoE** — if the arch is absent from the
   *chosen* vLLM’s
   `vllm.model_executor.models.registry` (or logs say
   `has no vLLM implementation, falling back to Transformers`), that pin is
   **invalid** for serve plans. Transformers fallback + `--trust-remote-code`
   is **not** a substitute for native MoE (full-precision `nn.Linear` init,
   BnB often does not cut peak VRAM, LoRA/offload interactions break).
3. **Driver CUDA next** — `nvidia-smi` → CUDA capability (e.g. 12.4). Choose
   torch **cu tag** from **Driver → torch** below. Venv directory tag should
   match (e.g. `inference_venvs/cu124`).
4. **Intersect** — pick the **oldest vLLM that still meets the arch floor**
   *and* can keep torch on that cu tag (or a documented same-major cu tag the
   driver runs). Prefer exact `torch==…+cuXXX` then `vllm==…`.
5. **Prove before planned** — in the target venv python:
   - list/registry contains the HF architecture string, **or**
   - fail the pin and move to a newer vLLM floor (do not “hope” fallback works).
6. **Multi-node** — rank0 publishes the chosen exact pins in rationale;
   workers **copy the same pins**. Independent upgrades (worker→0.8.x while
   rank0 keeps 0.7.3) cause Ray/NCCL/ABI fights. Align `libnccl.so.2` via
   `strings` after install.
7. **Only then** `inference_ensure_runtime(planned)` → pip → smoke →
   `verified`.

`rejected_alternatives` must include at least one concrete reject, e.g.
“reuse vllm==0.7.3 — no Qwen3_5Moe registry entry” or
“vllm>=0.17 unpinned — may pull torch cu128 on this driver.”

## Arch → min vLLM (native)

Floors are **inclusive** minimums for *native* registry support. Newer patch
lines are OK if torch cu tag stays valid.

| HF `architectures` / `model_type` | Min vLLM (native) | Notes |
|-----------------------------------|-------------------|--------|
| `Qwen3_5MoeForConditionalGeneration` / `qwen3_5_moe` | **0.17.0** | Qwen3.6 MoE (e.g. 35B-A3B) reuses Qwen3.5 MoE arch — same row |
| `Qwen3_5ForConditionalGeneration` / `qwen3_5` | **0.17.0** | Dense Qwen3.5 / 3.6 family |
| `Qwen3MoeForCausalLM` / `qwen3_moe` | **0.8.0+** (verify) | Classic Qwen3 MoE — **not** the same as `qwen3_5_moe` |
| `Qwen2MoeForCausalLM` / `qwen2_moe` | **0.7.x** often OK | Still verify registry on the exact pin |
| GPT-2 / Llama-style older arches | often **0.7.x** | Prefer existing cu-matched venv if registry hit |

If `model_type` says `qwen3_5_moe` but the agent only searched for
`qwen3_moe.py`, that is a **miss** — check the `Qwen3_5*` names.

## Driver → torch cu tag

| `nvidia-smi` CUDA | Preferred torch wheel | Default venv tag | Reject without driver upgrade |
|-------------------|----------------------|------------------|-------------------------------|
| 12.4 | `torch==…+cu124` | `cu124` | Installing wheels that upgrade to **cu128/cu130** runtime |
| 12.1 / 12.2 | `+cu121` / matching | match tag | Mixing cu124 venv with cu121 torch |
| 12.8 | `+cu128` | `cu128` | Forcing ancient cu118 stacks |

Torch **first**, then vLLM. After any pip that can touch torch or
`nvidia-nccl-*`, re-run CUDA smoke and `strings` on `libnccl.so.2`.

## How to pick the exact vLLM pin (after floor + cu tag)

1. Start at **Arch min**.
2. Query mirror / PyPI for that version’s `requires_dist` (torch / xgrammar).
3. If deps force a torch cu tag the driver cannot run → try the next
   **newer** vLLM that documents a compatible torch, or fail
   `phase=ensure_runtime` with “arch needs vLLM≥X but driver CUDA Y cannot
   run required torch cuZ” — do **not** silently drop below the arch floor.
4. China mirrors: Aliyun → Tsinghua; record mirror in `pip_index`.
5. Landmine: some **0.8.0–0.8.2** releases pin `xgrammar==0.1.16`, which
   **never published** on PyPI (versions jump 0.1.13 → 0.1.17). Prefer a
   vLLM whose xgrammar pin exists on the mirror, or install that dep from a
   source that actually has it **before** resolving vLLM — do not burn turns
   walking 0.8.0→0.8.1→0.8.2 with the same missing pin.

## Anti-patterns (from real deploys)

| Anti-pattern | Why it fails |
|--------------|--------------|
| Reuse `vllm==0.7.3` because cu124 venv exists | Arch floor for Qwen3.6 MoE is 0.17+; 0.7.3 falls back and OOMs |
| Worker upgrades to 0.8.x alone; rank0 stays 0.7.3 | Stack skew; Ray/NCCL/ABI breakage |
| Treat Transformers fallback as “supported” | Peak VRAM ≈ full bf16 MoE init; BnB flags may be set but unused in init |
| `precision=bnb_4bit` as cure for unsupported arch | Does not create native kernels; may still OOM on fallback |
| Unpinned `vllm` / `vllm>=0.17` after cu124 torch | Resolver replaces torch with cu128/cu130 |
| Assume “0.8.x needs CUDA 12.8” without checking wheel | Some 0.8.x run on cu124 torch; still may lack `Qwen3_5*` — check registry |

## Multi-node pin contract

- One `compat_chain` pin set for the job; all ranks install the same
  `torch==` / `vllm==` / ray pin (when used).
- rank0 should state pins early in rationale; workers must not invent a
  higher vLLM “for arch” without the same planned chain on every rank.
- After align: NCCL smoke before `inference_start_vllm` (see
  `multinode-nccl-and-lib-drift.md`).

## Minimal verification snippet

```bash
PY="$HOME/.cache/gpu_platform/inference_venvs/cu124/bin/python"
# 1) driver
nvidia-smi --query-gpu=driver_version --format=csv,noheader
# 2) arch in this vLLM
"$PY" - <<'PY'
from vllm.model_executor.models import registry as R
arch = "Qwen3_5MoeForConditionalGeneration"
# adapt to the installed vLLM registry API
names = set(getattr(R, "_MODELS", {}) or {})
if not names and hasattr(R, "ModelRegistry"):
    try:
        names = set(R.ModelRegistry.get_supported_archs())
    except Exception:
        names = set()
print("HIT" if arch in names or any("Qwen3_5Moe" in str(x) for x in names) else "MISS", sorted(x for x in names if "Qwen3" in str(x))[:40])
PY
# 3) torch cu tag
"$PY" -c "import torch; print(torch.__version__, torch.version.cuda)"
```

If step 2 prints `MISS` for the assignment’s architecture, **change vLLM**,
do not proceed to serve on that pin.
