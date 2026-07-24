"""
# Inference adapters config (internal: secrets may live in config.yaml)

Add to ~/.gpucloud/config.yaml when enabling deploy-after-confirm inference:

```yaml
model:
  provider: openrouter   # or openai / custom
  default: your-model
  api_key: "sk-..."      # LLM key for agent bring-up (internal deployments)

plugins:
  enabled: [cluster, inference_adapters]

cluster:
  enabled: true
  role: master   # or worker
  # GPU master: enable both so this host schedules AND can serve / ensure_runtime.
  # Pure control-plane (no GPU): embedded_master true, embedded_worker false.
  embedded_master: true
  embedded_worker: true
  node_id: master-a          # required when embedded_worker is true
  master_url: http://<master>:8765
  bind_host: 0.0.0.0
  bind_port: 8765
  secret: "shared-cluster-secret"   # env GPUCLOUD_CLUSTER_SECRET still wins if set

inference_adapters:
  enabled: true
  default_adapter_id: hf_vllm
  health_poll_seconds: 2
  health_timeout_seconds: 300
  serve_api_key_env: INFERENCE_API_KEY
  serve_api_key: ""       # optional protect local vLLM HTTP
  hf_token: ""            # optional private weight pull
  status_callback_url: "" # optional thin API callback for deploy status projection
  max_replan_attempts: 16
  # Idle / no-progress budgets (download/write progress renews them; not absolute wall clocks).
  # Replan scheme/matrix switches only for no_wheel | conflict | import_failed.
  max_replan_wall_seconds: 3600
  ensure_runtime_timeout_seconds: 1800
  mirror_profiles: {}     # optional named pip indexes; empty uses built-in default
  runtime_matrix: []      # optional pin matrix override; empty uses built-in
  runtime_schemes: []     # optional scheme templates; empty uses built-in
```

# Optional legacy .env (not required when keys are in config.yaml)

```bash
# Still supported if you prefer env over yaml:
# OPENROUTER_API_KEY=...
# GPUCLOUD_CLUSTER_SECRET=...
# HF_TOKEN=...
# INFERENCE_API_KEY=...
```

Use `plugins.inference_adapters.bootstrap.plan_deploy_bootstrap(...)` after
deploy is requested to render per-node config.yaml (+ optional .env) and a
remote start script. Assignment JSON must never carry plaintext keys.
Master selects RuntimeScheme (tasks); workers execute/replan — see
`skills/mlops/gpucloud-inference-deployment/references/runtime-scheme-contract.md`.

``ensure_runtime_timeout_seconds`` and ``max_replan_wall_seconds`` are **idle
no-progress limits**: pip download/write output renews them. Absolute
"kill after N seconds from start" is not used. Replan only amends scheme /
matrix for ``no_wheel``, ``conflict``, and ``import_failed``; pip timeout
classifies as ``timeout`` and is refused (no matrix switch).

Bootstrap master configs enable ``embedded_worker: true`` so the master host
registers as a schedulable node (same ensure_runtime / serve path as workers).
Control-plane-only masters may set ``embedded_worker: false`` after render.
"""
