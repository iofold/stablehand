FROM python:3.13-alpine@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0 AS patched-python-package

RUN pip install \
  --no-cache-dir \
  --disable-pip-version-check \
  --target /patched-python-package \
  pyasn1==0.6.4

FROM ghcr.io/berriai/litellm-non_root@sha256:4f2dcc36fe5d251013dd40a65d63fa7f3291c8f2db6d0634b6e4997ad7950257

USER root
RUN rm -rf \
  /app/.venv/lib/python3.13/site-packages/pyasn1 \
  /app/.venv/lib/python3.13/site-packages/pyasn1-0.6.3.dist-info
COPY --from=patched-python-package \
  /patched-python-package/pyasn1 \
  /app/.venv/lib/python3.13/site-packages/pyasn1
COPY --from=patched-python-package \
  /patched-python-package/pyasn1-0.6.4.dist-info \
  /app/.venv/lib/python3.13/site-packages/pyasn1-0.6.4.dist-info
COPY deploy/compose/model-gateway/patch_spend_reseed.py /opt/gateway-patches/patch_spend_reseed.py
RUN /app/.venv/bin/python /opt/gateway-patches/patch_spend_reseed.py \
  > /opt/gateway-patches/spend-reseed-patch.json
USER 65534
