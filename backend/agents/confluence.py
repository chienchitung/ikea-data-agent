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


# --- 定義給 Agent 使用的工具 (Tools) ---

@tool
def search_confluence_pages(query: str) -> str:
    """
    當不知道確切頁面標題時，使用此工具搜索 Confluence 頁面。
    輸入關鍵字，返回相關頁面的 ID、標題和完整連結。
    """
    print(f"\n[Tool Call] 正在搜尋 Confluence: {query} ...")
    try:
        if not confluence:
             return "Confluence client is not initialized."
             
        # 使用 CQL 進行全文搜索 (text ~ query) 而不僅是標題搜索
        # 改進：移除特定的 space 限制（以搜尋完整系統），並將含有空格的字串以更寬鬆的方式比對
        # 如果 user 的關鍵字包含空格（如 "7 customer segments"），直接用精確比對與模糊比對
        if " " in query:
            cql = f'(title ~ "{query}" OR text ~ "{query}")'
        else:
            cql = f'(title ~ "{query}*" OR text ~ "{query}*")'
            
        # 如果你只限於 idtt 空間，請將上方改成 cql = f'space = "idtt" AND ' + cql
        # 這裡為了解決找不到其他頁面，先幫你開放為全域搜尋，或你可以自行加回 space 的條件
        
        # 增加 limit 到 10 以利查找更多相關頁面
        results = confluence.cql(cql, limit=10)

        output = []
        base_url = os.getenv("CONFLUENCE_URL", "").rstrip('/')
        
        for item in results.get("results", []):
            content = item.get("content", {})
            page_id = content.get("id")
            title = content.get("title")
            
            # 獲取 webui link，處理 URL 結構
            webui = content.get("_links", {}).get("webui", "")
            
            # 強制確保路徑以 /wiki 開頭
            if not webui.startswith("/wiki"):
                webui = f"/wiki{webui}" if webui.startswith("/") else f"/wiki/{webui}"
                
            full_url = f"{base_url}{webui}"
            
            # 預先組裝 Markdown Link，方便 Agent 直接使用
            markdown_link = f"[{title}]({full_url})"
            
            # 標記是否為標題完全匹配（高優先級）
            match_tag = "[⭐️標題匹配]" if query.lower() in title.lower() else ""
            
            output.append(f"ID: {page_id} | {match_tag} Title: {title} | Link: {markdown_link}")

        return "\n".join(output) if output else "⚠️ 【系統警告】Confluence 中完全找不到相關頁面！你必須直接告訴使用者「找不到相關文件」，絕對不能憑空編造標題或連結！"
    except Exception as e:
        return f"搜尋錯誤: {str(e)}"

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
        
        # 獲取 URL
        base_url = os.getenv("CONFLUENCE_URL", "").rstrip('/')
        webui = page.get("_links", {}).get("webui", "")
        
        # 強制確保路徑以 /wiki 開頭
        if not webui.startswith("/wiki"):
             webui = f"/wiki{webui}" if webui.startswith("/") else f"/wiki/{webui}"
             
        full_url = f"{base_url}{webui}"
        markdown_link = f"[{title}]({full_url})"
        
        # 清理 HTML
        text_content = clean_html(html_body)
        
        # 將長度限制放寬至 20000 字元，避免長表格或完整文章被腰斬
        truncated_content = text_content[:20000] + ("\n... [內容過長已截斷]" if len(text_content) > 20000 else "")
        
        return f"標題: {title}\n來源連結: {markdown_link}\n內容摘要:\n{truncated_content}"
    except Exception as e:
        return f"讀取錯誤: {str(e)}"


# 工具列表
confluence_tools = [search_confluence_pages, get_confluence_page_content]

print("\n✅ Confluence Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in confluence_tools]}")
