import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.messages import messages_from_dict, messages_to_dict


from storage_paths import CONVERSATION_STORE_DIR as STORE_DIR, AGENT_TRACE_DIR as TRACE_DIR
MAX_STORED_MESSAGES = 40
MAX_TOOL_CONTEXT_CHARS = 20000
MAX_TOOL_RESULTS = 30
MAX_MEMORY_SUMMARY_CHARS = 8000


def _safe_conversation_id(conversation_id: Optional[str]) -> Optional[str]:
    if not conversation_id:
        return None
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", conversation_id)
    return safe_id[:120] or None


def _conversation_path(conversation_id: Optional[str]) -> Optional[Path]:
    safe_id = _safe_conversation_id(conversation_id)
    if not safe_id:
        return None
    return STORE_DIR / f"{safe_id}.json"


def load_conversation_messages(conversation_id: Optional[str]):
    path = _conversation_path(conversation_id)
    if not path or not path.exists():
        return []

    try:
        with path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        return _visible_messages(messages_from_dict(payload.get("messages", [])))
    except Exception as e:
        print(f"⚠️ Failed to load conversation context: {e}")
        return []


def load_tool_context(conversation_id: Optional[str]) -> str:
    path = _conversation_path(conversation_id)
    if not path or not path.exists():
        return ""

    try:
        with path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload.get("tool_context", "")
    except Exception as e:
        print(f"⚠️ Failed to load tool context: {e}")
        return ""


def load_tool_results(conversation_id: Optional[str]) -> list[dict]:
    path = _conversation_path(conversation_id)
    if not path or not path.exists():
        return []

    try:
        with path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        results = payload.get("tool_results", [])
        return results if isinstance(results, list) else []
    except Exception as e:
        print(f"⚠️ Failed to load structured tool results: {e}")
        return []


def load_memory_summary(conversation_id: Optional[str]) -> str:
    path = _conversation_path(conversation_id)
    if not path or not path.exists():
        return ""

    try:
        with path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        return str(payload.get("memory_summary", "") or "")
    except Exception as e:
        print(f"⚠️ Failed to load memory summary: {e}")
        return ""


def _has_tool_calls(message) -> bool:
    return bool(getattr(message, "tool_calls", None))


def _text_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return str(content)


def _visible_messages(messages):
    visible = []
    for message in messages:
        if isinstance(message, HumanMessage):
            visible.append(message)
        elif isinstance(message, AIMessage) and not _has_tool_calls(message):
            content = _text_content(message.content).strip()
            if content:
                visible.append(AIMessage(content=content))
    return visible[-MAX_STORED_MESSAGES:]


def _tool_context(messages) -> str:
    chunks = []
    for message in messages:
        if getattr(message, "type", "") == "tool" or message.__class__.__name__ == "ToolMessage":
            name = getattr(message, "name", "") or "tool"
            content = _text_content(message.content).strip()
            if content:
                chunks.append(f"[{name}]\n{content}")

    context = "\n\n".join(chunks)
    if len(context) > MAX_TOOL_CONTEXT_CHARS:
        return context[-MAX_TOOL_CONTEXT_CHARS:]
    return context


def _structured_tool_results(messages) -> list[dict]:
    results = []
    for message in messages:
        if getattr(message, "type", "") != "tool" and message.__class__.__name__ != "ToolMessage":
            continue
        name = getattr(message, "name", "") or "tool"
        content = _text_content(message.content).strip()
        if not content:
            continue
        results.append({
            "name": name,
            "content": content,
            "preview": content[:800],
            "char_count": len(content),
            "saved_at": datetime.now(timezone.utc).isoformat(),
        })
    return results[-MAX_TOOL_RESULTS:]


def _memory_summary(messages) -> str:
    visible = _visible_messages(messages)
    if not visible:
        return ""

    lines = [
        "這是同一個對話的持續記憶摘要，供長對話延續脈絡使用。",
        "請以最新使用者問題為主，只在追問或延續前文時引用摘要。",
    ]

    first_user = next((m for m in visible if isinstance(m, HumanMessage)), None)
    if first_user:
        lines.append(f"起始需求：{_text_content(first_user.content).strip()[:700]}")

    user_turns = [
        _text_content(m.content).strip()
        for m in visible
        if isinstance(m, HumanMessage) and _text_content(m.content).strip()
    ][-8:]
    if user_turns:
        lines.append("近期使用者意圖：")
        lines.extend(f"- {turn[:500]}" for turn in user_turns)

    assistant_turns = [
        _text_content(m.content).strip()
        for m in visible
        if isinstance(m, AIMessage) and _text_content(m.content).strip()
    ][-5:]
    if assistant_turns:
        lines.append("近期助理回答重點：")
        # Keep the most recent assistant turn at full detail so the classifier
        # can see enough of long reports to correctly identify follow-up questions.
        for i, turn in enumerate(assistant_turns):
            limit = 1800 if i == len(assistant_turns) - 1 else 700
            lines.append(f"- {turn[:limit]}")

    summary = "\n".join(lines)
    if len(summary) > MAX_MEMORY_SUMMARY_CHARS:
        return summary[-MAX_MEMORY_SUMMARY_CHARS:]
    return summary


def save_conversation_messages(conversation_id: Optional[str], messages) -> None:
    path = _conversation_path(conversation_id)
    if not path:
        return

    STORE_DIR.mkdir(parents=True, exist_ok=True)
    message_list = list(messages)
    payload = {
        "messages": messages_to_dict(_visible_messages(message_list)),
        "tool_context": _tool_context(message_list),
        "tool_results": _structured_tool_results(message_list),
        "memory_summary": _memory_summary(message_list),
    }

    try:
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as e:
        print(f"⚠️ Failed to save conversation context: {e}")


def save_agent_trace(conversation_id: Optional[str], trace: dict) -> None:
    safe_id = _safe_conversation_id(conversation_id) or "no_conversation"
    TRACE_DIR.mkdir(parents=True, exist_ok=True)
    trace_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = TRACE_DIR / f"{safe_id}-{trace_id}.json"
    payload = {
        "conversation_id": safe_id,
        "trace_id": trace_id,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        **(trace or {}),
    }
    try:
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ Failed to save agent trace: {e}")
