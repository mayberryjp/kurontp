import json
import logging
import secrets
import sqlite3
import tempfile
import time
from pathlib import Path

from bottle import Bottle, HTTPError, request, response, static_file

from kuro.config import Settings
from kuro.db import Repository
from kuro.ntp import NTPService

log = logging.getLogger(__name__)
STATIC = Path(__file__).resolve().parents[1] / "static"


def create_app(settings: Settings, repository: Repository, service: NTPService) -> Bottle:
    app = Bottle()

    @app.hook("before_request")
    def authorize():
        request.environ["kuro.started"] = time.monotonic()
        if (request.method != "OPTIONS" and request.path.startswith("/api/")
                and request.path != "/api/session" and settings.admin_token):
            expected = f"Bearer {settings.admin_token}".encode()
            actual = request.headers.get("Authorization", "").encode()
            if not secrets.compare_digest(expected, actual):
                raise HTTPError(401, "A valid admin bearer token is required")

    @app.hook("after_request")
    def headers_and_log():
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
        )
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        duration = (time.monotonic() - request.environ.get("kuro.started", time.monotonic())) * 1000
        log.info("http method=%s path=%s status=%s duration_ms=%.2f",
                 request.method, request.path, response.status_code, duration)

    def error_handler(error):
        response.content_type = "application/json"
        codes = {400: "validation_error", 401: "unauthenticated", 404: "not_found",
                 405: "method_not_allowed", 500: "internal_error", 503: "not_ready"}
        message = "Internal server error" if error.status_code == 500 else str(error.body)
        if error.status_code == 500:
            log.error("http_failed exception=%r", error.exception)
        return json.dumps({"status": "error", "code": codes.get(error.status_code, "http_error"),
                           "error": message})

    for status_code in (400, 401, 403, 404, 405, 422, 429, 500, 503):
        app.error(status_code)(error_handler)

    @app.route("/<path:path>", method="OPTIONS")
    def options(path):
        return ""

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "kuro"}

    @app.get("/ready")
    def ready():
        try:
            repository.summary()
        except sqlite3.Error:
            raise HTTPError(503, "Database unavailable") from None
        if not service.synchronized() or not service.socket or service.writer_failed:
            raise HTTPError(503, "NTP listener, upstream synchronization, or tracking not ready")
        return {"status": "ok"}

    @app.get("/api/session")
    def session():
        return {"status": "ok", "authentication_required": bool(settings.admin_token)}

    @app.get("/api/status")
    def status():
        return {"status": "ok", **service.status(), "totals": repository.summary(),
                "configuration": {"upstreams": settings.upstream_hosts,
                                  "sync_interval": settings.sync_interval,
                                  "sync_max_age": settings.sync_max_age,
                                  "allowed_networks": settings.allowed_networks,
                                  "rate_limit": settings.rate_limit,
                                  "listen_address": settings.ntp_host}}

    @app.get("/api/clients")
    def clients():
        try:
            raw_limit = request.query.get("limit")
            limit = int(raw_limit) if raw_limit is not None else None
            offset = int(request.query.get("offset", "0"))
            if (limit is not None and limit < 1) or offset < 0:
                raise ValueError()
        except ValueError:
            raise HTTPError(400, "limit must be positive and offset must be non-negative") from None
        result = repository.clients(request.query.get("search", ""), limit, offset)
        for item in result["items"]:
            item["first_seen"] = format_time(item["first_seen"])
            item["last_seen"] = format_time(item["last_seen"])
        return {"status": "ok", **result}

    @app.get("/api/backup")
    def backup():
        with tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False) as descriptor:
            path = Path(descriptor.name)
        try:
            repository.backup(str(path))
        except Exception:
            path.unlink(missing_ok=True)
            raise
        response.content_type = "application/vnd.sqlite3"
        response.headers["Content-Disposition"] = 'attachment; filename="kuro-backup.sqlite3"'
        response.headers["Content-Length"] = str(path.stat().st_size)

        def chunks():
            try:
                with path.open("rb") as source:
                    while chunk := source.read(65536):
                        yield chunk
            finally:
                path.unlink(missing_ok=True)

        return chunks()

    @app.get("/")
    def index():
        response.headers["Cache-Control"] = "no-cache"
        return static_file("index.html", root=str(STATIC))

    @app.get("/assets/<path:path>")
    def assets(path):
        return static_file(path, root=str(STATIC / "assets"),
                           headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.get("/<path:path>")
    def not_found(path):
        raise HTTPError(404, "Not found")

    return app


def format_time(timestamp: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(timestamp, UTC).isoformat()