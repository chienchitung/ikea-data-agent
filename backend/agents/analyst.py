import os
import re
import json
import gspread
import pandas as pd
from typing import Optional
from oauth2client.service_account import ServiceAccountCredentials
from langchain.tools import tool
from dotenv import load_dotenv
import glob
from datetime import datetime, timezone

load_dotenv()

# 全局變量來緩存工作表數據
_cached_data = {}

# Hardcoded sheet key from notebook
SPREADSHEET_KEY = os.getenv("GOOGLE_SHEET_KEY", "1bnqghULmnxgZdu4ALDZ2FGUzBxwamD27qYZVGMq1uEo")

# ── 欄位別名對映表 ────────────────────────────────────────────────────────────
# 對應實際欄位：ID, Ticket No., Creation Date, Name, Email, Department,
#              Subject, Request Details, Attachments, Status, Labels,
#              Device, Market, Data Source, Data Support,
#              Start Date, Due Date, Assigned To, Modified
COLUMN_ALIASES: dict[str, list[str]] = {
    "Ticket No.":      ["工單號", "工單編號", "ticket", "工單", "單號"],
    "Creation Date":   ["建立日期", "建立時間", "創建日期", "創建時間"],
    "Name":            ["申請人", "姓名", "申請者", "name"],
    "Email":           ["信箱", "電子郵件", "e-mail"],
    "Department":      ["部門", "單位", "需求部門", "申請部門", "部处", "department"],
    "Subject":         ["主旨", "標題", "題目", "需求標題", "subject"],
    "Request Details": ["需求內容", "需求描述", "詳情", "內容", "request details"],
    "Attachments":     ["附件", "attachments"],
    "Status":          ["狀態", "進度", "status"],
    "Labels":          ["標籤", "分類", "類型", "label", "labels"],
    "Device":          ["裝置", "設備", "device"],
    "Market":          ["市場", "國家", "market"],
    "Data Source":     ["資料來源", "數據來源", "data source"],
    "Data Support":    ["資料支援", "數據支援", "data support"],
    "Start Date":      ["開始日期", "開始時間", "起始日期", "start date"],
    "Due Date":        ["截止日期", "到期日期", "期限", "due date"],
    "Assigned To":     ["負責人", "指派給", "處理人", "承辦人", "assigned to"],
    "Modified":        ["修改日期", "更新時間", "modified"],
}

# 反向查詢表：中文別名 → 英文欄位名（全部小寫 key，加速比對）
_ALIAS_LOOKUP: dict[str, str] = {
    alias.lower(): col
    for col, aliases in COLUMN_ALIASES.items()
    for alias in aliases
}


def _resolve_column(df: pd.DataFrame, term: str) -> Optional[str]:
    """
    將使用者輸入的中文或英文欄位名稱對應到 DataFrame 的實際欄位名。
    優先完全匹配，其次別名查詢。回傳實際欄位名，找不到回傳 None。
    """
    # 1. 直接完全匹配（英文欄位原名）
    if term in df.columns:
        return term
    # 2. 別名查詢（不分大小寫）
    canonical = _ALIAS_LOOKUP.get(term.lower())
    if canonical and canonical in df.columns:
        return canonical
    # 3. 部分模糊匹配（欄位名包含 term，或 term 包含欄位名）
    term_lower = term.lower()
    for col in df.columns:
        if term_lower in col.lower() or col.lower() in term_lower:
            return col
    return None


def _extract_column_filters(query: str) -> list[tuple[str, str]]:
    """
    從查詢字串中偵測「欄位=值」的篩選條件。
    支援格式：
      - "部門 是 Marketing"
      - "負責人：Jackie"
      - "Department = HR"
      - "market 台灣"（欄位別名 + 值，無連接詞）
    回傳 [(raw_column_term, value), ...] 清單。
    """
    filters = []
    # 格式 A：欄位 [是|為|=|：|:] 值
    pattern_a = r'([^\s,，]+)\s*(?:是|為|=|：|:)\s*([^,，、\n]+)'
    for m in re.finditer(pattern_a, query):
        col_term, value = m.group(1).strip(), _clean_filter_value(m.group(2))
        if value:
            filters.append((col_term, value))
    return filters


def _clean_filter_value(value: str) -> str:
    """Clean natural-language suffixes while preserving multi-word values."""
    cleaned = str(value).strip().strip('"\'「」')
    suffix_markers = [
        ' 的每', ' 的各', ' 的月', ' 的ticket', ' 的 ticket', ' 每個月',
        ' 各月', ' 每月', ' 月份', ' 圖表', ' chart', ' 統計', ' 數量'
    ]
    for marker in suffix_markers:
        if marker in cleaned:
            cleaned = cleaned.split(marker, 1)[0].strip()
    return cleaned.strip().strip('"\'「」')

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


def _load_worksheet_dataframe(worksheet_name: str) -> tuple[pd.DataFrame, int]:
    gc = get_gspread_client()
    spreadsheet = gc.open_by_key(SPREADSHEET_KEY)
    worksheet = spreadsheet.worksheet(worksheet_name)
    all_records = get_all_records_safe(worksheet)
    _cached_data[worksheet_name] = all_records
    if not all_records:
        return pd.DataFrame(), 0
    df = _drop_empty_columns(pd.DataFrame(all_records))
    _detect_date_columns(df)
    return df, len(df)

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
        return f"Available worksheets in this Google Sheet: {', '.join(worksheet_titles)}"
    except Exception as e:
        return f"Failed to list worksheets: {str(e)}"

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
            return f"Worksheet '{worksheet_name}' is empty."
        
        # 獲取欄位名稱
        columns = list(all_records[0].keys())
        row_count = len(all_records)
        
        # 顯示每個欄位的一些統計信息
        result = f"Worksheet '{worksheet_name}' structure:\n"
        result += f"- Total rows: {row_count}\n"
        result += f"- Columns ({len(columns)}): {', '.join(columns)}\n"
        result += f"\nFirst 3 sample rows:\n"
        
        for i, record in enumerate(all_records[:3], 1):
            result += f"\nRow {i}:\n"
            for key, value in record.items():
                result += f"  - {key}: {value}\n"
        
        return result
    except gspread.exceptions.WorksheetNotFound:
        return f"Worksheet '{worksheet_name}' was not found. Use list_worksheets to see available worksheets."
    except Exception as e:
        return f"Failed to read worksheet structure: {str(e)}"

def _drop_empty_columns(df: pd.DataFrame) -> pd.DataFrame:
    """移除完全空白或全為空字串的欄位"""
    return df.loc[:, df.apply(lambda col: col.replace('', pd.NA).notna().any())]


def _detect_date_columns(df: pd.DataFrame) -> list:
    """針對已知的 Google Sheet 欄位，強制將日期欄位轉換為 datetime"""
    # 已知日期欄位
    date_cols = ['Creation Date', 'Start Date', 'Due Date', 'Modified']
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


def _wants_chart(query: str) -> bool:
    chart_keywords = [
        '圖表', '圖形', '視覺化', '可視化', '長條圖', '柱狀圖', '圓餅圖', '折線圖',
        'bar chart', 'pie chart', 'line chart', 'chart', 'visualization', 'visualisation'
    ]
    query_lower = query.lower()
    return any(keyword in query_lower for keyword in chart_keywords)


def _wants_monthly_counts(query: str) -> bool:
    query_lower = query.lower()
    monthly_terms = [
        '每個月', '各月', '月份', '月別', '按月', '每月', '月趨勢',
        'monthly', 'by month', 'per month', 'month over month'
    ]
    count_terms = ['數量', '幾筆', '統計', 'count', 'counts', 'ticket', 'tickets', '工單']
    return any(term in query_lower for term in monthly_terms) and any(term in query_lower for term in count_terms)


def _choose_month_date_column(df: pd.DataFrame, query: str) -> Optional[str]:
    query_lower = query.lower()
    if any(term in query_lower for term in ['建立', '創建', 'creation', 'created']):
        preferred = ['Creation Date', 'Start Date', 'Due Date', 'Modified']
    elif any(term in query_lower for term in ['開始', 'start']):
        preferred = ['Start Date', 'Creation Date', 'Due Date', 'Modified']
    elif any(term in query_lower for term in ['到期', '截止', 'due']):
        preferred = ['Due Date', 'Start Date', 'Creation Date', 'Modified']
    else:
        # Ticket volume by month usually means when tickets were created.
        preferred = ['Creation Date', 'Start Date', 'Due Date', 'Modified']

    for col in preferred:
        actual_col = _resolve_column(df, col)
        if actual_col and pd.api.types.is_datetime64_any_dtype(df[actual_col]):
            return actual_col
    return None


def _choose_filter_date_column(df: pd.DataFrame, query: str) -> Optional[str]:
    """Choose the date column used for date-range filtering."""
    query_lower = query.lower()
    if any(term in query_lower for term in ['開始', 'start']):
        preferred = ['Start Date', 'Creation Date', 'Due Date', 'Modified']
    elif any(term in query_lower for term in ['到期', '截止', 'due']):
        preferred = ['Due Date', 'Start Date', 'Creation Date', 'Modified']
    elif any(term in query_lower for term in ['修改', '更新', 'modified', 'updated']):
        preferred = ['Modified', 'Creation Date', 'Start Date', 'Due Date']
    else:
        # Ticket/request volume and broad date filters should default to creation date.
        preferred = ['Creation Date', 'Start Date', 'Due Date', 'Modified']

    for col in preferred:
        actual_col = _resolve_column(df, col)
        if actual_col and pd.api.types.is_datetime64_any_dtype(df[actual_col]):
            return actual_col
    return None


def _wants_duration_reason_analysis(query: str) -> bool:
    query_lower = query.lower()
    compact = re.sub(r"\s+", "", query_lower)
    duration_terms = ['long duration', 'duration', '耗時', '花很久', '花費時間', '處理時間', '久', '延遲']
    reason_terms = ['reason', 'cause', 'why', '原因', '為什麼', '導致', '瓶頸']
    return any(term in query_lower or term in compact for term in duration_terms) and any(
        term in query_lower or term in compact for term in reason_terms
    )


def _format_source_footer(worksheet_name: str, total_rows: int) -> str:
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return (
        "\n\n---\n"
        f"Source: Google Sheet worksheet `{worksheet_name}`\n"
        f"Fetched at: {fetched_at}\n"
        f"Rows read before filtering: {total_rows}\n"
        "Grounding rule: All numbers and row details above are computed directly from the worksheet data returned in this tool call."
    )


def _monthly_counts(df: pd.DataFrame, date_col: str) -> pd.Series:
    valid_dates = df.dropna(subset=[date_col]).copy()
    if valid_dates.empty:
        return pd.Series(dtype=int)
    return valid_dates.groupby(valid_dates[date_col].dt.to_period('M')).size().sort_index()


def _wants_detail_rows(query: str) -> bool:
    detail_keywords = [
        '明細', '詳細資料', '資料表', '表格', '列出每筆', '每一筆', 'raw data',
        'detail rows', 'details', 'show table', 'data table'
    ]
    query_lower = query.lower()
    return any(keyword in query_lower for keyword in detail_keywords)


def _wants_all_distributions(query: str) -> bool:
    keywords = [
        '所有欄位', '全部欄位', '所有分布', '全部分布', '欄位分布',
        'all fields', 'all distributions', 'profile'
    ]
    query_lower = query.lower()
    return any(keyword in query_lower for keyword in keywords)


def _parse_analysis_intent(
    query: str,
    df: pd.DataFrame,
    group_by_override: str = "",
    wants_chart: bool = False,
    wants_detail_rows: bool = False,
    chart_type_override: str = "",
) -> dict:
    """
    Convert a natural-language analysis request into a small, predictable shape.
    This prevents secondary fields like "filter by assignee" from stealing the
    main chart dimension from phrases like "by month".

    group_by_override / chart_type_override take priority over the keyword
    heuristics below when non-empty — they represent an explicit decision the
    caller (the LLM, via query_worksheet_data's named params) already made, so
    there is no need to re-guess it from the free-text query.
    """
    query_lower = query.lower()
    group_by = None

    if group_by_override:
        normalized_override = group_by_override.strip()
        if normalized_override.lower() in {"month", "monthly", "月份", "月"}:
            group_by = "month"
        else:
            # Fail-safe: an unresolved override simply won't match stat_cols
            # downstream, so the caller gracefully falls back to today's
            # chart-column guess instead of erroring out.
            group_by = _resolve_column(df, normalized_override) or normalized_override
    else:
        group_rules = [
            ('month', ['每個月', '各月', '月份', '月別', '按月', '每月', '月趨勢', 'monthly', 'by month', 'per month']),
            ('Status', ['狀態', '進度', 'status']),
            ('Market', ['市場', 'market']),
            ('Data Source', ['資料來源', '數據來源', 'data source']),
            ('Data Support', ['資料支援', '數據支援', '支援類型', 'data support']),
            ('Assigned To', ['依負責人', '按負責人', '各負責人', '負責人分布', 'assigned distribution', 'by assignee']),
            ('Department', ['部門', 'department']),
            ('Labels', ['標籤', '分類', 'label']),
            ('Device', ['裝置', 'device']),
        ]
        for value, terms in group_rules:
            if any(term in query_lower for term in terms):
                group_by = value
                break

    metric = 'ticket_count'
    if any(term in query_lower for term in ['平均', 'average', '天數', '處理時間', '花費', '工時']):
        metric = 'duration_days'

    output = 'chart' if wants_chart else 'summary'
    if wants_detail_rows:
        output = 'table'
    elif group_by == 'month':
        output = 'chart'

    chart_type = chart_type_override or _chart_type(query)
    if group_by == 'month' and not chart_type_override:
        chart_type = 'line'

    date_column = _choose_month_date_column(df, query) if group_by == 'month' else None

    filterable_fields = []
    for col, terms in [
        ('Assigned To', ['負責人', 'assigned', '篩選']),
        ('Status', ['狀態', 'status', '篩選']),
        ('Market', ['市場', 'market', '篩選']),
        ('Department', ['部門', 'department', '篩選']),
    ]:
        if col in df.columns and any(term in query_lower for term in terms):
            filterable_fields.append(col)

    return {
        'metric': metric,
        'group_by': group_by,
        'date_column': date_column,
        'output': output,
        'chart_type': chart_type,
        'filterable_fields': filterable_fields,
    }


def _choose_chart_column(query: str, stat_cols: list[str]) -> Optional[str]:
    if not stat_cols:
        return None

    query_lower = query.lower()
    priority_terms = [
        ('Status', ['狀態', '進度', 'status']),
        ('Assigned To', ['負責人', '處理人', '承辦人', 'assigned']),
        ('Market', ['市場', 'market']),
        ('Labels', ['標籤', '分類', 'label']),
        ('Data Source', ['資料來源', '數據來源', 'data source']),
        ('Department', ['部門', 'department']),
        ('Device', ['裝置', 'device']),
    ]

    for col, terms in priority_terms:
        if col in stat_cols and any(term in query_lower for term in terms):
            return col

    for col, _ in priority_terms:
        if col in stat_cols:
            return col

    return stat_cols[0]


def _summary_columns(stat_cols: list[str], chart_col: Optional[str], wants_all_distributions: bool = False) -> list[str]:
    if wants_all_distributions:
        return stat_cols

    preferred = [chart_col, 'Status', 'Market', 'Data Source', 'Data Support']
    selected = []
    for col in preferred:
        if col and col in stat_cols and col not in selected:
            selected.append(col)
    return selected[:4]


def _format_counts_line(col: str, counts: pd.Series, limit: int = 5) -> str:
    top_items = list(counts.head(limit).items())
    line = f"- **{col}**: " + ", ".join(f"{v} {c} rows" for v, c in top_items)
    remaining = len(counts) - len(top_items)
    if remaining > 0:
        line += f" ({remaining} more categories)"
    return line + "\n"


def _chart_type(query: str) -> str:
    query_lower = query.lower()
    if any(k in query_lower for k in ['圓餅', 'pie']):
        return 'pie'
    if any(k in query_lower for k in ['折線', 'line']):
        return 'line'
    return 'bar'


def _build_chart_block(title: str, labels: list[str], values: list[int], chart_type: str = 'bar', is_sequential: bool = False) -> str:
    data = [
        {"label": str(label) if str(label).strip() else "(Blank)", "value": int(value)}
        for label, value in zip(labels, values)
    ]
    chart_spec = {
        "title": title,
        "type": chart_type,
        "xKey": "label",
        "yKey": "value",
        "isSequential": is_sequential,
        "data": data,
    }
    return "\n\n```chart\n" + json.dumps(chart_spec, ensure_ascii=False, indent=2) + "\n```\n"


def _parse_iso_date(value: str, fallback_end: bool = False) -> Optional[pd.Timestamp]:
    raw = str(value or "").strip()
    if not raw:
        return None
    normalized = raw.replace("/", "-").replace("年", "-").replace("月", "").replace("日", "")
    try:
        if re.fullmatch(r"\d{4}", normalized):
            return pd.Timestamp(f"{normalized}-12-31" if fallback_end else f"{normalized}-01-01")
        if re.fullmatch(r"\d{4}-\d{1,2}", normalized):
            start = pd.Timestamp(f"{normalized}-01")
            return start + pd.offsets.MonthEnd(1) if fallback_end else start
        return pd.Timestamp(normalized)
    except Exception:
        return None


def _month_labels_between(start: pd.Timestamp, end: pd.Timestamp) -> list[str]:
    if start is None or end is None:
        return []
    periods = pd.period_range(start=start.to_period("M"), end=end.to_period("M"), freq="M")
    return [str(period) for period in periods]


def _series_counts_dict(series: pd.Series, limit: int = 20) -> dict:
    counts = series.fillna("(Blank)").astype(str).replace("", "(Blank)").value_counts().head(limit)
    return {str(key): int(value) for key, value in counts.items()}


@tool
def query_request_tickets_structured(
    date_start: str = "",
    date_end: str = "",
    date_column: str = "Creation Date",
    group_by: str = "month",
    include_details: bool = False,
    status: str = "",
    assigned_to: str = "",
    department: str = "",
    market: str = "",
    data_source: str = "",
    chart_type: str = "line",
) -> str:
    """
    Structured Request worksheet query for ticket/request/工單 questions.

    Use this tool before the generic query_worksheet_data when the user asks about
    Request tickets, yearly/YTD/monthly ticket counts, status distribution,
    assignee workload, or row-level Request details.

    Parameters should be explicit. For example, a 2026 yearly ticket question must
    pass date_start="2026-01-01" and date_end="2026-12-31" rather than a vague
    natural-language range. group_by supports: month, status, assigned_to,
    department, market, data_source, none.
    """
    try:
        df, total_rows = _load_worksheet_dataframe("Request")
        if df.empty:
            return json.dumps({
                "tool": "query_request_tickets_structured",
                "error": "Request worksheet has no data.",
                "source": {"worksheet": "Request", "rows_read_before_filtering": 0},
            }, ensure_ascii=False, indent=2)

        requested_start = _parse_iso_date(date_start)
        requested_end = _parse_iso_date(date_end, fallback_end=True)
        actual_date_col = _resolve_column(df, date_column) or _resolve_column(df, "Creation Date")
        filtered = df.copy()
        filters_applied = []

        if requested_start is not None and requested_end is not None and actual_date_col:
            filtered = filtered[(filtered[actual_date_col] >= requested_start) & (filtered[actual_date_col] <= requested_end)]
            filters_applied.append({
                "field": actual_date_col,
                "operator": "between",
                "start": requested_start.strftime("%Y-%m-%d"),
                "end": requested_end.strftime("%Y-%m-%d"),
            })

        field_filters = {
            "Status": status,
            "Assigned To": assigned_to,
            "Department": department,
            "Market": market,
            "Data Source": data_source,
        }
        for canonical, value in field_filters.items():
            cleaned = str(value or "").strip()
            actual_col = _resolve_column(filtered, canonical)
            if cleaned and actual_col:
                filtered = filtered[filtered[actual_col].astype(str).str.contains(cleaned, case=False, na=False)]
                filters_applied.append({
                    "field": actual_col,
                    "operator": "contains",
                    "value": cleaned,
                })

        row_count = int(len(filtered))
        normalized_group_by = str(group_by or "none").strip().lower()
        group_column_map = {
            "status": "Status",
            "assigned_to": "Assigned To",
            "assignee": "Assigned To",
            "department": "Department",
            "market": "Market",
            "data_source": "Data Source",
            "source": "Data Source",
        }

        monthly_counts = {}
        missing_months = []
        chart_block = ""
        if normalized_group_by == "month" and actual_date_col:
            counts = _monthly_counts(filtered, actual_date_col)
            monthly_counts = {str(period): int(value) for period, value in counts.items()}
            if requested_start is not None and requested_end is not None:
                expected_months = _month_labels_between(requested_start, requested_end)
                missing_months = [month for month in expected_months if month not in monthly_counts]
            chart_block = _build_chart_block(
                title="Monthly ticket count",
                labels=list(monthly_counts.keys()),
                values=list(monthly_counts.values()),
                chart_type="line" if chart_type not in {"bar", "pie", "line"} else chart_type,
                is_sequential=True,
            )

        grouped_counts = {}
        if normalized_group_by != "month":
            group_col = group_column_map.get(normalized_group_by)
            actual_group_col = _resolve_column(filtered, group_col) if group_col else None
            if actual_group_col:
                grouped_counts = _series_counts_dict(filtered[actual_group_col])
                chart_block = _build_chart_block(
                    title=f"{actual_group_col} distribution",
                    labels=list(grouped_counts.keys()),
                    values=list(grouped_counts.values()),
                    chart_type="bar" if chart_type not in {"bar", "pie", "line"} else chart_type,
                )

        distributions = {}
        for col in ["Status", "Assigned To", "Department", "Market", "Data Source", "Data Support"]:
            actual_col = _resolve_column(filtered, col)
            if actual_col:
                distributions[actual_col] = _series_counts_dict(filtered[actual_col], limit=12)

        detail_columns = [
            _resolve_column(filtered, col)
            for col in ["Ticket No.", "Creation Date", "Subject", "Status", "Market", "Data Source", "Data Support", "Assigned To"]
        ]
        detail_columns = [col for col in detail_columns if col]
        details = []
        if include_details and detail_columns:
            detail_df = filtered[detail_columns].copy()
            for col in detail_df.columns:
                if pd.api.types.is_datetime64_any_dtype(detail_df[col]):
                    detail_df[col] = detail_df[col].dt.strftime("%Y-%m-%d").fillna("")
                else:
                    detail_df[col] = detail_df[col].fillna("").astype(str)
            details = detail_df.head(120).to_dict(orient="records")

        checks = {
            "row_count": row_count,
            "monthly_sum": int(sum(monthly_counts.values())) if monthly_counts else None,
            "monthly_sum_matches_row_count": (int(sum(monthly_counts.values())) == row_count) if monthly_counts else None,
            "details_returned": len(details),
            "details_truncated": include_details and row_count > len(details),
        }

        source = {
            "worksheet": "Request",
            "spreadsheet_key": SPREADSHEET_KEY,
            "rows_read_before_filtering": total_rows,
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "grounding_rule": "All counts, distributions, details, and coverage fields are computed directly from the Request worksheet in this tool call.",
        }

        coverage = {
            "date_column": actual_date_col,
            "requested_start": requested_start.strftime("%Y-%m-%d") if requested_start is not None else None,
            "requested_end": requested_end.strftime("%Y-%m-%d") if requested_end is not None else None,
            "filtered_min_date": filtered[actual_date_col].min().strftime("%Y-%m-%d") if actual_date_col and row_count else None,
            "filtered_max_date": filtered[actual_date_col].max().strftime("%Y-%m-%d") if actual_date_col and row_count else None,
            "missing_months_in_requested_range": missing_months,
        }

        payload = {
            "tool": "query_request_tickets_structured",
            "filters_applied": filters_applied,
            "coverage": coverage,
            "row_count": row_count,
            "monthly_counts": monthly_counts,
            "grouped_counts": grouped_counts,
            "field_distributions": distributions,
            "details": details,
            "checks": checks,
            "chart_block": chart_block.strip(),
            "source": source,
        }
        return json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    except gspread.exceptions.WorksheetNotFound:
        return json.dumps({
            "tool": "query_request_tickets_structured",
            "error": "Worksheet `Request` was not found.",
        }, ensure_ascii=False, indent=2)
    except Exception as e:
        return json.dumps({
            "tool": "query_request_tickets_structured",
            "error": str(e),
        }, ensure_ascii=False, indent=2)


@tool
def query_worksheet_data(
    worksheet_name: str,
    query_description: str,
    wants_chart: bool = False,
    chart_type: str = "",
    group_by_column: str = "",
    wants_detail_rows: bool = False,
    wants_all_distributions: bool = False,
    wants_reason_analysis: bool = False,
) -> str:
    """
    根據查詢需求從指定工作表中檢索和分析資料，用於 Request 以外的 worksheet，
    或 query_request_tickets_structured 無法覆蓋的自由文字分析（跨欄位篩選、
    duration/reason 分析、任意工作表的欄位分布）。

    請把你已經判斷好的意圖填入下列具名參數，不要只寫進 query_description 讓
    工具重新用關鍵字猜測：
    - wants_chart: 使用者要不要圖表/圖形/視覺化。
    - chart_type: "bar" | "line" | "pie"；不確定就留空（工具會退回猜測）。
    - group_by_column: 圖表或統計的主維度欄位名，例如 "Status"、"Market"、
      "Department"、"Assigned To"；月份用 "Month"。這是主維度，不是篩選條件。
    - wants_detail_rows: 是否要逐筆明細/資料表，而不是摘要統計。
    - wants_all_distributions: 是否要「所有欄位」分布，而不是重點欄位。
    - wants_reason_analysis: 是否在問耗時原因/延遲/bottleneck/root cause。

    query_description 仍用來描述：日期區間（相對時間詞彙請先轉換成明確西元
    年月區間，例如「今年」→「2026年1月到12月」）、欄位篩選條件（格式
    「{欄位名} 是 {值}」）、以及其他無法用上面具名參數表達的自由文字分析需求。

    範例：使用者問「請用長條圖顯示各市場的工單分布」
    → query_worksheet_data(
         worksheet_name="Request",
         query_description="各市場的工單分布",
         wants_chart=True,
         chart_type="bar",
         group_by_column="Market",
      )
    """
    try:
        # Always fetch the worksheet for analysis queries so answers reflect the
        # current Google Sheet instead of a stale in-memory cache.
        gc = get_gspread_client()
        spreadsheet = gc.open_by_key(SPREADSHEET_KEY)
        worksheet = spreadsheet.worksheet(worksheet_name)
        all_records = get_all_records_safe(worksheet)
        _cached_data[worksheet_name] = all_records

        if not all_records:
            return f"Worksheet '{worksheet_name}' has no data." + _format_source_footer(worksheet_name, 0)

        df = pd.DataFrame(all_records)
        df = _drop_empty_columns(df)
        total_rows = len(df)
        query_lower = query_description.lower()

        # LLM-provided intent wins; fall back to keyword guessing on the free-text
        # query_description only when the caller left a param at its default. This
        # keeps behavior unchanged for callers/prompts that haven't adopted the new
        # named params yet, while letting an explicit decision short-circuit the
        # keyword guess once the caller does provide one.
        effective_wants_chart = wants_chart or _wants_chart(query_description)
        effective_wants_detail_rows = wants_detail_rows or _wants_detail_rows(query_description)
        effective_wants_all_distributions = wants_all_distributions or _wants_all_distributions(query_description)
        effective_wants_reason_analysis = wants_reason_analysis or _wants_duration_reason_analysis(query_description)
        normalized_chart_type = chart_type.strip().lower() if chart_type.strip().lower() in {"bar", "line", "pie"} else ""

        result = f"Worksheet: {worksheet_name} | Total rows: {total_rows}\n\n"

        # ── Step 1：偵測日期欄位 ──────────────────────────────
        date_cols = _detect_date_columns(df)
        analysis_intent = _parse_analysis_intent(
            query_description,
            df,
            group_by_override=group_by_column,
            wants_chart=effective_wants_chart,
            wants_detail_rows=effective_wants_detail_rows,
            chart_type_override=normalized_chart_type,
        )

        # ── Step 2：依日期區間篩選 ────────────────────────────
        date_start, date_end = _extract_date_range(query_description)
        if date_start:
            ref_col = _choose_filter_date_column(df, query_description)
            if ref_col:
                mask = (df[ref_col] >= date_start) & (df[ref_col] <= date_end)
                df = df[mask]
                result += f"📅 Date filter: {date_start.strftime('%Y-%m-%d')} to {date_end.strftime('%Y-%m-%d')} ({ref_col}), {len(df)} rows\n\n"
                if df.empty:
                    return result + "No data in this date range." + _format_source_footer(worksheet_name, total_rows)

        # ── Step 3：依狀態篩選 ────────────────────────────────
        status_col = _resolve_column(df, 'Status')
        status_filter = None
        if any(k in query_lower for k in ['關閉', 'closed']):
            status_filter = 'Closed'
        elif any(k in query_lower for k in ['完成', 'done']):
            status_filter = 'Done'
        elif any(k in query_lower for k in ['進行中', 'doing', 'in progress']):
            status_filter = 'Doing'
        elif any(k in query_lower for k in ['待辦', 'to do', 'todo']):
            status_filter = 'To Do'

        if status_filter and status_col:
            df = df[df[status_col].str.contains(status_filter, case=False, na=False)]
            result += f"🔍 Status filter: {status_filter}, {len(df)} rows\n\n"
            if df.empty:
                return result + f"No rows have status \"{status_filter}\"." + _format_source_footer(worksheet_name, total_rows)

        # ── Step 4：依 Ticket ID 搜尋 ────────────────────────
        ticket_pattern = r'(REQ\d+)'
        potential_ids = re.findall(ticket_pattern, query_description, re.IGNORECASE)
        if potential_ids:
            masks = [df.astype(str).apply(lambda x: x.str.contains(pid, case=False, na=False)).any(axis=1)
                     for pid in potential_ids]
            if masks:
                combined_mask = masks[0]
                for m in masks[1:]:
                    combined_mask = combined_mask | m
                df = df[combined_mask]
                result += f"🔎 ID search: {', '.join(potential_ids)}, {len(df)} rows\n\n"
                if df.empty:
                    return result + "No matching ticket ID was found." + _format_source_footer(worksheet_name, total_rows)

        # ── Step 4.5：依欄位值篩選（中文別名對映）────────────
        # 例：「部門 是 Marketing」→ Department == Marketing
        #     「負責人：Jackie」 → Assigned To contains Jackie
        col_filters = _extract_column_filters(query_description)
        for col_term, value in col_filters:
            actual_col = _resolve_column(df, col_term)
            if actual_col:
                df = df[df[actual_col].astype(str).str.contains(value, case=False, na=False)]
                result += f"🏷️ Field filter: {actual_col} ({col_term}) contains \"{value}\", {len(df)} rows\n\n"
                if df.empty:
                    return result + f"No rows match \"{actual_col} = {value}\"." + _format_source_footer(worksheet_name, total_rows)

        # ── Step 5：統計類查詢（平均天數）────────────────────
        if any(k in query_lower for k in ['平均', 'average', '天數', '處理時間', '花費', '工時']):
            start_col = _resolve_column(df, 'Start Date')
            due_col = _resolve_column(df, 'Due Date')
            ticket_col = _resolve_column(df, 'Ticket No.')
            if start_col and due_col:
                df = df.copy()
                df['_處理天數'] = (df[due_col] - df[start_col]).dt.days + 1
                df_valid = df.dropna(subset=['_處理天數'])
                if not df_valid.empty:
                    result += "### Processing Time Statistics\n\n"
                    result += f"- Valid rows: {len(df_valid)}\n"
                    result += f"- Average days: {df_valid['_處理天數'].mean():.1f}\n"
                    result += f"- Minimum: {int(df_valid['_處理天數'].min())} days | Maximum: {int(df_valid['_處理天數'].max())} days\n\n"

                    display_cols = [c for c in [ticket_col, start_col, due_col, '_處理天數'] if c]
                    df_display = df_valid[display_cols].rename(columns={'_處理天數': 'Processing Days'})
                    result += _to_markdown_table(df_display)
                    if effective_wants_chart and ticket_col:
                        chart_df = df_valid[[ticket_col, '_處理天數']].dropna().head(12)
                        result += _build_chart_block(
                            title="Ticket processing days",
                            labels=list(chart_df[ticket_col].astype(str)),
                            values=list(chart_df['_處理天數'].astype(int)),
                            chart_type=(normalized_chart_type or _chart_type(query_description)),
                        )
                    if effective_wants_reason_analysis:
                        evidence_cols = [
                            col for col in [
                                ticket_col,
                                _resolve_column(df_valid, 'Subject'),
                                _resolve_column(df_valid, 'Request Details'),
                                _resolve_column(df_valid, 'Status'),
                                _resolve_column(df_valid, 'Labels'),
                                _resolve_column(df_valid, 'Data Source'),
                                _resolve_column(df_valid, 'Data Support'),
                                _resolve_column(df_valid, 'Assigned To'),
                                '_處理天數',
                            ]
                            if col
                        ]
                        evidence = (
                            df_valid.sort_values('_處理天數', ascending=False)
                            .head(10)[evidence_cols]
                            .rename(columns={'_處理天數': 'Processing Days'})
                        )
                        result += "\n\n### Evidence Rows For Duration Analysis\n\n"
                        result += _to_markdown_table(evidence)
                        result += (
                            "\n\nCausality note: The worksheet can show which rows took longer and the text recorded in "
                            "`Subject` / `Request Details`, but it does not prove a root cause unless the row text explicitly states one."
                        )
                    return result + _format_source_footer(worksheet_name, total_rows)

        # ── Step 6：輸出資料內容（Markdown 表格）────────────
        df = _drop_empty_columns(df)

        if analysis_intent.get('group_by') == 'month' or _wants_monthly_counts(query_description):
            month_col = analysis_intent.get('date_column') or _choose_month_date_column(df, query_description)
            if month_col:
                counts = _monthly_counts(df, month_col)
                if not counts.empty:
                    labels = [str(period) for period in counts.index]
                    values = [int(value) for value in counts.values]
                    result += "### Monthly Ticket Count\n\n"
                    result += f"- Date column: {month_col}\n"
                    result += f"- Counted rows: {sum(values)}\n"
                    result += "- Monthly distribution: " + ", ".join(
                        f"{label} {value} rows" for label, value in zip(labels, values)
                    ) + "\n"

                    if analysis_intent.get('output') == 'chart':
                        result += _build_chart_block(
                            title="Monthly ticket count",
                            labels=labels,
                            values=values,
                            chart_type=analysis_intent.get('chart_type', 'line'),
                            is_sequential=True,
                        )

                    # Only show assignee breakdown / hint when no person filter is active
                    assigned_col = _resolve_column(df, 'Assigned To')
                    active_filters = {_resolve_column(df, t) for t, _ in col_filters}
                    already_filtered_by_assignee = assigned_col and assigned_col in active_filters
                    if assigned_col and not already_filtered_by_assignee and assigned_col in analysis_intent.get('filterable_fields', []):
                        assignee_counts = (
                            df[assigned_col]
                            .fillna("(Blank)")
                            .astype(str)
                            .replace("", "(Blank)")
                            .value_counts()
                            .head(8)
                        )
                        result += "\nAvailable assignee filters: " + ", ".join(
                            f"{name} ({count} rows)" for name, count in assignee_counts.items()
                        ) + "\n"

                    if not effective_wants_detail_rows:
                        if not already_filtered_by_assignee:
                            result += "\nTo filter by a specific assignee, ask for example: \"Monthly ticket count for assignee Kelly Dong\".\n"
                        return result + _format_source_footer(worksheet_name, total_rows)
            else:
                result += "No usable date column was found, so monthly statistics cannot be calculated.\n\n"

        # 統計分布（類別欄位、unique <= 15）
        stat_cols = [col for col in df.columns
                     if col not in date_cols
                     and (df[col].dtype == object)
                     and df[col].nunique() <= 15]
        if stat_cols:
            intent_group = analysis_intent.get('group_by')
            chart_col = intent_group if intent_group in stat_cols else None
            if not chart_col and analysis_intent.get('output') == 'chart':
                chart_col = _choose_chart_column(query_description, stat_cols)

            if analysis_intent.get('output') == 'chart':
                result += "### Key Summary\n\n"
                for col in _summary_columns(stat_cols, chart_col, effective_wants_all_distributions):
                    counts = df[col].fillna("(Blank)").astype(str).replace("", "(Blank)").value_counts()
                    result += _format_counts_line(col, counts)
                result += "\n"

                if chart_col:
                    counts = df[chart_col].fillna("(Blank)").astype(str).replace("", "(Blank)").value_counts().head(12)
                    result += _build_chart_block(
                        title=f"{chart_col} distribution",
                        labels=list(counts.index),
                        values=list(counts.values),
                        chart_type=analysis_intent.get('chart_type', _chart_type(query_description)),
                    )
            else:
                result += "### Field Distribution Statistics\n\n"
                for col in stat_cols:
                    counts = df[col].value_counts()
                    result += f"**{col}**: " + ", ".join(f"{v} ({c} rows)" for v, c in counts.items()) + "\n"
                result += "\n"

        if analysis_intent.get('output') == 'chart' and not effective_wants_detail_rows:
            result += f"{len(df)} rows were summarized and a chart was generated from the filters. Ask for details if you need row-level data.\n"
            return result + _format_source_footer(worksheet_name, total_rows)

        # 資料表格
        result += f"### Data Details ({len(df)} rows)\n\n"
        result += _to_markdown_table(df)

        return result + _format_source_footer(worksheet_name, total_rows)

    except gspread.exceptions.WorksheetNotFound:
        return f"Worksheet '{worksheet_name}' was not found."
    except Exception as e:
        return f"Failed to query worksheet data: {str(e)}"

# Data Analyst Agent 的工具列表
analyst_tools = [list_worksheets, get_worksheet_structure, query_request_tickets_structured, query_worksheet_data]

print("\n✅ Analyst Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in analyst_tools]}")
