import sqlite3
import threading
from contextlib import closing
from pathlib import Path


class Repository:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        with self.lock, self.connection:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA busy_timeout=5000")
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS clients (
                    ip TEXT PRIMARY KEY,
                    requests INTEGER NOT NULL,
                    first_seen REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    version INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS clients_last_seen ON clients(last_seen);
                PRAGMA user_version=1;
            """)

    def record(self, records: list[tuple[str, float, int]]) -> None:
        with self.lock, self.connection:
            self.connection.executemany("""
                INSERT INTO clients(ip, requests, first_seen, last_seen, version)
                VALUES (?, 1, ?, ?, ?)
                ON CONFLICT(ip) DO UPDATE SET
                    requests = clients.requests + 1,
                    first_seen = min(clients.first_seen, excluded.first_seen),
                    last_seen = max(clients.last_seen, excluded.last_seen),
                    version = excluded.version
            """, [(ip, seen, seen, version) for ip, seen, version in records])

    def clients(self, search: str = "", limit: int | None = None, offset: int = 0) -> dict:
        with self.lock:
            total = self.connection.execute(
                "SELECT count(*) FROM clients WHERE instr(ip, ?) > 0", (search,)
            ).fetchone()[0]
            rows = self.connection.execute(
                "SELECT * FROM clients WHERE instr(ip, ?) > 0 "
                "ORDER BY last_seen DESC, ip LIMIT ? OFFSET ?",
                (search, limit if limit is not None else -1, offset),
            ).fetchall()
        return {"items": [dict(row) for row in rows], "total": total}

    def summary(self) -> dict:
        with self.lock:
            row = self.connection.execute(
                "SELECT count(*) AS clients, coalesce(sum(requests), 0) AS requests, "
                "max(last_seen) AS last_request FROM clients"
            ).fetchone()
        return dict(row)

    def backup(self, destination: str) -> None:
        with self.lock, closing(sqlite3.connect(destination)) as target:
            self.connection.backup(target)

    def close(self) -> None:
        with self.lock:
            self.connection.close()