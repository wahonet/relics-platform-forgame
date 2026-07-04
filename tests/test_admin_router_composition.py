from __future__ import annotations

from routers import admin


def test_admin_router_includes_relic_subrouter_paths():
    paths = {getattr(route, "path", "") for route in admin.router.routes}

    assert "/admin/relics" in paths
    assert "/admin/relics-export" in paths
    assert "/admin/stats-overview" in paths
    assert "/admin/audit" in paths
