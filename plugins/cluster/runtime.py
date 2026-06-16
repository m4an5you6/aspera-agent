"""Reusable cluster runtime for CLI and embedded control-plane modes."""

from __future__ import annotations

import dataclasses
import logging
import threading
from typing import Any, Callable, Optional

from plugins.cluster.cluster_logging import ClusterLogger
from plugins.cluster.config import ClusterConfig, load_cluster_config, resolve_role
from plugins.cluster.controller import ClusterController
from plugins.cluster.events import ClusterEventBridge
from plugins.cluster.models import ClusterEvent
from plugins.cluster.server import ClusterHTTPServer
from plugins.cluster.store import ClusterStore, open_store
from plugins.cluster.tools import set_runtime as set_tool_runtime

_log = logging.getLogger(__name__)

QueueDelivery = Callable[[str, ClusterEvent], None]


@dataclasses.dataclass
class ClusterRuntime:
    cfg: ClusterConfig
    store: ClusterStore
    logger: ClusterLogger
    events: ClusterEventBridge
    controller: ClusterController
    server: Optional[ClusterHTTPServer] = None
    embedded: bool = False
    session_key: str = ""

    @property
    def running(self) -> bool:
        return self.server is not None


_runtime_lock = threading.RLock()
_embedded_runtime: Optional[ClusterRuntime] = None


def build_runtime(*, force_enabled: bool = False) -> ClusterRuntime:
    """Create the cluster runtime stack without starting an HTTP server."""
    cfg = load_cluster_config()
    if force_enabled:
        cfg.enabled = True
    cfg.data_dir.mkdir(parents=True, exist_ok=True)

    store = open_store(cfg.database_url)
    store.ensure_schema()
    logger = ClusterLogger(cfg, store)
    events = ClusterEventBridge(cfg, store)
    controller = ClusterController(cfg, store, logger, events)
    runtime = ClusterRuntime(
        cfg=cfg,
        store=store,
        logger=logger,
        events=events,
        controller=controller,
    )
    _publish_tool_runtime(runtime)
    return runtime


def _publish_tool_runtime(runtime: ClusterRuntime) -> None:
    set_tool_runtime(
        controller=runtime.controller,
        store=runtime.store,
        logger=runtime.logger,
        events=runtime.events,
    )


def configure_event_delivery(
    runtime: ClusterRuntime,
    *,
    agent: Any = None,
    session_key: str = "",
    queue_delivery: Optional[QueueDelivery] = None,
) -> None:
    """Attach queue/guide/interrupt callbacks for the current host process."""
    if session_key:
        runtime.session_key = session_key
        if not runtime.cfg.event_session_key:
            runtime.cfg.event_session_key = session_key

    def session_matches() -> bool:
        target = (runtime.cfg.event_session_key or runtime.session_key or "").strip()
        if not target or not runtime.session_key:
            return True
        return target == runtime.session_key

    def on_queue(text: str, event: ClusterEvent) -> None:
        if not session_matches():
            _log.info(
                "cluster event %s queued for session %s, current session is %s",
                event.event_id,
                runtime.cfg.event_session_key,
                runtime.session_key,
            )
            runtime.events.requeue(event)
            return
        if queue_delivery:
            queue_delivery(text, event)
            return
        runtime.events.requeue(event)

    def on_guide(text: str) -> bool:
        if not session_matches():
            return False
        steer = getattr(agent, "steer", None)
        if callable(steer):
            return bool(steer(text))
        if queue_delivery:
            queue_delivery(text, _synthetic_event(runtime, "guide_fallback", text))
            return True
        return False

    def on_interrupt(text: str) -> bool:
        if not session_matches():
            return False
        interrupt = getattr(agent, "interrupt", None)
        if callable(interrupt):
            interrupt(text)
            return True
        if queue_delivery:
            queue_delivery(text, _synthetic_event(runtime, "interrupt_fallback", text))
            return True
        return False

    runtime.events.callbacks.on_queue = on_queue
    runtime.events.callbacks.on_guide = on_guide
    runtime.events.callbacks.on_interrupt = on_interrupt


def _synthetic_event(runtime: ClusterRuntime, event_type: str, text: str) -> ClusterEvent:
    from plugins.cluster.models import ClusterEvent, new_id

    return ClusterEvent(
        event_id=new_id("ev-"),
        event_type=event_type,
        payload={"summary": text},
        route_mode="queue",
    )


def start_embedded_master(
    *,
    agent: Any = None,
    session_key: str = "",
    queue_delivery: Optional[QueueDelivery] = None,
) -> Optional[ClusterRuntime]:
    """Start the configured embedded cluster master once per process."""
    global _embedded_runtime

    cfg = load_cluster_config()
    if not cfg.enabled or not cfg.embedded_master:
        return None
    if resolve_role(cfg) != "master":
        _log.info("cluster embedded_master requested but role resolves to worker")
        return None

    with _runtime_lock:
        if _embedded_runtime is None:
            runtime = build_runtime(force_enabled=True)
            runtime.embedded = True
            server = ClusterHTTPServer(runtime.cfg, runtime.controller, runtime.logger)
            server.start(block=False)
            runtime.server = server
            if server._httpd is not None:  # noqa: SLF001 - runtime owns the server lifecycle.
                host, port = server._httpd.server_address[:2]  # noqa: SLF001
                runtime.cfg.bind_host = str(host)
                runtime.cfg.bind_port = int(port)
                if runtime.cfg.master_url.endswith(":0"):
                    runtime.cfg.master_url = f"http://{host}:{port}"
            _embedded_runtime = runtime
            _log.info(
                "embedded cluster master started on %s:%s",
                runtime.cfg.bind_host,
                runtime.cfg.bind_port,
            )
        else:
            runtime = _embedded_runtime
            _publish_tool_runtime(runtime)

        configure_event_delivery(
            runtime,
            agent=agent,
            session_key=session_key,
            queue_delivery=queue_delivery,
        )
        return runtime


def get_embedded_runtime() -> Optional[ClusterRuntime]:
    with _runtime_lock:
        return _embedded_runtime


def stop_embedded_master() -> None:
    global _embedded_runtime
    with _runtime_lock:
        runtime = _embedded_runtime
        _embedded_runtime = None
    if runtime and runtime.server:
        runtime.server.stop()

