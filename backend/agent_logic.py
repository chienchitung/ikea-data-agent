import asyncio
import glob
import json
import os
import re
import inspect
import time
from datetime import datetime
from typing import Optional

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from agents.coordinator import (
    coordinator_executor,
    _effective_llm_with_fallback,
    _fast_llm,
    classify_turn_context,
    reset_progress_handler,
    set_progress_handler,
    set_api_key,
    reset_api_key,
)
from agents.document import get_document_corpus, get_loaded_files, search_document_base, set_active_documents, reset_active_documents, DOCUMENT_QUERY_TERMS
import agents.document as _doc_module
from conversation_store import (
    load_conversation_messages,
    load_memory_summary,
    load_tool_context,
    load_tool_results,
    save_agent_trace,
    save_conversation_messages,
)

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_kb_init_lock = asyncio.Lock()


def _load_stored_conversation_state(conversation_id: Optional[str]):
    return (
        load_conversation_messages(conversation_id),
        load_tool_context(conversation_id),
        load_tool_results(conversation_id),
        load_memory_summary(conversation_id),
    )


async def _ensure_kb_initialized(api_key: str) -> None:
    """Load KB from the on-disk FAISS cache if it was not loaded at startup."""
    if _doc_module.vector_db is not None:
        return
    faiss_index_dir = os.path.abspath(_doc_module.FAISS_INDEX_PATH)
    has_cache = os.path.exists(os.path.join(faiss_index_dir, "index.faiss"))
    has_pdfs = bool(
        glob.glob(os.path.join(_BACKEND_DIR, "*.pdf"))
        + glob.glob(os.path.join(_BACKEND_DIR, "..", "*.pdf"))
    )
    if not (has_cache or has_pdfs):
        return
    async with _kb_init_lock:
        if _doc_module.vector_db is not None:
            return
        print("⚡ Lazy KB init: loading from disk cache with provided API key...")
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, lambda: _doc_module.initialize_knowledge_base(api_key=api_key))


_DOCUMENT_QUERY_TERMS = DOCUMENT_QUERY_TERMS

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
            # Skip type="thinking" parts: the Gemini API can return the
            # model's internal reasoning as a separate content part alongside
            # the real type="text" answer. include_thoughts=False on the LLM
            # already asks the API not to send these; this check is a
            # structural (API-field-based, not keyword-guessed) backstop.
            if isinstance(item, dict) and item.get("type") == "thinking":
                continue
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
    messages_window = visible_history[-14:]
    last_idx = len(messages_window) - 1
    for idx, message in enumerate(messages_window):
        role = "user" if isinstance(message, HumanMessage) else "assistant"
        # Give the most recent assistant message a larger budget so the classifier
        # can see enough of long reports to correctly identify follow-up questions.
        limit = 2400 if (role == "assistant" and idx == last_idx - 1) else 1400
        lines.append(f"{role}: {_truncate_text(_message_text(message.content), limit)}")
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

    if turn_context.get("should_force_fresh_tool"):
        return []

    relation = str(turn_context.get("relation", "standalone"))
    include_context = (
        turn_context.get("should_include_prior_tool_context")
        or turn_context.get("should_answer_from_context")
        or relation in {"context_follow_up", "context_refinement"}
        # Fallback: include prior context for ambiguous turns so the LLM can
        # decide whether to reuse it or re-query; standalone turns with an
        # explicit force-fresh flag already exit above.
        or relation == "ambiguous"
    )
    if not include_context:
        return []

    context = stored_tool_context[-MAX_PRIOR_TOOL_CONTEXT_CHARS:]
    return [SystemMessage(content=(
        "## Prior Tool Context\n\n"
        "以下是同一對話先前工具查詢取得的資料。若最新問題是在延續前文、追問或改寫，可直接引用此資料作答。"
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


def _parse_json_object(text: str) -> dict:
    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{.*\}", str(text or ""), re.DOTALL)
    if not match:
        return {}
    try:
        return json.loads(match.group(0))
    except Exception:
        return {}


def _verification_source_context(messages: list, stored_tool_context: str, turn_context: dict) -> str:
    current_tool_chunks = []
    for message in _tool_messages(messages):
        name = getattr(message, "name", "") or "tool"
        content = _message_text(message.content).strip()
        if content:
            current_tool_chunks.append(f"[{name}]\n{content}")

    if current_tool_chunks:
        return "\n\n".join(current_tool_chunks)[-18000:]

    relation = str((turn_context or {}).get("relation", "standalone"))
    can_use_prior = (
        (turn_context or {}).get("should_answer_from_context")
        or (turn_context or {}).get("should_include_prior_tool_context")
        or relation in {"context_follow_up", "context_refinement"}
    )
    if can_use_prior and stored_tool_context:
        return str(stored_tool_context)[-14000:]

    return ""


def _query_targets_specific_months(query: str) -> bool:
    """True when the user already scoped the ticket query to specific months or
    quarters (e.g. 「今年4,5,6月」, "Q2", 「第二季」). A January-to-December span
    still counts as a full-year ask, not a month-scoped one."""
    compact = re.sub(r"\s+", "", query)
    if re.search(r"1\s*月\s*(?:到|至|-|~|～)\s*12\s*月", compact):
        return False
    # Strip year tokens like 2026年 so their digits don't read as months.
    without_years = re.sub(r"20\d{2}\s*年?", "", compact)
    if re.search(r"(?<![\d.])(?:1[0-2]|0?[1-9])\s*月", without_years):
        return True
    return bool(re.search(r"[qQ][1-4]|第\s*[一二三四1-4]\s*季", compact))


def _requested_year_for_ticket_query(user_query: str) -> Optional[int]:
    query = str(user_query or "")
    lowered = query.lower()
    compact = re.sub(r"\s+", "", lowered)
    ticket_terms = ["工單", "ticket", "tickets", "request", "requests", "需求"]
    if not any(term in lowered or term in compact for term in ticket_terms):
        return None

    # A query already scoped to specific months/quarters is not a year-level
    # ask; auditing the whole year would fetch data the user never requested
    # (e.g. 「今年4,5,6月」 previously triggered a full Jan-Dec audit query).
    if _query_targets_specific_months(query):
        return None

    explicit_year = re.search(r"\b(20\d{2})\b|(?:^|[^\d])(20\d{2})\s*年", query)
    if explicit_year:
        year = next(group for group in explicit_year.groups() if group)
        return int(year)

    if any(term in query for term in ["今年", "本年", "整年", "全年"]):
        return datetime.now().year

    return None


def _source_has_full_year_filter(source_context: str, year: int) -> bool:
    text = str(source_context or "")
    full_year_patterns = [
        f"Date filter: {year}-01-01 to {year}-12-31",
        f"{year}年1月到12月",
        f"{year}-01-01",
    ]
    has_start = any(pattern in text for pattern in full_year_patterns)
    has_end = f"{year}-12-31" in text or f"{year}-12" in text
    return has_start and has_end


def _compact_audit_context(audit_text: str, limit: int = 8000) -> str:
    """稽核 context 的用途只是讓驗證器抓漏掉的月份，需要的是開頭摘要與
    每月筆數分佈（幾百字元就夠），不需要逐筆明細。8000 已綽綽有餘；
    先前的 22000 只是把驗證 prompt 灌大、拖慢驗證呼叫。"""
    text = str(audit_text or "")
    if len(text) <= limit:
        return text

    head_limit = min(8000, limit // 3)
    tail_limit = limit - head_limit - 80
    return (
        text[:head_limit].rstrip()
        + "\n\n...[audit detail truncated; opening summary and latest rows retained]...\n\n"
        + text[-tail_limit:].lstrip()
    )


async def _augment_year_ticket_verification_context(
    user_query: str,
    source_context: str,
) -> tuple[str, dict]:
    year = _requested_year_for_ticket_query(user_query)
    if not year:
        return source_context, {"ran": False, "reason": "not_year_ticket_query"}

    if _source_has_full_year_filter(source_context, year):
        return source_context, {"ran": False, "reason": "source_already_full_year", "year": year}

    audit_query = f"{year}年1月到12月 每月工單數量，列出每月分佈與明細"
    try:
        from agents.analyst import query_worksheet_data

        audit_result = await asyncio.to_thread(
            query_worksheet_data.invoke,
            {
                "worksheet_name": "Request",
                "query_description": audit_query,
            },
        )
        audit_text = str(audit_result or "")
        if not audit_text.strip() or audit_text.startswith("Failed to query worksheet data"):
            return source_context, {
                "ran": True,
                "status": "failed",
                "year": year,
                "error": audit_text[:500],
            }

        augmented = (
            f"{str(source_context or '')[-4000:]}\n\n"
            "## Internal Full-Year Request Worksheet Audit\n\n"
            "The user asked for a year-level ticket/request answer. "
            "This audit query is the authoritative full-year Request worksheet check and must be used to catch omitted months.\n\n"
            f"{_compact_audit_context(audit_text)}"
        )
        return augmented, {
            "ran": True,
            "status": "completed",
            "year": year,
            "query": audit_query,
        }
    except Exception as e:
        print(f"⚠️ Full-year ticket audit failed: {e}")
        return source_context, {
            "ran": True,
            "status": "failed",
            "year": year,
            "error": str(e),
        }


def _needs_llm_verification(response: str, source_context: str) -> bool:
    """驗證器的用途是比對回答中的數字/筆數/明細是否被工具來源支持。
    回答裡連一個數字、表格或 chart block 都沒有（純聊天、概念說明、
    格式改寫）時，沒有事實可查核，跑一次 fast-LLM 驗證純粹是多等
    5~15 秒，直接跳過。"""
    if not str(source_context or "").strip():
        return False
    text = str(response or "")
    if "```chart" in text:
        return True
    if re.search(r"^\s*\|.+\|\s*$", text, re.MULTILINE):
        return True
    return bool(re.search(r"\d", text))


async def _verify_response_against_sources(
    user_query: str,
    response: str,
    source_context: str,
) -> tuple[str, dict]:
    if not response.strip() or not source_context.strip():
        return response, {"checked": False, "status": "skipped", "reason": "no_source_context"}

    verification_prompt = [
        SystemMessage(content=(
            "你是 Data Machi 的內部答案查核器。你的工作不是重新發揮，而是比對「候選回答」是否被「來源資料」支持。\n"
            "請檢查所有數字、筆數、日期、狀態、負責人、部門、市場、資料來源、ticket 明細與原因敘述。\n"
            "若候選回答的事實都能被來源資料支持，回傳 status=pass。\n"
            "若有任何來源找不到、數字不一致、把推測說成事實、或 row details 與來源不符，回傳 status=revise，並提供修正版。\n"
            "修正版必須保留原回答語言，只移除或更正不被支持的內容；不要新增來源資料沒有的事實。\n"
            "若候選回答含有 ```chart code block，修正版必須逐字保留該 chart block，不得改寫 JSON。\n"
            "只回傳 JSON，不要輸出 Markdown。Schema:\n"
            "{\"status\":\"pass|revise\",\"issues\":[\"...\"],\"revised_response\":\"...\"}"
        )),
        HumanMessage(content=json.dumps({
            "user_query": user_query,
            "candidate_response": response,
            "source_context": source_context,
        }, ensure_ascii=False)),
    ]

    try:
        verifier_response = await _fast_llm().ainvoke(verification_prompt)
        parsed = _parse_json_object(_message_text(verifier_response.content))
        status = str(parsed.get("status", "pass")).lower()
        issues = parsed.get("issues", [])
        if not isinstance(issues, list):
            issues = [str(issues)]

        if status == "revise":
            revised = str(parsed.get("revised_response", "")).strip()
            if revised:
                return revised, {
                    "checked": True,
                    "status": "revised",
                    "issues": [str(issue)[:300] for issue in issues[:8]],
                }

        return response, {
            "checked": True,
            "status": "passed",
            "issues": [str(issue)[:300] for issue in issues[:8]],
        }
    except Exception as e:
        print(f"⚠️ Response verification failed: {e}")
        return response, {"checked": False, "status": "failed", "error": str(e)}




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


def _fix_chart_code_blocks(response: str) -> str:
    """Convert ```json code blocks that are chart specs into ```chart blocks.

    The LLM occasionally mislabels chart specs as json, which causes the
    frontend to display raw JSON instead of the interactive chart widget.
    """
    pattern = re.compile(r'```json[ \t]*\r?\n(.*?)\r?\n```', re.DOTALL)

    def replace_if_chart(match: re.Match) -> str:
        code = match.group(1).strip()
        try:
            spec = json.loads(code)
            if (
                isinstance(spec, dict)
                and spec.get('type') in ('bar', 'line', 'pie')
                and isinstance(spec.get('data'), list)
                and len(spec['data']) > 0
                and 'title' in spec
            ):
                return f"```chart\n{code}\n```"
        except (json.JSONDecodeError, ValueError):
            pass
        return match.group(0)

    return pattern.sub(replace_if_chart, response)


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


async def _answer_from_document_base(message: str) -> Optional[dict]:
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
        or "no pdf files have been uploaded" in lowered_document_context
        or "error: no pdf" in lowered_document_context
    ):
        # System/status message, nothing to fact-check against sources.
        return {"response": document_context, "document_context": document_context, "skip_verification": True}

    reply_language = _detect_reply_language(clean_message)
    response = await _effective_llm_with_fallback().ainvoke([
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
    return {
        "response": _message_text(response.content).strip(),
        "document_context": document_context,
        "skip_verification": False,
    }

async def process_chat_detailed(
    message: str,
    chat_history: list,
    conversation_id: Optional[str] = None,
    turn_context: Optional[dict] = None,
    progress_callback=None,
    gemini_api_key: Optional[str] = None,
    active_documents: Optional[list] = None,
) -> dict:
    """
    Process the chat message using the LangGraph Coordinator Agent.
    """
    api_key_token = set_api_key(gemini_api_key) if gemini_api_key else None
    active_docs_token = set_active_documents(active_documents) if active_documents is not None else None
    if gemini_api_key:
        await _ensure_kb_initialized(gemini_api_key)
    try:
        started_at = time.perf_counter()
        await _emit_progress(progress_callback, "understanding", "Understanding your question")
        clean_message = _clean_user_query(message)
        document_result = await _answer_from_document_base(message)
        if document_result:
            document_response = document_result["response"]
            if document_result.get("skip_verification"):
                verification_metadata = {"checked": False, "status": "skipped", "reason": "system_message"}
            elif not _needs_llm_verification(document_response, document_result["document_context"]):
                verification_metadata = {"checked": False, "status": "skipped", "reason": "no_factual_claims"}
            else:
                await _emit_progress(progress_callback, "composing", "Verifying the response")
                document_response, verification_metadata = await _verify_response_against_sources(
                    clean_message,
                    document_response,
                    document_result["document_context"],
                )

            elapsed_ms = round((time.perf_counter() - started_at) * 1000)
            document_context_text = str(document_result.get("document_context") or "")
            await asyncio.to_thread(save_agent_trace, conversation_id, {
                "user_query": clean_message,
                "turn_context": turn_context or {},
                "tool_outputs": [{
                    "name": "search_document_base",
                    "char_count": len(document_context_text),
                    "content": document_context_text[:12000],
                    "truncated": len(document_context_text) > 12000,
                }],
                "verification": verification_metadata,
                "final_response_preview": document_response[:4000],
                "elapsed_ms": elapsed_ms,
            })

            return {
                "response": document_response,
                "metadata": {
                    "elapsed_ms": elapsed_ms,
                    "mode": "document_direct",
                    "turn_context": turn_context or {},
                    "tool_results": [],
                    "usage": {},
                    "verification": verification_metadata,
                },
            }

        # Dispatched together onto a worker thread: these are synchronous disk
        # reads, and calling them directly on the event loop would block every
        # other in-flight request (e.g. a concurrent GET /meetings) for however
        # long the read takes.
        (
            stored_messages,
            stored_tool_context,
            stored_tool_results,
            stored_memory_summary,
        ) = await asyncio.to_thread(_load_stored_conversation_state, conversation_id)
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
                # Skip type="thinking" parts (see _message_text's comment above).
                if isinstance(item, dict) and item.get('type') == 'thinking':
                    continue
                if isinstance(item, dict) and 'text' in item:
                    agent_response_parts.append(item['text'])
                elif isinstance(item, str):
                    agent_response_parts.append(item)
            agent_response = "".join(agent_response_parts)
        else:
            agent_response = str(agent_response_raw)

        agent_response = _fix_chart_code_blocks(agent_response)
        confluence_links = _collect_confluence_links(response_state["messages"], stored_tool_context)
        agent_response = _ensure_confluence_source_links(
            agent_response,
            confluence_links,
            _detect_reply_language(clean_message),
        )
        verification_context = _verification_source_context(
            response_state["messages"],
            stored_tool_context,
            turn_context or {},
        )
        if _needs_llm_verification(agent_response, verification_context):
            await _emit_progress(progress_callback, "composing", "Verifying the response")
            verification_context, full_year_audit_metadata = await _augment_year_ticket_verification_context(
                clean_message,
                verification_context,
            )
            agent_response, verification_metadata = await _verify_response_against_sources(
                clean_message,
                agent_response,
                verification_context,
            )
            verification_metadata["full_year_audit"] = full_year_audit_metadata
        else:
            verification_metadata = {
                "checked": False,
                "status": "skipped",
                "reason": "no_factual_claims",
                "full_year_audit": {"ran": False, "reason": "verification_skipped"},
            }
        agent_response = _fix_chart_code_blocks(agent_response)
        agent_response = _ensure_confluence_source_links(
            agent_response,
            confluence_links,
            _detect_reply_language(clean_message),
        )
        await _emit_progress(progress_callback, "composing", "Finalizing the response")

        save_messages = (
            list(conversation_history)
            + [HumanMessage(content=message), AIMessage(content=agent_response)]
            + _tool_messages(response_state["messages"])
        )
        await asyncio.to_thread(save_conversation_messages, conversation_id, save_messages)

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
            "verification": verification_metadata,
        }

        raw_tool_outputs = []
        for tool_message in _tool_messages(response_state["messages"]):
            raw_content = _message_text(tool_message.content).strip()
            raw_tool_outputs.append({
                "name": getattr(tool_message, "name", "") or "tool",
                "char_count": len(raw_content),
                "content": raw_content[:12000],
                "truncated": len(raw_content) > 12000,
            })
        await asyncio.to_thread(save_agent_trace, conversation_id, {
            "user_query": clean_message,
            "turn_context": turn_context or {},
            "tool_outputs": raw_tool_outputs,
            "verification": verification_metadata,
            "final_response_preview": agent_response[:4000],
            "elapsed_ms": elapsed_ms,
        })
        
        return {
            "response": agent_response,
            "metadata": metadata,
        }
    except Exception as e:
        print(f"❌ Chat Error [{type(e).__name__}]: {e}")
        return {
            "response": f"Error processing request: {str(e)}",
            "metadata": {
                "error": str(e),
                "turn_context": turn_context or {},
            },
        }
    finally:
        if api_key_token is not None:
            reset_api_key(api_key_token)
        if active_docs_token is not None:
            reset_active_documents(active_docs_token)


async def process_chat(
    message: str,
    chat_history: list,
    conversation_id: Optional[str] = None,
    turn_context: Optional[dict] = None,
) -> str:
    result = await process_chat_detailed(message, chat_history, conversation_id, turn_context)
    return result["response"]
