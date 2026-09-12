// Reading the one secret this repository cannot function without.
//
// Its own module because it is the only pure function in the release path, and the thing
// most likely to be wrong is not the code but what was pasted into the secret — which is
// testable here with keys generated for the test, and nowhere else.
import { createPrivateKey } from 'node:crypto';

/** The key as OpenSSL will accept it.
 *
 *  A secret is pasted by a person into a web form, and three things happen to it on the
 *  way: the line breaks arrive as the two characters `\` and `n`, the whole thing arrives
 *  wrapped in quotes, or only the base64 body is copied and the armour left behind. All
 *  three reach OpenSSL as the same `DECODER routines::unsupported`, which says nothing
 *  about which one it was — and the release that blocked on it had already built four
 *  targets by then.
 *
 *  So the recoverable shapes are recovered, and the rest are named by shape: the PEM header
 *  is a fixed public string and a line count is not key material, which is the most that
 *  can be said out loud in a job that has the key in its environment. */
export function readSigningKey(raw) {
  let text = raw.trim();
  if (/^(".*"|'.*')$/s.test(text)) text = text.slice(1, -1).trim();
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n').trim();
  if (!text.startsWith('-----BEGIN')) {
    const body = text.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(body) && body.length >= 40) {
      text = `-----BEGIN PRIVATE KEY-----\n${body.replace(/(.{64})/g, '$1\n').trim()}\n-----END PRIVATE KEY-----\n`;
    }
  }

  let key;
  try {
    key = createPrivateKey(text);
  } catch (error) {
    const header = /^-----BEGIN ([A-Z0-9 ]+)-----/.exec(text)?.[1];
    throw new Error([
      'CAPABILITY_SIGNING_KEY could not be read as a private key.',
      header ? `It begins "-----BEGIN ${header}-----".` : 'It carries no PEM header, and its body is not base64.',
      header === 'OPENSSH PRIVATE KEY' ? 'That is ssh-keygen\'s own format; convert it with `openssl pkey -in key -out key.pem`.' : '',
      header === 'PUBLIC KEY' || header === 'RSA PUBLIC KEY' ? 'That is the public half of the pair.' : '',
      `Shape: ${text.split('\n').length} line(s), ${text.length} characters (${error.code ?? error.message}).`,
      'Re-set the secret to the PKCS#8 PEM, header and footer included.',
    ].filter(Boolean).join(' '));
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`The signing key is ${key.asymmetricKeyType}, not Ed25519.`);
  return key;
}
