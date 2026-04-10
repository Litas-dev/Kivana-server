FROM rust:1.88-slim-bookworm AS build

WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
RUN cargo build --release

COPY . .
RUN find src migrations -type f -exec touch {} +
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update -y && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/kivana-api /app/kivana-api
COPY --from=build /app/kivana-admin /app/kivana-admin
COPY --from=build /app/kivana-portal /app/kivana-portal
ENV RUST_LOG=info
EXPOSE 8080
CMD ["/app/kivana-api"]
