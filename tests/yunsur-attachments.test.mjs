import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { messageAttachment, readMessageAttachment } from '../yunsur-attachments.mjs';

function examplePdf() {
  const content = 'BT /F1 12 Tf 20 80 Td (AB) Tj ET';
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Synthetic def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
2 beginbfchar
<41> <4E2D>
<42> <6587>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const stream = value => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream(content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>',
    stream(cmap),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-file-reader-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^douyin-file-reader-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const viaLocalFile = bytes => async (url, target, options) => {
  assert.equal(options.trustedDouyinAttachment, true);
  assert.ok(bytes.length <= options.maxBytes);
  await fs.writeFile(target, bytes, { flag: 'wx' });
  return { bytes: bytes.length };
};

test('指定 PDF 附件在本机提取中文正文和文件名', async t => {
  const bytes = examplePdf();
  const attachment = messageAttachment('file', { name: '合成附件.pdf', format: 'application/octet-stream', mime_type: 'application/pdf',
    file_url: 'https://attachment.douyincdn.com/synthetic', data_size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') });
  assert.equal(attachment.readable, true);
  const captured = await readMessageAttachment(attachment, await fixture(t), { download: viaLocalFile(bytes) });
  assert.deepEqual(captured?.fileText, { filename: '合成附件.pdf', format: 'pdf', text: '中文', truncated: false });
});

test('通用文件类型使用已知扩展名，文字 MIME 参数不影响读取正文', async t => {
  const url = 'https://attachment.douyincdn.com/synthetic';
  const pdf = messageAttachment('file', { file_name: '合成.pdf', format: 'application/octet-stream', file_url: url });
  assert.equal(pdf.readable, true);
  assert.equal(pdf.format, 'pdf');
  assert.equal(messageAttachment('file', { file_name: '未知.exe', format: 'application/octet-stream', file_url: url }).readable, false);
  assert.equal(messageAttachment('file', { file_name: '伪装.txt', mime_type: 'text/html', file_url: url }).readable, false);
  const text = messageAttachment('file', { file_name: '合成说明', mime_type: 'text/plain; charset=utf-8', file_url: url });
  const result = await readMessageAttachment(text, await fixture(t), { download: viaLocalFile(Buffer.from('合成说明正文')) });
  assert.equal(result.fileText.text, '合成说明正文');
});

test('伪装成 PDF 的网页不作为文件正文', async t => {
  const attachment = messageAttachment('file', { name: '合成附件.pdf', download_url: 'https://attachment.douyincdn.com/synthetic' });
  const captured = await readMessageAttachment(attachment, await fixture(t), { download: viaLocalFile(Buffer.from('<html>合成登录提示</html>')) });
  assert.equal(captured, null);
});

test('指定原生视频附件从本机正片单独解码', async t => {
  const bytes = await fs.readFile(new URL('./fixtures/headless-progress.mp4', import.meta.url));
  const attachment = messageAttachment('video-attachment', { name: '合成正片.mp4',
    video: { play_addr: { url_list: ['https://attachment.douyincdn.com/synthetic'] } } });
  const captured = await readMessageAttachment(attachment, await fixture(t), { download: viaLocalFile(bytes) });
  assert.equal(captured?.understandingScope, 'single-message-video-samples');
  assert.ok(captured?.videoAttachment.durationSeconds > 0);
  assert.ok(captured?.frames.length >= 1);
});
