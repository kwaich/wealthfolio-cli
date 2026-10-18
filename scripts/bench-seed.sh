#!/usr/bin/env bash
# Seeds a fresh test server (scripts/test-server.sh up) with a fixed data set
# for scripts/bench.sh:
#
#   Brokerage  USD securities: 6 stocks bought monthly in 2025, dividends
#   Euro ISA   EUR securities: 2 stocks bought quarterly
#   Checking   USD cash, tracked for spending: November 2025 salary,
#              categorised spending, and budget targets for 2025-11
#
#   eval "$(WF_TEST_PROXY=1 scripts/test-server.sh up)"
#   pnpm build && scripts/bench-seed.sh
#
# Run it once per server: it adds the same data again on a second run. Prices
# need the server to reach Yahoo Finance; without them, holdings carry nulls
# and the numbers are smaller than a real portfolio's.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${WF_TEST_URL:?Run: eval \"\$(scripts/test-server.sh up)\"}"
: "${WF_TEST_PASSWORD:?Run: eval \"\$(scripts/test-server.sh up)\"}"
export WF_CONFIG_DIR="${WF_BENCH_CONFIG_DIR:-$ROOT/.bench}"
mkdir -p "$WF_CONFIG_DIR"
wf() { node "$ROOT/dist/wf.js" "$@"; }
id() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'; }

WF_PASSWORD="$WF_TEST_PASSWORD" wf login --url "$WF_TEST_URL" >/dev/null
wf call update_settings --args \
  '{"settingsUpdate":{"baseCurrency":"USD","timezone":"UTC","onboardingCompleted":true}}' >/dev/null

account() {
  wf call create_account --args "{\"account\":{\"name\":\"$1\",\"accountType\":\"$2\",\"currency\":\"$3\",
    \"isDefault\":false,\"isActive\":true,\"isArchived\":false,\"trackingMode\":\"TRANSACTIONS\"}}" | id
}
activity() { wf call create_activity --args "{\"activity\":$1}" | id; }

BROKER=$(account Brokerage SECURITIES USD)
ISA=$(account "Euro ISA" SECURITIES EUR)
CHECKING=$(account Checking CASH USD)
echo "accounts: $BROKER $ISA $CHECKING" >&2

activity "{\"accountId\":\"$BROKER\",\"activityType\":\"DEPOSIT\",\"activityDate\":\"2025-01-02\",\"amount\":\"200000\",\"currency\":\"USD\"}" >/dev/null
activity "{\"accountId\":\"$ISA\",\"activityType\":\"DEPOSIT\",\"activityDate\":\"2025-01-02\",\"amount\":\"100000\",\"currency\":\"EUR\"}" >/dev/null
for symbol in AAPL MSFT NVDA GOOGL AMZN VTI; do
  for month in 01 02 03 04 05 06 07 08 09 10 11 12; do
    activity "{\"accountId\":\"$BROKER\",\"activityType\":\"BUY\",\"activityDate\":\"2025-$month-15\",
      \"quantity\":\"2\",\"unitPrice\":\"$((100 + 10#$month * 3))\",\"fee\":\"1\",\"currency\":\"USD\",
      \"asset\":{\"symbol\":\"$symbol\",\"quoteCcy\":\"USD\"}}" >/dev/null
  done
done
for symbol in SAP.DE ASML.AS; do
  for month in 02 05 08 11; do
    activity "{\"accountId\":\"$ISA\",\"activityType\":\"BUY\",\"activityDate\":\"2025-$month-10\",
      \"quantity\":\"5\",\"unitPrice\":\"200\",\"fee\":\"2\",\"currency\":\"EUR\",
      \"asset\":{\"symbol\":\"$symbol\",\"quoteCcy\":\"EUR\"}}" >/dev/null
  done
done
for month in 03 06 09 12; do
  activity "{\"accountId\":\"$BROKER\",\"activityType\":\"DIVIDEND\",\"activityDate\":\"2025-$month-20\",
    \"amount\":\"12.5\",\"currency\":\"USD\",\"asset\":{\"symbol\":\"AAPL\"}}" >/dev/null
done
echo "investments: done" >&2

# Spending: the account must be tracked before its activities count.
wf call update_spending_settings --args \
  "{\"update\":{\"enabled\":true,\"accountIds\":[\"$CHECKING\"]}}" >/dev/null
categorise() {
  wf call assign_activity_category --args \
    "{\"activityId\":\"$1\",\"taxonomyId\":\"$2\",\"categoryId\":\"$3\"}" >/dev/null
}
salary=$(activity "{\"accountId\":\"$CHECKING\",\"activityType\":\"DEPOSIT\",\"activityDate\":\"2025-11-01\",\"amount\":\"6500\",\"currency\":\"USD\"}")
categorise "$salary" income_sources cat_income_employment
# day category amount
while read -r day category amount; do
  spend=$(activity "{\"accountId\":\"$CHECKING\",\"activityType\":\"WITHDRAWAL\",
    \"activityDate\":\"2025-11-$day\",\"amount\":\"$amount\",\"currency\":\"USD\"}")
  categorise "$spend" spending_categories "$category"
done <<'ROWS'
01 cat_housing 2200
02 cat_groceries 84.20
03 cat_transport 45
04 cat_food 32.50
05 cat_bills 120
06 cat_groceries 61.75
07 cat_entertainment 18.99
08 cat_shopping 149
09 cat_food 27.80
10 cat_health 60
11 cat_groceries 92.10
12 cat_transport 45
13 cat_food 41.20
14 cat_personal 35
15 cat_bills 64.99
16 cat_groceries 73.40
17 cat_travel 410
18 cat_food 22.30
19 cat_gifts 75
20 cat_groceries 88.60
21 cat_entertainment 12.99
22 cat_fees 4.50
23 cat_food 55.10
24 cat_shopping 89
25 cat_groceries 66.30
26 cat_transport 45
27 cat_education 120
28 cat_food 38.90
29 cat_other_expense 25
30 cat_groceries 79.95
ROWS
while read -r category amount; do
  wf call upsert_budget_target --args "{\"periodKey\":\"2025-11\",\"target\":{\"periodKey\":\"2025-11\",
    \"targetType\":\"category\",\"taxonomyId\":\"spending_categories\",\"categoryId\":\"$category\",
    \"amount\":\"$amount\"}}" >/dev/null
done <<'ROWS'
cat_housing 2200
cat_groceries 500
cat_food 200
cat_transport 150
cat_bills 200
cat_shopping 150
cat_entertainment 50
ROWS
echo "spending: done" >&2

# Quotes and the recalculation; the sync result says which symbols failed.
wf sync --wait --wait-timeout 300 >&2
