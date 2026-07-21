import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, AIMessage
from agent_logic import process_chat_detailed
from reply_language import detect_reply_language_text
from agents.coordinator import suggest_clarifications, set_api_key, reset_api_key
from agents.document import set_active_documents, reset_active_documents
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
    gemini_api_key: Optional[str] = None
    active_documents: Optional[List[str]] = None

class ChatResponse(BaseModel):
    response: str
    error_code: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)

class ClarificationRequest(BaseModel):
    message: str
    history: List[Message] = Field(default_factory=list)
    conversation_id: Optional[str] = None
    gemini_api_key: Optional[str] = None
    active_documents: Optional[List[str]] = None

class ClarificationResponse(BaseModel):
    needs_clarification: bool = False
    questions: list = Field(default_factory=list)
    reason: str = ""
    turn_context: Dict[str, Any] = Field(default_factory=dict)

def detect_reply_language(text: str) -> str:
    """\u932f\u8aa4\u8a0a\u606f\u7528\u7684\u8a9e\u8a00\u5224\u65b7\uff08zh/en\uff09\uff0c\u8d70\u5171\u7528\u7684\u4e2d\u6587\u504f\u7f6e\u6838\u5fc3\uff0c
    \u907f\u514d\u300c\u4e2d\u6587\u63d0\u554f\u593e\u82f1\u6587\u540d\u8a5e\u300d\u6642\u932f\u8aa4\u8a0a\u606f\u4e5f\u8b8a\u82f1\u6587\u3002"""
    return "zh" if detect_reply_language_text(str(text or "")) == "Traditional Chinese" else "en"


def product_error(code: str, title: str, message: str, next_steps: Optional[List[str]] = None, details=None):
    return {
        "code": code,
        "title": title,
        "message": message,
        "next_steps": next_steps or [],
        "details": details,
    }

def error_markdown(error: dict, language: str = "en") -> str:
    next_steps = error.get("next_steps") or []
    output = f"**{error.get('title', 'Something went wrong')}**\n\n{error.get('message', '')}".strip()
    if next_steps:
        helper = "你可以試試：" if language == "zh" else "You can try:"
        output += f"\n\n{helper}\n" + "\n".join(f"- {step}" for step in next_steps)
    return output


def localized_product_error(code: str, language: str, details=None) -> dict:
    zh = language == "zh"
    if code == "ai_provider_unavailable":
        return product_error(
            code,
            "AI 服務目前無法使用" if zh else "AI service is unavailable",
            "後端目前無法連到模型服務，或缺少 API 設定，所以這次請求無法完成。" if zh else "The backend cannot reach the model service or is missing API configuration, so this request could not be completed.",
            ["確認 GOOGLE_API_KEY / GEMINI_API_KEY 已設定", "稍後再試一次"] if zh else ["Check that GOOGLE_API_KEY / GEMINI_API_KEY is configured", "Try again later"],
            details,
        )
    if code == "transcription_provider_unavailable":
        return product_error(
            code,
            "尚未提供 Groq API Key" if zh else "No Groq API Key provided",
            "轉譯錄音需要 Groq API Key，但這次請求沒有帶上，後端也不會保存這組金鑰。" if zh else "Transcribing this recording requires a Groq API Key, but none was sent with this request, and the backend does not store one.",
            ["在會議錄製視窗輸入你的 Groq API Key", "稍後再試一次"] if zh else ["Enter your Groq API Key in the meeting recorder window", "Try again later"],
            details,
        )
    if code == "pdf_not_ready":
        return product_error(
            code,
            "PDF 知識庫尚未準備好" if zh else "PDF knowledge base is not ready",
            "目前還沒有可搜尋的 PDF 內容。PDF 可能尚未上傳，或解析 / embedding 尚未成功完成。" if zh else "There is no searchable PDF content yet. The PDF may not have been uploaded, or parsing / embedding may not have completed successfully.",
            ["上傳 PDF 並等待處理完成", "如果剛上傳，請確認上傳結果顯示成功"] if zh else ["Upload a PDF and wait for processing to finish", "If you just uploaded one, confirm the upload result shows success"],
            details,
        )
    if code == "no_relevant_result":
        return product_error(
            code,
            "找不到可支持回答的資料" if zh else "No supporting data was found",
            "目前可用資料不足以可靠回答。為了避免混入不相關內容，我不會猜測。" if zh else "The available data is not enough to answer this reliably. To avoid mixing unrelated content, I will not guess.",
            ["改用更接近來源文件的關鍵字", "補充頁碼、段落標題或截圖標題", "如果內容是圖片型資料，請詢問掃描頁或圖片頁細節"] if zh else ["Try a keyword closer to the source document", "Add a page number, section title, or screenshot heading", "If the content is image-based, ask for the scanned/image page details"],
            details,
        )
    if code == "agent_runtime_error":
        return product_error(
            code,
            "處理過程中斷了" if zh else "Processing was interrupted",
            "解讀問題或呼叫工具時發生錯誤，所以這次回答可能沒有完成。" if zh else "An error occurred while interpreting the question or calling tools, so this answer may not have completed.",
            ["稍後再試一次", "如果問題很長，請先縮小範圍", "如果持續發生，請檢查後端 log"] if zh else ["Try again later", "If the question is long, narrow the scope first", "If it keeps happening, check the backend log"],
            details,
        )
    if code == "chat_server_error":
        return product_error(
            code,
            "後端無法處理這則訊息" if zh else "Backend failed to process the message",
            "訊息已送到後端，但處理流程中斷了。" if zh else "The message reached the backend, but processing was interrupted.",
            ["稍後再試一次", "如果問題很長，請先縮小範圍", "如果持續發生，請檢查後端 log"] if zh else ["Try again later", "If the question is long, narrow the scope first", "If it keeps happening, check the backend log"],
            details,
        )
    return product_error(code, "發生錯誤" if zh else "Something went wrong", "請稍後再試一次。" if zh else "Please try again later.", details=details)


def classify_chat_error_text(text: str, language: str = "en") -> Optional[dict]:
    lowered = str(text or "").lower()
    if not text:
        return None

    is_error_response = lowered.startswith("error processing request")
    api_key_error = (
        "google_api_key" in lowered
        or ("api key" in lowered and (is_error_response or "not valid" in lowered or "invalid" in lowered))
        or ("gemini" in lowered and is_error_response)
    )
    if api_key_error:
        return localized_product_error("ai_provider_unavailable", language)

    if (
        "知識庫尚未建立" in text
        or "請先上傳 PDF" in text
        or "knowledge base is not ready" in lowered
        or "upload a pdf first" in lowered
    ):
        return localized_product_error("pdf_not_ready", language)

    if (
        "文件中完全未提及" in text
        or "找不到相關" in text
        or "無結果" in text
        or "no relevant content" in lowered
        or "does not contain enough information" in lowered
        or "system warning: no relevant" in lowered
    ):
        return localized_product_error("no_relevant_result", language)

    if "error processing request" in lowered or "工具執行錯誤" in text or "發生錯誤" in text:
        return localized_product_error("agent_runtime_error", language)

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

    # value 是內部查詢用的欄位值（Status、Market、Data Source…），模型需要它
    # 來下正確的工具條件，但它不該回聲到使用者看得到的回覆裡——之前的格式
    # 「By Status（Status）」會誘導模型照抄括號裡的參數名。
    selected_lines = []
    for item in request.clarifications:
        line = f"- {item.question}: {item.label}"
        if item.value and item.value != item.label:
            line += f"｜internal query value: {item.value}"
        selected_lines.append(line)
    return (
        f"使用者原始問題：{request.message}\n\n"
        "使用者在釐清題選擇的條件（internal metadata）：\n"
        + "\n".join(selected_lines)
        + "\n\n請回答原始問題，並把上述選擇視為查詢條件或輸出格式約束。"
        "不要只回覆釐清選項，也不要在最終回答中重複描述這段 metadata。"
        "回覆中若需提及這些條件，請用使用者語言的自然敘述（例如「依狀態分析」），"
        "絕對不要輸出 internal query value、選項代號或參數名稱本身。"
    )


def sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    print(f"📩 Received: {request.message}")
    
    chat_history = convert_history(request.history)
    reply_language = detect_reply_language(request.message)
    
    # Process
    try:
        result = await process_chat_detailed(
            message_with_clarifications(request),
            chat_history,
            request.conversation_id,
            request.turn_context or None,
            gemini_api_key=request.gemini_api_key or None,
            active_documents=request.active_documents,
        )
        response_text = result["response"]
        metadata = result.get("metadata", {})
        productized_error = classify_chat_error_text(response_text, reply_language)
        if productized_error:
            return ChatResponse(
                response=error_markdown(productized_error, reply_language),
                error_code=productized_error["code"],
                metadata=metadata,
            )
        return ChatResponse(response=response_text, metadata=metadata)
    except Exception as e:
        print(f"❌ Error: {e}")
        raise HTTPException(
            status_code=500,
            detail=localized_product_error("chat_server_error", reply_language, str(e))
        )


@app.post("/chat/stream")
async def chat_stream_endpoint(request: ChatRequest):
    print(f"📡 Streaming: {request.message}")
    chat_history = convert_history(request.history)
    message_for_agent = message_with_clarifications(request)
    reply_language = detect_reply_language(request.message)

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def progress_handler(payload: dict):
            # 最終回答的 token 增量走獨立的 SSE 事件型別，讓前端把它跟
            # 進度狀態列分開處理（progress 更新狀態列，delta 逐字顯示答案）。
            if isinstance(payload, dict) and payload.get("phase") == "delta":
                await queue.put(("delta", payload))
            else:
                await queue.put(("progress", payload))

        async def run_chat():
            try:
                result = await process_chat_detailed(
                    message_for_agent,
                    chat_history,
                    request.conversation_id,
                    request.turn_context or None,
                    progress_handler,
                    gemini_api_key=request.gemini_api_key or None,
                    active_documents=request.active_documents,
                )
                response_text = result["response"]
                metadata = result.get("metadata", {})
                productized_error = classify_chat_error_text(response_text, reply_language)
                if productized_error:
                    await queue.put(("final", {
                        "response": error_markdown(productized_error, reply_language),
                        "error_code": productized_error["code"],
                        "metadata": metadata,
                    }))
                elif not response_text or not response_text.strip():
                    # Guard against empty responses (e.g. LLM returned only a
                    # function_call part that _content_to_text stripped to "").
                    empty_error = localized_product_error("agent_runtime_error", reply_language)
                    await queue.put(("final", {
                        "response": error_markdown(empty_error, reply_language),
                        "error_code": empty_error["code"],
                        "metadata": metadata,
                    }))
                else:
                    await queue.put(("final", {
                        "response": response_text,
                        "metadata": metadata,
                    }))
            except asyncio.CancelledError:
                # Task was cancelled (e.g. SSE client disconnected). Do not put
                # anything in the queue — the generator is already closing.
                raise
            except Exception as e:
                print(f"❌ Stream Error: {e}")
                await queue.put(("error", localized_product_error("chat_server_error", reply_language, str(e))))

        task = asyncio.create_task(run_chat())
        try:
            yield sse_event("progress", {"phase": "understanding", "label": "Understanding your question"})

            while True:
                event, payload = await queue.get()
                yield sse_event(event, payload)
                if event in {"final", "error"}:
                    break
        finally:
            # Cancel the background task if still running (e.g. client disconnected
            # mid-stream). Without this, orphaned tasks accumulate and exhaust the
            # Gemini API rate limit, causing other concurrent conversations to fail.
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    from fastapi.responses import StreamingResponse
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/clarifications", response_model=ClarificationResponse)
async def clarification_endpoint(request: ClarificationRequest):
    api_key_token = set_api_key(request.gemini_api_key) if request.gemini_api_key else None
    docs_token = set_active_documents(request.active_documents) if request.active_documents is not None else None
    try:
        history_text = "\n".join(
            f"{msg.role}: {msg.content}"
            for msg in request.history[-8:]
        )
        result = await suggest_clarifications(
            request.message,
            history_text,
            active_documents=request.active_documents,
        )
        return ClarificationResponse(**result)
    except Exception as e:
        print(f"❌ Clarification Error: {e}")
        return ClarificationResponse()
    finally:
        if api_key_token is not None:
            reset_api_key(api_key_token)
        if docs_token is not None:
            reset_active_documents(docs_token)

from fastapi import UploadFile, File, Form
from fastapi.responses import JSONResponse, FileResponse
import shutil
import os
from urllib.parse import unquote
from agents.document import (
    initialize_knowledge_base,
    search_document_base,
    get_loaded_files,
    rename_document_in_kb,
    remove_document_from_kb,
)

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
# PDF 存放目錄由 DATA_DIR 環境變數控制（見 storage_paths.py）：
# 掛了 Render Persistent Disk 後設 DATA_DIR=/var/data，PDF 就不會在
# 重新部署時被清掉。未設定時 PDF_STORAGE_DIR == backend/，行為不變。
from storage_paths import PDF_DIR as _PDF_DIR
PDF_STORAGE_DIR = str(_PDF_DIR)


def _pdf_storage_paths(filename: str) -> list[str]:
    decoded = os.path.basename(unquote(filename))
    return [
        os.path.join(PDF_STORAGE_DIR, decoded),
        os.path.join(BACKEND_DIR, decoded),
        os.path.abspath(decoded),
    ]


def _list_pdf_files() -> list[str]:
    disk_files = {
        name
        for storage_dir in {PDF_STORAGE_DIR, BACKEND_DIR}
        if os.path.isdir(storage_dir)
        for name in os.listdir(storage_dir)
        if name.lower().endswith(".pdf") and os.path.isfile(os.path.join(storage_dir, name))
    }
    return sorted(disk_files | set(get_loaded_files()))

@app.post("/upload")
async def upload_file(file: UploadFile = File(...), gemini_api_key: Optional[str] = Form(None)):
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
        # Store uploads in the persistent PDF dir (falls back to backend/).
        file_location = os.path.join(PDF_STORAGE_DIR, safe_filename)
            
        with open(file_location, "wb+") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        print(f"✅ File uploaded: {safe_filename}")
        
        # Trigger reload of knowledge base and get result
        result = initialize_knowledge_base(api_key=gemini_api_key or None)
        
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
            result_message = result.get("message", "")
            # Missing API key means file is saved but KB can't be built yet — not a hard failure
            if "GOOGLE_API_KEY missing" in result_message or "Embeddings initialization failed" in result_message:
                return {
                    "filename": safe_filename,
                    "message": "File uploaded. Set your Gemini API key to enable PDF search.",
                    "warning": "knowledge_base_not_built",
                    "details": result,
                }
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
            for storage_dir in {PDF_STORAGE_DIR, BACKEND_DIR}:
                if deleted or not os.path.isdir(storage_dir):
                    continue
                for existing_file in os.listdir(storage_dir):
                    if existing_file == decoded_filename:
                        path = os.path.join(storage_dir, existing_file)
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
        
        # Remove from in-memory KB immediately (no API key needed)
        remove_document_from_kb(decoded_filename)

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

from agents.meeting import (
    new_meeting_id,
    audio_dir_for,
    normalize_audio,
    transcribe_audio,
    generate_minutes,
    build_docx,
    save_meeting_record,
    load_meeting_record,
    delete_meeting_record,
    save_prepared_audio,
    load_prepared_audio,
)


class MeetingDownloadRequest(BaseModel):
    meeting_data: Dict[str, Any]


def _effective_gemini_api_key(provided: Optional[str]) -> Optional[str]:
    return provided or os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")


def _effective_groq_api_key(provided: Optional[str]) -> Optional[str]:
    # Deliberately client-supplied only, with no server-side env var fallback
    # (unlike Gemini's key above): the backend must never retain a Groq key.
    return (provided or "").strip() or None


def _meeting_not_found_error(action: str) -> dict:
    return product_error(
        "meeting_not_found",
        "Meeting record not found",
        f"The system could not find this meeting record to {action}. It may have been deleted.",
        ["Refresh the meetings list"],
    )


@app.post("/meetings/prepare-audio/stream")
async def prepare_meeting_audio_stream(audio: UploadFile = File(...)):
    """
    Phase 1 of meeting-minutes generation: upload + normalize the recording
    only. The frontend calls this the moment a file is picked or a recording
    finishes — while the user is still filling in title/attendees/etc — so
    that by the time they click "Generate Meeting Minutes", the (often
    slowest) audio-prep step is already done and that click can go straight
    into transcribing instead of restarting the wait from "Preparing audio…".
    Requires no API keys since nothing here calls Gemini or Groq.
    """
    meeting_id = new_meeting_id()

    ext = os.path.splitext(audio.filename or "")[1] or ".bin"
    meeting_dir = audio_dir_for(meeting_id)
    meeting_dir.mkdir(parents=True, exist_ok=True)
    audio_path = meeting_dir / f"audio{ext}"

    with audio_path.open("wb") as buffer:
        shutil.copyfileobj(audio.file, buffer)

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def run_pipeline():
            loop = asyncio.get_running_loop()

            def emit_progress_threadsafe(phase: str, label: str, percent: Optional[int] = None) -> None:
                # normalize_audio() runs in a worker thread (asyncio.to_thread)
                # so a long transcode doesn't block other requests.
                # asyncio.Queue isn't thread-safe, so progress ticks from that
                # thread have to be handed back to the event loop via
                # call_soon_threadsafe.
                payload = {"phase": phase, "label": label}
                if percent is not None:
                    payload["percent"] = percent
                loop.call_soon_threadsafe(queue.put_nowait, ("progress", payload))

            try:
                await queue.put(("progress", {"phase": "normalizing_audio", "label": "Preparing audio"}))

                def on_normalize_progress(percent: int) -> None:
                    emit_progress_threadsafe("normalizing_audio", f"Preparing audio ({percent}%)", percent)

                normalized_path = await asyncio.to_thread(normalize_audio, str(audio_path), on_normalize_progress)
                await asyncio.to_thread(save_prepared_audio, meeting_id, audio_path.name, Path(normalized_path).name)

                await queue.put(("final", {"meeting_id": meeting_id}))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"❌ Audio prepare error: {e}")
                await queue.put(("error", product_error(
                    "audio_prepare_error",
                    "Could not prepare this recording",
                    "An error occurred while preparing the audio for transcription.",
                    ["Try again later", "Try a different audio file"],
                    str(e),
                )))

        task = asyncio.create_task(run_pipeline())
        try:
            yield sse_event("progress", {"phase": "uploading_audio", "label": "Uploading recording"})
            while True:
                event, payload = await queue.get()
                yield sse_event(event, payload)
                if event in {"final", "error"}:
                    break
        finally:
            # NOTE: deliberately not attempting to also delete meeting_dir here
            # for the case where the client disconnects before ever receiving
            # meeting_id (so it has no way to clean up via DELETE
            # /meetings/{id} itself). task.cancel() can't actually interrupt
            # normalize_audio() once its ffmpeg subprocess is running — it's
            # synchronous work in a thread pool (asyncio.to_thread), so
            # cancellation only stops us from *waiting* on it, not the thread
            # itself. Deleting the directory here raced with that still-running
            # background thread in testing (it was still writing into the
            # directory being removed), producing spurious normalize_audio
            # failures. Left as a rare, self-healing orphan instead — Render's
            # ephemeral disk clears it on the next deploy regardless.
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    from fastapi.responses import StreamingResponse
    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/meetings/generate/stream")
async def generate_meeting_minutes_stream(
    meeting_id: str = Form(...),
    meeting_title: str = Form(""),
    date: str = Form(""),
    time: str = Form(""),
    note_taker: str = Form(""),
    attendees: str = Form(""),
    apologies: str = Form(""),
    gemini_api_key: Optional[str] = Form(None),
    groq_api_key: Optional[str] = Form(None),
):
    """
    Phase 2: transcribe + draft minutes for a meeting_id that
    /meetings/prepare-audio/stream already uploaded and normalized (no audio
    file is re-uploaded here — see save_prepared_audio/load_prepared_audio).
    """
    api_key = _effective_gemini_api_key(gemini_api_key)
    groq_api_key = _effective_groq_api_key(groq_api_key)

    meeting_dir = audio_dir_for(meeting_id)
    prepared = load_prepared_audio(meeting_id)
    if not prepared or not (meeting_dir / prepared["normalized_filename"]).exists():
        async def missing_prep_stream():
            yield sse_event("error", product_error(
                "meeting_not_prepared",
                "This recording hasn't finished preparing yet",
                "No prepared audio was found for this meeting. It may still be uploading, "
                "preparation may have failed earlier, or the audio may have been discarded.",
                ["Wait for audio preparation to finish and try again", "Re-select the recording and try again"],
            ))
        from fastapi.responses import StreamingResponse
        return StreamingResponse(missing_prep_stream(), media_type="text/event-stream")

    normalized_path = str(meeting_dir / prepared["normalized_filename"])
    original_filename = prepared["original_filename"]

    meta = {
        "meeting_title": meeting_title,
        "date": date,
        "time": time,
        "note_taker": note_taker,
        "attendees": attendees,
        "apologies": apologies,
    }

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        async def run_pipeline():
            loop = asyncio.get_running_loop()

            def on_split_progress(percent: int) -> None:
                # See prepare_meeting_audio_stream's emit_progress_threadsafe
                # for why this needs call_soon_threadsafe: the split runs in a
                # worker thread, and asyncio.Queue isn't thread-safe.
                payload = {
                    "phase": "splitting_audio",
                    "label": f"Splitting audio for transcription ({percent}%)",
                    "percent": percent,
                }
                loop.call_soon_threadsafe(queue.put_nowait, ("progress", payload))

            try:
                if not api_key:
                    await queue.put(("error", localized_product_error("ai_provider_unavailable", "en")))
                    return
                if not groq_api_key:
                    await queue.put(("error", localized_product_error("transcription_provider_unavailable", "en")))
                    return

                await queue.put(("progress", {"phase": "transcribing", "label": "Transcribing audio"}))

                async def on_transcription_chunk_done(completed: int, total: int) -> None:
                    # Only fires when the recording was large enough to need
                    # splitting; short recordings finish in one Groq request
                    # with no intermediate progress to report.
                    await queue.put(("progress", {
                        "phase": "transcribing",
                        "label": f"Transcribing audio ({completed}/{total})",
                        "current": completed,
                        "total": total,
                        "percent": round(completed / total * 100) if total else None,
                    }))

                transcription = await transcribe_audio(
                    normalized_path, groq_api_key,
                    on_chunk_done=on_transcription_chunk_done,
                    on_split_progress=on_split_progress,
                )
                transcript = transcription["text"]
                segments = transcription["segments"]

                if not transcript.strip():
                    await queue.put(("error", product_error(
                        "transcription_empty",
                        "No speech was found in this recording",
                        "The audio was processed but no transcribable speech was detected.",
                        ["Confirm the recording actually captured audio", "Try uploading a different file"],
                    )))
                    return

                await queue.put(("progress", {"phase": "drafting_minutes", "label": "Drafting meeting minutes"}))
                minutes = await generate_minutes(transcript, meta, api_key)

                record = {
                    "meeting_id": meeting_id,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "audio_filename": original_filename,
                    # The playback endpoint serves this file; normalize_audio() may
                    # have converted the original into a browser-playable mp3, or
                    # fallen back to the original path if pydub/ffmpeg weren't available.
                    "audio_playback_filename": prepared["normalized_filename"],
                    "transcript": transcript,
                    "segments": segments,
                    "meeting_data": minutes,
                }
                await asyncio.to_thread(save_meeting_record, record)

                await queue.put(("final", {
                    "meeting_id": meeting_id,
                    "transcript": transcript,
                    "segments": segments,
                    "minutes": minutes,
                    # The frontend fetches the audio once via GET
                    # /meetings/{id}/audio and caches it client-side (see
                    # meetingStore.js), then deletes this server-side copy —
                    # it needs these filenames to build that cached record in
                    # the same shape the old server-persisted one had.
                    "created_at": record["created_at"],
                    "audio_filename": record["audio_filename"],
                    "audio_playback_filename": record["audio_playback_filename"],
                }))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"❌ Meeting pipeline error: {e}")
                await queue.put(("error", product_error(
                    "meeting_processing_error",
                    "Could not generate meeting minutes",
                    "An error occurred while transcribing the recording or drafting the minutes.",
                    ["Try again later", "If the recording is very long, try a shorter clip"],
                    str(e),
                )))

        task = asyncio.create_task(run_pipeline())
        try:
            while True:
                event, payload = await queue.get()
                yield sse_event(event, payload)
                if event in {"final", "error"}:
                    break
        finally:
            # Cancel the background task if still running (e.g. client disconnected
            # mid-stream) — mirrors chat_stream_endpoint's cleanup so an abandoned
            # transcription doesn't keep running against the Gemini API forever.
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    from fastapi.responses import StreamingResponse
    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/meetings/download")
async def download_meeting(payload: MeetingDownloadRequest):
    # Stateless by design: meeting records now live in the browser (IndexedDB),
    # not on this server (see the frontend's meetingStore.js and the removed
    # GET /meetings, GET /meetings/{id}, PUT /meetings/{id} endpoints this
    # replaced) — this endpoint just converts whatever meeting_data the
    # client already has into a .docx, without needing to look anything up.
    docx_bytes = await asyncio.to_thread(build_docx, payload.meeting_data)
    title = payload.meeting_data.get("meeting_title") or "Meeting Notes"
    safe_title = re.sub(r"[^\w\-() ]", "_", title).strip() or "Meeting Notes"

    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{safe_title}.docx"'},
    )


AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".aiff": "audio/aiff",
}


@app.get("/meetings/{meeting_id}/audio")
async def get_meeting_audio(meeting_id: str):
    record = await asyncio.to_thread(load_meeting_record, meeting_id)
    if record is None:
        raise HTTPException(status_code=404, detail=_meeting_not_found_error("play"))

    playback_filename = record.get("audio_playback_filename") or record.get("audio_filename")
    audio_path = audio_dir_for(meeting_id) / str(playback_filename or "")
    if not playback_filename or not audio_path.exists():
        raise HTTPException(status_code=404, detail=_meeting_not_found_error("play"))

    media_type = AUDIO_MEDIA_TYPES.get(audio_path.suffix.lower(), "application/octet-stream")
    # FileResponse handles Range requests, which <audio> needs for seeking/scrubbing.
    return FileResponse(audio_path, media_type=media_type)


@app.delete("/meetings/{meeting_id}")
async def delete_meeting(meeting_id: str):
    deleted = await asyncio.to_thread(delete_meeting_record, meeting_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=_meeting_not_found_error("delete"))
    return {"message": f"Meeting {meeting_id} deleted successfully"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
