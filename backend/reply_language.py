"""回覆語言判斷的共用核心。

先前 agent_logic.py 與 agents/coordinator.py 各有一份複製的啟發式，
規則是「english_chars > cjk_count * 1.5 → English」。這對「中文提問
夾帶英文名詞」的訊息會誤判：例如使用者用中文請求分類、但列出四個
英文分類名（Dashboard Development & Optimization…），英文字母數
輕易輾壓中文字數，整篇回覆就變英文。

這裡改成「中文偏置」：寫中文句子的人夾英文領域名詞（分類名、欄位名、
工具名）極常見，寫英文的人夾中文字極罕見，所以只要出現足以構成中文
片語的字數就判中文，不跟英文字母比多寡。
"""

import re

REPLY_LANGUAGE_CHINESE = "Traditional Chinese"
REPLY_LANGUAGE_ENGLISH = "English"

# turn_context.reply_language 的合法值 → 對外語言標籤
_REPLY_LANGUAGE_ALIASES = {
    "zh-tw": REPLY_LANGUAGE_CHINESE,
    "zh": REPLY_LANGUAGE_CHINESE,
    "zh-hant": REPLY_LANGUAGE_CHINESE,
    "traditional chinese": REPLY_LANGUAGE_CHINESE,
    "chinese": REPLY_LANGUAGE_CHINESE,
    "en": REPLY_LANGUAGE_ENGLISH,
    "en-us": REPLY_LANGUAGE_ENGLISH,
    "english": REPLY_LANGUAGE_ENGLISH,
}


def detect_reply_language_text(text: str) -> str:
    """以中文偏置的啟發式判斷回覆語言。呼叫端自行做前置清理。"""
    cleaned = str(text or "").strip()
    if not cleaned:
        return REPLY_LANGUAGE_CHINESE

    cjk_count = len(re.findall(r"[\u3400-\u9fff]", cleaned))
    english_words = re.findall(r"[A-Za-z]{2,}", cleaned)
    english_chars = sum(len(word) for word in english_words)

    if cjk_count == 0:
        return REPLY_LANGUAGE_ENGLISH if english_chars > 0 else REPLY_LANGUAGE_CHINESE
    if cjk_count >= 4:
        # 足以構成中文片語＝使用者在說中文，夾帶再多英文名詞也不改判。
        return REPLY_LANGUAGE_CHINESE
    # 只有 1~3 個中文字：多半是英文句子引用一個中文標籤
    # （例如 list tickets with status 已完成）。
    return REPLY_LANGUAGE_ENGLISH if english_chars >= 12 else REPLY_LANGUAGE_CHINESE


def normalize_reply_language(value) -> str:
    """把 LLM 判定的 reply_language（zh-TW / en 及常見別名）正規化成
    對外語言標籤；非法或空值回傳空字串，表示交給啟發式 fallback。"""
    return _REPLY_LANGUAGE_ALIASES.get(str(value or "").strip().lower(), "")
