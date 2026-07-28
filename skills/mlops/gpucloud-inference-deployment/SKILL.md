---
name: gpucloud-inference-deployment
description: Deploy inference via on-node agent until vLLM is ready.
version: 2.5.2
author: GPUCLOUD
platforms: [linux]
metadata:
  gpucloud:
    tags: [gpucloud, inference, deployment, vllm, cluster, model-adapter, nccl]
    related_skills: [gpucloud-worker-setup, gpucloud-sft-training, gpucloud-megatron-weight-export, serving-llms-vllm]
    triggers:
      - deploy trained model
      - vllm from training
      - gpucloud inference deployment
      - adapter_id hf_vllm
      - nccl unhandled cuda error
---

# GPUCLOUD Inference Deployment

Use when a cluster inference assignment must expose a trained model through
vLLM on **this GPU node**. An on-node LLM agent owns deps, artifacts, start,
and health until ready (not a fixed pin matrix). You choose exact pins; tools
enforce a full compatibility-chain decision before install and before serve.

## When to Use

- Cluster worker received `job_kind=inference` and you are the deploy agent.
- Platform called `POST /api/inference/agent/deploy` and bootstrap already
  started `gpucloud gateway` on this host.

## Prerequisites

- `model.api_key` in `~/.gpucloud/config.yaml` (agent LLM).
- Tools: `terminal`, file tools, `inference_ensure_runtime`,
  `inference_start_vllm`, `inference_health`, `inference_report_ready`;
  multi-node also `inference_ray_start`, `inference_ray_join`,
  `inference_cluster_wait_workers`.
- Assignment JSON includes `model.local_path`, `gpus`, `serve`, optional
  `sources`, `model_hint`, `training_artifact_kind`, and for multi-node
  `node_rank` / `nnodes` / `local_visible_devices` / `ray`.
- Read before install: `references/vllm-runtime-and-model-readiness.md` and
  `references/torch-cuda-version-drift.md`.
- Multi-node TP: also read `references/multinode-nccl-and-lib-drift.md`.

## How to Run

Work until ready, then call `inference_report_ready`.

## Quick Reference

| Step | Action |
|------|--------|
| Probe | In the inference **venv** (not system `python3`): `nvidia-smi` + model family |
| Compat chain | **Before any torch/vLLM pip**: write full chain → `inference_ensure_runtime` (`planned`) |
| Install | Exact `==` pins into that venv via **pip mirrors** (torch before vllm) |
| Verify | CUDA smoke in venv → `inference_ensure_runtime` (`verified`) |
| Artifacts | Ensure HF-loadable dir; sync via `sources[]` if missing |
| Multi-node align | Same torch/vLLM/**libnccl** on all ranks (`strings` on `.so`, not only `pip show`) |
| NCCL smoke | Gloo then NCCL allreduce across ranks **before** vLLM TP>1 |
| Multi-node | rank0: ray head → wait workers → vLLM TP=global + ray; worker: ray join → `worker_ready` |
| Serve | `inference_start_vllm` with that venv's `python_executable` (rank0 only when nnodes>1) |
| Done | rank0: `phase=ready` + reachable visit_host; worker: `phase=worker_ready` |

## Runtime home

Do all env checks and installs in the inference venv — system `python3` /
bare `pip` are not the source of truth.

1. Prefer `$INFERENCE_PYTHON` / `$VLLM_PYTHON` when set.
2. Else use (or create) `~/.cache/gpu_platform/inference_venvs/<tag>/`
   (e.g. `cu124`) — probe `bin/python`, install with `bin/pip`.
3. Pass the chosen `bin/python` as `python_executable` to
   `inference_ensure_runtime`, `inference_start_vllm`, and Ray tools.

Details: `references/vllm-runtime-and-model-readiness.md`.

## Compatibility chain (mandatory)

**Any torch/vLLM pip install is forbidden until** you have called
`inference_ensure_runtime` with `status=planned` and a complete
`compat_chain`. **Ray / `inference_start_vllm` refuse** until a second call
with `status=verified` (after pip + CUDA smoke) for the same `job_id`.

Required `compat_chain` fields (align with the tool schema):

| Field | Meaning |
|-------|---------|
| `driver` | `nvidia_smi_cuda` / `driver_version` from probe |
| `model_family` | e.g. qwen3.6_moe from config / hint |
| `venv_python` | Absolute path under `inference_venvs` |
| `pins` | Exact `pkg==version` for **torch** and **vllm** (optional transformers/ray). Reject `>=`, bare names |
| `install_order` | Ordered list; torch before vllm |
| `pip_index` | China mirror URL (Aliyun preferred, else Tsinghua). Not official PyPI by default |
| `pip_extra_index` | Optional; PyTorch CUDA wheel index only when needed |
| `rationale` | Short narrative: driver CUDA → torch cu tag → vllm pin → why not latest; mirror choice |
| `rejected_alternatives` | ≥1 concrete reject (e.g. `vllm>=0.8.0` pulls torch cu130) |
| `smoke_cmd` | One-liner CUDA smoke planned after install |

Flow: probe → write chain → `ensure_runtime(planned)` → pip exact pins with
`-i <pip_index> --trusted-host …` → smoke → `ensure_runtime(verified)` →
Ray/serve.

## Multi-node Ray TP

When `nnodes > 1` (assignment has `ray.enabled` and global
`gpus.tensor_parallel` = total GPUs):

- Use **local** `local_visible_devices` / `gpus.visible_devices` for this node only.
- **Align stacks across ranks** before Ray/serve: same exact torch/vLLM pins
  and the same `libnccl.so.2` version string (see
  `references/multinode-nccl-and-lib-drift.md`). `pip show nvidia-nccl-cu12`
  can lie after a cu130 drift — verify with `strings` on the `.so`.
- **NCCL smoke before vLLM**: prove cross-node Gloo, then NCCL CUDA allreduce.
  If NCCL fails with `driver … insufficient` / `unhandled cuda error` while
  ping/SSH/Ray/`gloo` work, fix `libnccl` on every rank — do **not** keep
  restarting `inference_start_vllm`, and do **not** degrade to single-node TP.
- Put `NCCL_*` / `GLOO_SOCKET_IFNAME` into the **ray worker process** env
  (`ray start` / `ray join`), not only the API server shell.
- **rank>0**: compat chain verified → `inference_ray_join` to
  `$GPUCLOUD_CLUSTER_ADVERTISED_ADDR` of head or master addr + `ray.head_port`
  → `inference_report_ready` with `phase=worker_ready` (no API server).
- **rank0**: compat chain verified → `inference_ray_start` →
  `inference_cluster_wait_workers` (must succeed; use `http://…` master URL) →
  NCCL smoke OK → `inference_start_vllm` with global TP + `ray.enabled` →
  health → `phase=ready` with reachable `visit_host`. Never start two
  independent TP=1 servers.
- **If NCCL smoke fails** after aligning `libnccl` / worker env: stop
  restarting `inference_start_vllm` in a loop; fix the stack (same
  `libnccl.so.2` + process-env on every rank) or fail `phase=start` with the
  NCCL/`libnccl` diagnostic. Do **not** silently switch the assignment to
  single-node TP=1.

## Procedure

1. **Inspect environment** with `terminal`: `nvidia-smi`, then the venv
   python above — `"$PY" -c "import torch,vllm"` (may fail — that is OK;
   install only into this venv if needed).
2. **Identify model family** from `model.local_path` (`config.json`
   `model_type` / `architectures`), directory name, and optional
   `model_hint` / `training_artifact_kind` (e.g. gpt2, qwen2.5, qwen3,
   megatron export). Newer Qwen often needs newer vLLM than GPT-2.
3. **Compat chain** — read `references/torch-cuda-version-drift.md`, choose
   exact pins, call `inference_ensure_runtime` (`planned`). Do **not** skip
   this before pip.
4. **Install stack** (only if the venv lacks a usable torch/vLLM): follow
   `install_order` with exact `==` pins from the chain. **Never** use
   `vllm>=…` or unpinned `vllm` after torch is pinned — that is the drift
   failure mode. For `nnodes>1` also pin/install `ray` into the same venv.
   **Default pip index is a China mirror** (not official PyPI):
   1. Aliyun: `https://mirrors.aliyun.com/pypi/simple/`
      (`--trusted-host mirrors.aliyun.com`)
   2. Tsinghua: `https://pypi.tuna.tsinghua.edu.cn/simple`
      (`--trusted-host pypi.tuna.tsinghua.edu.cn`)
   3. Only if both fail: document `mirrors failed` in rationale and
      re-`ensure_runtime`, then official PyPI / config index.
   Torch CUDA wheels may add `--extra-index-url https://download.pytorch.org/whl/cuXXX`
   — that does **not** replace the main mirror for vLLM.
   Example:
   ```bash
   PIP="$HOME/.cache/gpu_platform/inference_venvs/<tag>/bin/pip"
   $PIP install "torch==2.5.1+cu124" \
     -i https://mirrors.aliyun.com/pypi/simple/ \
     --trusted-host mirrors.aliyun.com \
     --extra-index-url https://download.pytorch.org/whl/cu124
   $PIP install "vllm==<exact-pin>" \
     -i https://mirrors.aliyun.com/pypi/simple/ \
     --trusted-host mirrors.aliyun.com
   ```
   Avoid `| tail` on long installs; use `terminal(background=true)` and poll.
5. **Verify**: run `smoke_cmd` in the venv, then
   `inference_ensure_runtime` with `status=verified` (same chain / pins).
6. **Artifacts**: if `local_path` missing or not HF-loadable (`config.json` +
   weights), sync via `sources[]`. For `megatron_checkpoints` /
   `swift_output` / `.distcp`, follow `gpucloud-megatron-weight-export`.
   - **Qwen LoRA / `swift_output`**: endpoint is `hf_lora_*/` adapters, **not**
     a full-weight `merged_model`. Prefer SWIFT `--merge_lora false`.
   - If `{job_dir}/hf_lora_*/` already has `adapter_config.json` +
     `adapter_model.safetensors`, **skip export/merge**; serve base HF from
     `args.json` with `adapter_options.enable_lora=true` and
     `max_lora_rank` ≥ training rank.
   - **HARD**: never hand-merge LoRA into base safetensors for MoE; if SWIFT
     fails on MoE → `phase=ensure_artifacts` (do not invent `merge_step*.py`).
   Hand-rolled `load_distcp` only as last resort for **non-MoE**. If still
   impossible, fail with `phase=ensure_artifacts`.
7. **Start**: single-node — `inference_start_vllm` with local devices.
   Multi-node — follow **Multi-node Ray TP** (align `libnccl`, NCCL smoke,
   then rank0 waits for workers and starts TP). Pass
   `--trust-remote-code` for custom Qwen configs when required.
   For LoRA: `model.local_path` / serve path = **base HF**; set
   `adapter_options.enable_lora` (+ `max_lora_rank`); load the adapter via
   vLLM LoRA (do not replace base with a merged tree).
8. **Health**: poll `inference_health` until `ready` (or timeout →
   `phase=health_timeout`). Local `curl http://127.0.0.1:<port>/health` is
   fine for probing only (rank0).
9. **Report**: `inference_report_ready` with success contract (see below).
   **`visit_host` must be a client-reachable address**, not loopback (rank0).
   Prefer in order: `$GPUCLOUD_CLUSTER_ADVERTISED_ADDR` → node public /
   outer IP (e.g. `gpu_nodes.host` / `hostname -I` non-private) →
   cluster `advertised_addr`. Never copy `127.0.0.1` / `localhost` from
   `inference_start_vllm` into the outcome — that tool may return loopback
   for local health even when serve binds `0.0.0.0`.

## Outcome contract

```json
{
  "success": true,
  "summary": "inference ready",
  "details": {
    "phase": "ready",
    "adapter_id": "hf_vllm",
    "visit_host": "<advertised host>",
    "visit_port": 8000,
    "protocol": "http://",
    "stream_path": "/v1/chat/completions",
    "health_path": "/health",
    "deploy_node_id": 20,
    "callback_url": "",
    "model_path": "/path/to/model"
  }
}
```

Failure: `success=false`, `details.phase` in
`ensure_runtime|ensure_artifacts|start|health_timeout|cancelled|validate`.

## Pitfalls

- Fixed pin matrices cannot cover all model families — decide from evidence,
  but always record the decision via `inference_ensure_runtime`.
- Do not treat a failed system `python3 -c "import vllm"` as “no vLLM”;
  check the inference venv first.
- Bare `pip` / `~/.local` installs miss the serve interpreter — always use
  the venv `bin/pip`.
- Bare `pip install vllm` without `-i` mirror is a common stall; use Aliyun
  then Tsinghua before falling back.
- `vllm>=…` after a cu124 torch pin can upgrade torch **and** replace
  `libnccl.so.2` with a cuda13 build — see
  `references/torch-cuda-version-drift.md` and
  `references/multinode-nccl-and-lib-drift.md`.
- Multi-node: Ray/SSH OK + NCCL fail usually means **`libnccl` / driver
  mismatch**, not “no connectivity.” Check `strings` on both nodes.
- Multi-node: never run independent TP=1 API servers on each node; rank0 must
  wait for `worker_ready` before `phase=ready`.
- Disk space under `~/.cache/pip` / `/tmp/pip-unpack-*` can fill during large
  wheels — clean failed partial downloads when retrying.
- Never put API keys in the outcome JSON.
- Never report `visit_host=127.0.0.1` / `localhost` — platforms store that
  as the client endpoint; use the advertised / public host instead.
- Prefer managed start tool so cluster stop can kill the serve PID.
- Megatron / `swift_output` raw checkpoints need
  `gpucloud-megatron-weight-export` before serve.
- Qwen LoRA: existing `hf_lora_*` → reuse; never build `merged_model/`.

## Verification

- `inference_ensure_runtime` reached `status=verified` for this `job_id`
- Chosen venv `python` imports torch + vLLM; CUDA smoke prints `CUDA_OK`
- Multi-node: `strings` on `libnccl.so.2` matches across ranks; NCCL smoke OK
- `inference_health` → `ready`
- `curl -sS http://127.0.0.1:<port>/health` succeeds (local probe only)
- `inference_report_ready` `visit_host` is reachable from outside the node
  (not `127.0.0.1`)
- `inference_report_ready` returned `stored: true`
