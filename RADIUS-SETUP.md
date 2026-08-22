# RADIUS mode - router setup guide (phase 4)

Follows on from the RADIUS work in phases 1-3 (auth server, accounting,
admin UI toggle - see the "feat(radius): ..." and "feat(sites): ..." commit
messages for what each added). This is the part that needed a real
tenant + real MikroTik to fully close out, which wasn't available while
building it - so this doc is written to get someone through that first
live test, with a diagnostic tool to isolate server-side vs router-side
if something doesn't work.

## What got built to support this phase

- `test/radius-integration.test.js` - unlike the phase 1/2 smoke tests
  (which call the codec functions directly), this one actually starts
  `startAuthServer()`/`startAcctServer()` on real loopback UDP sockets
  and fires real packets at them over the network stack - the closest
  thing to a live-router test achievable without physical hardware.
  Run: `node test/radius-integration.test.js`
- `scripts/radius-diagnostic.js` - a standalone CLI tool (no DB, no repo
  checkout needed - it's self-contained) that sends a real Access-Request
  and Accounting-Start/Stop at a *deployed* server, the way a router's
  RADIUS client would. **Run this first** if a router "isn't working" -
  it tells you in one command whether the problem is server-side
  (wrong secret/NAS-Identifier, server unreachable) or router-side
  (RouterOS config), before you go digging through router logs.

### A finding from building the integration test worth knowing

Sending a wrong secret with **no** Message-Authenticator attribute
produces a normal Access-Reject, not a silent drop - the server decrypts
the password with whatever secret it has on file, gets garbage, and a
garbage password just looks like a wrong password. Only a request that
**includes** Message-Authenticator lets the server catch a wrong secret
and drop it before attempting anything. This is correct RADIUS protocol
behavior, not a bug - but it means Message-Authenticator is doing real
security work here, not just optional decoration. RouterOS's default
behavior on whether it's sent varies by version; worth confirming
against your actual unit early rather than assuming.

## Before you start

1. The site must already exist in YourNet with **type = Mikrotik**.
2. You need admin (SSH or Winbox) access to the router.
3. Know your RouterOS version (`/system resource print`) - RADIUS
   support itself is old and stable, but exact menu wording has shifted
   across major versions.
4. **This is a live cutover, not a preview.** The moment you turn RADIUS
   mode on for a site, the portal page stops being able to grant access
   for that site via the old flow (see the fix in the phase 3 commit) -
   customers can't successfully redeem a code until the router is
   actually reconfigured. Do this during a low-traffic window, and have
   the router config ready to paste in *before* you flip the switch in
   the admin panel.

## Step 1 - get your RADIUS credentials

In the admin panel: **Manage Sites -> RADIUS mode** (button appears on
any Mikrotik site) -> **Turn on RADIUS mode**.

This generates and shows, once with copy buttons:
- Server address
- Auth port (default 1812) and Accounting port (default 1813)
- NAS-Identifier (unique to this site)
- Secret

You can reopen this panel later to see the NAS-Identifier and secret
again (they're not hidden after the first view) - but turning RADIUS
mode **off** discards them, and turning it back on generates a
completely new pair. Reconfigure the router at that point too; there's
no way to recover the old secret once it's cleared.

## Step 2 - configure the router (RouterOS)

Exact command from the admin panel (also shown inline in the panel):

```
/radius add service=hotspot address=<server address> secret=<secret> \
    nas-identifier=<NAS-Identifier> \
    authentication-port=<auth port> accounting-port=<accounting port>
```

Then point the hotspot profile this site uses at RADIUS instead of its
local user database:

```
/ip hotspot profile print
/ip hotspot profile set [find name="<profile name>"] use-radius=yes
```

If you're not sure which profile the site uses, check whichever one was
set up during the site's original Mikrotik config wizard
(`rsc-wizard.html` / `POST /sites/mikrotik/hotspot-profiles`).

Two things worth setting explicitly rather than leaving default,
depending on RouterOS version:

- **`radius-accounting=yes`** on the hotspot profile, if it's a separate
  toggle from `use-radius` on your version - accounting won't flow
  otherwise, and the dashboard's live-clients view for this site will
  stay empty even though auth works.
- If your RouterOS version exposes it, sending **Message-Authenticator**
  on Access-Request is worth turning on explicitly - see the security
  note above for why.

## Step 3 - verify, in this order

**3a. Server side, before touching the router again:**

```
node scripts/radius-diagnostic.js \
  --host <server address> --secret <secret> --nas-id <NAS-Identifier> \
  --code <a real, currently-unused voucher code for this site>
```

A clean `Access-Accept` here confirms the server has the right secret
and NAS-Identifier on file and is reachable from wherever you're running
this - independent of the router entirely. If this fails, fix it before
even looking at the router; nothing router-side matters until this
passes. (Note: this actually redeems the voucher code it's given, same
as a real login - use a throwaway code, not one you need to keep.)

**3b. Router side, with a real device:**

Connect a phone/laptop to the hotspot, open the login page, enter a
fresh voucher code. Confirm on the router:

```
/ip hotspot active print
```

The session should show up there exactly like an 'api'-mode session
does - RADIUS-authenticated sessions aren't visually distinct in this
list, which is also why the existing kick-a-session code path still
works unmodified for anything the router can reach directly.

**3c. Accounting / dashboard:**

While that session is active, check the dashboard's live-clients view
for this site - it should show the session (reading from
`radius_sessions`, not the router directly - see the phase 2 commit).
Disconnect the test device and confirm the entry clears after the
router sends its Accounting-Stop.

## If something's wrong - troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Diagnostic script: no reply at all | `RADIUS_ENABLED` not set on the deployment | Confirm the env var is `true` and the service restarted |
| Diagnostic script: no reply at all | NAS-Identifier mismatch | Re-check it in the admin panel's RADIUS mode panel - reopen it to confirm the exact current value |
| Diagnostic script: no reply at all | Firewall dropping UDP | Confirm Render (or wherever this is deployed) actually has the auth/acct ports open for inbound UDP |
| Diagnostic script: Access-Reject | Voucher code wrong/expired/already used | Retry with a fresh, confirmed-unused code |
| Router login page: "wrong code" for a code you know is right | Secret mismatch between router config and admin panel | Re-copy the secret from the admin panel - it's easy to fat-finger by hand, use the copy button |
| Router login succeeds but session doesn't show in dashboard | Accounting not enabled on the hotspot profile, or acct port blocked | Check `radius-accounting=yes` on the profile; re-run the diagnostic script's accounting check |
| Customer can't reconnect after a brief Wi-Fi drop | Should be handled automatically (see the reconnect fix in the phase 2 commit) - if it's still failing... | Check the voucher's `expires_at` hasn't actually passed; the fix only re-authenticates a still-active, unexpired voucher |
| Need to back out entirely | — | Manage Sites -> RADIUS mode -> Turn off. Site reverts to the normal push flow immediately; remove the `/radius` entry and set `use-radius=no` on the router's hotspot profile whenever convenient (not urgent - a RADIUS client with no traffic pointed at it is harmless) |

## Known limitation, still true after this phase

Session-Timeout (sent on every Access-Accept) enforces *connected* time,
not wall-clock time from purchase - a voucher with gaps in usage can run
longer in real time than its label suggests, since the router can't be
reached mid-session to cut it off early (that's the CGNAT problem this
whole feature exists to solve). The DB still expires the voucher
correctly on schedule for billing; only the live kick doesn't reach
RADIUS-mode sites. A true fix would need CoA/Disconnect-Message (RFC
3576) support, which is a real, standalone piece of work - not something
folded into this phase.
