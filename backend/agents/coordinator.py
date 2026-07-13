from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.prebuilt import create_react_agent
from google.api_core.exceptions import GoogleAPIError
from dotenv import load_dotenv

# langchain-google-genai >= 4.x calls Gemini through the google-genai SDK,
# whose 5xx failures raise google.genai.errors.ServerError — NOT a subclass of
# google.api_core.exceptions.GoogleAPIError. with_fallbacks() matched only
# GoogleAPIError, so a 504 DEADLINE_EXCEEDED / 503 from the new SDK bypassed
# the fast-model fallback entirely and surfaced to the user as an error.
try:
    from google.genai.errors import ServerError as GenaiServerError
    _FALLBACK_EXCEPTIONS = (GoogleAPIError, GenaiServerError)
except ImportError:
    _FALLBACK_EXCEPTIONS = (GoogleAPIError,)
import os
from datetime import datetime

# Import tools from other agents
from .trello import trello_tools
from .confluence import confluence_tools
from .document import document_tools, get_loaded_files
from .analyst import analyst_tools

load_dotenv()

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
# Used for internal JSON classification/verification steps (turn-context
# routing, intent guardrail, clarification detection, response fact-check)
# that run once or twice per turn but never generate the text the user
# reads. gemini-3.5-flash has been observed taking 90s+ per call under heavy
# load vs. gemini-2.5-flash's ~7s for the same kind of schema-only request
# (see backend/agents/meeting.py), and with 2-3 of these internal calls
# stacked sequentially before/after the user-facing answer, that difference
# was the main driver of 100s+ replies. Keep GEMINI_MODEL (3.5-flash) only
# for the final answer generation, where output quality is user-visible.
GEMINI_FAST_MODEL = os.getenv("GEMINI_FAST_MODEL", "gemini-2.5-flash")
_env_api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")

# langchain_google_genai retries ResourceExhausted(429)/ServiceUnavailable(503)/
# GoogleAPIError automatically, but its default (max_retries=6, exponential
# backoff up to 60s, no timeout) is tuned for offline/batch jobs, not a
# synchronous chat turn a user is staring at. Left at the default, a single
# "high demand" 503 streak on GEMINI_MODEL can turn one turn into a 90s+ wait
# (matches the 90s+ figures noted above and in backend/agents/meeting.py)
# before the library even finishes retrying. Retry a couple of times quickly
# instead, bounded by a timeout per attempt; with_fallbacks() (see
# _effective_llm_with_fallback / _effective_llm_with_tools_and_fallback below)
# hands the turn to GEMINI_FAST_MODEL if GEMINI_MODEL still hasn't recovered.
MODEL_MAX_RETRIES = int(os.getenv("GEMINI_MAX_RETRIES", "2"))
MODEL_TIMEOUT_SECONDS = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "25"))

# include_thoughts=False: without this, the Gemini API may return an extra
# type="thinking" content part alongside the final type="text" part. Nothing
# in this codebase's content-joining code distinguished the two, so a
# thinking part (the model's own draft/checklist, sometimes referencing
# internal prompt rule IDs like "HC-2") could get concatenated in front of
# the real answer and shown to the user. Disabling it at the source is more
# reliable than trying to detect and strip it after the fact.
llm = ChatGoogleGenerativeAI(
    model=GEMINI_MODEL,
    temperature=0,
    google_api_key=_env_api_key,
    include_thoughts=False,
    max_retries=MODEL_MAX_RETRIES,
    timeout=MODEL_TIMEOUT_SECONDS,
) if _env_api_key else None

fast_llm = ChatGoogleGenerativeAI(
    model=GEMINI_FAST_MODEL,
    temperature=0,
    google_api_key=_env_api_key,
    include_thoughts=False,
    max_retries=MODEL_MAX_RETRIES,
    timeout=MODEL_TIMEOUT_SECONDS,
) if _env_api_key else None

# Define coordinator tools wrapper
all_tools = trello_tools + confluence_tools + document_tools + analyst_tools

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PROMPT_DIR = os.path.join(BASE_DIR, "prompts")


def _read_text_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def _read_prompt_module(filename: str) -> str:
    return _read_text_file(os.path.join(PROMPT_DIR, filename))


# 模組載入順序對應優先等級，Layer 1 最高、Layer 6 最低
# LLM 遇到衝突時，永遠以編號較小的 Layer 為準
prompt_modules = {
    # Layer 1 — 絕對限制，任何情況下不得違反
    "Hard Constraints": _read_prompt_module("hard_constraints.md"),
    # Layer 2 — 身份、人設、範疇邊界
    "Core Identity": _read_prompt_module("core_identity.md"),
    # Layer 3 — 工作流程、零幻覺、工具使用原則
    "Workflow Policy": _read_prompt_module("workflow_policy.md"),
    # Layer 4 — 各 Agent 工具路由細則與資料 schema
    "Tool Routing": _read_prompt_module("tool_routing.md"),
    "Data Schema": _read_prompt_module("data_schema.md"),
    # Layer 5 — 輸出格式
    "Response Formatting": _read_prompt_module("response_formatting.md"),
    # Layer 6 — 溝通技巧、詞彙參考（最低優先，可被上層覆蓋）
    "Skills": _read_text_file(os.path.join(BASE_DIR, "skills.md")),
    "Glossary": _read_text_file(os.path.join(BASE_DIR, "glossary.md")),
}

current_date = datetime.now().strftime("%Y-%m-%d")
current_year = datetime.now().year

module_sections = "\n\n".join(
    f"## {title}\n\n{content}"
    for title, content in prompt_modules.items()
    if content
)

system_prompt = f"""
# System Context

- 今天的日期是：{current_date}
- 今年是：{current_year} 年。當用戶提到「今年」、「去年」、「本月」等相對時間詞彙時，請一律以這個當下日期為基準來推算。
- Final answer language must follow the latest user message:
  - If the latest user message is mainly Traditional Chinese, answer in Traditional Chinese.
  - If the latest user message is mainly English, answer in English.
  - If the latest user message mixes languages, use the language used for the actual question or request.
  - This rule applies only to assistant answers. Frontend UI fields such as clarification panel labels remain English.

# Prompt Priority（衝突解決規則）

以下六個 Layer 決定規則優先順序。**若任意兩條規則衝突，編號較小的 Layer 永遠勝出，不得以任何理由例外。**

| Layer | 模組 | 說明 |
|-------|------|------|
| 1 | Hard Constraints | 絕對禁止與強制行為，永不被覆蓋 |
| 2 | Core Identity | 身份、人設、範疇邊界 |
| 3 | Workflow Policy | 工作流程、零幻覺、工具呼叫原則 |
| 4 | Tool Routing / Data Schema | 各工具路由細則 |
| 5 | Response Formatting | 輸出格式規範 |
| 6 | Skills / Glossary | 溝通風格、詞彙（最低優先） |

# Loaded Prompt Modules

{module_sections}

## Glossary Usage Note

若 glossary 未涵蓋某個縮寫或專有名詞，請務必先呼叫 Confluence 工具查詢，不要自行展開或猜測。
"""

import asyncio
import contextvars
import inspect
import json
import re
import time
from typing import Annotated, Any, TypedDict
from langchain_core.messages import BaseMessage, SystemMessage, AIMessage, HumanMessage, ToolMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages

# 定義 Graph 狀態，儲存對話歷史
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

# 綁定所有工具給 LLM（env key 存在時才建立，否則為 None）
model_with_tools = llm.bind_tools(all_tools) if llm else None

# 建立工具查詢 map，供 parallel_tool_node 使用
_tool_map = {t.name: t for t in all_tools}
_progress_handler_var = contextvars.ContextVar("progress_handler", default=None)
_api_key_var = contextvars.ContextVar("gemini_api_key", default=None)

# Chat history 上限（保留 system + 最近 N 則，避免 token 越來越多）
MAX_HISTORY = 20

_INTERIM_RESPONSE_MARKERS = [
    # 中文預告詞
    "請稍等", "請等一下", "稍等一下", "等我一下", "我正在查",
    "正在處理", "處理中", "立刻請", "馬上請",
    "我幫你查", "我來查", "讓我看看", "讓我查", "讓我來",
    "讓我幫你", "讓我幫你查", "讓我確認", "讓我先查",
    "我先查", "我查一下", "我來幫你查", "我來確認",
    "我先看看", "容我查", "馬上幫你查", "幫你查一下",
    # 英文預告詞
    "let me check", "let me look", "let me search", "let me find",
    "i'll check", "i'll look", "i'll search", "i'll find",
    "i will check", "i will look", "one moment", "just a moment",
]

# See _is_interim_response(): only messages that are short overall, with the
# marker phrase right at the start, are treated as placeholders.
_INTERIM_RESPONSE_MAX_LEN = 60
_INTERIM_RESPONSE_MARKER_WINDOW = 15

_MAX_INTERIM_RETRIES = 2

_DEFAULT_INTENT = {
    "needs_tool": False,
    "fresh_query": False,
    "domain": "none",
    "reason": "",
}

_DEFAULT_CLARIFICATION = {
    "needs_clarification": False,
    "questions": [],
    "reason": "",
}

from .document import DOCUMENT_QUERY_TERMS as _DOCUMENT_QUERY_TERMS

# Explicit correction / verification challenges only. These are the ONLY
# phrases that force a fresh tool re-query even when classify_turn_context()
# already said should_answer_from_context=True. Generic/broad terms (資料,
# 統計, 分析, 需求, 部門, 最新, 全部, ...) were removed — they matched ordinary
# follow-up phrasing (e.g. "各部門的工單數量可以怎麼分析") and force-vetoed the
# router's should_answer_from_context decision even when the router had
# already judged the prior tool context sufficient. classify_turn_context's
# router prompt already instructs should_force_fresh_tool=true whenever the
# user asks for "最新、重新查、全部、目前狀態", so removing the broad terms here
# does not remove that safety net — it removes a redundant, over-broad
# duplicate that was silently overriding correct LLM judgments.
_CORRECTION_CHALLENGE_TERMS = [
    "確定", "正確", "重新檢查", "再確認", "核對", "檢查資訊",
    "有錯", "錯誤", "不對", "不正確", "修正", "更正",
    "are you sure", "is that correct", "double check", "recheck", "verify",
    "incorrect", "wrong", "not correct", "fix the data",
]

_CHART_DIMENSION_OPTIONS = [
    {"label": "By month", "value": "Month", "description": "Show monthly ticket volume trends"},
    {"label": "By status", "value": "Status", "description": "Compare ticket counts by status"},
    {"label": "By market", "value": "Market", "description": "Compare TW, HK, IKNA, and other markets"},
    {"label": "By data source", "value": "Data Source", "description": "Compare sources such as CDP and GA4"},
    {"label": "By support type", "value": "Data Support", "description": "Compare dashboard, report, support, and other types"},
    {"label": "By owner", "value": "Assigned To", "description": "Compare ticket volume by assignee"},
]

_REPORT_SCOPE_OPTIONS = [
    {"label": "Request tickets", "value": "Request worksheet", "description": "Analyze ticket volume, status, market, and data source"},
    {"label": "Trello projects", "value": "Trello board", "description": "Summarize board lists, card progress, and ownership"},
    {"label": "Confluence docs", "value": "Confluence pages", "description": "Summarize definitions, workflows, or dashboard documentation"},
]

_REPORT_FORMAT_OPTIONS = [
    {"label": "Summary", "value": "summary", "description": "Organize the analysis into concise written takeaways"},
    {"label": "Chart", "value": "chart", "description": "Create an interactive chart with short insights"},
    {"label": "Table", "value": "table", "description": "Format the result as a clean summary table"},
]

_DEFAULT_TURN_CONTEXT = {
    "relation": "standalone",
    "should_answer_from_context": False,
    "should_include_prior_tool_context": False,
    "should_force_fresh_tool": False,
    "should_skip_clarification": False,
    "domain_hint": "none",
    "confidence": 0.0,
    "reason": "",
}

_TOOL_PROGRESS_LABELS = {
    "list_worksheets": "Reading worksheet list",
    "get_worksheet_structure": "Checking worksheet fields",
    "query_worksheet_data": "Querying worksheet data",
    "search_confluence_pages": "Searching Data Team Toolbox",
    "get_confluence_page_content": "Reading Data Team Toolbox",
    "get_all_pages": "Browsing Data Team Toolbox",
    "search_document_base": "Searching PDF knowledge base",
    "get_project_status": "Checking Trello progress",
    "get_card_details": "Reading Trello card",
    "get_card_details_by_name": "Searching Trello card",
}


def set_progress_handler(handler):
    return _progress_handler_var.set(handler)


def reset_progress_handler(token) -> None:
    _progress_handler_var.reset(token)


def set_api_key(key: str):
    return _api_key_var.set(key)


def reset_api_key(token) -> None:
    _api_key_var.reset(token)


def _effective_llm():
    api_key = _api_key_var.get()
    if api_key:
        return ChatGoogleGenerativeAI(
            model=GEMINI_MODEL,
            temperature=0,
            google_api_key=api_key,
            include_thoughts=False,
            max_retries=MODEL_MAX_RETRIES,
            timeout=MODEL_TIMEOUT_SECONDS,
        )
    if llm is not None:
        return llm
    raise ValueError("No Gemini API key configured. Please set your API key in the app settings.")


def _fast_llm():
    """LLM for internal JSON-only classification/verification steps. See
    GEMINI_FAST_MODEL comment above for why this is a separate, faster model
    from the one used for user-facing answer generation."""
    api_key = _api_key_var.get()
    if api_key:
        return ChatGoogleGenerativeAI(
            model=GEMINI_FAST_MODEL,
            temperature=0,
            google_api_key=api_key,
            include_thoughts=False,
            max_retries=MODEL_MAX_RETRIES,
            timeout=MODEL_TIMEOUT_SECONDS,
        )
    if fast_llm is not None:
        return fast_llm
    raise ValueError("No Gemini API key configured. Please set your API key in the app settings.")


def _effective_llm_with_fallback():
    """GEMINI_MODEL for non-tool, user-facing answer generation, falling
    back to GEMINI_FAST_MODEL if GEMINI_MODEL is still failing (e.g. a "high
    demand" 503 streak) after MODEL_MAX_RETRIES quick retries. See the
    MODEL_MAX_RETRIES/MODEL_TIMEOUT_SECONDS comment above."""
    return _effective_llm().with_fallbacks([_fast_llm()], exceptions_to_handle=_FALLBACK_EXCEPTIONS)


def _effective_llm_with_tools_and_fallback(tools):
    """Same intent as _effective_llm_with_fallback(), for calls that bind
    tools. bind_tools() must happen before with_fallbacks(): the resulting
    RunnableWithFallbacks has no bind_tools() method of its own, so each
    candidate model needs tools bound before being wrapped."""
    primary = _effective_llm().bind_tools(tools)
    fallback = _fast_llm().bind_tools(tools)
    return primary.with_fallbacks([fallback], exceptions_to_handle=_FALLBACK_EXCEPTIONS)


async def emit_progress(phase: str, label: str, **extra) -> None:
    handler = _progress_handler_var.get()
    if not handler:
        return

    payload = {
        "phase": phase,
        "label": label,
        **extra,
    }
    try:
        result = handler(payload)
        if inspect.isawaitable(result):
            await result
    except Exception as e:
        print(f"⚠️ [emit_progress] callback error (ignored): {e}")


def _has_tool_calls(message) -> bool:
    return hasattr(message, "tool_calls") and bool(message.tool_calls)


def _has_source_citation(content: str) -> bool:
    return "來源" in content or "Source:" in content


def _is_interim_response(content) -> bool:
    if not isinstance(content, str):
        return False
    # Every real, tool-grounded answer is required to end with a source
    # citation (Zero Hallucination Policy in workflow_policy.md); an interim
    # "still working" placeholder never has one, since no tool has run yet.
    # This catches short real answers that a length/position check alone
    # would still misclassify — e.g. "處理中的工單有 3 筆。[來源: Request 工作表]"
    # legitimately opens with "處理中" (a status value in this app's domain,
    # not just a "let me process this" placeholder phrase) and is well under
    # the length cutoff below.
    if _has_source_citation(content):
        return False
    normalized = content.strip().lower()
    # A genuine "still working" placeholder is short and opens with the
    # marker phrase (e.g. "讓我查一下狀態，請稍等"). A completed answer can
    # innocently contain the same prefix in past tense — "我幫你查到了！以下是
    # 19 個欄位..." contains "我幫你查" but is a real, structured answer, not a
    # placeholder. Bounding both the marker's position and the overall
    # length keeps the former case flagged (forces a real tool call) without
    # misclassifying the latter (which previously got discarded and replaced
    # with an empty reply — see the interim-retry branch in agent_node).
    if not normalized or len(normalized) > _INTERIM_RESPONSE_MAX_LEN:
        return False
    head = normalized[:_INTERIM_RESPONSE_MARKER_WINDOW]
    return any(marker.lower() in head for marker in _INTERIM_RESPONSE_MARKERS)


def _extract_user_query_for_guardrail(content) -> str:
    if not isinstance(content, str):
        return str(content)
    text = content
    for marker in ["目前使用者問題：", "使用者原始問題："]:
        if marker in text:
            text = text.rsplit(marker, 1)[-1].strip()

    clarification_marker = "使用者在釐清題選擇的條件："
    if clarification_marker in text:
        text = text.split(clarification_marker, 1)[0].strip()

    metadata_marker = "以下是使用者在送出前選擇的釐清選項"
    if metadata_marker in text:
        text = text.split(metadata_marker, 1)[0].strip()

    return text or content


def _content_to_text(content: Any) -> str:
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


def _detect_reply_language(user_query: str) -> str:
    text = _extract_user_query_for_guardrail(str(user_query or "")).strip()
    if not text:
        return "Traditional Chinese"

    cjk_count = len(re.findall(r"[\u3400-\u9fff]", text))
    english_words = re.findall(r"[A-Za-z]{2,}", text)
    english_chars = sum(len(word) for word in english_words)

    if cjk_count == 0 and english_chars > 0:
        return "English"
    if english_chars == 0 and cjk_count > 0:
        return "Traditional Chinese"

    # For mixed messages, bias toward the language carrying the question text.
    return "English" if english_chars > cjk_count * 1.5 else "Traditional Chinese"


def _language_instruction_for(user_query: str) -> SystemMessage:
    language = _detect_reply_language(user_query)
    return SystemMessage(content=(
        "## Response Language\n\n"
        f"Answer the user in {language}. Match the latest user's language for the final assistant response. "
        "Do not use this rule for frontend UI labels; UI labels must remain English."
    ))


def _parse_json_object(text: str) -> dict:
    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return {}
    try:
        return json.loads(match.group(0))
    except Exception:
        return {}


def _latest_human_index(messages: list[BaseMessage]) -> int:
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], HumanMessage) and not (
            str(messages[i].content).startswith("⚠️ 系統強制攔截")
            or str(messages[i].content).startswith("System guardrail:")
        ):
            return i
    return -1


def _has_answerable_context_before_latest_human(messages: list[BaseMessage]) -> bool:
    latest_index = _latest_human_index(messages)
    if latest_index <= 0:
        return False

    # Only consider actual tool results (ToolMessages or Prior Tool Context) as
    # "answerable context". Plain AIMessages and Conversation Memory summaries are
    # excluded because they don't constitute raw queryable data — using them causes
    # the LLM to be called without bind_tools() for data questions, which produces
    # function_call-only responses that _content_to_text() renders as empty strings.
    for message in messages[:latest_index]:
        if isinstance(message, SystemMessage):
            content = _content_to_text(message.content)
            if "Prior Tool Context" in content:
                return True
        if getattr(message, "type", "") == "tool" or message.__class__.__name__ == "ToolMessage":
            return True
    return False


async def _answer_from_context(messages: list[BaseMessage], user_query: str) -> AIMessage:
    direct_instruction = SystemMessage(content=(
        "## Contextual Follow-up Handling\n\n"
        f"Answer in {_detect_reply_language(user_query)} based on the latest user message. "
        "最新使用者問題是在延續、追問、擴寫、改寫或重新組織前文，不是獨立的新問題。"
        "請直接根據近期對話、Conversation Memory、Turn Context Decision 與 Prior Tool Context 回答。"
        "不要呼叫工具，也不要把最新問題當成搜尋關鍵字。"
        "如果前文資料足以支持，請產出使用者要求的完整結構；"
        "如果前文資料只支持部分結論，請先說明「以下根據目前已查到的資料整理」，"
        "再列出可支持的分析與缺口。"
        f"\n\n最新使用者問題：{user_query}"
    ))

    if messages and isinstance(messages[-1], HumanMessage):
        direct_messages = messages[:-1] + [direct_instruction, messages[-1]]
    else:
        direct_messages = messages + [direct_instruction]

    response = await _effective_llm_with_fallback().ainvoke(direct_messages)
    return AIMessage(content=_content_to_text(response.content).strip())


async def classify_turn_context(
    user_query: str,
    history_text: str = "",
    has_prior_tool_context: bool = False,
) -> dict:
    """
    Semantic router for a user turn. It decides how the latest message relates
    to the conversation before tools are considered.
    """
    if not str(history_text or "").strip():
        return dict(_DEFAULT_TURN_CONTEXT)

    router_prompt = f"""
你是 Data Machi 的「對話脈絡判斷器」，只輸出 JSON，不要回答使用者問題。

你的任務：根據「近期對話」與「最新使用者訊息」，判斷這輪應如何處理上下文與工具。

relation 請選一個：
- standalone: 最新訊息是獨立新問題，主要不依賴前文。
- context_follow_up: 最新訊息是在追問前文、代名詞指代、比較、補充或延續同一主題。
- context_refinement: 最新訊息是在要求改寫、擴寫、整理、格式轉換、變更呈現方式或更有條理地重組前文答案。
- fresh_tool_request: 最新訊息明確要求重新查詢、最新資料、全部資料、新的篩選條件，或前文不足以回答。
- ambiguous: 可能有關聯但脈絡不足，需要釐清。

判斷原則：
- 人類對話中，短句常依賴前文。例如「那可以整理成表格嗎」「可以更完整嗎」「那 Kelly 呢」「這些代表什麼」都通常是 context_follow_up 或 context_refinement。
- 如果最新訊息只是在改變輸出形式、深度、語氣、結構、比較方式，通常不需要重新查工具。
- 如果最新訊息新增了資料範圍、時間、對象、欄位、條件，且需要資料才能回答，可能需要 fresh_tool_request。
- 如果使用者明確說最新、重新查、全部、目前狀態、再跑一次資料，should_force_fresh_tool=true。
- 如果前文已有足夠答案或工具結果，且最新訊息只是延續/整理/擴寫，should_answer_from_context=true。
- 如果需要使用先前工具結果才能自然延續，且 has_prior_tool_context=true，should_include_prior_tool_context=true。
- 如果是延續前文，should_skip_clarification=true，避免問已能從上下文推斷的引導題。

可用 domain_hint：
analyst, trello, confluence, document, none, unknown

請只回傳 JSON：
{{
  "relation": "standalone" | "context_follow_up" | "context_refinement" | "fresh_tool_request" | "ambiguous",
  "should_answer_from_context": true/false,
  "should_include_prior_tool_context": true/false,
  "should_force_fresh_tool": true/false,
  "should_skip_clarification": true/false,
  "domain_hint": "analyst" | "trello" | "confluence" | "document" | "none" | "unknown",
  "confidence": 0.0,
  "reason": "一句很短的判斷理由"
}}

has_prior_tool_context: {str(bool(has_prior_tool_context)).lower()}

近期對話：
{history_text[-6000:]}

最新使用者訊息：
{user_query}
"""
    try:
        await emit_progress("understanding", "Checking context")
        response = await _fast_llm().ainvoke([HumanMessage(content=router_prompt)])
        parsed = _parse_json_object(_content_to_text(response.content))
        if not parsed:
            return dict(_DEFAULT_TURN_CONTEXT)

        return _sanitize_turn_context(parsed)
    except Exception as e:
        print(f"\n⚠️ [TurnContext] classifier failed: {e}")
        return dict(_DEFAULT_TURN_CONTEXT)


def _sanitize_turn_context(parsed: dict) -> dict:
    """Validate/normalize a model-produced turn-context JSON object."""
    relation = str(parsed.get("relation", "standalone"))
    if relation not in {"standalone", "context_follow_up", "context_refinement", "fresh_tool_request", "ambiguous"}:
        relation = "standalone"

    domain_hint = str(parsed.get("domain_hint", "unknown"))
    if domain_hint not in {"analyst", "trello", "confluence", "document", "none", "unknown"}:
        domain_hint = "unknown"

    try:
        confidence = float(parsed.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "relation": relation,
        "should_answer_from_context": bool(parsed.get("should_answer_from_context", False)),
        "should_include_prior_tool_context": bool(parsed.get("should_include_prior_tool_context", False)),
        "should_force_fresh_tool": bool(parsed.get("should_force_fresh_tool", False)),
        "should_skip_clarification": bool(parsed.get("should_skip_clarification", False)),
        "domain_hint": domain_hint,
        "confidence": max(0.0, min(1.0, confidence)),
        "reason": str(parsed.get("reason", ""))[:240],
    }


def _extract_turn_context(messages: list[BaseMessage]) -> dict:
    for message in messages:
        if not isinstance(message, SystemMessage):
            continue
        content = _content_to_text(message.content)
        if "## Turn Context Decision" not in content:
            continue
        parsed = _parse_json_object(content)
        if parsed:
            merged = dict(_DEFAULT_TURN_CONTEXT)
            merged.update(parsed)
            return merged
    return dict(_DEFAULT_TURN_CONTEXT)


def _should_answer_from_context(turn_context: dict, messages: list[BaseMessage]) -> bool:
    if not turn_context.get("should_answer_from_context"):
        return False
    if turn_context.get("should_force_fresh_tool"):
        return False
    latest_query = ""
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            latest_query = _extract_user_query_for_guardrail(_content_to_text(message.content))
            break
    if _is_correction_challenge_query(latest_query):
        return False
    return _has_answerable_context_before_latest_human(messages)


def _prepare_messages_for_model(messages: list[BaseMessage]) -> list[BaseMessage]:
    if not messages or not (
        isinstance(messages[0], SystemMessage)
        and messages[0].content == system_prompt
    ):
        messages = [SystemMessage(content=system_prompt)] + messages

    primary_system = messages[0]
    context_systems = [
        message for message in messages[1:]
        if isinstance(message, SystemMessage)
    ]
    dialogue_messages = [
        message for message in messages[1:]
        if not isinstance(message, SystemMessage)
    ]

    if len(dialogue_messages) > MAX_HISTORY:
        dialogue_messages = dialogue_messages[-MAX_HISTORY:]

    latest_user_query = ""
    for message in reversed(dialogue_messages):
        if isinstance(message, HumanMessage):
            latest_user_query = _content_to_text(message.content)
            break

    language_systems = []
    if latest_user_query:
        language_systems.append(_language_instruction_for(latest_user_query))

    return [primary_system] + context_systems + language_systems + dialogue_messages


def _looks_like_document_query(user_query: str) -> bool:
    if not get_loaded_files():
        return False

    normalized = str(user_query or "").strip()
    if not normalized:
        return False

    loaded_file_names = [os.path.splitext(name)[0].lower() for name in get_loaded_files()]
    lowered = normalized.lower()
    if any(file_name and file_name in lowered for file_name in loaded_file_names):
        return True

    compact = re.sub(r"\s+", "", normalized)
    return any(term.lower() in lowered or term in compact for term in _DOCUMENT_QUERY_TERMS)


def _is_correction_challenge_query(user_query: str) -> bool:
    lowered = str(user_query or "").lower()
    compact = re.sub(r"\s+", "", lowered)
    return any(term in lowered or term in compact for term in _CORRECTION_CHALLENGE_TERMS)


def _fallback_clarification(user_query: str) -> dict:
    """
    Deterministic clarification for broad asks that the LLM may otherwise answer
    with a chat bubble. This keeps the UI panel behavior stable for common vague
    report requests.
    """
    normalized = user_query.strip().lower()
    compact = re.sub(r"\s+", "", normalized)

    broad_report_terms = [
        "分析報告", "一份報告", "報告", "analysisreport", "分析一下", "做分析"
    ]
    concrete_scope_terms = [
        "request", "ticket", "工單", "工作表", "worksheet", "trello", "卡片",
        "專案", "confluence", "文件", "dashboard", "圖表", "chart", "狀態",
        "status", "市場", "market", "資料來源", "data source", "負責人",
        "assigned", "時間", "今年", "本月", "202", "hk", "tw", "ikna"
    ]

    is_broad_report = any(term in compact for term in broad_report_terms)
    has_concrete_scope = any(term in normalized or term in compact for term in concrete_scope_terms)

    if is_broad_report and not has_concrete_scope:
        return {
            "needs_clarification": True,
            "reason": "The data scope for the analysis report is not clear yet.",
            "questions": [
                {
                    "id": "report_scope",
                    "question": "Which data source should I analyze?",
                    "type": "single",
                    "options": list(_REPORT_SCOPE_OPTIONS),
                }
            ],
        }

    if is_broad_report and has_concrete_scope and "圖表" not in compact and "chart" not in normalized:
        return {
            "needs_clarification": True,
            "reason": "Please choose the report format first.",
            "questions": [
                {
                    "id": "report_format",
                    "question": "How would you like the analysis report presented?",
                    "type": "single",
                    "options": list(_REPORT_FORMAT_OPTIONS),
                }
            ],
        }

    return dict(_DEFAULT_CLARIFICATION)


def _has_tool_result_after_latest_human(messages: list[BaseMessage]) -> bool:
    latest_human_index = -1
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], HumanMessage) and not (
            str(messages[i].content).startswith("⚠️ 系統強制攔截")
            or str(messages[i].content).startswith("System guardrail:")
        ):
            latest_human_index = i
            break

    if latest_human_index == -1:
        return False

    for message in messages[latest_human_index + 1:]:
        if getattr(message, "type", "") == "tool" or message.__class__.__name__ == "ToolMessage":
            return True
    return False


async def _classify_user_intent(user_query: str) -> dict:
    """
    Semantic guardrail classifier. This is not the primary router; the tool-bound
    LLM still decides tool calls first. We only use this when the LLM returns a
    direct answer, to decide whether that direct answer should be allowed.
    """
    if _looks_like_document_query(user_query):
        return {
            "needs_tool": True,
            "fresh_query": False,
            "domain": "document",
            "reason": "問題看起來是在詢問已上傳 PDF/文件內容",
        }

    classifier_prompt = f"""
你是 Data Machi 的意圖分類器，只輸出 JSON，不要回答使用者問題。

請判斷使用者問題是否需要查詢 IKEA Data Team 內部工具。

可用工具領域：
- trello: IKEA Data Requests Trello 看板、卡片、專案進度、負責人、標籤、留言。
- analyst: Google Sheet / worksheet / Request 工作表、工單/ticket/request 數量、統計、圖表、KPI、趨勢、資料表查詢。
- confluence: Data Team Toolbox（Confluence）中的團隊文件、流程、名詞定義、dashboard/tool 內部說明、操作教學。使用者說「Toolbox」或「Data Team Toolbox」即屬於此 domain。
- document: 已上傳 PDF/文件內容。
- none: 一般閒聊、改寫、翻譯、或可以直接根據目前對話文字回答且不需要內部資料。

判斷規則：
- 如果問題需要最新、完整、全部、重新查詢、目前狀態、或使用者要求全量彙整，fresh_query=true。
- 如果問題是在追問「上述、這些、剛剛」且目前上下文足以回答，可 needs_tool=false。
- 如果問題是在上一則回答之後要求「更完整」、「比較完整」、「有結構」、「整理成報告」、「更詳細」，
  這通常是要求改寫/擴寫既有答案，不是新的資料查詢；除非使用者明確要求重新查詢或最新資料，否則 needs_tool=false。
- 如果問題涉及 IKEA 內部資料、專案、工單、文件、dashboard 定義或 worksheet 統計，needs_tool=true。
- 如果問題要求圖表且資料來自 ticket/request/worksheet，domain=analyst。

請只回傳以下 JSON schema：
{{
  "needs_tool": true/false,
  "fresh_query": true/false,
  "domain": "trello" | "analyst" | "confluence" | "document" | "none",
  "reason": "一句很短的判斷理由"
}}

使用者問題：
{user_query}
"""
    try:
        response = await _fast_llm().ainvoke([HumanMessage(content=classifier_prompt)])
        parsed = _parse_json_object(_content_to_text(response.content))
        if not parsed:
            return dict(_DEFAULT_INTENT)

        domain = parsed.get("domain", "none")
        if domain not in {"trello", "analyst", "confluence", "document", "none"}:
            domain = "none"

        return {
            "needs_tool": bool(parsed.get("needs_tool", False)),
            "fresh_query": bool(parsed.get("fresh_query", False)),
            "domain": domain,
            "reason": str(parsed.get("reason", ""))[:200],
        }
    except Exception as e:
        print(f"\n⚠️ [Guardrail] Intent classifier failed: {e}")
        return dict(_DEFAULT_INTENT)


def _sanitize_clarification_questions(parsed: dict) -> list:
    questions = []
    for question in parsed.get("questions", [])[:1]:
        options = []
        for option in question.get("options", [])[:5]:
            label = str(option.get("label", "")).strip()
            value = str(option.get("value", label)).strip()
            if label and value:
                options.append({
                    "label": label,
                    "value": value,
                    "description": str(option.get("description", "")).strip(),
                })
        if str(question.get("id", "")) == "chart_dimension":
            allowed_values = {option["value"] for option in _CHART_DIMENSION_OPTIONS}
            options = [option for option in options if option["value"] in allowed_values]
            if len(options) < 2:
                options = list(_CHART_DIMENSION_OPTIONS)
        if question.get("question") and options:
            questions.append({
                "id": str(question.get("id", f"q{len(questions) + 1}")),
                "question": str(question.get("question")),
                "type": "single",
                "options": options,
            })
    return questions


async def suggest_clarifications(user_query: str, history_text: str = "", active_documents: list = None) -> dict:
    """
    Decide whether the UI should ask a short clarification before running tools.
    This powers the floating option panel above the input box.

    對話脈絡判斷（turn_context）與釐清題設計在同一次 fast-LLM 呼叫完成。
    先前是 classify_turn_context() → 釐清 prompt 兩次串行呼叫，而且這兩次
    都擋在 /chat/stream 開始之前，等於每則訊息都先付兩次 LLM 往返的入場費；
    合併後入場費減半。classify_turn_context() 本身保留給 /chat/stream 在
    前端沒帶 turn_context 時的後援路徑。
    """
    has_history = bool(str(history_text or "").strip())

    combined_prompt = f"""
你是 Data Machi 的「對話脈絡判斷器」兼「需求釐清設計器」，只輸出 JSON，不要回答使用者問題。
你要在同一份 JSON 裡完成兩件事：A. 判斷這輪對話脈絡（turn_context）；B. 判斷是否需要在執行工具前向使用者釐清。

## A. 對話脈絡判斷（turn_context）

relation 請選一個：
- standalone: 最新訊息是獨立新問題，主要不依賴前文。
- context_follow_up: 最新訊息是在追問前文、代名詞指代、比較、補充或延續同一主題。
- context_refinement: 最新訊息是在要求改寫、擴寫、整理、格式轉換、變更呈現方式或更有條理地重組前文答案。
- fresh_tool_request: 最新訊息明確要求重新查詢、最新資料、全部資料、新的篩選條件，或前文不足以回答。
- ambiguous: 可能有關聯但脈絡不足，需要釐清。

判斷原則：
- 人類對話中，短句常依賴前文。例如「那可以整理成表格嗎」「可以更完整嗎」「那 Kelly 呢」「這些代表什麼」都通常是 context_follow_up 或 context_refinement。
- 如果最新訊息只是在改變輸出形式、深度、語氣、結構、比較方式，通常不需要重新查工具。
- 如果最新訊息新增了資料範圍、時間、對象、欄位、條件，且需要資料才能回答，可能需要 fresh_tool_request。
- 如果使用者明確說最新、重新查、全部、目前狀態、再跑一次資料，should_force_fresh_tool=true。
- 如果前文已有足夠答案或工具結果，且最新訊息只是延續/整理/擴寫，should_answer_from_context=true。
- 如果需要使用先前工具結果才能自然延續，且 has_prior_tool_context=true，should_include_prior_tool_context=true。
- 如果是延續前文，should_skip_clarification=true，避免問已能從上下文推斷的引導題。
- 如果「近期對話」是空的，relation 固定為 standalone，所有 should_* 為 false。

可用 domain_hint：analyst, trello, confluence, document, none, unknown

## B. 釐清題判斷

只在「缺少的選擇會明顯影響工具、查詢條件或圖表呈現」時才 needs_clarification=true。
如果問題已經足夠明確，請 needs_clarification=false。
如果 A 判斷為延續前文（should_skip_clarification=true），needs_clarification 必須為 false。

重要語言規則：
- 所有會顯示在前端 UI 的欄位都必須使用英文：reason、question、label、description。
- 即使使用者用中文提問，clarification panel 仍需輸出英文，避免 UI 中英混雜。
- value 可以保留系統查詢需要的英文欄位值，例如 Status、Market、Data Source。

常見需要釐清的情境：
- 使用者只說「分析報告」、「一份報告」、「幫我分析」但沒有指定資料來源或分析對象。
- 使用者要求圖表，但沒有指定呈現維度，例如狀態、市場、資料來源、支援類型、負責人。
- 使用者要求整理資料，但沒有說要摘要、表格、圖表或明細。
- 使用者問 Trello 進度但沒有指定 list 或範圍，且上下文也無法判斷。
- 搜尋文件/Confluence 可能命中多個主題，需要使用者選擇方向。
- 如果使用者是在上一則回答後要求「更完整」、「比較完整」、「有結構」、「更詳細」或「整理成報告」，
  且近期對話已經提供資料脈絡，請不要再釐清資料來源；這是延續前文的改寫/擴寫需求。

請只提出 1 個最關鍵的問題，每題 2-5 個選項。選項要短、具體、互斥。不要問已經可從問題或上下文推斷的事。
如果有多個缺口，優先詢問「最會影響工具查詢結果」的問題；其他缺口留到下一輪再問，不要一次塞進同一個提示框。

## 回傳 JSON schema

{{
  "turn_context": {{
    "relation": "standalone" | "context_follow_up" | "context_refinement" | "fresh_tool_request" | "ambiguous",
    "should_answer_from_context": true/false,
    "should_include_prior_tool_context": true/false,
    "should_force_fresh_tool": true/false,
    "should_skip_clarification": true/false,
    "domain_hint": "analyst" | "trello" | "confluence" | "document" | "none" | "unknown",
    "confidence": 0.0,
    "reason": "一句很短的判斷理由"
  }},
  "needs_clarification": true/false,
  "reason": "A short reason in English",
  "questions": [
    {{
      "id": "chart_dimension",
      "question": "Which dimension should the chart use?",
      "type": "single",
      "options": [
        {{"label": "By status", "value": "Status", "description": "Compare ticket counts by status"}},
        {{"label": "By market", "value": "Market", "description": "Compare TW, HK, IKNA, and other markets"}},
        {{"label": "By data source", "value": "Data Source", "description": "Compare sources such as CDP and GA4"}},
        {{"label": "By month", "value": "Month", "description": "Show monthly ticket volume trends"}}
      ]
    }}
  ]
}}

has_prior_tool_context: {str(has_history).lower()}

近期對話：
{history_text[-6000:] if has_history else "(空)"}

{'目前使用者已勾選的 PDF 文件：' + ', '.join(active_documents) if active_documents else '目前未勾選任何 PDF 文件'}

最新使用者訊息：
{user_query}
"""

    def with_turn_context(result: dict, turn_context: dict) -> dict:
        payload = dict(result)
        payload["turn_context"] = turn_context
        return payload

    try:
        await emit_progress("understanding", "Checking context")
        response = await _fast_llm().ainvoke([HumanMessage(content=combined_prompt)])
        parsed = _parse_json_object(_content_to_text(response.content))
        if not parsed:
            return with_turn_context(_fallback_clarification(user_query), dict(_DEFAULT_TURN_CONTEXT))

        # 空對話沒有脈絡可判斷，維持與 classify_turn_context 相同的確定性行為。
        if has_history:
            turn_context = _sanitize_turn_context(parsed.get("turn_context") or {})
        else:
            turn_context = dict(_DEFAULT_TURN_CONTEXT)

        if turn_context.get("should_skip_clarification") or not parsed.get("needs_clarification"):
            return with_turn_context(_DEFAULT_CLARIFICATION, turn_context)

        questions = _sanitize_clarification_questions(parsed)
        if not questions:
            return with_turn_context(_DEFAULT_CLARIFICATION, turn_context)

        return with_turn_context({
            "needs_clarification": True,
            "questions": questions,
            "reason": str(parsed.get("reason", ""))[:200],
        }, turn_context)
    except Exception as e:
        print(f"\n⚠️ [Clarification] failed: {e}")
        return with_turn_context(_fallback_clarification(user_query), dict(_DEFAULT_TURN_CONTEXT))

async def parallel_tool_node(state: AgentState):
    """
    並行執行所有工具呼叫：當 LLM 同時呼叫多個工具時，
    改為 asyncio.gather 並行處理，大幅減少累積等待時間。
    """
    last_message = state["messages"][-1]
    tool_calls = last_message.tool_calls

    async def execute_one(tc):
        t = _tool_map.get(tc["name"])
        tool_name = tc["name"]
        started_at = time.perf_counter()
        await emit_progress(
            "tool",
            _TOOL_PROGRESS_LABELS.get(tool_name, f"Querying {tool_name}"),
            tool=tool_name,
            status="started",
        )
        if not t:
            await emit_progress(
                "tool",
                f"Tool not found: {tool_name}",
                tool=tool_name,
                status="failed",
                elapsed_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return ToolMessage(
                content=f"Tool not found: {tool_name}",
                tool_call_id=tc["id"],
                name=tool_name
            )
        try:
            # 使用 asyncio.to_thread 避免 sync 工具阻塞 event loop
            result = await asyncio.to_thread(t.invoke, tc["args"])
            await emit_progress(
                "tool",
                f"{_TOOL_PROGRESS_LABELS.get(tool_name, tool_name)} completed",
                tool=tool_name,
                status="completed",
                elapsed_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return ToolMessage(
                content=str(result),
                tool_call_id=tc["id"],
                name=tool_name
            )
        except Exception as e:
            await emit_progress(
                "tool",
                f"{_TOOL_PROGRESS_LABELS.get(tool_name, tool_name)} failed",
                tool=tool_name,
                status="failed",
                elapsed_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return ToolMessage(
                content=f"Tool execution error: {str(e)}",
                tool_call_id=tc["id"],
                name=tool_name
            )

    results = await asyncio.gather(*[execute_one(tc) for tc in tool_calls])
    return {"messages": list(results)}

def _consecutive_interim_count(messages: list) -> int:
    """Count consecutive AI interim responses (no tool calls) at the tail of messages."""
    count = 0
    for msg in reversed(messages):
        if (
            isinstance(msg, AIMessage)
            and not _has_tool_calls(msg)
            and _is_interim_response(_content_to_text(msg.content))
        ):
            count += 1
        else:
            break
    return count


async def agent_node(state: AgentState):
    messages = state["messages"]

    # Detect retry: the last message is an AI interim response with no tool call.
    # In that case inject a corrective instruction so the LLM actually calls the tool.
    is_retry = (
        messages
        and isinstance(messages[-1], AIMessage)
        and not _has_tool_calls(messages[-1])
        and _is_interim_response(_content_to_text(messages[-1].content))
    )

    messages = _prepare_messages_for_model(messages)

    last_human_msg = next((m.content for m in reversed(messages) if isinstance(m, HumanMessage)), "")
    guardrail_query = _extract_user_query_for_guardrail(last_human_msg)
    turn_context = _extract_turn_context(messages)

    # Follow-up / refinement：上下文已足夠，直接整理回答，不重新查工具
    if _should_answer_from_context(turn_context, messages):
        await emit_progress("composing", "Drafting from context")
        response = await _answer_from_context(messages, guardrail_query)
        # Gemini may return only a function_call part (no text) when forced into a
        # data-fetching path without bind_tools(). _content_to_text() then yields "".
        # Fall through to the normal tool-calling flow instead of returning empty.
        if _content_to_text(response.content).strip():
            return {"messages": [response]}

    if is_retry:
        await emit_progress("tool", "Retrying tool call")
        # Append a corrective system message to force an immediate tool call
        messages = messages + [SystemMessage(content=(
            "## 工具呼叫強制指令\n\n"
            "你剛才說要查詢但沒有呼叫任何工具，導致流程中斷。"
            "請**立即**呼叫適當的工具完成任務，不要再輸出任何說明、預告或中文敘述。"
            "直接執行工具呼叫，不要有任何前言。"
        ))]
    else:
        await emit_progress("thinking", "Choosing the right tool")

    response = await _effective_llm_with_tools_and_fallback(all_tools).ainvoke(messages)

    if _has_tool_calls(response):
        await emit_progress("tool", "Preparing data lookup", status="queued")
    else:
        await emit_progress("composing", "Drafting the response")

    return {"messages": [response]}


def should_continue(state: AgentState):
    """判斷 LLM 是呼叫了工具、需要 retry，還是已得到最終答案"""
    last_message = state["messages"][-1]

    if _has_tool_calls(last_message):
        return "action"

    # If the LLM generated planning text without calling a tool, retry up to the limit
    if _is_interim_response(_content_to_text(last_message.content)):
        if _consecutive_interim_count(state["messages"]) <= _MAX_INTERIM_RETRIES:
            return "agent"

    return END

# 建立我們自己的 LangGraph 狀態機 (StateGraph)
workflow = StateGraph(AgentState)
workflow.add_node("agent", agent_node)
workflow.add_node("action", parallel_tool_node)

workflow.add_edge(START, "agent")
workflow.add_conditional_edges("agent", should_continue)
workflow.add_edge("action", "agent")

coordinator_executor = workflow.compile()
