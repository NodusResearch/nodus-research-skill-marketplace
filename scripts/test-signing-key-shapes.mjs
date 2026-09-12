// The shapes a pasted signing key arrives in.
//
// The key is typed into a web form by a person, and that form is the last thing to touch it
// before a release depends on it. Three manglings are common, and all three reach OpenSSL
// as one undifferentiated `DECODER routines::unsupported` — which is what a release
// discovered after building four targets, with no way to tell which had happened.
//
// Every key here is generated for the test. None of this ever sees the published one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { readSigningKey } from './lib/signing-key.mjs';

const ed25519 = () => generateKeyPairSync('ed25519');
const pemOf = key => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const refusal = secret => {
  try { readSigningKey(secret); return ''; } catch (error) { return error.message; }
};

test('a key pasted the way people paste keys is still read', () => {
  const pem = pemOf(ed25519().privateKey);
  const body = pem.split('\n').filter(line => !line.startsWith('-----')).join('');

  for (const [shape, secret] of [
    ['the PEM as exported', pem],
    ['with whitespace around it', `  ${pem}\n\n`],
    ['wrapped in quotes by a shell or a form', `"${pem}"`],
    ['single-quoted', `'${pem}'`],
    ['with its newlines escaped', pem.replace(/\n/g, '\\n')],
    ['escaped and quoted together', `"${pem.replace(/\n/g, '\\n')}"`],
    ['with only the base64 body copied', body],
    ['the body, wrapped by whatever pasted it', body.replace(/(.{40})/g, '$1\n')],
  ]) {
    assert.equal(readSigningKey(secret).asymmetricKeyType, 'ed25519', shape);
  }

  // And what comes back is the same key, not merely a key: a reader that quietly produced a
  // different one would sign every release with something nothing can verify.
  const original = ed25519().privateKey;
  const recovered = readSigningKey(pemOf(original).replace(/\n/g, '\\n'));
  assert.equal(recovered.export({ type: 'pkcs8', format: 'pem' }).toString(), pemOf(original));
});

test('what cannot be a signing key is named, not guessed at', () => {
  // The public half is the commonest wrong paste, and the one that would otherwise read as
  // a key-handling fault rather than the wrong half of a pair.
  const publicPem = ed25519().publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.match(refusal(publicPem), /public half of the pair/);

  // An algorithm this contract does not use, refused for what it is rather than for failing
  // to decode: a signature from it would verify nowhere.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.match(refusal(pemOf(rsa.privateKey)), /is rsa, not Ed25519/);

  // ssh-keygen's own container, which OpenSSL will not read at all.
  assert.match(refusal('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----'), /openssl pkey/);

  assert.match(refusal('not a key at all'), /carries no PEM header/);
  assert.match(refusal(''), /carries no PEM header/);
});

test('the refusal says nothing it should not', () => {
  // This runs in a job that has the real key in its environment, so what it prints when the
  // key is wrong matters as much as whether it prints anything.
  const rsa = pemOf(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
  const body = rsa.split('\n').filter(line => !line.startsWith('-----')).join('');
  const message = refusal(rsa);
  assert.equal(message.includes(body.slice(0, 40)), false, 'the key body reached the error message');

  const truncated = refusal(pemOf(ed25519().privateKey).slice(0, 60));
  assert.match(truncated, /\d+ line\(s\), \d+ characters/, 'the shape is reported as counts');
  assert.ok(truncated.length < 600);
});
