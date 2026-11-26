// Formatting and calendar maths. Pure functions, no DOM, so Node tests can import them.
// Money is always whole paise (integers); dates are derived, never typed in.

export const GROUPS = [
  { key: 'action_required', name: 'Action Required', short: 'Action', slot: 1 },
  { key: 'awaiting_reply', name: 'Awaiting Reply', short: 'Awaiting', slot: 2 },
  { key: 'receipts_finance', name: 'Receipts & Finance', short: 'Receipts', slot: 3 },
  { key: 'newsletters_reading', name: 'Newsletters & Reading', short: 'Reading', slot: 4 },
  { key: 'promotions_spam', name: 'Promotions & Spam', short: 'Promos', slot: 5 },
  { key: 'low_priority', name: 'Low Priority / Archive', short: 'Low', slot: 6 },
];
export const GROUP_BY_KEY = new Map(GROUPS.map((g) => [g.key, g]));

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Only http(s) and mailto links may be rendered; anything else (javascript:, data:) is dropped. */
export function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- money

const AMOUNT_RE = /^(-)?([0-9][0-9,]*)(?:\.([0-9]{1,2}))?$/;
export const MAX_PAISE = 1e15;

/** "₹1,23,456.78" | "Rs. 1234.5" | "1,23,456" -> integer paise, or null. No floating point. */
export function parseInrToPaise(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\s+/g, '');
  if (s.startsWith('-₹')) s = '-' + s.slice(2);
  const m = AMOUNT_RE.exec(s);
  if (!m) return null;
  const whole = m[2].replace(/,/g, '');
  if (!whole) return null;
  const frac = (m[3] || '').padEnd(2, '0');
  const value = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(value) || value > MAX_PAISE) return null;
  return m[1] ? -value : value;
}

/** 12345678 -> "1,23,456.78" (lakh/crore grouping). Integer arithmetic only. */
export function formatInr(paise) {
  if (!Number.isSafeInteger(paise)) throw new TypeError('paise must be a safe integer');
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rem = abs % 100;
  let digits = String(rupees);
  if (digits.length > 3) {
    let head = digits.slice(0, -3);
    const tail = digits.slice(-3);
    const groups = [];
    while (head.length > 2) {
      groups.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) groups.unshift(head);
    digits = [...groups, tail].join(',');
  }
  return `${sign}${digits}.${String(rem).padStart(2, '0')}`;
}

export const formatRupees = (paise) => (paise < 0 ? '-₹' + formatInr(-paise) : '₹' + formatInr(paise));

/**
 * Short rupee label for chart axes: ₹950, ₹12.5K, ₹4.05 L, ₹1.2 Cr.
 * Display only: the division here is never used for totals, which stay in paise.
 */
export function formatRupeesCompact(paise) {
  const r = paise / 100;
  const abs = Math.abs(r);
  const trim = (v) => String(Number(v.toFixed(2)));
  if (abs >= 1e7) return `₹${trim(r / 1e7)} Cr`;
  if (abs >= 1e5) return `₹${trim(r / 1e5)} L`;
  if (abs >= 1e3) return `₹${trim(r / 1e3)}K`;
  return `₹${Math.round(r)}`;
}

/** Whole numbers with Indian grouping, for counts: 123456 -> "1,23,456". */
export function formatCount(n) {
  return formatInr(Math.round(n) * 100).slice(0, -3);
}

// ---------------------------------------------------------------- calendar

const partCache = new Map();
function partsFormatter(timeZone) {
  let f = partCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    partCache.set(timeZone, f);
  }
  return f;
}

export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Calendar parts of an instant in a time zone. Formatter is cached: O(1) amortised. */
export function localParts(date, timeZone = deviceTimeZone()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(d)) p[type] = value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mm: Number(p.minute) };
}

const DAY_MS = 86_400_000;

/** ISO 8601 week of a calendar date: weeks start Monday; week 1 holds the year's first Thursday. */
export function isoWeekOfYmd(y, m, d) {
  const t = Date.UTC(y, m - 1, d);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = t + (3 - dow) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7);
  return { year, week };
}

export function isoWeek(date, timeZone) {
  const p = localParts(date, timeZone);
  return p ? isoWeekOfYmd(p.y, p.m, p.d) : null;
}

export const cwLabel = (w) => `CW${String(w.week).padStart(2, '0')}`;
export const cwKey = (w) => `${w.year}-W${String(w.week).padStart(2, '0')}`;

/** Monday (UTC midnight of the calendar date) that starts ISO week {year, week}. */
export function isoWeekMonday({ year, week }) {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - jan4dow * DAY_MS + (week - 1) * 7 * DAY_MS;
}

/** Indian financial year: 1 April to 31 March. */
export function fyStartYearOfYmd(y, m) {
  return m >= 4 ? y : y - 1;
}
export const fyLabelFromStart = (start) => `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
export function fyLabel(date, timeZone) {
  const p = localParts(date, timeZone);
  return p ? fyLabelFromStart(fyStartYearOfYmd(p.y, p.m)) : '';
}

const pad = (n) => String(n).padStart(2, '0');
export function formatDate(date, timeZone) {
  const p = localParts(date, timeZone);
  return p ? `${pad(p.d)}/${pad(p.m)}/${p.y}` : '';
}
export function formatDayMonth(date, timeZone) {
  const p = localParts(date, timeZone);
  return p ? `${pad(p.d)}/${pad(p.m)}` : '';
}
export function formatTime(date, timeZone) {
  const p = localParts(date, timeZone);
  return p ? `${pad(p.hh)}:${pad(p.mm)}` : '';
}
export const formatDateTime = (date, tz) => `${formatDate(date, tz)} ${formatTime(date, tz)}`;

/** Short, list-friendly: time today, "dd/mm" this year, "dd/mm/yyyy" otherwise. */
export function formatWhen(date, now = new Date(), timeZone) {
  const p = localParts(date, timeZone);
  const n = localParts(now, timeZone);
  if (!p || !n) return '';
  if (p.y === n.y && p.m === n.m && p.d === n.d) return `${pad(p.hh)}:${pad(p.mm)}`;
  if (p.y === n.y) return `${pad(p.d)}/${pad(p.m)}`;
  return `${pad(p.d)}/${pad(p.m)}/${p.y}`;
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Parse a day-first date typed by the user: "28/10", "28/10/2026", "28-10-26".
 * Without a year, the most recent past occurrence is used (typing "28/12" in
 * January means last December). Returns {y,m,d} or {error}.
 */
export function parseDayFirst(text, today) {
  const s = String(text ?? '').trim();
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(s);
  if (!m) return { error: 'Type the date day first, like 28/10 or 28/10/2026.' };
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = m[3] ? Number(m[3]) : today.y;
  if (m[3] && m[3].length === 2) y += 2000;
  if (mo < 1 || mo > 12) return { error: `Month ${mo} does not exist. Use day/month, like 28/10.` };
  if (d < 1 || d > daysInMonth(y, mo)) {
    return { error: `${pad(d)}/${pad(mo)}/${y} is not a real date${mo === 2 && d === 29 ? ' (not a leap year)' : ''}.` };
  }
  if (!m[3] && (mo > today.m || (mo === today.m && d > today.d))) {
    y -= 1;
    if (d > daysInMonth(y, mo)) return { error: `29/02/${y} is not a real date (not a leap year).` };
  }
  return { y, m: mo, d };
}

/** UTC instant of local midnight for a calendar date in a zone (for "since" filters). */
export function zonedMidnight({ y, m, d }, timeZone) {
  // Start from UTC midnight and correct by the zone's offset at that moment.
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess -= asUtc - Date.UTC(y, m - 1, d);
  }
  return guess;
}

export function plural(n, one, many = one + 's') {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}
