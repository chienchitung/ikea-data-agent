import re
from typing import Optional

from langchain_core.messages import HumanMessage, AIMessage
from agents.coordinator import coordinator_executor
from conversation_store import load_conversation_messages, load_tool_context, save_conversation_messages


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

async def process_chat(message: str, chat_history: list, conversation_id: Optional[str] = None) -> str:
    """
    Process the chat message using the LangGraph Coordinator Agent.
    """
    try:
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
