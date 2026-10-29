# Multi-stage build of apps/settlement. Build context is the repo root.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/settlement ./cmd/settlement

FROM alpine:3.20
# tzdata: the scheduler resolves Asia/Bahrain for the daily batch close.
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/settlement ./settlement
CMD ["./settlement", "daemon"]
