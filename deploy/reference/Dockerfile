# syntax=docker/dockerfile:1

# The qe-report API and its operator command, from this checkout.
#
# Two stages. The first has pnpm, the workspace, and everything a build needs; the second has the
# built server, its production dependencies, and nothing else: no workspace source, no compiler,
# no package manager, and no PostgreSQL client. Backup tooling lives in its own image, because the
# service that answers the public port has no business holding pg_dump.
#
# The base image is pinned by digest. The tag beside it is there for a person reading this file;
# the digest is what is built.

# node:24-bookworm-slim, Node v24.21.0
ARG NODE_IMAGE=node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# The version the workspace pins; corepack ships with the base image.
RUN corepack enable
# The protocol schema is the source of truth outside the workspace, and the validator's build
# copies it, so the build context is the repository and not just ts/.
COPY protocol/schema ./protocol/schema
COPY ts ./ts
WORKDIR /src/ts
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter './packages/*' run build
# A self-contained tree: the built API, its workspace dependencies, and production dependencies.
RUN pnpm --filter qe-report-http-api deploy --prod /out

FROM ${NODE_IMAGE} AS runtime
# Dependency versions, for whoever has to answer what is running.
LABEL org.opencontainers.image.title="qe-report API"
LABEL org.opencontainers.image.description="Quality engineering reporting API v1 and its operator command"
LABEL org.opencontainers.image.source="https://github.com/yannisyoussef/qe-report"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim"
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

# A dedicated account with a fixed id, so a mounted volume's ownership is predictable.
RUN groupadd --system --gid 10001 qe \
 && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin qe
WORKDIR /app
COPY --from=build --chown=root:root /out ./
# Both commands the deployment needs, by name.
RUN printf '#!/bin/sh\nexec node /app/dist/bin/server.js "$@"\n' > /usr/local/bin/qe-report-server \
 && printf '#!/bin/sh\nexec node /app/dist/bin/admin.js "$@"\n' > /usr/local/bin/qe-report-admin \
 && chmod 0555 /usr/local/bin/qe-report-server /usr/local/bin/qe-report-admin

# The two durable roots, owned by the account that will use them. A fresh named volume takes its
# ownership from the image, which is what lets the server run as a non-root user without an init
# step. A bind mount does not: an operator who mounts host directories must chown them 10001:10001
# themselves, and /readyz will say so until they do.
RUN mkdir -p /var/lib/qe-report/blobs /var/lib/qe-report/staging \
 && chown -R 10001:10001 /var/lib/qe-report \
 && chmod 0700 /var/lib/qe-report/blobs /var/lib/qe-report/staging
# No VOLUME for either root. It would add nothing the compose file does not already say, and it
# would make every `docker compose run --rm --entrypoint qe-report-admin api ...` -- the shape the
# operator guide uses throughout -- leave two anonymous volumes behind on the host.

# The container network is the boundary, so the server binds every interface inside it. Outside a
# container the server still defaults to loopback; nothing about that default changes here.
ENV NODE_ENV=production
ENV QE_REPORT_HOST=0.0.0.0
ENV QE_REPORT_PORT=8080
EXPOSE 8080
USER 10001:10001
STOPSIGNAL SIGTERM
CMD ["qe-report-server"]
