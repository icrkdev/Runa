# syntax=docker/dockerfile:1

FROM rust:1-slim AS build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY server ./server
ARG RUNA_COMMIT=dev
ARG RUNA_BUNDLE_SHA256=dev
RUN RUNA_COMMIT=$RUNA_COMMIT RUNA_BUNDLE_SHA256=$RUNA_BUNDLE_SHA256 \
    cargo build --release --locked -p runa-server

FROM node:22-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=build /src/target/release/runa-server /runa
COPY --from=web-build /web/dist /dist
# Rooms are pure RAM. These defaults keep the process inside a 256 MB
# container; raise them deliberately, in step with the container's own limit.
# See "Sizing it for the host" in the README.
ENV RUNA_DIST=/dist \
    RUNA_BIND=0.0.0.0:3000 \
    RUNA_MAX_TOTAL_LOG_MB=128 \
    RUNA_MAX_ROOMS=128
USER nonroot:nonroot
EXPOSE 3000
ENTRYPOINT ["/runa"]
