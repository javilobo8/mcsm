FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/mcsm-agent ./cmd/agent

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/mcsm-agent /usr/local/bin/mcsm-agent
ENV DATA_ROOT=/srv/minecraft AGENT_DATA=/var/lib/mcsm-agent MCSM_NETWORK=mcsm
VOLUME ["/var/lib/mcsm-agent"]
ENTRYPOINT ["mcsm-agent"]
