"""
quick-note — a minimal Python agent demonstrating ask_user.

The agent asks the user for a note body and a tag, then emits a timestamped
markdown artifact summarising the note.

Run standalone (you'll need to feed answer JSONL on stdin manually):
    python main.py --prefix "Note"
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

# Make `agent_util` importable from the parent agents/ directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_util import (  # noqa: E402
    artifact,
    ask_user,
    done,
    emit_error,
    node_end,
    node_start,
    token,
)


def slugify(s: str) -> str:
    cleaned = "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")
    return cleaned or "note"


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture a quick note from the user.")
    parser.add_argument("--prefix", default="Note", help="Heading label for the note.")
    args = parser.parse_args()

    try:
        node_start("collect", {"prefix": args.prefix})
        body = ask_user("What would you like to note?", node="collect")
        token(f"got note: {body[:60]}{'…' if len(body) > 60 else ''}", node="collect")

        tag = ask_user(
            "Pick a tag (or type your own):",
            choices=["work", "personal", "idea", "todo"],
            node="collect",
        )
        node_end("collect", progress=0.6)

        node_start("save")
        now = datetime.now()
        timestamp = now.isoformat(timespec="seconds")
        md = (
            f"# {args.prefix}: {body[:48]}{'…' if len(body) > 48 else ''}\n\n"
            f"- **Tag:** {tag}\n"
            f"- **Captured:** {timestamp}\n\n"
            f"> {body}\n"
        )
        artifact_name = f"note-{slugify(tag)}-{now.strftime('%Y%m%d-%H%M%S')}.md"
        artifact(artifact_name, "md", md, node="save")
        token(f"saved {artifact_name}", node="save")
        node_end("save", progress=1.0)

        done(ok=True, summary=f"Captured note tagged '{tag}'")
        return 0
    except Exception as e:  # noqa: BLE001
        emit_error(str(e))
        done(ok=False, error=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
