---
name: gpucloud-inference-deployment
description: Deploy via cluster ModelAdapter with JSON spec bootstrap.
version: 1.2.0
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
3. Master selects a **RuntimeScheme** (`tasks[]` + mirror/constraints). Worker runs `validate → ensure_runtime → ensure_artifacts → start → health → outcome`. High-frequency **replan** stays on master/worker; platform only sees terminal status.
4. Never put api keys or package pins in assignment JSON. Use `secrets_ref` env names only.

## Flow

```text
confirm resources
  → POST /api/inference/agent/deploy  (or cluster_submit_job job_kind=inference)
  → bootstrap nodes (config.yaml: model.api_key + cluster.secret)
  → workers heartbeat capabilities
  → master selects RuntimeScheme (experience + rules)
  → worker task runner (replan as needed) → ModelAdapter start/health
  → status callback / DB available + visit_*
```

Bootstrap helpers: `plugins.inference_adapters.bootstrap.plan_deploy_bootstrap`.

## JSON Spec Shape (platform → master)

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

Do **not** send vLLM/torch version pins or install scripts. Master fills `runtime_scheme`.

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
  max_replan_attempts: 16
  max_replan_wall_seconds: 3600
  serve_api_key: ""
  hf_token: ""
```

## Thin API

- `POST /api/inference/agent/deploy` — create deploy row + submit to master
- `POST /api/inference/agent/status` — master projects ready/failed (Bearer cluster secret)
- `GET /api/inference/agent/deploy/{id}` — poll status (`bootstrapping|submitted|available|failed`)

## Troubleshooting

- `capabilities_incomplete:<node>` — wait for worker heartbeat probe, retry submit.
- `no_scheme_match:` — no built-in scheme for this CUDA/python; extend matrix/schemes.
- `replan_exhausted:` — install/replan budget used up; check `inference-logs/` and experience failures.
- `agent_llm_api_key_missing` — `model.api_key` / `.env` lacked LLM key before gateway start.
- Health timeout — see `references/vllm-runtime-and-model-readiness.md`.

## References

- `references/runtime-scheme-contract.md`
- `references/vllm-runtime-and-model-readiness.md`
- `references/deployment-master-inference-status.md`
- `plugins/inference_adapters/CONFIG.example.md`
