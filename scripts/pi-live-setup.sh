#!/bin/sh
# FrostTrader on the Pi: update to the newest version and set up the owner sign-in that live trading
# needs. Run it yourself on the Pi (it asks for your password; nothing is sent anywhere):
#
#   ssh henwy@pihost
#   cd ~/frosttrader && git pull && sh scripts/pi-live-setup.sh
#
# It writes ~/frosttrader/.env (readable only by you) with FROST_TRADER_PASSWORD and a new
# FROST_TRADER_TOTP_SECRET, prints the secret ONCE for KeePassXC (Entry > TOTP > Set up TOTP), then
# rebuilds and restarts the container. Live trading stays OFF: you switch it on yourself in
# Settings > Live trading, through the tunnel (docs/LIVE.md).
set -eu
cd "$(dirname "$0")/.."
if [ -f .env ] && grep -q '^FROST_TRADER_PASSWORD=' .env; then
  echo "A sign-in is already set up in .env. Rebuilding only."
else
  printf 'Choose a FrostTrader password (not your Alpaca one): '
  stty -echo; read -r pw; stty echo; echo
  printf 'Type it again: '
  stty -echo; read -r pw2; stty echo; echo
  [ "$pw" = "$pw2" ] || { echo "They differ. Nothing was changed."; exit 1; }
  [ ${#pw} -ge 12 ] || { echo "Use at least 12 characters. Nothing was changed."; exit 1; }
  case "$pw" in *"'"*|*'
'*) echo "Please leave out the ' character. Nothing was changed."; exit 1 ;; esac
  secret=$(python3 -c 'import base64,os;print(base64.b32encode(os.urandom(20)).decode().rstrip("="))')
  umask 077
  # single quotes: Docker Compose takes the value literally (no $ expansion)
  { echo "FROST_TRADER_PASSWORD='$pw'"; echo "FROST_TRADER_TOTP_SECRET=$secret"; } > .env
  chmod 600 .env
  echo
  echo "Your 6-digit code secret (add it to KeePassXC: Entry > TOTP > Set up TOTP, 30 s, 6 digits):"
  echo "  $secret"
  echo "It is shown only now. It is also in ~/frosttrader/.env, readable only by you."
fi
docker compose -f docker-compose.pi.yml up -d --build
sleep 8
docker logs --tail 3 frosttrader
echo "Done. Live trading is still OFF. Next: docs/LIVE.md, step 2 (your live keys in Settings)."
