import ipaddress
import logging
import math
import queue
import socket
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

import ntplib

from kuro.config import Settings
from kuro.db import Repository

log = logging.getLogger(__name__)


def query_upstream(host: str, port: int, timeout: float):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)
    last_error: Exception = OSError("No upstream addresses")
    for family, kind, protocol, _, address in addresses:
        try:
            with socket.socket(family, kind, protocol) as connection:
                connection.settimeout(timeout)
                connection.connect(address)
                sent = time.time()
                started = time.monotonic()
                packet = ntplib.NTPPacket(version=4, mode=3,
                                          tx_timestamp=ntplib.system_to_ntp_time(sent))
                payload = packet.to_data()
                connection.send(payload)
                data = connection.recv(512)
                received = time.time()
                elapsed = time.monotonic() - started
                stats = ntplib.NTPStats()
                stats.from_data(data)
                stats.dest_timestamp = ntplib.system_to_ntp_time(received)
                if (len(data) < 48 or data[24:32] != payload[40:48]
                        or stats.mode != 4 or stats.version not in (3, 4)
                        or stats.leap == 3 or not 1 <= stats.stratum <= 14
                        or stats.tx_timestamp == 0 or stats.recv_timestamp == 0
                        or abs(received - sent - elapsed) > 0.1
                        or not math.isfinite(stats.offset) or not -0.001 <= stats.delay <= 5
                        or not 0 <= stats.root_delay <= 10 or stats.root_dispersion > 10):
                    raise ValueError("Invalid or unsynchronized upstream reply")
                return stats, address[0]
        except (OSError, ntplib.NTPException, ValueError) as error:
            last_error = error
    raise last_error


@dataclass(frozen=True)
class ClockSample:
    host: str
    address: str
    unix: float
    monotonic: float
    offset: float
    delay: float
    dispersion: float
    root_delay: float
    stratum: int
    leap: int
    reference_id: int


class NTPService:
    def __init__(self, settings: Settings, repository: Repository):
        self.settings = settings
        self.repository = repository
        self.sample: ClockSample | None = None
        self.upstreams: list[dict] = [
            {"host": host, "status": "pending"} for host in settings.upstream_hosts
        ]
        self.stop_event = threading.Event()
        self.events: queue.Queue[tuple[str, float, int]] = queue.Queue(maxsize=10000)
        self.networks = [ipaddress.ip_network(part.strip())
                         for part in settings.allowed_networks.split(",") if part.strip()]
        self.rates: OrderedDict[str, tuple[int, int]] = OrderedDict()
        self.metrics = {"rejected": 0, "rate_limited": 0, "tracking_dropped": 0, "replies": 0}
        self.threads: list[threading.Thread] = []
        self.socket: socket.socket | None = None
        self.started = time.monotonic()
        self.writer_failed = False

    def synchronized(self) -> bool:
        sample = self.sample
        return sample is not None and time.monotonic() - sample.monotonic < self.settings.sync_max_age

    def now(self) -> float:
        sample = self.sample
        return (sample.unix + time.monotonic() - sample.monotonic) if sample else time.time()

    def status(self) -> dict:
        sample = self.sample
        return {
            "synchronized": self.synchronized(),
            "stratum": sample.stratum if self.synchronized() and sample else 16,
            "selected_upstream": sample.host if sample else None,
            "offset_ms": sample.offset * 1000 if sample else None,
            "delay_ms": sample.delay * 1000 if sample else None,
            "sync_age_seconds": time.monotonic() - sample.monotonic if sample else None,
            "uptime_seconds": time.monotonic() - self.started,
            "listening": self.socket is not None,
            "port": self.socket.getsockname()[1] if self.socket else self.settings.ntp_port,
            "tracking_healthy": not self.writer_failed,
            "tracking_queue": self.events.qsize(),
            "metrics": dict(self.metrics),
            "upstreams": self.upstreams,
        }

    def sync_once(self) -> None:
        candidates = []
        upstreams = []
        for host in self.settings.upstream_hosts:
            if self.stop_event.is_set():
                return
            try:
                stats, address = query_upstream(host, self.settings.upstream_port,
                                                self.settings.upstream_timeout)
                reference_id = (int(ipaddress.ip_address(address))
                                if ":" not in address else 0x4B55524F)
                sample = ClockSample(
                    host, address, time.time() + stats.offset, time.monotonic(),
                    stats.offset, stats.delay, stats.root_dispersion, stats.root_delay,
                    stats.stratum + 1, stats.leap, reference_id,
                )
                candidates.append(sample)
                upstreams.append({"host": host, "address": address, "status": "reachable",
                                  "stratum": stats.stratum, "offset_ms": stats.offset * 1000,
                                  "delay_ms": stats.delay * 1000})
            except (OSError, ntplib.NTPException, ValueError):
                log.warning("upstream_unavailable host=%s", host)
                upstreams.append({"host": host, "status": "unreachable"})
        if candidates:
            self.sample = min(candidates, key=lambda candidate: candidate.delay)
        self.upstreams = upstreams

    def sync_loop(self) -> None:
        while not self.stop_event.is_set():
            self.sync_once()
            self.stop_event.wait(self.settings.sync_interval)

    def response(self, data: bytes, ip: str, received: float) -> bytes | None:
        if len(data) != 48 or not any(ipaddress.ip_address(ip) in net for net in self.networks):
            self.metrics["rejected"] += 1
            return None
        packet = ntplib.NTPPacket()
        packet.from_data(data)
        if packet.mode != 3 or packet.version not in (3, 4) or packet.tx_timestamp == 0:
            self.metrics["rejected"] += 1
            return None
        try:
            self.events.put_nowait((ip, time.time(), packet.version))
        except queue.Full:
            self.metrics["tracking_dropped"] += 1
        window = int(time.monotonic())
        previous_window, count = self.rates.pop(ip, (window, 0))
        count = count + 1 if previous_window == window else 1
        self.rates[ip] = (window, count)
        if len(self.rates) > 4096:
            self.rates.popitem(last=False)
        if count > self.settings.rate_limit:
            self.metrics["rate_limited"] += 1
            return None
        reply = ntplib.NTPPacket(version=packet.version, mode=4)
        sample = self.sample
        synced = self.synchronized()
        reply.leap = sample.leap if synced and sample else 3
        reply.stratum = sample.stratum if synced and sample else 16
        reply.poll = max(4, min(packet.poll, 17))
        reply.precision = -20
        reply.ref_id = sample.reference_id if sample else 0
        reply.root_delay = max(0, sample.root_delay + sample.delay) if sample else 0
        reply.root_dispersion = min(65535, sample.dispersion + sample.delay / 2
                                    + (time.monotonic() - sample.monotonic) * 0.000015
                                    ) if sample else 0
        reply.ref_timestamp = ntplib.system_to_ntp_time(sample.unix) if sample else 0
        reply.orig_timestamp = packet.tx_timestamp
        reply.recv_timestamp = ntplib.system_to_ntp_time(received)
        reply.tx_timestamp = ntplib.system_to_ntp_time(self.now())
        payload = reply.to_data()
        return payload[:24] + data[40:48] + payload[32:]

    def listen_loop(self) -> None:
        connection = self.socket
        if connection is None:
            raise RuntimeError("NTP socket must be bound before starting the listener")
        while not self.stop_event.is_set():
            try:
                data, address = connection.recvfrom(1024)
                received = self.now()
                payload = self.response(data, address[0], received)
                if payload:
                    connection.sendto(payload, address)
                    self.metrics["replies"] += 1
            except TimeoutError:
                continue
            except (OSError, ntplib.NTPException):
                if not self.stop_event.is_set():
                    log.exception("ntp_packet_failed")

    def flush(self) -> None:
        records: list[tuple[str, float, int]] = []
        while len(records) < 10000:
            try:
                records.append(self.events.get_nowait())
            except queue.Empty:
                break
        if records:
            try:
                self.repository.record(records)
                self.writer_failed = False
            except Exception:
                self.writer_failed = True
                self.metrics["tracking_dropped"] += len(records)
                log.exception("tracking_write_failed")

    def writer_loop(self) -> None:
        while not self.stop_event.wait(0.5):
            self.flush()

    def start(self) -> None:
        family = socket.AF_INET6 if ":" in self.settings.ntp_host else socket.AF_INET
        connection = socket.socket(family, socket.SOCK_DGRAM)
        try:
            connection.bind((self.settings.ntp_host, self.settings.ntp_port))
            connection.settimeout(0.5)
        except OSError:
            connection.close()
            raise
        self.socket = connection
        for target in (self.sync_loop, self.listen_loop, self.writer_loop):
            thread = threading.Thread(target=target, daemon=True, name=target.__name__)
            self.threads.append(thread)
            thread.start()

    def close(self) -> None:
        self.stop_event.set()
        for thread in self.threads:
            thread.join()
        if self.socket:
            self.socket.close()
            self.socket = None
        self.flush()