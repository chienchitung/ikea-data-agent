import os
import glob
from langchain.tools import tool
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from dotenv import load_dotenv
try:
    import pytesseract
    from pdf2image import convert_from_path
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False

load_dotenv()

vector_db = None
embeddings = None
loaded_files = []

def get_loaded_files():
    return loaded_files

def initialize_knowledge_base():
    global vector_db, embeddings, loaded_files
    
    # 1. Setup Embeddings
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("Warning: GOOGLE_API_KEY not found for Document Agent.")
        return {
            "success": False, 
            "message": "GOOGLE_API_KEY missing."
        }

    try:
        embeddings = GoogleGenerativeAIEmbeddings(
            model="models/gemini-embedding-001",
            google_api_key=api_key
        )
    except Exception as e:
        print(f"Warning: Failed to initialize Embeddings: {e}")
        return {
            "success": False, 
            "message": f"Embeddings initialization failed: {e}"
        }

    # 2. Check for PDF
    # Look for any PDF in the backend directory or parent directory
    pdf_files = glob.glob("*.pdf") + glob.glob("../*.pdf") + glob.glob("backend/*.pdf")
    if not pdf_files:
        loaded_files = []  # Clear the list when no PDFs found
        print("Info: No PDF files found for Document Agent knowledge base.")
        return {
            "success": True, 
            "loaded_files": [], 
            "failed_files": [],
            "message": "No PDF files found."
        }

    # Load ALL found PDFs
    all_splits = []
    _local_loaded_files = []
    failed_files = []
    
    for filename in pdf_files:
        try:
            loader = PyPDFLoader(filename)
            pages = loader.load()
            
            # Check if any pages have content
            has_content = any(len(page.page_content.strip()) > 0 for page in pages)
            
            # --- OCR Fallback Logic ---
            if not has_content and OCR_AVAILABLE:
                print(f"⚠️ Warning: {os.path.basename(filename)} has no text content. Attempting OCR...")
                try:
                    # Convert PDF to images
                    print(f"   Converting PDF to images (this may take a while)...")
                    images = convert_from_path(filename)
                    
                    ocr_pages = []
                    for i, image in enumerate(images):
                        # Use Traditional Chinese + Simplified Chinese + English
                        # Assumes Tesseract data is installed in /opt/homebrew/share/tessdata/ or system path
                        text = pytesseract.image_to_string(image, lang='chi_tra+chi_sim+eng')
                        if text.strip():
                            ocr_pages.append(Document(
                                page_content=text,
                                metadata={"source": os.path.basename(filename), "page": i}
                            ))
                            
                    if ocr_pages:
                        print(f"✅ OCR Successful: Extracted text from {len(ocr_pages)} pages.")
                        pages = ocr_pages
                        has_content = True
                    else:
                         print(f"❌ OCR Failed: Could not extract text even with OCR.")
                except Exception as ocr_e:
                    print(f"❌ OCR Error: {ocr_e}")
                    failed_files.append((filename, f"OCR Failed: {ocr_e}"))

            if not has_content:
                if not OCR_AVAILABLE:
                     failed_files.append((filename, "No text found & OCR tools not installed"))
                     print(f"⚠️ Warning: {os.path.basename(filename)} is scanned. Install tesseract & pdf2image for OCR support.")
                elif filename not in [f[0] for f in failed_files]: # Don't double add
                     failed_files.append((filename, "No text content found even after OCR"))
                continue
                
            text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
            splits = text_splitter.split_documents(pages)
            
            # Add metadata for source file
            for split in splits:
                split.metadata['source'] = os.path.basename(filename)
                
            all_splits.extend(splits)
            _local_loaded_files.append(os.path.basename(filename))
            print(f"✅ Loaded: {os.path.basename(filename)} ({len(pages)} pages, {len(splits)} chunks)")
        except Exception as e:
            failed_files.append((filename, str(e)))
            print(f"❌ Error loading {filename}: {e}")

    if failed_files:
        print(f"\n⚠️ Failed to process {len(failed_files)} file(s):")
        for fname, reason in failed_files:
            print(f"   - {os.path.basename(fname)}: {reason}")
    
    if not all_splits:
        print("\n❌ No content extracted from any PDFs.")
        print("   Possible reasons:")
        print("   1. PDFs are scanned images without text (OCR needed)")
        print("   2. PDFs are password-protected")
        print("   3. PDFs are corrupted or in an unsupported format")
        return {
            "success": False, 
            "loaded_files": [], 
            "failed_files": failed_files,
            "message": "No extractable content found in any PDFs."
        }

    # --- Robust Building Logic with Rate Limit Handling ---
    import time
    
    print(f"文件已切割為 {len(all_splits)} 個區塊。準備開始 Embedding (Batch Mode)...")
    
    batch_size = 5  # 極低：每次 5 個
    normal_sleep = 2 # 正常休息
    error_sleep = 60 # 遇到錯誤休息 60 秒
    
    total_chunks = len(all_splits)
    vector_db = None # Reset
    
    i = 0
    while i < total_chunks:
        batch = all_splits[i : i + batch_size]
        current_end = min(i + batch_size, total_chunks)
        print(f"🔄 處理進度: {i+1} ~ {current_end} / {total_chunks} ...", end=" ", flush=True)
        
        try:
            if vector_db is None:
                vector_db = FAISS.from_documents(batch, embeddings)
            else:
                vector_db.add_documents(batch)
                
            print("✅ OK")
            i += batch_size
            time.sleep(normal_sleep)
            
        except Exception as e:
            error_msg = str(e)
            if "429" in error_msg or "ResourceExhausted" in error_msg:
                print(f"\n⚠️ 觸發 API 速率限制 (Rate Limit)。")
                print(f"⏳ 系統將自動暫停 {error_sleep} 秒後重試，請耐心等待...")
                time.sleep(error_sleep)
                # Retry same batch
            else:
                print(f"\n❌ 發生未預期的錯誤: {e}")
                # For critical errors, we might want to skip or break. 
                # Choosing to break to avoid infinite loops on bad data.
                break

    if vector_db:
        # Update global list
        loaded_files = _local_loaded_files

        print("\n✅ Document 憑證已從 Environment Variables 載入")
        print(f"   Loaded Knowledge Base from: {', '.join(loaded_files)}")
        print("✅ Document Knowledge Base Initialized.")
        
        return {
            "success": True,
            "loaded_files": loaded_files,
            "failed_files": failed_files,
            "message": f"Successfully loaded {len(loaded_files)} documents."
        }
    else:
        loaded_files = []
        print("❌ Failed to initialize vector DB.")
        return {
            "success": False,
            "loaded_files": [],
            "failed_files": failed_files,
            "message": "Failed to initialize knowledge base. No valid content found."
        }

# Try to initialize on module load
initialize_knowledge_base()

def rename_document_in_kb(old_name: str, new_name: str) -> bool:
    """
    Optimized rename: Updates metadata in the existing vector_db in-place.
    Avoids full re-initialization (OCR/Embedding).
    """
    global vector_db, loaded_files
    
    if vector_db is None:
        return False

    print(f"⚡️ Optimizing Rename: {old_name} -> {new_name} in VectorDB...")
    
    try:
        # FAISS in LangChain typically uses InMemoryDocstore
        # Access the underlying dictionary
        docstore_dict = vector_db.docstore._dict
        
        count = 0
        for doc_id, doc in docstore_dict.items():
            if doc.metadata.get("source") == old_name:
                doc.metadata["source"] = new_name
                count += 1
        
        print(f"✅ Fast Rename: Updated metadata for {count} chunks.")
        
        # Update global loaded_files list
        if old_name in loaded_files:
            index = loaded_files.index(old_name)
            loaded_files[index] = new_name
            
        return count > 0
    except Exception as e:
        print(f"❌ Fast Rename Failed: {e}")
        return False

@tool
def search_document_base(query: str) -> str:
    """
    檢索 PDF 知識庫中的相關內容。
    當用戶詢問關於「規範」、「流程」、「合約細節」或「文件內容」時，必須使用此工具。
    回傳最相關的 5 個段落。
    """
    global vector_db
    if vector_db is None:
        return "錯誤：知識庫尚未建立，請先上傳 PDF 文件。"
    
    print(f"\n[Knowledge Search] 正在檢索: {query} ...")
    
    # 進行相似度搜尋 (k 代表回傳前五名最相關的片段，但透過 score 進行過濾)
    results_with_scores = vector_db.similarity_search_with_score(query, k=5)
    
    # Langchain FAISS 中，L2 distance 越小代表越相似。通常大於某個閾值(例如 1.0)就代表很不相關。
    filtered_results = [(doc, score) for doc, score in results_with_scores if score < 1.2]
    
    if not filtered_results:
        return "⚠️ 文件中未提及此內容（找不到足夠相關的資訊，請不要憑空編造）。"

    output = ""
    for i, (doc, score) in enumerate(filtered_results):
        # 包含頁碼資訊，方便溯源
        page_num = doc.metadata.get("page", "未知")
        output += f"\n--- 參考片段 {i+1} (Page {page_num}, Distance: {score:.2f}) ---\n"
        output += doc.page_content
        output += "\n"
    
    return output

# 打包工具
document_tools = [search_document_base]

print("\n✅ Document Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in document_tools]}")
