#!/bin/sh
# FrostTrader's private website on the Pi (docs/WEBSITE.md). Run it yourself on the Pi AFTER
# scripts/pi-live-setup.sh (which sets your FrostTrader password and 6-digit code):
#
#   ssh henwy@pihost
#   cd ~/frosttrader && git pull && sh scripts/pi-website-setup.sh
#
# It asks for the website's hostname and your Cloudflare Access team name and AUD tag (none of these
# is a secret), writes them into ~/frosttrader/.env, and restarts FrostTrader. Leave the hostname
# blank to switch the website off again.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] && grep -q '^FROST_TRADER_TOTP_SECRET=' .env || { echo "Run scripts/pi-live-setup.sh first (password and 6-digit code)."; exit 1; }
printf 'Website hostname, e.g. trader.frosttechnology.com.au (blank = website off): '; read -r host
printf 'Cloudflare Access team name (the part before .cloudflareaccess.com): '; read -r team
printf 'Cloudflare Access application AUD tag: '; read -r aud
case "$host$team$aud" in *[!A-Za-z0-9.-]*) echo "Only letters, digits, dots and dashes, please. Nothing was changed."; exit 1 ;; esac
tmp=$(mktemp)
grep -v -e '^FROST_TRADER_PUBLIC_HOST=' -e '^FROST_TRADER_CF_TEAM=' -e '^FROST_TRADER_CF_AUD=' .env > "$tmp" || true
{
  cat "$tmp"
  if [ -n "$host" ]; then echo "FROST_TRADER_PUBLIC_HOST=$host"; fi
  if [ -n "$team" ]; then echo "FROST_TRADER_CF_TEAM=$team"; fi
  if [ -n "$aud" ]; then echo "FROST_TRADER_CF_AUD=$aud"; fi
} > .env
rm -f "$tmp"
chmod 600 .env
docker compose -f docker-compose.pi.yml up -d --build
sleep 8
docker logs --tail 3 frosttrader
if [ -n "$host" ]; then echo "Website on for https://$host (Cloudflare must route it to http://localhost:8795)."; else echo "Website off."; fi
