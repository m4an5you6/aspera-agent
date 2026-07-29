# vLLM / Torch Version Index

Decision aid for `compat_chain` pins. Use as **floors and landmines**, not a
frozen “always install this triple” matrix. Tables go stale; **verify** with
registry + driver probe + **CUDA smoke** before declaring a pin dead.

Companion: `torch-cuda-version-drift.md` (accidental cu-tag drift vs intentional
upgrade when arch forces a newer torch).

## Decision order (mandatory)

Do **not** start from “venv already has vllm 0.7.3 → reuse.” Wrong order caused
Qwen3.6 MoE deploys to stay on an unsupported engine.

1. **Arch first** — read `config.json` `architectures` + `model_type` (and
   `auto_map` if present). For multimodal / nested configs also read
   `text_config.model_type` and `text_config.num_experts` (top-level
   `num_experts` may be missing even when the model is MoE). Map to a row in
   **Arch → min vLLM** below.
2. **Native support required for large MoE** — if the arch is absent from the
   *chosen* vLLM’s
   `vllm.model_executor.models.registry` (or logs say
   `has no vLLM implementation, falling back to Transformers`), that pin is
   **invalid** for serve plans. Transformers fallback + `--trust-remote-code`
   is **not** a substitute for native MoE (full-precision `nn.Linear` init,
   BnB often does not cut peak VRAM, LoRA/offload interactions break).
3. **Driver CUDA next** — `nvidia-smi` → reported CUDA capability (e.g. 12.4)
   and `driver_version`. Choose a **preferred** torch cu tag from
   **Driver → torch** below. That preferred tag is the default when the arch
   floor can keep torch there.
4. **Intersect (arch wins over “prefer same cu tag”)** — pick the **oldest
   vLLM that still meets the arch floor**. Read that release’s
   `requires_dist` / docs for the **required torch**.
   - If required torch stays on the preferred cu tag → plan that pair in the
     matching venv (e.g. `inference_venvs/cu124`).
   - If required torch is a **newer cu tag** (e.g. vLLM ≥0.17 needs
     `torch==2.10.0` on **cu126/cu128**) → **intentionally** plan that newer
     cu tag in a **dedicated** venv (e.g. `inference_venvs/cu128`), pin exact
     `torch==…+cuXXX` **first**, then matching `vllm==…`. Do **not** keep
     cu124 torch and `--no-deps` install a vLLM built for torch 2.10 (ABI
     break). Do **not** pre-BLOCK solely because `nvidia-smi` still prints
     CUDA 12.4 — that line is driver *capability advertising*, not a proof
     that every 12.x user-mode wheel fails.
5. **Prove before planned/verified** — in the target venv python:
   - CUDA smoke must succeed after torch install (see smoke below).
   - Registry contains the HF architecture string, **or** fail the pin and
     move to a newer vLLM floor (do not “hope” fallback works).
6. **Multi-node** — rank0 publishes the chosen exact pins in rationale;
   workers **copy the same pins** (same cu tag / same venv tag). Independent
   upgrades cause Ray/NCCL/ABI fights. Align `libnccl.so.2` via `strings`
   after install.
7. **Only then** `inference_ensure_runtime(planned)` → pip → smoke →
   `verified`.

`rejected_alternatives` must include at least one concrete reject, e.g.
“reuse vllm==0.7.3 — no Qwen3_5Moe registry entry” or
“vllm==0.17.0 --no-deps on torch 2.5.1+cu124 — ABI mismatch”.

## Arch → min vLLM (native)

Floors are **inclusive** minimums for *native* registry support. Newer patch
lines are OK if torch cu tag matches that release’s requirement **and** CUDA
smoke passes.

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

| `nvidia-smi` CUDA | Preferred torch (when arch allows) | Default venv tag | When arch needs newer torch / cu tag |
|-------------------|------------------------------------|------------------|--------------------------------------|
| 12.4 | `torch==…+cu124` | `cu124` | **Try** dedicated `cu126`/`cu128` venv + exact `torch==2.10.0+cuXXX` then matching vLLM; **prove with smoke**. Do not forbid a priori |
| 12.1 / 12.2 | `+cu121` / matching | match tag | Same rule: intentional upgrade only when arch floor requires it |
| 12.8 | `+cu128` | `cu128` | Prefer cu128; avoid forcing ancient cu118 stacks |

### CUDA 12.x minor compatibility (do not over-claim)

- CUDA **12.x** minor-version compatibility baselines are around driver
  **≥525** on Linux. A **550.x** driver advertising CUDA **12.4** is still
  inside that major-family window; a **cu128** user-mode wheel is **not**
  automatically illegal.
- Full CUDA Toolkit **12.8** docs still list a higher *recommended* minimum
  (e.g. **≥570**). Treat that as **risk**, not as a hard reject without a
  runtime error.
- **Only** treat driver/runtime as the hard fail after smoke or serve logs
  show concrete errors, e.g. `cudaErrorCallRequiresNewerDriver`,
  `CUDA driver version is insufficient`, `unsupported PTX version`, or
  equivalent. Then `phase=ensure_runtime` may cite those strings and suggest
  a driver upgrade.
- Never write “driver cannot run CUDA 12.8” solely from the skill table or
  from an ABI error caused by mixing vLLM 0.17 with torch 2.5.1.

Torch **first**, then vLLM. After any pip that can touch torch or
`nvidia-nccl-*`, re-run CUDA smoke and `strings` on `libnccl.so.2`.

## How to pick the exact vLLM pin (after floor + cu tag)

1. Start at **Arch min**.
2. Query mirror / PyPI for that version’s `requires_dist` (torch / xgrammar).
3. If deps require a newer torch cu tag than the preferred driver match:
   - Plan **intentional** upgrade (new venv tag + exact torch pin +
     `--extra-index-url https://download.pytorch.org/whl/cuXXX`).
   - Install torch → CUDA smoke → vLLM → registry HIT.
   - If smoke fails with a real driver/PTX error → report that error text;
     options: driver upgrade, or (only if product allows) non-vLLM path.
   - Do **not** silently drop below the arch floor.
   - Do **not** `--no-deps` a newer vLLM onto an old torch.
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
| Unpinned `vllm` / `vllm>=0.17` after cu124 torch | Accidental resolver replace of torch (drift) — pin both exactly |
| `vllm==0.17` with `--no-deps` on torch 2.5.1+cu124 | `_C.abi3.so` undefined symbol — ABI, not “prove driver bad” |
| Pre-BLOCK “550 cannot run cu128” without smoke | Over-claim; try intentional cu128 + smoke first |
| Assume “0.8.x needs CUDA 12.8” without checking wheel | Some 0.8.x run on cu124 torch; still may lack `Qwen3_5*` — check registry |

## Multi-node pin contract

- One `compat_chain` pin set for the job; all ranks install the same
  `torch==` / `vllm==` / ray pin (when used) into the **same cu-tag venv**.
- rank0 should state pins early in rationale; workers must not invent a
  higher vLLM “for arch” without the same planned chain on every rank.
- After align: NCCL smoke before `inference_start_vllm` (see
  `multinode-nccl-and-lib-drift.md`).

## Minimal verification snippet

```bash
# Prefer the venv that matches the planned cu tag (cu124 or cu128)
PY="$HOME/.cache/gpu_platform/inference_venvs/cu128/bin/python"
# 1) driver
nvidia-smi --query-gpu=driver_version --format=csv,noheader
nvidia-smi | head -3
# 2) CUDA smoke (required after torch install / before verified)
"$PY" - <<'PY'
import torch
print("torch", torch.__version__, "compiled_cuda", torch.version.cuda)
print("cuda_available", torch.cuda.is_available())
assert torch.cuda.is_available(), "CUDA not available"
x = torch.zeros(1, device="cuda")
print("alloc_ok", float(x))
print("GPU", torch.cuda.get_device_name(0), "cap", torch.cuda.get_device_capability(0))
PY
# 3) arch in this vLLM
"$PY" - <<'PY'
from vllm.model_executor.models import registry as R
arch = "Qwen3_5MoeForConditionalGeneration"
names = set(getattr(R, "_MODELS", {}) or {})
if not names and hasattr(R, "ModelRegistry"):
    try:
        names = set(R.ModelRegistry.get_supported_archs())
    except Exception:
        names = set()
print("HIT" if arch in names or any("Qwen3_5Moe" in str(x) for x in names) else "MISS", sorted(x for x in names if "Qwen3" in str(x))[:40])
PY
```

If step 2 fails with a driver/PTX insufficient error, cite that log in
`inference_report_ready`. If step 3 prints `MISS` for the assignment’s
architecture, **change vLLM**, do not proceed to serve on that pin.
