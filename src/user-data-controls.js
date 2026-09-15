import { exportUserDataBackup, importUserDataBackup } from './user-data-backup.js';

export function initializeUserDataControls(document) {
  const controls = document.querySelector('#user-data-controls');
  if (!controls) return;

  const exportButton = controls.querySelector('#export-user-data');
  const importButton = controls.querySelector('#import-user-data');
  const fileInput = controls.querySelector('#user-data-file');
  const status = document.querySelector('#user-data-status');
  let busy = false;

  function setBusy(value) {
    busy = value;
    controls.setAttribute('aria-busy', String(value));
    exportButton.disabled = value;
    importButton.disabled = value;
    fileInput.disabled = value;
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
    status.hidden = false;
  }

  exportButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    showStatus('正在生成备份…');
    try {
      const backup = await exportUserDataBackup();
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const date = new Date();
      const dateLabel = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((value) => String(value).padStart(2, '0')).join('-');
      link.href = url;
      link.download = `history-dedupe-backup-${dateLabel}.json`;
      link.hidden = true;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        // Keep the blob alive until the browser has started the download.
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      showStatus('已发起备份下载，包含重命名、分组名称和置顶。');
    } catch (error) {
      showStatus(`备份失败：${error.message || '请重试。'}`, true);
    } finally {
      setBusy(false);
    }
  });

  importButton.addEventListener('click', () => {
    if (!busy) fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || busy) return;
    setBusy(true);
    showStatus('正在恢复备份…');
    try {
      const text = await file.text();
      let backup;
      try {
        backup = JSON.parse(text);
      } catch {
        throw new Error('备份文件不是有效的 JSON。');
      }
      const counts = await importUserDataBackup(backup);
      showStatus(`恢复完成：现有 ${counts.titles} 条重命名、${counts.groups} 个分组名称、${counts.pins} 条置顶。已有名称已保留。`);
    } catch (error) {
      showStatus(`恢复失败：${error.message || '请检查备份文件后重试。'}`, true);
    } finally {
      fileInput.value = '';
      setBusy(false);
    }
  });
}
