// Inbox and receipts export. Two preamble lines say what the file is; the import
// screen skips them by finding the header row. "Action" and "Label" are left
// blank so the owner can fill them in Excel and import the file back as commands.

import { GROUP_BY_KEY, cwLabel, formatDate, formatDateTime, formatInr, formatTime, fyLabel, isoWeek } from './format.js';
import { encodeCell, toCsv } from './csv.js';

export const EXPORT_HEADER = [
  'Account', 'Account name', 'Message ID', 'Message IDs', 'Thread ID', 'Date', 'Time', 'FY', 'Week',
  'From', 'From address', 'Subject', 'Group', 'Priority', 'Summary', 'Suggested action', 'Suggested label',
  'Amount (₹)', 'Reference', 'Action', 'Label',
];

export function exportInboxCsv(messages, accounts, { timeZone, now = new Date(), title = 'Mailean inbox export' } = {}) {
  const names = new Map(accounts.map((a) => [a.id, a.label]));
  const nowWeek = isoWeek(now, timeZone);
  const rows = [
    [encodeCell(title)],
    [encodeCell(`Generated ${formatDateTime(now, timeZone)} (${fyLabel(now, timeZone)}, ${cwLabel(nowWeek)}). Fill the Action column, then use Import.`)],
    [],
    EXPORT_HEADER,
  ];
  for (const m of messages) {
    const d = new Date(m.ts);
    const w = isoWeek(d, timeZone);
    rows.push([
      encodeCell(m.account), encodeCell(names.get(m.account) || m.account),
      encodeCell(m.id, 'id'), encodeCell(m.message_ids.join(' ')), encodeCell(m.thread_id, 'id'),
      formatDate(d, timeZone), formatTime(d, timeZone), fyLabel(d, timeZone), `${cwLabel(w)} ${w.year}`,
      encodeCell(m.sender_name), encodeCell(m.sender_email), encodeCell(m.subject),
      encodeCell(GROUP_BY_KEY.get(m.group)?.name || m.group), String(m.priority), encodeCell(m.summary),
      encodeCell(m.suggested_action), encodeCell(m.suggested_label || ''),
      m.amount_paise === null ? '' : formatInr(m.amount_paise),
      encodeCell(m.reference || '', 'id'), '', '',
    ]);
  }
  return toCsv(rows);
}
