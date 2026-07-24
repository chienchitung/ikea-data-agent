"""Smoke tests for _build_meeting_context_messages (agent_logic.py):

- Formats selected meeting records into a single SystemMessage.
- Skips non-dict entries and entries with empty content.
- Enforces a combined character budget across all selected meetings,
  dropping later selections that would exceed it and noting how many
  were omitted (rather than truncating every meeting evenly).
- Returns [] for no/empty input.

No Gemini API key or network access is required.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("GOOGLE_API_KEY", "dummy")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import agent_logic


def test_formats_single_meeting():
    messages = agent_logic._build_meeting_context_messages([
        {"title": "Quarterly Roadmap Sync", "content": "Discussed Q3 priorities."},
    ])
    assert len(messages) == 1, messages
    assert "Quarterly Roadmap Sync" in messages[0].content
    assert "Discussed Q3 priorities." in messages[0].content
    print("PASS: single meeting formatted into one SystemMessage")


def test_skips_invalid_entries():
    messages = agent_logic._build_meeting_context_messages([
        {"title": "Empty", "content": ""},
        {"title": "", "content": ""},
        "not a dict",
        None,
    ])
    assert messages == [], messages
    print("PASS: entries with no usable content produce no message")


def test_empty_or_none_input():
    assert agent_logic._build_meeting_context_messages(None) == []
    assert agent_logic._build_meeting_context_messages([]) == []
    print("PASS: None/[] input returns no messages")


def test_total_budget_drops_later_meetings():
    # Each meeting's content is capped per-meeting at
    # _MEETING_CONTEXT_CHAR_LIMIT (8000) before the total budget is
    # applied, so 4 meetings of 10000 raw chars each land as 4 x 8000 =
    # 32000 — over the 24000 total budget. The first 3 (24000) should fit
    # exactly; the 4th should be dropped with an omission note.
    meetings = [{"title": f"Meeting {i}", "content": "x" * 10000} for i in range(1, 5)]
    messages = agent_logic._build_meeting_context_messages(meetings)
    assert len(messages) == 1
    content = messages[0].content
    assert "Meeting 1" in content and "Meeting 2" in content and "Meeting 3" in content
    assert "Meeting 4" not in content
    assert "1 筆會議記錄" in content
    print("PASS: total character budget enforced, over-budget meeting omitted with a note")


def test_under_budget_no_omission_note():
    messages = agent_logic._build_meeting_context_messages([
        {"title": "Small", "content": "short content"},
    ])
    assert "筆會議記錄" not in messages[0].content
    print("PASS: no omission note when comfortably under budget")


def main():
    test_formats_single_meeting()
    test_skips_invalid_entries()
    test_empty_or_none_input()
    test_total_budget_drops_later_meetings()
    test_under_budget_no_omission_note()
    print("meeting context smoke tests passed")


if __name__ == "__main__":
    main()
