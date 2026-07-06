from __future__ import annotations

import asyncio
import time

import main


def _extract_session_cookie(resp) -> str:
    set_cookie = resp.headers["set-cookie"]
    assert set_cookie.startswith("session=")
    return set_cookie.split(";", 1)[0].split("=", 1)[1]


def test_login_allows_when_auth_disabled(monkeypatch):
    monkeypatch.setattr(main, "_CONFIG", {"server": {"enable_auth": False}})
    monkeypatch.setattr(main, "_SESSION_SECRET", "test-secret")

    resp = asyncio.run(main.api_login(main._LoginBody(username="anyone", password="wrong")))

    assert resp.status_code == 200
    cookie = _extract_session_cookie(resp)
    assert main._verify_session(cookie) == "anyone"


def test_login_checks_configured_users_when_auth_enabled(monkeypatch):
    monkeypatch.setattr(
        main,
        "_CONFIG",
        {
            "server": {
                "enable_auth": True,
                "users": [{"username": "admin", "password": "changeme"}],
            }
        },
    )
    monkeypatch.setattr(main, "_SESSION_SECRET", "test-secret")

    ok = asyncio.run(main.api_login(main._LoginBody(username="admin", password="changeme")))
    bad = asyncio.run(main.api_login(main._LoginBody(username="admin", password="wrong")))

    assert ok.status_code == 200
    assert bad.status_code == 401
    assert main._verify_session(_extract_session_cookie(ok)) == "admin"


def test_session_cookie_cannot_be_forged(monkeypatch):
    monkeypatch.setattr(main, "_SESSION_SECRET", "test-secret")

    # 旧版固定值 cookie 与随意拼接的 cookie 都必须拒绝
    assert main._verify_session("authenticated") is None
    assert main._verify_session("admin.9999999999.deadbeef") is None
    assert main._verify_session(None) is None
    assert main._verify_session("") is None

    # 合法签名但已过期的会话必须拒绝
    expired = main._sign_session("admin", int(time.time()) - 10)
    assert main._verify_session(expired) is None

    # 合法且未过期的会话通过
    valid = main._sign_session("admin", int(time.time()) + 3600)
    assert main._verify_session(valid) == "admin"

    # 换密钥后旧会话立即失效
    monkeypatch.setattr(main, "_SESSION_SECRET", "another-secret")
    assert main._verify_session(valid) is None


def test_public_path_matching_is_strict():
    assert main._is_public_path("/login")
    assert main._is_public_path("/api/login")
    assert main._is_public_path("/app/")
    assert main._is_public_path("/app/index.html")
    assert main._is_public_path("/static/logo.png")
    # 同前缀但不同路径不能被放行
    assert not main._is_public_path("/loginxxx")
    assert not main._is_public_path("/api/loginfoo")
    assert not main._is_public_path("/apple")
    assert not main._is_public_path("/api/relics")
