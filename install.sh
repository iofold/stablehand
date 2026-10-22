#!/bin/sh
# Stablehand installer.
#
#   curl -fsSL https://raw.githubusercontent.com/iofold/stablehand/master/install.sh | sh
#
# From nothing to the Overnight Analyst running: checks Docker, clones the repo
# (or uses the checkout it runs from), writes .env with generated secrets,
# starts the stack with the model gateway and the artifact gallery, seeds the
# analyst and fires one run. Prints the UI address, the API token and the
# run's receipt. Safe to re-run: it keeps every value already in .env, and a
# second run starts nothing new and spends nothing.
#
# Settings, all optional, read from the environment:
#   OPENAI_API_KEY         used when .env has none; otherwise you are asked
#   STABLEHAND_DIR         where to clone (default ./stablehand)
#   STABLEHAND_REPO        git URL (default https://github.com/iofold/stablehand.git)
#   STABLEHAND_REF         branch or tag to clone (default master)
#   STABLEHAND_IMAGE_TAG   image tag to use; default: sha-<commit>, then latest
#   STABLEHAND_BUILD=1     build every image from the checkout instead of pulling
#   STABLEHAND_FIRST_RUN   once (default: only if no brief exists yet), always, or skip
#   API_PORT, UI_PORT, GALLERY_PORT, ...  as in .env.example
set -eu

# Everything runs inside main(), which the shell parses in full before the
# first command runs: a truncated download fails instead of half-installing,
# and nothing below can read the rest of the script from a `curl | sh` pipe.
main() {
REPO_URL=${STABLEHAND_REPO:-https://github.com/iofold/stablehand.git}
CLONE_DIR=${STABLEHAND_DIR:-stablehand}
CLONE_REF=${STABLEHAND_REF:-master}
FIRST_RUN=${STABLEHAND_FIRST_RUN:-once}
STARTED_AT=$(date +%s)

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
elapsed() { s=$(( $(date +%s) - STARTED_AT )); printf '%dm %02ds' $((s / 60)) $((s % 60)); }

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
say "Checking prerequisites"
have docker || die "Docker is not installed. Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running, or this user cannot reach it. Start Docker and try again."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command). It ships with Docker Desktop; on Linux install docker-compose-plugin."
have curl || die "curl is required."
if have openssl; then
  random_hex() { openssl rand -hex "$1"; }
else
  random_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
fi
mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
if [ "${mem:-0}" -gt 0 ] && [ "$mem" -lt 6000000000 ]; then
  warn "Docker has $((mem / 1000000000)) GB of memory. The stack wants about 6 GB; builds and runs may fail with less."
fi
note "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), $(docker compose version --short 2>/dev/null | sed 's/^/compose /')"

# ── 2. The checkout ───────────────────────────────────────────────────────────
is_checkout() { [ -f "$1/docker-compose.yml" ] && [ -f "$1/.env.example" ] && [ -d "$1/packages/examples/overnight-analyst" ]; }
if is_checkout .; then
  say "Using the checkout in $(pwd)"
elif is_checkout "$CLONE_DIR"; then
  say "Using the existing checkout in $CLONE_DIR"
  cd "$CLONE_DIR"
else
  have git || die "git is required to clone Stablehand."
  [ -e "$CLONE_DIR" ] && die "$CLONE_DIR exists but is not a Stablehand checkout. Set STABLEHAND_DIR to another path."
  say "Cloning $REPO_URL ($CLONE_REF) into $CLONE_DIR"
  git clone --quiet --depth 1 --branch "$CLONE_REF" "$REPO_URL" "$CLONE_DIR"
  cd "$CLONE_DIR"
fi
ROOT=$(pwd)

# ── 3. .env ───────────────────────────────────────────────────────────────────
# Values are only ever added or filled in, never replaced, so a re-run keeps
# every secret. Each key ends up on exactly one line.
env_get() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed 's/^"\(.*\)"$/\1/'
}
env_set() {
  key=$1
  ENV_SET_VALUE=$2
  export ENV_SET_VALUE
  if grep -q "^$key=" .env; then
    pattern="^$key="
  elif grep -q "^# *$key=" .env; then
    pattern="^# *$key="
  else
    printf '%s=%s\n' "$key" "$ENV_SET_VALUE" >> .env
    return 0
  fi
  (umask 077 && awk -v pat="$pattern" -v key="$key" '
    $0 ~ pat { if (!done) { print key "=" ENVIRON["ENV_SET_VALUE"]; done = 1 } next }
    { print }' .env > .env.tmp) && mv .env.tmp .env
}
env_default() {
  if [ -z "$(env_get "$1")" ]; then
    env_set "$1" "$2"
    changed="$changed $1"
  fi
}

say "Writing .env"
if [ ! -f .env ]; then
  (umask 077 && cp .env.example .env)
  note "created .env from .env.example"
fi
chmod 600 .env
changed=""

if [ -z "$(env_get OPENAI_API_KEY)" ]; then
  key=${OPENAI_API_KEY:-}
  if [ -z "$key" ] && [ -r /dev/tty ]; then
    printf 'OpenAI API key (input hidden; the agents and the gateway use it): ' > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    IFS= read -r key < /dev/tty || key=""
    stty echo < /dev/tty 2>/dev/null || true
    printf '\n' > /dev/tty
  fi
  [ -n "$key" ] || die "No OpenAI API key. Set OPENAI_API_KEY and run the installer again."
  env_set OPENAI_API_KEY "$key"
  changed="$changed OPENAI_API_KEY"
fi

env_default COMPOSE_FILE "docker-compose.yml:deploy/compose/model-gateway/docker-compose.yml:extensions/artifact-gallery/docker-compose.yml"
env_default SECRET_MASTER_KEY "$(random_hex 32)"
env_default STABLEHAND_API_TOKEN "$(random_hex 32)"
env_default LITELLM_MASTER_KEY "sk-$(random_hex 24)"
env_default LITELLM_SALT_KEY "$(random_hex 32)"
env_default LITELLM_DATABASE_PASSWORD "$(random_hex 24)"
env_default STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY "sk-$(random_hex 24)"
# On one host the orchestrator can use the gateway's master key to read spend
# and to mint per-run keys; neither ever enters a sandbox.
env_default STABLEHAND_MODEL_GATEWAY_METERING_KEY "$(env_get LITELLM_MASTER_KEY)"
env_default STABLEHAND_MODEL_GATEWAY_ADMIN_KEY "$(env_get LITELLM_MASTER_KEY)"
env_default STABLEHAND_MODEL_GATEWAY_REVISION "local-1"
env_default GALLERY_WEBHOOK_SECRET "$(random_hex 24)"
# The analyst reads public web pages. GET and HEAD only; see .env.example to narrow it.
env_default STABLEHAND_EGRESS_EXTRA_ALLOW '"GET *;HEAD *"'
if [ -n "$changed" ]; then
  note "set:$changed"
else
  note "nothing to change"
fi

setting() {
  # Shell environment first, then .env, then the default, as Compose does.
  eval "value=\${$1:-}"
  [ -n "$value" ] || value=$(env_get "$1")
  printf '%s' "${value:-$2}"
}
API_PORT=$(setting API_PORT 3002)
UI_PORT=$(setting UI_PORT 3200)
GALLERY_PORT=$(setting GALLERY_PORT 8090)

# ── 4. Images ─────────────────────────────────────────────────────────────────
REGISTRY=$(setting STABLEHAND_IMAGE_REGISTRY ghcr.io/iofold)
image_published() { docker manifest inspect "$REGISTRY/stablehand-orchestrator:$1" >/dev/null 2>&1; }
images_present() {
  images=$(STABLEHAND_IMAGE_TAG=$1 docker compose config --images 2>/dev/null) || return 1
  [ -n "$images" ] || return 1
  for image in $images; do
    docker image inspect "$image" >/dev/null 2>&1 || return 1
  done
}

say "Choosing images"
if [ -n "${STABLEHAND_IMAGE_TAG:-}" ]; then
  candidates=$STABLEHAND_IMAGE_TAG
else
  candidates=""
  if have git && git rev-parse --git-dir >/dev/null 2>&1; then
    candidates="sha-$(git rev-parse --short=7 HEAD)"
  fi
  candidates="$candidates $(env_get STABLEHAND_IMAGE_TAG) latest"
fi
tag=""
pull=0
for candidate in $candidates; do
  if images_present "$candidate"; then
    tag=$candidate
    note "$tag: already on this machine"
    break
  fi
  if [ "${STABLEHAND_BUILD:-0}" != 1 ] && image_published "$candidate"; then
    tag=$candidate
    pull=1
    note "$tag: published on $REGISTRY"
    break
  fi
done
if [ -z "$tag" ]; then
  # shellcheck disable=SC2086 # split the candidate list on purpose
  set -- $candidates
  tag=$1
  note "$tag: no published images found, building from this checkout (10-20 minutes the first time)"
fi
[ "$(env_get STABLEHAND_IMAGE_TAG)" = "$tag" ] || env_set STABLEHAND_IMAGE_TAG "$tag"
export STABLEHAND_IMAGE_TAG="$tag"

if [ "$pull" = 1 ]; then
  say "Pulling images"
  # Anything not published at this tag is built by `up` below.
  docker compose pull --quiet --ignore-pull-failures 2>/dev/null || warn "some images could not be pulled; they will be built"
fi

# ── 5. Start ──────────────────────────────────────────────────────────────────
say "Starting the stack"
if [ "${STABLEHAND_BUILD:-0}" = 1 ]; then
  docker compose up -d --build < /dev/null
else
  docker compose up -d < /dev/null
fi

say "Waiting for the API on http://localhost:$API_PORT"
deadline=$(( $(date +%s) + 600 ))
until curl -fsS -o /dev/null "http://127.0.0.1:$API_PORT/health" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    docker compose ps >&2 || true
    die "The API did not answer within 10 minutes. See: docker compose logs orchestrator gateway-init litellm"
  fi
  sleep 3
done
note "healthy after $(elapsed)"

# ── 6. Seed the Overnight Analyst ─────────────────────────────────────────────
# Copy this checkout's example into the container, so the seed and manifest
# match the checkout even when the pulled image is older.
EXAMPLE=/app/packages/examples/overnight-analyst
for file in seed.ts run-once.ts agents/.; do
  docker compose cp "packages/examples/overnight-analyst/$file" "orchestrator:$EXAMPLE/$file" >/dev/null 2>&1 \
    || die "Could not copy $file into the orchestrator container."
done

timezone=${ANALYST_TZ:-}
if [ -z "$timezone" ] && [ -L /etc/localtime ]; then
  timezone=$(readlink /etc/localtime | sed -n 's|.*/zoneinfo/||p')
fi

say "Seeding the Overnight Analyst"
current_key=$(env_get GALLERY_API_KEY)
gallery_mode=auto
[ -n "$current_key" ] || gallery_mode=rotate
seed_log=$(mktemp)
trap 'rm -f "$seed_log"' EXIT
# The key goes to the seed through its environment, never the command line.
# It is set for this one command only: an exported (even empty) value would
# override .env when Compose recreates the gallery below.
GALLERY_API_KEY=$current_key docker compose exec -T \
  -e API_URL=http://localhost:3001 \
  -e GALLERY_API_KEY \
  -e ANALYST_GALLERY="$gallery_mode" \
  -e ANALYST_TZ="${timezone:-UTC}" \
  -w "$EXAMPLE" orchestrator node --experimental-strip-types seed.ts < /dev/null > "$seed_log" 2>&1 \
  || { grep -v '^GALLERY_API_KEY=' "$seed_log" >&2; die "Seeding failed."; }
grep -v -e '^GALLERY_API_KEY=' -e '^Put this line in .env' "$seed_log" | sed '/^$/d' | sed 's/^/    /'
new_key=$(sed -n 's/^GALLERY_API_KEY=//p' "$seed_log" | tail -n 1)
if [ -n "$new_key" ]; then
  env_set GALLERY_API_KEY "$new_key"
  note "saved the gallery's scoped key to .env"
  docker compose up -d gallery >/dev/null 2>&1 || warn "could not restart the gallery; run: docker compose up -d gallery"
fi

# ── 7. First run ──────────────────────────────────────────────────────────────
receipt_line=""
if [ "$FIRST_RUN" != skip ]; then
  say "Running the Overnight Analyst once (a few minutes; the receipt follows)"
  run_log=$(mktemp)
  trap 'rm -f "$seed_log" "$run_log"' EXIT
  only_if_none=1
  [ "$FIRST_RUN" = always ] && only_if_none=0
  # A read loop instead of grep or sed, so progress shows as it happens.
  docker compose exec -T \
    -e API_URL=http://localhost:3001 \
    -e GALLERY_URL=http://gallery:8090 \
    -e ANALYST_SKIP_IF_BRIEF="$only_if_none" \
    -w "$EXAMPLE" orchestrator node --experimental-strip-types run-once.ts < /dev/null 2>&1 \
    | tee "$run_log" | while IFS= read -r line; do
        case $line in
          "RESULT "*) ;;
          *) printf '    %s\n' "$line" ;;
        esac
      done
  receipt_line=$(grep '^RESULT ' "$run_log" | tail -n 1 || true)
  case "$receipt_line" in
    *status=COMPLETED*|*status=SKIPPED*) ;;
    *) warn "the first run did not finish cleanly; open the UI to see why" ;;
  esac
fi

# ── 8. Done ───────────────────────────────────────────────────────────────────
TOKEN=$(env_get STABLEHAND_API_TOKEN)
cost=$(printf '%s' "$receipt_line" | sed -n 's/.*cost_usd=\([^ ]*\).*/\1/p')
say "Stablehand is running ($(elapsed))"
case "$receipt_line" in
  *status=COMPLETED*gallery=shown*) note "first run: completed for \$${cost:-unknown} in model calls; the brief is in the gallery" ;;
  *status=COMPLETED*) note "first run: completed for \$${cost:-unknown} in model calls; the brief is under Artifacts in the UI" ;;
  *status=SKIPPED*) note "first run: skipped, a brief already exists (STABLEHAND_FIRST_RUN=always runs another)" ;;
esac
cat <<EOF

  UI        http://localhost:$UI_PORT
  Token     $TOKEN
            (paste it when the UI asks; it is STABLEHAND_API_TOKEN in $ROOT/.env)
  Gallery   http://localhost:$GALLERY_PORT
  API       http://localhost:$API_PORT

  The Overnight Analyst runs every day at 07:00 (${timezone:-UTC}). Open it in the UI
  to see the run, its receipt and its files. Run it again now:
    cd $ROOT && docker compose exec -e API_URL=http://localhost:3001 \\
      -e GALLERY_URL=http://gallery:8090 -w $EXAMPLE orchestrator \\
      node --experimental-strip-types run-once.ts

  Stop: docker compose down    Remove everything: docker compose down -v
EOF
}

main "$@"
