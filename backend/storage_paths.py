"""所有落地資料的路徑集中在這裡，由 DATA_DIR 環境變數統一控制。

背景：Render 這類 PaaS 的服務檔案系統是「暫時性」的——每次部署/重啟都
會換上全新的容器，寫在本機磁碟的東西（上傳的 PDF、對話紀錄、會議紀錄、
錄音檔）全部消失。使用者實際回報過：重新部署後 PDF 來源不見了。

解法：在 Render 服務上掛一顆 Persistent Disk（例如 mount 到 /var/data），
並設定環境變數 DATA_DIR=/var/data。之後所有資料都寫進磁碟掛載點，部署
重啟不再遺失。

沒有設定 DATA_DIR 時（本機開發、尚未掛磁碟的部署），所有路徑退回原本
的位置（backend/ 目錄底下），行為與過去完全相同。
"""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent

_data_dir_env = os.getenv("DATA_DIR", "").strip()
DATA_DIR = Path(_data_dir_env) if _data_dir_env else BACKEND_DIR

# 上傳的 PDF 來源。legacy 佈局是直接放在 backend/ 根目錄，維持一致：
# PDF 一律放在 DATA_DIR 根目錄（DATA_DIR 未設定時就是 backend/）。
PDF_DIR = DATA_DIR

# 對話與追蹤紀錄
CONVERSATION_STORE_DIR = DATA_DIR / ".conversation_store"
AGENT_TRACE_DIR = DATA_DIR / ".agent_traces"

# 會議紀錄與錄音
MEETING_STORE_DIR = DATA_DIR / ".meeting_store"
MEETING_AUDIO_DIR = DATA_DIR / ".meeting_uploads"

# PDF 知識庫的快取（FAISS index 與 chunk cache）。放進 DATA_DIR 讓部署後
# 不用重新 OCR/嵌入整批文件；就算遺失也只是重建，不會丟資料。
FAISS_INDEX_PATH = str(DATA_DIR / "faiss_index")
DOCUMENT_CHUNKS_PATH = str(DATA_DIR / "document_chunks.json")

if _data_dir_env:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
