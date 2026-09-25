FROM mitmproxy/mitmproxy:12.2.3
COPY addon /opt/stablehand/addon
COPY rules.default.txt /opt/stablehand/rules.default.txt
COPY entrypoint.sh /opt/stablehand/entrypoint.sh
ENV STABLEHAND_EGRESS_RULES=/opt/stablehand/rules.default.txt
USER root
RUN mkdir -p /srv/egress-ca && chown mitmproxy:mitmproxy /srv/egress-ca && chmod +x /opt/stablehand/entrypoint.sh
USER mitmproxy
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD python3 -c "import socket; socket.create_connection(('127.0.0.1', 8080), 2).close()"
ENTRYPOINT ["/opt/stablehand/entrypoint.sh"]
