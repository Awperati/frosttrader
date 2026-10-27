# FrostTrader as your private website

Built 27 Oct 2026 after the owner's "I want to turn it into a live trading website now" and "a. sounds
good" (relayed by Top Dog): a **private** website for you only, on your phone and PC. Not public.
**Off until you set it up.**

## How it is protected

1. **Cloudflare Access** in front: only your email gets in, with a one-time code. You set this up.
2. **FrostTrader's own sign-in** behind it: your FrostTrader password and the 6-digit code. Sessions
   end after 30 minutes without use, or 12 hours at most. Wrong attempts lock out that address and slow
   everyone down (never you out for good).
3. FrostTrader also **checks Cloudflare Access's signed token itself**, when you give it your Access
   team name and the app's AUD tag: a request that somehow skipped Access is still refused.
4. The server still listens only on the Pi's own 127.0.0.1; Cloudflare's tunnel (`cloudflared`, already
   running on the Pi) is the only way in from outside. Any hostname but yours is refused.
5. No cookies (a session token in a request header), so no cross-site request forgery; requests must
   come from the site's own page; no CORS; a strict Content-Security-Policy; no framing.
6. From the website you can't save live keys (only on your PC through the SSH tunnel), and you can't
   use the Frost AI connector. Switching live on still needs the phrase, your password and the code.
7. Every sign-in (good or bad), sign-out and change made from the website goes into the audit log.

The kill switch works from the phone: the big red button at the top. A PAPER / LIVE badge is always
in the header.

## Setting it up (you, in this order)

1. **Sign-in on the Pi** (if not done for live trading yet): `ssh henwy@pihost`, then
   `cd ~/frosttrader && git pull && sh scripts/pi-live-setup.sh`.
2. **Cloudflare tunnel: add the hostname.** Cloudflare dashboard → Zero Trust → Networks → Tunnels →
   your Pi's tunnel → Public Hostname → Add: subdomain `trader`, domain `frosttechnology.com.au`,
   service **HTTP** `localhost:8795`.
3. **Cloudflare Access: lock it to you.** Zero Trust → Access → Applications → Add → Self-hosted:
   application domain `trader.frosttechnology.com.au`; session 24 hours; policy "Allow", include
   "Emails" = your email only; login method "One-time PIN". Save, then copy the application's
   **AUD tag** (Overview tab) and note your **team name** (Settings → Custom Pages: the part before
   `.cloudflareaccess.com`).
4. **Tell FrostTrader:** on the Pi, `cd ~/frosttrader && sh scripts/pi-website-setup.sh` and answer
   the three questions (hostname, team name, AUD tag). It restarts FrostTrader.
5. **Open https://trader.frosttechnology.com.au** on your phone: Cloudflare's email code first, then
   FrostTrader's password and 6-digit code.

To switch the website off: run `scripts/pi-website-setup.sh` again with a blank hostname, or remove
the public hostname in Cloudflare. The SSH tunnel way (`ssh -N -L 8788:127.0.0.1:8795 henwy@pihost`)
keeps working either way, with no sign-in.

## Tested

`test/website.test.mjs`: off by default; refused without a session, with another hostname or another
site's Origin; /mcp and live keys refused over the website; sign-in, sign-out and expiry; Access
tokens with a wrong key, audience, team, expiry or signature refused; sign-ins audited. Not tested
against the real Cloudflare (that happens when you set it up).
