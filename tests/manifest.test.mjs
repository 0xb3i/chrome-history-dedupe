import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('manifest and package expose the same user-visible version', () => {
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.version, '0.9.0');
});

test('browser action opens the popup page', () => {
  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('action command suggests Option+S on macOS and Alt+S elsewhere', () => {
  assert.deepEqual(manifest.commands._execute_action.suggested_key, {
    default: 'Alt+S',
    mac: 'Option+S'
  });
});

test('rename command opens a service-worker handled shortcut', () => {
  assert.deepEqual(manifest.background, {
    service_worker: 'src/background.js',
    type: 'module'
  });
  assert.equal(manifest.permissions.includes('storage'), true);
  assert.equal(manifest.permissions.includes('tabs'), true);
  assert.equal(manifest.permissions.includes('activeTab'), true);
  assert.equal(manifest.permissions.includes('alarms'), true);
  assert.equal(manifest.permissions.includes('scripting'), true);
  assert.deepEqual(manifest.commands['rename-current-page'].suggested_key, {
    default: 'Alt+Shift+S',
    mac: 'Option+Shift+S'
  });
});
