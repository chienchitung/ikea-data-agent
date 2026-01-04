from langchain_core.messages import HumanMessage, AIMessage
from agents.coordinator import coordinator_executor

def process_chat(message: str, chat_history: list) -> str:
    """
    Process the chat message using the Coordinator Agent.
    """
    try:
        response = coordinator_executor.invoke({
            "input": message,
            "chat_history": chat_history
        })
        
        # 修正輸出格式：從回應中提取純文字內容 (matching notebook logic)
        agent_response_raw = response["output"]
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
        
        return agent_response
    except Exception as e:
        return f"Error processing request: {str(e)}"
