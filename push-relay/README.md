# ClassMapper push relay

The one server ClassMapper has. It exists for exactly one reason: a browser
can only receive a push notification while fully closed if *something*
outside the browser holds onto the message and delivers it later — that's
a platform requirement (the [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)),
not a design choice. Everything else about ClassMapper still runs entirely
on your device.

**What it knows:** a push subscription (an opaque endpoint + keys the
browser hands out — not tied to your identity) and a list of
`{ tag, sendAt, title, body }` instructions the app computed for you, e.g.
*"at 9:47am, show 'Time to leave for CS 101'"*. It has no idea what a class
is, has never seen your schedule, and can't compute a leave-by time itself —
the app does all of that, the same way it always has, and just hands this
relay the finished text and a timestamp.

**What it forgets:** every alert, the moment it's delivered — or within
~26 hours regardless, so an outage can't leave stale data sitting around
forever.

**Privacy tradeoff, stated plainly:** the notification *text* (which will
usually include your course code and building) passes through this relay to
reach a push service (e.g. Google's FCM) on its way to your device. That's
new — every other part of ClassMapper keeps your schedule on your device
only. Background alerts are opt-in in Settings specifically because of this.

---

## Deploying your own relay

You need a (free) Cloudflare account and about five minutes. Claude can
write code but can't create the account or complete the browser login for
you — those two steps are yours.

```bash
cd push-relay
npm install
```

**1. Log in to Cloudflare** (opens a browser window):
```bash
npx wrangler login
```

**2. Create the KV namespace** that holds pending alerts:
```bash
npx wrangler kv namespace create ALERTS
```
It prints an `id`. Paste it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

**3. Generate a VAPID key pair** (proves to push services that pushes came
from your relay — separate from, and unrelated to, your Cloudflare login):
```bash
node generate-vapid-keys.js
```

**4. Store the keys as secrets** (never committed — Wrangler prompts you to
paste each value, it doesn't go on the command line):
```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```
For `VAPID_SUBJECT`, paste `mailto:you@example.com` — push services use it
to contact you if your relay is ever misbehaving (sending too much, etc.).

**5. Deploy:**
```bash
npx wrangler deploy
```
It prints your Worker's URL — something like
`https://classmapper-push-relay.<your-subdomain>.workers.dev`.

**6. Wire it into the app.** Open `../js/push-config.js` and fill in:
- `RELAY_URL` — the Worker URL from step 5
- `VAPID_PUBLIC_KEY` — the same public key from step 3 (the *public* one only)

Commit and push (`git add`, `git commit`, `git push`) like any other change
— GitHub Pages redeploys the app the same way it always has. Background
alerts turn on for anyone who opts in from Settings after that.

---

## Cost

Cloudflare's free tier: 100,000 Worker requests/day, unlimited Cron Trigger
invocations, 1,000 KV writes/day and 100,000 reads/day. A single user
checking the app a few times a day and getting a handful of alerts is
nowhere close to any of those limits. Multiple users would still need to
share this one relay deployment (each gets their own KV entries, keyed by
their own subscription) unless you deploy separate relays.

## Debugging

```bash
npx wrangler tail
```
streams live logs from the deployed Worker — useful if alerts aren't
arriving. Push delivery failures with a 404/410 status (an expired or
revoked subscription) are expected and silently cleaned up; anything else
gets logged.
