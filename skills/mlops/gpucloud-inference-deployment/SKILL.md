---
name: gpucloud-inference-deployment
description: Deploy via cluster ModelAdapter with JSON spec bootstrap.
version: 1.1.0
author: GPUCLOUD
platforms: [linux]
metadata:
  gpucloud:
    tags: [gpucloud, inference, deployment, vllm, cluster, model-adapter]
    related_skills: [gpucloud-worker-setup, gpucloud-sft-training, serving-llms-vllm]
    triggers:
      - deploy trained model
      - vllm from training
      - gpucloud inference deployment
      - adapter_id hf_vllm
---

# GPUCLOUD Inference Deployment

Use after training completes when the platform should expose a model through a **cluster ModelAdapter** (not Head SSH family pipelines).

## Core Rules

1. Confirm job, GPUs, weights, and the **LLM api_key for agent bring-up** first.
2. **Deploy starts agent bring-up** — platform `POST /api/inference/agent/deploy` with `bootstrap=true` SSHs to nodes, writes `config.yaml` (`model.api_key`, `cluster.secret`), starts `gpucloud gateway`, then submits the inference job.
3. Inference execution is a **fixed code lifecycle** on the worker: `validate → ensure_artifacts → start → health → outcome`. Skills do **not** schedule processes.
4. Never put api keys in assignment JSON. Use `secrets_ref` env names only (runtime may resolve from config.yaml for internal fleets).

## Flow

```text
confirm resources
  → POST /api/inference/agent/deploy  (or cluster_submit_job job_kind=inference)
  → bootstrap nodes (config.yaml: model.api_key + cluster.secret)
  → master assigns → worker ModelAdapter
  → status callback / DB available + visit_*
```

Bootstrap helpers: `plugins.inference_adapters.bootstrap.plan_deploy_bootstrap`.

## JSON Spec Shape

```json
{
  "job_kind": "inference",
  "adapter_id": "hf_vllm",
  "spec_version": 1,
  "model": { "local_path": "/data/models/job-123-hf" },
  "gpus": {
    "node_ids": ["gpu-node-03"],
    "visible_devices": [0],
    "tensor_parallel": 1
  },
  "serve": { "host": "0.0.0.0", "port": 8000 },
  "secrets_ref": { "serve_api_key_env": "INFERENCE_API_KEY" },
  "sources": []
}
```

Reference adapter `hf_vllm`: local HF directory → vLLM → `/health`. New models = new `adapter_id` implementation under `plugins/inference_adapters/`.

## Config (non-secret)

```yaml
plugins:
  enabled: [cluster, inference_adapters]
cluster:
  enabled: true
  role: master   # or worker
  embedded_master: true
  embedded_worker: true
  master_url: http://<master>:8765
  secret: "<shared-cluster-secret>"
model:
  provider: openrouter
  default: <model>
  api_key: "<llm-api-key>"
inference_adapters:
  enabled: true
  default_adapter_id: hf_vllm
  status_callback_url: http://<thin-api>/api/inference/agent/status
  serve_api_key: ""   # optional
  hf_token: ""        # optional
```

## Secrets (config.yaml by default; `.env` still optional)

- **Required in config:** `model.api_key` (or env `OPENROUTER_API_KEY` / `OPENAI_API_KEY`)
- **Required in config:** `cluster.secret` (or env `GPUCLOUD_CLUSTER_SECRET`; env wins if both set)
- Optional: `inference_adapters.hf_token`, `inference_adapters.serve_api_key`

## Thin API

- `POST /api/inference/agent/deploy` — create deploy row + submit to master
- `POST /api/inference/agent/status` — master projects ready/failed (Bearer cluster secret)
- `GET /api/inference/agent/deploy/{id}` — poll status

## Troubleshooting

- `agent_llm_api_key_missing` — `model.api_key` / `.env` lacked LLM key before gateway start.
- `unknown adapter_id` — enable `inference_adapters` plugin / import adapter module.
- Health timeout — check inference logs under cluster `inference-logs/` and vLLM package compatibility (`references/vllm-runtime-and-model-readiness.md`).

## References

- `references/vllm-runtime-and-model-readiness.md`
- `plugins/inference_adapters/CONFIG.example.md`
