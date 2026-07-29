"""Reference adapter: local HF directory → vLLM → health poll."""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen

from plugins.inference_adapters.base import ArtifactPaths, EndpointInfo, HealthState, ModelAdapter
from plugins.inference_adapters.inference_venv import resolve_serve_python
from plugins.inference_adapters.registry import register_adapter
from plugins.inference_adapters.spec import resolve_secret_env


def _serve_python_from_spec(spec: Dict[str, Any], facts: Dict[str, Any]) -> str:
    runtime = spec.get("runtime") if isinstance(spec.get("runtime"), dict) else {}
    requested = str(
        runtime.get("python_executable") or facts.get("python_executable") or ""
    ).strip()
    return resolve_serve_python(requested)

_log = logging.getLogger(__name__)


def _looks_like_hf_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    # Minimal HF layout signals
    names = {p.name for p in path.iterdir()} if path.exists() else set()
    if "config.json" in names:
        return True
    if any(n.endswith(".safetensors") or n.endswith(".bin") for n in names):
        return True
    return False


@register_adapter
class HfVllmAdapter(ModelAdapter):
    adapter_id = "hf_vllm"

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._endpoint: Optional[EndpointInfo] = None
        self._log_paths: Dict[str, Path] = {}
        self._runtime_facts: Dict[str, Any] = {}

    def validate(self, spec: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        model = spec.get("model") if isinstance(spec.get("model"), dict) else {}
        local_path = str(model.get("local_path") or "").strip()
        if not local_path:
            errors.append("model.local_path is required for hf_vllm")
        serve = spec.get("serve") if isinstance(spec.get("serve"), dict) else {}
        port = serve.get("port", 8000)
        try:
            port_i = int(port)
            if port_i < 1 or port_i > 65535:
                errors.append("serve.port out of range")
        except (TypeError, ValueError):
            errors.append("serve.port must be an integer")
        gpus = spec.get("gpus") if isinstance(spec.get("gpus"), dict) else {}
        tp = gpus.get("tensor_parallel", 1)
        try:
            if int(tp) < 1:
                errors.append("gpus.tensor_parallel must be >= 1")
        except (TypeError, ValueError):
            errors.append("gpus.tensor_parallel must be an integer")
        return errors

    def ensure_runtime(self, spec: Dict[str, Any]) -> None:
        """Run RuntimeScheme.tasks via task_runner (with optional replan callback)."""
        from plugins.inference_adapters.runtime_scheme import get_replan_budget
        from plugins.inference_adapters.task_runner import NeedsReplan, run_scheme_tasks

        runtime = spec.get("runtime") if isinstance(spec.get("runtime"), dict) else {}
        scheme = runtime.get("scheme") if isinstance(runtime.get("scheme"), dict) else None
        if not scheme:
            # No scheme embedded — nothing to install (legacy callers).
            return

        replan_cb = spec.get("_replan_callback")
        stop_flag = spec.get("_stop_flag")
        max_attempts, max_wall = get_replan_budget()

        log_dir = Path(
            os.environ.get("GPUCLOUD_INFERENCE_LOG_DIR")
            or (Path(os.environ.get("GPUCLOUD_HOME", str(Path.home() / ".gpucloud"))) / "cluster" / "inference-logs")
        )
        job_id = str(spec.get("job_id") or "inference")
        job_log_dir = log_dir / job_id

        constrained = str(
            (scheme.get("constraints") or {}).get("python_executable") or ""
        ).strip()
        initial_facts = {"python_executable": resolve_serve_python(constrained)}

        try:
            result = run_scheme_tasks(
                scheme,
                initial_facts=initial_facts,
                replan_callback=replan_cb if callable(replan_cb) else None,
                stop_flag=stop_flag if callable(stop_flag) else None,
                log_dir=job_log_dir,
                max_replan_attempts=max_attempts,
                max_replan_wall_seconds=max_wall,
            )
        except NeedsReplan:
            raise
        self._runtime_facts = dict(result.facts)
        # Persist resolved python back onto spec runtime for start()
        runtime = dict(runtime)
        runtime["python_executable"] = str(
            result.facts.get("python_executable") or initial_facts["python_executable"]
        )
        runtime["facts"] = dict(result.facts)
        spec["runtime"] = runtime

    def ensure_artifacts(self, spec: Dict[str, Any]) -> ArtifactPaths:
        model = spec.get("model") if isinstance(spec.get("model"), dict) else {}
        local_path = Path(str(model.get("local_path") or "")).expanduser()
        if not local_path.exists():
            raise FileNotFoundError(f"model.local_path does not exist: {local_path}")
        if not _looks_like_hf_dir(local_path):
            raise ValueError(
                f"model.local_path does not look like an HF/vLLM-loadable directory: {local_path}"
            )
        return ArtifactPaths(model_path=str(local_path.resolve()))

    def start(self, spec: Dict[str, Any], artifacts: ArtifactPaths) -> EndpointInfo:
        serve = spec.get("serve") if isinstance(spec.get("serve"), dict) else {}
        gpus = spec.get("gpus") if isinstance(spec.get("gpus"), dict) else {}
        host = str(serve.get("host") or "0.0.0.0")
        port = int(serve.get("port") or 8000)
        tp = int(gpus.get("tensor_parallel") or 1)
        visible = gpus.get("local_visible_devices") or gpus.get("visible_devices")
        runtime = spec.get("runtime") if isinstance(spec.get("runtime"), dict) else {}
        scheme = runtime.get("scheme") if isinstance(runtime.get("scheme"), dict) else {}
        scheme_extra = list((scheme.get("constraints") or {}).get("extra_args") or [])
        adapter_options = (
            spec.get("adapter_options") if isinstance(spec.get("adapter_options"), dict) else {}
        )
        extra_args = list(
            serve.get("extra_args")
            or adapter_options.get("extra_args")
            or scheme_extra
            or []
        )
        ray = spec.get("ray") if isinstance(spec.get("ray"), dict) else {}
        use_ray = bool(ray.get("enabled")) or str(
            ray.get("distributed_executor_backend")
            or adapter_options.get("distributed_executor_backend")
            or ""
        ).lower() == "ray"

        env = os.environ.copy()
        env.update({str(k): str(v) for k, v in dict(spec.get("env") or {}).items()})
        if isinstance(scheme.get("constraints"), dict) and isinstance(scheme["constraints"].get("env"), dict):
            env.update({str(k): str(v) for k, v in scheme["constraints"]["env"].items()})
        if isinstance(visible, list) and visible:
            env["CUDA_VISIBLE_DEVICES"] = ",".join(str(x) for x in visible)

        secrets_ref = spec.get("secrets_ref") if isinstance(spec.get("secrets_ref"), dict) else {}
        api_key_env = str(
            secrets_ref.get("serve_api_key_env")
            or ""
        ).strip()
        api_key = resolve_secret_env(api_key_env) if api_key_env else resolve_secret_env("INFERENCE_API_KEY")

        python_exe = _serve_python_from_spec(spec, self._runtime_facts or {})

        cmd = [
            python_exe,
            "-m",
            "vllm.entrypoints.openai.api_server",
            "--model",
            artifacts.model_path,
            "--host",
            host,
            "--port",
            str(port),
            "--tensor-parallel-size",
            str(tp),
        ]
        if use_ray:
            cmd.extend(["--distributed-executor-backend", "ray"])
            ray_addr = str(ray.get("address") or env.get("RAY_ADDRESS") or "").strip()
            if not ray_addr:
                head_port = ray.get("head_port") or ray.get("port")
                head_host = (
                    os.environ.get("GPUCLOUD_CLUSTER_ADVERTISED_ADDR", "").strip()
                    or os.environ.get("MASTER_ADDR", "").strip()
                    or "127.0.0.1"
                )
                if head_port is not None:
                    ray_addr = f"{head_host}:{int(head_port)}"
            if ray_addr:
                env["RAY_ADDRESS"] = ray_addr

        extra_joined = " ".join(str(a) for a in extra_args)
        if adapter_options.get("trust_remote_code") and "--trust-remote-code" not in extra_joined:
            cmd.append("--trust-remote-code")
        if adapter_options.get("max_model_len") is not None and "--max-model-len" not in extra_joined:
            cmd.extend(["--max-model-len", str(int(adapter_options["max_model_len"]))])
        if (
            adapter_options.get("gpu_memory_utilization") is not None
            and "--gpu-memory-utilization" not in extra_joined
        ):
            cmd.extend(
                [
                    "--gpu-memory-utilization",
                    str(float(adapter_options["gpu_memory_utilization"])),
                ]
            )
        if adapter_options.get("cpu_offload_gb") is not None and "--cpu-offload-gb" not in extra_joined:
            cmd.extend(["--cpu-offload-gb", str(float(adapter_options["cpu_offload_gb"]))])
        if adapter_options.get("enable_lora") and "--enable-lora" not in extra_joined:
            cmd.append("--enable-lora")
        if adapter_options.get("max_lora_rank") is not None and "--max-lora-rank" not in extra_joined:
            cmd.extend(["--max-lora-rank", str(int(adapter_options["max_lora_rank"]))])
        dtype = str(adapter_options.get("dtype") or "").strip()
        if dtype and "--dtype" not in extra_joined:
            cmd.extend(["--dtype", dtype])
        quantization = str(adapter_options.get("quantization") or "").strip()
        if quantization and "--quantization" not in extra_joined:
            cmd.extend(["--quantization", quantization])
        load_format = str(adapter_options.get("load_format") or "").strip()
        if load_format and "--load-format" not in extra_joined:
            cmd.extend(["--load-format", load_format])
        if adapter_options.get("enforce_eager") and "--enforce-eager" not in extra_joined:
            cmd.append("--enforce-eager")
        lora_modules = adapter_options.get("lora_modules")
        if lora_modules and "--lora-modules" not in extra_joined:
            cmd.extend(["--lora-modules", str(lora_modules)])

        if api_key:
            env["VLLM_API_KEY"] = api_key
            cmd.extend(["--api-key", api_key])
        cmd.extend(str(a) for a in extra_args)

        log_dir = Path(
            os.environ.get("GPUCLOUD_INFERENCE_LOG_DIR")
            or (Path(os.environ.get("GPUCLOUD_HOME", str(Path.home() / ".gpucloud"))) / "cluster" / "inference-logs")
        )
        log_dir.mkdir(parents=True, exist_ok=True)
        job_id = str(spec.get("job_id") or "inference")
        stdout_path = log_dir / f"{job_id}.stdout.log"
        stderr_path = log_dir / f"{job_id}.stderr.log"
        self._log_paths = {"stdout": stdout_path, "stderr": stderr_path}

        stdout_f = open(stdout_path, "ab")
        stderr_f = open(stderr_path, "ab")
        _log.info("hf_vllm starting: %s", " ".join(cmd))
        self._proc = subprocess.Popen(
            cmd,
            env=env,
            stdout=stdout_f,
            stderr=stderr_f,
            start_new_session=True,
        )
        visit_host = os.environ.get("GPUCLOUD_CLUSTER_ADVERTISED_ADDR", "").strip()
        if not visit_host or host not in ("0.0.0.0", "::"):
            visit_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
        if os.environ.get("GPUCLOUD_CLUSTER_ADVERTISED_ADDR", "").strip() and host in ("0.0.0.0", "::"):
            visit_host = os.environ["GPUCLOUD_CLUSTER_ADVERTISED_ADDR"].strip()

        self._endpoint = EndpointInfo(
            host=visit_host,
            port=port,
            protocol=str(serve.get("protocol") or "http://"),
            stream_path=str(serve.get("stream_path") or "/v1/chat/completions"),
            health_path=str(serve.get("health_path") or "/health"),
            extra={"pid": self._proc.pid, "logs": {k: str(v) for k, v in self._log_paths.items()}},
        )
        return self._endpoint

    def health(self) -> HealthState:
        if self._proc is not None and self._proc.poll() is not None:
            return "dead"
        if self._endpoint is None:
            return "dead"
        url = f"http://127.0.0.1:{self._endpoint.port}{self._endpoint.health_path}"
        try:
            req = Request(url, method="GET")
            with urlopen(req, timeout=2) as resp:
                if 200 <= getattr(resp, "status", 200) < 300:
                    return "ready"
                return "degraded"
        except Exception:
            if self._proc is not None and self._proc.poll() is None:
                return "degraded"
            return "dead"

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        if proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.terminate()
            except Exception:
                pass
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.2)
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except Exception:
                pass
