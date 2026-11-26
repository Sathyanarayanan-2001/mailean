// Background thread for CSV import parsing, so a large file never freezes the page.
import { buildImportPreview } from './csv.js';

self.onmessage = (event) => {
  const { id, text, accounts } = event.data || {};
  try {
    self.postMessage({ id, result: buildImportPreview(String(text || ''), accounts || []) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
