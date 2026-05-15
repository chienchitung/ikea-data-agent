# IKEA Data Agent (Data Machi) 專屬數據助手

## 📌 專案介紹 (Project Overview)
本專案為開發給「IKEA Data Team」使用的內部專屬 AI 助理系統——**Data Machi**。這是一個基於大型語言模型（LLM，目前預設使用 Gemini 2.5 Flash）結合 LangChain 工具生態圈打造的多智能體（Multi-Agent System）架構。它被賦予了嚴格的系統身份與邊界，專注於解決團隊內部的數據處理、專案進度追蹤以及知識庫檢索問題。系統同時包含方便使用者互動的 Web 前端介面設計與穩定提供服務的 Python 後端。

## 🎯 核心開發目的 (Core Purpose)
1. **專注業務範圍**：確保 AI 助理只協助回答 IKEA 內部的數據、Trello 專案進度、Confluence 文件以及團隊知識庫的問題。針對無關的閒聊（如天氣、食譜、通用百科等），將會進行阻擋並回覆標準答案，避免模型提供非業務範圍的資訊。
2. **多代理人協作 (Multi-Agent System)**：系統核心由一個 Coordinator (協調整合者) 接收使用者提問，並依據意圖分配給特定的專家 Agent，包含：
   - **Analyst (數據分析)**：負責串接 Google 服務存取 Google Sheets 上的商業資料。
   - **Confluence (知識庫)**：負責檢索 Confluence 上的團隊文件、規範與解決方案。
   - **Trello (專案管理)**：負責追蹤專案管理看板狀態以及票卡進度。
   - **Document (文檔處理)**：負責檢索本地文件（使用向量資料庫輔助問答）。
3. **優化團隊效率**：透過直覺的聊天對話介面，幫助團隊成員快速檢索所需資料並排解問題。

## 🛠 系統架構與技術棧 (Tech Stack)
- **前端 (Frontend)**：React.js + Vite + TailwindCSS (建構於 Node.js 環境)
- **後端 (Backend)**：Python + FastAPI (提供 RESTful API)
- **AI / 核心邏輯**：LangChain + Google Generative AI (Gemini)
- **其他整合**：Trello API / Confluence 文件檢索 / 向量資料庫（Vector DB）等

---

## 🚀 如何啟動專案 (How to Run)

請確保你的電腦已安裝以下環境：
- **Node.js**：前端使用 Vite 7，需 `^20.19.0` 或 `>=22.12.0`
- **Python**：建議 3.10 以上版本（3.9 已接近/進入多數套件的支援尾端）

### 1️⃣ 後端啟動方式 (Backend Startup)

後端主要負責處理 AI 邏輯、資料檢索與提供 API。

1. **進入後端資料夾**
   ```bash
   cd backend
   ```
2. **建立並啟動虛擬環境 (Virtual Environment)**
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # macOS / Linux
   # Windows: .venv\Scripts\activate
   ```
3. **安裝依賴套件 (Install Requirements)**
   ```bash
   pip install -r requirements.txt
   ```
4. **環境變數設定 (.env)**
   請確保在 `backend` 目錄下準備好 `.env` 檔案，需包含的主要金鑰如下：
   ```env
   # Google Gemini API
   GOOGLE_API_KEY=your_google_api_key

   # Trello API 設定
   TRELLO_BOARD_ID=your_trello_board_id
   TRELLO_API_KEY=your_trello_api_key
   TRELLO_TOKEN=your_trello_token

   # Confluence API 設定
   CONFLUENCE_URL=your_confluence_url
   CONFLUENCE_USERNAME=your_confluence_username
   CONFLUENCE_API_TOKEN=your_confluence_api_token
   
   # Google Sheet 設定
   GOOGLE_SHEET_KEY=your_sheet_key_id
   ```
5. **GCP 服務帳號憑證配置 (Service Account JSON)**
   由於 `Analyst` Agent 需要存取 Google Sheets 等服務，請向團隊取得 Google Cloud 服務帳號憑證（`.json` 檔，例如：`cedar-unison-XXXX.json`），並將該檔案放置於 `backend/` 目錄下。系統啟動時將自動讀取該檔案進行身份驗證。
6. **PDF OCR / 視覺解析依賴（選用，但建議安裝）**
   如果要處理掃描型 PDF、圖片頁、截圖或圖表頁，除了 Python 套件外，系統環境也需要 OCR / PDF 圖片轉換工具。
   macOS 可用：
   ```bash
   brew install tesseract poppler
   ```
   若暫時不需要 PDF 視覺摘要，可在 `backend/.env` 關閉：
   ```env
   PDF_VISUAL_CONTEXT=false
   ```
   也可以限制視覺解析頁數，避免大型 PDF 處理太久：
   ```env
   PDF_VISUAL_PAGE_LIMIT=30
   ```
7. **啟動伺服器**
   ```bash
   python main.py
   ```
   伺服器預設會透過 Uvicorn 在 `http://0.0.0.0:8000` 運行。

### 2️⃣ 前端啟動方式 (Frontend Startup)

前端提供了與 Data Machi 互動的聊天者介面。

1. **進入前端資料夾**（請重新開一個新的終端機分頁/視窗）
   ```bash
   cd frontend
   ```
2. **安裝 Node 套件 (Install Node Modules)**
   ```bash
   npm install
   ```
3. **啟動開發伺服器 (Start Dev Server)**
   ```bash
   npm run dev
   ```
   啟動後，終端機會顯示類似 `http://localhost:5173` 的本地網址，點擊即可開啟網頁。

4. **指定後端 API 位址（選用）**
   若後端不是跑在預設的 `http://localhost:8000`，請在啟動前指定 `VITE_API_URL`：
   ```bash
   VITE_API_URL=http://127.0.0.1:8001 npm run dev
   ```
   或在 `frontend/.env.local` 建立：
   ```env
   VITE_API_URL=http://127.0.0.1:8001
   ```

### 3️⃣ AI Debug 模式（僅開發用）

前端內建一個 AI Debug 面板，用來檢查每一輪回覆的上下文判斷、工具調用、耗時與 token metadata。這個功能只供開發與除錯使用，正式版不會顯示。

臨時開啟一次：
```bash
cd frontend
VITE_DEBUG_AI=true npm run dev
```

若同時要指定後端 API：
```bash
cd frontend
VITE_DEBUG_AI=true VITE_API_URL=http://127.0.0.1:8001 npm run dev
```

也可以在 `frontend/.env.local` 固定開啟：
```env
VITE_DEBUG_AI=true
VITE_API_URL=http://127.0.0.1:8000
```

注意：Debug 按鈕的顯示條件是「Vite 開發模式」且 `VITE_DEBUG_AI=true`。production build 即使設定 `VITE_DEBUG_AI=true`，也不會顯示 Debug 按鈕。

### 4️⃣ 驗證指令（建議在提交前執行）

後端語法與上下文路由 smoke test：
```bash
python -m py_compile backend/agent_logic.py backend/agents/coordinator.py backend/main.py backend/conversation_store.py backend/tests/context_routing_smoke.py
GOOGLE_API_KEY=dummy python backend/tests/context_routing_smoke.py
```

前端 lint 與 production build：
```bash
cd frontend
npm run lint
npm run build
```

---

## ☁️ 雲端部署指南 (Cloud Deployment)

若你要將專案部署至雲端，讓團隊成員 24 小時隨時都可以透過網址使用，最推薦的方式為 **前端代管 (Vercel) + 後端代管 (Render)**。

### 步驟一：部署後端 (Render)
本專案已包含好 `render.yaml` 藍圖設定檔。
1. 註冊並登入 [Render](https://render.com/)，在 Dashboard 選擇 **Blueprints** 並綁定你的 GitHub 專案。
2. Render 會自動讀取 `render.yaml` 建立名為 `ikea-data-agent-backend` 的服務。
   - *(備註：若你不是使用 Blueprint，而是手動建立 Web Service，請確保填寫 Build Command 為 `cd backend && pip install -r requirements.txt`，Start Command 為 `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT`)*
3. 在 Render 控制台把所有的環境變數 (Environment Variables，如 `GOOGLE_API_KEY`、`.json` 的金鑰內容等) 填寫完成。
4. 部署完成後，會得到一串網址（如：`https://ikea-data-agent-backend.onrender.com`），請把這串網址複製備用。

### 步驟二：部署前端 (Vercel)
本專案的 React / Vite 前端已經準備好讀取環境變數。
1. 登入 [Vercel](https://vercel.com/)，點擊 **Add New Project**，並匯入你的 GitHub 專案。
2. 設定 **Root Directory** 為 `frontend`。
3. 在 Environment Variables 區塊，增加一個變數：
   - Name: `VITE_API_URL`
   - Value: `你在 Render 拿到的後端網址`
   - 不要在正式環境開啟或依賴 `VITE_DEBUG_AI`；Debug UI 只應用於本機開發。
4. 點擊 **Deploy**，不用幾分鐘你的前端就會上線，任何人只需開啟該網址即可無縫使用完整的 AI 系統。

---

## 💡 注意事項
* 每次要運行後端，都必須進入 `backend` 目錄並確認虛擬環境已經 `source .venv/bin/activate` 啟動。
* 預設情況下，前端將向 `http://localhost:8000` 或後端配置之 API 埠號發送請求，若有更改埠號請檢查全域網址設定。
* 前端聊天目前會優先使用 `/chat/stream` 接收後端進度事件；若後端服務沒有啟動，畫面會顯示連線失敗提示。
* `frontend/.env.local` 只放本機開發設定，不要提交真實 API key 或正式環境敏感資訊。
* 後端會在本機產生對話與 PDF 索引快取，例如 `backend/.conversation_store/`、`backend/faiss_index/`、`backend/document_chunks.json`；部署或清理環境時要留意這些資料是否需要保留。
* `render.yaml` 目前仍指定 Render 使用 Python 3.9.6；正式部署前建議評估更新到 Python 3.10+，避免 Google / LangChain 相關套件之後停止支援。
