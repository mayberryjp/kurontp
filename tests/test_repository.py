import sqlite3

from kuro.db import Repository


def test_client_counts_survive_restart_and_backup(tmp_path):
    path = str(tmp_path / "kuro.db")
    repository = Repository(path)
    repository.record([("192.168.1.5", 100.0, 4), ("192.168.1.5", 120.0, 4)])
    repository.record([("192.168.1.6", 130.0, 3)])
    repository.close()
    repository = Repository(path)
    client = repository.clients(search="1.5")["items"][0]
    assert client == {"ip": "192.168.1.5", "requests": 2, "first_seen": 100.0,
                      "last_seen": 120.0, "version": 4}
    assert repository.summary()["requests"] == 3
    assert len(repository.clients(limit=1)["items"]) == 1
    backup = str(tmp_path / "backup.db")
    repository.backup(backup)
    with sqlite3.connect(backup) as connection:
        assert connection.execute("SELECT sum(requests) FROM clients").fetchone()[0] == 3
    repository.close()