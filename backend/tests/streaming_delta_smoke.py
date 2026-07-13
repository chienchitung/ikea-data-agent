"""Smoke tests for the /chat/stream token-streaming pipeline.

Stubs coordinator_executor.astream() with a scripted (mode, chunk) sequence and
asserts that process_chat_detailed():
- forwards agent-node text chunks as {"phase": "delta", "text": ...} payloads,
- filters out tool-node chunks and tool_call chunks,
- emits {"reset": true} when a new AI message supersedes an interim one,
- still returns the final state's answer as the response.

No Gemini API key or network access is required.
"""

import asyncio
import os
import sys
from pathlib import Path

os.environ.setdefault("GOOGLE_API_KEY", "dummy")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage

import agent_logic


class _StubExecutor:
    def __init__(self, script):
        self._script = script

    async def astream(self, _input, stream_mode=None):
        assert set(stream_mode or []) == {"messages", "values"}, stream_mode
        for item in self._script:
            yield item


def _tool_call_chunk(name: str) -> dict:
    return {"name": name, "args": "", "id": "call_1", "index": 0, "type": "tool_call_chunk"}


async def _run_chat(script, message="請幫我打聲招呼"):
    agent_logic.coordinator_executor = _StubExecutor(script)
    events = []

    async def progress_callback(payload):
        events.append(payload)

    result = await agent_logic.process_chat_detailed(
        message,
        chat_history=[],
        conversation_id=None,
        turn_context={"relation": "standalone"},
        progress_callback=progress_callback,
    )
    deltas = [event for event in events if event.get("phase") == "delta"]
    return result, deltas


async def test_deltas_forwarded_and_filtered():
    final_message = AIMessage(content="這是一段沒有數字的完整回覆。")
    script = [
        ("messages", (AIMessageChunk(content="這是一段", id="m1"), {"langgraph_node": "agent"})),
        # A chunk carrying tool-call deltas must not reach the user.
        ("messages", (
            AIMessageChunk(content="", id="m1", tool_call_chunks=[_tool_call_chunk("query_worksheet_data")]),
            {"langgraph_node": "agent"},
        )),
        # Tool-node output must not reach the user either.
        ("messages", (AIMessageChunk(content="TOOL NOISE", id="t1"), {"langgraph_node": "action"})),
        ("messages", (AIMessageChunk(content="沒有數字的完整回覆。", id="m1"), {"langgraph_node": "agent"})),
        ("values", {"messages": [HumanMessage(content="hi"), final_message]}),
    ]

    result, deltas = await _run_chat(script)

    streamed = "".join(delta.get("text", "") for delta in deltas)
    assert streamed == "這是一段沒有數字的完整回覆。", streamed
    assert not any(delta.get("reset") for delta in deltas), deltas
    assert result["response"] == "這是一段沒有數字的完整回覆。", result["response"]
    # No digits and no tool context -> the LLM verification round trip is skipped.
    assert result["metadata"]["verification"]["status"] == "skipped", result["metadata"]["verification"]
    print("PASS: deltas forwarded, tool chunks filtered, verification skipped")


async def test_reset_on_new_message():
    final_message = AIMessage(content="正式回答。")
    script = [
        # Interim message the graph later abandons (retry path).
        ("messages", (AIMessageChunk(content="我來查詢一下", id="m1"), {"langgraph_node": "agent"})),
        # A new AI message starts -> frontend must discard the interim text.
        ("messages", (AIMessageChunk(content="正式回答。", id="m2"), {"langgraph_node": "agent"})),
        ("values", {"messages": [HumanMessage(content="hi"), final_message]}),
    ]

    result, deltas = await _run_chat(script)

    reset_indices = [i for i, delta in enumerate(deltas) if delta.get("reset")]
    assert len(reset_indices) == 1, deltas
    after_reset = "".join(delta.get("text", "") for delta in deltas[reset_indices[0]:])
    assert after_reset == "正式回答。", after_reset
    assert result["response"] == "正式回答。", result["response"]
    print("PASS: reset emitted when a new AI message supersedes the interim one")


async def main():
    await test_deltas_forwarded_and_filtered()
    await test_reset_on_new_message()
    print("streaming delta smoke tests passed")


if __name__ == "__main__":
    asyncio.run(main())
