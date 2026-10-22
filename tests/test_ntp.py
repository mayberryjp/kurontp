import logging
import socket
import time

import ntplib
import pytest
from pydantic import ValidationError

from kuro.config import Settings
from kuro.db import Repository
from kuro.ntp import ClockSample, NTPService, query_upstream


@pytest.mark.parametrize(("value", "expected"), [
    ("0", 0), ("10", 10), ("20", 20), ("50", 50),
    ("INFO", 20), ("debug", 10), (" warning ", 30), ("WARN", 30), ("FATAL", 50),
])
def test_log_level_environment_variable(monkeypatch, value, expected):
    monkeypatch.setenv("LOG_LEVEL", value)
    settings = Settings()
    logger = logging.Logger("test-log-level")
    logger.setLevel(settings.log_level)
    assert logger.level == expected


@pytest.mark.parametrize("value", ["", "verbose", "-1", "1.5"])
def test_invalid_log_level_environment_variable(monkeypatch, value):
    monkeypatch.setenv("LOG_LEVEL", value)
    with pytest.raises(ValidationError, match="LOG_LEVEL must be"):
        Settings()


def test_servers_environment_variable(monkeypatch):
    monkeypatch.setenv("NTP_SERVERS", "time.example.com, 192.0.2.1,time.example.com")
    assert Settings().upstream_hosts == ["time.example.com", "192.0.2.1"]
    monkeypatch.setenv("NTP_SERVERS", " , ")
    with pytest.raises(ValidationError, match="NTP_SERVERS must contain at least one hostname"):
        Settings()


def service(tmp_path, **overrides):
    settings = Settings(database_path=str(tmp_path / "test.db"), ntp_port=0, **overrides)
    return NTPService(settings, Repository(settings.database_path))


def request_packet(version=4):
    return ntplib.NTPPacket(version=version, mode=3,
                            tx_timestamp=ntplib.system_to_ntp_time(time.time())).to_data()


def sample():
    return ClockSample("test", "127.0.0.1", time.time(), time.monotonic(),
                       0.001, 0.002, 0.001, 0.001, 3, 0, 0x7F000001)


def test_unsynced_synced_and_stale_replies(tmp_path):
    server = service(tmp_path, sync_max_age=1)
    packet = request_packet()
    reply = ntplib.NTPPacket()
    reply.from_data(server.response(packet, "127.0.0.1", server.now()))
    assert (reply.leap, reply.stratum, reply.mode) == (3, 16, 4)
    server.sample = sample()
    payload = server.response(packet, "127.0.0.1", server.now())
    reply.from_data(payload)
    assert (reply.leap, reply.stratum) == (0, 3)
    assert payload[24:32] == packet[40:48]
    server.sample = ClockSample(**{**vars(sample()), "monotonic": time.monotonic() - 2})
    reply.from_data(server.response(packet, "127.0.0.1", server.now()))
    assert (reply.leap, reply.stratum) == (3, 16)
    server.close()
    assert server.repository.summary()["requests"] == 3
    server.repository.close()


def test_acl_malformed_rate_limits_and_tracking(tmp_path):
    server = service(tmp_path, rate_limit=1)
    packet = request_packet()
    assert server.response(b"bad", "127.0.0.1", time.time()) is None
    assert server.response(packet, "8.8.8.8", time.time()) is None
    assert server.response(request_packet(2), "127.0.0.1", time.time()) is None
    assert server.response(packet, "127.0.0.1", time.time())
    assert server.response(packet, "127.0.0.1", time.time()) is None
    server.flush()
    assert server.repository.summary()["requests"] == 2
    assert server.metrics["rate_limited"] == 1
    server.close()
    server.repository.close()


def test_real_udp_exchange_and_upstream_client(tmp_path, monkeypatch):
    server = service(tmp_path)
    server.sample = sample()
    monkeypatch.setattr(server, "sync_loop", lambda: None)
    server.start()
    try:
        port = server.status()["port"]
        stats, address = query_upstream("127.0.0.1", port, 1)
        assert stats.stratum == 3
        assert address == "127.0.0.1"
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.settimeout(1)
            connection.sendto(request_packet(3), ("127.0.0.1", port))
            payload, _ = connection.recvfrom(512)
            assert len(payload) == 48
    finally:
        server.close()
    assert server.repository.summary()["requests"] == 2
    server.repository.close()


def test_upstream_failover_and_holdover(tmp_path, monkeypatch):
    server = service(tmp_path, upstreams="bad,good")
    stats = ntplib.NTPStats()
    stats.stratum = 2
    stats.dest_timestamp = ntplib.system_to_ntp_time(time.time())
    stats.orig_timestamp = stats.dest_timestamp - 0.01
    stats.recv_timestamp = stats.dest_timestamp - 0.005
    stats.tx_timestamp = stats.recv_timestamp

    def query(host, port, timeout):
        if host == "bad":
            raise OSError("unavailable")
        return stats, "127.0.0.1"

    monkeypatch.setattr("kuro.ntp.query_upstream", query)
    server.sync_once()
    assert server.synchronized()
    assert server.sample.host == "good"
    assert server.upstreams[0]["status"] == "unreachable"
    monkeypatch.setattr("kuro.ntp.query_upstream", lambda *args: (_ for _ in ()).throw(OSError()))
    server.sync_once()
    assert server.synchronized()
    server.close()
    server.repository.close()