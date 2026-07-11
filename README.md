# IKEA Data Agent (Data Machi) 專屬數據助手

## 📌 專案介紹 (Project Overview)
本專案為開發給「IKEA Data Team」使用的內部專屬 AI 助理系統——**Data Machi**。這是一個基於大型語言模型（LLM）結合 LangGraph 打造的多智能體（Multi-Agent System）架構。系統採用雙模型設計：最終回答與使用者實際互動使用 `GEMINI_MODEL`（預設 `gemini-3.5-flash`），對話脈絡判斷、澄清問題設計、回答查核等內部、非使用者可見的步驟則改用較快的 `GEMINI_FAST_MODEL`（預設 `gemini-2.5-flash`），兩者皆可透過環境變數調整。它被賦予了嚴格的系統身份與邊界，專注於解決團隊內部的數據處理、專案進度追蹤以及知識庫檢索問題。系統同時包含方便使用者互動的 Web 前端介面設計與穩定提供服務的 Python 後端。

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
- **AI / 核心邏輯**：LangGraph（StateGraph 狀態機，見 [`LangChain_vs_LangGraph.md`](./LangChain_vs_LangGraph.md) 說明遷移原因）+ Google Generative AI (Gemini)，透過 `langchain-google-genai` 串接
- **其他整合**：Trello API / Confluence 文件檢索 / 向量資料庫（Vector DB）/ Groq Whisper（會議錄音轉逐字稿）等

---

## 🚀 如何啟動專案 (How to Run)

本專案需要同時啟動 **後端 FastAPI** 與 **前端 Vite**。建議開兩個終端機視窗：

- 終端機 A：啟動後端，預設網址為 `http://localhost:8000`
- 終端機 B：啟動前端，預設網址通常為 `http://localhost:5173`

請先確認本機已安裝：

- **Node.js**：前端使用 Vite 7，需 `^20.19.0` 或 `>=22.12.0`
- **Python**：建議使用 `3.10` 以上，推薦 `3.11` 或 `3.12`
- **Homebrew**：macOS 若要安裝 OCR / PDF 工具會用到

> 不建議使用 macOS 內建的 Python 3.9.6。Google 套件已提醒 Python 3.9 逐步停止支援，而且安裝 `numpy` 等套件時比較容易遇到編譯錯誤。

### 1️⃣ 後端啟動方式 (Backend)

後端負責 AI 邏輯、資料檢索、文件處理，以及提供前端呼叫的 API。

#### 第一次啟動

請在專案根目錄執行：

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
```

如果你的電腦還沒有 `python3.11`，macOS 可先安裝：

```bash
brew install python@3.11
```

安裝完成後，確認 `backend/.env` 已存在並填好必要設定，再啟動後端：

```bash
python main.py
```

啟動成功時，終端機會看到 Uvicorn 服務啟動訊息。後端預設會跑在：

```text
http://localhost:8000
```

#### 之後再次啟動

如果已經建立過 `.venv` 並安裝過套件，下次只需要：

```bash
cd backend
source .venv/bin/activate
python main.py
```

#### 後端環境變數

請在 `backend/.env` 準備以下設定。實際值請向團隊或服務管理者取得：

```env
# Google Gemini API
GOOGLE_API_KEY=your_google_api_key

# 選填：分別指定「最終回答」與「內部判斷步驟」使用的模型，不設定則用預設值
GEMINI_MODEL=gemini-3.5-flash
GEMINI_FAST_MODEL=gemini-2.5-flash

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

如果要使用 Google Sheets / Analyst Agent，還需要提供 Google Cloud service account 憑證。**請勿把 `.json` 金鑰檔提交到 git**（`backend/*.json` 已加入 `.gitignore`）。有兩種方式擇一：

- **正式環境／建議做法**：把整份 `.json` 金鑰內容貼進 `GOOGLE_SERVICE_ACCOUNT_JSON` 環境變數（單行字串即可，程式會自動解析）。
- **本機開發**：把 `.json` 檔案放在 `backend/` 目錄下即可（例如 `backend/your-project-XXXX.json`），程式會自動偵測——但僅限本機使用，不要提交到 git。

```env
# 擇一設定即可；若兩者都沒有，Analyst Agent 會回報找不到憑證
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...", ...}
```

#### PDF OCR / 視覺解析依賴

如果要處理掃描型 PDF、圖片頁、截圖或圖表頁，除了 Python 套件外，macOS 還需要安裝：

```bash
brew install tesseract poppler
```

如果暫時不需要 PDF 視覺摘要，可在 `backend/.env` 關閉：

```env
PDF_VISUAL_CONTEXT=false
```

也可以限制視覺解析頁數，避免大型 PDF 處理太久：

```env
PDF_VISUAL_PAGE_LIMIT=30
```

#### 會議錄音轉逐字稿依賴

如果要使用「會議記錄」功能（上傳/錄製會議錄音 → 轉逐字稿 → 自動產生會議記錄 .docx），
除了 Python 套件（`pydub`、`python-docx`）外，macOS 還需要安裝 `ffmpeg` 才能把瀏覽器錄音
（`webm`/`opus`）或手機錄音轉成 Gemini 支援的音訊格式：

```bash
brew install ffmpeg
```

轉逐字稿本身使用 Groq 的 Whisper API（`whisper-large-v3-turbo`，速度遠快於直接把音檔丟給 Gemini）。
Groq API Key **不是**放在 `backend/.env`——後端刻意不保存這組金鑰，使用者需要在前端「會議錄製」視窗裡自行輸入，
每次請求才會隨著呼叫一起帶上。

### 2️⃣ 前端啟動方式 (Frontend)

前端是 Data Machi 的聊天介面，會呼叫後端 API。請開啟另一個終端機視窗，保持後端繼續執行。

#### 第一次啟動

請在專案根目錄執行：

```bash
cd frontend
npm install
npm run dev
```

啟動後，Vite 會顯示本機網址，通常是：

```text
http://localhost:5173
```

打開這個網址即可使用前端畫面。

#### 之後再次啟動

如果已經安裝過 Node 套件，下次只需要：

```bash
cd frontend
npm run dev
```

#### 指定後端 API 位址

前端預設會呼叫：

```text
http://localhost:8000
```

如果後端不是跑在 `8000`，例如跑在 `8001`，可以用以下方式啟動前端：

```bash
VITE_API_URL=http://127.0.0.1:8001 npm run dev
```

或建立 `frontend/.env.local`：

```env
VITE_API_URL=http://127.0.0.1:8001
```

如果後端使用預設 `8000`，也可以寫成：

```env
VITE_API_URL=http://127.0.0.1:8000
```

### 3️⃣ 快速啟動指令總覽

終端機 A：後端

```bash
cd backend
source .venv/bin/activate
python main.py
```

終端機 B：前端

```bash
cd frontend
npm run dev
```

瀏覽器開啟：

```text
http://localhost:5173
```

### 4️⃣ 常見安裝問題

#### `numpy` metadata-generation-failed

如果安裝套件時看到類似：

```text
error: metadata-generation-failed
Encountered error while generating package metadata.
numpy
```

通常代表目前 Python 版本或編譯環境不適合，pip 嘗試從原始碼編譯 `numpy` 但失敗。建議改用 Python 3.11 重建虛擬環境：

```bash
cd backend
deactivate 2>/dev/null
rm -rf .venv
brew install python@3.11
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
```

#### pip 版本太舊

如果看到：

```text
WARNING: You are using pip version ...
```

可在已啟動虛擬環境後升級：

```bash
python -m pip install --upgrade pip
```

#### Python 3.9 / urllib3 / OpenSSL 警告

如果看到 Google 套件提示 Python 3.9 不再支援，或 `urllib3 NotOpenSSLWarning`，通常不是專案程式碼錯誤，但建議改用 Homebrew 或 pyenv 安裝的 Python 3.11，並重新建立 `.venv`。

### 5️⃣ AI Debug 模式（僅開發用）

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

### 6️⃣ 驗證指令（建議在提交前執行）

後端語法與上下文路由 smoke test：
```bash
python -m py_compile backend/agent_logic.py backend/agents/coordinator.py backend/main.py backend/conversation_store.py backend/tests/context_routing_smoke.py backend/tests/meeting_docx_smoke.py
GOOGLE_API_KEY=dummy python backend/tests/context_routing_smoke.py
python backend/tests/meeting_docx_smoke.py
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
3. 在 Render 控制台把所有的環境變數 (Environment Variables) 填寫完成，包含 `GOOGLE_API_KEY`、Trello / Confluence 相關設定，以及 `GOOGLE_SERVICE_ACCOUNT_JSON`（把 Google service account 的 `.json` 金鑰內容整份貼進去，不要用檔案上傳的方式）。
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
* `render.yaml` 已指定 Render 使用 Python `3.11.15`（repo 根目錄的 `.python-version` 也是同一版本，作為 Render 沒有正確套用該環境變數時的備援）；本機開發請確認用的也是 Python 3.10+，不要用 macOS 內建的 3.9.6。
* Google service account 憑證請用 `GOOGLE_SERVICE_ACCOUNT_JSON` 環境變數提供；`backend/*.json` 已加入 `.gitignore`，切勿把金鑰檔提交到 git（若不確定舊的憑證檔是否曾經被提交過，請檢查 git 歷史紀錄並到 Google Cloud Console 旋轉金鑰）。
