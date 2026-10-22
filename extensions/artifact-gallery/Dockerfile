# artifact-gallery: runs the TypeScript sources directly under Bun, the
# runtime its package.json start script uses. There are no dependencies.
FROM oven/bun:1.3.10-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src/ src/
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV GALLERY_PORT=8090 \
    GALLERY_DATA_DIR=/data
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -q -O /dev/null http://127.0.0.1:8090/healthz || exit 1
CMD ["bun", "run", "src/server.ts"]
