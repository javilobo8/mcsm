# Base images pinned by digest (L11): the agent has the Docker socket. To update them:
# docker buildx imagetools inspect <image:tag> and replace the digest.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Empty = the version in agent/VERSION (the docker-compose files do not pass --build-arg VERSION).
ARG VERSION=
RUN v="${VERSION:-$(tr -d '[:space:]' < VERSION)}" && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${v}" -o /out/mcsm-agent ./cmd/agent

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/mcsm-agent /usr/local/bin/mcsm-agent
# Runs as root on purpose: it needs /var/run/docker.sock and to write to DATA_ROOT
# (host bind mount, owned by root or by the itzg container user).
ENV DATA_ROOT=/srv/minecraft AGENT_DATA=/var/lib/mcsm-agent MCSM_NETWORK=mcsm
VOLUME ["/var/lib/mcsm-agent"]
ENTRYPOINT ["mcsm-agent"]
