# IKEA Data Agent (Data Machi) 專屬數據助手

## 📌 專案介紹 (Project Overview)
本專案為開發給「IKEA Data Team」使用的內部專屬 AI 助理系統——**Data Machi**。這是一個基於大型語言模型（LLM, 如 Gemini 2.5 Pro）結合 LangChain 工具生態圈打造的多智能體（Multi-Agent System）架構。它被賦予了嚴格的系統身份與邊界，專注於解決團隊內部的數據處理、專案進度追蹤以及知識庫檢索問題。系統同時包含方便使用者互動的 Web 前端介面設計與穩定提供服務的 Python 後端。

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
- **Node.js** (建議 v18 以上版本)
- **Python** (建議 3.9 以上版本)

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
6. **啟動伺服器**
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

---

## ☁️ 雲端部署指南 (Cloud Deployment)

若你要將專案部署至雲端，讓團隊成員 24 小時隨時都可以透過網址使用，最推薦的方式為 **前端代管 (Vercel) + 後端代管 (Render)**。

### 步驟一：部署後端 (Render)
本專案已包含好 `render.yaml` 藍圖設定檔。
1. 註冊並登入 [Render](https://render.com/)，在 Dashboard 選擇 **Blueprints** 並綁定你的 GitHub 專案。
2. Render 會自動讀取 `render.yaml` 建立名為 `ikea-data-agent-backend` 的服務。
3. 在 Render 控制台把所有的環境變數 (Environment Variables，如 `GOOGLE_API_KEY`、`.json` 的金鑰內容等) 填寫完成。
4. 部署完成後，會得到一串網址（如：`https://ikea-data-agent-backend.onrender.com`），請把這串網址複製備用。

### 步驟二：部署前端 (Vercel)
本專案的 React / Vite 前端已經準備好讀取環境變數。
1. 登入 [Vercel](https://vercel.com/)，點擊 **Add New Project**，並匯入你的 GitHub 專案。
2. 設定 **Root Directory** 為 `frontend`。
3. 在 Environment Variables 區塊，增加一個變數：
   - Name: `VITE_API_URL`
   - Value: `你在 Render 拿到的後端網址`
4. 點擊 **Deploy**，不用幾分鐘你的前端就會上線，任何人只需開啟該網址即可無縫使用完整的 AI 系統。

---

## 💡 注意事項
* 每次要運行後端，都必須進入 `backend` 目錄並確認虛擬環境已經 `source .venv/bin/activate` 啟動。
* 預設情況下，前端將向 `http://localhost:8000` 或後端配置之 API 埠號發送請求，若有更改埠號請檢查全域網址設定。
