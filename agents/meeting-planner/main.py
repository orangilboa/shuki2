"""
Meeting planner — a LangGraph agent for openshuki (Python, mock Outlook COM).

Given a list of people and an urgency level, it scans everyone's Outlook
calendars, decides which existing meetings may be overridden (using the user's
saved override rules), asks for clearance on the unclear cases — and *learns*
from those answers by appending to the saved rules — then proposes a slot,
sends the invite, and monitors responses.

The calendar access goes through `outlook_com.py`, a mock shaped like the real
desktop Outlook COM object model so the eventual swap to `win32com` is
mechanical.

Run standalone:
    python -u main.py --people "Alice,Bob" --urgency 7d --subject "Sync" --duration_min 30
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, TypedDict

# Make `agent_util` importable from the parent agents/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_util import (  # noqa: E402
    artifact,
    ask_user,
    config_patch,
    custom,
    done,
    emit_error,
    load_agent_config,
    node_end,
    node_start,
    token,
    tool_call,
    tool_result,
)

from langgraph.graph import StateGraph, START, END  # noqa: E402

import outlook_com as ol  # noqa: E402


# ---------- config / urgency ---------------------------------------------

URGENCY_HORIZON_DAYS = {"asap": 2, "2d": 2, "7d": 7, "30d": 30}

# How many distinct ambiguous subjects we'll stop to ask about, to keep a run
# from turning into an interrogation. Logged when it bites.
MAX_CLARIFICATIONS = 4


def _parse_hour(value: str, default_h: int) -> int:
    try:
        return max(0, min(23, int(str(value).split(":")[0])))
    except (ValueError, IndexError):
        return default_h


def _fmt(dt: datetime) -> str:
    return dt.strftime("%a %b %d %H:%M")


def _matches(subject: str, category: str, keywords: list[str]) -> bool:
    hay = f"{subject} {category}".lower()
    return any(kw.strip() and kw.strip().lower() in hay for kw in keywords)


# ---------- graph state ---------------------------------------------------


class PlannerState(TypedDict, total=False):
    people: list[str]
    urgency: str
    subject: str
    duration_min: int
    # resolved config
    always_override: list[str]
    never_override: list[str]
    workday_start_h: int
    workday_end_h: int
    window_start: datetime
    window_end: datetime
    # working data
    conflicts: list[dict[str, Any]]
    proposed: list[datetime]
    chosen: datetime
    responses: list[dict[str, str]]


# ---------- nodes ---------------------------------------------------------

# The live invite is handed from `send` to `monitor` out-of-band so we don't
# put a non-serializable COM object into the graph state.
_LAST_INVITE: "ol.AppointmentItem | None" = None


def load_config_node(state: PlannerState) -> PlannerState:
    node_start("load_config", {"urgency": state["urgency"]})
    cfg = load_agent_config()
    token(f"loaded config keys: {sorted(cfg.keys()) or 'none'}", node="load_config")

    always = [str(x) for x in cfg.get("alwaysOverride", []) if isinstance(x, str)]
    never = [str(x) for x in cfg.get("neverOverride", []) if isinstance(x, str)]
    start_h = _parse_hour(cfg.get("workdayStart", "09:00"), 9)
    end_h = _parse_hour(cfg.get("workdayEnd", "17:00"), 17)

    horizon = URGENCY_HORIZON_DAYS.get(state["urgency"], 7)
    now = datetime.now()
    window_start = now + timedelta(minutes=30)  # small buffer
    window_end = (now + timedelta(days=horizon)).replace(
        hour=end_h, minute=0, second=0, microsecond=0
    )

    node_end("load_config", progress=0.1)
    return {
        "always_override": always,
        "never_override": never,
        "workday_start_h": start_h,
        "workday_end_h": end_h,
        "window_start": window_start,
        "window_end": window_end,
    }


def scan_node(state: PlannerState) -> PlannerState:
    node_start("scan", {"people": state["people"]})
    app = ol.Application()
    ns = app.GetNamespace("MAPI")

    window_start = state["window_start"]
    window_end = state["window_end"]

    # Organizer ("Me") plus each invitee. Real COM: GetDefaultFolder for self,
    # GetSharedDefaultFolder(recipient, ...) for others.
    owners: list[tuple[str, ol.Folder]] = [("Me", ns.GetDefaultFolder(ol.OL_FOLDER_CALENDAR))]
    for person in state["people"]:
        tool_call("outlook.GetSharedDefaultFolder", args={"recipient": person}, node="scan")
        folder = ns.GetSharedDefaultFolder(ns.CreateRecipient(person), ol.OL_FOLDER_CALENDAR)
        tool_result("outlook.GetSharedDefaultFolder", ok=True, items=folder.Items.Count, node="scan")
        owners.append((person, folder))

    conflicts: list[dict[str, Any]] = []
    for owner, folder in owners:
        for appt in folder.Items:
            if window_start <= appt.Start <= window_end:
                conflicts.append(
                    {
                        "person": owner,
                        "subject": appt.Subject,
                        "start": appt.Start,
                        "end": appt.End,
                        "busy": appt.BusyStatus,
                        "category": appt.Categories,
                        "klass": "",  # filled by classify
                    }
                )

    token(f"found {len(conflicts)} appointments in the {state['urgency']} window", node="scan")
    node_end("scan", progress=0.3)
    return {"conflicts": conflicts}


def classify_node(state: PlannerState) -> PlannerState:
    node_start("classify", {"count": len(state.get("conflicts", []))})
    always = state["always_override"]
    never = state["never_override"]

    for c in state["conflicts"]:
        if _matches(c["subject"], c["category"], always):
            c["klass"] = "overridable"
        elif _matches(c["subject"], c["category"], never):
            c["klass"] = "hard"
        elif c["busy"] == ol.OL_FREE:
            c["klass"] = "overridable"  # free slots never block
        else:
            c["klass"] = "ambiguous"

    counts = {
        k: sum(1 for c in state["conflicts"] if c["klass"] == k)
        for k in ("overridable", "hard", "ambiguous")
    }
    custom({"kind": "classification", "counts": counts}, node="classify")
    token(
        f"overridable={counts['overridable']} hard={counts['hard']} "
        f"ambiguous={counts['ambiguous']}",
        node="classify",
    )
    node_end("classify", progress=0.45)
    return {"conflicts": state["conflicts"]}


def clarify_node(state: PlannerState) -> PlannerState:
    node_start("clarify", {})
    conflicts = state["conflicts"]

    # Ask once per distinct ambiguous subject; resolve all rows with that
    # subject from the single answer.
    ambiguous_subjects: list[str] = []
    for c in conflicts:
        if c["klass"] == "ambiguous" and c["subject"] not in ambiguous_subjects:
            ambiguous_subjects.append(c["subject"])

    if not ambiguous_subjects:
        token("no ambiguous meetings — nothing to clarify", node="clarify")
        node_end("clarify", progress=0.6)
        return {"conflicts": conflicts}

    if len(ambiguous_subjects) > MAX_CLARIFICATIONS:
        token(
            f"{len(ambiguous_subjects)} ambiguous subjects; asking about the "
            f"first {MAX_CLARIFICATIONS}, treating the rest as hard conflicts",
            node="clarify",
        )

    asked = ambiguous_subjects[:MAX_CLARIFICATIONS]
    deferred = ambiguous_subjects[MAX_CLARIFICATIONS:]
    learn_always: list[str] = []
    learn_never: list[str] = []

    for subject in asked:
        answer = ask_user(
            f"You have '{subject}' meetings clashing. Can these be overridden?",
            choices=["Override once", "Always override", "Never override", "Keep busy"],
            node="clarify",
        )
        a = answer.strip().lower()
        if "always" in a:
            resolution = "overridable"
            learn_always.append(subject)
        elif "never" in a:
            resolution = "hard"
            learn_never.append(subject)
        elif "override" in a:  # "override once"
            resolution = "overridable"
        else:  # "keep busy" / anything else
            resolution = "hard"
        for c in conflicts:
            if c["subject"] == subject and c["klass"] == "ambiguous":
                c["klass"] = resolution

    # Anything we didn't get to is treated as a hard conflict for this run.
    for c in conflicts:
        if c["klass"] == "ambiguous" and c["subject"] in deferred:
            c["klass"] = "hard"

    # Learn over time: persist the durable decisions into the agent's config.
    if learn_always or learn_never:
        patch: dict[str, Any] = {"append": {}}
        if learn_always:
            patch["append"]["alwaysOverride"] = learn_always
        if learn_never:
            patch["append"]["neverOverride"] = learn_never
        config_patch(append=patch["append"], node="clarify")
        token(
            f"learned: always={learn_always or '—'} never={learn_never or '—'}",
            node="clarify",
        )

    node_end("clarify", progress=0.6)
    return {"conflicts": conflicts}


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start < b_end and b_start < a_end


def propose_node(state: PlannerState) -> PlannerState:
    node_start("propose", {})
    duration = int(state["duration_min"])
    start_h = state["workday_start_h"]
    end_h = state["workday_end_h"]
    window_end = state["window_end"]
    now = datetime.now()

    # Only hard conflicts block a slot; overridable ones are considered free.
    blocked = [
        (c["start"], c["end"]) for c in state["conflicts"] if c["klass"] == "hard"
    ]

    proposed: list[datetime] = []
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= window_end and len(proposed) < 3:
        if day.weekday() < 5:  # weekdays only
            t = day.replace(hour=start_h)
            day_close = day.replace(hour=end_h)
            while t + timedelta(minutes=duration) <= day_close:
                slot_end = t + timedelta(minutes=duration)
                if t >= now + timedelta(minutes=30) and t <= window_end:
                    if not any(_overlaps(t, slot_end, b0, b1) for b0, b1 in blocked):
                        proposed.append(t)
                        if len(proposed) >= 3:
                            break
                t += timedelta(minutes=30)
        day += timedelta(days=1)

    if proposed:
        custom(
            {"kind": "proposed_slots", "slots": [_fmt(s) for s in proposed]},
            node="propose",
        )
        for s in proposed:
            token(f"candidate: {_fmt(s)}", node="propose")
    else:
        token("no free slot found in the urgency window", node="propose")

    node_end("propose", progress=0.75)
    return {"proposed": proposed}


def confirm_node(state: PlannerState) -> PlannerState:
    node_start("confirm", {})
    proposed = state.get("proposed", [])
    if not proposed:
        node_end("confirm", progress=0.78)
        return {}

    choices = [_fmt(s) for s in proposed]
    answer = ask_user(
        f"Pick a time for '{state['subject']}' ({state['duration_min']} min):",
        choices=choices,
        node="confirm",
    )
    chosen = proposed[0]
    a = answer.strip().lower()
    for s in proposed:
        if _fmt(s).lower() in a or a in _fmt(s).lower():
            chosen = s
            break
    token(f"chosen: {_fmt(chosen)}", node="confirm")
    node_end("confirm", progress=0.82)
    return {"chosen": chosen}


def send_node(state: PlannerState) -> PlannerState:
    global _LAST_INVITE
    node_start("send", {})
    if "chosen" not in state:
        token("nothing to send (no slot chosen)", node="send")
        node_end("send", progress=0.85)
        return {}

    app = ol.Application()
    invite = app.CreateItem(ol.OL_APPOINTMENT_ITEM)
    invite.Subject = state["subject"]
    invite.Start = state["chosen"]
    invite.Duration = int(state["duration_min"])
    invite.MeetingStatus = ol.OL_MEETING
    for person in state["people"]:
        invite.Recipients.Add(person)

    tool_call(
        "outlook.AppointmentItem.Send",
        args={"subject": invite.Subject, "start": _fmt(invite.Start), "to": state["people"]},
        node="send",
    )
    invite.Send()
    tool_result("outlook.AppointmentItem.Send", ok=True, recipients=invite.Recipients.Count, node="send")
    token(f"invite sent to {len(state['people'])} people", node="send")

    # Hand the live invite to monitor out-of-band (see _LAST_INVITE) so we can
    # poll the same Recipients objects without polluting the graph state.
    _LAST_INVITE = invite
    node_end("send", progress=0.88)
    return {}


def monitor_node(state: PlannerState) -> PlannerState:
    node_start("monitor", {})
    invite = _LAST_INVITE
    if invite is None:
        node_end("monitor", progress=1.0)
        return {"responses": []}

    import time

    recipients = list(invite.Recipients)
    final: dict[str, str] = {}
    ticks = 6
    for i in range(ticks):
        for r in recipients:
            status = r.MeetingResponseStatus
            if status != ol.OL_RESPONSE_NONE:
                final[r.Name] = ol.RESPONSE_NAME[status]
        answered = len(final)
        token(f"responses: {answered}/{len(recipients)}", node="monitor")
        node_end("monitor", progress=0.88 + 0.12 * ((i + 1) / ticks))
        if answered >= len(recipients):
            break
        time.sleep(1.0)

    responses = [
        {"person": r.Name, "status": final.get(r.Name, "No response (pending)")}
        for r in recipients
    ]
    custom({"kind": "responses", "responses": responses}, node="monitor")
    return {"responses": responses}


def _build_artifact(state: PlannerState) -> str:
    lines = [f"# Meeting plan — {state['subject']}", ""]
    if "chosen" in state:
        end = state["chosen"] + timedelta(minutes=int(state["duration_min"]))
        lines += [
            f"**When:** {_fmt(state['chosen'])} – {end.strftime('%H:%M')} "
            f"({state['duration_min']} min)",
            f"**Urgency:** {state['urgency']}",
            f"**Attendees:** {', '.join(state['people'])}",
            "",
        ]
    else:
        lines += ["_No suitable slot was found in the urgency window._", ""]

    responses = state.get("responses", [])
    if responses:
        lines += ["## Invite responses", "", "| Attendee | Status |", "| --- | --- |"]
        lines += [f"| {r['person']} | {r['status']} |" for r in responses]
        lines.append("")

    overridden = [c for c in state.get("conflicts", []) if c["klass"] == "overridable"]
    if overridden:
        lines += ["## Conflicts overridden", "", "| Person | Meeting | When |", "| --- | --- | --- |"]
        lines += [
            f"| {c['person']} | {c['subject']} | {_fmt(c['start'])} |" for c in overridden
        ]
        lines.append("")

    hard = [c for c in state.get("conflicts", []) if c["klass"] == "hard"]
    if hard:
        lines += ["## Hard conflicts respected", "", "| Person | Meeting | When |", "| --- | --- | --- |"]
        lines += [
            f"| {c['person']} | {c['subject']} | {_fmt(c['start'])} |" for c in hard
        ]
        lines.append("")

    return "\n".join(lines)


def finalize_node(state: PlannerState) -> PlannerState:
    node_start("summarize", {})
    md = _build_artifact(state)
    artifact("meeting-plan.md", "md", md, node="summarize")
    node_end("summarize", progress=1.0)
    return {}


def build_graph():
    g = StateGraph(PlannerState)
    g.add_node("load_config", load_config_node)
    g.add_node("scan", scan_node)
    g.add_node("classify", classify_node)
    g.add_node("clarify", clarify_node)
    g.add_node("propose", propose_node)
    g.add_node("confirm", confirm_node)
    g.add_node("send", send_node)
    g.add_node("monitor", monitor_node)
    g.add_node("summarize", finalize_node)
    g.add_edge(START, "load_config")
    g.add_edge("load_config", "scan")
    g.add_edge("scan", "classify")
    g.add_edge("classify", "clarify")
    g.add_edge("clarify", "propose")
    g.add_edge("propose", "confirm")
    g.add_edge("confirm", "send")
    g.add_edge("send", "monitor")
    g.add_edge("monitor", "summarize")
    g.add_edge("summarize", END)
    return g.compile()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--people", default="")
    parser.add_argument("--urgency", default="7d")
    parser.add_argument("--subject", default="Meeting")
    parser.add_argument("--duration_min", default="30")
    args = parser.parse_args()

    people = [p.strip() for p in args.people.split(",") if p.strip()]
    if not people:
        emit_error("at least one person is required")
        done(ok=False, error="no_people")
        sys.exit(1)

    urgency = args.urgency if args.urgency in URGENCY_HORIZON_DAYS else "7d"
    try:
        duration_min = max(5, int(float(args.duration_min)))
    except (TypeError, ValueError):
        duration_min = 30

    # The config may carry a default duration; honour it when the form left
    # the default. (The form default is 30, so we only override if config sets
    # something and the user didn't change it — kept simple here.)
    cfg = load_agent_config()
    if args.duration_min in ("", "30") and isinstance(cfg.get("defaultDurationMin"), (int, float)):
        duration_min = max(5, int(cfg["defaultDurationMin"]))

    try:
        graph = build_graph()
        result = graph.invoke(
            {
                "people": people,
                "urgency": urgency,
                "subject": args.subject or "Meeting",
                "duration_min": duration_min,
            }
        )
        chosen = result.get("chosen")
        summary = (
            f"{args.subject} scheduled for {_fmt(chosen)}"
            if chosen
            else "No slot found"
        )
        done(ok=True, summary=summary)
        sys.exit(0)
    except Exception as err:  # noqa: BLE001
        emit_error(str(err))
        done(ok=False, error=str(err))
        sys.exit(1)


if __name__ == "__main__":
    main()
