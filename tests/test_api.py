import sqlite3

import pytest
from webtest import TestApp

from kuro.api.app import create_app
from kuro.config import Settings
from kuro.db import Repository
from kuro.ntp import NTPService


@pytest.fixture
def api(tmp_path):
    settings = Settings(database_path=str(tmp_path / "api.db"))
    repository = Repository(settings.database_path)
    service = NTPService(settings, repository)
    yield TestApp(create_app(settings, repository, service)), repository, service
    repository.close()


def test_health_ready_and_json_errors(api):
    app, repository, _service = api
    assert app.get("/health").json["status"] == "ok"
    assert app.get("/ready", status=503).json["code"] == "not_ready"
    assert app.get("/missing", status=404).json["code"] == "not_found"
    repository.close()
    assert app.get("/ready", status=503).json["error"] == "Database unavailable"


def test_public_api_cors_and_pagination(api):
    app, repository, _service = api
    assert app.get("/api/status").json["status"] == "ok"
    assert "admin_token" not in Settings.model_fields
    app.get("/api/session", status=404)
    assert app.options("/api/status").headers["Access-Control-Allow-Origin"] == "*"
    repository.record([("10.0.0.1", 100.0, 4), ("10.0.0.2", 101.0, 3)])
    result = app.get("/api/clients").json
    assert len(result["items"]) == 2
    assert result["items"][0]["last_seen"].endswith("+00:00")
    assert len(app.get("/api/clients?limit=1").json["items"]) == 1
    assert app.get("/api/clients?search=0.2").json["total"] == 1
    app.get("/api/clients?limit=bad", status=400)
    app.get("/api/clients?offset=-1", status=400)
    app.get("/api/clients?limit=0", status=400)
    assert app.get("/api/status").json["totals"]["requests"] == 2


def test_backup_is_valid_sqlite(api, tmp_path):
    app, repository, _service = api
    repository.record([("10.1.2.3", 123.0, 4)])
    result = app.get("/api/backup")
    assert result.content_type == "application/vnd.sqlite3"
    path = tmp_path / "backup.db"
    path.write_bytes(result.body)
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT ip FROM clients").fetchone()[0] == "10.1.2.3"