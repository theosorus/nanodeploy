# CADDY_VERSION must point to a builder image with go >= 1.25: the sablier
# plugin now requires it (older 2.10.x builders ship go 1.24 and the build dies)
ARG CADDY_VERSION=2.11.4
FROM caddy:${CADDY_VERSION}-builder AS builder
RUN xcaddy build --with github.com/sablierapp/sablier-caddy-plugin

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
