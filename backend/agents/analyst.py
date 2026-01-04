import os
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
        
        all_records = worksheet.get_all_records()
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

@tool
def query_worksheet_data(worksheet_name: str, query_description: str) -> str:
    """
    根據查詢需求從指定工作表中檢索和分析資料。
    此工具可以執行複雜的資料分析，包括：
    - 統計數量（有多少筆資料、某狀態有幾筆等）
    - 篩選資料（找出符合特定條件的記錄）
    - 計算平均值、總和等統計指標
    - 日期計算（例如：計算起始日期到結束日期的平均天數）
    - 資料分組與摘要
    
    參數:
    - worksheet_name: 工作表的名稱
    - query_description: 詳細描述要查詢的內容
    """
    try:
        # 先檢查緩存
        if worksheet_name not in _cached_data:
            gc = get_gspread_client()
            spreadsheet = gc.open_by_key(SPREADSHEET_KEY)
            worksheet = spreadsheet.worksheet(worksheet_name)
            all_records = worksheet.get_all_records()
            _cached_data[worksheet_name] = all_records
        else:
            all_records = _cached_data[worksheet_name]
        
        if not all_records:
            return f"工作表 '{worksheet_name}' 中沒有資料。"
        
        # 將資料轉換為 DataFrame
        df = pd.DataFrame(all_records)
        
        result = f"針對工作表 '{worksheet_name}' 的查詢結果：\n\n"
        result += f"總資料筆數: {len(df)}\n\n"
        
        # 智能分析查詢意圖
        query_lower = query_description.lower()
        
        # 檢查是否需要進行時間計算
        if any(keyword in query_lower for keyword in ['平均', 'average', '天數', 'days', '時間', 'time', '花費']):
            # 嘗試找到日期相關欄位
            date_columns = [col for col in df.columns if any(x in col.lower() for x in ['date', '日期', 'start', 'due', '起始', '結束'])]
            
            if len(date_columns) >= 2:
                # 轉換日期欄位
                for col in date_columns:
                    try:
                        df[col] = pd.to_datetime(df[col], errors='coerce')
                    except:
                        pass
                
                # 如果查詢提到「關閉」或「closed"，篩選對應資料
                if any(keyword in query_lower for keyword in ['關閉', 'closed', '完成', 'done']):
                    status_cols = [col for col in df.columns if 'status' in col.lower() or '狀態' in col]
                    if status_cols:
                        df_filtered = df[df[status_cols[0]].str.contains('Closed|Done|關閉|完成', case=False, na=False)]
                        if len(df_filtered) > 0:
                            # 找到起始和結束日期欄位
                            start_col = next((col for col in date_columns if 'start' in col.lower() or '起始' in col), None)
                            end_col = next((col for col in date_columns if 'due' in col.lower() or 'end' in col.lower() or '結束' in col or 'due' in col), None)
                            
                            if start_col and end_col:
                                # 計算天數：(結束日期 - 起始日期) + 1，因此當天完成算 1 天
                                df_filtered['處理天數'] = (df_filtered[end_col] - df_filtered[start_col]).dt.days + 1
                                df_valid = df_filtered.dropna(subset=['處理天數'])
                                
                                if len(df_valid) > 0:
                                    avg_days = df_valid['處理天數'].mean()
                                    # 檢查是否有當天完成的工單 (處理天數為 1)
                                    one_day_count = len(df_valid[df_valid['處理天數'] == 1])
                                    
                                    result += f"=== 已關閉工單的處理時間分析 ===\n"
                                    result += f"有效資料筆數: {len(df_valid)} 筆\n"
                                    result += f"平均處理天數: {avg_days:.1f} 天\n"
                                    result += f"最短處理天數: {df_valid['處理天數'].min():.0f} 天\n"
                                    result += f"最長處理天數: {df_valid['處理天數'].max():.0f} 天\n\n"
                                    
                                    if one_day_count > 0:
                                        result += f"📌 **註**: {one_day_count} 筆工單的處理時間為 1 天（起始日期與結束日期相同，代表當天完成）\n\n"
                                    
                                    # 新增 Markdown 表格格式顯示所有工單
                                    result += "### 詳細處理時間列表\n\n"
                                    result += "| 工單編號 | 起始日期 | 結束日期 | 處理天數 | 說明 |\n"
                                    result += "|---------|---------|---------|---------|------|\n"
                                    
                                    # 找到 Ticket No. 欄位
                                    ticket_col = next((col for col in df_filtered.columns if 'ticket' in col.lower() or '工單' in col or 'no' in col.lower()), None)
                                    
                                    for idx, row in df_valid.iterrows():
                                        ticket_no = row[ticket_col] if ticket_col else row.name
                                        start_date = row[start_col].strftime('%Y-%m-%d') if pd.notna(row[start_col]) else 'N/A'
                                        end_date = row[end_col].strftime('%Y-%m-%d') if pd.notna(row[end_col]) else 'N/A'
                                        days = int(row['處理天數'])
                                        note = "當天完成" if days == 1 else ""
                                        result += f"| {ticket_no} | {start_date} | {end_date} | {days} 天 | {note} |\n"
                                    
                                    return result
        
        # 提供資料摘要
        result += "=== 資料摘要 ===\n"
        result += f"欄位: {', '.join(df.columns.tolist())}\n\n"
        
        # 對每個欄位進行統計
        for col in df.columns:
            if df[col].dtype == 'object' or df[col].dtype == 'string':
                unique_values = df[col].nunique()
                if unique_values <= 20:
                    result += f"【{col}】的分布:\n"
                    value_counts = df[col].value_counts()
                    for value, count in value_counts.items():
                        result += f"  - {value}: {count} 筆\n"
                    result += "\n"
        
        # 智能搜尋：檢查是否查詢特定 ID 或關鍵字
        import re
        # 嘗試尋找類似 Ticket No 的模式 (例如 REQ2025...)
        ticket_pattern = r'(REQ\d+|[A-Za-z0-9]{10,})'
        potential_ids = re.findall(ticket_pattern, query_description, re.IGNORECASE)
        
        # 排除常見非 ID 關鍵字
        exclude_keywords = ['AVERAGE', 'COUNT', 'STATUS', 'SUMMARY', 'REPORT', 'UPDATE', 'PROGRESS', 'DASHBOARD', 'TIME', 'DAYS']
        potential_ids = [pid for pid in potential_ids if pid.upper() not in exclude_keywords and len(pid) > 5]
        
        target_records = []
        if potential_ids:
            # 如果發現疑似 ID，嘗試在所有欄位中搜尋
            for pid in potential_ids:
                # 在整個 dataframe 中搜尋字串
                mask = df.astype(str).apply(lambda x: x.str.contains(pid, case=False, na=False)).any(axis=1)
                matches = df[mask]
                if not matches.empty:
                    target_records.append(matches)
        
        # 如果有找到特定紀錄，優先顯示
        if target_records:
            df_target = pd.concat(target_records).drop_duplicates()
            result += f"=== 搜尋結果 ({len(df_target)} 筆) ===\n"
            for idx, row in df_target.iterrows():
                result += f"\n第 {idx + 1} 筆:\n"
                for col in df.columns:
                    result += f"  - {col}: {row[col]}\n"
            
            # 如果搜尋結果量少，已經顯示完畢，直接返回
            return result

        # 顯示資料樣本 (原本的邏輯)
        if len(df) <= 10:
            result += "=== 所有資料 ===\n"
            for idx, row in df.iterrows():
                result += f"\n第 {idx + 1} 筆:\n"
                for col in df.columns:
                    result += f"  - {col}: {row[col]}\n"
        else:
            result += f"=== 最近 10 筆資料 ===\n"
            for idx in range(min(10, len(df))):
                row = df.iloc[idx]
                result += f"\n第 {idx + 1} 筆:\n"
                for col in df.columns:
                    result += f"  - {col}: {row[col]}\n"
            result += f"\n(僅顯示前 10 筆，共 {len(df)} 筆資料)"
        
        return result
    
    except gspread.exceptions.WorksheetNotFound:
        return f"找不到名為 '{worksheet_name}' 的工作表。"
    except Exception as e:
        return f"查詢資料時發生錯誤: {str(e)}"

# Data Analyst Agent 的工具列表
analyst_tools = [list_worksheets, get_worksheet_structure, query_worksheet_data]

print("\n✅ Analyst Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in analyst_tools]}")
