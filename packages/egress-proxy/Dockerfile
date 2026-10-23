FROM mitmproxy/mitmproxy:12.2.3
COPY addon /opt/stablehand/addon
COPY rules.default.txt rules.runtime.txt /opt/stablehand/
COPY entrypoint.sh /opt/stablehand/entrypoint.sh
ENV STABLEHAND_EGRESS_RULES=/opt/stablehand/rules.default.txt \
    STABLEHAND_EGRESS_RUNTIME_RULES=/opt/stablehand/rules.runtime.txt
USER root
RUN mkdir -p /srv/egress-ca && chown mitmproxy:mitmproxy /srv/egress-ca && chmod +x /opt/stablehand/entrypoint.sh
USER mitmproxy
# 8080: open listener (a session lease is optional); 8081: lease listener (a lease is required).
EXPOSE 8080 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD python3 -c "import socket; [socket.create_connection(('127.0.0.1', port), 2).close() for port in (8080, 8081)]"
ENTRYPOINT ["/opt/stablehand/entrypoint.sh"]
