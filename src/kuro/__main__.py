import logging
import signal
import threading

from waitress.server import create_server

from kuro.api.app import create_app
from kuro.config import Settings
from kuro.db import Repository
from kuro.ntp import NTPService

log = logging.getLogger(__name__)


def main() -> None:
    settings = Settings()
    logging.basicConfig(level=settings.log_level,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    repository = Repository(settings.database_path)
    service = NTPService(settings, repository)
    server = create_server(create_app(settings, repository, service),
                           host=settings.api_host, port=settings.api_port, threads=4)

    def stop(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT, stop)
    try:
        service.start()
        log.info("kuro_started http=%s:%s ntp=%s:%s", settings.api_host, settings.api_port,
             settings.ntp_host, settings.ntp_port)
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        service.close()
        repository.close()


if __name__ == "__main__":
    main()