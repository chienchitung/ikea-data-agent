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
    output = f"**{error.get('title', 'Something went wrong')}**\n\n{error.get('message', '')}".strip()
    if next_steps:
        output += "\n\nYou can try:\n" + "\n".join(f"- {step}" for step in next_steps)
    return output

def classify_chat_error_text(text: str) -> Optional[dict]:
    lowered = str(text or "").lower()
    if not text:
        return None

    if "google_api_key" in lowered or "api key" in lowered or "gemini" in lowered:
        return product_error(
            "ai_provider_unavailable",
            "AI service is unavailable",
            "The backend cannot reach the model service or is missing API configuration, so this request could not be completed.",
            ["Check that GOOGLE_API_KEY / GEMINI_API_KEY is configured", "Try again later"],
        )

    if (
        "知識庫尚未建立" in text
        or "請先上傳 PDF" in text
        or "knowledge base is not ready" in lowered
        or "upload a pdf first" in lowered
    ):
        return product_error(
            "pdf_not_ready",
            "PDF knowledge base is not ready",
            "There is no searchable PDF content yet. The PDF may not have been uploaded, or parsing / embedding may not have completed successfully.",
            ["Upload a PDF and wait for processing to finish", "If you just uploaded one, confirm the upload result shows success"],
        )

    if (
        "文件中完全未提及" in text
        or "找不到相關" in text
        or "無結果" in text
        or "找不到" in text
        or "no relevant content" in lowered
        or "does not contain enough information" in lowered
    ):
        return product_error(
            "no_relevant_result",
            "No supporting data was found",
            "The available data is not enough to answer this reliably. To avoid mixing unrelated content, I will not guess.",
            ["Try a keyword closer to the source document", "Add a page number, section title, or screenshot heading", "If the content is image-based, ask for the scanned/image page details"],
        )

    if "error processing request" in lowered or "工具執行錯誤" in text or "發生錯誤" in text:
        return product_error(
            "agent_runtime_error",
            "Processing was interrupted",
            "An error occurred while interpreting the question or calling tools, so this answer may not have completed.",
            ["Try again later", "If the question is long, narrow the scope first", "If it keeps happening, check the backend log"],
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
                "Backend failed to process the message",
                "The message reached the backend, but processing was interrupted.",
                ["Try again later", "If the question is long, narrow the scope first", "If it keeps happening, check the backend log"],
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
                    "Backend failed to process the message",
                    "The message reached the backend, but processing was interrupted.",
                    ["Try again later", "If the question is long, narrow the scope first", "If it keeps happening, check the backend log"],
                    str(e),
                )))

        task = asyncio.create_task(run_chat())
        yield sse_event("progress", {"phase": "understanding", "label": "Understanding your question"})

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
from urllib.parse import unquote
from agents.document import (
    initialize_knowledge_base, 
    search_document_base, 
    get_loaded_files,
    rename_document_in_kb
)

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


def _pdf_storage_paths(filename: str) -> list[str]:
    decoded = os.path.basename(unquote(filename))
    return [
        os.path.join(BACKEND_DIR, decoded),
        os.path.abspath(decoded),
    ]


def _list_pdf_files() -> list[str]:
    disk_files = {
        name
        for name in os.listdir(BACKEND_DIR)
        if name.lower().endswith(".pdf") and os.path.isfile(os.path.join(BACKEND_DIR, name))
    }
    return sorted(disk_files | set(get_loaded_files()))

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        if not file.filename.endswith('.pdf'):
            raise HTTPException(
                status_code=400,
                detail=product_error(
                    "unsupported_file_type",
                    "Only PDF files are supported",
                    "This upload endpoint can currently process PDF files only.",
                    ["Upload a .pdf file", "If you have an image or presentation, convert it to PDF first"],
                )
            )
            
        safe_filename = os.path.basename(unquote(file.filename))
        # Always store uploaded PDFs in the backend directory, regardless of cwd.
        file_location = os.path.join(BACKEND_DIR, safe_filename)
            
        with open(file_location, "wb+") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        print(f"✅ File uploaded: {safe_filename}")
        
        # Trigger reload of knowledge base and get result
        result = initialize_knowledge_base()
        
        # Check if the uploaded file is in the failed list
        uploaded_filename = safe_filename
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
                "PDF uploaded, but parsing failed",
                "The file was received, but the system could not turn it into searchable knowledge-base content.",
                ["Confirm the PDF opens and is not encrypted", "If it is scanned, confirm OCR dependencies are available", "Upload it again later"],
                {"reason": failed_reason, "result": result},
            )
            return JSONResponse(
                status_code=422,
                content={
                    "filename": safe_filename,
                    **error,
                }
            )
            
        # If result.success is False but file wasn't specifically in failed list (e.g. global error)
        if result and not result.get("success", False):
             error = product_error(
                "knowledge_base_unavailable",
                "PDF knowledge base was not created",
                "The file was received, but embedding or index creation failed, so this PDF is not queryable yet.",
                ["Confirm GOOGLE_API_KEY / GEMINI_API_KEY is available", "Confirm the backend can reach the model service", "Retry processing or upload again later"],
                result,
             )
             return JSONResponse(
                status_code=422,
                content={
                    "filename": safe_filename,
                    **error,
                }
            )
        
        return {
            "filename": safe_filename, 
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
                "Upload failed",
                "The backend was interrupted while saving or processing the PDF.",
                ["Try again later", "Confirm the filename does not contain unusual characters", "If it keeps happening, check the backend log"],
                str(e),
            )
        )

from agents.document import get_loaded_files

@app.get("/documents")
async def list_documents():
    return {"documents": _list_pdf_files()}

@app.delete("/documents/{filename}")
async def delete_document(filename: str):
    try:
        decoded_filename = os.path.basename(unquote(filename))
        print(f"\n🗑️ Delete Request for: {decoded_filename}")
        
        deleted = False
        attempted_paths = _pdf_storage_paths(decoded_filename)
        
        for path in attempted_paths:
            if os.path.exists(path) and os.path.isfile(path):
                os.remove(path)
                deleted = True
                print(f"✅ Deleted file: {path}")
                break
        
        if not deleted:
            for existing_file in os.listdir(BACKEND_DIR):
                if existing_file == decoded_filename:
                    path = os.path.join(BACKEND_DIR, existing_file)
                    os.remove(path)
                    deleted = True
                    print(f"✅ Deleted file via listdir match: {path}")
                    break

        if not deleted:
            print(f"❌ File not found. Checked: {attempted_paths}")
            print(f"   Available PDF files in backend/: {_list_pdf_files()}")
                
            raise HTTPException(
                status_code=404,
                detail=product_error(
                    "document_not_found",
                    "PDF not found",
                    "The system could not find the file to delete. It may already be deleted or the filename may differ.",
                    ["Refresh the document list", "Confirm the filename is correct"],
                    {"checked_locations": attempted_paths},
                )
            )
        
        # Reinitialize knowledge base
        initialize_knowledge_base()
        
        return {"message": f"File {decoded_filename} deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Delete Error: {e}")
        raise HTTPException(
            status_code=500,
            detail=product_error(
                "delete_server_error",
                "Delete failed",
                "The backend was interrupted while deleting the file or rebuilding the knowledge base.",
                ["Try again later", "If the file is already gone, refresh the document list"],
                str(e),
            )
        )

@app.put("/documents/{old_filename}")
async def rename_document(old_filename: str, new_name: dict):
    try:
        decoded_old_filename = os.path.basename(unquote(old_filename))
        new_filename = new_name.get("new_name")
        if not new_filename:
            raise HTTPException(
                status_code=400,
                detail=product_error(
                    "missing_document_name",
                    "New filename is missing",
                    "A new name is required to rename the document.",
                    ["Enter a new PDF name"],
                )
            )
        
        # Ensure new filename ends with .pdf
        new_filename = os.path.basename(unquote(new_filename))
        if not new_filename.endswith('.pdf'):
            new_filename += '.pdf'
        
        # Find the old file
        old_paths = _pdf_storage_paths(decoded_old_filename)
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
                    "PDF not found",
                    "The system could not find the file to rename. It may already be deleted or the filename may differ.",
                    ["Refresh the document list", "Confirm the filename is correct"],
                )
            )
        
        # Construct new path in same directory
        directory = os.path.dirname(old_path)
        new_path = os.path.join(directory, new_filename)
        
        # Rename the file
        os.rename(old_path, new_path)
        print(f"✅ Renamed: {decoded_old_filename} -> {new_filename}")
        
        # Optimized: Update metadata in-place instead of reloading everything
        # initialize_knowledge_base()
        rename_success = rename_document_in_kb(decoded_old_filename, new_filename)
        
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
                "Rename failed",
                "The backend was interrupted while renaming the file or updating knowledge-base metadata.",
                ["Try again later", "Confirm the new filename does not contain unusual characters"],
                str(e),
            )
        )

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
