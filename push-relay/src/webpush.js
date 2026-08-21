// Web Push, built on nothing but the platform's own Web Crypto API — no
// npm dependency. This matters specifically because the obvious choice (the
// `web-push` package) sends its HTTP request via Node's `https` module,
// which Cloudflare Workers don't implement even under nodejs_compat; Workers
// only speak `fetch`. So this reimplements the two things `web-push` would
// otherwise do for us: signing a VAPID identity JWT (RFC 8292) and
// encrypting the notification payload (RFC 8291), then sends the result
// with a plain `fetch`.

function b64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const base64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

/** Imports the relay's VAPID key pair (from env secrets) as CryptoKeys. */
async function importVapidKeys(publicKeyB64url, privateKeyB64url) {
  const pubBytes = b64urlToBytes(publicKeyB64url);
  const x = pubBytes.slice(1, 33);
  const y = pubBytes.slice(33, 65);
  const d = b64urlToBytes(privateKeyB64url);

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: bytesToB64url(d), x: bytesToB64url(x), y: bytesToB64url(y), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return { privateKey, publicKeyBytes: pubBytes };
}

/** A signed VAPID identity JWT (RFC 8292) — proves the push service the relay is who it claims, not who's sending the notification content. */
async function buildVapidJwt(privateKey, audience, subject) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const signingInput = `${bytesToB64url(utf8(JSON.stringify(header)))}.${bytesToB64url(utf8(JSON.stringify(payload)))}`;
  // Web Crypto's ECDSA signatures are already in the raw r||s format VAPID
  // wants — no DER-to-raw conversion needed, unlike most other ECDSA tooling.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(signingInput));
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

/**
 * Encrypts `payload` (a plain object) for one push subscription per RFC 8291
 * ("aes128gcm"), and returns the raw bytes to POST as the request body.
 */
async function encryptPayload(payload, subscription) {
  const clientPublicKey = b64urlToBytes(subscription.keys.p256dh); // 65 bytes, uncompressed point
  const authSecret = b64urlToBytes(subscription.keys.auth); // 16 bytes

  // A fresh ECDH key pair per message — this is for payload confidentiality,
  // deliberately separate from the VAPID identity key pair above.
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const serverPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));

  const clientPublicKeyImported = await crypto.subtle.importKey(
    'raw',
    clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKeyImported }, serverKeyPair.privateKey, 256),
  );

  // Stage 1 HKDF: shared ECDH secret + auth secret -> IKM for stage 2.
  const sharedSecretKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const ikmInfo = concatBytes(utf8('WebPush: info\0'), clientPublicKey, serverPublicKeyRaw);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: ikmInfo },
      sharedSecretKey,
      256,
    ),
  );

  // Stage 2 HKDF: IKM + a random per-message salt -> the actual AES key and nonce.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('Content-Encoding: aes128gcm\0') },
    ikmKey,
    128,
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('Content-Encoding: nonce\0') },
      ikmKey,
      96,
    ),
  );

  const cekKey = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  // A single record, no padding beyond the mandatory 0x02 "last record" delimiter (RFC 8188 §2).
  const plaintext = concatBytes(utf8(JSON.stringify(payload)), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, plaintext),
  );

  // RFC 8188 §2.1 header: salt(16) || record size(4, big-endian) || key id length(1) || key id.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const header = concatBytes(salt, recordSize, new Uint8Array([serverPublicKeyRaw.length]), serverPublicKeyRaw);

  return concatBytes(header, ciphertext);
}

/**
 * Sends one Web Push notification. `vapid` = { publicKey, privateKey, subject }
 * (all base64url strings except subject, which is "mailto:you@example.com").
 * Throws on a non-2xx response so callers can decide whether to retry/drop.
 */
export async function sendWebPush(subscription, payload, vapid, ttlSeconds = 60) {
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;

  const { privateKey, publicKeyBytes } = await importVapidKeys(vapid.publicKey, vapid.privateKey);
  const jwt = await buildVapidJwt(privateKey, audience, vapid.subject);
  const body = await encryptPayload(payload, subscription);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(ttlSeconds),
      Authorization: `vapid t=${jwt}, k=${bytesToB64url(publicKeyBytes)}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Push service returned ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
}
