import json
import re
import inspect
import time
from typing import Optional

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from agents.coordinator import (
    coordinator_executor,
    llm,
    classify_turn_context,
    reset_progress_handler,
    set_progress_handler,
)
from agents.document import get_document_corpus, get_loaded_files, search_document_base
from conversation_store import (
    load_conversation_messages,
    load_memory_summary,
    load_tool_context,
    load_tool_results,
    save_conversation_messages,
)


_DOCUMENT_QUERY_TERMS = [
    "pdf", "PDF", "文件", "文檔", "檔案", "document",
    "上傳", "剛上傳", "這份", "這個檔", "這份檔", "這份資料"
]

_FULL_DOCUMENT_QUERY_TERMS = [
    "整份", "整個", "完整", "全部", "全篇", "全文", "通篇",
    "摘要", "總結", "整理", "解讀", "overview", "summary", "summarize"
]

RECENT_CONTEXT_MESSAGES = 18
MAX_CONTEXT_MEMORY_CHARS = 5000
MAX_CONTEXT_LINE_CHARS = 520
MAX_PRIOR_TOOL_CONTEXT_CHARS = 12000


def _message_text(content) -> str:
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


def _truncate_text(text: str, limit: int) -> str:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[:limit - 1].rstrip()}…"


def _clean_user_query(message: str) -> str:
    text = str(message or "").strip()
    for marker in ["目前使用者問題：", "使用者原始問題："]:
        if marker in text:
            text = text.rsplit(marker, 1)[-1].strip()

    clarification_marker = "使用者在釐清題選擇的條件："
    if clarification_marker in text:
        text = text.split(clarification_marker, 1)[0].strip()

    metadata_marker = "以下是使用者在送出前選擇的釐清選項"
    if metadata_marker in text:
        text = text.split(metadata_marker, 1)[0].strip()

    return text or str(message or "")


def _detect_reply_language(user_query: str) -> str:
    text = _clean_user_query(str(user_query or "")).strip()
    if not text:
        return "Traditional Chinese"

    cjk_count = len(re.findall(r"[\u3400-\u9fff]", text))
    english_words = re.findall(r"[A-Za-z]{2,}", text)
    english_chars = sum(len(word) for word in english_words)

    if cjk_count == 0 and english_chars > 0:
        return "English"
    if english_chars == 0 and cjk_count > 0:
        return "Traditional Chinese"
    return "English" if english_chars > cjk_count * 1.5 else "Traditional Chinese"


def _is_visible_chat_message(message) -> bool:
    return isinstance(message, (HumanMessage, AIMessage))


def _format_history_for_router(history: list) -> str:
    visible_history = [m for m in history if _is_visible_chat_message(m)]
    lines = []
    for message in visible_history[-12:]:
        role = "user" if isinstance(message, HumanMessage) else "assistant"
        lines.append(f"{role}: {_truncate_text(_message_text(message.content), 900)}")
    return "\n".join(lines)


async def _emit_progress(progress_callback, phase: str, label: str, **extra) -> None:
    if not progress_callback:
        return
    payload = {
        "phase": phase,
        "label": label,
        **extra,
    }
    result = progress_callback(payload)
    if inspect.isawaitable(result):
        await result


def _build_conversation_memory(history: list, stored_memory_summary: str = "") -> tuple[list, list]:
    visible_history = [m for m in history if _is_visible_chat_message(m)]
    if len(visible_history) <= RECENT_CONTEXT_MESSAGES:
        return [], visible_history

    older_messages = visible_history[:-RECENT_CONTEXT_MESSAGES]
    recent_messages = visible_history[-RECENT_CONTEXT_MESSAGES:]

    if stored_memory_summary:
        return [
            SystemMessage(content=f"## Conversation Memory\n\n{stored_memory_summary}")
        ], recent_messages

    lines = [
        "以下是同一個對話中較早的內容摘錄，用來保留長對話脈絡。",
        "回答時請以最新使用者問題為主；只有在最新問題需要延續前文、代名詞或先前條件時才引用這些內容。",
    ]

    first_user = next((m for m in older_messages if isinstance(m, HumanMessage)), None)
    if first_user:
        lines.append(f"起始需求：{_truncate_text(_message_text(first_user.content), MAX_CONTEXT_LINE_CHARS)}")

    for message in older_messages[-12:]:
        role = "使用者" if isinstance(message, HumanMessage) else "助理"
        lines.append(f"- {role}: {_truncate_text(_message_text(message.content), MAX_CONTEXT_LINE_CHARS)}")

    memory = "\n".join(lines)
    if len(memory) > MAX_CONTEXT_MEMORY_CHARS:
        memory = memory[-MAX_CONTEXT_MEMORY_CHARS:]

    return [SystemMessage(content=f"## Conversation Memory\n\n{memory}")], recent_messages


def _build_turn_context_message(turn_context: dict) -> list:
    if not turn_context:
        return []
    return [SystemMessage(content=(
        "## Turn Context Decision\n\n"
        "以下 JSON 是根據最新使用者訊息與近期對話做出的語意路由判斷。"
        "請用它判斷這輪應延續前文、直接整理上下文、重新查工具，或視為新問題。\n\n"
        f"{json.dumps(turn_context, ensure_ascii=False)}"
    ))]


def _build_prior_tool_context(stored_tool_context: str, turn_context: dict) -> list:
    if not stored_tool_context:
        return []

    relation = str(turn_context.get("relation", "standalone"))
    include_context = (
        turn_context.get("should_include_prior_tool_context")
        or turn_context.get("should_answer_from_context")
        or relation in {"context_follow_up", "context_refinement"}
    )
    if not include_context or turn_context.get("should_force_fresh_tool"):
        return []

    context = stored_tool_context[-MAX_PRIOR_TOOL_CONTEXT_CHARS:]
    return [SystemMessage(content=(
        "## Prior Tool Context\n\n"
        "以下是同一對話先前工具查詢取得的資料。Turn Context Decision 已判斷這輪可能需要延續前文時，才會提供此段。"
        "若最新問題要求最新、全部或新的資料範圍，請重新呼叫工具，不要只依賴這段資料。\n\n"
        f"{context}"
    ))]


def _tool_messages(messages: list) -> list:
    return [
        message for message in messages
        if isinstance(message, ToolMessage)
        or getattr(message, "type", "") == "tool"
        or message.__class__.__name__ == "ToolMessage"
    ]


def _structured_tool_metadata(messages: list) -> list[dict]:
    results = []
    for message in _tool_messages(messages):
        content = _message_text(message.content).strip()
        name = getattr(message, "name", "") or "tool"
        results.append({
            "name": name,
            "preview": content[:800],
            "char_count": len(content),
        })
    return results


def _numbers_in_text(text: str) -> set[str]:
    normalized = str(text or "")
    return set(re.findall(r"(?<![A-Za-z])\d+(?:\.\d+)?%?(?![A-Za-z])", normalized))


def _latest_tool_content(messages: list, tool_names: set[str]) -> str:
    for message in reversed(_tool_messages(messages)):
        name = getattr(message, "name", "") or ""
        if name in tool_names:
            return _message_text(message.content).strip()
    return ""


def _enforce_grounded_analyst_response(agent_response: str, messages: list, reply_language: str = "Traditional Chinese") -> str:
    analyst_tool_content = _latest_tool_content(
        messages,
        {"query_worksheet_data", "get_worksheet_structure", "list_worksheets"},
    )
    if not analyst_tool_content:
        return agent_response

    response_numbers = _numbers_in_text(agent_response)
    tool_numbers = _numbers_in_text(analyst_tool_content)
    ungrounded_numbers = response_numbers - tool_numbers
    if ungrounded_numbers:
        warning = (
            "I found numbers in the drafted answer that were not present in the worksheet tool result, "
            "so I am returning the grounded tool result directly to avoid unsupported data."
            if reply_language == "English"
            else "我發現草稿回答中出現了工作表工具結果沒有提供的數字，因此改為直接回傳已依工具結果計算的內容，避免使用未受支持的資料。"
        )
        return f"{warning}\n\n{analyst_tool_content}"

    return agent_response


def _usage_metadata(messages: list) -> dict:
    total_input = 0
    total_output = 0
    seen_usage = False

    for message in messages:
        usage = getattr(message, "usage_metadata", None)
        if not isinstance(usage, dict):
            continue
        seen_usage = True
        total_input += int(usage.get("input_tokens") or usage.get("prompt_token_count") or 0)
        total_output += int(usage.get("output_tokens") or usage.get("candidates_token_count") or 0)

    if not seen_usage:
        return {}
    return {
        "input_tokens": total_input,
        "output_tokens": total_output,
        "total_tokens": total_input + total_output,
    }


def _extract_confluence_links(text: str) -> dict:
    links = {}
    for title, url in re.findall(r"(?:Link|來源連結):\s*\[([^\]]+)\]\(([^)]+)\)", text):
        links[title.strip()] = url.strip()
    return links


def _collect_confluence_links(messages, stored_tool_context: str) -> dict:
    links = _extract_confluence_links(stored_tool_context or "")
    for message in messages:
        if getattr(message, "type", "") == "tool" or message.__class__.__name__ == "ToolMessage":
            links.update(_extract_confluence_links(_message_text(message.content)))
    return links


def _ensure_confluence_source_links(response: str, confluence_links: dict, reply_language: str = "Traditional Chinese") -> str:
    if not response or not confluence_links:
        return response

    updated = response
    source_prefix = "Source:" if reply_language == "English" else "來源："
    for title, url in confluence_links.items():
        markdown_link = f"[{title}]({url})"
        plain_source_patterns = [
            f"[來源: {title}]",
            f"[來源： {title}]",
            f"[來源:{title}]",
            f"[來源：{title}]",
        ]
        for pattern in plain_source_patterns:
            updated = updated.replace(pattern, f"{source_prefix} {markdown_link}")

        source_line_patterns = [
            f"來源: {title}",
            f"來源： {title}",
            f"Source: {title}",
        ]
        for pattern in source_line_patterns:
            updated = updated.replace(pattern, f"{source_prefix} {markdown_link}")

    if "來源" not in updated and "Source:" not in updated:
        first_title, first_url = next(iter(confluence_links.items()))
        updated = f"{updated.rstrip()}\n\n{source_prefix} [{first_title}]({first_url})"
    return updated


def _looks_like_document_query(message: str) -> bool:
    loaded_files = get_loaded_files()
    if not loaded_files:
        return False

    normalized = _clean_user_query(message)
    if not normalized:
        return False

    lowered = normalized.lower()
    loaded_file_names = [name.lower() for name in loaded_files]
    loaded_file_stems = [name.rsplit(".", 1)[0].lower() for name in loaded_files]
    if any(name and name in lowered for name in loaded_file_names + loaded_file_stems):
        return True

    compact = re.sub(r"\s+", "", normalized)
    return any(term.lower() in lowered or term in compact for term in _DOCUMENT_QUERY_TERMS)


def _looks_like_full_document_query(message: str) -> bool:
    normalized = str(message or "").strip()
    if not normalized:
        return False

    lowered = normalized.lower()
    compact = re.sub(r"\s+", "", normalized)
    return any(term.lower() in lowered or term in compact for term in _FULL_DOCUMENT_QUERY_TERMS)


async def _answer_from_document_base(message: str) -> Optional[str]:
    clean_message = _clean_user_query(message)
    if not _looks_like_document_query(clean_message):
        return None

    is_full_document_query = _looks_like_full_document_query(clean_message)
    if is_full_document_query:
        document_context = get_document_corpus()
    else:
        document_context = await search_document_base.ainvoke({"query": clean_message})

    lowered_document_context = str(document_context or "").lower()
    if (
        "知識庫尚未建立" in document_context
        or "系統警告" in document_context
        or "knowledge base is not ready" in lowered_document_context
        or "system warning" in lowered_document_context
    ):
        return document_context

    reply_language = _detect_reply_language(clean_message)
    response = await llm.ainvoke([
        SystemMessage(content=(
            "你是 IKEA Data Team 的 PDF 文件問答助理。"
            "請只根據提供的 PDF 內容回答；若內容不足以回答，請明確說文件內容不足。"
            f"回答語言必須跟隨最新使用者問題；本輪請使用 {reply_language}。"
            "先給直接答案，再整理重點。"
            "如果使用者要求整份文件摘要或解讀，請從全文件角度整理主題、重點、流程與可行動事項。"
            "PDF 內容可能同時包含 Type=text 的文字層與 Type=visual_summary 的圖片/截圖/圖表摘要。"
            "不要只因為文字與圖片在同一頁，就推論它們在描述同一件事；"
            "只有 visual_summary 明確指出圖文關係時，才可把圖片與附近文字連結。"
            "如果圖文關係不確定，請直接說明不確定，不要硬配對。"
            "最後必須列出來源；中文回答用「來源：Guidebook.pdf（第 1 頁）」，英文回答用「Source: Guidebook.pdf (page 1)」。"
        )),
        HumanMessage(content=(
            f"使用者問題：{clean_message}\n\n"
            f"PDF 內容：\n{document_context}"
        )),
    ])
    return _message_text(response.content).strip()

async def process_chat_detailed(
    message: str,
    chat_history: list,
    conversation_id: Optional[str] = None,
    turn_context: Optional[dict] = None,
    progress_callback=None,
) -> dict:
    """
    Process the chat message using the LangGraph Coordinator Agent.
    """
    try:
        started_at = time.perf_counter()
        await _emit_progress(progress_callback, "understanding", "Understanding your question")
        document_answer = await _answer_from_document_base(message)
        if document_answer:
            elapsed_ms = round((time.perf_counter() - started_at) * 1000)
            return {
                "response": document_answer,
                "metadata": {
                    "elapsed_ms": elapsed_ms,
                    "mode": "document_direct",
                    "turn_context": turn_context or {},
                    "tool_results": [],
                    "usage": {},
                },
            }

        stored_messages = load_conversation_messages(conversation_id)
        stored_tool_context = load_tool_context(conversation_id)
        stored_tool_results = load_tool_results(conversation_id)
        stored_memory_summary = load_memory_summary(conversation_id)
        clean_message = _clean_user_query(message)
        conversation_history = chat_history if chat_history else stored_messages

        if not turn_context:
            history_text = _format_history_for_router(conversation_history)
            await _emit_progress(progress_callback, "understanding", "Checking context")
            turn_context = await classify_turn_context(
                clean_message,
                history_text,
                has_prior_tool_context=bool(stored_tool_context),
            )
        await _emit_progress(progress_callback, "thinking", "Combining context")
        memory_messages, recent_history = _build_conversation_memory(conversation_history, stored_memory_summary)
        turn_context_messages = _build_turn_context_message(turn_context)
        prior_tool_context_messages = _build_prior_tool_context(stored_tool_context, turn_context)
        current_message = message

        # Build messages payload for langgraph
        messages = (
            memory_messages
            + turn_context_messages
            + prior_tool_context_messages
            + recent_history
            + [HumanMessage(content=current_message)]
        )

        # Use ainvoke to support async parallel tool execution
        token = set_progress_handler(progress_callback)
        try:
            response_state = await coordinator_executor.ainvoke({
                "messages": messages
            })
        finally:
            reset_progress_handler(token)
        
        # Get the last message from the state
        last_message = response_state["messages"][-1]
        
        # The content can be string or list (e.g. text blocks)
        agent_response_raw = last_message.content
        agent_response_parts = []
        
        if isinstance(agent_response_raw, list):
            for item in agent_response_raw:
                if isinstance(item, dict) and 'text' in item:
                    agent_response_parts.append(item['text'])
                elif isinstance(item, str):
                    agent_response_parts.append(item)
            agent_response = "".join(agent_response_parts)
        else:
            agent_response = str(agent_response_raw)

        confluence_links = _collect_confluence_links(response_state["messages"], stored_tool_context)
        agent_response = _ensure_confluence_source_links(
            agent_response,
            confluence_links,
            _detect_reply_language(clean_message),
        )
        agent_response = _enforce_grounded_analyst_response(
            agent_response,
            response_state["messages"],
            _detect_reply_language(clean_message),
        )
        await _emit_progress(progress_callback, "composing", "Finalizing the response")

        save_messages = (
            list(conversation_history)
            + [HumanMessage(content=message), AIMessage(content=agent_response)]
            + _tool_messages(response_state["messages"])
        )
        save_conversation_messages(conversation_id, save_messages)

        tool_results = _structured_tool_metadata(response_state["messages"])
        if not tool_results:
            tool_results = [
                {
                    "name": item.get("name", "tool"),
                    "preview": item.get("preview", ""),
                    "char_count": item.get("char_count", 0),
                }
                for item in stored_tool_results[-5:]
                if isinstance(item, dict)
            ]

        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        metadata = {
            "elapsed_ms": elapsed_ms,
            "mode": "agent",
            "turn_context": turn_context or {},
            "tool_results": tool_results,
            "usage": _usage_metadata(response_state["messages"]),
            "memory_summary_used": bool(stored_memory_summary),
        }
        
        return {
            "response": agent_response,
            "metadata": metadata,
        }
    except Exception as e:
        return {
            "response": f"Error processing request: {str(e)}",
            "metadata": {
                "error": str(e),
                "turn_context": turn_context or {},
            },
        }


async def process_chat(
    message: str,
    chat_history: list,
    conversation_id: Optional[str] = None,
    turn_context: Optional[dict] = None,
) -> str:
    result = await process_chat_detailed(message, chat_history, conversation_id, turn_context)
    return result["response"]
