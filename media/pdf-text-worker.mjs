import fs from 'node:fs/promises';
import { getDocument } from './vendor/pdf/pdfjs.mjs';

const maxBytes = 10 * 1024 * 1024;
const maxPages = 40;
const textLimit = 8000;
const file = process.argv[2];
const stat = await fs.stat(file);
if (!stat.isFile() || stat.size > maxBytes) throw Error('PDF 附件体积无效。');
const bytes = await fs.readFile(file);
if (!bytes.subarray(0, 1024).includes('%PDF-')) throw Error('PDF 附件格式无效。');
const task = getDocument({
  data: new Uint8Array(bytes),
  isEvalSupported: false, stopAtErrors: true, useSystemFonts: false, disableFontFace: true,
  useWorkerFetch: false, useWasm: false, verbosity: 0,
});
try {
  const document = await task.promise;
  let text = '';
  const pages = Math.min(document.numPages, maxPages);
  let truncated = document.numPages > pages;
  let readPages = 0;
  for (let number = 1; number <= pages && text.length <= textLimit; number++) {
    const page = await document.getPage(number);
    try {
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const remaining = textLimit + 1 - text.length;
        text += item.str.slice(0, remaining) + (item.hasEOL ? '\n' : ' ');
        if (text.length > textLimit) { truncated = true; break; }
      }
      text += '\n';
      readPages++;
    } finally { page.cleanup(); }
  }
  process.stdout.write(JSON.stringify({ text: text.trim().slice(0, textLimit), truncated: truncated || readPages < pages }));
} finally { await task.destroy(); }
