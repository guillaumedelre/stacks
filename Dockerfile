FROM alpine:3.22 AS css

ARG TAILWIND_VERSION=4.3.3
ARG TARGETARCH

RUN apk add --no-cache libstdc++ libgcc \
    && case "$TARGETARCH" in arm64) arch=arm64 ;; *) arch=x64 ;; esac \
    && wget -qO /usr/local/bin/tailwindcss "https://github.com/tailwindlabs/tailwindcss/releases/download/v${TAILWIND_VERSION}/tailwindcss-linux-${arch}-musl" \
    && chmod +x /usr/local/bin/tailwindcss

WORKDIR /build
COPY tailwind.css index.html ./
RUN tailwindcss --input tailwind.css --output app.css --minify

FROM docker:29.10-cli

RUN apk add --no-cache python3 py3-yaml

WORKDIR /app
COPY server.py index.html cards.js ui.js ./
COPY --from=css /build/app.css ./

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=1s CMD wget -q --spider http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT []
CMD ["python3", "-u", "server.py"]
