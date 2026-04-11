from langchain_core.messages import HumanMessage, AIMessage
from agents.coordinator import coordinator_executor

def process_chat(message: str, chat_history: list) -> str:
    """
    Process the chat message using the LangGraph Coordinator Agent.
    """
    try:
        # Build messages payload for langgraph
        messages = chat_history + [HumanMessage(content=message)]
        
        # Invoke the prebuilt react agent
        response_state = coordinator_executor.invoke({
            "messages": messages
        })
        
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
        
        return agent_response
    except Exception as e:
        return f"Error processing request: {str(e)}"
