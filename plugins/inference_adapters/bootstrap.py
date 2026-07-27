"""Deploy-triggered bootstrap: write config.yaml (with secrets) and start gateway.

Internal deployments may keep LLM / cluster secrets in config.yaml.
Assignment JSON still must not carry plaintext keys.
"""

from __future__ import annotations

import os
import shlex
import textwrap
from pathlib import Path
from typing import Any, Dict, List, Optional


def _yaml_scalar(value: str) -> str:
    """Quote a YAML scalar when it needs escaping."""
    s = str(value)
    if not s:
        return '""'
    needs_quote = (
        s.strip() != s
        or any(c in s for c in ":#{}[]&*!|>'\"%@`,\n\t")
        or s.lower() in ("true", "false", "null", "yes", "no", "~")
        or s[:1].isdigit()
    )
    if needs_quote:
        escaped = s.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return s


def render_master_config(
    *,
    bind_host: str = "0.0.0.0",
    bind_port: int = 8765,
    node_id: str = "",
    master_url: str = "",
    default_adapter_id: str = "hf_vllm",
    model_provider: str = "",
    model_default: str = "",
    model_base_url: str = "",
    llm_api_key: str = "",
    cluster_secret: str = "",
    hf_token: str = "",
    inference_api_key: str = "",
) -> str:
    """Render master config.

    GPU masters also enable ``embedded_worker`` so the same host registers as a
    schedulable node, receives inference assignments, and runs ensure_runtime.
    Pure control-plane (no GPU) fleets may still set ``embedded_worker: false``
    by hand after render.
    """
    provider = model_provider or "openrouter"
    model_lines = [
        "model:",
        f"  provider: {provider}",
        f"  default: {_yaml_scalar(model_default)}",
    ]
    if model_base_url:
        model_lines.append(f"  base_url: {_yaml_scalar(model_base_url)}")
    if llm_api_key:
        model_lines.append(f"  api_key: {_yaml_scalar(llm_api_key)}")

    resolved_master_url = (master_url or "").strip() or f"http://127.0.0.1:{int(bind_port)}"
    node_line = ""
    if str(node_id or "").strip():
        node_line = f"\n              node_id: {_yaml_scalar(str(node_id).strip())}"

    # Indent must match sibling keys inside the dedent block below (14 spaces).
    # Wrong indent (e.g. "  secret:") shrinks textwrap.dedent's common prefix and
    # produces invalid YAML (secret at document root, over-indented children).
    cluster_extra = ""
    if cluster_secret:
        cluster_extra = f"\n              secret: {_yaml_scalar(cluster_secret)}"

    ia_extra_lines: List[str] = []
    if inference_api_key:
        ia_extra_lines.append(f"              serve_api_key: {_yaml_scalar(inference_api_key)}")
    if hf_token:
        ia_extra_lines.append(f"              hf_token: {_yaml_scalar(hf_token)}")
    ia_extra = ("\n" + "\n".join(ia_extra_lines)) if ia_extra_lines else ""

    return (
        "\n".join(model_lines)
        + "\n"
        + textwrap.dedent(
            f"""
            plugins:
              enabled: [cluster, inference_adapters]

            cluster:
              enabled: true
              role: master
              embedded_master: true
              embedded_worker: true
              master_url: {_yaml_scalar(resolved_master_url)}
              bind_host: {bind_host}
              bind_port: {bind_port}{node_line}
              heartbeat_interval_sec: 5
              heartbeat_ttl_sec: 20{cluster_extra}

            inference_adapters:
              enabled: true
              default_adapter_id: {default_adapter_id}
              health_poll_seconds: 2
              health_timeout_seconds: 300
              serve_api_key_env: INFERENCE_API_KEY{ia_extra}
            """
        ).lstrip()
    )


def render_worker_config(
    *,
    master_url: str,
    node_id: str,
    default_adapter_id: str = "hf_vllm",
    model_provider: str = "",
    model_default: str = "",
    model_base_url: str = "",
    llm_api_key: str = "",
    cluster_secret: str = "",
    hf_token: str = "",
    inference_api_key: str = "",
) -> str:
    provider = model_provider or "openrouter"
    model_lines = [
        "model:",
        f"  provider: {provider}",
        f"  default: {_yaml_scalar(model_default)}",
    ]
    if model_base_url:
        model_lines.append(f"  base_url: {_yaml_scalar(model_base_url)}")
    if llm_api_key:
        model_lines.append(f"  api_key: {_yaml_scalar(llm_api_key)}")

    cluster_extra = ""
    if cluster_secret:
        cluster_extra = f"\n              secret: {_yaml_scalar(cluster_secret)}"

    ia_extra_lines: List[str] = []
    if inference_api_key:
        ia_extra_lines.append(f"              serve_api_key: {_yaml_scalar(inference_api_key)}")
    if hf_token:
        ia_extra_lines.append(f"              hf_token: {_yaml_scalar(hf_token)}")
    ia_extra = ("\n" + "\n".join(ia_extra_lines)) if ia_extra_lines else ""

    return (
        "\n".join(model_lines)
        + "\n"
        + textwrap.dedent(
            f"""
            plugins:
              enabled: [cluster, inference_adapters]

            cluster:
              enabled: true
              role: worker
              embedded_master: false
              embedded_worker: true
              master_url: {master_url}
              node_id: {node_id}
              heartbeat_interval_sec: 5
              heartbeat_ttl_sec: 20{cluster_extra}

            inference_adapters:
              enabled: true
              default_adapter_id: {default_adapter_id}
              health_poll_seconds: 2
              health_timeout_seconds: 300
              serve_api_key_env: INFERENCE_API_KEY{ia_extra}
            """
        ).lstrip()
    )


def render_dotenv(
    *,
    llm_api_key: str = "",
    llm_api_key_env: str = "OPENROUTER_API_KEY",
    cluster_secret: str = "",
    hf_token: str = "",
    inference_api_key: str = "",
    extra: Optional[Dict[str, str]] = None,
) -> str:
    """Optional .env render (legacy). Prefer secrets in config.yaml for internal deploys."""
    lines: List[str] = []
    if llm_api_key:
        lines.append(f"{llm_api_key_env}={llm_api_key.strip()}")
    if cluster_secret:
        lines.append(f"GPUCLOUD_CLUSTER_SECRET={cluster_secret.strip()}")
    if hf_token:
        lines.append(f"HF_TOKEN={hf_token.strip()}")
    if inference_api_key:
        lines.append(f"INFERENCE_API_KEY={inference_api_key.strip()}")
    for k, v in (extra or {}).items():
        if k and v is not None:
            lines.append(f"{k}={v}")
    return ("\n".join(lines) + "\n") if lines else ""


def write_node_files(
    gpucloud_home: Path,
    *,
    config_yaml: str,
    dotenv: str = "",
) -> Dict[str, str]:
    home = Path(gpucloud_home)
    home.mkdir(parents=True, exist_ok=True)
    config_path = home / "config.yaml"
    config_path.write_text(config_yaml, encoding="utf-8")
    try:
        os.chmod(config_path, 0o600)
    except OSError:
        pass
    out: Dict[str, str] = {"config": str(config_path), "gpucloud_home": str(home)}
    if dotenv.strip():
        env_path = home / ".env"
        env_path.write_text(dotenv, encoding="utf-8")
        try:
            os.chmod(env_path, 0o600)
        except OSError:
            pass
        out["env"] = str(env_path)
    return out


def build_remote_bootstrap_script(
    *,
    role: str,
    gpucloud_home: str,
    config_yaml: str,
    dotenv: str = "",
    install_cmd: str = "",
    start_cmd: str = "gpucloud gateway",
) -> str:
    """Return a bash script that writes config.yaml (and optional .env) then starts gateway."""
    if role not in ("master", "worker"):
        raise ValueError("role must be master or worker")
    install = install_cmd.strip() or (
        "echo 'gpu-agent install skipped (set install_cmd to clone/pip install)'"
    )
    env_block = ""
    if dotenv.strip():
        env_block = textwrap.dedent(
            f"""
            cat > "$GPUCLOUD_HOME/.env" <<'GPUCLOUD_ENV_EOF'
            {dotenv.rstrip()}
            GPUCLOUD_ENV_EOF
            chmod 600 "$GPUCLOUD_HOME/.env" || true
            """
        )
    return textwrap.dedent(
        f"""\
        #!/usr/bin/env bash
        set -euo pipefail
        export GPUCLOUD_HOME={shlex.quote(gpucloud_home)}
        mkdir -p "$GPUCLOUD_HOME"
        {install}
        cat > "$GPUCLOUD_HOME/config.yaml" <<'GPUCLOUD_CONFIG_EOF'
        {config_yaml.rstrip()}
        GPUCLOUD_CONFIG_EOF
        chmod 600 "$GPUCLOUD_HOME/config.yaml" || true
        {env_block}
        # Start single gateway unit (cluster embeds via config)
        nohup {start_cmd} >"$GPUCLOUD_HOME/gateway.bootstrap.log" 2>&1 &
        echo $! >"$GPUCLOUD_HOME/gateway.pid"
        echo "bootstrapped role={role} home=$GPUCLOUD_HOME pid=$(cat "$GPUCLOUD_HOME/gateway.pid")"
        """
    )


def plan_deploy_bootstrap(
    *,
    master_node_id: str,
    worker_node_ids: List[str],
    master_url: str,
    llm_api_key: str,
    llm_api_key_env: str = "OPENROUTER_API_KEY",
    cluster_secret: str,
    bind_port: int = 8765,
    hf_token: str = "",
    inference_api_key: str = "",
    model_provider: str = "",
    model_default: str = "",
    model_base_url: str = "",
    gpucloud_home: str = "~/.gpucloud",
    also_write_dotenv: bool = False,
) -> Dict[str, Any]:
    """Build bootstrap payloads for master + workers (secrets in config.yaml by default)."""
    if not str(llm_api_key or "").strip():
        raise ValueError("llm_api_key is required to start gpu-agent (agent_llm_api_key_missing)")
    if not str(cluster_secret or "").strip():
        raise ValueError("cluster_secret is required")

    dotenv = ""
    if also_write_dotenv:
        dotenv = render_dotenv(
            llm_api_key=llm_api_key,
            llm_api_key_env=llm_api_key_env,
            cluster_secret=cluster_secret,
            hf_token=hf_token,
            inference_api_key=inference_api_key,
        )

    common_kw = dict(
        model_provider=model_provider,
        model_default=model_default,
        model_base_url=model_base_url,
        llm_api_key=llm_api_key,
        cluster_secret=cluster_secret,
        hf_token=hf_token,
        inference_api_key=inference_api_key,
    )
    master_cfg = render_master_config(
        bind_port=bind_port,
        node_id=master_node_id,
        master_url=master_url,
        **common_kw,
    )
    workers = []
    for nid in worker_node_ids:
        wcfg = render_worker_config(
            master_url=master_url,
            node_id=nid,
            **common_kw,
        )
        workers.append(
            {
                "node_id": nid,
                "role": "worker",
                "config_yaml": wcfg,
                "dotenv": dotenv,
                "script": build_remote_bootstrap_script(
                    role="worker",
                    gpucloud_home=gpucloud_home,
                    config_yaml=wcfg,
                    dotenv=dotenv,
                ),
            }
        )
    return {
        "master": {
            "node_id": master_node_id,
            "role": "master",
            "config_yaml": master_cfg,
            "dotenv": dotenv,
            "script": build_remote_bootstrap_script(
                role="master",
                gpucloud_home=gpucloud_home,
                config_yaml=master_cfg,
                dotenv=dotenv,
            ),
        },
        "workers": workers,
        "notes": [
            "Call only after deploy is requested (not pre-pool).",
            "llm_api_key / cluster.secret are written into config.yaml (internal deployments).",
            "Never put api_key in assignment JSON.",
            "Master enables embedded_worker so it can register, ensure_runtime, and serve like workers.",
            "Control-plane-only masters (no GPU) may set embedded_worker: false after render.",
        ],
    }
