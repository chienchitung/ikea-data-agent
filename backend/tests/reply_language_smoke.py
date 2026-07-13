"""Smoke tests for reply-language detection.

Covers the regression where a Chinese question quoting English category names
("請根據這幾個構面分類… 1. Dashboard Development & Optimization …") was
classified as an English question because the old heuristic compared raw
character counts, which made the whole reply come back in English.

No Gemini API key or network access is required.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("GOOGLE_API_KEY", "dummy")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from reply_language import detect_reply_language_text, normalize_reply_language

import agent_logic
from agents.coordinator import _sanitize_turn_context

FAILING_QUERY = (
    "請根據這幾個構面分類，將今年4,5,6月的所有需求工單列出之後進行分類\n"
    "1. Dashboard Development & Optimization\n"
    "2. Customer Behavior & Segmentation Analysis\n"
    "3. Data Extraction & Reporting\n"
    "4. Other support"
)


def test_heuristic():
    cases = [
        (FAILING_QUERY, "Traditional Chinese"),
        ("Show me all tickets from April", "English"),
        ("list all tickets with status 已完成", "English"),
        ("列出全部工單", "Traditional Chinese"),
        ("", "Traditional Chinese"),
        ("幫我畫一張 Status 分佈的 chart", "Traditional Chinese"),
    ]
    for query, expected in cases:
        got = detect_reply_language_text(query)
        assert got == expected, f"{query[:30]!r}: got {got}, expected {expected}"
    print("PASS: heuristic keeps Chinese questions Chinese despite English terms")


def test_normalize():
    cases = [
        ("zh-TW", "Traditional Chinese"),
        ("zh-Hant", "Traditional Chinese"),
        ("Traditional Chinese", "Traditional Chinese"),
        ("en", "English"),
        ("English", "English"),
        ("fr", ""),
        (None, ""),
        ("", ""),
    ]
    for value, expected in cases:
        got = normalize_reply_language(value)
        assert got == expected, f"{value!r}: got {got!r}, expected {expected!r}"
    print("PASS: reply_language values normalized, invalid ones rejected")


def test_sanitize_turn_context_reply_language():
    sanitized = _sanitize_turn_context({"relation": "standalone", "reply_language": "zh-TW"})
    assert sanitized["reply_language"] == "Traditional Chinese", sanitized
    sanitized = _sanitize_turn_context({"relation": "standalone", "reply_language": "gibberish"})
    assert sanitized["reply_language"] == "", sanitized
    sanitized = _sanitize_turn_context({"relation": "standalone"})
    assert sanitized["reply_language"] == "", sanitized
    print("PASS: _sanitize_turn_context keeps valid reply_language, drops invalid")


def test_effective_reply_language_precedence():
    # LLM 判定優先於啟發式（就算啟發式會說英文）。
    got = agent_logic._effective_reply_language(
        {"reply_language": "Traditional Chinese"},
        "Show me all tickets from April",
    )
    assert got == "Traditional Chinese", got
    # 缺值/非法時退回啟發式。
    got = agent_logic._effective_reply_language({}, "Show me all tickets from April")
    assert got == "English", got
    got = agent_logic._effective_reply_language(None, FAILING_QUERY)
    assert got == "Traditional Chinese", got
    print("PASS: turn_context reply_language wins, heuristic is the fallback")


if __name__ == "__main__":
    test_heuristic()
    test_normalize()
    test_sanitize_turn_context_reply_language()
    test_effective_reply_language_precedence()
    print("reply language smoke tests passed")
