#!/usr/bin/env python3
"""Measure webshell command latency with incremental output capture.

Uses BEGIN/END sentinels to slice exact output range per command.
Uses websocket --since cursor to avoid tail-window rescans.
Writes a JSON report with per-step timing in milliseconds.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass
from typing import List, Tuple

# Optional [#seq] prefix in websocket --since mode.
# Match through URL/(bytes) section and stop at payload start (space) or end-of-line.
EVENT_RE = re.compile(
    r"^(?:\[#(?P<seq>\d+)\]\s+)?\[(?P<ts>[0-9T:\.\-]+Z)\] "
    r"\[(?P<dir>in|out|open|close|error)\] "
    r".*?(?: \(\d+B\))?(?:[ \t]|$)",
    re.M,
)
NEXT_SINCE_RE = re.compile(r"NEXT_SINCE\s+(\d+)")
NEXT_SINCE_SUFFIX_RE = re.compile(r"(?:\r?\n)?NEXT_SINCE\s+\d+\s*$")
ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def run_browse(binary: str, args: List[str]) -> Tuple[str, float]:
    start = time.perf_counter_ns()
    proc = subprocess.run(
        [binary, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    end = time.perf_counter_ns()
    cost_ms = (end - start) / 1_000_000.0
    if proc.returncode != 0:
        raise RuntimeError(f"browse {' '.join(args)} failed:\n{proc.stdout}")
    return proc.stdout, cost_ms


def parse_next_since(raw: str, fallback: int) -> int:
    m = NEXT_SINCE_RE.search(raw)
    if not m:
        return fallback
    try:
        return int(m.group(1))
    except ValueError:
        return fallback


def strip_next_since_suffix(raw: str) -> str:
    return NEXT_SINCE_SUFFIX_RE.sub("", raw)


def extract_in_payload(raw: str) -> str:
    # websocket --since appends a cursor line; never treat it as command output.
    raw = strip_next_since_suffix(raw)

    matches = list(EVENT_RE.finditer(raw))
    if not matches:
        return ""

    parts: List[str] = []
    for idx, m in enumerate(matches):
        if m.group("dir") != "in":
            continue
        start = m.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(raw)
        chunk = raw[start:end]
        if chunk.startswith("\n"):
            chunk = chunk[1:]
        parts.append(chunk)

    text = "".join(parts)
    text = ANSI_RE.sub("", text)
    text = text.replace("\r", "")
    return text


@dataclass
class CommandMetrics:
    command: str
    begin_marker: str
    end_marker: str
    input_start_ms: int
    clear_done_ms: int
    type_done_ms: int
    enter_done_ms: int
    first_output_ms: int | None
    result_done_ms: int
    next_input_ms: int | None
    clear_cost_ms: float
    type_cost_ms: float
    enter_cost_ms: float
    poll_count: int
    poll_total_cost_ms: float
    input_to_send_ms: int
    send_to_first_output_ms: int | None
    send_to_result_ms: int
    input_to_result_ms: int
    result_to_next_input_ms: int | None


def run_remote_command(
    binary: str,
    remote_cmd: str,
    *,
    cursor: int,
    poll_interval_ms: int,
    timeout_ms: int,
    clear_each_command: bool,
) -> Tuple[CommandMetrics, str, int]:
    marker_id = uuid.uuid4().hex[:10]
    begin = f"__GS_BEGIN_{marker_id}__"
    end = f"__GS_END_{marker_id}__"

    wrapped = f"printf '{begin}\\n'; {remote_cmd}; printf '\\n{end}\\n'"

    t_input_start = now_ms()
    if clear_each_command:
        _, clear_cost = run_browse(binary, ["websocket", "--clear"])
        t_clear_done = now_ms()
        current_cursor = 0
    else:
        clear_cost = 0.0
        t_clear_done = t_input_start
        current_cursor = cursor

    _, type_cost = run_browse(binary, ["type", wrapped])
    t_type_done = now_ms()

    _, enter_cost = run_browse(binary, ["press", "Enter"])
    t_enter_done = now_ms()

    first_output_ms: int | None = None
    poll_count = 0
    poll_total = 0.0
    result_payload = ""
    captured = ""

    deadline = t_enter_done + timeout_ms
    while True:
        poll_count += 1
        ws_raw, poll_cost = run_browse(binary, ["websocket", "--since", str(current_cursor)])
        poll_total += poll_cost
        t_poll_done = now_ms()

        next_cursor = parse_next_since(ws_raw, current_cursor)
        payload = extract_in_payload(ws_raw)
        if payload:
            captured += payload

        if first_output_ms is None and begin in captured:
            first_output_ms = t_poll_done

        b_idx = captured.find(begin)
        if b_idx != -1:
            e_idx = captured.find(end, b_idx + len(begin))
            if e_idx != -1:
                result_payload = captured[b_idx + len(begin) : e_idx]
                result_payload = result_payload.lstrip("\n")
                result_done = t_poll_done
                current_cursor = next_cursor
                break

        current_cursor = next_cursor

        if t_poll_done >= deadline:
            result_done = t_poll_done
            if b_idx != -1:
                partial = captured[b_idx + len(begin) :]
                result_payload = partial.lstrip("\n") + "\n<TIMEOUT_NO_END_MARKER>"
            else:
                result_payload = "<TIMEOUT_NO_END_MARKER>"
            break

        time.sleep(poll_interval_ms / 1000.0)

    metrics = CommandMetrics(
        command=remote_cmd,
        begin_marker=begin,
        end_marker=end,
        input_start_ms=t_input_start,
        clear_done_ms=t_clear_done,
        type_done_ms=t_type_done,
        enter_done_ms=t_enter_done,
        first_output_ms=first_output_ms,
        result_done_ms=result_done,
        next_input_ms=None,
        clear_cost_ms=round(clear_cost, 3),
        type_cost_ms=round(type_cost, 3),
        enter_cost_ms=round(enter_cost, 3),
        poll_count=poll_count,
        poll_total_cost_ms=round(poll_total, 3),
        input_to_send_ms=t_enter_done - t_input_start,
        send_to_first_output_ms=(None if first_output_ms is None else first_output_ms - t_enter_done),
        send_to_result_ms=result_done - t_enter_done,
        input_to_result_ms=result_done - t_input_start,
        result_to_next_input_ms=None,
    )
    return metrics, result_payload, current_cursor


def default_commands() -> List[str]:
    return [
        "ls -1 /var/log/tiger",
        "tail -n 5 /var/log/tiger/aot_cache_conf.json",
        "tail -n 5 /var/log/tiger/data.manhattan.access.log",
        "tail -n 5 /var/log/tiger/data.manhattan.call.log",
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe webshell command latency in ms")
    parser.add_argument(
        "--binary",
        default=os.environ.get("B")
        or os.environ.get("BROWSE_BIN")
        or "/Users/bytedance/.codex/skills/gstack/browse/dist/browse",
    )
    parser.add_argument("--poll-interval-ms", type=int, default=150)
    parser.add_argument("--timeout-ms", type=int, default=10000)
    parser.add_argument("--cursor", type=int, default=0, help="Initial websocket --since cursor")
    parser.add_argument("--clear-each-command", action="store_true", help="Run websocket --clear before each command")
    parser.add_argument("--output", default="")
    parser.add_argument("--command", action="append", default=[], help="Remote command to run (can be repeated)")
    parser.add_argument("--commands-file", default="", help="Path to commands file, one command per line")
    args = parser.parse_args()

    commands = list(args.command)
    if args.commands_file:
        with open(args.commands_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                commands.append(line)
    if not commands:
        commands = default_commands()

    results = []
    outputs = []
    cursor = max(args.cursor, 0)

    # One-time cursor sync to skip historical traffic when not clearing per command.
    if not args.clear_each_command:
        ws_sync, _ = run_browse(args.binary, ["websocket", "--since", str(cursor)])
        cursor = parse_next_since(ws_sync, cursor)

    for i, cmd in enumerate(commands):
        m, out, cursor = run_remote_command(
            args.binary,
            cmd,
            cursor=cursor,
            poll_interval_ms=args.poll_interval_ms,
            timeout_ms=args.timeout_ms,
            clear_each_command=args.clear_each_command,
        )
        outputs.append({"command": cmd, "output": out})
        results.append(m)

        if i + 1 < len(commands):
            next_start = now_ms()
            m.next_input_ms = next_start
            m.result_to_next_input_ms = next_start - m.result_done_ms

    report = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "binary": args.binary,
        "poll_interval_ms": args.poll_interval_ms,
        "timeout_ms": args.timeout_ms,
        "initial_cursor": args.cursor,
        "final_cursor": cursor,
        "clear_each_command": args.clear_each_command,
        "commands": [asdict(x) for x in results],
        "outputs": outputs,
        "summary": {
            "count": len(results),
            "avg_input_to_result_ms": round(sum(x.input_to_result_ms for x in results) / max(len(results), 1), 2),
            "avg_send_to_result_ms": round(sum(x.send_to_result_ms for x in results) / max(len(results), 1), 2),
            "avg_polls": round(sum(x.poll_count for x in results) / max(len(results), 1), 2),
        },
    }

    out_path = args.output or f"/tmp/webshell_latency_{int(time.time())}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(out_path)
    print(json.dumps(report["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
