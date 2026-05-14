import os
import glob
import shutil
import json
from langchain.tools import tool
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from dotenv import load_dotenv
from pypdf import PdfReader
try:
    import pytesseract
    from pdf2image import convert_from_path
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False
try:
    from google import genai
    VISUAL_CONTEXT_AVAILABLE = True
except ImportError:
    VISUAL_CONTEXT_AVAILABLE = False

load_dotenv()

vector_db = None
embeddings = None
loaded_files = []
document_chunks = []

# FAISS 持久化路徑（與 document.py 同層的 backend/ 目錄下）
FAISS_INDEX_PATH = os.path.join(os.path.dirname(__file__), "..", "faiss_index")
DOCUMENT_CHUNKS_PATH = os.path.join(os.path.dirname(__file__), "..", "document_chunks.json")
DOCUMENT_PIPELINE_VERSION = "layout_visual_v1"
PDF_VISUAL_CONTEXT_ENABLED = os.getenv("PDF_VISUAL_CONTEXT", "true").lower() not in {"0", "false", "no"}
PDF_VISUAL_PAGE_LIMIT = int(os.getenv("PDF_VISUAL_PAGE_LIMIT", "80"))
PDF_VISUAL_MODEL = os.getenv("PDF_VISUAL_MODEL", "gemini-2.5-flash")

VISUAL_TRIGGER_TERMS = [
    "附圖", "如圖", "圖片", "截圖", "圖表", "示意圖", "流程圖", "架構圖",
    "mockup", "dashboard", "diagram", "screenshot", "chart", "image", "visual"
]

def get_loaded_files():
    return loaded_files


def _chunk_sort_key(chunk: dict):
    page = chunk.get("page", 0)
    chunk_index = chunk.get("chunk_index", 0)
    if not isinstance(page, int):
        page = 0
    if not isinstance(chunk_index, int):
        chunk_index = 0
    return (chunk.get("source", ""), page, chunk_index)


def _document_chunks_are_current(chunks: list[dict]) -> bool:
    return bool(chunks) and all(
        chunk.get("pipeline_version") == DOCUMENT_PIPELINE_VERSION
        and chunk.get("content_type")
        for chunk in chunks
    )


def _save_document_chunks(chunks: list[dict]) -> None:
    try:
        with open(DOCUMENT_CHUNKS_PATH, "w", encoding="utf-8") as f:
            json.dump(chunks, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"⚠️ 儲存 document chunk cache 失敗：{e}")


def _load_document_chunks() -> list[dict]:
    try:
        with open(DOCUMENT_CHUNKS_PATH, "r", encoding="utf-8") as f:
            chunks = json.load(f)
        if isinstance(chunks, list):
            return chunks
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"⚠️ 載入 document chunk cache 失敗：{e}")
    return []


def _chunks_from_vector_db() -> list[dict]:
    if vector_db is None:
        return []

    chunks = []
    docs = list(getattr(vector_db.docstore, "_dict", {}).values())
    for index, doc in enumerate(docs):
        chunks.append({
            "chunk_id": f"{doc.metadata.get('source', 'unknown')}:{doc.metadata.get('page', 0)}:{index}",
            "source": doc.metadata.get("source", "未知文件"),
            "page": doc.metadata.get("page", 0),
            "chunk_index": index,
            "content_type": doc.metadata.get("content_type", "text"),
            "pipeline_version": doc.metadata.get("pipeline_version", DOCUMENT_PIPELINE_VERSION),
            "text": doc.page_content.strip(),
        })
    return sorted(chunks, key=_chunk_sort_key)


def get_document_corpus(max_chars: int = 60000) -> str:
    """
    Return the loaded PDF content from the FAISS docstore for whole-document
    summary questions. This uses the already processed chunks, so it also works
    after loading the persisted FAISS cache.
    """
    chunks = document_chunks or _chunks_from_vector_db()
    if not chunks:
        return "錯誤：知識庫尚未建立，請先上傳 PDF 文件。"

    output_parts = ["以下是已上傳 PDF 的完整文字內容摘要來源，請依照全文件脈絡回答。\n"]
    current_chars = len(output_parts[0])
    truncated = False

    for chunk_record in sorted(chunks, key=_chunk_sort_key):
        source = chunk_record.get("source", "未知文件")
        page = chunk_record.get("page", "未知")
        if isinstance(page, int):
            page += 1
        text = str(chunk_record.get("text", "")).strip()
        content_type = chunk_record.get("content_type", "text")
        if not text:
            continue

        chunk = f"\n--- Source: {source}, Page {page}, Type: {content_type} ---\n{text}\n"
        if current_chars + len(chunk) > max_chars:
            truncated = True
            break
        output_parts.append(chunk)
        current_chars += len(chunk)

    if truncated:
        output_parts.append("\n[注意：文件內容過長，已達本次可處理字數上限；以上為前段完整內容。]\n")

    return "".join(output_parts)


def _page_text_contains_visual_reference(text: str) -> bool:
    lowered = str(text or "").lower()
    compact = "".join(lowered.split())
    return any(term.lower() in lowered or term.lower() in compact for term in VISUAL_TRIGGER_TERMS)


def _xobject_has_image(xobject) -> bool:
    try:
        obj = xobject.get_object()
    except Exception:
        return False

    subtype = obj.get("/Subtype")
    if subtype == "/Image":
        return True

    if subtype == "/Form":
        resources = obj.get("/Resources") or {}
        nested = resources.get("/XObject")
        if nested:
            try:
                nested = nested.get_object()
                return any(_xobject_has_image(item) for item in nested.values())
            except Exception:
                return False
    return False


def _detect_pdf_image_pages(filename: str) -> set[int]:
    image_pages = set()
    try:
        reader = PdfReader(filename)
        for page_index, page in enumerate(reader.pages):
            resources = page.get("/Resources") or {}
            xobjects = resources.get("/XObject")
            if not xobjects:
                continue
            xobjects = xobjects.get_object()
            if any(_xobject_has_image(item) for item in xobjects.values()):
                image_pages.add(page_index)
    except Exception as e:
        print(f"⚠️ 無法偵測 PDF 圖片頁：{os.path.basename(filename)}，原因：{e}")
    return image_pages


def _should_build_visual_context(page: Document, image_pages: set[int]) -> bool:
    page_index = page.metadata.get("page", 0)
    if page_index in image_pages:
        return True
    return _page_text_contains_visual_reference(page.page_content)


def _visual_context_prompt(source_name: str, page_number: int) -> str:
    return f"""
你正在協助建立 PDF 的多模態知識庫。請分析這一頁 PDF 的畫面與版面。

重要原則：
- 不要因為文字和圖片在同一頁，就假設它們在講同一件事。
- 請把圖片、截圖、圖表、diagram、mockup 與周圍文字的關係說清楚。
- 如果某個圖片看起來只是範例、附圖、另一個流程或獨立主題，請明確標記為「關係不確定」或「可能不相關」。
- 請保留可被搜尋的關鍵字、畫面文字、圖表標籤、流程節點名稱。

請用繁體中文輸出，格式固定如下：

頁面視覺摘要
- 文件：{source_name}
- 頁碼：{page_number}
- 整體版面用途：
- 視覺元素：
  - Visual 1
    - 位置：例如上方 / 下方 / 左側 / 右側 / 中央
    - 類型：截圖 / 圖表 / 流程圖 / 架構圖 / mockup / 圖示 / 其他
    - 圖中可見文字：
    - 圖片實際表達：
    - 與附近文字的關係：明確相關 / 可能相關 / 不確定 / 可能不相關
    - 不應混淆的內容：
- 圖文關係結論：
"""


def _generate_page_visual_summary(filename: str, page_index: int, source_name: str, client) -> str:
    if not (PDF_VISUAL_CONTEXT_ENABLED and OCR_AVAILABLE and VISUAL_CONTEXT_AVAILABLE):
        return ""

    try:
        images = convert_from_path(
            filename,
            dpi=120,
            first_page=page_index + 1,
            last_page=page_index + 1,
        )
        if not images:
            return ""

        response = client.models.generate_content(
            model=PDF_VISUAL_MODEL,
            contents=[
                _visual_context_prompt(source_name, page_index + 1),
                images[0],
            ],
        )
        return str(getattr(response, "text", "") or "").strip()
    except Exception as e:
        print(f"⚠️ 視覺摘要失敗：{source_name} Page {page_index + 1}，原因：{e}")
        return ""


def _build_visual_documents(filename: str, pages: list[Document], source_name: str, api_key: str) -> list[Document]:
    if not (PDF_VISUAL_CONTEXT_ENABLED and OCR_AVAILABLE and VISUAL_CONTEXT_AVAILABLE):
        return []

    image_pages = _detect_pdf_image_pages(filename)
    target_pages = [
        page for page in pages
        if _should_build_visual_context(page, image_pages)
    ][:PDF_VISUAL_PAGE_LIMIT]

    if not target_pages:
        return []

        print(f"🖼️  建立頁面視覺摘要：{source_name}（{len(target_pages)} pages）")
    visual_docs = []
    try:
        client = genai.Client(api_key=api_key)
    except Exception as e:
        print(f"⚠️ 視覺摘要 client 初始化失敗：{e}")
        return []

    for page in target_pages:
        page_index = page.metadata.get("page", 0)
        summary = _generate_page_visual_summary(filename, page_index, source_name, client)
        if not summary:
            if not visual_docs:
                print("⚠️ 第一個視覺摘要失敗，略過本次 PDF 視覺摘要建立，避免重複 API/網路錯誤。")
                break
            continue
        visual_docs.append(Document(
            page_content=summary,
            metadata={
                "source": source_name,
                "page": page_index,
                "content_type": "visual_summary",
                "pipeline_version": DOCUMENT_PIPELINE_VERSION,
            }
        ))
    return visual_docs

def initialize_knowledge_base():
    global vector_db, embeddings, loaded_files, document_chunks
    
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

    # 提早退出：沒有 PDF 就不需要做任何事
    if not pdf_files:
        loaded_files = []
        document_chunks = []
        if os.path.exists(DOCUMENT_CHUNKS_PATH):
            try:
                os.remove(DOCUMENT_CHUNKS_PATH)
            except Exception as rm_e:
                print(f"⚠️ 清除 document chunk cache 失敗：{rm_e}")
        print("Info: No PDF files found for Document Agent knowledge base.")
        return {
            "success": True,
            "loaded_files": [],
            "failed_files": [],
            "message": "No PDF files found."
        }

    # 計算一次，後續複用
    faiss_index_dir = os.path.abspath(FAISS_INDEX_PATH)

    # ⚡️ 嘗試從磁碟載入已快取的 FAISS index（避免重啟時重新 embedding）
    if os.path.exists(os.path.join(faiss_index_dir, "index.faiss")):
        try:
            vector_db = FAISS.load_local(
                faiss_index_dir,
                embeddings,
                allow_dangerous_deserialization=True
            )
            # 從快取的 metadata 還原 loaded_files
            cached_sources = {
                doc.metadata.get("source", "")
                for doc in vector_db.docstore._dict.values()
                if doc.metadata.get("source")
            }
            # 驗證：快取的檔案清單必須與磁碟上的 PDF 完全一致
            # 若有差異（新增或刪除了 PDF），強制重建 index
            current_basenames = {os.path.basename(f) for f in pdf_files}
            if cached_sources == current_basenames:
                loaded_files = list(cached_sources)
                document_chunks = _load_document_chunks()
                chunk_sources = {
                    chunk.get("source", "")
                    for chunk in document_chunks
                    if chunk.get("source")
                }
                if chunk_sources != cached_sources:
                    document_chunks = _chunks_from_vector_db()
                    _save_document_chunks(document_chunks)
                if _document_chunks_are_current(document_chunks):
                    print(f"\n⚡️ FAISS index 從磁碟快取載入，跳過 embedding（{len(loaded_files)} 個文件，{len(document_chunks)} chunks）")
                    return {
                        "success": True,
                        "loaded_files": loaded_files,
                        "chunk_count": len(document_chunks),
                        "failed_files": [],
                        "message": f"Loaded from cache: {len(loaded_files)} documents, {len(document_chunks)} chunks."
                    }
                print("⚠️ PDF 解析 pipeline 已更新，強制重建 layout/visual-aware index")
            else:
                print(f"⚠️ 快取文件清單與磁碟不符，強制重建 index")
                print(f"   快取：{cached_sources}")
                print(f"   磁碟：{current_basenames}")
        except Exception as cache_e:
            print(f"⚠️ 快取載入失敗，重新建立 index：{cache_e}")

    # Load ALL found PDFs
    all_splits = []
    all_chunk_records = []
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
                
            source_name = os.path.basename(filename)
            for page in pages:
                page.metadata["source"] = source_name
                page.metadata["content_type"] = "text"
                page.metadata["pipeline_version"] = DOCUMENT_PIPELINE_VERSION

            visual_docs = _build_visual_documents(filename, pages, source_name, api_key)
            documents_to_split = pages + visual_docs

            text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
            splits = text_splitter.split_documents(documents_to_split)
            
            # Add metadata for source file
            for split_index, split in enumerate(splits):
                split.metadata['source'] = source_name
                split.metadata['chunk_index'] = split_index
                split.metadata['content_type'] = split.metadata.get("content_type", "text")
                split.metadata['pipeline_version'] = DOCUMENT_PIPELINE_VERSION
                all_chunk_records.append({
                    "chunk_id": f"{source_name}:{split.metadata.get('page', 0)}:{split_index}",
                    "source": source_name,
                    "page": split.metadata.get("page", 0),
                    "chunk_index": split_index,
                    "content_type": split.metadata.get("content_type", "text"),
                    "pipeline_version": DOCUMENT_PIPELINE_VERSION,
                    "text": split.page_content.strip(),
                })
                
            all_splits.extend(splits)
            _local_loaded_files.append(source_name)
            print(f"✅ Loaded: {source_name} ({len(pages)} pages, {len(visual_docs)} visual summaries, {len(splits)} chunks)")
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
        document_chunks = sorted(all_chunk_records, key=_chunk_sort_key)

        # 💾 儲存 FAISS index 到磁碟，下次重啟直接載入、跳過 embedding
        try:
            if os.path.exists(faiss_index_dir):
                shutil.rmtree(faiss_index_dir)
                print(f"🗑️ 已清除舊的 FAISS 磁碟快取")
            if os.path.exists(DOCUMENT_CHUNKS_PATH):
                os.remove(DOCUMENT_CHUNKS_PATH)
                print("🗑️ 已清除舊的 document chunk cache")
            os.makedirs(faiss_index_dir, exist_ok=True)
            vector_db.save_local(faiss_index_dir)
            print(f"💾 FAISS index 已儲存到磁碟：{faiss_index_dir}")
        except Exception as save_e:
            print(f"⚠️ FAISS index 儲存失敗（不影響運作）：{save_e}")
        _save_document_chunks(document_chunks)

        print("\n✅ Document 憑證已從 Environment Variables 載入")
        print(f"   Loaded Knowledge Base from: {', '.join(loaded_files)}")
        print(f"✅ Document Knowledge Base Initialized. Parsed chunks: {len(document_chunks)}")

        return {
            "success": True,
            "loaded_files": loaded_files,
            "chunk_count": len(document_chunks),
            "failed_files": failed_files,
            "message": f"Successfully loaded {len(loaded_files)} documents and {len(document_chunks)} chunks."
        }
    else:
        loaded_files = []
        document_chunks = []
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
    global vector_db, loaded_files, document_chunks
    
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

        chunk_updates = 0
        for chunk in document_chunks:
            if chunk.get("source") == old_name:
                chunk["source"] = new_name
                chunk["chunk_id"] = str(chunk.get("chunk_id", "")).replace(old_name, new_name, 1)
                chunk_updates += 1
        if chunk_updates:
            _save_document_chunks(document_chunks)
            print(f"✅ Fast Rename: Updated document chunk cache for {chunk_updates} chunks.")
            
        return count > 0
    except Exception as e:
        print(f"❌ Fast Rename Failed: {e}")
        return False

@tool
def search_document_base(query: str) -> str:
    """
    檢索 PDF 知識庫中的相關內容。
    當用戶詢問關於「規範」、「流程」、「合約細節」或「文件內容」時，必須使用此工具。
    回傳最相關的文字片段與頁面視覺摘要。
    """
    global vector_db
    if vector_db is None:
        return "錯誤：知識庫尚未建立，請先上傳 PDF 文件。"
    
    print(f"\n[Knowledge Search] 正在檢索: {query} ...")
    
    # 進行相似度搜尋。不同 embedding model / FAISS distance strategy 的分數範圍
    # 不穩定，不能用固定門檻硬濾，否則相關片段可能全部被丟掉。
    results_with_scores = vector_db.similarity_search_with_score(query, k=6)

    if not results_with_scores:
        return "⚠️ 【系統警告】文件中完全未提及此內容！你必須直接告訴使用者「文件裡沒有寫」，絕對不能憑空編造或推測答案！"

    output = (
        "以下是 PDF 知識庫中最相關的片段，請只根據這些內容回答，並在結尾列出來源。\n"
        "注意：Type=text 代表 PDF 文字層；Type=visual_summary 代表頁面圖片/截圖/圖表的視覺摘要。"
        "不要只因為兩個片段在同一頁，就假設它們描述同一件事；只有 visual_summary 明確指出圖文關係時，才可把圖片和文字連在一起。\n"
    )
    for i, (doc, score) in enumerate(results_with_scores):
        # 包含頁碼資訊，方便溯源
        source = doc.metadata.get("source", "未知文件")
        page_num = doc.metadata.get("page", "未知")
        content_type = doc.metadata.get("content_type", "text")
        if isinstance(page_num, int):
            page_num += 1
        output += f"\n--- 參考片段 {i+1} (Source: {source}, Page {page_num}, Type: {content_type}, Distance: {score:.2f}) ---\n"
        output += doc.page_content
        output += "\n"
    
    return output

# 打包工具
document_tools = [search_document_base]

print("\n✅ Document Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in document_tools]}")
