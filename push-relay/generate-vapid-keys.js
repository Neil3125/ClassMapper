// One-off helper: generates a fresh VAPID key pair for Web Push.
// Run: node generate-vapid-keys.js
//
// The public key is safe to commit/embed in client code. The private key is
// a secret — it proves to push services that pushes came from this relay,
// so it goes into `wrangler secret put VAPID_PRIVATE_KEY`, never into a
// committed file.

import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pubJwk = publicKey.export({ format: 'jwk' });
const rawPub = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pubJwk.x, 'base64url'),
  Buffer.from(pubJwk.y, 'base64url'),
]);

const privJwk = privateKey.export({ format: 'jwk' });
const rawPriv = Buffer.from(privJwk.d, 'base64url');

console.log('VAPID_PUBLIC_KEY =', b64url(rawPub));
console.log('VAPID_PRIVATE_KEY =', b64url(rawPriv));
console.log('\nPublic key also goes into js/push-config.js in the main app.');
