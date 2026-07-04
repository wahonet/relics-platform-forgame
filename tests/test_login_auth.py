from __future__ import annotations

import asyncio

import main


def test_login_allows_when_auth_disabled(monkeypatch):
    monkeypatch.setattr(main, "_CONFIG", {"server": {"enable_auth": False}})

    resp = asyncio.run(main.api_login(main._LoginBody(username="anyone", password="wrong")))

    assert resp.status_code == 200
    assert "session=authenticated" in resp.headers["set-cookie"]


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

    ok = asyncio.run(main.api_login(main._LoginBody(username="admin", password="changeme")))
    bad = asyncio.run(main.api_login(main._LoginBody(username="admin", password="wrong")))

    assert ok.status_code == 200
    assert bad.status_code == 401
