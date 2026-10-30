#!/usr/bin/env bash
# Overload + crash test (CAPACITY.md): pushes past capacity, kills the api
# process mid-load (SIGKILL, like a crash or an OOM kill), checks that Docker
# restarts it, then checks the data with verify.sql.
#
#   BASE_URL=http://localhost:8097 PROJECT=filspay-cap VUS=400 scripts/load/chaos.sh
#
# Run on the Docker host of ops/docker-compose.prod.yml.
set -euo pipefail
cd "$(dirname "$0")"
export BASE_URL="${BASE_URL:?set BASE_URL}"
PROJECT="${PROJECT:-filspay-prod}"
export VUS="${VUS:-400}" DURATION="${DURATION:-2m}" MODE=overload
export RUN_ID="${RUN_ID:-chaos-$(date +%Y%m%d-%H%M%S)}"
KILL_AFTER="${KILL_AFTER:-60}"
COMPOSE=(docker compose -f ../../ops/docker-compose.prod.yml -p "$PROJECT")
API="$("${COMPOSE[@]}" ps -q api)"

./run.sh > "results/$RUN_ID.log" 2>&1 &
LOAD=$!

sleep "$KILL_AFTER"
PID="$(docker inspect -f '{{.State.Pid}}' "$API")"
RESTARTS="$(docker inspect -f '{{.RestartCount}}' "$API")"
echo "$(date +%T) SIGKILL api process (pid $PID in the Docker host)"
# Kill from the host pid namespace: a real crash, not a 'docker stop'.
docker run --rm --pid=host --privileged alpine:3.20 kill -9 "$PID"
START=$(date +%s)
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$API")" = healthy ] \
  && [ "$(docker inspect -f '{{.RestartCount}}' "$API")" -gt "$RESTARTS" ]; do sleep 1; done
echo "$(date +%T) api healthy again after $(( $(date +%s) - START ))s," \
  "restart count $(docker inspect -f '{{.RestartCount}}' "$API")"

wait "$LOAD" || true
tail -40 "results/$RUN_ID.log"
# The load has ended: check the data.
"${COMPOSE[@]}" exec -T postgres psql -U filspay -d filspay -v run_id="'$RUN_ID-%'" -f - < verify.sql
