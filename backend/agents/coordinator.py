from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.prebuilt import create_react_agent
from dotenv import load_dotenv
import os
from datetime import datetime

# Import tools from other agents
from .trello import trello_tools
from .confluence import confluence_tools
from .document import document_tools
from .analyst import analyst_tools

load_dotenv()

llm = ChatGoogleGenerativeAI(
    model="gemini-2.5-flash",
    temperature=0,
    google_api_key=os.getenv("GOOGLE_API_KEY")
)

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


prompt_modules = {
    "Core Identity": _read_prompt_module("core_identity.md"),
    "Workflow Policy": _read_prompt_module("workflow_policy.md"),
    "Tool Routing": _read_prompt_module("tool_routing.md"),
    "Data Schema": _read_prompt_module("data_schema.md"),
    "Response Formatting": _read_prompt_module("response_formatting.md"),
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

# Prompt Priority

請依照以下優先順序執行。若不同模組之間發生衝突，永遠以前面的規則為準：

1. 本 System Context 與 Prompt Priority
2. Core Identity, scope, out-of-scope, identity guardrails
3. Workflow, zero hallucination, tool usage, citation, empty-result policy
4. Tool routing and data schema
5. Response formatting
6. Skills, communication style, glossary reference

# Loaded Prompt Modules

{module_sections}

## Glossary Usage Note

若 glossary 未涵蓋某個縮寫或專有名詞，請務必先呼叫 Confluence 工具查詢，不要自行展開或猜測。
"""

import asyncio
import json
import re
from typing import Annotated, Any, TypedDict
from langchain_core.messages import BaseMessage, SystemMessage, AIMessage, HumanMessage, ToolMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages

# 定義 Graph 狀態，儲存對話歷史
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

# 綁定所有工具給 LLM
model_with_tools = llm.bind_tools(all_tools)

# 建立工具查詢 map，供 parallel_tool_node 使用
_tool_map = {t.name: t for t in all_tools}

# Chat history 上限（保留 system + 最近 N 則，避免 token 越來越多）
MAX_HISTORY = 20

_INTERIM_RESPONSE_MARKERS = [
    "請稍等", "請等一下", "稍等一下", "等我一下", "我正在", "正在處理",
    "處理中", "我將", "我會", "我來幫你", "讓我來", "讓我先", "立刻請",
    "馬上請", "我幫你查", "我幫你整理", "我來查", "我來整理"
]

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

_CHART_DIMENSION_OPTIONS = [
    {"label": "依月份", "value": "Month", "description": "看每月 ticket 數量趨勢"},
    {"label": "依狀態", "value": "Status", "description": "看各狀態的工單數量"},
    {"label": "依市場", "value": "Market", "description": "比較 TW、HK、IKNA 等市場"},
    {"label": "依資料來源", "value": "Data Source", "description": "比較 CDP、GA4 等來源"},
    {"label": "依支援類型", "value": "Data Support", "description": "比較 dashboard、report、support 等類型"},
    {"label": "依負責人", "value": "Assigned To", "description": "比較各負責人的工單量"},
]

_REPORT_SCOPE_OPTIONS = [
    {"label": "Request 工單", "value": "Request worksheet", "description": "分析工單數量、狀態、市場與資料來源"},
    {"label": "Trello 專案", "value": "Trello board", "description": "整理看板清單、卡片進度與負責狀態"},
    {"label": "Confluence 文件", "value": "Confluence pages", "description": "彙整文件定義、流程或 dashboard 說明"},
]

_REPORT_FORMAT_OPTIONS = [
    {"label": "摘要說明", "value": "summary", "description": "用重點文字整理分析結果"},
    {"label": "圖表", "value": "chart", "description": "產生互動式圖表和簡短洞察"},
    {"label": "表格", "value": "table", "description": "整理成乾淨的彙總表"},
]


def _has_tool_calls(message) -> bool:
    return hasattr(message, "tool_calls") and bool(message.tool_calls)


def _is_interim_response(content) -> bool:
    if not isinstance(content, str):
        return False
    normalized = content.lower()
    return any(marker.lower() in normalized for marker in _INTERIM_RESPONSE_MARKERS)


def _extract_user_query_for_guardrail(content) -> str:
    if not isinstance(content, str):
        return str(content)
    marker = "目前使用者問題："
    if marker in content:
        return content.rsplit(marker, 1)[-1].strip()
    return content


def _content_to_text(content: Any) -> str:
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
            "reason": "分析報告的資料範圍還不明確",
            "questions": [
                {
                    "id": "report_scope",
                    "question": "你想分析哪一類資料？",
                    "type": "single",
                    "options": list(_REPORT_SCOPE_OPTIONS),
                }
            ],
        }

    if is_broad_report and has_concrete_scope and "圖表" not in compact and "chart" not in normalized:
        return {
            "needs_clarification": True,
            "reason": "先確認報告呈現方式",
            "questions": [
                {
                    "id": "report_format",
                    "question": "你希望分析報告以什麼形式呈現？",
                    "type": "single",
                    "options": list(_REPORT_FORMAT_OPTIONS),
                }
            ],
        }

    return dict(_DEFAULT_CLARIFICATION)


def _has_tool_result_after_latest_human(messages: list[BaseMessage]) -> bool:
    latest_human_index = -1
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], HumanMessage) and not str(messages[i].content).startswith("⚠️ 系統強制攔截"):
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
    classifier_prompt = f"""
你是 Data Machi 的意圖分類器，只輸出 JSON，不要回答使用者問題。

請判斷使用者問題是否需要查詢 IKEA Data Team 內部工具。

可用工具領域：
- trello: IKEA Data Requests Trello 看板、卡片、專案進度、負責人、標籤、留言。
- analyst: Google Sheet / worksheet / Request 工作表、工單/ticket/request 數量、統計、圖表、KPI、趨勢、資料表查詢。
- confluence: 團隊文件、流程、名詞定義、dashboard/tool 內部說明、操作教學。
- document: 已上傳 PDF/文件內容。
- none: 一般閒聊、改寫、翻譯、或可以直接根據目前對話文字回答且不需要內部資料。

判斷規則：
- 如果問題需要最新、完整、全部、重新查詢、目前狀態、或使用者要求全量彙整，fresh_query=true。
- 如果問題是在追問「上述、這些、剛剛」且目前上下文足以回答，可 needs_tool=false。
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
        response = await llm.ainvoke([HumanMessage(content=classifier_prompt)])
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


async def suggest_clarifications(user_query: str, history_text: str = "") -> dict:
    """
    Decide whether the UI should ask a short clarification before running tools.
    This powers the floating option panel above the input box.
    """
    fallback = _fallback_clarification(user_query)
    if fallback.get("needs_clarification"):
        return fallback

    clarification_prompt = f"""
你是 Data Machi 的需求釐清設計器。請先理解使用者問題，再判斷是否需要在執行工具前向使用者釐清。

只在「缺少的選擇會明顯影響工具、查詢條件或圖表呈現」時才 needs_clarification=true。
如果問題已經足夠明確，請 needs_clarification=false。

常見需要釐清的情境：
- 使用者只說「分析報告」、「一份報告」、「幫我分析」但沒有指定資料來源或分析對象。
- 使用者要求圖表，但沒有指定呈現維度，例如狀態、市場、資料來源、支援類型、負責人。
- 使用者要求整理資料，但沒有說要摘要、表格、圖表或明細。
- 使用者問 Trello 進度但沒有指定 list 或範圍，且上下文也無法判斷。
- 搜尋文件/Confluence 可能命中多個主題，需要使用者選擇方向。

請最多提出 2 個問題，每題 2-5 個選項。選項要短、具體、互斥。不要問已經可從問題或上下文推斷的事。

回傳 JSON schema：
{{
  "needs_clarification": true/false,
  "reason": "一句很短的理由",
  "questions": [
    {{
      "id": "chart_dimension",
      "question": "你想用哪個維度呈現圖表？",
      "type": "single",
      "options": [
        {{"label": "依狀態", "value": "Status", "description": "看各狀態的工單數量"}},
        {{"label": "依市場", "value": "Market", "description": "比較 TW、HK、IKNA 等市場"}},
        {{"label": "依資料來源", "value": "Data Source", "description": "比較 CDP、GA4 等來源"}},
        {{"label": "依月份", "value": "Month", "description": "看每月 ticket 數量趨勢"}}
      ]
    }}
  ]
}}

近期對話摘要：
{history_text[-3000:]}

使用者問題：
{user_query}
"""
    try:
        response = await llm.ainvoke([HumanMessage(content=clarification_prompt)])
        parsed = _parse_json_object(_content_to_text(response.content))
        if not parsed or not parsed.get("needs_clarification"):
            return dict(_DEFAULT_CLARIFICATION)

        questions = []
        for question in parsed.get("questions", [])[:2]:
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

        if not questions:
            return dict(_DEFAULT_CLARIFICATION)

        return {
            "needs_clarification": True,
            "questions": questions,
            "reason": str(parsed.get("reason", ""))[:200],
        }
    except Exception as e:
        print(f"\n⚠️ [Clarification] failed: {e}")
        return dict(_DEFAULT_CLARIFICATION)

async def parallel_tool_node(state: AgentState):
    """
    並行執行所有工具呼叫：當 LLM 同時呼叫多個工具時，
    改為 asyncio.gather 並行處理，大幅減少累積等待時間。
    """
    last_message = state["messages"][-1]
    tool_calls = last_message.tool_calls

    async def execute_one(tc):
        t = _tool_map.get(tc["name"])
        if not t:
            return ToolMessage(
                content=f"找不到工具: {tc['name']}",
                tool_call_id=tc["id"],
                name=tc["name"]
            )
        try:
            # 使用 asyncio.to_thread 避免 sync 工具阻塞 event loop
            result = await asyncio.to_thread(t.invoke, tc["args"])
            return ToolMessage(
                content=str(result),
                tool_call_id=tc["id"],
                name=tc["name"]
            )
        except Exception as e:
            return ToolMessage(
                content=f"工具執行錯誤: {str(e)}",
                tool_call_id=tc["id"],
                name=tc["name"]
            )

    results = await asyncio.gather(*[execute_one(tc) for tc in tool_calls])
    return {"messages": list(results)}

async def agent_node(state: AgentState):
    """
    LLM 思考節點：決定要呼叫工具，還是直接回答
    我們在這裡加上客製化的防禦邏輯，防堵幻覺。
    """
    messages = state["messages"]

    # 確保系統提示詞永遠在對話最前面
    if not messages or getattr(messages[0], "type", "") != "system":
        messages = [SystemMessage(content=system_prompt)] + messages

    # ✂️ Chat history 截斷：保留 system message + 最近 MAX_HISTORY 則
    # 避免對話越長、每次傳給 LLM 的 token 越多導致變慢
    if len(messages) > MAX_HISTORY + 1:
        messages = messages[:1] + messages[-(MAX_HISTORY):]

    response = await model_with_tools.ainvoke(messages)

    # 🕵️‍♂️ 【客製化攔截點：強制檢查工具使用與幻覺防護】
    # 1. 找出使用者最後一句話
    last_human_msg = next((m.content for m in reversed(messages) if isinstance(m, HumanMessage)), "")
    guardrail_query = _extract_user_query_for_guardrail(last_human_msg)

    # 2. 如果模型沒有呼叫工具，才用語意分類器判斷是否需要攔截重試。
    #    這取代舊版不斷擴充 keyword list 的做法。
    intent = dict(_DEFAULT_INTENT)
    if not _has_tool_calls(response):
        intent = await _classify_user_intent(guardrail_query)
    needs_tool = bool(intent.get("needs_tool", False))
    needs_fresh_query = bool(intent.get("fresh_query", False))

    # 3. 檢查是否已經針對最新 user turn 取得 tool 結果。
    # fresh_query 只需要在「尚未查過」時強制，避免工具回來後又被同一個 user turn 反覆觸發。
    has_tool_result_after_latest_human = _has_tool_result_after_latest_human(messages)

    # 同時保留最近 tool result 的檢查，給後面的查無結果防幻覺使用。
    tool_messages = [m for m in messages[-10:] if getattr(m, "type", "") == "tool" or m.__class__.__name__ == "ToolMessage"]
    has_recent_tool_result = len(tool_messages) > 0

    # 🛑 防護 A：該查沒查 -> 強制重試 (內部自動 re-prompt)
    if not _has_tool_calls(response):
        if needs_tool and not has_tool_result_after_latest_human:
            if needs_fresh_query:
                print(f"\n⚠️ [Guardrail] Intent={intent.get('domain')} fresh query，強制重新呼叫工具。Reason: {intent.get('reason')}")
                retry_msg = f"⚠️ 系統強制攔截：意圖分類判斷這題需要重新查詢內部工具，建議工具領域是 {intent.get('domain')}。你不能只整理 chat history 中的舊資料。原始使用者問題是：{guardrail_query}。請保留使用者要求的輸出形式（例如圖表/chart）並立即呼叫最合適的工具！"
            else:
                print(f"\n⚠️ [Guardrail] Intent={intent.get('domain')} needs tool but no tool call，強制重發 Prompt。Reason: {intent.get('reason')}")
                retry_msg = f"⚠️ 系統強制攔截：意圖分類判斷這題需要內部工具，建議工具領域是 {intent.get('domain')}，但你沒有呼叫任何工具。原始使用者問題是：{guardrail_query}。請保留使用者要求的輸出形式（例如圖表/chart）並立即呼叫最合適的工具！"
            retry_prompt = HumanMessage(content=retry_msg)
            response = await model_with_tools.ainvoke(messages + [retry_prompt])
            # 如果第二次還是不呼叫，就給強制安全回應
            if not _has_tool_calls(response):
                forced_msg = AIMessage(content="我翻遍了手邊的工具，但目前真的找不到這方面的相關資訊喔！為確保資訊正確，我不敢亂猜，可以請您提供更多關鍵字嗎？😊")
                return {"messages": [forced_msg]}

    # 🛑 防護 A2：禁止把「請稍等 / 我正在處理」當作最終答案
    if not _has_tool_calls(response) and needs_tool and _is_interim_response(response.content):
        print("\n⚠️ [Guardrail] 偵測到 LLM 只回覆處理中訊息，強制改為立即呼叫工具！")
        retry_msg = (
            "⚠️ 系統強制攔截：你的上一則回答只是『請稍等/正在處理』，"
            "但系統不支援把這種中途狀態當作最終答案。請不要說你將要查詢，"
            "請立刻呼叫最相關的工具取得資料；如果問題資訊不足，請直接提出明確的澄清問題。"
        )
        response = await model_with_tools.ainvoke(messages + [HumanMessage(content=retry_msg)])
        if not _has_tool_calls(response) and _is_interim_response(response.content):
            forced_msg = AIMessage(content="我需要再確認一下查詢條件，才不會整理錯資料。可以請你補充要查的工作表、時間範圍或負責人嗎？")
            return {"messages": [forced_msg]}

    # 🛑 防護 B：工具查無資料，但大腦開始亂掰 (幻覺生成) -> 直接覆寫
    if not _has_tool_calls(response):
        if has_recent_tool_result:
            last_tool_content = tool_messages[-1].content
            # 如果末次工具回傳了警告或找不到
            if "系統警告" in last_tool_content or "找不到" in last_tool_content or "無結果" in last_tool_content:
                # 檢查 LLM 的回答是否有乖乖承認找不到
                admit_keywords = ["找不到", "沒有找到", "無法找到", "沒有相關", "查無", "未提及", "沒有提及"]
                if not any(ak in response.content for ak in admit_keywords):
                    print("\n⚠️ [Guardrail] 偵測到 LLM 在 Tool 查無結果後試圖捏造答案 (幻覺)！已被強制阻擋。")
                    safe_msg = AIMessage(content="我剛才幫你翻遍了手邊的系統，但目前真的找不到相關的資訊喔！為確保正確避免給錯資訊，這部分可能要請你再確認一下關鍵字，或是問問相關負責的同事喔！😊")
                    return {"messages": [safe_msg]}

    return {"messages": [response]}

def should_continue(state: AgentState):
    """判斷 LLM 是呼叫了工具，還是已經得到最終答案"""
    last_message = state["messages"][-1]
    
    # 如果有呼叫工具的動作，導向 action 節點
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "action"
    
    # 如果沒有呼叫工具（代表它想直接跟您講話），結束圖的執行
    return END

# 建立我們自己的 LangGraph 狀態機 (StateGraph)
workflow = StateGraph(AgentState)
workflow.add_node("agent", agent_node)
workflow.add_node("action", parallel_tool_node)

workflow.add_edge(START, "agent")
workflow.add_conditional_edges("agent", should_continue)
workflow.add_edge("action", "agent")

coordinator_executor = workflow.compile()
