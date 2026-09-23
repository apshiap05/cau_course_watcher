'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'chrome-extension', 'background.js');
const source = `${fs.readFileSync(sourcePath, 'utf8')}\nglobalThis.__runSelectionInPage = runSelectionInPage; globalThis.__inspectPageHealth = inspectPageHealthInMainWorld;`;

const originalAlert = () => {};
const originalConfirm = () => false;
const firstCell = { textContent: '202602071001898' };
const row = { querySelector: () => firstCell };
const link = {
  getAttribute(name) {
    if (name === 'href') return "javascript:xsxkFun('202602071001898','70133032','')";
    return '';
  },
  closest: () => row,
};
const frameWindow = {
  alert: originalAlert,
  confirm: originalConfirm,
  xsxkFun() {
    if (!this.confirm('确认选择当前课程班级？')) return;
    if (!this.confirm('该课程为专业英语课程组内课程，是否选择？')) return;
    setTimeout(() => this.alert('选课成功'), 100);
  },
};
const frameDocument = {
  documentElement: {},
  location: { pathname: '/jsxsd/xsxkkc/comeInFawxk' },
  querySelector(selector) {
    if (selector === '#kcxx' || selector === '#dataView') return {};
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes('input[type="button"]')) return [{ value: '查询' }];
    return [link];
  },
};

const context = vm.createContext({
  chrome: {
    runtime: { onMessage: { addListener() {} } },
  },
  console,
  document: {
    getElementById: () => ({ contentWindow: frameWindow, contentDocument: frameDocument }),
  },
  location: {
    origin: 'https://newjw.cau.edu.cn',
    pathname: '/jsxsd/xsxk/changed-semester-entry',
  },
  URL,
  setTimeout,
  clearTimeout,
});

vm.runInContext(source, context, { filename: sourcePath });

(async () => {
  const result = await context.__runSelectionInPage({
    jx0404id: '202602071001898',
    kcid: '70133032',
    cfbs: '',
    autoConfirmAll: true,
  });
  assert.deepEqual(Array.from(result.confirmations), [
    '确认选择当前课程班级？',
    '该课程为专业英语课程组内课程，是否选择？',
  ]);
  assert.deepEqual(Array.from(result.messages), ['选课成功']);
  assert.equal(frameWindow.alert, originalAlert);
  assert.equal(frameWindow.confirm, originalConfirm);
  const health = context.__inspectPageHealth();
  assert.equal(health.frameReady, true);
  assert.equal(health.entryReady, true);
  assert.equal(health.tableReady, true);
  assert.equal(health.nativeReady, true);
  assert.equal(health.bridgeReady, true);
  frameDocument.location.pathname = '/jsxsd/xsxkkc/comeInBxqjhxk';
  const nonFreeHealth = context.__inspectPageHealth();
  assert.equal(nonFreeHealth.entryReady, false, '非自由选课路由不得被识别为可查询入口');
  process.stdout.write('background selection smoke test: ok\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
