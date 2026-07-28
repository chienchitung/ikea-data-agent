# 從 LangChain 到 LangGraph：Multi-Agent 架構的演進之路
*（涵蓋 LangGraph 架構設計、Multi-Agent 常見迷思、以及 2025–2026 AI Engineering 術語體系）*

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

## 4. 2026 官方文件補充：LangGraph 不只是「畫流程圖」

對照 LangGraph 官方文件，目前（2026）它被定位為一個**低階的 Agent Orchestration Runtime**，重點不只是把流程畫成節點與邊，而是讓長時間、可恢復、可觀測的 Agent 工作流可以進入 production。

### 1. LangGraph 與 LangChain 的分工更清楚了
官方目前把幾個層次拆得更明確：
* **LangChain**：偏高階 agent framework，提供模型、工具、agent loop 等抽象。
* **LangGraph**：偏低階 orchestration runtime，專注於 durable execution、streaming、human-in-the-loop、persistence。
* **LangSmith**：負責 tracing、evaluation、debugging、deployment/observability。

因此，LangGraph 不一定只用於 Multi-Agent；它也適合任何「長時間、具狀態、需要可恢復」的單一 Agent 或 workflow。反過來說，如果只是少數工具與簡單問答，單一 agent 加上良好的 prompt / middleware 可能已經足夠，不必過早拆成多 Agent。

### 2. Persistence / Checkpoint 是 production 關鍵
LangGraph 的 persistence layer 會在每一步 graph execution 儲存 state checkpoint，並用 `thread_id` 管理同一條對話或工作流。這讓系統可以做到：
* **多輪對話記憶**：同一個 `thread_id` 可以接續前文。
* **Human-in-the-loop**：流程暫停後，人類可以檢查 state，再恢復。
* **Time travel debugging**：回看或重播過去某個 graph step。
* **Fault tolerance**：某個 node 失敗時，可從上一個成功 checkpoint 恢復，而不是整段重跑。

本機 demo 可以用 in-memory checkpointer；正式環境建議使用 database-backed checkpointer，例如 Postgres。

### 3. Human-in-the-loop 已從「按鈕」進化成 interrupt/resume
新的文件更強調 `interrupt()` 與 `Command(resume=...)` 這種模式：  
當 node 裡呼叫 `interrupt()`，LangGraph 會保存目前 state，將一段 JSON-serializable payload 回傳給外部 UI；等人類批准、修改或補資料後，再用 `Command(resume=...)` 恢復同一條 thread。

這和單純在畫面最後放一個「Approve」按鈕不同。真正可靠的 human-in-the-loop 應該放在高風險工具之前，例如：
* 寄信、刪除資料、修改 Trello/Confluence 前。
* 查詢成本很高、會觸發大量 API call 前。
* Agent 需要人類補充缺失條件時。

### 4. Memory 要分成短期與長期
官方文件把 memory 拆成兩種：
* **Short-term memory**：存在 thread state / checkpoint 裡，用於同一段對話的上下文。
* **Long-term memory**：存在跨 session 的 store，用於使用者偏好、專案背景、長期事實。

Data Machi 目前已經有自己的 `conversation_store` 與 memory summary，這是正確方向；若未來要更靠近 LangGraph 原生能力，可以考慮把這層遷移到 LangGraph checkpointer / store，讓 resume、debug、HITL 更一致。

### 5. Multi-Agent 的設計要避免「為拆而拆」
LangChain / LangGraph 官方多 Agent 指南也提醒：不是每個複雜任務都需要 Multi-Agent。拆分的主要理由通常是：
* 工具太多，單一 agent 容易選錯工具。
* 上下文太大，需要隔離不同 domain 的資訊。
* 任務需要明確的階段、交接、審核。
* 不同子任務需要不同權限、模型或 prompt。

如果只是同一個 domain 裡的幾個工具，單一 agent + 明確 router / middleware 可能更穩。這點對 Data Machi 很重要：Trello、Confluence、Document、Analyst 是合理分工；但在每個 domain 內部，不一定要再繼續細拆成更多 agents。

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

## 6. 名詞釐清：Agentic AI 與 Multi-Agent 是一樣的嗎？（2026 觀點）

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
用一張圖來理解：**Multi-Agent 是實現強大 Agentic AI 的重要路徑之一，但不是唯一道路。**

根據著名 AI 領袖吳恩達 (Andrew Ng) 等人在 2024–2026 年所確立的共識，實現 Agentic Workflows 主要有四大設計模式 (Design Patterns)：
1. **Tool Use**（讓 AI 使用網路或 API，如你的 Confluence 搜尋）。
2. **Reflection**（讓 AI 檢查自己是否寫錯了並重寫）。
3. **Planning**（給 AI 複雜任務後，讓它自己先寫計畫書再逐步執行）。
4. **Multi-Agent Collaboration**（👉 **多智能體協作，也就是你的 IKEA Data Agent 採用的架構**）。

也就是說：**你的專案正在透過「Multi-Agent 架構」來打造出一個強大的「Agentic AI 系統」。**

---

## 7. Prompt、Context、Loop、Graph、Harness Engineering：五個詞彙的來源與對照

2025–2026 開始，業界冒出一連串「XX Engineering」新詞。這一節想回答一個實際的問題：**Data Machi 現在做的事，算不算 Graph Engineering？** 答案分兩層：技術能力上的演進是真的，但「乾淨的五層架構」是編輯性的簡化，不是業界定論。下面先給一張整合表，再分三段分別討論「這是演進還是造詞」「Harness Engineering 的真正源頭」「對照這個專案」。

### 五個詞彙一次看

| 詞彙 | 關注的問題 | 提出者與時間 | 對應到 Data Machi |
| :--- | :--- | :--- | :--- |
| **Prompt Engineering** | 這一句話該怎麼寫，模型才聽得懂？ | 概念可溯源至 2018 Salesforce 的 McCann et al. 論文；詞彙普遍歸功於 Gwern Branwen（另有 Karpathy／Richard Socher 的說法），~2020，眾說紛紜、無單一可引用來源 | 各 Agent 的 System Prompt（`backend/prompts/*.md`） |
| **Context Engineering** | 這一次呼叫，模型「看得到」什麼？ | Tobi Lütke（2025/6/19）提出偏好，Andrej Karpathy（2025/6/25）給出被廣泛引用的定義並帶起討論 | `messages` 組裝、`turn_context`、meeting context 字數上限控制 |
| **Loop Engineering** | 讓 AI 自主跑「觀察→執行→檢查→重試」到達成目標為止 | 據二手報導：Peter Steinberger、Boris Cherny（2026/6）先後發言，Addy Osmani 整理成詞彙；原始貼文連結未查證 | `should_continue` 條件邊構成的重試迴圈 |
| **Graph Engineering** | 任務太複雜時，把多個 Agent／Loop 組織成一張有向圖 | 詞彙 ~2026/7 由 Steinberger 引爆討論（連結未查證）；LangChain 官方部落格把詞彙套用回 2024/1 就有的 LangGraph 實作 | `coordinator.py` 的 `StateGraph`（`agent`／`action` 節點 + 條件路由） |
| **Harness Engineering** | 幫模型搭建防護欄、驗證與監控環境，讓長時間自主任務不失控 | Mitchell Hashimoto（2026/2/5）提出，OpenAI 的 Lopopolo（2026/2/11）正式化，Fowler／Böckeler（~2026/4）給出目前最嚴謹的框架 | 見下方「對照 Data Machi」——這層對不太上，不要照單全收 |

> 完整引用見第 10 節第 19、22–25 項；Loop／Graph 的原始貼文因查無可直接引用的連結，只在表中註明來源人名，不列入正式參考文獻。

### 這是演進，還是社群造詞？

不必照單全收業界的行銷詞彙。台灣開發者社群（iThome 鐵人賽）有一篇文章把這個問題當標題，給了一個具體的判準：

> Graph Engineering 有沒有被官方收編——LangChain、Anthropic、OpenAI 任何一家發出「定義性文章」，這個詞就從一句反問升級成候選實踐；一直沒有，它多半會像大多數社群造詞一樣退場。

三個重點分開看：

1. **判準套用結果**：以 Graph Engineering 來說，這個判準已經被跨過——LangChain 官方部落格直接發過《3 Years of Graph Engineering with LangGraph》，用這個詞描述自己三年來的實踐（目前每月下載量超過 6500 萬次），只是「圖編排」這個做法本身不是 2026 年才發明的，LangGraph 從 2024/1 就長這樣。
2. **文章的結論**：這些詞不是「一代淘汰上一代」，而是工程的關注點持續向上遷移——從「控制模型輸出」走向「組織智能協作」，反映的是能力真實上升，不是純粹的造詞遊戲。
3. **Loop 跟 Graph 的關係**：套用軟體工程師 David Khourshid 的說法，「Loop 只是一種有向、循環的 Graph」（a loop is just a directed, cyclic graph）——Loop 是 Graph 的簡化特例，Graph 則是把好幾個 Loop 連接成一個有平行分支、共享狀態的完整系統，這也是上表把兩者相鄰排列而不是當成對立概念的原因。

### Harness Engineering 的真正源頭：不是 Anthropic

這一層特別容易被誤傳源頭，值得單獨講清楚。實際順序是 **Hashimoto 提出概念 → OpenAI 正式化 → Anthropic 用案例示範 → Fowler／Böckeler 給出目前最嚴謹的框架**：

* **Hashimoto 的原始定義**（2026/2/5）很直白：「每次發現 Agent 犯錯，就把解法工程化到環境裡，讓那個錯誤結構性地不可能再發生」。
* **Fowler／Böckeler 的「Guides and Sensors」框架**（目前最嚴謹的版本）：**Guides**（事前引導，例如 AGENTS.md、code mods、skills）在 Agent 行動「之前」導正方向；**Sensors**（事後偵測，例如 linter、結構化測試、AI code review）在「之後」抓出問題、回饋修正，並進一步分成 computational controls（確定性工具）與 inferential controls（LLM 語意判斷）。
* **Anthropic 的案例**（2026/3/24，詞彙已存在一個半月後發表）：用 Planner/Generator/Evaluator 三代理人架構（靈感來自 GAN）示範怎麼做得更精細——Evaluator 依設計品質、原創性、工藝、功能性四項標準打分，一輪批評迴圈跑 5–15 次，搭配 Initializer agent、context reset、progress log 讓長任務跨 session 保持連貫，現已內建成 Claude Code 的 `/goal` 指令。

### 對照 Data Machi：老實說，不是每一層都對得上

**Prompt、Context、Loop、Graph 這四層，直接對到具體程式碼，沒什麼好爭議的**（見上表）。但 **Harness 這一層對不太上**，不必硬凹成「五層都做到了」：

* 「回答查核」是單次驗證，不是 Anthropic 那種跑 5–15 輪的 Generator/Evaluator 迭代迴圈，也沒有 linter、測試這類 Sensor。
* `emit_progress` 是單向回報給使用者看，不會回饋去修正 Agent 行為，嚴格說也不算 Sensor。
* 系統提示詞（`hard_constraints.md` 等）勉強算 Guide，但這其實跟第一層 Prompt Engineering 高度重疊——Harness 框架裡的「Guides」半邊，某種程度上就是換個名字重講一次 Prompt Engineering，不是真正獨立的新東西。

比較誠實的講法是：這個專案穩穩踩了四層，第五層目前沒有做，也不需要為了湊滿五層而勉強宣稱有。

---

## 8. 展望未來：Multi-Agent 與 Agentic AI 的下一步發展趨勢

當我們把架構穩固在 LangGraph（狀態機與工作流）之後，整個 AI 和 Multi-Agent 社群目前正在往以下幾個「最前沿」的方向發展。這些也是你的 IKEA Data Agent 未來可以考慮升級的藍圖：

### 1. 跨出 API 限制：具身智能與電腦操作 (Computer Use / Agentic RPA)
* **現狀**：目前的 Agent 只能透過我們寫好的 Python 程式碼 (如 API) 來去操作 Trello 或 Confluence。
* **未來**：隨 Anthropic 推出 `Computer Use` API，Agent 可以直接「看著螢幕、控制滑鼠與鍵盤」去操作那些沒有 API 或老舊的企業內部 ERP 系統，像人類一樣打開瀏覽器、填寫表單、點擊下載。Agent 不再只是回答問題的「聊天機器人」，而是真正的「虛擬點擊工」。
  *(💡 業界案例：例如 OpenClaw 這類自架式個人 Agent 平台，主打把 Agent 接到 WhatsApp/Telegram/Discord 等日常入口。不過此類工具因為可能操作本機檔案、帳號、訊息與外部服務，企業使用前必須先評估安全邊界、權限隔離與審核機制。)*

### 2. 擁有長期記憶與個人化 (Long-term Memory & Personalization)
* **現狀**：現在的 Agent（即便用了 LangGraph）通常只有「短期記憶 (Session State)」，瀏覽器一關、對話結束，它就失憶了。
* **未來**：各大框架正在導入基礎建設級別的「長期記憶夾 (Memories / Checkpointers)」。例如，Data Machi 會記得「Jacky 上週都在查 DY 的合約，今天問『進度』時，高機率是在問 DY 專案」，甚至能自我更新提示詞，達成千人千面的專屬助理體驗。

### 3. 液態與動態生成的團隊 (Swarm Architectures)
* **現狀**：在 LangGraph 中，開發者必須在寫程式時預先定義好有幾個 Agent、誰負責什麼（靜態圖：Trello 節點 ➔ Document 節點）。
* **未來**：如同 OpenAI 曾開源的 `Swarm` 教學型概念（現已由正式的 OpenAI Agents SDK 接手），未來的系統會變成「液態的」。遇到極度複雜的任務時，Coordinator 可能會**在運行中動態建立並呼叫新的下屬 Agent** 來幫忙，任務結束後再將它們銷毀。正式企業系統仍需要權限控管、觀測性、審核點與持久化狀態，不能只靠教育型原型。

### 4. 異構模型群 (Hybrid / Heterogeneous Model Swarms)
* **現狀**：目前整個專案可能都依賴同一個模型（例如 Gemini）。
* **未來**：針對不同的 Agent 節點，指派「最適合的」模型。
  * `Coordinator` 使用能力較強、推理與工具選擇更穩定的模型來做決策。
  * `Analyst_Agent` 使用專精爬蟲或數理的小模型。
  * `Document_Agent` 甚至可以直接跑在本地的微型模型，不僅可以大幅降低 API 成本，還能提高特定領域的反應速度。

### 5. 終端機與程式碼級的自主數位員工 (CLI Agents)
我們正在從「AI 給建議，人類打字」的 Copilot 時代，跨入「AI 自行承攬專案、直接改 Code」的 Autonomous Worker 時代。
*(💡 業界實例：Claude Code、Codex CLI 等 coding agents。它們不只是一個聊天視窗，而是直接活在工程師的 Terminal / IDE / repo 裡面，能讀 codebase、下指令跑測試、修改檔案，並在人工審核後交付 patch 或 commit。)*

### 6. 企業級 Agent OS (智能體作業系統)
未來的企業不再需要手動起 uvicorn 或設定 Docker 來養自己的 Agent，而是會出現類似「Agent OS」的平台，開發者只需宣告哪些職能的 Agent 存在，系統會自動處理它們的長期記憶、權限控管、甚至跨企業不同 Agent 的對接與通訊協議（見第 10 節參考文獻第 13、16 項的 MCP／A2A 這類開放標準）。

### 7. 別忘了潑一盆冷水：不是每個專案都該急著上馬
Gartner 預測到 2027 年底前，超過 40% 的 agentic AI 專案會被取消，主因是成本失控、商業價值不明確、風險控管不足；報告也點出「**agent washing**」現象——許多廠商把既有的 AI 助理、RPA、聊天機器人重新包裝成「agentic」。這份數據跟第 4 節「避免為拆而拆」的提醒互相呼應：技術方向正確，不代表每個功能都該急著做成 Agent。

> **總結**：從 AgentExecutor 走向 LangGraph，我們解決了 **「控制力與穩定度」** 的問題；而未來的發展，則是朝向 **「無限延長記憶、打破 API 邊界操作實體軟體、以及動態無人團隊」** 的方向邁進——但同時也要對「agent washing」保持警覺，AI 要真正成為數位世界中的數位員工 (Digital Co-workers)，靠的是紮實的工程，不是換個名詞。

---

## 9. 結語：為什麼 Data Machi 專案要擁抱 LangGraph？

在你的 IKEA Data Agent 專案中，你設計了多個專業的工具（Trello, Confluence, Document, Analyst）以及非常嚴格的「轉派策略 (Cross-Check)」與「查無結果協議 (Empty Result Protocol)」。

如果停留在舊的 `AgentExecutor`，你只能將這些壓力全部塞在 **coordinator_prompt** 裡，祈禱模型夠聰明，不要偷懶。

換上 **LangGraph** 後，我們打開了一扇大門——而 `coordinator.py` 目前已經不再是預建構的 `create_react_agent`，而是拆解成真正的 `StateGraph` 節點：

```python
workflow = StateGraph(AgentState)
workflow.add_node("agent", agent_node)      # LLM 決策：選工具或給答案
workflow.add_node("action", parallel_tool_node)  # 執行工具（平行、非阻塞）

workflow.add_edge(START, "agent")
workflow.add_conditional_edges("agent", should_continue)
workflow.add_edge("action", "agent")
```

`should_continue` 這條 Edge 就是第 1 節提到「LLM 固執己見、開發者難以強制介入」問題的具體解法：如果 LLM 呼叫了工具，路由到 `action` 執行；如果 LLM 只輸出了規劃文字、卻沒有真的呼叫工具（`_is_interim_response`），Python 會強制把對話送回 `agent` 重試，最多重試 `_MAX_INTERIM_RETRIES` 次，而不是任由模型用文字敷衍過關。這是程式邏輯（Edge）在把關，不是靠 Prompt 祈禱模型自律。

這才是現今企業級 Multi-Agent 開發的主流共識：**不只要有聰明的 AI，更要有確定性的工程流程。**

---

## 10. 參考文獻與技術共識（Reference & Literature）

這套「從單純 Prompt 到 RAG，再進化到 Multi-Agent 工作流，乃至 Graph／Harness Engineering」的發展思路，是目前 (2024–2026) 全球 AI 業界與學界的強烈共識。以下列出幾個權威來源供參考：

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

5. **LangGraph 官方文件: Overview**：
   * **論點**：LangGraph 是低階 orchestration framework / runtime，核心能力包含 durable execution、streaming、human-in-the-loop、memory、debugging 與 production deployment；也可不依賴 LangChain 單獨使用。
   * **出處**：[LangGraph Overview](https://docs.langchain.com/oss/python/langgraph/overview)

6. **LangGraph 官方文件: Persistence / Checkpointing**：
   * **論點**：LangGraph 透過 checkpointer 在每一步保存 graph state，支援 threads、conversation memory、time travel debugging、fault tolerance 與 human-in-the-loop。正式環境建議使用資料庫型 checkpointer。
   * **出處**：[LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

7. **LangGraph 官方文件: Interrupts / Human-in-the-loop**：
   * **論點**：`interrupt()` 可在 node 內動態暫停工作流，並透過 `Command(resume=...)` 恢復；這比單純在 UI 結尾放 Approve 按鈕更適合高風險工具與長時間流程。
   * **出處**：[LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

8. **LangGraph 官方文件: Memory**：
   * **論點**：LangGraph memory 分為 thread-level short-term memory 與跨 session 的 long-term memory/store，分別服務於多輪對話上下文與長期個人化。
   * **出處**：[LangGraph Memory](https://docs.langchain.com/oss/python/langgraph/add-memory)

9. **LangChain 官方文件: Multi-agent Patterns**：
   * **論點**：Multi-agent 系統適合工具過多、上下文需要隔離、任務需分工或審核的情境；但官方也提醒不是每個複雜任務都需要 Multi-Agent，單一 agent 加上合適工具與狀態邏輯有時更簡單穩定。
   * **出處**：[LangChain Multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent)

10. **OpenAI Swarm GitHub**：
    * **論點**：Swarm 是用於探索輕量 multi-agent orchestration 的教育型框架，適合理解 agents / handoffs 概念，但不應直接當成 production-ready 架構。
    * **出處**：[OpenAI Swarm](https://github.com/openai/swarm)

11. **Anthropic: Introducing Computer Use**：
    * **論點**：Anthropic 官方發表，讓 Claude 具備直接讀取螢幕截圖、控制滑鼠與鍵盤操作電腦介面的能力，是第 8 節「跨出 API 限制、具身電腦操作」討論的官方出處。目前仍是 beta 功能，正式導入前需評估權限隔離與審核機制。
    * **出處**：[Introducing computer use, a new Claude 3.5 Sonnet, and Claude 3.5 Haiku](https://www.anthropic.com/news/3-5-models-and-computer-use)、[Computer use tool（技術文件）](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

12. **Claude Code（Anthropic 官方 CLI Coding Agent）**：
    * **論點**：第 8 節提到「活在 Terminal / IDE / repo 裡的 coding agent」的具體案例，能讀取 codebase、執行指令、修改檔案，並在人工審核後交付 commit——本文件本身也是在這樣的環境中被建立與維護的。
    * **出處**：[anthropics/claude-code (GitHub)](https://github.com/anthropics/claude-code)

13. **Anthropic: Model Context Protocol (MCP)**（2024 年 11 月發表，2025–2026 快速成為業界標準）：
    * **論點**：MCP 是「Agent 如何連接外部工具與資料源」的開放標準，解決了本文一直在談的問題——每接一個新工具（Trello、Confluence、Google Sheets…）都要客製一次整合的困境。2025 年起 OpenAI、Google DeepMind 等相繼採用；2025/12/9 更進一步由 **Anthropic（捐出 MCP）、OpenAI（捐出 AGENTS.md，見第 17 項）、Block（捐出 Goose 框架）** 三方共同發起，正式成立 Linux Foundation 旗下的 Agentic AI Foundation（AAIF），白金會員還包含 AWS、Google、Microsoft、Bloomberg、Cloudflare，成為廠商中立的開放標準——不是單一家公司「捐贈」而已，而是主要廠商聯合治理。對 Data Machi 而言，這代表 Trello/Confluence/Analyst 這幾支工具，長期有機會統一改走 MCP 而不是各自客製的 API 整合。
    * **出處**：[Introducing the Model Context Protocol](https://www.anthropic.com/news/model-context-protocol)、[Linux Foundation Announces the Formation of the Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)

14. **Anthropic: Building Effective Agents**（2024 年 12 月發表，持續是 2025–2026 agent 設計模式領域被引用最多的文章之一）：
    * **論點**：Anthropic 匯整與數十個團隊合作打造 LLM Agent 的實務經驗，明確區分「Workflow（預先寫死的程式路徑）」與「Agent（LLM 動態決定下一步）」，並提醒：多數成功案例用的是簡單、可組合的模式，而不是複雜框架。這正好呼應第 4 節第 5 點「避免為拆而拆」——不是每個任務都需要真正的 Multi-Agent。
    * **出處**：[Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)

15. **OpenAI Agents SDK**（2025 年 3 月發表，取代第 10 項的 Swarm 成為正式 production 框架）：
    * **論點**：延續 Swarm 的核心概念（Agents、Handoffs），但補上 Guardrails、Tracing、Session 管理等 production 必要功能；Swarm repo 目前已停止更新並在文件中直接導向 Agents SDK。可視為「教育型原型 → 正式框架」的具體後續發展，讓第 10 項的 Swarm 討論不再停留在 2024 年的原型階段。
    * **出處**：[openai/openai-agents-python (GitHub)](https://github.com/openai/openai-agents-python)

16. **Google: Agent2Agent Protocol (A2A)**（2025 年 4 月發表，2025 年 6 月捐贈給 Linux Foundation）：
    * **論點**：如果說 MCP 解決的是「Agent 如何連接工具」，A2A 解決的是「不同廠商打造的 Agent 之間如何互相溝通、委派任務」——兩者是互補而非競爭關係。已有 Salesforce、SAP、ServiceNow 等 150 多個組織採用，是 Multi-Agent 系統走向「跨廠商協作」的下一步基礎建設。
    * **出處**：[Announcing the Agent2Agent Protocol (A2A)](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)

17. **AGENTS.md**（開放格式，2025 年由 OpenAI 發起，已有 6 萬多個開源專案採用）：
    * **論點**：一份給 AI coding agent 看的「README」——用固定格式在專案根目錄說明架構、慣例、測試指令、注意事項，讓 Claude Code、OpenAI Codex、Cursor 等不同廠商的 coding agent 都能讀懂同一份專案上下文，不用每個工具各寫一份客製設定。是第 8 節「CLI Coding Agent」討論的具體配套標準，也是 AAIF（第 13 項）成立時 OpenAI 捐出的專案之一。
    * **出處**：[agents.md（官方網站與規格）](https://agents.md/)

18. **Gartner: 超過 40% 的 Agentic AI 專案將於 2027 年底前被取消**（2025/6/25 發布，持續是 2026 年業界討論的重要提醒）：
    * **論點**：Gartner 預測，多數目前的 agentic AI 專案仍停留在早期實驗或概念驗證階段，成本失控、商業價值不明確、風險控管不足是主要取消原因；報告也點出「**agent washing**」現象——許多廠商把既有的 AI 助理、RPA、聊天機器人重新包裝成「agentic」，Gartner 估計數千家宣稱做 agentic AI 的廠商中，只有約 130 家是真正名符其實的。同一份報告也預測到 2028 年，33% 的企業軟體會內建 agentic AI（2024 年不到 1%），日常工作決策有 15% 會由 agentic AI 自主完成（2024 年為 0%）。這份數據是本文第 4 節「避免為拆而拆」與第 8 節樂觀展望之間很好的平衡提醒：技術方向正確，不代表每個專案都該急著上馬。
    * **出處**：[Gartner Predicts Over 40% of Agentic AI Projects Will Be Canceled by End of 2027](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)

19. **LangChain: 3 Years of Graph Engineering with LangGraph**（2026 年發表）：
    * **論點**：LangChain 官方部落格直接用「Graph Engineering」一詞描述 LangGraph 三年來的實踐，也是第 7 節「演進還是造詞」判準（是否有官方定義性文章）被跨過的直接證據。文中也提到「Loop 只是一種有向、循環的 Graph」（a loop is just a directed, cyclic graph）——呼應第 7 節把 Loop 視為 Graph 的簡化特例，而不是對立概念。
    * **出處**：[3 Years of Graph Engineering with LangGraph](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph)

20. **Anthropic: Harness design for long-running application development**（2026/3/24 發表）：
    * **論點**：第 7 節「Harness Engineering 的真正源頭」小節引用的實作案例，示範用 Planner/Generator/Evaluator 三代理人架構（靈感來自 GAN）搭配 Initializer agent、context reset、progress log，讓 Claude 能自主完成長達數小時的軟體開發任務而不跑偏，並已內建成 Claude Code 的 `/goal` 指令。**注意**：這篇不是「Harness Engineering」一詞的源頭，發表時間點在 Hashimoto（第 23 項）與 OpenAI（第 24 項）之後一個半月，見第 7 節的更正說明。
    * **出處**：[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)

21. **iThome 鐵人賽：從 Prompt Engineering 到 Graph Engineering，Harness/Loop Engineering 是演進還是造詞？**（中文社群觀點，2026）：
    * **論點**：本文第 7 節「這是演進，還是社群造詞？」的判準主要參考來源，提出「這些詞不是世代淘汰，而是一層包一層，工程關注點持續向上遷移」的結論。（原文網頁對自動化工具擋下直接讀取，本文引用內容為透過搜尋引擎索引摘要交叉比對而來，非逐字轉載，建議讀者直接參閱原文確認細節。）
    * **出處**：[從 Prompt Engineering 到 Graph Engineering：Harness Engineering、Loop Engineering 是演進還是造詞？](https://ithelp.ithome.com.tw/articles/10397462)

22. **Andrej Karpathy / Tobi Lütke：Context Engineering 的起點**：
    * **論點**：Shopify CEO Tobi Lütke 在 X 上表達偏好「context engineering」勝過「prompt engineering」，六天後 Andrej Karpathy 跟進並給出被廣泛引用的定義：「filling the context window with just the right information for the next step」。是第 7 節表格裡 Context Engineering 一列的直接來源。
    * **出處**：[Andrej Karpathy on X (2025/6/25)](https://x.com/karpathy/status/1937902205765607626)

23. **Mitchell Hashimoto: My AI Adoption Journey**（2026/2/5 發表）：
    * **論點**：目前查證到「Harness Engineering」概念最早的公開文字紀錄。Hashimoto（HashiCorp 共同創辦人、Terraform／Vagrant 作者）提出的定義很直白：「每次發現 Agent 犯錯，就把解法工程化到環境裡，讓那個錯誤結構性地不可能再發生」。是第 7 節「Harness Engineering 的真正源頭」更正說明的直接依據。
    * **出處**：[My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey)

24. **OpenAI: Harness engineering — leveraging Codex in an agent-first world**（2026/2/11 發表）：
    * **論點**：Ryan Lopopolo 發表，把 Hashimoto 六天前才提出的概念正式寫成官方文章，記錄 OpenAI 團隊如何用「零人工手寫程式碼」在五個月內、超過 1,500 個 PR 全部由 Codex 撰寫／審查／合併，產出約百萬行程式碼，核心標語是「Humans steer. Agents execute.」。是把 Harness Engineering 從個人部落格「制度化」的關鍵一步。
    * **出處**：[Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)

25. **Martin Fowler（Birgitta Böckeler）: Harness engineering for coding agent users**（2026 年發表）：
    * **論點**：目前針對 Harness Engineering 最嚴謹的具體框架，提出「Guides and Sensors」的分類：Guides 是行動前的引導（如 AGENTS.md、code mods、skills），Sensors 是事後偵測並回饋修正（如 linter、結構化測試、AI code review），並進一步分成 computational controls（確定性工具）與 inferential controls（LLM 語意判斷）。是第 7 節指出 Data Machi「Harness 這層對不太上」的判斷依據。
    * **出處**：[Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)
    * **出處**：[從 Prompt Engineering 到 Graph Engineering：Harness Engineering、Loop Engineering 是演進還是造詞？](https://ithelp.ithome.com.tw/articles/10397462)
