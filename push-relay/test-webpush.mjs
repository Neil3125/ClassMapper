// Round-trip self-test for src/webpush.js: encrypts with our own RFC 8291
// implementation, then independently decrypts and verifies using a
// from-scratch reader of that same output, plus checks the VAPID JWT's
// signature verifies. Not part of the deploy — just proof the hand-rolled
// crypto in webpush.js is actually correct, since a subtly wrong derivation
// would otherwise fail silently against a real push service with no useful
// error message.
//
// Run: node test-webpush.mjs

import assert from 'node:assert/strict';

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  return new Uint8Array(Buffer.from((str + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

// --- fake "browser" push subscription -------------------------------------
const clientKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const clientPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', clientKeyPair.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const subscription = {
  endpoint: 'https://example.invalid/push/abc123',
  keys: { p256dh: b64url(clientPublicRaw), auth: b64url(authSecret) },
};

// --- fake VAPID identity ----------------------------------------------------
const vapidKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapidPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidKeyPair.publicKey));
const vapidPrivateJwk = await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey);

// Import webpush.js's internals by re-implementing the same call sequence
// its exported sendWebPush() would make, but intercepting the fetch instead
// of actually sending it — lets us inspect the exact bytes it produced.
const mod = await import('./src/webpush.js');

const vapidPrivateRawD = fromB64url(vapidPrivateJwk.d);
const payload = { title: 'Time to leave for CS 101', body: '5 min walk to Brimmer Hall', tag: 'cs101:540' };

let capturedRequest = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  capturedRequest = { url, init };
  return { ok: true, text: async () => '' };
};
await mod.sendWebPush(subscription, payload, {
  publicKey: b64url(vapidPublicRaw),
  privateKey: b64url(vapidPrivateRawD),
  subject: 'mailto:test@example.com',
});
globalThis.fetch = realFetch;

assert.ok(capturedRequest, 'sendWebPush should have called fetch');
assert.equal(capturedRequest.url, subscription.endpoint);
assert.equal(capturedRequest.init.headers['Content-Encoding'], 'aes128gcm');

// --- verify the VAPID JWT's signature really validates ---------------------
const authHeader = capturedRequest.init.headers.Authorization;
const jwt = authHeader.match(/t=([^,]+)/)[1];
const [headerB64, payloadB64, sigB64] = jwt.split('.');
const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
const sig = fromB64url(sigB64);
const verified = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' },
  vapidKeyPair.publicKey,
  sig,
  signingInput,
);
assert.equal(verified, true, 'VAPID JWT signature must verify against the public key');

const claims = JSON.parse(Buffer.from(fromB64url(payloadB64)).toString('utf8'));
assert.equal(claims.aud, 'https://example.invalid');
assert.equal(claims.sub, 'mailto:test@example.com');
assert.ok(claims.exp > Date.now() / 1000);
console.log('✔ VAPID JWT is well-formed and its signature verifies');

// --- decrypt the aes128gcm body independently, per RFC 8291/8188 -----------
const body = new Uint8Array(capturedRequest.init.body);
const salt = body.slice(0, 16);
const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
const keyIdLen = body[20];
const serverPublicRaw = body.slice(21, 21 + keyIdLen);
const ciphertext = body.slice(21 + keyIdLen);
assert.equal(recordSize, 4096);
assert.equal(keyIdLen, 65);

const serverPublicKey = await crypto.subtle.importKey(
  'raw',
  serverPublicRaw,
  { name: 'ECDH', namedCurve: 'P-256' },
  false,
  [],
);
const sharedSecret = new Uint8Array(
  await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPublicKey }, clientKeyPair.privateKey, 256),
);

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const utf8 = (s) => new TextEncoder().encode(s);

const sharedSecretKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
const ikmInfo = concat(utf8('WebPush: info\0'), clientPublicRaw, serverPublicRaw);
const ikm = new Uint8Array(
  await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: ikmInfo }, sharedSecretKey, 256),
);

const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
const cek = await crypto.subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('Content-Encoding: aes128gcm\0') },
  ikmKey,
  128,
);
const nonce = new Uint8Array(
  await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8('Content-Encoding: nonce\0') }, ikmKey, 96),
);

const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, ciphertext));

// Last byte is the RFC 8188 "last record" delimiter (0x02); strip it.
assert.equal(plaintext[plaintext.length - 1], 0x02);
const decoded = JSON.parse(Buffer.from(plaintext.slice(0, -1)).toString('utf8'));
assert.deepEqual(decoded, payload);
console.log('✔ Payload round-trips: encrypted by webpush.js, independently decrypted, matches exactly');

console.log('\nAll webpush.js self-checks passed.');
