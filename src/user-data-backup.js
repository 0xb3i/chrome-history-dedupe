import {
  TITLE_OVERRIDES_STORAGE_KEY,
  TITLE_OVERRIDES_MIGRATION_STORAGE_KEY,
  TITLE_OVERRIDES_MIGRATION_VERSION,
  GROUP_NAME_OVERRIDES_STORAGE_KEY,
  PINNED_URLS_STORAGE_KEY,
  readUserDataForBackup,
  mergeUserDataFromBackup
} from './storage.js';

const BACKUP_FORMAT = 'history-dedupe-user-data';
const BACKUP_VERSION = 1;

export async function exportUserDataBackup() {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: await readUserDataForBackup()
  };
}

export async function importUserDataBackup(backup) {
  validateUserDataBackup(backup);
  return mergeUserDataFromBackup(backup.data);
}

export function validateUserDataBackup(backup) {
  if (!isRecord(backup) || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw new Error('请选择此插件导出的备份文件，或升级插件以读取较新版本的备份。');
  }
  const data = backup.data;
  if (!isRecord(data)) throw invalidData();
  const version = data[TITLE_OVERRIDES_MIGRATION_STORAGE_KEY];
  if (!Number.isInteger(version) || version < 0 || version > TITLE_OVERRIDES_MIGRATION_VERSION) {
    throw new Error('备份数据版本不受支持，请升级插件后重试。');
  }
  const titles = data[TITLE_OVERRIDES_STORAGE_KEY];
  const groups = data[GROUP_NAME_OVERRIDES_STORAGE_KEY];
  const pins = data[PINNED_URLS_STORAGE_KEY];
  if (!isRecord(titles) || !isRecord(groups) || !Array.isArray(pins)) throw invalidData();
  for (const [key, record] of Object.entries(titles)) {
    if (!isText(key)) throw invalidData();
    if (typeof record === 'string') {
      if (!isText(record)) throw invalidData();
    } else if (!isRecord(record) || !isText(record.title) ||
      (record.targetUrl !== undefined && !isText(record.targetUrl)) ||
      (record.updatedAt !== undefined && !Number.isFinite(record.updatedAt))) {
      throw invalidData();
    }
  }
  if (Object.entries(groups).some(([key, title]) => !isText(key) || !isText(title)) ||
    pins.some((key) => !isText(key))) throw invalidData();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function invalidData() {
  return new Error('备份内容不完整或格式无效，未导入任何数据。');
}
