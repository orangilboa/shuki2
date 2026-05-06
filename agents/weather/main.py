"""
Weather forecast — a 2-node LangGraph demo for openshuki.

Pipeline: fetch → format. The agent reads `--location` and `--days` from the
command line (filled by the openshuki agent form), generates a mock forecast,
and prints it via the JSONL protocol expected by the subprocess runner.

Run standalone:
    python main.py --location Tokyo --days 3
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path
from typing import Any, TypedDict

# Make `agent_util` importable from the parent agents/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_util import (  # noqa: E402
    artifact,
    custom,
    done,
    emit_error,
    node_end,
    node_start,
    token,
    tool_call,
    tool_result,
)

from langgraph.graph import StateGraph, START, END  # noqa: E402


class WeatherState(TypedDict, total=False):
    location: str
    days: int
    raw: list[dict[str, Any]]
    summary: str


CONDITIONS = ["Sunny", "Partly cloudy", "Cloudy", "Rain", "Thunderstorm", "Snow", "Windy"]


def fetch_node(state: WeatherState) -> WeatherState:
    location = state.get("location") or ""
    days = int(state.get("days") or 3)

    node_start("fetch", {"location": location, "days": days})
    token(f"looking up {location}…", node="fetch")
    tool_call("weather_api.lookup", args={"location": location, "days": days}, node="fetch")
    time.sleep(0.4)  # pretend network latency

    rng = random.Random(hash(location) & 0xFFFFFFFF)
    raw = []
    for i in range(max(1, days)):
        low = rng.randint(-3, 18)
        high = rng.randint(low + 1, low + 14)
        raw.append({
            "day": i + 1,
            "condition": rng.choice(CONDITIONS),
            "high_c": high,
            "low_c": low,
        })

    tool_result("weather_api.lookup", ok=True, count=len(raw), node="fetch")
    custom({"kind": "weather.raw", "rows": raw}, node="fetch")
    node_end("fetch", progress=0.5)

    return {**state, "raw": raw}


def format_node(state: WeatherState) -> WeatherState:
    rows = state.get("raw") or []
    location = state.get("location") or ""

    node_start("format", {"rows": len(rows)})

    lines = [f"Forecast for {location}:"]
    for r in rows:
        lines.append(
            f"  Day {r['day']}: {r['condition']}, {r['low_c']}°C – {r['high_c']}°C"
        )

    for line in lines:
        token(line, node="format")

    summary = "\n".join(lines)

    # Emit a markdown artifact with a friendlier table-style report.
    md_lines = [f"# Weather forecast — {location}", "", "| Day | Condition | Low | High |", "| --- | --- | --- | --- |"]
    for r in rows:
        md_lines.append(
            f"| {r['day']} | {r['condition']} | {r['low_c']}°C | {r['high_c']}°C |"
        )
    artifact(
        f"forecast-{location.lower().replace(' ', '-') or 'summary'}.md",
        "md",
        "\n".join(md_lines) + "\n",
        node="format",
    )

    node_end("format", progress=1.0)
    return {**state, "summary": summary}


def build_graph():
    g = StateGraph(WeatherState)
    g.add_node("fetch", fetch_node)
    g.add_node("format", format_node)
    g.add_edge(START, "fetch")
    g.add_edge("fetch", "format")
    g.add_edge("format", END)
    return g.compile()


def main() -> int:
    parser = argparse.ArgumentParser(description="Mock weather forecast (2-node LangGraph).")
    parser.add_argument("--location", required=True, help="City or area to forecast.")
    parser.add_argument("--days", type=int, default=3, help="Number of days to forecast.")
    args = parser.parse_args()

    try:
        graph = build_graph()
        result = graph.invoke({"location": args.location, "days": args.days})
        done(ok=True, summary=result.get("summary", ""))
        return 0
    except Exception as e:  # noqa: BLE001
        emit_error(str(e))
        done(ok=False, error=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
