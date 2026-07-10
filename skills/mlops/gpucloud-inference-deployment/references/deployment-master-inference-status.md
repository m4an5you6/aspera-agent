# Agent-orchestrated inference status

Prefer the thin API under ComputingPlatform-Inference:

- `POST /api/inference/agent/deploy` — after resources are confirmed; submits `job_kind=inference` to the cluster master.
- `POST /api/inference/agent/status` — master callback projecting `available` / `failed` + visit fields into `inference_deploy_nodes`.
- `GET /api/inference/agent/deploy/{deploy_node_id}` — poll deploy status.

Do **not** treat legacy Deployment-master inference stubs as the control plane. Worker-local ModelAdapter (`hf_vllm` or a new adapter) plus cluster heartbeat is the supported path.

Platform backends should read `inference_deploy_nodes` or the GET endpoint — they should not poll GPU worker `/health` themselves.
