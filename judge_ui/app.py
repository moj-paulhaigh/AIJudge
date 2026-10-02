"""
Judge Dashboard: a standalone service, independent of the chat test UI.

Reads data/ directly off disk (the SQLite store, aijudge.db, and verdicts/)
and the shared judge_rules.py for what the rules actually are — it has no
dependency on chatui/backend at all, and chatui/backend has none on this.
An admin/compliance user can run this on its own to see what the Judge is
doing without needing the chat testing tool running at all.
"""

import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

load_dotenv()

APP_DIR = Path(__file__).resolve().parent  # judge_ui/
REPO_ROOT = APP_DIR.parent
FRONTEND_DIR = APP_DIR / "frontend"

sys.path.insert(0, str(REPO_ROOT))
import judge_rules  # noqa: E402 — shared, side-effect-free rule definitions
import judge_store  # noqa: E402 — shared SQLite state written by the Judge

# Same anchoring logic as litellm_proxy/judge_logger.py and
# chatui/backend/app.py — a relative AIJUDGE_DATA_DIR must resolve against
# the repo root, not whatever cwd this process happens to be started from.
_data_dir_env = os.environ.get("AIJUDGE_DATA_DIR")
DATA_DIR = ((REPO_ROOT / _data_dir_env) if _data_dir_env else (REPO_ROOT / "data")).resolve()
VERDICTS_DIR = DATA_DIR / "verdicts"

STORE = judge_store.Store(DATA_DIR)

# Window (seconds) over which requests/sec is computed — must match (or be
# shorter than) STATS_WINDOW_SECONDS in litellm_proxy/judge_logger.py,
# which is how long a timestamp survives in stats["recent_timestamps"].
RPS_WINDOW_SECONDS = 60

# How many one-minute token buckets the dashboard's timeline shows. Must be
# <= TOKEN_BUCKET_KEEP in litellm_proxy/judge_logger.py.
TIMELINE_MINUTES = 30

# How many sessions the suspicion table lists.
TOP_SESSIONS_SHOWN = 20

# Drill-down limits: how many verdict files to scan for one session, and how
# much of the tail of judge_activity.log to search for judge prompts/replies.
SESSION_SCAN_MAX_FILES = 3000
ACTIVITY_LOG_TAIL_BYTES = 4_000_000
_LOG_ENTRY_START = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[AIJudge\] ", re.M)
_JUDGE_PROMPT = re.compile(r"^REQUEST (\S+) \| JUDGE PROMPT[^\n]*\n(.*)\Z", re.S)
_JUDGE_RAW = re.compile(r"^REQUEST (\S+) \| JUDGE RAW RESPONSE: (.*)\Z", re.S)

app = FastAPI(title="AIJudge — Judge Dashboard")


def _percentile(sorted_values, p):
    if not sorted_values:
        return 0.0
    return sorted_values[min(len(sorted_values) - 1, int(p * len(sorted_values)))]


@app.post("/api/blocklist/reset")
async def reset_blocklist():
    cleared = STORE.clear_blocklist()
    # The Judge (a different process) does an indexed read of the blocked
    # table on every request, so it sees this on its very next call. Sessions
    # (scores, watermarks) are untouched.
    return {"cleared_count": len(cleared), "cleared": cleared}


def _judge_transcripts(record_ids):
    """Judge prompt / raw replies per triggering record id, from the tail of
    judge_activity.log (the only place they are kept)."""
    wanted = set(record_ids)
    found = {}
    log_file = DATA_DIR / "judge_activity.log"
    if not wanted or not log_file.exists():
        return found
    with open(log_file, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - ACTIVITY_LOG_TAIL_BYTES))
        text = fh.read().decode("utf-8", errors="replace")
    for entry in _LOG_ENTRY_START.split(text):
        entry = entry.rstrip("\n")
        m = _JUDGE_PROMPT.match(entry)
        if m and m.group(1) in wanted:
            found.setdefault(m.group(1), {"prompt": None, "raw": []})["prompt"] = m.group(2)
            continue
        m = _JUDGE_RAW.match(entry)
        if m and m.group(1) in wanted:
            found.setdefault(m.group(1), {"prompt": None, "raw": []})["raw"].append(m.group(2))
    return found


def _redact(text):
    # The canary is a secret; the chat backend's system prompt carries it, so
    # it appears in logged inputs. Never show it in the dashboard.
    return text.replace(judge_rules.CANARY_TOKEN, "[canary]") if isinstance(text, str) else text


def _last_user_text(input_text):
    """The final user message of a logged input ("role: content" lines)."""
    marker = "\nuser: "
    i = input_text.rfind(marker)
    if i >= 0:
        return input_text[i + len(marker):]
    return input_text[len("user: "):] if input_text.startswith("user: ") else input_text


@app.get("/api/sessions/{session_id}")
async def session_detail(session_id: str):
    """Everything the Judge recorded for one session: its state, every
    exchange (input, output, fast-rule hits, verdict) and the slow-tier
    judge's prompt / raw reply where a review ran."""
    try:
        session = STORE.read_sessions_payload().get("sessions", {}).get(session_id)
        blocked = session_id in STORE.blocked_users()
    except sqlite3.Error:
        session, blocked = None, False

    exchanges = []
    if VERDICTS_DIR.exists():
        files = sorted(VERDICTS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for f in files[:SESSION_SCAN_MAX_FILES]:
            try:
                rec = json.loads(f.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if rec.get("user_id") == session_id:
                exchanges.append(rec)
    exchanges.sort(key=lambda r: r.get("timestamp", ""))

    judge = _judge_transcripts([e["id"] for e in exchanges if e.get("judge_path") == "slow"])
    for e in exchanges:
        e["user_text"] = _redact(_last_user_text(e.get("input", "")))
        e["input"] = _redact(e.get("input", ""))
        e["output"] = _redact(e.get("output", ""))
        e["judge"] = judge.get(e["id"])

    if session is None and not exchanges:
        raise HTTPException(status_code=404, detail="unknown session")
    session = session or {}
    return {
        "session_id": session_id,
        "blocked": blocked,
        "score": session.get("score", 0),
        "reviewed_score": session.get("reviewed_score", 0),
        "requests": session.get("requests", 0),
        "reviews": session.get("reviews", []),
        "hits": session.get("hits", []),
        "slow_review_threshold": judge_rules.SLOW_REVIEW_THRESHOLD,
        "exchanges": exchanges,
    }


@app.get("/api/judge-stats")
async def judge_stats():
    try:
        blocked_users = STORE.blocked_users()
        stats = STORE.read_stats()
        sessions_file = STORE.read_sessions_payload()
    except sqlite3.Error:
        blocked_users, stats, sessions_file = [], {}, {}

    recent_timestamps = stats.get("recent_timestamps", [])
    now = time.time()
    requests_last_window = sum(1 for t in recent_timestamps if now - t <= RPS_WINDOW_SECONDS)

    # Per-minute chat vs judge token spend for the last TIMELINE_MINUTES,
    # zero-filled so the chart has a continuous x axis.
    buckets = stats.get("token_buckets", {})
    this_minute = int(now // 60) * 60
    token_timeline = []
    for i in range(TIMELINE_MINUTES - 1, -1, -1):
        t = this_minute - i * 60
        b = buckets.get(str(t), {})
        token_timeline.append({"t": t, "chat": b.get("chat", 0), "judge": b.get("judge", 0)})

    session_tokens = stats.get("session_tokens", {})
    top_sessions = sorted(
        ({"session_id": sid, **v} for sid, v in session_tokens.items()),
        key=lambda s: s.get("chat", 0) + s.get("judge", 0),
        reverse=True,
    )[:8]

    # Latency the fast tier adds to the request path (its pre-call hook).
    fl = sessions_file.get("fast_latency", {})
    recent_latency = sorted(fl.get("recent", []))
    fast_checks = fl.get("checks", 0)
    fast_latency = {
        "checks": fast_checks,
        "avg_ms": (fl.get("total_ms", 0) / fast_checks) if fast_checks else 0,
        "p50_ms": _percentile(recent_latency, 0.5),
        "p95_ms": _percentile(recent_latency, 0.95),
        "max_ms": fl.get("max_ms", 0),
        "sample_size": len(recent_latency),
    }

    threshold = judge_rules.SLOW_REVIEW_THRESHOLD
    # Per-rule shadow hit counts, from the hits each session retains (recent
    # only, MAX_HITS_KEPT per session — not lifetime totals).
    shadow_ids = {r["id"] for r in judge_rules.FAST_RULES if r.get("shadow")}
    shadow_hits = {rid: 0 for rid in shadow_ids}
    for s in sessions_file.get("sessions", {}).values():
        for h in s.get("hits", []):
            if h.get("shadow") and h.get("rule") in shadow_hits:
                shadow_hits[h["rule"]] += 1

    sessions = []
    for sid, s in sessions_file.get("sessions", {}).items():
        checks = s.get("fast_checks", 0)
        sessions.append({
            "session_id": sid,
            "score": s.get("score", 0),
            "reviewed_score": s.get("reviewed_score", 0),
            "blocked": sid in blocked_users,
            "requests": s.get("requests", 0),
            "fast_checks": checks,
            "fast_latency_avg_ms": (s.get("fast_latency_total_ms", 0) / checks) if checks else 0,
            "fast_latency_max_ms": s.get("fast_latency_max_ms", 0),
            "recent_hits": [h["name"] + (" (shadow)" if h.get("shadow") else "") for h in s.get("hits", [])[-4:]],
            "last_review": (s.get("reviews") or [None])[-1],
            "last_seen": s.get("last_seen", 0),
        })
    sessions.sort(
        key=lambda s: (
            not s["blocked"] and (s["last_review"] or {}).get("verdict") == "safe",
            s["blocked"],
            s["score"],
            s["last_seen"],
        ),
        reverse=True,
    )
    reviewed_sessions = sorted(
        (s for s in sessions if s["last_review"]),
        key=lambda s: s["last_review"].get("ts", 0),
        reverse=True,
    )

    recent_verdicts = []
    if VERDICTS_DIR.exists():
        files = sorted(VERDICTS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:50]
        for f in files:
            try:
                recent_verdicts.append(json.loads(f.read_text()))
            except json.JSONDecodeError:
                continue

    return {
        # Rules whose real pattern is secret (the canary) carry a redact_pattern to show instead.
        "fast_rules": [
            {k: v for k, v in {**r, "pattern": r.get("redact_pattern", r["pattern"])}.items() if k != "redact_pattern"}
            for r in judge_rules.FAST_RULES
        ],
        "shadow_hits": shadow_hits,
        "slow_review": judge_rules.SLOW_REVIEW,
        "totals": {
            "total_requests": stats.get("total_requests", 0),
            "verdict_counts": stats.get("verdict_counts", {"safe": 0, "suspicious": 0, "bad": 0}),
            "total_prompt_tokens": stats.get("total_prompt_tokens", 0),
            "total_completion_tokens": stats.get("total_completion_tokens", 0),
            "total_tokens": stats.get("total_tokens", 0),
            "judge_overhead_tokens": stats.get("judge_overhead_tokens", 0),
            "judge_prompt_tokens": stats.get("judge_prompt_tokens", 0),
            "judge_completion_tokens": stats.get("judge_completion_tokens", 0),
            "judge_calls": stats.get("judge_calls", 0),
            "unique_sessions": len(stats.get("unique_sessions", [])),
            "blocked_sessions": len(blocked_users),
        },
        "requests_per_second": round(requests_last_window / RPS_WINDOW_SECONDS, 3),
        "requests_last_window": requests_last_window,
        "window_seconds": RPS_WINDOW_SECONDS,
        "judge_paths": stats.get("judge_paths", {"fast_block": 0, "fast": 0, "slow": 0}),
        "fast_latency": fast_latency,
        "slow_review_threshold": threshold,
        "sessions": sessions[:TOP_SESSIONS_SHOWN],
        "reviewed_sessions": reviewed_sessions,
        "token_timeline": token_timeline,
        "top_sessions": top_sessions,
        "blocked_users": blocked_users,
        "recent_verdicts": recent_verdicts,
    }


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
