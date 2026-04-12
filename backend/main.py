from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, AIMessage
from agent_logic import process_chat
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

class ChatRequest(BaseModel):
    message: str
    history: List[Message] = []

class ChatResponse(BaseModel):
    response: str

@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    print(f"📩 Received: {request.message}")
    
    # Convert history
    chat_history = []
    for msg in request.history:
        if msg.role == "user":
            chat_history.append(HumanMessage(content=msg.content))
        elif msg.role == "assistant":
            chat_history.append(AIMessage(content=msg.content))
    
    # Process
    try:
        response_text = await process_chat(request.message, chat_history)
        return ChatResponse(response=response_text)
    except Exception as e:
        print(f"❌ Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

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
            raise HTTPException(status_code=400, detail="Only PDF files are allowed")
            
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
            return JSONResponse(
                status_code=422,
                content={
                    "filename": file.filename,
                    "message": f"File uploaded but processing failed: {failed_reason}",
                    "details": result
                }
            )
            
        # If result.success is False but file wasn't specifically in failed list (e.g. global error)
        if result and not result.get("success", False):
             return JSONResponse(
                status_code=422,
                content={
                    "filename": file.filename,
                    "message": f"File uploaded but knowledge base initialization failed: {result.get('message')}",
                    "details": result
                }
            )
        
        return {
            "filename": file.filename, 
            "message": "File uploaded and processed successfully", 
            "details": result
        }
    except Exception as e:
        print(f"❌ Upload Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

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
                
            raise HTTPException(status_code=404, detail=f"File {filename} not found. Checked locations: {file_paths}")
        
        # Reinitialize knowledge base
        initialize_knowledge_base()
        
        return {"message": f"File {filename} deleted successfully"}
    except Exception as e:
        print(f"❌ Delete Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/documents/{old_filename}")
async def rename_document(old_filename: str, new_name: dict):
    try:
        new_filename = new_name.get("new_name")
        if not new_filename:
            raise HTTPException(status_code=400, detail="new_name is required")
        
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
            raise HTTPException(status_code=404, detail=f"File {old_filename} not found")
        
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
    except Exception as e:
        print(f"❌ Rename Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
