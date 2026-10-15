import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const LEGACY_SHARED_MEMORY_DB_PATH = 'D:/codex分局/大肥鱼/memory/shared.sqlite';
const FIELDS = {
  stateDir: 'DOUYIN_STATE_DIR',
  mediaEnvFile: 'DOUYIN_MEDIA_ENV_FILE',
  mediaSettingsFile: 'DOUYIN_MEDIA_SETTINGS_FILE',
  mediaRuntimeRoot: 'DOUYIN_MEDIA_RUNTIME_ROOT',
  mediaModelsDir: 'DOUYIN_MEDIA_MODELS_DIR',
};

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径。`);
  return path.normalize(value);
}

// 此处只读可信启动器写入的位置记录，不创建目录，也不迁移已有状态。
export function resolveRuntimePaths({ env = process.env, home = homedir(), sourceRoot = SOURCE_ROOT, legacyMemoryDbPath = LEGACY_SHARED_MEMORY_DB_PATH } = {}) {
  const locationFile = absolute(env.DOUYIN_RUNTIME_LOCATION_FILE || path.join(home, '.dsh', 'douyin-browser', 'runtime-location.json'), '运行位置记录');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(locationFile, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.version !== 1 || typeof stored.stateDir !== 'string') throw new Error();
    for (const field of Object.keys(FIELDS)) if (stored[field] !== undefined) absolute(stored[field], `运行位置 ${field}`);
    if (stored.memoryDir !== undefined) absolute(stored.memoryDir, '运行位置 memoryDir');
    if (stored.memoryDbPath !== undefined) absolute(stored.memoryDbPath, '运行位置 memoryDbPath');
    if (stored.memoryDbPath !== undefined && stored.memoryDir !== undefined && path.dirname(path.normalize(stored.memoryDbPath)) !== path.normalize(stored.memoryDir)) throw new Error();
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('运行位置记录无法读取或格式错误；未切换到另一套状态。');
  }
  const mediaRoot = path.join(sourceRoot, 'media');
  const selected = (field, fallback) => absolute(env[FIELDS[field]] || stored[field] || fallback, field);
  const stateDir = selected('stateDir', path.join(sourceRoot, 'state'));
  const mediaRuntimeRoot = selected('mediaRuntimeRoot', mediaRoot);
  let memoryDbPath;
  if (env.DEEPSEEK_SHARED_MEMORY_DB?.trim()) memoryDbPath = absolute(env.DEEPSEEK_SHARED_MEMORY_DB, '共享记忆数据库');
  else if (stored.memoryDbPath !== undefined) memoryDbPath = absolute(stored.memoryDbPath, '运行位置 memoryDbPath');
  else if (stored.memoryDir !== undefined) memoryDbPath = path.join(absolute(stored.memoryDir, '运行位置 memoryDir'), 'shared.sqlite');
  else if (path.isAbsolute(legacyMemoryDbPath) && fs.existsSync(legacyMemoryDbPath)) {
    if (!fs.statSync(legacyMemoryDbPath).isFile()) throw new Error('已有共享记忆路径不是文件；未创建另一套数据库。');
    memoryDbPath = path.normalize(legacyMemoryDbPath);
  } else memoryDbPath = path.join(home, '.dsh', 'douyin-browser', 'memory', 'shared.sqlite');
  return {
    locationFile, stateDir, memoryDir: path.dirname(memoryDbPath), memoryDbPath,
    mediaEnvFile: selected('mediaEnvFile', path.join(mediaRoot, '.env')),
    mediaSettingsFile: selected('mediaSettingsFile', path.join(mediaRoot, 'settings.local.json')),
    mediaRuntimeRoot,
    mediaModelsDir: selected('mediaModelsDir', path.join(mediaRuntimeRoot, '.models')),
    mediaCaptureDir: path.join(stateDir, 'media-captures'),
    browserProfileDir: path.join(home, '.dsh', 'douyin-browser', 'cli-profile'),
    browserControlDir: path.join(home, '.dsh', 'douyin-browser', 'control'),
  };
}

export function resolveNodeExecutable({ env = process.env, executable = process.execPath, versions = process.versions } = {}) {
  if (env.DOUYIN_NODE_EXECUTABLE) return absolute(env.DOUYIN_NODE_EXECUTABLE, 'Node 运行程序');
  if (versions.electron) throw new Error('桌面运行时须设置 DOUYIN_NODE_EXECUTABLE，不能将桌面 EXE 当作 Node 启动浏览器。');
  return executable;
}
