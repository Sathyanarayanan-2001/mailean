// Decrypt a state file written by agent/state.py (AES-256-GCM, PBKDF2-SHA256).
// WebCrypto runs off the main thread, so the 600,000-iteration key derivation
// does not freeze the page. The derived key is cached for the session only.

export const ENC_TAG = 'mailean-aesgcm-v1';
const keyCache = new Map();

function b64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isEncrypted(obj) {
  return !!obj && obj.enc === ENC_TAG;
}

async function deriveKey(passphrase, salt, iterations) {
  const id = `${passphrase}\u0000${salt}\u0000${iterations}`;
  if (keyCache.has(id)) return keyCache.get(id);
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64(salt), iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  keyCache.set(id, key);
  return key;
}

export async function decryptState(blob, passphrase) {
  if (!isEncrypted(blob)) throw new Error('Not an encrypted Mailean state file.');
  if (!passphrase) throw new Error('This state file is encrypted. Enter the passphrase in Settings.');
  const iterations = Number(blob.iter) || 600000;
  const key = await deriveKey(passphrase, blob.salt, iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64(blob.iv), additionalData: new TextEncoder().encode(ENC_TAG) }, key, b64(blob.ct),
    );
  } catch {
    keyCache.clear();
    throw new Error('Wrong passphrase: the state file could not be decrypted. Check it matches MAILEAN_STATE_PASSPHRASE.');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

export function forgetKeys() {
  keyCache.clear();
}
