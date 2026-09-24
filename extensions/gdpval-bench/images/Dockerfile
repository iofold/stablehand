# Benchmark harness images — EXTEND the stock harness images, never modify
# them. Adds document/media tooling GDPval deliverables need (headless
# LibreOffice for docx/pptx/pdf conversion, ffmpeg for media tasks).
#
# Build (one per harness):
#   docker build --build-arg BASE=stablehand/harness-langgraph:latest \
#     -t stablehand-bench/harness-langgraph:latest -f images/Dockerfile images/
#
# Activate on dev1 by pointing the orchestrator at the bench prefix for the
# benchmark window (see README): STABLEHAND_IMAGE_PREFIX=stablehand-bench/harness

ARG BASE=stablehand/harness-langgraph:latest
FROM ${BASE}

USER root
RUN apk add --no-cache libreoffice ffmpeg font-noto
USER stablehand
