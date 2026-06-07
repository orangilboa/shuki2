"""
Mock Outlook desktop COM layer for the meeting-planner agent.

This deliberately mirrors the shape of the Outlook Object Model exposed by
`win32com.client.Dispatch("Outlook.Application")` so that swapping this module
for the real COM bindings later is mechanical. The names, constants, and call
sequences match what you'd write against real Outlook:

    import win32com.client
    app = win32com.client.Dispatch("Outlook.Application")   # <- replace Application()
    ns = app.GetNamespace("MAPI")
    cal = ns.GetDefaultFolder(OL_FOLDER_CALENDAR)
    for appt in cal.Items:
        appt.Subject, appt.Start, appt.End, appt.BusyStatus, appt.Categories
    invite = app.CreateItem(OL_APPOINTMENT_ITEM)
    invite.MeetingStatus = OL_MEETING
    invite.Recipients.Add("alice@contoso.com")
    invite.Send()
    invite.Recipients[1].MeetingResponseStatus   # 1-based in real COM

The mock seeds a deterministic-but-varied calendar per attendee (seeded by
name, like the traffic demo) with a realistic mix of low-signal items that are
override candidates ("Employee Holiday", "Team Lunch", "Town Hall") and hard
meetings. Invite responses arrive over a few seconds of wall-clock so the
agent's monitor step shows live progress.

Everything here is timezone-naive local datetime, dependency-free.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterator

# ---------- COM enum constants (values match real Outlook) ----------------

OL_FOLDER_CALENDAR = 9
OL_APPOINTMENT_ITEM = 1

# MeetingStatus (OlMeetingStatus)
OL_NON_MEETING = 0
OL_MEETING = 1

# BusyStatus (OlBusyStatus)
OL_FREE = 0
OL_TENTATIVE = 1
OL_BUSY = 2
OL_OUT_OF_OFFICE = 3

BUSY_STATUS_NAME = {
    OL_FREE: "Free",
    OL_TENTATIVE: "Tentative",
    OL_BUSY: "Busy",
    OL_OUT_OF_OFFICE: "OutOfOffice",
}

# ResponseStatus (OlResponseStatus)
OL_RESPONSE_NONE = 0
OL_RESPONSE_ORGANIZED = 1
OL_RESPONSE_TENTATIVE = 2
OL_RESPONSE_ACCEPTED = 3
OL_RESPONSE_DECLINED = 4

RESPONSE_NAME = {
    OL_RESPONSE_NONE: "None",
    OL_RESPONSE_ORGANIZED: "Organizer",
    OL_RESPONSE_TENTATIVE: "Tentative",
    OL_RESPONSE_ACCEPTED: "Accepted",
    OL_RESPONSE_DECLINED: "Declined",
}


# ---------- tiny deterministic RNG (seeded by name) -----------------------


def _seeded_rng(seed_str: str):
    """A small LCG seeded from a string — same approach as the traffic demo,
    so calendars are stable across runs for a given attendee."""
    seed = 0
    for ch in seed_str:
        seed = (seed * 31 + ord(ch)) & 0xFFFFFFFF
    state = {"s": seed or 1}

    def rand() -> float:
        state["s"] = (state["s"] * 1664525 + 1013904223) & 0xFFFFFFFF
        return state["s"] / 0xFFFFFFFF

    return rand


# Subjects that are commonly low-signal / overridable.
_SOFT_SUBJECTS = [
    ("Employee Holiday", OL_OUT_OF_OFFICE, "Notification"),
    ("Team Lunch", OL_FREE, "Social"),
    ("Town Hall", OL_TENTATIVE, "Company"),
    ("Lunch & Learn (optional)", OL_FREE, "Optional"),
    ("Focus Time", OL_TENTATIVE, "Personal"),
    ("Gym", OL_FREE, "Personal"),
    ("Out of office", OL_OUT_OF_OFFICE, "Notification"),
]

# Subjects that are usually hard conflicts.
_HARD_SUBJECTS = [
    ("1:1 with Manager", OL_BUSY, "Management"),
    ("Sprint Planning", OL_BUSY, "Engineering"),
    ("Customer Demo", OL_BUSY, "Sales"),
    ("Interview Panel", OL_BUSY, "Hiring"),
    ("Board Meeting", OL_BUSY, "Exec"),
]


# ---------- model objects -------------------------------------------------


@dataclass
class Recipient:
    """Mirror of an Outlook Recipient on a meeting. In real COM the response
    status is read-only and updated by the transport; here it's computed from
    elapsed wall-clock since the invite was sent."""

    Name: str
    _send_monotonic: float | None = None
    _delay_s: float = 0.0
    _outcome: int = OL_RESPONSE_ACCEPTED

    @property
    def MeetingResponseStatus(self) -> int:
        if self._send_monotonic is None:
            return OL_RESPONSE_NONE
        if (time.monotonic() - self._send_monotonic) >= self._delay_s:
            return self._outcome
        return OL_RESPONSE_NONE


class Recipients:
    """Mirror of the Recipients collection. NOTE: real Outlook Recipients are
    1-based; we honour that in __getitem__ so call sites match."""

    def __init__(self) -> None:
        self._items: list[Recipient] = []

    def Add(self, name: str) -> Recipient:
        r = Recipient(Name=name)
        self._items.append(r)
        return r

    @property
    def Count(self) -> int:
        return len(self._items)

    def __getitem__(self, index: int) -> Recipient:
        # 1-based, like the COM collection.
        return self._items[index - 1]

    def __iter__(self) -> Iterator[Recipient]:
        return iter(self._items)


@dataclass
class AppointmentItem:
    """Mirror of an Outlook AppointmentItem."""

    Subject: str = ""
    Start: datetime = field(default_factory=datetime.now)
    Duration: int = 30  # minutes, as in COM
    BusyStatus: int = OL_BUSY
    Categories: str = ""
    MeetingStatus: int = OL_NON_MEETING
    Recipients: Recipients = field(default_factory=Recipients)
    Location: str = ""

    @property
    def End(self) -> datetime:
        return self.Start + timedelta(minutes=self.Duration)

    def Save(self) -> None:  # no-op in the mock
        pass

    def Send(self) -> None:
        """Dispatch the meeting request. Seeds each recipient's response delay
        and outcome deterministically so the monitor step sees staggered
        replies over a few seconds."""
        for i, r in enumerate(self.Recipients):
            rand = _seeded_rng(f"{self.Subject}|{r.Name}|{i}")
            r._send_monotonic = time.monotonic()
            r._delay_s = 1.0 + rand() * 4.0  # 1-5s
            roll = rand()
            r._outcome = (
                OL_RESPONSE_ACCEPTED
                if roll < 0.7
                else OL_RESPONSE_TENTATIVE
                if roll < 0.88
                else OL_RESPONSE_DECLINED
            )


class _Items:
    """Mirror of a Folder.Items collection. Iterable over AppointmentItems.
    Real COM also offers .Restrict(filter)/.Sort(...); the agent filters in
    Python instead, which is a common real-world pattern too."""

    def __init__(self, items: list[AppointmentItem]) -> None:
        self._items = sorted(items, key=lambda a: a.Start)

    @property
    def Count(self) -> int:
        return len(self._items)

    def __iter__(self) -> Iterator[AppointmentItem]:
        return iter(self._items)


class Folder:
    def __init__(self, owner: str, items: list[AppointmentItem]) -> None:
        self._owner = owner
        self.Items = _Items(items)


def _seed_calendar(owner: str, horizon_days: int = 40) -> list[AppointmentItem]:
    """Generate a deterministic, varied calendar for `owner` over the horizon."""
    rand = _seeded_rng(f"calendar::{owner}")
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    out: list[AppointmentItem] = []
    for day_offset in range(horizon_days):
        day = today + timedelta(days=day_offset)
        if day.weekday() >= 5:  # skip weekends for most items
            if rand() > 0.15:
                continue
        # 0-3 appointments per day.
        n = int(rand() * 3.5)
        used_hours: set[int] = set()
        for _ in range(n):
            hour = 9 + int(rand() * 8)  # 9..16
            if hour in used_hours:
                continue
            used_hours.add(hour)
            soft = rand() < 0.55
            pool = _SOFT_SUBJECTS if soft else _HARD_SUBJECTS
            subject, busy, category = pool[int(rand() * len(pool))]
            duration = 30 if rand() < 0.6 else 60
            start = day + timedelta(hours=hour)
            out.append(
                AppointmentItem(
                    Subject=subject,
                    Start=start,
                    Duration=duration,
                    BusyStatus=busy,
                    Categories=category,
                    MeetingStatus=OL_MEETING if not soft else OL_NON_MEETING,
                )
            )
    return out


class Namespace:
    """Mirror of the MAPI namespace."""

    def __init__(self, me: str) -> None:
        self._me = me

    def GetDefaultFolder(self, folder_type: int) -> Folder:
        if folder_type != OL_FOLDER_CALENDAR:
            raise ValueError("mock only supports OL_FOLDER_CALENDAR")
        return Folder(self._me, _seed_calendar(self._me))

    def CreateRecipient(self, name: str) -> Recipient:
        return Recipient(Name=name)

    def GetSharedDefaultFolder(self, recipient: "Recipient | str", folder_type: int) -> Folder:
        if folder_type != OL_FOLDER_CALENDAR:
            raise ValueError("mock only supports OL_FOLDER_CALENDAR")
        name = recipient.Name if isinstance(recipient, Recipient) else str(recipient)
        return Folder(name, _seed_calendar(name))


class Application:
    """Mirror of the Outlook.Application COM object.

    Real code:  win32com.client.Dispatch("Outlook.Application")
    Mock code:  Application(me="me@contoso.com")
    """

    def __init__(self, me: str = "me@contoso.com") -> None:
        self._me = me

    def GetNamespace(self, kind: str) -> Namespace:
        # Real COM expects "MAPI".
        return Namespace(self._me)

    def CreateItem(self, item_type: int) -> AppointmentItem:
        if item_type != OL_APPOINTMENT_ITEM:
            raise ValueError("mock only supports OL_APPOINTMENT_ITEM")
        return AppointmentItem()
