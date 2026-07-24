"""Smoke tests for classify_chat_error_text (main.py):

Regression coverage for a real bug: a generation timeout or 503 "model
overloaded" error was being misclassified as ai_provider_unavailable
("check your GOOGLE_API_KEY / GEMINI_API_KEY") just because the error
message happened to mention "gemini" and started with "error processing
request" — misleading, since the actual cause has nothing to do with API
key configuration. Timeout/overload now gets its own
model_overloaded_or_timeout code with accurate copy, and the API-key
classification requires an actual auth signal.

No Gemini API key, network access, or the full agent stack is required —
this only exercises classify_chat_error_text, a pure function.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("GOOGLE_API_KEY", "dummy")

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main


def test_timeout_is_not_misclassified_as_api_key_error():
    err = main.classify_chat_error_text(
        "Error processing request: 504 Deadline Exceeded while calling gemini-3.6-flash",
        "zh",
    )
    assert err["code"] == "model_overloaded_or_timeout", err
    print("PASS: deadline-exceeded timeout classified as model_overloaded_or_timeout")


def test_503_overload_is_not_misclassified_as_api_key_error():
    err = main.classify_chat_error_text(
        "Error processing request: 503 The model is overloaded. Please try again later. (gemini)",
        "zh",
    )
    assert err["code"] == "model_overloaded_or_timeout", err
    print("PASS: 503 overload classified as model_overloaded_or_timeout")


def test_resource_exhausted_429_is_overload_not_api_key():
    err = main.classify_chat_error_text(
        "Error processing request: 429 RESOURCE_EXHAUSTED for gemini-3.6-flash",
        "en",
    )
    assert err["code"] == "model_overloaded_or_timeout", err
    print("PASS: 429 resource-exhausted classified as model_overloaded_or_timeout")


def test_genuine_invalid_api_key_still_classified_correctly():
    err = main.classify_chat_error_text(
        "Error processing request: 400 API key not valid. Please pass a valid API key.",
        "zh",
    )
    assert err["code"] == "ai_provider_unavailable", err
    print("PASS: genuine invalid API key still classified as ai_provider_unavailable")


def test_missing_api_key_still_classified_correctly():
    err = main.classify_chat_error_text(
        "Error processing request: GOOGLE_API_KEY is not set",
        "zh",
    )
    assert err["code"] == "ai_provider_unavailable", err
    print("PASS: missing GOOGLE_API_KEY still classified as ai_provider_unavailable")


def test_unrelated_error_falls_through_to_agent_runtime_error():
    err = main.classify_chat_error_text(
        "Error processing request: something else entirely broke",
        "zh",
    )
    assert err["code"] == "agent_runtime_error", err
    print("PASS: unrelated errors still fall through to agent_runtime_error")


def test_no_error_text_returns_none():
    assert main.classify_chat_error_text("", "en") is None
    assert main.classify_chat_error_text("A perfectly normal answer.", "en") is None
    print("PASS: non-error text returns None")


def main_test():
    test_timeout_is_not_misclassified_as_api_key_error()
    test_503_overload_is_not_misclassified_as_api_key_error()
    test_resource_exhausted_429_is_overload_not_api_key()
    test_genuine_invalid_api_key_still_classified_correctly()
    test_missing_api_key_still_classified_correctly()
    test_unrelated_error_falls_through_to_agent_runtime_error()
    test_no_error_text_returns_none()
    print("chat error classification smoke tests passed")


if __name__ == "__main__":
    main_test()
