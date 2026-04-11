# 從 LangChain 到 LangGraph：Multi-Agent 架構的演進之路

近年來，隨大型語言模型 (LLM) 能力的躍升，開發者們開始從「讓 LLM 單打獨鬥回答問題」，轉向「打造多個具備專業職能的 AI 智能體（Multi-Agent），讓它們互相協作」。

在這個轉變中，架構的選擇成了最大的痛點。本文將探討為何開發社群正逐漸從原生的 **LangChain (`AgentExecutor`)** 架構，大舉遷移至 **LangGraph** 架構，以及這背後的「進化思路」。

---

## 1. 舊典範：LangChain 的 AgentExecutor (黑盒子思維)

在傳統的 LangChain Multi-Agent 中，開發者通常會使用 `create_tool_calling_agent` 與 `AgentExecutor` 來建立智能體。

### 它的運作邏輯：
這個架構本質上是一個**依賴 LLM 自主判斷的巨型 `While` 迴圈**。
1. 將使用者的問題、對話紀錄、一系列的工具（Tools）通通打包塞給 LLM。
2. 讓 LLM 自己決定「該用什麼工具」或「該輸出最終答案」。
3. Executor 執行工具，把結果餵回給 LLM。
4. 重複步驟 2~3，直到 LLM 決定結束任務 (`AgentFinish`)。

### 遇到了什麼瓶頸？
1. **控制力薄弱 (Black Box)**：開發者只能透過「寫很長的 System Prompt」來祈求 LLM 按照規定的邏輯走（例如：找不到 A 就去查 B）。一旦 LLM 固執己見或是產生幻覺，開發者很難強制介入流程。
2. **缺乏明確的分工與狀態傳遞**：要在 LangChain 原生架構中實作「Agent A 查完資料後，轉交給 Agent B 審核，審核不通過再退回給 Agent A」，寫起來非常勉強且難以維護。
3. **人類無法輕鬆介入 (No Human-in-the-loop)**：迴圈一旦啟動，就無法輕易在「寄出 Email 前」或「刪除檔案前」讓程式暫停，等待人類點擊「同意」再繼續。

---

## 2. 新典範：LangGraph 狀態機 (白盒子思維)

為了解決複雜 Multi-Agent 系統面臨的失控問題，LangChain 團隊推出了 **LangGraph**。  
它的核心思路，就是把「黑箱的無限迴圈」進化為「**有向圖 (Graph)** 與 **狀態機 (State Machine)**」。

### 它的運作邏輯（三大核心）：
1. **State (狀態)**：
   每一次的對話不再只是把 Chat History 傳來傳去。LangGraph 引入了「全域狀態（Global State）」，就像一根接力棒。任何 Agent 都可以讀取這個狀態，並負責把最新的行動結果更新（Appended）到這根接力棒上。
2. **Nodes (節點 - 執行者)**：
   圖上的每一個節點可以是一個具體的 Agent（例如 Data Analyst）、一個具體的 Tool（例如 查 Trello），甚至是一段單純的 Python 程式碼。
3. **Edges (邊緣 - 決策路由)**：
   這是 LangGraph 最強大的地方！我們不再只靠 Prompt 來路由，而是可以**寫實體的 Python 條件判斷 (Conditional Edges)** 來決定下一步該走到哪。
   *(例如：寫一條規則 `if 搜尋結果 == 0: return "confluence_agent"`，徹底保障大腦不會隨便亂掰答案。)*

---

## 3. 架構對比總結：這是一種「控制權」的進化

從 LangChain 到 LangGraph，其實是從 **「完全信任大語言模型的黑箱」** 退回了一點點，融合了傳統軟體工程中的 **「狀態流控制（Control Flow）」**。

| 比較維度 | 舊版 LangChain (AgentExecutor) | 新版 LangGraph (StateGraph) |
| :--- | :--- | :--- |
| **流程控制** | **隱式 / 黑箱**<br>高度依賴 System Prompt 讓 LLM 自己決定順序。 | **顯式 / 白箱**<br>以圖論 (Graph) 定義明確的節點與條件路由跳轉。 |
| **記憶傳遞** | 依賴將每一次的對話 Append 到 `chat_history` 之中。 | 依賴結構化的 `State`（甚至可以追蹤特定任務到哪個階段）。 |
| **無限迴圈處理** | 只有簡單的 `max_iterations=10` 來暴力截斷。 | 可精確定義迴圈條件（如：自我糾錯 3 次後停止）。 |
| **人工審核** | 難以暫停。 | 原生支援中斷點 (Breakpoints)，可做到 Human-in-the-loop。 |
| **開發思維** | Prompt Engineering | Software Engineering + Prompt Engineering |

---

## 4. 結語：為什麼 Data Machi 專案要擁抱 LangGraph？

在你的 IKEA Data Agent 專案中，你設計了多個專業的工具（Trello, Confluence, Document, Analyst）以及非常嚴格的「轉派策略 (Cross-Check)」與「查無結果協議 (Empty Result Protocol)」。

如果停留在舊的 `AgentExecutor`，你只能將這些壓力全部塞在 **coordinator_prompt** 裡，祈禱模型夠聰明，不要偷懶。

換上 **LangGraph** (如我們目前重構的 `create_react_agent`) 後，我們打開了一扇大門。雖然我們目前使用了預建構的 `create_react_agent` 幫助我們無縫過渡，但未來如果發生「模型一直學不會轉派」的狀況，我們只需要把 `coordinator.py` 拆解成真正的 LangGraph 節點：讓 Python 去驗證工具的回傳值，只要是空的，直接透過 Edge (程式邏輯) 強制把對話丟給下一個 Agent。

這才是現今企業級 Multi-Agent 開發的主流共識：**不只要有聰明的 AI，更要有確定性的工程流程。**

---

## 5. 常見迷思：Multi-Agent 與 RAG 是一樣的東西嗎？

許多人在打造 AI 應用時，常會把 **RAG (檢索增強生成)** 與 **Multi-Agent (多智能體協作)** 混為一談。雖然兩者都是為了解決 LLM 幻覺（Hallucination）與知識不足的問題，但它們在核心架構與能做的事情上有著決定性的不同。

### RAG (Retrieval-Augmented Generation) - 「帶書考試的好學生」
* **本質**：一種**單向的資訊檢索管道（Data Pipeline）**。
* **運作模式**：接收問題 ➔ 把問題向量化 ➔ 去資料庫（如 FAISS、Pinecone）撈出前 5 篇相關文章 ➔ 把文章和問題一起丟給 LLM ➔ 生成最終答案。
* **特點**：它是一個**有向無環圖 (DAG - Directed Acyclic Graph)**，流程永遠是往前走的，不能回頭。如果撈出來的 5 篇文章根本沒有答案，LLM 也只能瞎掰或是回答不知道。
* **比喻**：就像一個圖書館員，你向他要資料，他去書架找幾本丟給你，然後就結案了。

### Multi-Agent (如 LangGraph) - 「獨立思考的跨部門專案小組」
* **本質**：一種**具備決策能力與輪迴反思的認知架構（Cognitive Architecture）**。
* **運作模式**：Agent 接收問題 ➔ 自行思考（Reasoning）該怎麼辦 ➔ 決定呼叫 `RAG_Tool` 找規範 ➔ 發現 RAG 給的資料不夠 ➔ 決定換個關鍵字再查一次，或是決定去呼叫 `Trello_Tool` 直接問專案負責人 ➔ 統整資料 ➔ 生成最終答案。
* **特點**：不僅限於「讀取（Read）」，它還可以「行動（Action/Write）」，例如更新卡片狀態、發送 Email。系統允許多次「大腦思考 ➔ 行動 ➔ 再思考」的**循環 (Cyclic Processing)**。
* **比喻**：就像一個完整的專案辦公室。Data Machi（協調者）接到任務後，判斷該指派給 Document Agent (做 RAG)、Trello Agent (去看進度) 還是 Analyst Agent (去算報表)，甚至能審視小弟們的回報覺得不夠好，退件要求重做。

> **小結**：**RAG 只是 Agent 手中的一項「工具（Tool）」**。在你的專案中，`search_document_base` 這個函式就是在執行 RAG；而 `coordinator.py` 和其他的 Agents 才是那個擁有「思考如何運用這項工具」大腦的主體。

---

## 6. 參考文獻與技術共識（Reference & Literature）

這套「從單純 Prompt 到 RAG，再進化到 Multi-Agent 工作流」的發展思路，是目前 (2024–2025) 全球 AI 業界與學界的強烈共識。以下列出幾個權威來源供參考：

1. **Andrew Ng (吳恩達) 的 Agentic Workflows 宣言**：
   * **論點**：在 2024 年的多場演講中，吳恩達明確指出「AI 代理工作流將帶來的進展，會比單純升級 LLM 基礎模型還要巨大」。他強調了四大代理模式：反思 (Reflection)、工具使用 (Tool Use)、規劃 (Planning) 與 多智能體協作 (Multi-agent collaboration)。
   * **出處**：[The Batch: AI Agentic Workflows](https://www.deeplearning.ai/the-batch/how-agents-can-improve-llm-performance/)

2. **LangChain 官方架構演進指南 (Cognitive Architectures)**：
   * **論點**：LangChain 創辦人 Harrison Chase 在發表 LangGraph 時的技術核心理念。他指出傳統的 LangChain (Chains & AgentExecutor) 是為了解決早期的問答需求，但面對需要複雜邏輯跳轉 (Branching) 與循環反思 (Cycling) 的企業專案時，必須強制升級為以「狀態機與圖論」為核心的 LangGraph。
   * **出處**：[LangChain Blog: Open Source Cognitive Architectures](https://blog.langchain.dev/open-source-cognitive-architectures/)

3. **研究論文: AutoGen 與多智能體對話模式**：
   * **論點**：由微軟研究院與各大高校共同發布的 AutoGen 論文證明了「將複雜任務拆解給多個具有不同角色的 Agent (例如一個寫程式、一個審查程式)，能顯著降低出錯率並解決 LLM 上限的瓶頸」。
   * **出處**：Wu, Q. et al. (2023). *"AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation"*. arXiv:2308.08155.

4. **研究論文: 反思機制 (Reflexion) 與 ReAct**：
   * **論點**：證明了「賦予模型思考自己錯在哪，並且改變下一次檢索關鍵字（這正是 LangGraph 在做的事情）」遠比「單次丟資料進去 (傳統 RAG)」的成功率高出非常多。
   * **出處**：Yao, S. et al. (2022). *"ReAct: Synergizing Reasoning and Acting in Language Models"*. arXiv:2210.03629.

---

## 7. 展望未來：Multi-Agent 的下一步發展趨勢

當我們把架構穩固在 LangGraph（狀態機與工作流）之後，整個 AI 和 Multi-Agent 社群目前正在往以下幾個「最前沿」的方向發展。這些也是你的 IKEA Data Agent 未來可以考慮升級的藍圖：

### 1. 跨出 API 限制：具身智能與電腦操作 (Computer Use / UI Automation)
* **現狀**：目前的 Agent 只能透過我們寫好的 Python 程式碼 (如 API) 來去操作 Trello 或 Confluence。
* **未來**：隨 Anthropic 推出 `Computer Use` API，未來的 Agent 可以直接「看著螢幕、控制滑鼠與鍵盤」去操作那些沒有 API 或老舊的企業內部 ERP 系統。Agent 不再只是回答問題的「聊天機器人」，而是真正的「虛擬點擊工」。

### 2. 擁有長期記憶與個人化 (Long-term Memory & Personalization)
* **現狀**：現在的 Agent（即便用了 LangGraph）通常只有「短期記憶 (Session State)」，瀏覽器一關、對話結束，它就失憶了。
* **未來**：各大框架正在導入基礎建設級別的「長期記憶夾 (Memories / Checkpointers)」。例如，Data Machi 會記得「Jacky 上週都在查 DY 的合約，今天問『進度』時，高機率是在問 DY 專案」，甚至能自我更新提示詞，達成千人千面的專屬助理體驗。

### 3. 液態與動態生成的團隊 (Swarm Architectures)
* **現狀**：在 LangGraph 中，開發者必須在寫程式時預先定義好有幾個 Agent、誰負責什麼（靜態圖：Trello 節點 ➔ Document 節點）。
* **未來**：如同 OpenAI 不久前開源的 `Swarm` 概念，未來的系統會變成「液態的」。遇到極度複雜的任務時，Coordinator 會**在運行中動態寫出並呼叫（Spawn）新的下屬 Agent** 來幫忙，任務結束後再將它們銷毀。這是一種無固定形狀（Graph-less）的動態協作網路。

### 4. 異構模型群 (Hybrid / Heterogeneous Model Swarms)
* **現狀**：目前整個專案可能都依賴同一個模型（例如 Gemini 2.5 Pro）。
* **未來**：針對不同的 Agent 節點，指派「最適合的」模型。
  * `Coordinator` 使用最大最聰明的模型（如 GPT-4o 或 Claude-3.5-Sonnet）來做決策。
  * `Analyst_Agent` 使用專精爬蟲或數理的小模型。
  * `Document_Agent` 甚至可以直接跑在本地的微型模型（如 Llama-3-8B），不僅可以大幅降低 API 成本，還能提高特定領域的反應速度。

> **總結**：從 AgentExecutor 走向 LangGraph，我們解決了**「控制力與穩定度」**的問題；而未來的發展，則是朝向**「無限延長記憶、打破 API 邊界操作實體軟體、以及動態無人團隊」**的方向邁進，AI 將真正成為數位世界中的數位員工 (Digital Co-workers)。

---

## 8. 2026 最新趨勢解析：Agentic AI 與 Multi-Agent 是一樣的嗎？

在 2026 年的當下，產業溝通經常會聽到 **Agentic AI（具備代理能力的 AI）** 與 **Multi-Agent（多智能體系統）** 這兩個熱門詞彙。許多人會將它們混為一談，但它們在概念與技術層次上其實有著明顯的區別。

### 什麼是 Agentic AI？（代理性 AI / 代理工作流）
**Agentic AI 是一種「系統屬性」或「設計哲學」。**
* 它指的是一個 AI 系統擁有「**自主性 (Autonomy)**」和「**行動力 (Agency)**」。
* 如果一個語言模型不再只是被動地「一問一答」，而是能夠：
  1. 主動理解使用者的模糊目標（規劃 Planning）。
  2. 遇到錯誤時懂得暫停並反思（自我糾錯 Reflection）。
  3. 自動去搜尋外部工具或操作周邊系統（工具使用 Tool Use）。
* 那麼，這個系統就可以被稱為 **Agentic (具備代理性的)**。
* **重點是**：即使是**單一個 LLM**，只要我們在外面幫它包上一層「思考 ➔ 嘗試 ➔ 觀察 ➔ 修正」的迴圈，它也是一個 Agentic AI！

### 什麼是 Multi-Agent？（多智能體系統）
**Multi-Agent 是一種「架構模式」或「實作方法」。**
* 它指的是系統由「**多個獨立的 AI 節點（Agents）**」所組成。每個節點可能有不同的 Prompt、不同的工具權限，甚至底層用不同的 LLM 模型。
* 這些 Agents 透過對話或特定的狀態機（例如 LangGraph）互相傳遞訊息、指派任務、審查彼此的產出。
* **重點是**：它是為了**分工與降噪**而生的架構，專門對付那些「單一個 Agent 無法兼顧」的極度複雜任務。

### 兩者的關係：如何互相作用？
用一張圖來理解：**Multi-Agent 是實現強大 Agentic AI 的其中一條必經之路。**

根據著名 AI 領袖吳恩達 (Andrew Ng) 等人在 2024–2026 年所確立的共識，實現 Agentic Workflows 主要有四大設計模式 (Design Patterns)：
1. **Tool Use**（讓 AI 使用網路或 API，如你的 Confluence 搜尋）。
2. **Reflection**（讓 AI 檢查自己是否寫錯了並重寫）。
3. **Planning**（給 AI 複雜任務後，讓它自己先寫計畫書再逐步執行）。
4. **Multi-Agent Collaboration**（👉 **多智能體協作，也就是你的 IKEA Data Agent 採用的架構**）。

也就是說：**你的專案正在透過「Multi-Agent 架構」來打造出一個強大的「Agentic AI 系統」。**

### 2026 年 Agentic AI 的三大最前沿進展
在 2026 年，單純的聊天或查資料已經不再是 Agentic AI 的終點，產業界正朝向以下三個實體級別的應用突破：

1. **從 API 操作進化到 Agentic RPA (具身電腦操作)**：
   早期的 Agent (如 2024 年) 只能依賴工程師寫好的 API 溝通；到了 2026 年，藉由像 Anthropic 的 Computer Use，Agentic AI 可以直接控制使用者的 Windows/macOS 畫面，像是人類一樣打開瀏覽器、填寫表單、點擊下載。
   *(💡 業界實例：最知名的開源專案如 **OpenClaw**，標榜「真正能做事的 AI」，能直接串接 WhatsApp/Telegram，自動幫你處理信件、訂機票與管理行事曆，是個人級 Agentic AI 的代表作。)*

2. **終端機與程式碼級的自主數位員工 (CLI Agents)**：
   我們正在從「AI 給建議，人類打字」的 Copilot 時代，跨入「AI 自行承攬專案、直接改 Code」的 Autonomous Worker 時代。
   *(💡 業界實例：Anthropic 官方推出的 **Claude Code**。它不只是一個聊天視窗，而是直接活在工程師的 Terminal (終端機) 裡面。它具備極強的 Agentic 能力：懂得自己看整個專案的 Codebase、自己下指令跑測試、自己修改檔案並 Commit。)*

3. **企業級 Agent OS (智能體作業系統)**：
   未來的企業不再需要手動起 uvicorn 或設定 Docker 來養自己的 Agent，而是會出現類似「Agent OS」的平台，開發者只需宣告哪些職能的 Agent 存在，系統會自動處理它們的長期記憶、權限控管、甚至跨企業不同 Agent 的對接與通訊協議。

> **結語**：不論是你的 `coordinator.py`、幫工程師寫扣的 **Claude Code**、還是幫你回訊息的 **OpenClaw**，它們背後的核心哲學都是一致的——賦予 AI「**思考、規劃與行動（行動包含修改檔案、打 API、點擊畫面）**」的能力。而要讓這些行動不失控，**Multi-Agent 工作流（如 LangGraph）** 就是目前最堅實的地基。