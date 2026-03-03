FROM node:20-bookworm-slim AS web-builder
WORKDIR /app/web

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build


FROM rust:1.86-bookworm AS rust-builder
WORKDIR /app

COPY Cargo.toml ./
COPY src ./src
COPY web ./web
COPY --from=web-builder /app/web/dist ./web/dist

RUN cargo build --release


FROM debian:bookworm-slim
WORKDIR /app

RUN useradd -r -u 10001 -g root appuser

COPY --from=rust-builder /app/target/release/axum-piping /usr/local/bin/axum-piping

ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080
USER 10001

ENTRYPOINT ["/usr/local/bin/axum-piping"]
