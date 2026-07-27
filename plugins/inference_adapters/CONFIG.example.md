"""
# Inference adapters config (internal: secrets may live in config.yaml)

Add to ~/.gpucloud/config.yaml when enabling deploy-after-confirm inference:

```yaml
model:
  provider: openrouter   # or openai / custom
  default: your-model
  api_key: "sk-..."      # LLM key for on-node inference agent (required for driver=agent)

plugins:
  enabled: [cluster, inference_adapters]

cluster:
  enabled: true
  role: master   # or worker
  # GPU master: enable both so this host schedules AND can serve.
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
  # agent (default): on-node AIAgent installs deps, prepares artifacts, starts vLLM until ready.
  # legacy_scheme: fixed RuntimeScheme task runner (pin matrix + replan).
  driver: agent
  default_adapter_id: hf_vllm
  health_poll_seconds: 2
  health_timeout_seconds: 300
  agent_timeout_seconds: 1800   # inactivity timeout for agent driver
  max_iterations: 90
  serve_api_key_env: INFERENCE_API_KEY
  serve_api_key: ""       # optional protect local vLLM HTTP
  hf_token: ""            # optional private weight pull
  status_callback_url: "" # optional thin API callback for deploy status projection
  # legacy_scheme only:
  max_replan_attempts: 16
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

With ``driver: agent`` (default), the assigned worker spawns an on-node AIAgent
that chooses torch/vLLM for the model family, syncs/checks weights, starts
serve via ``inference_start_vllm``, and reports ready. Fixed pin matrix is not
required. Set ``driver: legacy_scheme`` to restore the old RuntimeScheme path.

Bootstrap master configs enable ``embedded_worker: true`` so the master host
registers as a schedulable node. Control-plane-only masters may set
``embedded_worker: false`` after render.
"""
