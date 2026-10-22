FROM node:22-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json tsconfig.json vite.config.ts ./
RUN npm ci
COPY frontend ./frontend
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/data/kuro.sqlite3 \
    API_LISTEN_ADDRESS=0.0.0.0 \
    NTP_LISTEN_ADDRESS=0.0.0.0 \
    NTP_PORT=123
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
COPY --from=frontend /build/src/kuro/static ./src/kuro/static
RUN pip install --no-cache-dir . \
    && useradd --uid 10001 --create-home kuro \
    && mkdir -p /data && chown kuro:kuro /data
USER kuro
EXPOSE 8000/tcp 123/udp
CMD ["python", "-m", "kuro"]