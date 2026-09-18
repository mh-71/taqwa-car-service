#!/usr/bin/env bash
# ============================================================
# tests/integration/run.sh — Worker + local D1 integration run
# ------------------------------------------------------------
# Starts `wrangler dev --local`, seeds fixture rows into the LOCAL
# D1 file, runs tests/integration/api.test.mjs over real HTTP, then
# removes every fixture row and stops the Worker.
#
# LOCAL ONLY, by construction:
#   * every wrangler call here passes --local
#   * --remote is never used, and is rejected if passed in
#   * the binding in wrangler.jsonc is taqwa-local, whose database_id
#     is the "local-development-only" placeholder
#   * nothing here deploys
#
# Cleanup runs from an EXIT trap, so fixture rows are removed even if
# a test fails, the suite throws, or the run is interrupted.
#
# Usage:  npm run test:integration          (or: bash tests/integration/run.sh)
# Env:    PORT=8788 npm run test:integration
# ============================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-8787}"
DB="taqwa-local"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t taqwa-worker-XXXXXX.log)"

cd "$ROOT"
export WRANGLER_SEND_METRICS=false

# Refuse to run against anything remote, whatever the caller passed.
for arg in "$@"; do
  if [ "$arg" = "--remote" ]; then
    echo "REFUSED: this suite is local-only. --remote is never valid here." >&2
    exit 2
  fi
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
d1() { npx wrangler d1 execute "$DB" --local --command "$1" --json 2>/dev/null | sed -n '/^\[/,$p'; }
d1_file() { npx wrangler d1 execute "$DB" --local --file "$1" --json 2>/dev/null | sed -n '/^\[/,$p'; }

WORKER_PID=""
SEEDED=0

cleanup() {
  local code=$?
  if [ "$SEEDED" = "1" ]; then
    say "Removing fixture rows"
    d1_file "$HERE/fixtures/cleanup.sql" >/dev/null
    local left
    left=$(d1 "SELECT (SELECT count(*) FROM services WHERE id LIKE 'SRV-9%')
                    + (SELECT count(*) FROM customers WHERE id LIKE 'CUS-9%')
                    + (SELECT count(*) FROM vehicles WHERE id LIKE 'VEH-9%')
                    + (SELECT count(*) FROM mechanics WHERE id LIKE 'MEC-9%')
                    + (SELECT count(*) FROM parts WHERE id LIKE 'PRT-9%')
                    + (SELECT count(*) FROM appointments WHERE id LIKE 'APT-9%')
                    + (SELECT count(*) FROM job_cards WHERE id LIKE 'JOB-9%')
                    + (SELECT count(*) FROM job_card_services WHERE job_card_id LIKE 'JOB-9%')
                    + (SELECT count(*) FROM job_card_parts WHERE job_card_id LIKE 'JOB-9%')
                    + (SELECT count(*) FROM invoices WHERE id LIKE 'INV-9%')
                    + (SELECT count(*) FROM invoice_services WHERE invoice_id LIKE 'INV-9%')
                    + (SELECT count(*) FROM invoice_parts WHERE invoice_id LIKE 'INV-9%')
                    + (SELECT count(*) FROM payments WHERE id LIKE 'PAY-9%') AS n" \
           | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+')
    if [ "${left:-x}" = "0" ]; then
      echo "  all fixture rows removed"
    else
      echo "  WARNING: ${left:-?} fixture row(s) still present — remove them before committing" >&2
      [ "$code" = "0" ] && code=1
    fi
  fi

  if [ -n "$WORKER_PID" ]; then
    say "Stopping Worker"
    # Negative pid = the whole process group that setsid created.
    kill -- "-$WORKER_PID" 2>/dev/null || kill "$WORKER_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8; do kill -0 "$WORKER_PID" 2>/dev/null || break; sleep 1; done
    kill -9 -- "-$WORKER_PID" 2>/dev/null
    kill -9 "$WORKER_PID" 2>/dev/null
    wait "$WORKER_PID" 2>/dev/null
    sleep 1

    local stray
    stray=$(pgrep -f "workerd serve .*:$PORT" 2>/dev/null)
    [ -n "$stray" ] && { echo "  reaping stray workerd: $stray"; kill -9 $stray 2>/dev/null; sleep 1; }

    if curl -s -m 2 -o /dev/null "$BASE/api/health"; then
      echo "  WARNING: something is still listening on port $PORT" >&2
      [ "$code" = "0" ] && code=1
    else
      echo "  port $PORT free"
    fi
  fi
  rm -f "$LOG"
  exit $code
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- start
say "Starting Worker on port $PORT (local D1)"
# setsid puts wrangler in its own process group, so the EXIT trap can signal
# the whole tree. wrangler spawns workerd as a grandchild, and killing only the
# parent leaves workerd alive and holding the port.
setsid npx wrangler dev --local --port "$PORT" > "$LOG" 2>&1 &
WORKER_PID=$!

for _ in $(seq 1 45); do
  curl -s -m 2 -o /dev/null "$BASE/api/health" && break
  kill -0 "$WORKER_PID" 2>/dev/null || { echo "Worker exited during startup:" >&2; tail -20 "$LOG" >&2; exit 1; }
  sleep 1
done
curl -s -m 2 -o /dev/null "$BASE/api/health" || { echo "Worker did not become ready:" >&2; tail -20 "$LOG" >&2; exit 1; }
echo "  ready"

if ! curl -s "$BASE/api/health" | grep -q '"migrated": true'; then
  echo "Schema is not applied to the local database. Run: npm run db:migrate:local" >&2
  exit 1
fi
echo "  schema applied"

# ------------------------------------------------------- safety preflight
# The suite asserts exact row counts, so it needs these three tables to hold
# nothing but the fixtures. Refusing here also means the run can never delete
# rows it did not create.
say "Checking the local database is clear"
COUNTS=$(d1 "SELECT (SELECT count(*) FROM services) + (SELECT count(*) FROM customers) + (SELECT count(*) FROM vehicles) + (SELECT count(*) FROM mechanics) + (SELECT count(*) FROM parts) + (SELECT count(*) FROM appointments) + (SELECT count(*) FROM job_cards) + (SELECT count(*) FROM job_card_services)
                    + (SELECT count(*) FROM job_card_parts) + (SELECT count(*) FROM invoices)
                    + (SELECT count(*) FROM invoice_services) + (SELECT count(*) FROM invoice_parts)
                    + (SELECT count(*) FROM payments) AS n" \
         | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+')
if [ "${COUNTS:-x}" != "0" ]; then
  cat >&2 <<MSG
REFUSED: the fixture tables (services/customers/vehicles/mechanics/parts/
appointments/job_cards/invoices/line tables/payments) already hold ${COUNTS:-?} row(s).

This suite asserts exact counts, so it only runs against an empty local
database, and it will not delete rows it did not insert. Clear the local
database yourself first, or point PORT/wrangler at a scratch one.
MSG
  exit 1
fi
echo "  empty — safe to seed"

# ----------------------------------------------------------------- seed
say "Seeding fixtures"
SEEDED=1
d1_file "$HERE/fixtures/seed.sql" | grep -q '"success": true' || { echo "Seeding failed" >&2; exit 1; }
echo "  6 services, 2 customers, 2 vehicles, 3 mechanics, 3 parts, 6 appointments,"
  echo "  4 job cards (4 service lines, 2 part lines),"
  echo "  4 invoices (4 service lines, 2 part lines), 5 payments"

# ------------------------------------------------------------------ run
say "Running tests/integration/api.test.mjs"
TAQWA_API_BASE="$BASE" node "$HERE/api.test.mjs"
RESULT=$?

sleep 2   # let the Worker flush the tail of its request log
say "Worker status codes served"
grep -oE '(GET|POST|PUT|DELETE|PATCH|HEAD) [^ ]+ [0-9]{3}' "$LOG" | awk '{print $3}' | sort | uniq -c | sed 's/^/ /'
if grep -qE ' 5[0-9]{2} ' "$LOG"; then
  echo "  WARNING: the Worker served a 5xx" >&2
  RESULT=1
fi

exit $RESULT
