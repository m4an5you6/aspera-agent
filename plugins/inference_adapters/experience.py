"""Master-side shared experience store for inference RuntimeScheme selection/replan."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


def facts_fingerprint(facts: Optional[Dict[str, Any]]) -> str:
    """Normalize capabilities/facts into a stable fingerprint string."""
    caps = facts if isinstance(facts, dict) else {}

    def _int(key: str, default: int = 0) -> int:
        try:
            return int(caps.get(key) if caps.get(key) not in (None, "") else default)
        except (TypeError, ValueError):
            return default

    def _major_ver(raw: Any) -> str:
        s = str(raw or "").strip()
        if not s:
            return ""
        # torch 2.5.1+cu121 -> 2.5; vllm 0.6.6 -> 0.6
        base = s.split("+")[0]
        parts = base.split(".")
        if len(parts) >= 2:
            return f"{parts[0]}.{parts[1]}"
        return parts[0]

    py = str(caps.get("python_version") or "").strip()
    py_minor = ""
    if py:
        parts = py.split(".")
        if len(parts) >= 2:
            py_minor = f"{parts[0]}.{parts[1]}"
        else:
            py_minor = parts[0]

    payload = {
        "cuda_major": _int("cuda_driver_major"),
        "python_minor": py_minor,
        "driver_major": str(caps.get("nvidia_driver") or "").split(".")[0],
        "torch_major": _major_ver(caps.get("torch_version")),
        "vllm_major": _major_ver(caps.get("vllm_version")),
        "vllm_available": bool(caps.get("vllm_available")),
        "torch_available": bool(caps.get("torch_available")),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def tasks_digest(tasks: Optional[List[Dict[str, Any]]]) -> str:
    raw = json.dumps(tasks or [], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


REPLANABLE_ERROR_CLASSES = frozenset({"no_wheel", "conflict", "import_failed"})


def classify_error(error: str = "", failed_task_id: str = "") -> str:
    text = f"{failed_task_id} {error}".lower()
    # Timeout before broader tokens so "pip timeout after Ns" is not "other".
    if "pip timeout" in text or "timeout after" in text:
        return "timeout"
    if "no_wheel" in text or "no matching distribution" in text or "could not find a version" in text:
        return "no_wheel"
    if "conflict" in text or "resolutionimpossible" in text or "dependency" in text:
        return "conflict"
    if "import_failed" in text or "modulenotfound" in text or "import " in text:
        return "import_failed"
    if "constraint" in text or "no_scheme" in text or "incompatible" in text:
        return "constraint"
    if "pin_ref" in text or "unresolved" in text:
        return "unresolved_pin"
    return "other"


@dataclass
class ExperienceRecord:
    facts_fingerprint: str
    scheme_id: str
    tasks_digest: str
    outcome: str  # success | fail | replan_exhausted
    failed_task_id: str = ""
    error_class: str = ""
    effective_tasks: List[Dict[str, Any]] = field(default_factory=list)
    mirror_profile: str = "default"
    count: int = 1
    last_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ExperienceStore:
    """SQLite-backed (or memory) experience shared across workers on one master."""

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self._lock = threading.RLock()
        self._memory: Dict[str, ExperienceRecord] = {}
        self._db_path = Path(db_path) if db_path else None
        if self._db_path is not None:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            self._init_db()

    def _connect(self) -> sqlite3.Connection:
        assert self._db_path is not None
        conn = sqlite3.connect(str(self._db_path), timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS inference_experience (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    facts_fingerprint TEXT NOT NULL,
                    scheme_id TEXT NOT NULL,
                    tasks_digest TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    failed_task_id TEXT NOT NULL DEFAULT '',
                    error_class TEXT NOT NULL DEFAULT '',
                    effective_tasks TEXT NOT NULL DEFAULT '[]',
                    mirror_profile TEXT NOT NULL DEFAULT 'default',
                    count INTEGER NOT NULL DEFAULT 1,
                    last_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_inf_exp_fp
                ON inference_experience(facts_fingerprint, outcome)
                """
            )
            conn.commit()

    def _key(
        self,
        fingerprint: str,
        scheme_id: str,
        tasks_digest_s: str,
        outcome: str,
        failed_task_id: str,
        error_class: str,
    ) -> str:
        return "|".join(
            [fingerprint, scheme_id, tasks_digest_s, outcome, failed_task_id, error_class]
        )

    def record(
        self,
        *,
        facts: Dict[str, Any],
        scheme_id: str,
        tasks: List[Dict[str, Any]],
        outcome: str,
        failed_task_id: str = "",
        error: str = "",
        mirror_profile: str = "default",
    ) -> ExperienceRecord:
        fp = facts_fingerprint(facts)
        digest = tasks_digest(tasks)
        err_class = classify_error(error, failed_task_id) if outcome != "success" else ""
        with self._lock:
            if self._db_path is None:
                key = self._key(fp, scheme_id, digest, outcome, failed_task_id, err_class)
                existing = self._memory.get(key)
                if existing:
                    existing.count += 1
                    existing.last_at = time.time()
                    existing.effective_tasks = list(tasks)
                    return existing
                rec = ExperienceRecord(
                    facts_fingerprint=fp,
                    scheme_id=scheme_id,
                    tasks_digest=digest,
                    outcome=outcome,
                    failed_task_id=failed_task_id,
                    error_class=err_class,
                    effective_tasks=list(tasks),
                    mirror_profile=mirror_profile,
                )
                self._memory[key] = rec
                return rec

            with self._connect() as conn:
                row = conn.execute(
                    """
                    SELECT id, count FROM inference_experience
                    WHERE facts_fingerprint=? AND scheme_id=? AND tasks_digest=?
                      AND outcome=? AND failed_task_id=? AND error_class=?
                    LIMIT 1
                    """,
                    (fp, scheme_id, digest, outcome, failed_task_id, err_class),
                ).fetchone()
                now = time.time()
                tasks_json = json.dumps(tasks)
                if row:
                    conn.execute(
                        """
                        UPDATE inference_experience
                        SET count=count+1, last_at=?, effective_tasks=?, mirror_profile=?
                        WHERE id=?
                        """,
                        (now, tasks_json, mirror_profile, row["id"]),
                    )
                    count = int(row["count"]) + 1
                else:
                    conn.execute(
                        """
                        INSERT INTO inference_experience
                        (facts_fingerprint, scheme_id, tasks_digest, outcome, failed_task_id,
                         error_class, effective_tasks, mirror_profile, count, last_at)
                        VALUES (?,?,?,?,?,?,?,?,1,?)
                        """,
                        (
                            fp,
                            scheme_id,
                            digest,
                            outcome,
                            failed_task_id,
                            err_class,
                            tasks_json,
                            mirror_profile,
                            now,
                        ),
                    )
                    count = 1
                conn.commit()
            return ExperienceRecord(
                facts_fingerprint=fp,
                scheme_id=scheme_id,
                tasks_digest=digest,
                outcome=outcome,
                failed_task_id=failed_task_id,
                error_class=err_class,
                effective_tasks=list(tasks),
                mirror_profile=mirror_profile,
                count=count,
                last_at=time.time(),
            )

    def best_success(self, facts: Dict[str, Any]) -> Optional[ExperienceRecord]:
        fp = facts_fingerprint(facts)
        with self._lock:
            if self._db_path is None:
                matches = [
                    r
                    for r in self._memory.values()
                    if r.facts_fingerprint == fp and r.outcome == "success"
                ]
                if not matches:
                    return None
                matches.sort(key=lambda r: (r.count, r.last_at), reverse=True)
                return matches[0]

            with self._connect() as conn:
                row = conn.execute(
                    """
                    SELECT * FROM inference_experience
                    WHERE facts_fingerprint=? AND outcome='success'
                    ORDER BY count DESC, last_at DESC
                    LIMIT 1
                    """,
                    (fp,),
                ).fetchone()
            if not row:
                return None
            return self._row_to_record(row)

    def known_failures(self, facts: Dict[str, Any]) -> List[ExperienceRecord]:
        fp = facts_fingerprint(facts)
        with self._lock:
            if self._db_path is None:
                return [
                    r
                    for r in self._memory.values()
                    if r.facts_fingerprint == fp and r.outcome in ("fail", "replan_exhausted")
                ]
            with self._connect() as conn:
                rows = conn.execute(
                    """
                    SELECT * FROM inference_experience
                    WHERE facts_fingerprint=? AND outcome IN ('fail','replan_exhausted')
                    """,
                    (fp,),
                ).fetchall()
            return [self._row_to_record(r) for r in rows]

    def is_known_failure(
        self,
        facts: Dict[str, Any],
        *,
        scheme_id: str,
        failed_task_id: str,
        error: str = "",
    ) -> bool:
        err_class = classify_error(error, failed_task_id)
        fp = facts_fingerprint(facts)
        for rec in self.known_failures(facts):
            if (
                rec.facts_fingerprint == fp
                and rec.scheme_id == scheme_id
                and rec.failed_task_id == failed_task_id
                and rec.error_class == err_class
            ):
                return True
        return False

    def _row_to_record(self, row: sqlite3.Row) -> ExperienceRecord:
        try:
            tasks = json.loads(row["effective_tasks"] or "[]")
        except Exception:
            tasks = []
        if not isinstance(tasks, list):
            tasks = []
        return ExperienceRecord(
            facts_fingerprint=str(row["facts_fingerprint"]),
            scheme_id=str(row["scheme_id"]),
            tasks_digest=str(row["tasks_digest"]),
            outcome=str(row["outcome"]),
            failed_task_id=str(row["failed_task_id"] or ""),
            error_class=str(row["error_class"] or ""),
            effective_tasks=tasks,
            mirror_profile=str(row["mirror_profile"] or "default"),
            count=int(row["count"] or 1),
            last_at=float(row["last_at"] or 0),
        )


_STORE: Optional[ExperienceStore] = None
_STORE_LOCK = threading.Lock()


def get_experience_store(data_dir: Optional[Path] = None) -> ExperienceStore:
    """Process-wide experience store; uses sqlite under data_dir when provided."""
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            db = None
            if data_dir is not None:
                db = Path(data_dir) / "experience.sqlite"
            _STORE = ExperienceStore(db)
        return _STORE


def reset_experience_store_for_tests() -> None:
    global _STORE
    with _STORE_LOCK:
        _STORE = None
