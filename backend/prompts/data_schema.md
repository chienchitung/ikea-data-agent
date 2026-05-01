# Data Schema Reference

## Google Sheet 欄位對照表

工作表的實際英文欄位名如下。使用者提問時可能使用中文，請對照後在 `query_description` 中寫入正確欄位名稱或中文別名（工具內部會自動對映）。

| 英文欄位名 | 常見中文說法 |
|-----------|------------|
| Ticket No. | 工單號、工單編號 |
| Creation Date | 建立日期、創建日期 |
| Name | 申請人、姓名 |
| Email | 信箱、電子郵件 |
| Department | 部門、單位、需求部門、申請部門 |
| Subject | 主旨、標題、需求標題 |
| Request Details | 需求內容、需求描述 |
| Status | 狀態、進度 |
| Labels | 標籤、分類 |
| Device | 裝置、設備 |
| Market | 市場、國家 |
| Data Source | 資料來源 |
| Data Support | 資料支援 |
| Start Date | 開始日期 |
| Due Date | 截止日期、期限 |
| Assigned To | 負責人、承辦人 |

## Query Description Rules

- 相對時間必須轉成明確西元年月區間。
- 欄位篩選請使用「{欄位名} 是 {值}」格式。
- 圖表需求請在 `query_description` 保留分析槽位：指標（例如 ticket 數量）、主維度（例如月份/Status/Market）、篩選器（例如 Assigned To）、日期欄位（例如 Creation Date）。
- 「每個月 ticket 數量」的主維度是月份；「可以篩選不同負責人」只是 Assigned To 篩選器，不是主維度。
- 回答工單主旨 `Subject` 時，必須完全依據工具結果，禁止改寫。
