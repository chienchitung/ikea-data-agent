import os
from trello import TrelloClient
from langchain.tools import tool
from dotenv import load_dotenv
import dateutil.parser

load_dotenv()

# --- 1. 設定與環境變數 ---
TARGET_BOARD_ID = os.getenv("TRELLO_BOARD_ID", "67fccfb26a69c06a792c59b2")
TARGET_BOARD_NAME = "IKEA Data Requests"

# Initialize Trello API
api_key = os.getenv("TRELLO_API_KEY")
token = os.getenv("TRELLO_TOKEN")

client = None
if api_key and token:
    try:
        client = TrelloClient(
            api_key=api_key,
            token=token
        )
    except Exception as e:
        print(f"Warning: Failed to initialize Trello client: {e}")

if client:
    print("\n✅ Trello 憑證已從 Environment Variables 載入")
    print(f"   Board ID: {TARGET_BOARD_ID}")
    print("✅ Trello 連線成功！")

# 3. 輔助函式：格式化日期
def format_date(date_obj):
    if not date_obj: return "無"
    try:
        if hasattr(date_obj, 'strftime'): return date_obj.strftime("%Y-%m-%d %H:%M")
        dt = dateutil.parser.parse(str(date_obj))
        return dt.strftime("%Y-%m-%d %H:%M")
    except: return str(date_obj)

def get_board_member_lookup(board):
    try:
        return {member.id: member.full_name for member in board.all_members()}
    except Exception:
        return {}

def get_card_member_names(card, member_lookup=None):
    member_ids = getattr(card, "member_ids", None) or getattr(card, "idMembers", [])
    member_lookup = member_lookup or {}
    return [member_lookup.get(member_id, member_id) for member_id in member_ids]

def format_card_details(card, member_lookup=None) -> str:
    raw_start = getattr(card, 'start', None)
    if raw_start is None and hasattr(card, '_json_obj'):
        raw_start = card._json_obj.get('start')
    raw_due = getattr(card, 'due', None)
    desc = getattr(card, 'description', '') or getattr(card, 'desc', '(無描述)')
    labels = [f"{l.name}" for l in card.labels if l.name]
    members = get_card_member_names(card, member_lookup)

    details = f"=== 卡片詳情: {card.name} ===\n"
    details += f"📁 List: {client.get_list(card.list_id).name}\n"
    details += f"👤 負責人: {', '.join(members) if members else '無'}\n"
    details += f"🏷️ Labels: {', '.join(labels) if labels else '無'}\n"
    details += f"📅 Start: {format_date(raw_start)} | Due: {format_date(raw_due)}\n"
    details += f"📝 Description:\n{desc}\n"

    comments = card.get_comments()
    details += "\n--- Comments ---\n"
    if comments:
        for comment in comments:
            author = comment.get('memberCreator', {}).get('fullName', 'Unknown')
            text = comment.get('data', {}).get('text', '')
            date = format_date(comment.get('date', ''))
            details += f"[{date}] {author}: {text}\n"
    else:
        details += "(無留言)\n"
    return details

# --- 4. 定義專用工具 ---

@tool
def get_project_status() -> str:
    """
    讀取 'IKEA Data Requests' 看板中所有的清單與卡片概覽。
    當用戶詢問「目前的進度」、「有哪些任務」或「待辦事項」時使用此工具。
    回傳預設只包含清單名稱與卡片名稱；不要把卡片 ID、標籤、負責人或日期當作概覽輸出。
    """
    if not client:
        return "Trello Client not initialized."
    
    try:
        # 直接使用鎖定的 ID
        board = client.get_board(TARGET_BOARD_ID)
        result = f"--- 專案看板: {board.name} ---\n"
        
        for lst in board.list_lists():
            result += f"\n[List: {lst.name}]\n"
            cards = lst.list_cards()
            if not cards: 
                result += "  (目前此清單為空，無任何卡片)\n"
            else:
                for card in cards:
                    result += f"  - {card.name}\n"
        return result
    except Exception as e:
        return f"讀取看板失敗: {e}"

@tool
def get_card_details(card_id: str) -> str:
    """
    讀取特定卡片的詳細內容。
    包含 Start/End Date, Labels 與所有留言 (Comments)。
    """
    if not client:
        return "Trello Client not initialized."
    
    try:
        card = client.get_card(card_id)
        board = client.get_board(card.board_id)
        return format_card_details(card, get_board_member_lookup(board))
    except Exception as e:
        return f"讀取卡片詳情失敗: {e}"

@tool
def get_card_details_by_name(card_name: str) -> str:
    """
    用卡片名稱搜尋並讀取特定卡片的詳細內容。
    當用戶追問某張卡片的標籤、分類、負責人、日期、描述或留言時使用此工具。
    """
    if not client:
        return "Trello Client not initialized."

    try:
        board = client.get_board(TARGET_BOARD_ID)
        member_lookup = get_board_member_lookup(board)
        all_cards = []
        for lst in board.list_lists():
            all_cards.extend(lst.list_cards())

        normalized_query = card_name.strip().lower()
        exact_matches = [card for card in all_cards if card.name.strip().lower() == normalized_query]
        partial_matches = [card for card in all_cards if normalized_query in card.name.strip().lower()]
        matches = exact_matches or partial_matches

        if not matches:
            return f"找不到名稱包含「{card_name}」的 Trello 卡片。"
        if len(matches) > 1:
            match_names = "\n".join(f"  - {card.name}" for card in matches[:10])
            return f"找到多張可能的卡片，請讓用戶指定其中一張：\n{match_names}"

        return format_card_details(matches[0], member_lookup)
    except Exception as e:
        return f"讀取卡片詳情失敗: {e}"

trello_tools = [get_project_status, get_card_details, get_card_details_by_name]

print("\n✅ Trello Agent 工具已就緒")
print(f"   可用工具: {[tool.name for tool in trello_tools]}")
