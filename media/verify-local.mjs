import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { MediaAdapter } from './index.mjs';

const source = fileURLToPath(new URL('./verification/synthetic.wav',import.meta.url));
const startedAt = new Date().toISOString();
const settingsDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-media-verification-'));
const adapter = new MediaAdapter({config:{DOUYIN_MEDIA_WHISPER_MODEL:'tiny'},settingsFile:path.join(settingsDirectory,'settings.json')});
await adapter.setEnabled(true,{explicit:true});
const result = await adapter.transcribeAudio({source,backend:'local-whisper',language:'en'});
const resolved=path.resolve(settingsDirectory);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('验收设置清理路径越界。');await fs.rm(resolved,{recursive:true,force:true});
const receipt = {startedAt,finishedAt:new Date().toISOString(),kind:'真实本地 Whisper 识别 Windows SAPI 合成音频',
  sourceSha256:createHash('sha256').update(await fs.readFile(source)).digest('hex'),expected:'The orange cat is sleeping beside the blue window. This recording is only a test.',
  result,passed:Boolean(result.ok&&/orange cat/i.test(result.text)&&/blue window/i.test(result.text))};
await fs.writeFile(new URL('./verification/local-asr.json',import.meta.url),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt,null,2));
assert.equal(receipt.passed,true,'合成语音的核心词句应实际被本地 Whisper 识别。');
