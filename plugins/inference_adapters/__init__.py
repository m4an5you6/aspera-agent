"""Inference adapters plugin — ModelAdapter registry + agent driver tools."""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Enable via plugins.enabled: [inference_adapters]."""
    # Import side-effect: register built-in adapters
    from plugins.inference_adapters import hf_vllm as _hf_vllm  # noqa: F401
    from plugins.inference_adapters.agent_tools import (
        INFERENCE_CLUSTER_WAIT_WORKERS_SCHEMA,
        INFERENCE_ENSURE_RUNTIME_SCHEMA,
        INFERENCE_HEALTH_SCHEMA,
        INFERENCE_RAY_JOIN_SCHEMA,
        INFERENCE_RAY_START_SCHEMA,
        INFERENCE_REPORT_READY_SCHEMA,
        INFERENCE_START_VLLM_SCHEMA,
        INFERENCE_STOP_SCHEMA,
        handle_inference_cluster_wait_workers,
        handle_inference_ensure_runtime,
        handle_inference_health,
        handle_inference_ray_join,
        handle_inference_ray_start,
        handle_inference_report_ready,
        handle_inference_start_vllm,
        handle_inference_stop,
    )
    from plugins.inference_adapters.registry import list_adapters

    def _list_adapters(args: dict, **kwargs: Any) -> str:
        return json.dumps({"success": True, "adapters": list_adapters()})

    ctx.register_tool(
        name="inference_adapter_list",
        toolset="inference_adapters",
        schema={
            "name": "inference_adapter_list",
            "description": "List registered inference ModelAdapter ids on this worker.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handler=_list_adapters,
        emoji="🧩",
    )
    for name, schema, handler, emoji in (
        (
            "inference_ensure_runtime",
            INFERENCE_ENSURE_RUNTIME_SCHEMA,
            handle_inference_ensure_runtime,
            "🧭",
        ),
        ("inference_start_vllm", INFERENCE_START_VLLM_SCHEMA, handle_inference_start_vllm, "🚀"),
        ("inference_ray_start", INFERENCE_RAY_START_SCHEMA, handle_inference_ray_start, "🟠"),
        ("inference_ray_join", INFERENCE_RAY_JOIN_SCHEMA, handle_inference_ray_join, "🔗"),
        (
            "inference_cluster_wait_workers",
            INFERENCE_CLUSTER_WAIT_WORKERS_SCHEMA,
            handle_inference_cluster_wait_workers,
            "⏳",
        ),
        ("inference_health", INFERENCE_HEALTH_SCHEMA, handle_inference_health, "❤️"),
        ("inference_stop", INFERENCE_STOP_SCHEMA, handle_inference_stop, "🛑"),
        (
            "inference_report_ready",
            INFERENCE_REPORT_READY_SCHEMA,
            handle_inference_report_ready,
            "✅",
        ),
    ):
        ctx.register_tool(
            name=name,
            toolset="inference_adapters",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )
    logger.info(
        "inference_adapters plugin registered (%s)",
        ", ".join(list_adapters()) or "no adapters",
    )
