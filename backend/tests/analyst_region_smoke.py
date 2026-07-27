"""Smoke tests for the multi-spreadsheet ("region") routing added to
agents/analyst.py: the ticket-tracking sheet ("tickets", the original
single-spreadsheet behavior) now sits alongside two new App-metrics
spreadsheets ("TW", "HK"), selected via a `region` parameter threaded
through `_fetch_worksheet_records`, `list_worksheets`, and
`query_worksheet_data`.

No real Google Sheets access is exercised -- get_gspread_client is
monkeypatched with a fake client that just records which spreadsheet key
it was asked to open, so this only tests the routing/caching logic.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("GOOGLE_API_KEY", "dummy")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from agents import analyst


class FakeWorksheet:
    def __init__(self, rows):
        self._rows = rows

    def get_all_values(self):
        return self._rows


class FakeSpreadsheet:
    def __init__(self, key, worksheets):
        self.key = key
        self._worksheets = worksheets

    def worksheet(self, name):
        return self._worksheets[name]

    def worksheets(self):
        class _Title:
            def __init__(self, title):
                self.title = title
        return [_Title(name) for name in self._worksheets]


class FakeClient:
    """Records every open_by_key() call so tests can assert routing."""

    def __init__(self):
        self.opened_keys = []
        self._by_key = {}

    def register(self, key, spreadsheet):
        self._by_key[key] = spreadsheet

    def open_by_key(self, key):
        self.opened_keys.append(key)
        return self._by_key[key]


def _install_fake_client():
    fake_client = FakeClient()
    tickets_sheet = FakeSpreadsheet(analyst.SPREADSHEET_KEYS["tickets"], {
        "Request": FakeWorksheet([["Ticket No.", "Status"], ["1", "Open"]]),
    })
    tw_sheet = FakeSpreadsheet(analyst.SPREADSHEET_KEYS["TW"], {
        "Metrics List": FakeWorksheet([["Metric", "Definition"], ["DAU", "TW definition"]]),
        "02_App_ratings_daily": FakeWorksheet([["Date", "Rating"], ["2026-03-01", "4.5"]]),
    })
    hk_sheet = FakeSpreadsheet(analyst.SPREADSHEET_KEYS["HK"], {
        "Metrics List": FakeWorksheet([["Metric", "Definition"], ["DAU", "HK definition"]]),
    })
    fake_client.register(analyst.SPREADSHEET_KEYS["tickets"], tickets_sheet)
    fake_client.register(analyst.SPREADSHEET_KEYS["TW"], tw_sheet)
    fake_client.register(analyst.SPREADSHEET_KEYS["HK"], hk_sheet)

    original = analyst.get_gspread_client
    analyst.get_gspread_client = lambda: fake_client
    return fake_client, original


def test_resolve_spreadsheet_key_covers_all_three_regions():
    assert analyst._resolve_spreadsheet_key("tickets") == analyst.SPREADSHEET_KEYS["tickets"]
    assert analyst._resolve_spreadsheet_key("TW") == analyst.SPREADSHEET_KEYS["TW"]
    assert analyst._resolve_spreadsheet_key("HK") == analyst.SPREADSHEET_KEYS["HK"]
    try:
        analyst._resolve_spreadsheet_key("JP")
        assert False, "expected ValueError for an unknown region"
    except ValueError:
        pass
    print("PASS: _resolve_spreadsheet_key covers tickets/TW/HK and rejects unknown regions")


def test_fetch_worksheet_records_routes_to_the_right_spreadsheet():
    analyst._worksheet_fetch_cache.clear()
    fake_client, original = _install_fake_client()
    try:
        tw_rows = analyst._fetch_worksheet_records("Metrics List", region="TW")
        hk_rows = analyst._fetch_worksheet_records("Metrics List", region="HK")
        assert tw_rows == [{"Metric": "DAU", "Definition": "TW definition"}], tw_rows
        assert hk_rows == [{"Metric": "DAU", "Definition": "HK definition"}], hk_rows
        assert fake_client.opened_keys == [analyst.SPREADSHEET_KEYS["TW"], analyst.SPREADSHEET_KEYS["HK"]]
    finally:
        analyst.get_gspread_client = original
    print("PASS: same worksheet name in TW vs HK routes to the correct spreadsheet and doesn't cross-contaminate")


def test_fetch_worksheet_records_default_region_is_tickets():
    analyst._worksheet_fetch_cache.clear()
    fake_client, original = _install_fake_client()
    try:
        rows = analyst._fetch_worksheet_records("Request")
        assert rows == [{"Ticket No.": "1", "Status": "Open"}], rows
        assert fake_client.opened_keys == [analyst.SPREADSHEET_KEYS["tickets"]]
    finally:
        analyst.get_gspread_client = original
    print("PASS: omitting region defaults to the ticket-tracking spreadsheet (backward compatible)")


def test_cache_key_is_isolated_per_region():
    analyst._worksheet_fetch_cache.clear()
    fake_client, original = _install_fake_client()
    try:
        analyst._fetch_worksheet_records("Metrics List", region="TW")
        analyst._fetch_worksheet_records("Metrics List", region="TW")  # should hit cache, not re-open
        analyst._fetch_worksheet_records("Metrics List", region="HK")  # different region, must re-open
        assert fake_client.opened_keys == [analyst.SPREADSHEET_KEYS["TW"], analyst.SPREADSHEET_KEYS["HK"]], fake_client.opened_keys
    finally:
        analyst.get_gspread_client = original
    print("PASS: cache key includes region, so a repeat call for the same region is a cache hit while a different region still fetches")


def test_list_worksheets_tool_routes_by_region():
    fake_client, original = _install_fake_client()
    try:
        tw_result = analyst.list_worksheets.invoke({"region": "TW"})
        assert "02_App_ratings_daily" in tw_result, tw_result
        assert "Metrics List" in tw_result, tw_result
        default_result = analyst.list_worksheets.invoke({})
        assert "Request" in default_result, default_result
    finally:
        analyst.get_gspread_client = original
    print("PASS: list_worksheets tool opens the right spreadsheet for an explicit region and defaults to tickets")


def test_unknown_region_returns_error_string_not_exception():
    fake_client, original = _install_fake_client()
    try:
        result = analyst.list_worksheets.invoke({"region": "JP"})
        assert "Unknown region" in result or "Failed" in result, result
    finally:
        analyst.get_gspread_client = original
    print("PASS: an unknown region fails gracefully with an error string, not an unhandled exception")


def main_test():
    test_resolve_spreadsheet_key_covers_all_three_regions()
    test_fetch_worksheet_records_routes_to_the_right_spreadsheet()
    test_fetch_worksheet_records_default_region_is_tickets()
    test_cache_key_is_isolated_per_region()
    test_list_worksheets_tool_routes_by_region()
    test_unknown_region_returns_error_string_not_exception()
    print("analyst region-routing smoke tests passed")


if __name__ == "__main__":
    main_test()
