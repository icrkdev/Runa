# syntax=docker/dockerfile:1
#
# Multi-arch: builds natively on both amd64 and arm64 (Oracle Ampere).
# Nothing in here is arch-specific; the base images are all multi-platform.

FROM --platform=$BUILDPLATFORM node:22-slim AS web-build
WORKDIR /web
# Copy the manifests alone first so `npm ci` is cached independently of source.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM rust:1-slim AS server-build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY server ./server
ARG RUNA_COMMIT=dev
ARG RUNA_BUNDLE_SHA256=dev
# --locked so the image resolves the exact dependency versions CI tested.
RUN RUNA_COMMIT=$RUNA_COMMIT RUNA_BUNDLE_SHA256=$RUNA_BUNDLE_SHA256 \
    cargo build --release --locked -p runa-server

FROM gcr.io/distroless/cc-debian12 AS runtime
LABEL org.opencontainers.image.title="RUNA" \
      org.opencontainers.image.description="Ephemeral end-to-end encrypted collaborative markdown" \
      org.opencontainers.image.source="https://github.com/icrkdev/Runa" \
      org.opencontainers.image.licenses="MIT"

COPY --from=server-build /src/target/release/runa-server /runa
COPY --from=web-build /web/dist /dist

# Rooms are pure RAM, so every limit here is a ceiling on how much of the
# host a stranger can claim. These defaults suit a 256 MB container. Raise
# them at `docker run` time, in step with the container's own --memory.
# The arithmetic is in docs/DEPLOY.md.
ENV RUNA_DIST=/dist \
    RUNA_BIND=0.0.0.0:3000 \
    RUNA_MAX_TOTAL_LOG_MB=128 \
    RUNA_MAX_ROOMS=128 \
    RUNA_MAX_CONNECTIONS=256 \
    RUNA_MAX_QUEUE_KB=512

# 0.0.0.0 is correct *inside* the container. Publish it to loopback only
# (-p 127.0.0.1:3000:3000) so the proxy is the sole route in.
USER nonroot:nonroot
EXPOSE 3000
ENTRYPOINT ["/runa"]
