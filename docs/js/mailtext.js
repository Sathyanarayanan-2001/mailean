// Helpers for the email reader. Pure functions (no DOM), tested in Node.
// Email text is shown as text only. Links become clickable only for http(s),
// and the link text is always the real address, so no email can disguise
// where a link goes.

import { safeUrl } from './format.js';
import { MESSAGE_ID_RE } from './commands.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Split text into text and link pieces. O(n) in characters. */
export function linkSegments(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    let url = m[0];
    const trail = TRAILING.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const href = safeUrl(url);
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push(href ? { type: 'link', href, value: url } : { type: 'text', value: url });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

const MSGID_RE = /^<[^<>\s]{3,250}@[^<>\s]{1,250}>$/;

// Gmail's documented search operator takes the Message-ID without angle brackets
// (Gmail Help, "Refine searches in Gmail": rfc822msgid:200503292@example.com).
const bareId = (header) => header.slice(1, -1);

/**
 * Link that opens the message in Gmail on the web. The Message-ID search finds the
 * exact email; authuser picks the right account when several are signed in.
 */
export function gmailLink({ email = '', messageIdHeader = null, id = '' }) {
  const who = email ? `?authuser=${encodeURIComponent(email)}` : '';
  if (messageIdHeader && MSGID_RE.test(messageIdHeader)) {
    return `https://mail.google.com/mail/${who ? '' : 'u/0/'}${who}#search/${encodeURIComponent(`rfc822msgid:${bareId(messageIdHeader)}`)}`;
  }
  return MESSAGE_ID_RE.test(id) ? `https://mail.google.com/mail/${who ? '' : 'u/0/'}${who}#all/${id}` : 'https://mail.google.com/mail/';
}

/** Text to paste into Gmail's search box, including the phone app. */
export function gmailSearch(messageIdHeader) {
  return messageIdHeader && MSGID_RE.test(messageIdHeader) ? `rfc822msgid:${bareId(messageIdHeader)}` : '';
}

/** 512 B, 12.5 KB, 1.3 MB (1 KB = 1,024 bytes). */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(v / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/** Check a saved text file and keep only known fields with bounded sizes. */
export function validateBody(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null;
  return {
    id: MESSAGE_ID_RE.test(raw.id || '') ? raw.id : '',
    from: cap(raw.from, 300), to: cap(raw.to, 1000), cc: cap(raw.cc, 1000),
    subject: cap(raw.subject, 300), date: cap(raw.date, 100),
    text: cap(raw.text, 25000), truncated: !!raw.truncated, format: cap(raw.format, 10),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).slice(0, 50).map((a) => ({
      name: cap(a && a.name, 120) || 'attachment', mime: cap(a && a.mime, 100), size: Number(a && a.size) || 0,
    })),
  };
}

/** The conversation's message ids, newest first (Gmail ids grow with time). */
export function conversationOrder(row) {
  const others = (row.message_ids || []).filter((x) => x !== row.id).sort().reverse();
  return [row.id, ...others].slice(0, 10);
}

/** Check a fetched-attachments manifest; file names are used in a URL path, so they are strict. */
export function validateManifest(raw) {
  if (!raw || !Array.isArray(raw.files)) return null;
  return {
    fetched_at: cap(raw.fetched_at, 30),
    files: raw.files.slice(0, 50).map((f) => ({
      name: cap(f && f.name, 120) || 'attachment', mime: cap(f && f.mime, 100), size: Number(f && f.size) || 0,
      file: /^\d{2}-[A-Za-z0-9._ -]{1,140}$/.test((f && f.file) || '') ? f.file : null,
      encrypted: !!(f && f.encrypted), skipped: cap(f && f.skipped, 200) || null,
    })),
  };
}
