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
from typing import Annotated, TypedDict
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

# 需要呼叫工具的關鍵字（module-level 常數，避免每次 agent_node 呼叫都重建）
_INTERNAL_KEYWORDS = [
    "專案", "卡片", "trello", "進度", "誰負責", "規定", "文件", "confluence",
    "規範", "數據", "統計", "請查", "幫我查", "有哪些", "什麼是", "意思",
    "確定沒有", "真的沒有", "再找找", "再查一次", "確認一下", "你確定",
    "工單", "工作表", "request", "報告", "分析", "摘要", "彙整", "整理",
    "dashboard", "tableau", "tableau cloud", "bi", "部署", "發佈", "發布",
    "publish", "deploy", "cloud", "gcp", "google cloud", "google cloud platform",
    "bigquery", "bq", "cdp", "centralized data platform",
    "centratlized data platoform", "customer centralized platform",
    "customer centratlized platoform", "dynamic yield", "helpdesk"
]

# 全量查詢關鍵字：即使 history 有 tool 結果也必須重新查詢完整資料
_COMPREHENSIVE_KEYWORDS = [
    "所有", "全部", "整理", "報告", "彙整", "彙總", "重點報告", "統整",
    "全面", "完整", "一份", "總結", "摘要所有", "列出所有", "所有工單",
    "全部工單", "所有卡片", "全部專案", "整體", "overview", "summary"
]

_INTERIM_RESPONSE_MARKERS = [
    "請稍等", "請等一下", "稍等一下", "等我一下", "我正在", "正在處理",
    "處理中", "我將", "我會", "我來幫你", "讓我來", "讓我先", "立刻請",
    "馬上請", "我幫你查", "我幫你整理", "我來查", "我來整理"
]


def _has_tool_calls(message) -> bool:
    return hasattr(message, "tool_calls") and bool(message.tool_calls)


def _is_interim_response(content) -> bool:
    if not isinstance(content, str):
        return False
    normalized = content.lower()
    return any(marker.lower() in normalized for marker in _INTERIM_RESPONSE_MARKERS)

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

    # 2. 判斷是否需要呼叫工具 / 全量查詢（使用 module-level 常數）
    needs_fresh_query = any(kw in last_human_msg.lower() for kw in _COMPREHENSIVE_KEYWORDS)
    needs_tool = needs_fresh_query or any(kw in last_human_msg.lower() for kw in _INTERNAL_KEYWORDS)

    # 3. 檢查最近是否有 Tool 回傳結果（放寬到 10 句內有即可，即短期的記憶上下文）
    tool_messages = [m for m in messages[-10:] if getattr(m, "type", "") == "tool" or m.__class__.__name__ == "ToolMessage"]
    has_recent_tool_result = len(tool_messages) > 0

    # 🛑 防護 A：該查沒查 -> 強制重試 (內部自動 re-prompt)
    # needs_fresh_query = True 時，即使有近期 tool 結果也要重查（避免只摘要 history 舊資料）
    if not _has_tool_calls(response):
        if needs_tool and (not has_recent_tool_result or needs_fresh_query):
            if needs_fresh_query:
                print("\n⚠️ [Guardrail] 偵測到全量查詢請求，強制重新呼叫工具取得完整資料！")
                retry_msg = "⚠️ 系統強制攔截：用戶要求取得『全部/所有』資料並整理成報告，你**不能只整理 chat history 中的舊資料**！必須立即呼叫對應工具（例如 query_worksheet_data 或 get_project_status）重新取得完整的最新資料，再進行彙整。請立即呼叫工具！"
            else:
                print("\n⚠️ [Guardrail] 偵測到 LLM 試圖不呼叫工具就回答，強制重發 Prompt！")
                retry_msg = "⚠️ 系統強制攔截：你的回答沒有呼叫任何工具！你是 Data Machi，沒有先驗知識，遇到專案/文件問題『必須』呼叫 Tool 查詢，絕對禁止憑空回答。請立即呼叫相關工具！"
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
