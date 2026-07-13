# RuntimeScheme contract (Master tasks + replan + experience)

## Platform (thin)

Allowed projected states only: `bootstrapping → submitted → available | failed`.

Platform **must**:

1. Confirm job + GPUs, SSH bootstrap master/workers (`plan_deploy_bootstrap`).
   GPU masters render with `embedded_worker: true` so they register and can
   receive ensure_runtime / serve assignments like other workers.
2. Wait until nodes (including GPU master) have heartbeated with `probe_version >= 1` (or retry submit on `capabilities_incomplete:`).
3. Submit coarse inference JSON (no package pins / install steps).
4. Poll terminal status / accept status callback.

Platform **must not**:

- Choose vLLM/torch pins or run pip over SSH.
- Poll worker `/health`.
- Expose replan/install steps as product state machine states.

## Capabilities (worker heartbeat metrics)

Required for scheme selection (`probe_ready`):

- `probe_version` (>= 1)
- `python_executable`
- `gpu_count` (>= 1)

Also reported: `nvidia_driver`, `cuda_driver_major`, `torch_*`, `vllm_*`.

## RuntimeScheme (Master → Worker)

Scheme **body is `tasks[]`**, plus `mirror_profile`, `constraints`, `adapter_id`, `replan_generation`.

Typical built-in task order (single probe, not repeated):

`probe_stack → ensure_torch? → ensure_vllm? → verify_stack`

Extras (`ensure_extras`) are inserted on **replan** when verify/import fails — not in the default template.

Master embeds:

- `job.spec.extra.runtime_scheme`
- `job.spec.extra.inference_spec.runtime.scheme`

No full pip BOM on submit. Pins resolve lazily via `pin_ref` (`matrix:<id>/<pkg>`) when a task runs.

## Worker lifecycle

```text
validate → ensure_runtime (task runner + replan) → ensure_artifacts → start → health → outcome
```

## Replan

- Worker raises `needs_replan` → `POST /api/jobs/{id}/replan` → Master amends tasks / switches scheme.
- Budgets: `inference_adapters.max_replan_attempts` (default 16), `max_replan_wall_seconds` (default 3600).
- Replan is **not** visible to the platform.

## Experience store

Master-local `experience.sqlite` under cluster `data_dir`. Shared across workers on that master. Fingerprint from cuda/python/torch/vllm coarse facts. Used to prefer prior success schemes and avoid known failure combos.
