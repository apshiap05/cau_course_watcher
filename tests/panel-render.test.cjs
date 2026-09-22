'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const mode = process.argv[2];
assert.ok(mode === 'normal' || mode === 'multi', '用法：node tests/panel-render.test.cjs normal|multi');

const html = fs.readFileSync(0, 'utf8');
assert.match(html, /data-cau-panel-ready="true"/, '浏览器中未完成面板初始化');
assert.match(html, new RegExp(`data-cau-active-mode="${mode}"`), '激活模式与配置不一致');
assert.match(html, /data-cau-health-item-count="5"/, '页面健康状态必须包含五项检查');
assert.match(html, /data-cau-start-modal-hidden="true"/, '启动确认框默认必须隐藏');
assert.match(html, /data-cau-continue-policy="true"/, '继续抢课策略必须正确回填');

if (mode === 'normal') {
  assert.match(html, /data-cau-add-visible="false"/, '正常模式不应显示添加课程按钮');
  assert.match(html, /data-cau-visible-course-count="1"/, '正常模式只能显示一门课程');
  assert.match(html, /data-cau-visible-remove-count="0"/, '正常模式不应显示删除课程按钮');
  assert.match(html, /data-cau-continue-policy-visible="false"/, '正常模式不应显示多选成功策略');
} else {
  assert.match(html, /data-cau-add-visible="true"/, '多选模式应显示添加课程按钮');
  assert.match(html, /data-cau-visible-course-count="2"/, '多选模式应显示全部已配置课程');
  assert.match(html, /data-cau-visible-remove-count="2"/, '多选模式应显示每门课程的删除按钮');
  assert.match(html, /data-cau-course-status-count="2"/, '多选模式每门课程必须有独立状态');
  assert.match(html, /data-cau-continue-policy-visible="true"/, '多选模式应显示成功后继续策略');
}

process.stdout.write(`browser panel rendering (${mode}): ok\n`);
