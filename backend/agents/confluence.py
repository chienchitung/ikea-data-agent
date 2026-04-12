import os
from atlassian import Confluence
from langchain.tools import tool
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

# ✅ 從 Colab Secrets 讀取憑證 (Adapted for local .env)
try:
    CONFLUENCE_URL = os.getenv('CONFLUENCE_URL')
    CONFLUENCE_USERNAME = os.getenv('CONFLUENCE_USERNAME')
    CONFLUENCE_API_TOKEN = os.getenv('CONFLUENCE_API_TOKEN')

    print("✅ Confluence 憑證已從 Environment Variables 載入")
    print(f"   URL: {CONFLUENCE_URL}")
    print(f"   Username: {CONFLUENCE_USERNAME}")

except Exception as e:
    print(f"❌ 無法讀取 Environment Variables: {e}")
    raise

# 初始化 Confluence 客戶端
confluence = None
if CONFLUENCE_URL and CONFLUENCE_USERNAME and CONFLUENCE_API_TOKEN:
    try:
        confluence = Confluence(
            url=CONFLUENCE_URL,
            username=CONFLUENCE_USERNAME,
            password=CONFLUENCE_API_TOKEN,
            cloud=True
        )
        print(f"✅ Confluence 連線成功！")
    except Exception as e:
        print(f"❌ Confluence 連線失敗: {e}")
        print("\n請檢查:")
        print("  1. CONFLUENCE_URL 格式是否正確 (例如: https://your-domain.atlassian.net)")
        print("  2. CONFLUENCE_USERNAME 是否為正確的登入 Email")
        print("  3. CONFLUENCE_API_TOKEN 是否有效")

def clean_html(html_content):
    """輔助函式：將 Confluence 的 HTML 轉換為 Markdown，以保留表格與排版結構"""
    try:
        from markdownify import markdownify
        # 轉換為 markdown，保留表格結構與標題
        md_text = markdownify(html_content, heading_style="ATX", tables=True, strip=["img", "script", "style"])
        return md_text.strip()
    except ImportError:
        # Fallback 傳統的 BeautifulSoup
        soup = BeautifulSoup(html_content, "html.parser")
        return soup.get_text(separator="\n").strip()


# --- 共用輔助函式 ---

def _build_confluence_url(webui: str) -> str:
    """將 Confluence webui 相對路徑組合為完整 URL（確保含 /wiki 前綴）"""
    base_url = os.getenv("CONFLUENCE_URL", "").rstrip('/')
    if not webui.startswith("/wiki"):
        webui = f"/wiki{webui}" if webui.startswith("/") else f"/wiki/{webui}"
    return f"{base_url}{webui}"


def _format_confluence_items(items: list, original_query: str) -> list[str]:
    """將 CQL 結果格式化為 Markdown 連結字串，自動去重並標記標題匹配。"""
    output = []
    seen_ids = set()
    for item in items:
        content = item.get("content", {})
        page_id = content.get("id")
        if not page_id or page_id in seen_ids:
            continue
        seen_ids.add(page_id)
        title = content.get("title", "")
        full_url = _build_confluence_url(content.get("_links", {}).get("webui", ""))
        match_tag = "[⭐️標題匹配]" if original_query.lower() in title.lower() else ""
        output.append(f"ID: {page_id} | {match_tag} Title: {title} | Link: [{title}]({full_url})")
    return output


# --- 定義給 Agent 使用的工具 (Tools) ---

def _build_keyword_variants(query: str) -> list[str]:
    """
    自動產生多個關鍵字變體，提高找到正確頁面的機率。
    例如："7 segments" → ["7 segments", "7segments", "segments", "7"]
    例如："CEM定義" → ["CEM定義", "CEM", "定義"]
    """
    variants = [query]

    # 去除空格的版本（"7 segments" → "7segments"）
    no_space = query.replace(" ", "")
    if no_space != query:
        variants.append(no_space)

    # 拆分成個別關鍵字（取最長的那個，通常最有辨識度）
    parts = query.split()
    if len(parts) > 1:
        # 加入最長的單字作為廣泛搜尋
        longest = max(parts, key=len)
        if longest not in variants:
            variants.append(longest)
        # 加入第一個關鍵字
        if parts[0] not in variants:
            variants.append(parts[0])

    # 移除純數字或過短（1字元）的關鍵字
    variants = [v for v in variants if len(v) > 1]

    # 去重保持順序
    seen = set()
    unique = []
    for v in variants:
        if v not in seen:
            seen.add(v)
            unique.append(v)
    return unique


def _search_with_cql(query: str, limit: int = 10) -> list:
    """執行單次 CQL 搜尋，回傳 results list"""
    if " " in query:
        cql = f'(title ~ "{query}" OR text ~ "{query}")'
    else:
        cql = f'(title ~ "{query}*" OR text ~ "{query}*")'
    results = confluence.cql(cql, limit=limit)
    return results.get("results", [])


@tool
def search_confluence_pages(query: str) -> str:
    """
    當不知道確切頁面標題時，使用此工具搜索 Confluence 頁面。
    輸入關鍵字，返回相關頁面的 ID、標題和完整連結。
    會自動嘗試多種關鍵字變體（含/不含空格、拆分關鍵字），提高找到正確頁面的機率。
    """
    print(f"\n[Tool Call] 正在搜尋 Confluence: {query} ...")
    try:
        if not confluence:
            return "Confluence client is not initialized."

        # 第一輪：直接搜尋原始關鍵字
        items = _search_with_cql(query)
        output = _format_confluence_items(items, query)
        if output:
            print(f"   → 找到 {len(output)} 筆（原始關鍵字）")
            return "\n".join(output)

        # 第二輪：自動嘗試關鍵字變體
        variants = _build_keyword_variants(query)
        print(f"   → 原始關鍵字無結果，嘗試變體：{variants[1:]}")
        for variant in variants[1:]:
            items = _search_with_cql(variant)
            output = _format_confluence_items(items, query)
            if output:
                print(f"   → 找到 {len(output)} 筆（變體：{variant}）")
                return f"（以關鍵字「{variant}」搜尋到以下結果）\n" + "\n".join(output)

        return "⚠️ 【系統警告】Confluence 中完全找不到相關頁面！你必須直接告訴使用者「找不到相關文件」，絕對不能憑空編造標題或連結！"
    except Exception as e:
        return f"搜尋錯誤: {str(e)}"

@tool
def get_all_pages() -> str:
    """
    列出 Confluence 中所有頁面的標題與 ID。
    當 search_confluence_pages 找不到結果時，使用此工具瀏覽所有頁面標題，
    從中找到最相關的頁面再用 get_confluence_page_content 取得內容。
    """
    print(f"\n[Tool Call] 正在列出所有 Confluence 頁面 ...")
    try:
        if not confluence:
            return "Confluence client is not initialized."

        # 使用 CQL 取得所有頁面，依標題排序，最多回傳 200 筆
        cql = "type = page ORDER BY title ASC"
        results = confluence.cql(cql, limit=200)

        output = []
        for item in results.get("results", []):
            content = item.get("content", {})
            page_id = content.get("id")
            title = content.get("title")
            full_url = _build_confluence_url(content.get("_links", {}).get("webui", ""))
            output.append(f"ID: {page_id} | Title: {title} | Link: [{title}]({full_url})")

        if not output:
            return "找不到任何 Confluence 頁面。"

        return f"共找到 {len(output)} 個頁面：\n" + "\n".join(output)
    except Exception as e:
        return f"列出頁面錯誤: {str(e)}"


@tool
def get_confluence_page_content(page_id: str) -> str:
    """
    獲取指定 Confluence 頁面的詳細內容。
    必須輸入 search_confluence_pages 返回的 Page ID。
    """
    print(f"\n[Tool Call] 正在讀取 Confluence 頁面: {page_id} ...")
    try:
        if not confluence:
             return "Confluence client is not initialized."

        page = confluence.get_page_by_id(page_id, expand='body.storage')
        if not page:
            return "找不到該頁面。"
            
        title = page.get("title")
        html_body = page.get("body", {}).get("storage", {}).get("value", "")
        
        full_url = _build_confluence_url(page.get("_links", {}).get("webui", ""))
        markdown_link = f"[{title}]({full_url})"
        
        # 清理 HTML
        text_content = clean_html(html_body)
        
        # 將長度限制放寬至 20000 字元，避免長表格或完整文章被腰斬
        truncated_content = text_content[:20000] + ("\n... [內容過長已截斷]" if len(text_content) > 20000 else "")
        
        return f"標題: {title}\n來源連結: {markdown_link}\n內容摘要:\n{truncated_content}"
    except Exception as e:
        return f"讀取錯誤: {str(e)}"


# 工具列表
confluence_tools = [search_confluence_pages, get_confluence_page_content, get_all_pages]

print("\n✅ Confluence Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in confluence_tools]}")
