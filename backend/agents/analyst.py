import os
import re
import gspread
import pandas as pd
from oauth2client.service_account import ServiceAccountCredentials
from langchain.tools import tool
from dotenv import load_dotenv
import glob

load_dotenv()

# 全局變量來緩存工作表數據
_cached_data = {}

# Hardcoded sheet key from notebook
SPREADSHEET_KEY = os.getenv("GOOGLE_SHEET_KEY", "1bnqghULmnxgZdu4ALDZ2FGUzBxwamD27qYZVGMq1uEo")

def get_gspread_client():
    """
    建立 gspread 客戶端連線
    每次呼叫時都重新初始化（與 notebook 行為一致）
    """
    # Look for json keyfile
    keyfiles = glob.glob("*.json") + glob.glob("backend/*.json")
    # Filter out package*.json
    keyfiles = [f for f in keyfiles if "package" not in f and "lock" not in f]

    if not keyfiles:
        raise FileNotFoundError("找不到 Google Service Account JSON 金鑰檔案")

    json_keyfile = keyfiles[0]

    scope = ['https://spreadsheets.google.com/feeds',
             'https://www.googleapis.com/auth/drive']
    creds = ServiceAccountCredentials.from_json_keyfile_name(json_keyfile, scope)
    gc = gspread.authorize(creds)
    return gc


def get_all_records_safe(worksheet) -> list:
    """
    使用 get_all_values() 取代 get_all_records()，
    避免 gspread 遇到空白列就停止讀取的已知問題。
    """
    values = worksheet.get_all_values()
    if not values or len(values) < 2:
        return []
    headers = values[0]
    records = []
    for row in values[1:]:
        # 補齊欄位長度（有些列可能比 header 短）
        padded = row + [''] * (len(headers) - len(row))
        # 跳過整列都是空白的資料列
        if not any(str(v).strip() for v in padded):
            continue
        records.append(dict(zip(headers, padded)))
    return records

# 嘗試預先檢查憑證是否存在 (for logs)
try:
    _keyfiles = glob.glob("*.json") + glob.glob("backend/*.json")
    _keyfiles = [f for f in _keyfiles if "package" not in f and "lock" not in f]
    if _keyfiles:
        print(f"\n✅ Analyst 憑證已找到: {_keyfiles[0]}")
        print(f"   Spreadsheet Key: {SPREADSHEET_KEY}")
    else:
        print("Warning: Analyst Agent JSON keyfile not found.")
except Exception:
    pass

@tool
def list_worksheets() -> str:
    """
    列出 Google Sheet 中所有可用的工作表名稱。
    當用戶想知道有哪些工作表可以查詢時使用此工具。
    """
    try:
        gc = get_gspread_client()
        spreadsheet = gc.open_by_key(SPREADSHEET_KEY)
        worksheet_titles = [ws.title for ws in spreadsheet.worksheets()]
        return f"此 Google Sheet 中可用的工作表有：{', '.join(worksheet_titles)}"
    except Exception as e:
        return f"列出工作表時發生錯誤: {str(e)}"

@tool
def get_worksheet_structure(worksheet_name: str) -> str:
    """
    獲取指定工作表的結構信息，包括欄位名稱、資料行數等基本信息。
    當用戶想了解工作表的架構或有哪些欄位時使用此工具。
    
    參數:
    - worksheet_name: 工作表的名稱
    """
    try:
        gc = get_gspread_client()
        spreadsheet = gc.open_by_key(SPREADSHEET_KEY)
        worksheet = spreadsheet.worksheet(worksheet_name)
        
        all_records = get_all_records_safe(worksheet)
        _cached_data[worksheet_name] = all_records  # 緩存數據
        
        if not all_records:
            return f"工作表 '{worksheet_name}' 是空的，沒有資料。"
        
        # 獲取欄位名稱
        columns = list(all_records[0].keys())
        row_count = len(all_records)
        
        # 顯示每個欄位的一些統計信息
        result = f"工作表 '{worksheet_name}' 的結構信息：\n"
        result += f"- 總資料行數: {row_count}\n"
        result += f"- 欄位列表 ({len(columns)} 個): {', '.join(columns)}\n"
        result += f"\n前 3 筆資料範例：\n"
        
        for i, record in enumerate(all_records[:3], 1):
            result += f"\n第 {i} 筆:\n"
            for key, value in record.items():
                result += f"  - {key}: {value}\n"
        
        return result
    except gspread.exceptions.WorksheetNotFound:
        return f"找不到名為 '{worksheet_name}' 的工作表。請使用 list_worksheets 工具查看可用的工作表。"
    except Exception as e:
        return f"讀取工作表結構時發生錯誤: {str(e)}"

def _drop_empty_columns(df: pd.DataFrame) -> pd.DataFrame:
    """移除完全空白或全為空字串的欄位"""
    return df.loc[:, df.apply(lambda col: col.replace('', pd.NA).notna().any())]


def _detect_date_columns(df: pd.DataFrame) -> list:
    """針對已知的 Google Sheet 欄位，強制將日期欄位轉換為 datetime"""
    # 已知日期欄位：Start Date, Due Date
    date_cols = ['Start Date', 'Due Date']
    existing_cols = [col for col in date_cols if col in df.columns]
    for col in existing_cols:
        df[col] = pd.to_datetime(df[col], errors='coerce', format='mixed')
    return existing_cols


def _extract_date_range(query: str):
    """從查詢字串中嘗試解析日期區間，回傳 (start, end) 或 (None, None)"""
    # 支援各種常見日期格式：
    patterns = [
        # 格式 A: YYYY-MM 到 YYYY-MM (有包含兩次年份)
        r'(\d{4})[-/年](\d{1,2})[-/月]?\s*(?:到|~|至|-)\s*(\d{4})[-/年](\d{1,2})',
        # 格式 B: YYYY年MM月 到 MM月 (省略第二個年份)
        r'(\d{4})[-/年](\d{1,2})[-/月]?\s*(?:到|~|至|-)\s*(\d{1,2})[-/月]?',
        # 格式 C: YYYY年MM月 (單一年月)
        r'(\d{4})[-/年](\d{1,2})',
        # 格式 D: YYYY年 (整年)
        r'(20\d{2})\s*年'
    ]
    
    # 判斷 A
    match = re.search(patterns[0], query)
    if match:
        y1, m1, y2, m2 = match.groups()
        start = pd.Timestamp(f"{y1}-{int(m1):02d}-01")
        end = pd.Timestamp(f"{y2}-{int(m2):02d}-01") + pd.offsets.MonthEnd(1)
        return start, end
        
    # 判斷 B (這是 LLM 最常輸出的 "2026年1月到12月")
    match = re.search(patterns[1], query)
    if match:
        y1, m1, m2 = match.groups()
        start = pd.Timestamp(f"{y1}-{int(m1):02d}-01")
        end = pd.Timestamp(f"{y1}-{int(m2):02d}-01") + pd.offsets.MonthEnd(1)
        return start, end

    # 判斷 C
    match = re.search(patterns[2], query)
    if match:
        y, m = match.groups()
        start = pd.Timestamp(f"{y}-{int(m):02d}-01")
        end = start + pd.offsets.MonthEnd(1)
        return start, end

    # 判斷 D (只講 "2026年")
    match = re.search(patterns[3], query)
    if match:
        y = match.group(1)
        start = pd.Timestamp(f"{y}-01-01")
        end = pd.Timestamp(f"{y}-12-31")
        return start, end

    return None, None


def _to_markdown_table(df: pd.DataFrame) -> str:
    """將 DataFrame 轉為 Markdown 表格字串"""
    df = df.copy()
    # 將 datetime 欄位格式化為日期字串
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.strftime('%Y-%m-%d').fillna('N/A')
        else:
            df[col] = df[col].astype(str).replace('nan', '').replace('NaT', '')

    header = '| ' + ' | '.join(df.columns) + ' |'
    separator = '| ' + ' | '.join(['---'] * len(df.columns)) + ' |'
    rows = ['| ' + ' | '.join(str(v) for v in row) + ' |' for _, row in df.iterrows()]
    return '\n'.join([header, separator] + rows)


@tool
def query_worksheet_data(worksheet_name: str, query_description: str) -> str:
    """
    根據查詢需求從指定工作表中檢索和分析資料。
    此工具可以執行複雜的資料分析，包括：
    - 統計數量（有多少筆資料、某狀態有幾筆等）
    - 依日期區間篩選資料（例如：2025年1月到6月）
    - 依關鍵字篩選（專案名稱、狀態、負責人等）
    - 計算平均值、總和、處理天數等統計指標
    - 專案內容摘要整理

    參數:
    - worksheet_name: 工作表的名稱
    - query_description: 詳細描述要查詢的內容（可包含日期區間、關鍵字、分析需求）
      重要：若查詢包含相對時間詞彙（如「今年」、「去年」、「上半年」、「本季」等），
      請先將其轉換為明確的日期區間再傳入，例如「今年」→「2026年1月到12月」。
    """
    try:
        # 讀取資料（含緩存）
        if worksheet_name not in _cached_data:
            gc = get_gspread_client()
            spreadsheet = gc.open_by_key(SPREADSHEET_KEY)
            worksheet = spreadsheet.worksheet(worksheet_name)
            all_records = get_all_records_safe(worksheet)
            _cached_data[worksheet_name] = all_records
        else:
            all_records = _cached_data[worksheet_name]

        if not all_records:
            return f"工作表 '{worksheet_name}' 中沒有資料。"

        df = pd.DataFrame(all_records)
        df = _drop_empty_columns(df)
        total_rows = len(df)
        query_lower = query_description.lower()

        result = f"工作表：{worksheet_name}　總筆數：{total_rows}\n\n"

        # ── Step 1：偵測日期欄位 ──────────────────────────────
        date_cols = _detect_date_columns(df)

        # ── Step 2：依日期區間篩選 ────────────────────────────
        date_start, date_end = _extract_date_range(query_description)
        if date_start:
            # 預設使用 Start Date 進行篩選，若無則降級尋找 Creation Date
            ref_col = 'Start Date' if 'Start Date' in df.columns else ('Creation Date' if 'Creation Date' in df.columns else None)
            if ref_col:
                mask = (df[ref_col] >= date_start) & (df[ref_col] <= date_end)
                df = df[mask]
                result += f"📅 日期篩選：{date_start.strftime('%Y-%m-%d')} ～ {date_end.strftime('%Y-%m-%d')}（{ref_col}），共 {len(df)} 筆\n\n"
                if df.empty:
                    return result + "該日期區間內無資料。"

        # ── Step 3：依狀態篩選 ────────────────────────────────
        status_filter = None
        if any(k in query_lower for k in ['關閉', 'closed']):
            status_filter = 'Closed'
        elif any(k in query_lower for k in ['完成', 'done']):
            status_filter = 'Done'
        elif any(k in query_lower for k in ['進行中', 'doing', 'in progress']):
            status_filter = 'Doing'
        elif any(k in query_lower for k in ['待辦', 'to do', 'todo']):
            status_filter = 'To Do'

        if status_filter and 'Status' in df.columns:
            df = df[df['Status'].str.contains(status_filter, case=False, na=False)]
            result += f"🔍 狀態篩選：{status_filter}，共 {len(df)} 筆\n\n"
            if df.empty:
                return result + f"沒有狀態為「{status_filter}」的資料。"

        # ── Step 4：依 Ticket ID 或關鍵字搜尋 ────────────────
        ticket_pattern = r'(REQ\d+)'
        potential_ids = re.findall(ticket_pattern, query_description, re.IGNORECASE)
        if potential_ids:
            masks = [df.astype(str).apply(lambda x: x.str.contains(pid, case=False, na=False)).any(axis=1)
                     for pid in potential_ids]
            combined_mask = masks[0]
            for m in masks[1:]:
                combined_mask = combined_mask | m
            df = df[combined_mask]
            result += f"🔎 ID 搜尋：{', '.join(potential_ids)}，共 {len(df)} 筆\n\n"
            if df.empty:
                return result + "找不到符合的工單 ID。"

        # ── Step 5：統計類查詢（平均天數）────────────────────
        if any(k in query_lower for k in ['平均', 'average', '天數', '處理時間', '花費', '工時']):
            if 'Start Date' in df.columns and 'Due Date' in df.columns:
                df = df.copy()
                df['_處理天數'] = (df['Due Date'] - df['Start Date']).dt.days + 1
                df_valid = df.dropna(subset=['_處理天數'])
                if not df_valid.empty:
                    result += "### 處理時間統計\n\n"
                    result += f"- 有效筆數：{len(df_valid)}\n"
                    result += f"- 平均天數：{df_valid['_處理天數'].mean():.1f} 天\n"
                    result += f"- 最短：{int(df_valid['_處理天數'].min())} 天　最長：{int(df_valid['_處理天數'].max())} 天\n\n"

                    ticket_col = 'Ticket No.' if 'Ticket No.' in df.columns else None
                    display_cols = [c for c in [ticket_col, 'Start Date', 'Due Date', '_處理天數'] if c]
                    df_display = df_valid[display_cols].rename(columns={'_處理天數': '處理天數(天)'})
                    result += _to_markdown_table(df_display)
                    return result

        # ── Step 6：輸出資料內容（Markdown 表格）────────────
        df = _drop_empty_columns(df)

        # 統計分布（類別欄位、unique <= 15）
        stat_cols = [col for col in df.columns
                     if col not in date_cols
                     and (df[col].dtype == object)
                     and df[col].nunique() <= 15]
        if stat_cols:
            result += "### 欄位分布統計\n\n"
            for col in stat_cols:
                counts = df[col].value_counts()
                result += f"**{col}**：" + "　".join(f"{v}({c}筆)" for v, c in counts.items()) + "\n"
            result += "\n"

        # 資料表格
        result += f"### 資料明細（共 {len(df)} 筆）\n\n"
        result += _to_markdown_table(df)

        return result

    except gspread.exceptions.WorksheetNotFound:
        return f"找不到名為 '{worksheet_name}' 的工作表。"
    except Exception as e:
        return f"查詢資料時發生錯誤: {str(e)}"

# Data Analyst Agent 的工具列表
analyst_tools = [list_worksheets, get_worksheet_structure, query_worksheet_data]

print("\n✅ Analyst Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in analyst_tools]}")
