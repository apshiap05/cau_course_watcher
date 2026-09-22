'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sources = [
  path.join(__dirname, '..', 'userscript', 'cau-course-watcher.user.js'),
  path.join(__dirname, '..', 'chrome-extension', 'content.js'),
];

function loadTestApi(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const instrumented = source.replace(
    /\n\s*init\(\);\s*\n\}\)\(\);\s*$/,
    '\n  globalThis.__multiModeTest = { DEFAULT_CONFIG, PHASES, sanitizeConfig, activeCourseConfigs, getCourseControlState, advanceCourseIndex, isTargetUrl, state };\n})();',
  );
  assert.notEqual(instrumented, source, `无法挂载测试接口：${sourcePath}`);
  const context = vm.createContext({
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  });
  vm.runInContext(instrumented, context, { filename: sourcePath });
  return context.__multiModeTest;
}

for (const sourcePath of sources) {
  const api = loadTestApi(sourcePath);
  const legacy = api.sanitizeConfig({
    courseName: ' 羽毛球 ',
    teacher: '田野',
    minRemaining: 2,
    selectionStrategy: 'first',
    intervalMs: 5000,
  });
  assert.equal(legacy.mode, 'normal');
  assert.equal(legacy.courses.length, 1);
  assert.equal(legacy.courses[0].courseName, '羽毛球');
  assert.equal(legacy.courses[0].teacher, '田野');
  assert.equal(legacy.courses[0].minRemaining, 2);
  assert.equal(legacy.courses[0].selectionStrategy, 'first');
  assert.equal(legacy.successPolicy, 'stop-on-first', '旧配置必须迁移为任意一门成功后停止');

  const courses = Array.from({ length: 5 }, (_, index) => ({
    courseName: `课程${index + 1}`,
    minRemaining: index + 1,
    selectionStrategy: index % 2 ? 'first' : 'maxRemaining',
  }));
  const multi = api.sanitizeConfig({ ...api.DEFAULT_CONFIG, mode: 'multi', courses });
  assert.equal(multi.courses.length, 4, '课程数量必须限制为 4');
  assert.deepEqual(
    Array.from(api.activeCourseConfigs(multi), (course) => course.courseName),
    ['课程1', '课程2', '课程3', '课程4'],
  );
  const continueAll = api.sanitizeConfig({ ...multi, successPolicy: 'continue-until-all-selected' });
  assert.equal(continueAll.successPolicy, 'continue-until-all-selected');
  assert.equal(api.PHASES.VERIFYING, 'VERIFYING');

  assert.equal(api.isTargetUrl('https://newjw.cau.edu.cn/jsxsd/xsxk'), true);
  assert.equal(api.isTargetUrl('https://newjw.cau.edu.cn/jsxsd/xsxk/任意/路径?batch=changed#tab'), true);
  assert.equal(api.isTargetUrl('https://newjw.cau.edu.cn/jsxsd/xsxkabc'), false);

  api.state.config = multi;
  api.state.courseIndex = 0;
  const sequence = [];
  for (let index = 0; index < 5; index += 1) {
    sequence.push(api.state.courseIndex);
    api.advanceCourseIndex();
  }
  assert.deepEqual(sequence, [0, 1, 2, 3, 0], '轮询顺序必须循环前进');
  api.state.courseIndex = 0;
  api.state.selectedCourseIds.add(multi.courses[1].id);
  api.advanceCourseIndex();
  assert.equal(api.state.courseIndex, 2, '继续全部课程策略必须跳过已经成功的课程');
  api.state.selectedCourseIds.clear();

  const normal = api.sanitizeConfig({ ...multi, mode: 'normal' });
  assert.equal(api.activeCourseConfigs(normal).length, 1, '正常模式只能启用第一门课程');

  const normalControls = api.getCourseControlState('normal', 4, false);
  assert.equal(normalControls.visibleCourseCount, 1, '正常模式只能显示第一门课程');
  assert.equal(normalControls.addHidden, true, '正常模式必须隐藏添加课程按钮');
  assert.equal(normalControls.removeHidden, true, '正常模式必须隐藏删除课程按钮');
  assert.equal(normalControls.queryLabel, '仅查询一次');

  const oneCourseControls = api.getCourseControlState('multi', 1, false);
  assert.equal(oneCourseControls.addHidden, false, '多选模式必须显示添加课程按钮');
  assert.equal(oneCourseControls.addDisabled, false, '少于四门课程时应允许添加');
  assert.equal(oneCourseControls.removeDisabled, true, '只有一门课程时不能删除');

  const twoCourseControls = api.getCourseControlState('multi', 2, false);
  assert.equal(twoCourseControls.visibleCourseCount, 2);
  assert.equal(twoCourseControls.addDisabled, false);
  assert.equal(twoCourseControls.removeDisabled, false, '多于一门课程时应允许删除');
  assert.equal(twoCourseControls.queryLabel, '仅轮询一轮');

  const maxCourseControls = api.getCourseControlState('multi', 4, false);
  assert.equal(maxCourseControls.addDisabled, true, '达到四门课程上限时不能继续添加');
  assert.equal(maxCourseControls.removeDisabled, false);

  const busyControls = api.getCourseControlState('multi', 2, true);
  assert.equal(busyControls.tabsDisabled, true, '查询或监控时不能切换模式');
  assert.equal(busyControls.addDisabled, true, '查询或监控时不能添加课程');
  assert.equal(busyControls.removeDisabled, true, '查询或监控时不能删除课程');
  assert.match(fs.readFileSync(sourcePath, 'utf8'), /data-remove-course/);
}

process.stdout.write('multi-mode configuration and rotation tests: ok\n');
