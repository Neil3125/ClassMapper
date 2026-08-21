// ClassMapper push relay — the one server this project has.
//
// It knows nothing about your schedule. The app computes exactly what each
// notification should say and exactly when it should fire, entirely on your
// device, the same way it always has — this just holds onto that list of
// "send this text at this time" instructions and delivers them via Web Push
// even if your browser is closed by then. It forgets each instruction the
// moment it's delivered (or after ~26h if it's never claimed).
//
// Endpoints:
//   POST /schedule    { subscription, alerts: [{ tag, sendAt, title, body }] }
//   POST /unschedule  { subscription }              — clears all of a subscription's pending alerts
//   (scheduled)                                       — cron: sends anything due, every minute

import { sendWebPush } from './webpush.js';

const ALERT_TTL_SECONDS = 26 * 60 * 60;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, init = {}, origin) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(init.headers ?? {}) },
  });
}

async function subscriptionId(subscription) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function isValidSubscription(sub) {
  return Boolean(sub?.endpoint && sub?.keys?.p256dh && sub?.keys?.auth);
}

async function handleSchedule(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!isValidSubscription(body?.subscription) || !Array.isArray(body?.alerts)) {
    return json({ error: 'Expected { subscription, alerts: [...] }' }, { status: 400 }, origin);
  }
  if (body.alerts.length > 50) {
    return json({ error: 'Too many alerts in one batch (max 50)' }, { status: 400 }, origin);
  }

  const subId = await subscriptionId(body.subscription);
  let stored = 0;

  for (const alert of body.alerts) {
    if (!alert.tag || !Number.isFinite(alert.sendAt) || !alert.title) continue;
    const key = `alert:${subId}:${alert.tag}`;
    await env.ALERTS.put(
      key,
      JSON.stringify({
        subscription: body.subscription,
        title: String(alert.title).slice(0, 200),
        body: String(alert.body ?? '').slice(0, 500),
        sendAt: alert.sendAt,
      }),
      { expirationTtl: ALERT_TTL_SECONDS },
    );
    stored++;
  }

  return json({ ok: true, stored }, {}, origin);
}

async function handleUnschedule(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!isValidSubscription(body?.subscription)) {
    return json({ error: 'Expected { subscription }' }, { status: 400 }, origin);
  }
  const subId = await subscriptionId(body.subscription);
  let removed = 0;
  let cursor;
  do {
    const page = await env.ALERTS.list({ prefix: `alert:${subId}:`, cursor });
    await Promise.all(page.keys.map((k) => env.ALERTS.delete(k.name)));
    removed += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ ok: true, removed }, {}, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? undefined;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method === 'POST' && url.pathname === '/schedule') {
      return handleSchedule(request, env, origin);
    }
    if (request.method === 'POST' && url.pathname === '/unschedule') {
      return handleUnschedule(request, env, origin);
    }
    return json({ error: 'Not found' }, { status: 404 }, origin);
  },

  /** Runs on the Cron Trigger (see wrangler.toml) — delivers anything due, drops anything that's expired or whose subscription the browser has revoked. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(deliverDue(env));
  },
};

async function deliverDue(env) {
  const now = Date.now();
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  };

  let cursor;
  do {
    const page = await env.ALERTS.list({ prefix: 'alert:', cursor });
    await Promise.all(
      page.keys.map(async (k) => {
        const raw = await env.ALERTS.get(k.name);
        if (!raw) return;
        const alert = JSON.parse(raw);
        if (alert.sendAt > now) return; // not due yet

        try {
          await sendWebPush(alert.subscription, { title: alert.title, body: alert.body, tag: k.name }, vapid);
        } catch (err) {
          // 404/410 = the browser unsubscribed or the subscription expired;
          // anything else, leave it — the next run (or the TTL) will sort it out.
          if (err.status !== 404 && err.status !== 410) {
            console.warn('Push delivery failed', k.name, err.message);
            return;
          }
        }
        await env.ALERTS.delete(k.name);
      }),
    );
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
