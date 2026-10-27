#!/bin/sh
# FrostTrader phone alerts (ntfy) on the Pi (docs/ALERTS.md). Run it yourself on the Pi:
#
#   ssh henwy@pihost
#   cd ~/frosttrader && git pull && sh scripts/pi-alerts-setup.sh
#
# It updates FrostTrader, makes a new private topic name, writes it into data/notify.json (readable
# only by you; FrostTrader never shows it again), prints it ONCE for the ntfy app on your phone, and
# restarts FrostTrader. Run it again to make a new topic (the old one stops getting alerts).
set -eu
cd "$(dirname "$0")/.."
topic="frosttrader-$(python3 -c 'import secrets,string;a=string.ascii_lowercase+string.digits;print("".join(secrets.choice(a) for _ in range(24)))')"
mkdir -p data
umask 077
python3 - "$topic" <<'PY'
import json, os, sys
f = 'data/notify.json'
try:
    cur = json.load(open(f))
except Exception:
    cur = {}
cur.update({'enabled': True, 'server': cur.get('server') or 'https://ntfy.sh', 'topic': sys.argv[1]})
tmp = f + '.tmp'
with open(tmp, 'w') as out:
    json.dump(cur, out, indent=1)
os.chmod(tmp, 0o600)
os.replace(tmp, f)
PY
docker compose -f docker-compose.pi.yml up -d --build
sleep 8
docker logs --tail 2 frosttrader
echo
echo "Your private ntfy topic (subscribe to it in the ntfy app; shown only now):"
echo "  $topic"
echo "Server: https://ntfy.sh. Then press 'Send a test' in FrostTrader > Settings > Phone alerts."
