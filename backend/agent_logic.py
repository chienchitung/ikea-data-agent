import re
from typing import Optional

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from agents.coordinator import coordinator_executor, llm
from agents.document import get_document_corpus, get_loaded_files, search_document_base
from conversation_store import load_conversation_messages, load_tool_context, save_conversation_messages


_DOCUMENT_QUERY_TERMS = [
    "pdf", "文件", "文檔", "檔案", "資料來源", "source", "document",
    "上傳", "剛上傳", "這份", "這個檔", "這份檔", "這份資料"
]

_FULL_DOCUMENT_QUERY_TERMS = [
    "整份", "整個", "完整", "全部", "全篇", "全文", "通篇",
    "摘要", "總結", "整理", "解讀", "overview", "summary", "summarize"
]


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


def _ensure_confluence_source_links(response: str, confluence_links: dict) -> str:
    if not response or not confluence_links:
        return response

    updated = response
    for title, url in confluence_links.items():
        markdown_link = f"[{title}]({url})"
        plain_source_patterns = [
            f"[來源: {title}]",
            f"[來源： {title}]",
            f"[來源:{title}]",
            f"[來源：{title}]",
        ]
        for pattern in plain_source_patterns:
            updated = updated.replace(pattern, f"來源： {markdown_link}")

        source_line_patterns = [
            f"來源: {title}",
            f"來源： {title}",
        ]
        for pattern in source_line_patterns:
            updated = updated.replace(pattern, f"來源： {markdown_link}")

    if "來源" not in updated:
        first_title, first_url = next(iter(confluence_links.items()))
        updated = f"{updated.rstrip()}\n\n來源： [{first_title}]({first_url})"
    return updated


def _looks_like_document_query(message: str) -> bool:
    loaded_files = get_loaded_files()
    if not loaded_files:
        return False

    normalized = str(message or "").strip()
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
    if not _looks_like_document_query(message):
        return None

    is_full_document_query = _looks_like_full_document_query(message)
    if is_full_document_query:
        document_context = get_document_corpus()
    else:
        document_context = await search_document_base.ainvoke({"query": message})

    if "知識庫尚未建立" in document_context or "系統警告" in document_context:
        return document_context

    response = await llm.ainvoke([
        SystemMessage(content=(
            "你是 IKEA Data Team 的 PDF 文件問答助理。"
            "請只根據提供的 PDF 內容回答；若內容不足以回答，請明確說文件內容不足。"
            "回答要使用繁體中文，先給直接答案，再整理重點。"
            "如果使用者要求整份文件摘要或解讀，請從全文件角度整理主題、重點、流程與可行動事項。"
            "最後必須列出來源，格式如：來源：Guidebook.pdf（第 1 頁）。"
        )),
        HumanMessage(content=(
            f"使用者問題：{message}\n\n"
            f"PDF 內容：\n{document_context}"
        )),
    ])
    return _message_text(response.content).strip()

async def process_chat(message: str, chat_history: list, conversation_id: Optional[str] = None) -> str:
    """
    Process the chat message using the LangGraph Coordinator Agent.
    """
    try:
        document_answer = await _answer_from_document_base(message)
        if document_answer:
            return document_answer

        stored_messages = load_conversation_messages(conversation_id)
        stored_tool_context = load_tool_context(conversation_id)

        if stored_tool_context:
            current_message = (
                "以下是同一個對話先前工具查詢取得的上下文，請只在使用者追問「上述、這些、它們、剛剛」"
                "或需要延續前文時參考；若使用者要求最新或全量資料，仍需重新呼叫工具。\n\n"
                f"{stored_tool_context}\n\n"
                f"目前使用者問題：{message}"
            )
        else:
            current_message = message

        # Build messages payload for langgraph
        messages = (stored_messages or chat_history) + [HumanMessage(content=current_message)]

        # Use ainvoke to support async parallel tool execution
        response_state = await coordinator_executor.ainvoke({
            "messages": messages
        })

        save_conversation_messages(conversation_id, response_state["messages"])
        
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
        agent_response = _ensure_confluence_source_links(agent_response, confluence_links)
        
        return agent_response
    except Exception as e:
        return f"Error processing request: {str(e)}"
