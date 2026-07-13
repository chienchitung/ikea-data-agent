"""Smoke tests for the latency/504 fixes:

- _requested_year_for_ticket_query: month/quarter-scoped queries must not
  trigger the full-year audit; genuine year-level asks still do.
- _needs_llm_verification: answers without factual claims skip the LLM
  verification round trip.
- query_worksheet_data detail output is capped at 150 rows with a note.
- _fetch_worksheet_records: worksheet fetches are cached for the TTL and
  refetched after it expires.

No Gemini API key, Sheets credentials, or network access is required.
"""

import os
import sys
import time
from datetime import datetime
from pathlib import Path

os.environ.setdefault("GOOGLE_API_KEY", "dummy")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import agent_logic
from agents import analyst


def test_year_audit_trigger():
    this_year = datetime.now().year
    cases = [
        ("請根據這幾個構面分類，將今年4,5,6月的所有需求工單列出之後進行分類", None),
        ("今年的工單有多少", this_year),
        ("2025年的需求工單分佈", 2025),
        ("今年Q2的工單", None),
        ("今年第二季的需求", None),
        ("今年1月到12月的工單分佈", this_year),
        ("列出全年工單", this_year),
        ("今年10月的ticket", None),
        ("天氣如何", None),
        # 半年/H1H2 也是子年度範圍，不該觸發全年稽核。
        ("請提供一份2026年上半年所有需求工單的分析報告", None),
        ("2025年下半年的工單統計", None),
        ("今年 H1 的需求工單", None),
        # HFB05 這種產品代號裡的 H 不能被誤認成 H1/H2。
        ("今年 NHS HFB05 相關的需求工單", this_year),
    ]
    for query, expected in cases:
        got = agent_logic._requested_year_for_ticket_query(query)
        assert got == expected, f"{query!r}: got {got}, expected {expected}"
    print("PASS: year-audit trigger skips month/quarter-scoped queries")


def test_verification_gate():
    confluence_context = "[search_confluence_pages]\nCDP 是客戶資料平台，整合多來源的顧客輪廓。"
    cases = [
        ("好的，我可以幫你整理資料，請告訴我範圍。", "tool output", False),
        ("4月有 12 筆工單，5月有 8 筆。", "tool output", True),
        ("| Ticket | Status |", "tool output", True),
        ("```chart\n{}\n```", "tool output", True),
        ("4月有 12 筆工單", "", False),
        # 知識庫（Confluence/PDF 工具）來源的敘述性回答即使沒有數字也要驗證。
        ("CDP 是客戶資料平台，用來整合顧客輪廓。", confluence_context, True),
        ("這份文件說明入職流程。", "[search_document_base]\n入職流程文件內容", True),
    ]
    for response, source, expected in cases:
        got = agent_logic._needs_llm_verification(response, source)
        assert got == expected, f"{response[:20]!r}: got {got}, expected {expected}"
    print("PASS: verification gate skips answers without factual claims")


def test_detail_row_cap():
    records = [
        {
            "Ticket No.": f"REQ{i:04d}",
            "Subject": f"需求 {i}",
            "Status": "Closed",
            "Department": "Marketing",
        }
        for i in range(200)
    ]
    original = analyst._fetch_worksheet_records
    analyst._fetch_worksheet_records = lambda name: records
    try:
        output = analyst.query_worksheet_data.invoke({
            "worksheet_name": "Request",
            "query_description": "列出全部明細",
            "wants_detail_rows": True,
        })
    finally:
        analyst._fetch_worksheet_records = original

    assert "Data Details (200 rows)" in output, output[:400]
    assert "showing first 150 of 200 rows" in output, output[-400:]
    assert output.count("REQ01") > 0
    assert "REQ0149" in output and "REQ0150" not in output
    print("PASS: detail table capped at 150 rows with truncation note")


def test_worksheet_fetch_ttl_cache():
    fetch_count = [0]

    class _FakeWorksheet:
        def get_all_values(self):
            fetch_count[0] += 1
            return [["Ticket No."], ["REQ0001"]]

    class _FakeSpreadsheet:
        def worksheet(self, name):
            return _FakeWorksheet()

    class _FakeClient:
        def open_by_key(self, key):
            return _FakeSpreadsheet()

    original_client = analyst.get_gspread_client
    analyst.get_gspread_client = lambda: _FakeClient()
    analyst._worksheet_fetch_cache.clear()
    try:
        first = analyst._fetch_worksheet_records("Request")
        second = analyst._fetch_worksheet_records("Request")
        assert first == second == [{"Ticket No.": "REQ0001"}]
        assert fetch_count[0] == 1, f"expected 1 fetch within TTL, got {fetch_count[0]}"

        # Expire the cache entry and confirm a refetch happens.
        fetched_at, cached_records = analyst._worksheet_fetch_cache["Request"]
        analyst._worksheet_fetch_cache["Request"] = (
            fetched_at - analyst.SHEETS_CACHE_TTL_SECONDS - 1,
            cached_records,
        )
        analyst._fetch_worksheet_records("Request")
        assert fetch_count[0] == 2, f"expected refetch after TTL, got {fetch_count[0]}"
    finally:
        analyst.get_gspread_client = original_client
        analyst._worksheet_fetch_cache.clear()
    print("PASS: worksheet fetch cached within TTL and refetched after expiry")


if __name__ == "__main__":
    test_year_audit_trigger()
    test_verification_gate()
    test_detail_row_cap()
    test_worksheet_fetch_ttl_cache()
    print("latency fixes smoke tests passed")
