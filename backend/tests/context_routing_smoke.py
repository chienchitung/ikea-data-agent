import json
import os
import sys
from pathlib import Path

os.environ.setdefault("GOOGLE_API_KEY", "dummy")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from agents.coordinator import _extract_turn_context, _should_answer_from_context


def turn_context_message(payload):
    return SystemMessage(content=(
        "## Turn Context Decision\n\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    ))


def prior_tool_context_message(summary="Worksheet: Request | Total rows: 42"):
    # Mirrors agent_logic.py's _build_prior_tool_context(): _should_answer_from_context()
    # only treats a turn as "answerable from context" when the history contains an
    # actual ToolMessage or a "## Prior Tool Context" SystemMessage — a plain prior
    # AIMessage alone does not count (see _has_answerable_context_before_latest_human's
    # docstring/comment in coordinator.py). Tests must include this message to
    # accurately simulate what the real pipeline builds before the coordinator LLM runs.
    return SystemMessage(content=f"## Prior Tool Context\n\n以下是同一對話先前工具查詢取得的資料。\n\n{summary}")


def test_context_refinement_can_answer_from_prior_answer():
    payload = {
        "relation": "context_refinement",
        "should_answer_from_context": True,
        "should_include_prior_tool_context": True,
        "should_force_fresh_tool": False,
        "should_skip_clarification": True,
        "domain_hint": "analyst",
        "confidence": 0.92,
        "reason": "使用者是在要求把上一則分析整理得更完整。",
    }
    messages = [
        turn_context_message(payload),
        prior_tool_context_message(),
        AIMessage(content="上一則回答已包含 Request ticket 數量、資料來源與負責人分布。"),
        HumanMessage(content="可以提供比較完整且有結構的分析報告嗎"),
    ]

    extracted = _extract_turn_context(messages)

    assert extracted["relation"] == "context_refinement"
    assert extracted["should_skip_clarification"] is True
    assert _should_answer_from_context(extracted, messages) is True


def test_broad_term_follow_up_does_not_force_fresh_tool():
    # Regression guard for the _FRESH_DATA_TERMS -> _CORRECTION_CHALLENGE_TERMS trim:
    # generic terms like "分析"/"部門" used to force-veto should_answer_from_context
    # even when the router already judged prior tool context sufficient.
    payload = {
        "relation": "context_follow_up",
        "should_answer_from_context": True,
        "should_include_prior_tool_context": True,
        "should_force_fresh_tool": False,
        "should_skip_clarification": True,
        "domain_hint": "analyst",
        "confidence": 0.9,
        "reason": "使用者延續上一則的部門統計繼續追問。",
    }
    messages = [
        turn_context_message(payload),
        prior_tool_context_message(),
        AIMessage(content="上一則回答已包含各部門的工單數量分布。"),
        HumanMessage(content="各部門的工單數量可以怎麼分析？"),
    ]

    extracted = _extract_turn_context(messages)

    assert _should_answer_from_context(extracted, messages) is True


def test_correction_challenge_still_forces_fresh_tool():
    # The narrowed _CORRECTION_CHALLENGE_TERMS list must still veto
    # should_answer_from_context for genuine correctness challenges.
    payload = {
        "relation": "context_follow_up",
        "should_answer_from_context": True,
        "should_include_prior_tool_context": True,
        "should_force_fresh_tool": False,
        "should_skip_clarification": True,
        "domain_hint": "analyst",
        "confidence": 0.9,
        "reason": "使用者在質疑上一則資料是否正確。",
    }
    messages = [
        turn_context_message(payload),
        prior_tool_context_message(),
        AIMessage(content="上一則回答顯示本月共 42 筆工單。"),
        HumanMessage(content="你確定這個數字正確嗎"),
    ]

    extracted = _extract_turn_context(messages)

    assert _should_answer_from_context(extracted, messages) is False


def test_fresh_tool_request_does_not_answer_from_context():
    payload = {
        "relation": "fresh_tool_request",
        "should_answer_from_context": True,
        "should_include_prior_tool_context": False,
        "should_force_fresh_tool": True,
        "should_skip_clarification": False,
        "domain_hint": "analyst",
        "confidence": 0.88,
        "reason": "使用者要求重新查詢最新資料。",
    }
    messages = [
        turn_context_message(payload),
        AIMessage(content="上一則回答是舊的摘要。"),
        HumanMessage(content="重新查一次最新資料再整理成圖表"),
    ]

    extracted = _extract_turn_context(messages)

    assert extracted["should_force_fresh_tool"] is True
    assert _should_answer_from_context(extracted, messages) is False


def run():
    test_context_refinement_can_answer_from_prior_answer()
    test_fresh_tool_request_does_not_answer_from_context()
    test_broad_term_follow_up_does_not_force_fresh_tool()
    test_correction_challenge_still_forces_fresh_tool()
    print("context routing smoke tests passed")


if __name__ == "__main__":
    run()
