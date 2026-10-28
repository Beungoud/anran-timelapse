FROM --platform=$BUILDPLATFORM node:20-alpine AS web

WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm

ARG HARNESS_REPO=https://github.com/ajeanney/Ha-CloudEdge-Meari.git
ARG HARNESS_COMMIT=20745daf5d089363e314cf007c1cc32f6b6251ff

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone ${HARNESS_REPO} /opt/meari \
    && cd /opt/meari \
    && git checkout ${HARNESS_COMMIT}

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY backend/app ./app
COPY --from=web /web/dist ./public

ENV HARNESS_DIR=/opt/meari \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/public \
    PYTHONUNBUFFERED=1

EXPOSE 8787
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787"]
