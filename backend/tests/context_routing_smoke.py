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
        AIMessage(content="上一則回答已包含 Request ticket 數量、資料來源與負責人分布。"),
        HumanMessage(content="可以提供比較完整且有結構的分析報告嗎"),
    ]

    extracted = _extract_turn_context(messages)

    assert extracted["relation"] == "context_refinement"
    assert extracted["should_skip_clarification"] is True
    assert _should_answer_from_context(extracted, messages) is True


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
    print("context routing smoke tests passed")


if __name__ == "__main__":
    run()
