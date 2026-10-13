# Imágenes base fijadas por digest (L11): el agente tiene el socket de Docker. Para actualizarlas:
# docker buildx imagetools inspect <imagen:tag> y sustituir el digest.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Vacío = la versión de agent/VERSION (los docker-compose no pasan --build-arg VERSION).
ARG VERSION=
RUN v="${VERSION:-$(tr -d '[:space:]' < VERSION)}" && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${v}" -o /out/mcsm-agent ./cmd/agent

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/mcsm-agent /usr/local/bin/mcsm-agent
# Corre como root a propósito: necesita /var/run/docker.sock y escribir en DATA_ROOT
# (bind mount del host, propiedad de root o del usuario del contenedor itzg).
ENV DATA_ROOT=/srv/minecraft AGENT_DATA=/var/lib/mcsm-agent MCSM_NETWORK=mcsm
VOLUME ["/var/lib/mcsm-agent"]
ENTRYPOINT ["mcsm-agent"]
