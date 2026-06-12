/*
 * PocketCode mobile — crypto + link parsing
 * --------------------------------------------------------------------------
 * AES-256-GCM, wire-compatible with the Node host and the web viewer:
 *   blob = iv(12) || ciphertext || authTag(16), base64.
 * Pure JS (@noble/ciphers) so it runs in Expo Go with no native build.
 */
import { gcm } from "@noble/ciphers/aes.js";

// --- base64 (no atob/btoa dependency) --------------------------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    s += B64[b0 >> 2];
    s += B64[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
    s += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 || 0) >> 6)] : "=";
    s += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return s;
}

export function b64ToBytes(s) {
  s = s.replace(/=+$/, "");
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function b64urlToBytes(s) {
  return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/"));
}

// --- UTF-8 (handles emoji / surrogate pairs) -------------------------------
function utf8ToBytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c < 0xdc00) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

function bytesToUtf8(bytes) {
  let str = "", i = 0;
  while (i < bytes.length) {
    const c = bytes[i++];
    if (c < 0x80) str += String.fromCharCode(c);
    else if (c < 0xe0) str += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (c < 0xf0) str += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const off = cp - 0x10000;
      str += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
    }
  }
  return str;
}

// --- public API ------------------------------------------------------------
export function keyFromB64url(b64url) {
  return b64urlToBytes(b64url); // 32-byte Uint8Array
}

export function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctTag = gcm(key, iv).encrypt(utf8ToBytes(plaintext)); // ciphertext || tag
  const blob = new Uint8Array(12 + ctTag.length);
  blob.set(iv, 0);
  blob.set(ctTag, 12);
  return bytesToB64(blob);
}

export function decrypt(key, b64) {
  const blob = b64ToBytes(b64);
  const iv = blob.subarray(0, 12);
  const ctTag = blob.subarray(12);
  return bytesToUtf8(gcm(key, iv).decrypt(ctTag));
}

// Parse the connect link the host prints, e.g.
//   https://pocketcode-relay.onrender.com/?room=abc123#k=BASE64URLKEY
// Returns { relayUrl, room, key } or null.
export function parseConnectLink(text) {
  if (!text) return null;
  const room = (text.match(/[?&]room=([^&#\s]+)/) || [])[1];
  const keyB64 = (text.match(/[#&?]k=([A-Za-z0-9_\-]+)/) || [])[1];
  if (!room || !keyB64) return null;

  let relayUrl = "wss://pocketcode-relay.onrender.com";
  const origin = text.match(/^(https?):\/\/([^/?#\s]+)/);
  if (origin) relayUrl = (origin[1] === "https" ? "wss" : "ws") + "://" + origin[2];

  let key;
  try {
    key = keyFromB64url(keyB64);
  } catch {
    return null;
  }
  if (key.length !== 32) return null;
  return { relayUrl, room, key };
}
