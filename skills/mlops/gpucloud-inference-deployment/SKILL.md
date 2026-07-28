---
name: gpucloud-inference-deployment
description: Deploy inference via on-node agent until vLLM is ready.
version: 2.3.0
author: GPUCLOUD
platforms: [linux]
metadata:
  gpucloud:
    tags: [gpucloud, inference, deployment, vllm, cluster, model-adapter]
    related_skills: [gpucloud-worker-setup, gpucloud-sft-training, gpucloud-megatron-weight-export, serving-llms-vllm]
    triggers:
      - deploy trained model
      - vllm from training
      - gpucloud inference deployment
      - adapter_id hf_vllm
---

# GPUCLOUD Inference Deployment

Use when a cluster inference assignment must expose a trained model through
vLLM on **this GPU node**. An on-node LLM agent owns deps, artifacts, start,
and health until ready (not a fixed pin matrix).

## When to Use

- Cluster worker received `job_kind=inference` and you are the deploy agent.
- Platform called `POST /api/inference/agent/deploy` and bootstrap already
  started `gpucloud gateway` on this host.

## Prerequisites

- `model.api_key` in `~/.gpucloud/config.yaml` (agent LLM).
- Tools: `terminal`, file tools, `inference_start_vllm`, `inference_health`,
  `inference_report_ready`; multi-node also `inference_ray_start`,
  `inference_ray_join`, `inference_cluster_wait_workers`.
- Assignment JSON includes `model.local_path`, `gpus`, `serve`, optional
  `sources`, `model_hint`, `training_artifact_kind`, and for multi-node
  `node_rank` / `nnodes` / `local_visible_devices` / `ray`.

## How to Run

Work until ready, then call `inference_report_ready`.

## Quick Reference

| Step | Action |
|------|--------|
| Probe | In the inference **venv** (not system `python3`): torch/vLLM(+ray) + `nvidia-smi` |
| Model family | Read `config.json` / tokenizer / path; honor `model_hint` |
| Install | Into that same venv via **pip mirrors first** (see below) |
| Artifacts | Ensure HF-loadable dir; sync via `sources[]` if missing |
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
   `inference_start_vllm` / Ray tools.

Details: `references/vllm-runtime-and-model-readiness.md`.

## Multi-node Ray TP

When `nnodes > 1` (assignment has `ray.enabled` and global
`gpus.tensor_parallel` = total GPUs):

- Use **local** `local_visible_devices` / `gpus.visible_devices` for this node only.
- **rank>0**: install stack → `inference_ray_join` to
  `$GPUCLOUD_CLUSTER_ADVERTISED_ADDR` of head or master addr + `ray.head_port`
  → `inference_report_ready` with `phase=worker_ready` (no API server).
- **rank0**: install stack → `inference_ray_start` →
  `inference_cluster_wait_workers` (must succeed) → `inference_start_vllm`
  with global TP + `ray.enabled` → health → `phase=ready` with reachable
  `visit_host`. Never start two independent TP=1 servers.

## Procedure

1. **Inspect environment** with `terminal`: `nvidia-smi`, then the venv
   python above — `"$PY" -c "import torch,vllm"` (may fail — that is OK;
   install only into this venv if needed).
2. **Identify model family** from `model.local_path` (`config.json`
   `model_type` / `architectures`), directory name, and optional
   `model_hint` / `training_artifact_kind` (e.g. gpt2, qwen2.5, qwen3,
   megatron export). Newer Qwen often needs newer vLLM than GPT-2.
3. **Install stack** (only if the venv lacks a usable torch/vLLM): pick
   torch CUDA wheel + vLLM versions that match the model and driver.
   Prefer explicit `==` pins. On conflict or import failure,
   uninstall/retry another combo **in the same venv**.
   For `nnodes>1` also install `ray` into the same venv.
   **Prefer pip mirrors** for every `pip install` / `pip download` of
   torch/vLLM (and large deps). Do **not** default to bare PyPI — wheels
   are hundreds of MB and official source is often too slow on GPU nodes.
   Priority order:
   1. Aliyun: `https://mirrors.aliyun.com/pypi/simple/`
      (`--trusted-host mirrors.aliyun.com`)
   2. Tsinghua: `https://pypi.tuna.tsinghua.edu.cn/simple`
      (`--trusted-host pypi.tuna.tsinghua.edu.cn`)
   3. Only if both fail: config/`INFERENCE_PIP_INDEX_URL` / official PyPI.
   Example:
   ```bash
   ~/.cache/gpu_platform/inference_venvs/<tag>/bin/pip install "vllm==<pin>" \
     -i https://mirrors.aliyun.com/pypi/simple/ \
     --trusted-host mirrors.aliyun.com
   ```
   If Aliyun stalls, retry the same pin on Tsinghua. Avoid `| tail` on long
   installs so progress stays visible; use `terminal(background=true)` and
   poll. Historical reference only (not mandatory): cu12+py310 often used
   `torch==2.5.1` + `vllm==0.6.6` for older models — do **not** force this
   for Qwen3-class weights.
4. **Artifacts**: if `local_path` missing or not HF-loadable (`config.json` +
   weights), sync via `sources[]`. For `megatron_checkpoints` / `.distcp`,
   follow skill `gpucloud-megatron-weight-export` (ModelOpt / SWIFT recipes
   first; hand-rolled `load_distcp` only as last resort). If still impossible,
   fail with `phase=ensure_artifacts`.
5. **Start**: single-node — `inference_start_vllm` with local devices.
   Multi-node — follow **Multi-node Ray TP** (rank0 waits for workers).
6. **Health**: poll `inference_health` until `ready` (or timeout →
   `phase=health_timeout`). Local `curl http://127.0.0.1:<port>/health` is
   fine for probing only (rank0).
7. **Report**: `inference_report_ready` with success contract (see below).
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

- Fixed pin matrices cannot cover all model families — decide from evidence.
- Do not treat a failed system `python3 -c "import vllm"` as “no vLLM”;
  check the inference venv first.
- Bare `pip` / `~/.local` installs miss the serve interpreter — always use
  the venv `bin/pip`.
- Bare `pip install vllm` without `-i` mirror is a common stall; use Aliyun
  then Tsinghua before falling back.
- Disk space under `~/.cache/pip` / `/tmp/pip-unpack-*` can fill during large
  wheels — clean failed partial downloads when retrying.
- Never put API keys in the outcome JSON.
- Never report `visit_host=127.0.0.1` / `localhost` — platforms store that
  as the client endpoint; use the advertised / public host instead.
- Prefer managed start tool so cluster stop can kill the serve PID.
- Megatron raw checkpoints need `gpucloud-megatron-weight-export` before serve.
- Multi-node: never run independent TP=1 API servers on each node; rank0 must
  wait for `worker_ready` before `phase=ready`.

## Verification

- Chosen venv `python` imports torch + vLLM
- `inference_health` → `ready`
- `curl -sS http://127.0.0.1:<port>/health` succeeds (local probe only)
- `inference_report_ready` `visit_host` is reachable from outside the node
  (not `127.0.0.1`)
- `inference_report_ready` returned `stored: true`
