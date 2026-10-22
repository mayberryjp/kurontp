from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", populate_by_name=True)

    database_path: str = Field("data/kuro.sqlite3", validation_alias="DATABASE_PATH")
    api_host: str = Field("127.0.0.1", validation_alias="API_LISTEN_ADDRESS")
    api_port: int = Field(8000, ge=1, le=65535, validation_alias="API_PORT")
    ntp_host: str = Field("127.0.0.1", validation_alias="NTP_LISTEN_ADDRESS")
    ntp_port: int = Field(123, ge=0, le=65535, validation_alias="NTP_PORT")
    upstreams: str = Field("time.cloudflare.com,time.google.com", validation_alias="NTP_SERVERS")
    upstream_port: int = Field(123, ge=1, le=65535, validation_alias="NTP_UPSTREAM_PORT")
    sync_interval: float = Field(64, ge=1, validation_alias="NTP_SYNC_INTERVAL")
    sync_max_age: float = Field(600, ge=1, validation_alias="NTP_SYNC_MAX_AGE")
    upstream_timeout: float = Field(2, gt=0, le=30, validation_alias="NTP_UPSTREAM_TIMEOUT")
    allowed_networks: str = Field(
        "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7",
        validation_alias="NTP_ALLOWED_NETWORKS",
    )
    rate_limit: int = Field(20, ge=1, validation_alias="NTP_RATE_LIMIT")
    log_level: str = Field("INFO", validation_alias="LOG_LEVEL")

    @model_validator(mode="after")
    def validate_networks(self):
        import ipaddress

        if not self.upstream_hosts:
            raise ValueError("NTP_SERVERS must contain at least one hostname")
        networks = [part.strip() for part in self.allowed_networks.split(",") if part.strip()]
        if not networks:
            raise ValueError("NTP_ALLOWED_NETWORKS must contain at least one CIDR")
        for network in networks:
            ipaddress.ip_network(network)
        return self

    @property
    def upstream_hosts(self) -> list[str]:
        return list(dict.fromkeys(host.strip() for host in self.upstreams.split(",") if host.strip()))