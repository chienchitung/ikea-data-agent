import json
import re
from pathlib import Path
from typing import Optional

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.messages import messages_from_dict, messages_to_dict


STORE_DIR = Path(__file__).resolve().parent / ".conversation_store"
MAX_STORED_MESSAGES = 40
MAX_TOOL_CONTEXT_CHARS = 20000


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


def save_conversation_messages(conversation_id: Optional[str], messages) -> None:
    path = _conversation_path(conversation_id)
    if not path:
        return

    STORE_DIR.mkdir(parents=True, exist_ok=True)
    message_list = list(messages)
    payload = {
        "messages": messages_to_dict(_visible_messages(message_list)),
        "tool_context": _tool_context(message_list),
    }

    try:
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception as e:
        print(f"⚠️ Failed to save conversation context: {e}")
