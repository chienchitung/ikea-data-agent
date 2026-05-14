import asyncio
import json

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, AIMessage
from agent_logic import process_chat_detailed
from agents.coordinator import suggest_clarifications
import uvicorn

app = FastAPI()

# Allow frontend to communicate
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Message(BaseModel):
    role: str
    content: str

class ClarificationSelection(BaseModel):
    question: str
    label: str
    value: str

class ChatRequest(BaseModel):
    message: str
    history: List[Message] = Field(default_factory=list)
    conversation_id: Optional[str] = None
    clarifications: List[ClarificationSelection] = Field(default_factory=list)
    turn_context: Dict[str, Any] = Field(default_factory=dict)

class ChatResponse(BaseModel):
    response: str
    error_code: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)

class ClarificationRequest(BaseModel):
    message: str
    history: List[Message] = Field(default_factory=list)
    conversation_id: Optional[str] = None

class ClarificationResponse(BaseModel):
    needs_clarification: bool = False
    questions: list = Field(default_factory=list)
    reason: str = ""
    turn_context: Dict[str, Any] = Field(default_factory=dict)

def product_error(code: str, title: str, message: str, next_steps: Optional[List[str]] = None, details=None):
    return {
        "code": code,
        "title": title,
        "message": message,
        "next_steps": next_steps or [],
        "details": details,
    }

def error_markdown(error: dict) -> str:
    next_steps = error.get("next_steps") or []
    output = f"**{error.get('title', '我遇到一點問題')}**\n\n{error.get('message', '')}".strip()
    if next_steps:
        output += "\n\n你可以試試：\n" + "\n".join(f"- {step}" for step in next_steps)
    return output

def classify_chat_error_text(text: str) -> Optional[dict]:
    lowered = str(text or "").lower()
    if not text:
        return None

    if "google_api_key" in lowered or "api key" in lowered or "gemini" in lowered:
        return product_error(
            "ai_provider_unavailable",
            "AI 服務目前無法使用",
            "後端目前無法連到模型服務或缺少 API 設定，所以這次沒有辦法完成回答。",
            ["確認後端的 GOOGLE_API_KEY / GEMINI_API_KEY 是否已設定", "稍後再試一次"],
        )

    if "知識庫尚未建立" in text or "請先上傳 PDF" in text:
        return product_error(
            "pdf_not_ready",
            "PDF 知識庫還沒準備好",
            "我目前還沒有可查詢的 PDF 內容。可能是尚未上傳 PDF，或 PDF 解析/embedding 尚未成功完成。",
            ["先上傳 PDF 並等待處理完成", "如果剛上傳，請確認上傳結果是否顯示成功"],
        )

    if "文件中完全未提及" in text or "找不到相關" in text or "無結果" in text or "找不到" in text:
        return product_error(
            "no_relevant_result",
            "目前沒有找到可支持的資料",
            "我查到的資料不足以可靠回答這個問題。為避免把不同內容硬湊在一起，我不會直接推測。",
            ["換一個更接近文件原文的關鍵字", "補充文件頁碼、章節名稱或截圖中的標題", "如果是圖片內容，請確認 PDF 已完成視覺摘要解析"],
        )

    if "error processing request" in lowered or "工具執行錯誤" in text or "發生錯誤" in text:
        return product_error(
            "agent_runtime_error",
            "處理過程中斷了",
            "我在判斷問題或呼叫工具時遇到錯誤，這次回答可能沒有完成。",
            ["稍後重試一次", "如果問題很長，先縮小範圍再問", "若持續發生，請查看後端 log"],
        )

    return None


def convert_history(messages: List[Message]) -> list:
    chat_history = []
    for msg in messages:
        if msg.role == "user":
            chat_history.append(HumanMessage(content=msg.content))
        elif msg.role == "assistant":
            chat_history.append(AIMessage(content=msg.content))
    return chat_history


def message_with_clarifications(request: ChatRequest) -> str:
    if not request.clarifications:
        return request.message

    selected_lines = [
        f"- {item.question}: {item.label}（{item.value}）"
        for item in request.clarifications
    ]
    return (
        f"使用者原始問題：{request.message}\n\n"
        "使用者在釐清題選擇的條件：\n"
        + "\n".join(selected_lines)
        + "\n\n請回答原始問題，並把上述選擇視為查詢條件或輸出格式約束。"
        "不要只回覆釐清選項，也不要在最終回答中重複描述這段 metadata。"
    )


def sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    print(f"📩 Received: {request.message}")
    
    chat_history = convert_history(request.history)
    
    # Process
    try:
        result = await process_chat_detailed(
            message_with_clarifications(request),
            chat_history,
            request.conversation_id,
            request.turn_context or None,
        )
        response_text = result["response"]
        metadata = result.get("metadata", {})
        productized_error = classify_chat_error_text(response_text)
        if productized_error:
            return ChatResponse(
                response=error_markdown(productized_error),
                error_code=productized_error["code"],
                metadata=metadata,
            )
        return ChatResponse(response=response_text, metadata=metadata)
    except Exception as e:
        print(f"❌ Error: {e}")
        raise HTTPException(
            status_code=500,
            detail=product_error(
                "chat_server_error",
                "後端處理訊息時發生錯誤",
                "訊息已送到後端，但處理過程中斷了。",
                ["稍後重試一次", "如果問題很長，先縮小範圍再問", "若持續發生，請查看後端 log"],
                str(e),
            )
        )


@app.post("/chat/stream")
async def chat_stream_endpoint(request: ChatRequest):
    print(f"📡 Streaming: {request.message}")
    chat_history = convert_history(request.history)
    message_for_agent = message_with_clarifications(request)

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def progress_handler(payload: dict):
            await queue.put(("progress", payload))

        async def run_chat():
            try:
                result = await process_chat_detailed(
                    message_for_agent,
                    chat_history,
                    request.conversation_id,
                    request.turn_context or None,
                    progress_handler,
                )
                response_text = result["response"]
                metadata = result.get("metadata", {})
                productized_error = classify_chat_error_text(response_text)
                if productized_error:
                    await queue.put(("final", {
                        "response": error_markdown(productized_error),
                        "error_code": productized_error["code"],
                        "metadata": metadata,
                    }))
                else:
                    await queue.put(("final", {
                        "response": response_text,
                        "metadata": metadata,
                    }))
            except Exception as e:
                print(f"❌ Stream Error: {e}")
                await queue.put(("error", product_error(
                    "chat_server_error",
                    "後端處理訊息時發生錯誤",
                    "訊息已送到後端，但處理過程中斷了。",
                    ["稍後重試一次", "如果問題很長，先縮小範圍再問", "若持續發生，請查看後端 log"],
                    str(e),
                )))

        task = asyncio.create_task(run_chat())
        yield sse_event("progress", {"phase": "understanding", "label": "正在理解問題"})

        while True:
            event, payload = await queue.get()
            yield sse_event(event, payload)
            if event in {"final", "error"}:
                break

        await task

    from fastapi.responses import StreamingResponse
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/clarifications", response_model=ClarificationResponse)
async def clarification_endpoint(request: ClarificationRequest):
    try:
        history_text = "\n".join(
            f"{msg.role}: {msg.content}"
            for msg in request.history[-8:]
        )
        result = await suggest_clarifications(request.message, history_text)
        return ClarificationResponse(**result)
    except Exception as e:
        print(f"❌ Clarification Error: {e}")
        return ClarificationResponse()

from fastapi import UploadFile, File
from fastapi.responses import JSONResponse
import shutil
import os
from agents.document import (
    initialize_knowledge_base, 
    search_document_base, 
    get_loaded_files,
    rename_document_in_kb
)

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        if not file.filename.endswith('.pdf'):
            raise HTTPException(
                status_code=400,
                detail=product_error(
                    "unsupported_file_type",
                    "只支援 PDF 檔案",
                    "這個上傳入口目前只能處理 PDF。",
                    ["請改上傳 .pdf 檔", "如果是圖片或簡報，請先轉成 PDF 再上傳"],
                )
            )
            
        # Save file to current directory (which is 'backend' folder)
        file_location = file.filename
            
        with open(file_location, "wb+") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        print(f"✅ File uploaded: {file.filename}")
        
        # Trigger reload of knowledge base and get result
        result = initialize_knowledge_base()
        
        # Check if the uploaded file is in the failed list
        uploaded_filename = file.filename
        failed_reason = None
        
        if result and "failed_files" in result:
            for fname, reason in result.get("failed_files", []):
                # Check basename because full path might differ
                if os.path.basename(fname) == uploaded_filename:
                    failed_reason = reason
                    break
                    
        if failed_reason:
            # Return 422 Unprocessable Entity if the specific file failed
            print(f"❌ Processing failed for {uploaded_filename}: {failed_reason}")
            error = product_error(
                "pdf_processing_failed",
                "PDF 已上傳，但解析失敗",
                "檔案已收到，但系統無法把它轉成可查詢的知識庫內容。",
                ["確認 PDF 是否可開啟且未加密", "如果是掃描圖檔，確認 OCR/視覺解析依賴是否可用", "稍後重新上傳一次"],
                {"reason": failed_reason, "result": result},
            )
            return JSONResponse(
                status_code=422,
                content={
                    "filename": file.filename,
                    **error,
                }
            )
            
        # If result.success is False but file wasn't specifically in failed list (e.g. global error)
        if result and not result.get("success", False):
             error = product_error(
                "knowledge_base_unavailable",
                "PDF 知識庫沒有建立成功",
                "檔案已收到，但建立 embeddings 或索引時失敗，所以目前還不能問這份 PDF。",
                ["確認 GOOGLE_API_KEY / GEMINI_API_KEY 是否可用", "確認後端可連到模型服務", "稍後重新處理或重新上傳"],
                result,
             )
             return JSONResponse(
                status_code=422,
                content={
                    "filename": file.filename,
                    **error,
                }
            )
        
        return {
            "filename": file.filename, 
            "message": "File uploaded and processed successfully", 
            "details": result
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Upload Error: {e}")
        raise HTTPException(
            status_code=500,
            detail=product_error(
                "upload_server_error",
                "上傳時發生錯誤",
                "後端在儲存或處理 PDF 時中斷了。",
                ["稍後重試一次", "確認檔名不要包含特殊字元", "若持續發生，請查看後端 log"],
                str(e),
            )
        )

from agents.document import get_loaded_files

@app.get("/documents")
async def list_documents():
    files = get_loaded_files()
    return {"documents": files}

@app.delete("/documents/{filename}")
async def delete_document(filename: str):
    try:
        print(f"\n🗑️ Delete Request for: {filename}")
        
        # Try to find and delete the file
        # We explicitly check for decoded name, and maybe encoded name just in case
        file_paths = [
            f"backend/{filename}", 
            filename, 
            f"../{filename}",
            os.path.join("backend", filename)
        ]
        
        deleted = False
        attempted_paths = []
        
        for path in file_paths:
            full_path = os.path.abspath(path)
            attempted_paths.append(full_path)
            
            if os.path.exists(path):
                os.remove(path)
                deleted = True
                print(f"✅ Deleted file: {path} (Absolute: {full_path})")
                break
        
        if not deleted:
            # Try searching directly in backend directory using listdir to avoid encoding mismatches
            if os.path.exists("backend"):
                for existing_file in os.listdir("backend"):
                    if existing_file == filename:
                        path = os.path.join("backend", existing_file)
                        os.remove(path)
                        deleted = True
                        print(f"✅ Deleted file via listdir match: {path}")
                        break

        if not deleted:
            print(f"❌ File not found. Checked: {attempted_paths}")
            # List available files for debugging
            if os.path.exists("backend"):
                print(f"   Available files in backend/: {os.listdir('backend')}")
                
            raise HTTPException(
                status_code=404,
                detail=product_error(
                    "document_not_found",
                    "找不到這份 PDF",
                    "系統目前找不到要刪除的檔案，可能已經被刪除或檔名不同。",
                    ["重新整理文件清單", "確認檔名是否正確"],
                    {"checked_locations": file_paths},
                )
            )
        
        # Reinitialize knowledge base
        initialize_knowledge_base()
        
        return {"message": f"File {filename} deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Delete Error: {e}")
        raise HTTPException(
            status_code=500,
            detail=product_error(
                "delete_server_error",
                "刪除 PDF 時發生錯誤",
                "後端在刪除檔案或重建知識庫時中斷了。",
                ["稍後重試一次", "若檔案已消失，請重新整理文件清單"],
                str(e),
            )
        )

@app.put("/documents/{old_filename}")
async def rename_document(old_filename: str, new_name: dict):
    try:
        new_filename = new_name.get("new_name")
        if not new_filename:
            raise HTTPException(
                status_code=400,
                detail=product_error(
                    "missing_document_name",
                    "缺少新的檔案名稱",
                    "重新命名時需要提供新名稱。",
                    ["請輸入新的 PDF 名稱"],
                )
            )
        
        # Ensure new filename ends with .pdf
        if not new_filename.endswith('.pdf'):
            new_filename += '.pdf'
        
        # Find the old file
        old_paths = [f"backend/{old_filename}", old_filename, f"../{old_filename}"]
        old_path = None
        
        for path in old_paths:
            if os.path.exists(path):
                old_path = path
                break
        
        if not old_path:
            raise HTTPException(
                status_code=404,
                detail=product_error(
                    "document_not_found",
                    "找不到這份 PDF",
                    "系統目前找不到要重新命名的檔案，可能已經被刪除或檔名不同。",
                    ["重新整理文件清單", "確認檔名是否正確"],
                )
            )
        
        # Construct new path in same directory
        directory = os.path.dirname(old_path)
        new_path = os.path.join(directory, new_filename) if directory else new_filename
        
        # Rename the file
        os.rename(old_path, new_path)
        print(f"✅ Renamed: {old_filename} -> {new_filename}")
        
        # Optimized: Update metadata in-place instead of reloading everything
        # initialize_knowledge_base()
        rename_success = rename_document_in_kb(old_filename, new_filename)
        
        if not rename_success:
             print(f"⚠️ Fast rename failed (vector_db might be empty), falling back to full reload.")
             initialize_knowledge_base()

        return {"message": f"File renamed successfully", "new_name": new_filename}
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Rename Error: {e}")
        raise HTTPException(
            status_code=500,
            detail=product_error(
                "rename_server_error",
                "重新命名 PDF 時發生錯誤",
                "後端在重新命名檔案或更新知識庫 metadata 時中斷了。",
                ["稍後重試一次", "確認新檔名不要包含特殊字元"],
                str(e),
            )
        )

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
