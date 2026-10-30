#!/usr/bin/env bash
# Runs scripts/load/checkout.js with k6. Uses a local k6 when installed,
# else the pinned grafana/k6 Docker image. All k6 env vars pass through.
#
#   BASE_URL=http://localhost:8097 MODE=steady VUS=40 DURATION=2m scripts/load/run.sh
#   BASE_URL=http://localhost:8097 MODE=ramp VUS=120 STEP=20 scripts/load/run.sh
#   BASE_URL=https://your.server MODE=steady VUS=120 DURATION=3m scripts/load/run.sh
#
# Writes the k6 summary to scripts/load/results/<RUN_ID>.json (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
export BASE_URL="${BASE_URL:?set BASE_URL, e.g. http://localhost:8097}"
export RUN_ID="${RUN_ID:-load-$(date +%Y%m%d-%H%M%S)}"
mkdir -p results
ENV_ARGS=()
for v in BASE_URL SCENARIO MODE VUS RAMP DURATION THINK STEP STEP_HOLD RUN_ID; do
  [ -n "${!v:-}" ] && ENV_ARGS+=(-e "$v=${!v}")
done
echo "run id: $RUN_ID"
if command -v k6 >/dev/null; then
  k6 run "${ENV_ARGS[@]}" --summary-export "results/$RUN_ID.json" checkout.js
else
  # In the container, localhost is the container: reach the host instead.
  ENV_ARGS=("${ENV_ARGS[@]/localhost/host.docker.internal}")
  ENV_ARGS=("${ENV_ARGS[@]/127.0.0.1/host.docker.internal}")
  docker run --rm -i --add-host host.docker.internal:host-gateway \
    -v "$PWD:/load" -w /load grafana/k6:0.54.0 \
    run "${ENV_ARGS[@]}" --summary-export "results/$RUN_ID.json" checkout.js
fi
