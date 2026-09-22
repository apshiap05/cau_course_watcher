'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sources = [
  ['Chrome 扩展', path.join(root, 'chrome-extension', 'content.js')],
  ['Tampermonkey 脚本', path.join(root, 'userscript', 'cau-course-watcher.user.js')],
];

for (const [name, file] of sources) {
  const source = fs.readFileSync(file, 'utf8');
  for (const phase of ['CHECKING_CONFIG', 'WAITING_PAGE', 'QUERYING', 'WAITING_NEXT', 'CANDIDATE_FOUND', 'SUBMITTING', 'WAITING_DIALOGS', 'VERIFYING', 'SUCCESS', 'SLOT_LOST', 'UNCERTAIN']) {
    assert.match(source, new RegExp(`${phase}: '${phase}'`), `${name} 缺少阶段 ${phase}`);
  }
  assert.match(source, /addEventListener\('pointerleave',[\s\S]*?flushAutoSave\(true\)/, `${name} 必须在鼠标离开时自动保存`);
  assert.match(source, /toast\('配置已自动保存', false, 3000\)/, `${name} 自动保存提示必须显示 3 秒`);
  assert.match(source, /id="cau-cw-confirm-summary"/, `${name} 必须提供启动前配置摘要`);
  assert.match(source, /await confirmStart\(config, health\)/, `${name} 必须等待用户确认后启动`);
  assert.match(source, /data-health="page"[\s\S]*data-health="bridge"/, `${name} 必须显示五项健康状态`);
  assert.match(source, /页面结构未识别，已停止自动操作。请检查脚本版本或确认选课页面正确。/, `${name} 缺少结构异常保护提示`);
  assert.match(source, /data-course-status/, `${name} 必须提供每门课程独立状态`);
  assert.match(source, /continue-until-all-selected/, `${name} 必须实现全部课程成功策略`);
  assert.match(source, /field\('cau-cw-continue-row'\)\.hidden = !controls\.isMulti/, `${name} 正常模式必须隐藏多选成功策略`);
  assert.match(source, /结果不确定[\s\S]*return 'retry'/, `${name} 不确定结果必须提醒后继续`);
  assert.match(source, /state\.selectedCourseIds\.has/, `${name} 必须跳过已经成功的课程`);
  if (name === 'Tampermonkey 脚本') {
    assert.match(source, /addEventListener\(requestEvent, async \(\) =>/, '油猴弹窗桥接必须覆盖异步回调');
    assert.match(source, /Date\.now\(\) - startedAt < 15000[\s\S]*Date\.now\(\) - lastDialogAt < 2500/, '油猴弹窗桥接必须等待弹窗安静后再恢复');
  }
}

process.stdout.write('v1.4.0 feature contract tests: ok\n');
