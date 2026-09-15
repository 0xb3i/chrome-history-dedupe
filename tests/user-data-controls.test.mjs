import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = await readFile(new URL('../src/user-data-controls.js', import.meta.url), 'utf8');
const executable = source.replace(/import\s+\{[^}]+\}\s+from\s+'[^']+';/g, '')
  .replace('export function initializeUserDataControls', 'function initializeUserDataControls');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function createControls(options = {}) {
  const { document, window } = parseHTML(await readFile(new URL('../history.html', import.meta.url), 'utf8'));
  const blobs = [];
  const revoked = [];
  const downloads = [];
  const timers = [];
  const imports = [];
  let exportCalls = 0;
  let filePickerCalls = 0;
  const context = vm.createContext({
    document, Blob, Date,
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:backup-${blobs.length}`; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
    async exportUserDataBackup() {
      exportCalls += 1;
      return options.exportBackup ? options.exportBackup() : { format: 'history-dedupe-user-data', version: 1, data: {} };
    },
    async importUserDataBackup(backup) {
      imports.push(backup);
      return options.importBackup ? options.importBackup(backup) : { titles: 2, groups: 1, pins: 3 };
    }
  });
  vm.runInContext(executable, context);
  context.initializeUserDataControls(document);
  const one = (selector) => document.querySelector(selector);
  const fileInput = one('#user-data-file');
  fileInput.addEventListener('click', () => { filePickerCalls += 1; });
  document.addEventListener('click', (event) => {
    if (event.target.localName === 'a') downloads.push({ href: event.target.href, filename: event.target.download });
  });
  function selectFile(text, file = { text: async () => text }) {
    Object.defineProperty(fileInput, 'files', { configurable: true, value: file ? [file] : [] });
    fileInput.value = file ? 'backup.json' : '';
    fileInput.dispatchEvent(new window.Event('change'));
  }
  return { one, document, blobs, revoked, downloads, timers, imports, selectFile,
    get exportCalls() { return exportCalls; }, get filePickerCalls() { return filePickerCalls; } };
}

test('imports parsed backup, reports total counts and permits selecting the same file again', async () => {
  const ui = await createControls();
  const originalStatus = ui.one('#status-pill').textContent;
  const originalQuery = ui.one('#query').value;
  ui.one('#import-user-data').click();
  assert.equal(ui.filePickerCalls, 1);
  const text = '{"format":"history-dedupe-user-data","version":1}';
  ui.selectFile(text);
  await settle();
  assert.equal(JSON.stringify(ui.imports[0]), text);
  assert.match(ui.one('#user-data-status').textContent, /现有 2 条重命名、1 个分组名称、3 条置顶/);
  assert.equal(ui.one('#user-data-status').dataset.error, 'false');
  assert.equal(ui.one('#user-data-status').hidden, false);
  assert.equal(ui.one('#user-data-file').value, '');
  assert.equal(ui.one('#import-user-data').disabled, false);
  assert.equal(ui.one('#status-pill').textContent, originalStatus);
  assert.equal(ui.one('#query').value, originalQuery);
  ui.selectFile(text);
  await settle();
  assert.equal(ui.imports.length, 2);
});

test('invalid JSON is rejected before import and errors leave controls reusable', async () => {
  const ui = await createControls();
  ui.selectFile('{invalid');
  await settle();
  assert.equal(ui.imports.length, 0);
  assert.match(ui.one('#user-data-status').textContent, /恢复失败：备份文件不是有效的 JSON/);
  assert.equal(ui.one('#user-data-status').dataset.error, 'true');
  assert.equal(ui.one('#user-data-file').value, '');
  assert.equal(ui.one('#import-user-data').disabled, false);
  ui.selectFile('{}');
  await settle();
  assert.equal(ui.imports.length, 1);
  assert.equal(ui.one('#user-data-status').dataset.error, 'false');
});

test('validation and file read failures surface without replacing search status', async () => {
  const ui = await createControls({ importBackup: async () => { throw new Error('备份数据版本不受支持'); } });
  ui.selectFile('{}');
  await settle();
  assert.match(ui.one('#user-data-status').textContent, /恢复失败：备份数据版本不受支持/);
  ui.selectFile('', { text: async () => { throw new Error('文件读取失败'); } });
  await settle();
  assert.match(ui.one('#user-data-status').textContent, /恢复失败：文件读取失败/);
  assert.equal(ui.imports.length, 1);
  assert.equal(ui.one('#user-data-controls').getAttribute('aria-busy'), 'false');
  assert.equal(ui.one('#status-pill').textContent, '待搜索');
});

test('cancelling file selection leaves status untouched', async () => {
  const ui = await createControls();
  ui.selectFile('', null);
  await settle();
  assert.equal(ui.imports.length, 0);
  assert.equal(ui.one('#user-data-status').hidden, true);
  assert.equal(ui.one('#import-user-data').disabled, false);
});

test('exports one JSON download and releases its blob after the download begins', async () => {
  const backup = { format: 'history-dedupe-user-data', version: 1, data: { title: '中文名称' } };
  const ui = await createControls({ exportBackup: async () => backup });
  ui.one('#export-user-data').click();
  await settle();
  assert.equal(ui.downloads.length, 1);
  assert.match(ui.downloads[0].filename, /^history-dedupe-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(ui.downloads[0].href, 'blob:backup-1');
  assert.deepEqual(JSON.parse(await ui.blobs[0].text()), backup);
  assert.equal(ui.blobs[0].type, 'application/json');
  assert.equal(ui.document.querySelectorAll('a[download]').length, 0);
  assert.deepEqual(ui.revoked, []);
  assert.equal(ui.timers.length, 1);
  assert.ok(ui.timers[0].delay > 0);
  ui.timers[0].callback();
  assert.deepEqual(ui.revoked, ['blob:backup-1']);
  assert.match(ui.one('#user-data-status').textContent, /已发起备份下载/);
});

test('pending work prevents repeated export and import actions', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const ui = await createControls({ exportBackup: () => pending });
  ui.one('#export-user-data').click();
  ui.one('#export-user-data').click();
  ui.one('#import-user-data').click();
  ui.selectFile('{}');
  await settle();
  assert.equal(ui.exportCalls, 1);
  assert.equal(ui.filePickerCalls, 0);
  assert.equal(ui.imports.length, 0);
  assert.equal(ui.one('#user-data-controls').getAttribute('aria-busy'), 'true');
  assert.equal(ui.one('#export-user-data').disabled, true);
  finish({ data: {} });
  await settle();
  assert.equal(ui.one('#export-user-data').disabled, false);
  assert.equal(ui.one('#user-data-controls').getAttribute('aria-busy'), 'false');
});

test('export errors are visible and allow retry', async () => {
  let fails = true;
  const ui = await createControls({ exportBackup: async () => {
    if (fails) throw new Error('存储不可用');
    return { data: {} };
  } });
  ui.one('#export-user-data').click();
  await settle();
  assert.match(ui.one('#user-data-status').textContent, /备份失败：存储不可用/);
  assert.equal(ui.one('#user-data-status').dataset.error, 'true');
  assert.equal(ui.one('#export-user-data').disabled, false);
  fails = false;
  ui.one('#export-user-data').click();
  await settle();
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.one('#user-data-status').dataset.error, 'false');
});
