"""Cluster control-plane plugin — temporary master, worker agents, cluster_* tools."""

from __future__ import annotations

import logging
from typing import Any

from plugins.cluster.cli import cluster_command, register_cli
from plugins.cluster.tools import (
    CLUSTER_JOB_STATUS_SCHEMA,
    CLUSTER_LOGS_SCHEMA,
    CLUSTER_NODE_ACTION_SCHEMA,
    CLUSTER_STATUS_SCHEMA,
    CLUSTER_STOP_JOB_SCHEMA,
    CLUSTER_SUBMIT_JOB_SCHEMA,
    CLUSTER_VALIDATE_CONFIG_SCHEMA,
    check_cluster_available,
    handle_cluster_job_status,
    handle_cluster_logs,
    handle_cluster_node_action,
    handle_cluster_status,
    handle_cluster_stop_job,
    handle_cluster_submit_job,
    handle_cluster_validate_config,
)
from plugins.cluster.runtime import start_embedded_master, start_embedded_worker

logger = logging.getLogger(__name__)

_TOOLS = (
    ("cluster_status", CLUSTER_STATUS_SCHEMA, handle_cluster_status, "🖧"),
    ("cluster_validate_config", CLUSTER_VALIDATE_CONFIG_SCHEMA, handle_cluster_validate_config, "✅"),
    ("cluster_submit_job", CLUSTER_SUBMIT_JOB_SCHEMA, handle_cluster_submit_job, "🚀"),
    ("cluster_job_status", CLUSTER_JOB_STATUS_SCHEMA, handle_cluster_job_status, "📊"),
    ("cluster_logs", CLUSTER_LOGS_SCHEMA, handle_cluster_logs, "📜"),
    ("cluster_stop_job", CLUSTER_STOP_JOB_SCHEMA, handle_cluster_stop_job, "🛑"),
    ("cluster_node_action", CLUSTER_NODE_ACTION_SCHEMA, handle_cluster_node_action, "🔧"),
)


def register(ctx) -> None:
    """Register cluster tools and CLI. Enable via plugins.enabled: [cluster]."""
    for name, schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=name,
            toolset="cluster",
            schema=schema,
            handler=handler,
            check_fn=check_cluster_available,
            emoji=emoji,
        )

    ctx.register_cli_command(
        name="cluster",
        help="Temporary master control plane for multi-node training",
        setup_fn=register_cli,
        handler_fn=cluster_command,
    )

    def _queue_to_cli(text: str, _event: Any) -> None:
        ctx.inject_message(text)

    def _on_session_start(
        session_id: str = "",
        agent: Any = None,
        platform: str = "",
        **_kwargs: Any,
    ) -> None:
        if str(platform or "").lower() == "gateway":
            return
        start_embedded_master(
            agent=agent,
            session_key=session_id,
            queue_delivery=_queue_to_cli,
        )
        start_embedded_worker()

    def _pre_gateway_dispatch(event: Any = None, gateway: Any = None, session_store: Any = None, **_kwargs: Any) -> None:
        if event is None or gateway is None or session_store is None:
            return
        source = getattr(event, "source", None)
        if source is None:
            return
        try:
            session_entry = session_store.get_or_create_session(source)
            session_key = session_entry.session_key
        except Exception:
            session_key = ""
        if not session_key:
            return
        try:
            gateway._cache_session_source(session_key, source)
        except Exception:
            pass

        def _queue_to_gateway(text: str, cluster_event: Any) -> None:
            dispatch = getattr(gateway, "dispatch_cluster_event", None)
            if callable(dispatch):
                dispatch(
                    session_key=session_key,
                    text=text,
                    route_mode=getattr(cluster_event, "route_mode", "queue"),
                )

        start_embedded_master(
            session_key=session_key,
            queue_delivery=_queue_to_gateway,
        )
        start_embedded_worker()

    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_gateway_dispatch", _pre_gateway_dispatch)

    # Also boot when this process is already the gateway (plugin re-discovery).
    # Primary boot path is gateway/run.py after discover_plugins(); this covers
    # late loads while avoiding binding :8765 from short-lived CLI commands.
    import os

    if os.environ.get("_GPUCLOUD_GATEWAY") == "1":
        try:
            start_embedded_master()
            start_embedded_worker()
        except Exception:
            logger.exception("embedded cluster auto-start failed")

    logger.info("cluster plugin registered (%d tools)", len(_TOOLS))
