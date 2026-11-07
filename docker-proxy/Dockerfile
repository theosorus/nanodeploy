ARG HAPROXY_VERSION=3.2.26-alpine
FROM haproxy:${HAPROXY_VERSION}
# The mounted Docker socket belongs to root. No capabilities or host mounts
# other than that socket are needed; the caller is isolated on its own bridge.
USER root
COPY control-plane.cfg sablier.cfg /etc/nanodeploy/
STOPSIGNAL SIGTERM
ENTRYPOINT ["haproxy", "-W", "-db", "-f"]
CMD ["/etc/nanodeploy/control-plane.cfg"]
