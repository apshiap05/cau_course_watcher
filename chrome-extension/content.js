(function () {
  'use strict';

  const SCRIPT_ID = 'cau-course-watcher';
  const STORAGE_KEY = `${SCRIPT_ID}:chrome-config:v1`;
  const PAGE = window;
  const MAX_COURSES = 4;
  const TARGET_ORIGIN = 'https://newjw.cau.edu.cn';
  const TARGET_PATH_PREFIX = '/jsxsd/xsxk';

  const PHASES = Object.freeze({
    STOPPED: 'STOPPED',
    CHECKING_CONFIG: 'CHECKING_CONFIG',
    WAITING_PAGE: 'WAITING_PAGE',
    QUERYING: 'QUERYING',
    WAITING_NEXT: 'WAITING_NEXT',
    CANDIDATE_FOUND: 'CANDIDATE_FOUND',
    SUBMITTING: 'SUBMITTING',
    WAITING_DIALOGS: 'WAITING_DIALOGS',
    VERIFYING: 'VERIFYING',
    SUCCESS: 'SUCCESS',
    SLOT_LOST: 'SLOT_LOST',
    UNCERTAIN: 'UNCERTAIN',
    ERROR_PAUSED: 'ERROR_PAUSED',
  });

  const PHASE_LABELS = Object.freeze({
    [PHASES.STOPPED]: '已停止',
    [PHASES.CHECKING_CONFIG]: '配置检查中',
    [PHASES.WAITING_PAGE]: '等待页面就绪',
    [PHASES.QUERYING]: '查询中',
    [PHASES.WAITING_NEXT]: '等待下一轮',
    [PHASES.CANDIDATE_FOUND]: '发现候选课程',
    [PHASES.SUBMITTING]: '提交选课',
    [PHASES.WAITING_DIALOGS]: '等待弹窗结束',
    [PHASES.VERIFYING]: '验证选课结果',
    [PHASES.SUCCESS]: '选课成功',
    [PHASES.SLOT_LOST]: '余量被抢走',
    [PHASES.UNCERTAIN]: '结果不确定',
    [PHASES.ERROR_PAUSED]: '异常暂停',
  });

  const DEFAULT_COURSE = Object.freeze({
    id: 'course-1',
    courseName: '',
    matchMode: 'exact',
    courseCode: '',
    teacher: '',
    classNumber: '',
    campus: '',
    timeKeyword: '',
    minRemaining: 1,
    selectionStrategy: 'maxRemaining',
  });

  const DEFAULT_CONFIG = Object.freeze({
    mode: 'normal',
    courses: Object.freeze([DEFAULT_COURSE]),
    intervalMs: 5000,
    jitterMs: 900,
    maxAttempts: 0,
    showFullCourses: true,
    autoConfirmAllPrompts: true,
    desktopNotification: true,
    sound: true,
    successPolicy: 'stop-on-first',
  });

  const state = {
    running: false,
    inFlight: false,
    attempts: 0,
    timer: null,
    countdownTimer: null,
    nextRunAt: 0,
    consecutiveErrors: 0,
    transientFailures: 0,
    courseIndex: 0,
    stopRequested: false,
    config: sanitizeConfig(DEFAULT_CONFIG),
    audioContext: null,
    lastRows: [],
    phase: PHASES.STOPPED,
    courseRuntime: new Map(),
    selectedCourseIds: new Set(),
    configDirty: false,
    autoSaveTimer: null,
    writingConfig: false,
    health: null,
    confirming: false,
  };

  let ui = null;

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const saved = stored[STORAGE_KEY];
      if (!saved) return sanitizeConfig(DEFAULT_CONFIG);
      const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
      const merged = { ...DEFAULT_CONFIG, ...parsed };
      merged.courses = Array.isArray(parsed.courses) ? parsed.courses : [parsed];
      if (
        !Object.prototype.hasOwnProperty.call(parsed, 'autoConfirmAllPrompts') &&
        Object.prototype.hasOwnProperty.call(parsed, 'autoConfirmFirstPrompt')
      ) {
        merged.autoConfirmAllPrompts = Boolean(parsed.autoConfirmFirstPrompt);
      }
      return sanitizeConfig(merged);
    } catch (error) {
      console.warn('[CAU Course Watcher] 无法读取配置，将使用默认值。', error);
      return sanitizeConfig(DEFAULT_CONFIG);
    }
  }

  async function saveConfig(config) {
    const clean = sanitizeConfig(config);
    state.config = clean;
    await chrome.storage.local.set({ [STORAGE_KEY]: clean });
    return clean;
  }

  function sanitizeConfig(input) {
    const number = (value, fallback, min, max) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, parsed));
    };
    const sanitizeCourse = (course = {}, index = 0) => ({
      id: /^[A-Za-z0-9_-]{1,80}$/.test(String(course.id || '')) ? String(course.id) : `course-${index + 1}`,
      courseName: String(course.courseName || '').trim(),
      matchMode: course.matchMode === 'contains' ? 'contains' : 'exact',
      courseCode: String(course.courseCode || '').trim(),
      teacher: String(course.teacher || '').trim(),
      classNumber: String(course.classNumber || '').trim(),
      campus: String(course.campus || '').trim(),
      timeKeyword: String(course.timeKeyword || '').trim(),
      minRemaining: number(course.minRemaining, DEFAULT_COURSE.minRemaining, 1, 9999),
      selectionStrategy: course.selectionStrategy === 'first' ? 'first' : 'maxRemaining',
    });
    const rawCourses = Array.isArray(input.courses) ? input.courses : [input];
    const courses = rawCourses.slice(0, MAX_COURSES).map(sanitizeCourse);
    if (!courses.length) courses.push(sanitizeCourse(DEFAULT_COURSE));
    return {
      mode: input.mode === 'multi' ? 'multi' : 'normal',
      courses,
      intervalMs: number(input.intervalMs, DEFAULT_CONFIG.intervalMs, 3000, 120000),
      jitterMs: number(input.jitterMs, DEFAULT_CONFIG.jitterMs, 0, 10000),
      maxAttempts: number(input.maxAttempts, DEFAULT_CONFIG.maxAttempts, 0, 1000000),
      showFullCourses: Boolean(input.showFullCourses),
      autoConfirmAllPrompts: Boolean(input.autoConfirmAllPrompts),
      desktopNotification: Boolean(input.desktopNotification),
      sound: Boolean(input.sound),
      successPolicy: input.successPolicy === 'continue-until-all-selected'
        ? 'continue-until-all-selected'
        : 'stop-on-first',
    };
  }

  function activeCourseConfigs(config) {
    const courses = config.mode === 'multi' ? config.courses : config.courses.slice(0, 1);
    return courses.map((course, targetIndex) => ({ ...config, ...course, targetIndex }));
  }

  function isTargetUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.origin === TARGET_ORIGIN &&
        (url.pathname === TARGET_PATH_PREFIX || url.pathname.startsWith(`${TARGET_PATH_PREFIX}/`));
    } catch (_) {
      return false;
    }
  }

  function getCourseControlState(mode, courseCount, busy) {
    const isMulti = mode === 'multi';
    const count = Math.max(1, Math.min(MAX_COURSES, Number(courseCount) || 1));
    const isBusy = Boolean(busy);
    return {
      isMulti,
      visibleCourseCount: isMulti ? count : 1,
      tabsDisabled: isBusy,
      addHidden: !isMulti,
      addDisabled: isBusy || count >= MAX_COURSES,
      removeHidden: !isMulti,
      removeDisabled: isBusy || count <= 1,
      queryLabel: isMulti ? '仅轮询一轮' : '仅查询一次',
    };
  }

  function targetLabel(config) {
    const total = activeCourseConfigs(state.config).length;
    return total > 1 ? `课程 ${config.targetIndex + 1}/${total}“${config.courseName}”` : `“${config.courseName}”`;
  }

  function normalize(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compact(value) {
    return normalize(value).replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function ensureCourseRuntime(course) {
    if (!state.courseRuntime.has(course.id)) {
      state.courseRuntime.set(course.id, { text: '未查询', tone: 'gray', attempts: 0, matches: 0 });
    }
    return state.courseRuntime.get(course.id);
  }

  function setCourseStatus(course, text, tone = 'gray', details = {}) {
    if (!course?.id) return;
    const current = ensureCourseRuntime(course);
    const next = { ...current, ...details, text, tone };
    state.courseRuntime.set(course.id, next);
    if (!ui) return;
    const block = ui.courseList.querySelector(`[data-course-id="${course.id}"]`);
    if (!block) return;
    block.dataset.tone = tone;
    const badge = block.querySelector('[data-course-status]');
    if (badge) {
      badge.className = `cau-cw-course-state ${tone}`;
      badge.textContent = text;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitUntil(predicate, timeoutMs, stepMs = 120) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const result = predicate();
        if (result) return result;
      } catch (error) {
        lastError = error;
      }
      await sleep(stepMs);
    }
    if (lastError) throw lastError;
    throw new Error(`等待页面响应超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-style`;
    style.textContent = `
      #${SCRIPT_ID}-panel, #${SCRIPT_ID}-panel * { box-sizing: border-box; }
      #${SCRIPT_ID}-panel [hidden] { display: none !important; }
      #${SCRIPT_ID}-panel {
        position: fixed; top: 18px; right: 18px; z-index: 2147483646;
        width: 440px; max-height: calc(100vh - 36px); overflow: auto;
        color: #203129; background: #f8fbf9; border: 1px solid #9bc8aa;
        border-radius: 12px; box-shadow: 0 14px 40px rgba(13, 63, 34, .24);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${SCRIPT_ID}-panel.cau-cw-collapsed .cau-cw-body { display: none; }
      #${SCRIPT_ID}-panel .cau-cw-header {
        position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
        gap: 8px; padding: 11px 13px; color: white; background: #25824b;
        border-radius: 11px 11px 0 0;
      }
      #${SCRIPT_ID}-panel .cau-cw-title { flex: 1; font-size: 15px; font-weight: 700; }
      #${SCRIPT_ID}-panel .cau-cw-icon-btn {
        width: 28px; height: 26px; padding: 0; color: white; background: rgba(255,255,255,.14);
        border: 1px solid rgba(255,255,255,.32); border-radius: 6px; cursor: pointer;
      }
      #${SCRIPT_ID}-panel .cau-cw-body { padding: 12px; }
      #${SCRIPT_ID}-panel .cau-cw-tabs {
        display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 10px;
        padding: 4px; background: #e4eee7; border-radius: 9px;
      }
      #${SCRIPT_ID}-panel .cau-cw-mode-tab {
        min-height: 34px; border: 0; border-radius: 7px; color: #45604d;
        background: transparent; font-weight: 700; cursor: pointer;
      }
      #${SCRIPT_ID}-panel .cau-cw-mode-tab.active { color: white; background: #25824b; }
      #${SCRIPT_ID}-panel .cau-cw-mode-tab:disabled { opacity: .58; cursor: not-allowed; }
      #${SCRIPT_ID}-panel .cau-cw-status {
        display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px;
        padding: 9px; background: #edf6f0; border-radius: 8px;
      }
      #${SCRIPT_ID}-panel .cau-cw-status b { color: #126936; }
      #${SCRIPT_ID}-panel .cau-cw-section {
        margin: 9px 0; padding: 10px; background: white; border: 1px solid #d9e8de; border-radius: 8px;
      }
      #${SCRIPT_ID}-panel .cau-cw-section-title { margin-bottom: 7px; font-weight: 700; color: #176f3b; }
      #${SCRIPT_ID}-panel .cau-cw-section-heading {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        margin-bottom: 8px; padding: 1px 1px 8px; border-bottom: 1px solid #e3eee6;
      }
      #${SCRIPT_ID}-panel .cau-cw-section-heading .cau-cw-section-title { margin: 0; }
      #${SCRIPT_ID}-panel .cau-cw-add-btn {
        display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 5px;
        min-width: 96px; height: 30px; padding: 0 13px 0 10px; border: 1px solid #8ebfa0;
        border-radius: 999px; color: #176f3b; background: #edf6f0;
        font: 650 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        cursor: pointer; transition: color .16s ease, background .16s ease, border-color .16s ease, box-shadow .16s ease, transform .16s ease;
      }
      #${SCRIPT_ID}-panel .cau-cw-add-btn .cau-cw-add-symbol {
        font-size: 18px; font-weight: 500; line-height: 1; transform: translateY(-1px);
      }
      #${SCRIPT_ID}-panel .cau-cw-add-btn:hover:not(:disabled) {
        color: white; background: #25824b; border-color: #25824b; box-shadow: 0 3px 9px rgba(37,130,75,.2);
        transform: translateY(-1px);
      }
      #${SCRIPT_ID}-panel .cau-cw-add-btn:focus-visible {
        outline: 0; box-shadow: 0 0 0 3px rgba(45,140,82,.2);
      }
      #${SCRIPT_ID}-panel .cau-cw-add-btn:disabled { opacity: .45; cursor: not-allowed; }
      #${SCRIPT_ID}-panel .cau-cw-course-block {
        margin-top: 8px; padding: 9px; background: #f7faf8; border: 1px solid #d4e4d9; border-radius: 8px;
      }
      #${SCRIPT_ID}-panel .cau-cw-course-block:first-child { margin-top: 0; }
      #${SCRIPT_ID}-panel .cau-cw-course-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
      #${SCRIPT_ID}-panel .cau-cw-course-head b { color: #315e40; }
      #${SCRIPT_ID}-panel .cau-cw-small-btn {
        min-width: 30px; height: 28px; padding: 0 8px; border: 1px solid #9bc8aa;
        border-radius: 6px; color: #176f3b; background: #edf6f0; font-size: 18px; line-height: 1; cursor: pointer;
      }
      #${SCRIPT_ID}-panel .cau-cw-small-btn.cau-cw-remove { color: #a3322a; border-color: #e1b6b1; background: #fff1ef; }
      #${SCRIPT_ID}-panel .cau-cw-small-btn:disabled { opacity: .45; cursor: not-allowed; }
      #${SCRIPT_ID}-panel .cau-cw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      #${SCRIPT_ID}-panel label { display: block; color: #41574a; }
      #${SCRIPT_ID}-panel label > span { display: block; margin-bottom: 3px; }
      #${SCRIPT_ID}-panel input[type="text"],
      #${SCRIPT_ID}-panel input[type="number"],
      #${SCRIPT_ID}-panel select {
        width: 100%; height: 32px; padding: 4px 7px; color: #203129; background: white;
        border: 1px solid #b9cfc0; border-radius: 6px; outline: none;
      }
      #${SCRIPT_ID}-panel input:focus, #${SCRIPT_ID}-panel select:focus {
        border-color: #2d8c52; box-shadow: 0 0 0 2px rgba(45,140,82,.13);
      }
      #${SCRIPT_ID}-panel .cau-cw-check { display: flex; align-items: flex-start; gap: 7px; margin: 7px 0; }
      #${SCRIPT_ID}-panel .cau-cw-check input { margin-top: 3px; }
      #${SCRIPT_ID}-panel .cau-cw-arm {
        padding: 8px; background: #fff8e4; border: 1px solid #ecd78f; border-radius: 7px;
      }
      #${SCRIPT_ID}-panel .cau-cw-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 7px; }
      #${SCRIPT_ID}-panel .cau-cw-btn {
        min-height: 34px; padding: 6px 9px; border: 0; border-radius: 7px; cursor: pointer;
        color: white; background: #287e4a; font-weight: 650;
      }
      #${SCRIPT_ID}-panel .cau-cw-btn:hover { filter: brightness(1.07); }
      #${SCRIPT_ID}-panel .cau-cw-btn:disabled { opacity: .48; cursor: not-allowed; }
      #${SCRIPT_ID}-panel .cau-cw-btn-secondary { color: #245538; background: #e4f1e8; }
      #${SCRIPT_ID}-panel .cau-cw-btn-danger { background: #b64b42; }
      #${SCRIPT_ID}-panel .cau-cw-hint { margin: 7px 0 0; color: #687970; font-size: 12px; }
      #${SCRIPT_ID}-panel .cau-cw-log {
        height: 132px; margin: 0; padding: 7px 7px 7px 24px; overflow: auto;
        color: #30483a; background: #f4f8f5; border: 1px solid #d6e5da; border-radius: 7px;
      }
      #${SCRIPT_ID}-panel .cau-cw-log li { margin: 2px 0; word-break: break-word; }
      #${SCRIPT_ID}-panel .cau-cw-log .error { color: #ad2e24; }
      #${SCRIPT_ID}-panel .cau-cw-log .success { color: #087333; font-weight: 700; }
      #${SCRIPT_ID}-panel .cau-cw-running { color: #fff3ad; }
      #${SCRIPT_ID}-panel .cau-cw-paused { color: #e3f3e8; }
      #${SCRIPT_ID}-toast {
        position: fixed; left: 50%; top: 22px; z-index: 2147483647; transform: translateX(-50%);
        max-width: min(720px, 86vw); padding: 11px 16px; color: white; background: #246d43;
        border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.22); font: 14px/1.45 "Microsoft YaHei", sans-serif;
      }
      #${SCRIPT_ID}-panel {
        width: 468px; border: 0; border-radius: 16px;
        background: linear-gradient(180deg, #f6faf7 0, #fbfdfb 100%);
        box-shadow: 0 20px 55px rgba(12, 61, 32, .22), 0 2px 10px rgba(12, 61, 32, .12);
      }
      #${SCRIPT_ID}-panel .cau-cw-header {
        padding: 14px 16px; background: linear-gradient(135deg, #1f7443, #348a55);
        border-radius: 16px 16px 0 0;
      }
      #${SCRIPT_ID}-panel .cau-cw-title small { display: inline-block; margin-left: 4px; }
      #${SCRIPT_ID}-panel .cau-cw-body { padding: 14px; }
      #${SCRIPT_ID}-panel .cau-cw-section { border-radius: 12px; box-shadow: 0 2px 8px rgba(31,116,67,.04); }
      #${SCRIPT_ID}-panel .cau-cw-health {
        margin-bottom: 10px; padding: 10px 11px; border: 1px solid #d6e6db; border-radius: 11px;
        background: rgba(255,255,255,.82);
      }
      #${SCRIPT_ID}-panel .cau-cw-health-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      #${SCRIPT_ID}-panel .cau-cw-health-head strong { color: #1c653a; }
      #${SCRIPT_ID}-panel .cau-cw-health-summary { color: #78867d; font-size: 12px; }
      #${SCRIPT_ID}-panel .cau-cw-health-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      #${SCRIPT_ID}-panel .cau-cw-health-item {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 6px 8px; border-radius: 8px; color: #4c6053; background: #f2f7f3;
      }
      #${SCRIPT_ID}-panel .cau-cw-health-item::before { content: ''; width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #a7b1aa; }
      #${SCRIPT_ID}-panel .cau-cw-health-item.ok::before { background: #2b9a57; box-shadow: 0 0 0 3px rgba(43,154,87,.12); }
      #${SCRIPT_ID}-panel .cau-cw-health-item.warn::before { background: #dfa326; box-shadow: 0 0 0 3px rgba(223,163,38,.12); }
      #${SCRIPT_ID}-panel .cau-cw-health-item.bad::before { background: #d34e45; box-shadow: 0 0 0 3px rgba(211,78,69,.12); }
      #${SCRIPT_ID}-panel .cau-cw-health-item span { flex: 1; }
      #${SCRIPT_ID}-panel .cau-cw-health-item b { font-size: 12px; }
      #${SCRIPT_ID}-panel .cau-cw-status { border: 1px solid #d9e8de; background: linear-gradient(135deg, #edf7f0, #f5faf6); }
      #${SCRIPT_ID}-panel .cau-cw-course-block { position: relative; padding: 11px; border-radius: 11px; transition: border-color .18s, box-shadow .18s; }
      #${SCRIPT_ID}-panel .cau-cw-course-block[data-tone="yellow"] { border-color: #e7c76c; box-shadow: 0 0 0 2px rgba(231,199,108,.12); }
      #${SCRIPT_ID}-panel .cau-cw-course-block[data-tone="red"] { border-color: #df8c84; box-shadow: 0 0 0 2px rgba(223,140,132,.12); }
      #${SCRIPT_ID}-panel .cau-cw-course-block[data-tone="green"] { border-color: #75bd8c; box-shadow: 0 0 0 2px rgba(117,189,140,.13); }
      #${SCRIPT_ID}-panel .cau-cw-course-title { display: flex; min-width: 0; align-items: center; gap: 8px; }
      #${SCRIPT_ID}-panel .cau-cw-course-title b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${SCRIPT_ID}-panel .cau-cw-course-state {
        max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        padding: 3px 8px; border-radius: 999px; color: #69776d; background: #e8eeea; font-size: 11px; font-weight: 700;
      }
      #${SCRIPT_ID}-panel .cau-cw-course-state.yellow { color: #7a5707; background: #fff2c8; }
      #${SCRIPT_ID}-panel .cau-cw-course-state.red { color: #9d3028; background: #fde6e3; }
      #${SCRIPT_ID}-panel .cau-cw-course-state.green { color: #176a37; background: #dff3e6; }
      #${SCRIPT_ID}-panel .cau-cw-save-note { display: inline-flex; align-items: center; gap: 5px; color: #6b7c70; font-size: 11px; }
      #${SCRIPT_ID}-panel .cau-cw-save-note::before { content: '✓'; color: #27824b; font-weight: 900; }
      #${SCRIPT_ID}-panel .cau-cw-btn { border-radius: 9px; transition: transform .15s, filter .15s, box-shadow .15s; }
      #${SCRIPT_ID}-panel .cau-cw-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 10px rgba(31,116,67,.14); }
      #${SCRIPT_ID}-panel .cau-cw-log li { padding: 2px 0; border-bottom: 1px dashed rgba(73,105,83,.12); }
      #${SCRIPT_ID}-panel .cau-cw-log .phase { color: #176f3b; font-weight: 700; }
      #${SCRIPT_ID}-modal {
        position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
        padding: 22px; background: rgba(11,31,19,.46); backdrop-filter: blur(3px);
      }
      #${SCRIPT_ID}-modal[hidden] { display: none !important; }
      #${SCRIPT_ID}-modal .cau-cw-dialog {
        width: min(560px, 94vw); max-height: 86vh; overflow: auto; padding: 20px;
        color: #203129; background: #fff; border: 1px solid #cfe1d5; border-radius: 16px;
        box-shadow: 0 22px 70px rgba(5,32,15,.3); font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #${SCRIPT_ID}-modal h2 { margin: 0 0 5px; color: #195f36; font-size: 19px; }
      #${SCRIPT_ID}-modal p { margin: 4px 0 12px; color: #6b786f; }
      #${SCRIPT_ID}-modal .cau-cw-confirm-summary { margin: 12px 0; padding: 12px; border-radius: 10px; background: #f1f7f3; }
      #${SCRIPT_ID}-modal .cau-cw-confirm-summary div { margin: 4px 0; }
      #${SCRIPT_ID}-modal .cau-cw-confirm-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 15px; }
      #${SCRIPT_ID}-modal button { min-width: 100px; min-height: 38px; border: 0; border-radius: 9px; color: #244d32; background: #e5efe8; font-weight: 700; cursor: pointer; }
      #${SCRIPT_ID}-modal button[data-confirm] { color: white; background: #267b49; }
      @media (max-width: 720px) {
        #${SCRIPT_ID}-panel { inset: 8px 8px auto auto; width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createPanel() {
    if (document.getElementById(`${SCRIPT_ID}-panel`)) return;
    injectStyle();
    const panel = document.createElement('aside');
    panel.id = `${SCRIPT_ID}-panel`;
    panel.innerHTML = `
      <div class="cau-cw-header">
        <div class="cau-cw-title">选课余量监控助手 <small>Chrome v1.4.1</small></div>
        <span id="cau-cw-run-state" class="cau-cw-paused">已停止</span>
        <button id="cau-cw-collapse" class="cau-cw-icon-btn" title="收起/展开">—</button>
      </div>
      <div class="cau-cw-body">
        <div class="cau-cw-tabs" role="tablist" aria-label="监控模式">
          <button class="cau-cw-mode-tab" type="button" role="tab" data-mode="normal">正常模式</button>
          <button class="cau-cw-mode-tab" type="button" role="tab" data-mode="multi">多选模式</button>
        </div>
        <div class="cau-cw-health" aria-label="页面健康状态">
          <div class="cau-cw-health-head"><strong>页面健康状态</strong><span id="cau-cw-health-summary" class="cau-cw-health-summary">正在检测…</span></div>
          <div class="cau-cw-health-grid">
            <div class="cau-cw-health-item" data-health="page"><span>页面状态</span><b>检测中</b></div>
            <div class="cau-cw-health-item" data-health="entry"><span>选课入口</span><b>检测中</b></div>
            <div class="cau-cw-health-item" data-health="table"><span>课程表</span><b>检测中</b></div>
            <div class="cau-cw-health-item" data-health="native"><span>原生选课函数</span><b>检测中</b></div>
            <div class="cau-cw-health-item" data-health="bridge"><span>弹窗桥接</span><b>检测中</b></div>
          </div>
        </div>
        <div class="cau-cw-status">
          <div>页面：<b id="cau-cw-page-state">检测中</b></div>
          <div>查询：<b id="cau-cw-attempts">0 次</b></div>
          <div>结果：<b id="cau-cw-result">尚未查询</b></div>
          <div>下次：<b id="cau-cw-next">—</b></div>
        </div>

        <div class="cau-cw-section">
          <div class="cau-cw-section-heading">
            <div class="cau-cw-section-title">待选课程</div>
            <button id="cau-cw-add-course" class="cau-cw-add-btn" type="button" title="增加待选课程" aria-label="增加待选课程">
              <span class="cau-cw-add-symbol" aria-hidden="true">＋</span><span>添加课程</span>
            </button>
          </div>
          <div id="cau-cw-course-list"></div>
          <p id="cau-cw-target-hint" class="cau-cw-hint"></p>
        </div>

        <div class="cau-cw-section">
          <div class="cau-cw-section-title">刷新与选择</div>
          <div class="cau-cw-grid">
            <label><span>刷新间隔（秒）</span><input id="cau-cw-interval" type="number" min="3" max="120" step="0.5"></label>
            <label><span>随机抖动（毫秒）</span><input id="cau-cw-jitter" type="number" min="0" max="10000" step="100"></label>
            <label style="grid-column: 1 / -1"><span>最多查询次数（全部课程合计）</span><input id="cau-cw-max-attempts" type="number" min="0" max="1000000" step="1" title="0 表示不限"></label>
          </div>
          <p class="cau-cw-hint">多选模式的全部课程共用这里的刷新间隔；相邻两次查询之间都会等待该间隔并附加随机抖动。</p>
          <label class="cau-cw-check"><input id="cau-cw-show-full" type="checkbox"><span>查询时显示已满课程，便于观察余量变化</span></label>
          <label class="cau-cw-check"><input id="cau-cw-auto-confirm" type="checkbox"><span>自动点击本次选课流程中的所有“确定”弹窗（包括班级确认和课程组确认）</span></label>
          <label class="cau-cw-check"><input id="cau-cw-notify" type="checkbox"><span>成功、验证码或异常时发送桌面通知</span></label>
          <label class="cau-cw-check"><input id="cau-cw-sound" type="checkbox"><span>重要事件播放提示音</span></label>
          <label id="cau-cw-continue-row" class="cau-cw-check"><input id="cau-cw-continue-all" type="checkbox"><span>一门成功后继续监控，直到全部待选课程都选中</span></label>
          <label class="cau-cw-check cau-cw-arm"><input id="cau-cw-arm" type="checkbox"><span><b>本次授权：</b>我确认上述条件无误，并授权发现余量后自动提交一次选课、按上述设置处理该次选课弹窗。此项不会保存，刷新页面后需重新勾选。</span></label>
        </div>

        <div class="cau-cw-actions">
          <button id="cau-cw-save" class="cau-cw-btn cau-cw-btn-secondary">立即保存</button>
          <button id="cau-cw-query" class="cau-cw-btn cau-cw-btn-secondary">仅查询一次</button>
          <button id="cau-cw-start" class="cau-cw-btn">开始监控</button>
          <button id="cau-cw-pause" class="cau-cw-btn cau-cw-btn-danger" disabled>立即停止</button>
          <button id="cau-cw-enter" class="cau-cw-btn cau-cw-btn-secondary">进入自由选课</button>
          <button id="cau-cw-clear-log" class="cau-cw-btn cau-cw-btn-secondary">清空日志</button>
        </div>
        <p class="cau-cw-save-note">修改配置后，鼠标离开面板会自动保存</p>
        <p class="cau-cw-hint">紧急停止：按 Esc。验证码、会话失效、不确定的选课结果或非余量类失败都会自动暂停。</p>

        <div class="cau-cw-section">
          <div class="cau-cw-section-title">运行日志</div>
          <ol id="cau-cw-log" class="cau-cw-log"></ol>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const modal = document.createElement('div');
    modal.id = `${SCRIPT_ID}-modal`;
    modal.hidden = true;
    modal.innerHTML = `
      <div class="cau-cw-dialog" role="dialog" aria-modal="true" aria-labelledby="cau-cw-confirm-title">
        <h2 id="cau-cw-confirm-title">确认开始监控</h2>
        <p>请最后核对课程条件。点击“确认并开始”后，发现余量将按授权自动提交。</p>
        <div id="cau-cw-confirm-summary" class="cau-cw-confirm-summary"></div>
        <div class="cau-cw-confirm-actions">
          <button type="button" data-cancel>返回修改</button>
          <button type="button" data-confirm>确认并开始</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    ui = {
      panel,
      runState: panel.querySelector('#cau-cw-run-state'),
      pageState: panel.querySelector('#cau-cw-page-state'),
      attempts: panel.querySelector('#cau-cw-attempts'),
      result: panel.querySelector('#cau-cw-result'),
      next: panel.querySelector('#cau-cw-next'),
      log: panel.querySelector('#cau-cw-log'),
      start: panel.querySelector('#cau-cw-start'),
      pause: panel.querySelector('#cau-cw-pause'),
      arm: panel.querySelector('#cau-cw-arm'),
      courseList: panel.querySelector('#cau-cw-course-list'),
      addCourse: panel.querySelector('#cau-cw-add-course'),
      modeTabs: [...panel.querySelectorAll('.cau-cw-mode-tab')],
      targetHint: panel.querySelector('#cau-cw-target-hint'),
      modal,
      confirmSummary: modal.querySelector('#cau-cw-confirm-summary'),
      healthSummary: panel.querySelector('#cau-cw-health-summary'),
      healthItems: Object.fromEntries([...panel.querySelectorAll('[data-health]')].map((item) => [item.dataset.health, item])),
    };

    writeConfigToPanel(state.config);
    bindPanelEvents();
    updatePageStatus();
    log('助手已就绪。请先填写目标并使用“仅查询一次”核对结果。');
  }

  function field(id) {
    return document.getElementById(id);
  }

  function courseBlockTemplate(index, course) {
    const runtime = state.courseRuntime.get(course.id) || { text: '未查询', tone: 'gray', attempts: 0, matches: 0 };
    const label = course.courseName ? `待选课程 ${index + 1}（${escapeHtml(course.courseName)}）` : `待选课程 ${index + 1}`;
    return `
      <div class="cau-cw-course-block" data-course-index="${index}" data-course-id="${course.id}" data-tone="${runtime.tone}">
        <div class="cau-cw-course-head">
          <div class="cau-cw-course-title"><b>${label}</b><span class="cau-cw-course-state ${runtime.tone}" data-course-status>${escapeHtml(runtime.text)}</span></div>
          <button class="cau-cw-small-btn cau-cw-remove" type="button" data-remove-course="${index}" title="删除这门课程">−</button>
        </div>
        <div class="cau-cw-grid">
          <label style="grid-column: 1 / -1"><span>课程名称（必填）</span><input data-course-field="courseName" type="text" placeholder="例如：羽毛球"></label>
          <label><span>名称匹配</span><select data-course-field="matchMode"><option value="exact">智能精确（推荐）</option><option value="contains">包含关键词</option></select></label>
          <label><span>课程编号（可选）</span><input data-course-field="courseCode" type="text" placeholder="例如：70013084"></label>
          <label><span>教师（可选）</span><input data-course-field="teacher" type="text" placeholder="包含匹配"></label>
          <label><span>课序号（可选）</span><input data-course-field="classNumber" type="text" placeholder="例如：507"></label>
          <label><span>校区（可选）</span><input data-course-field="campus" type="text" placeholder="例如：烟台研究院"></label>
          <label><span>时间关键词（可选）</span><input data-course-field="timeKeyword" type="text" placeholder="例如：星期六 1-2节"></label>
          <label><span>最低余量</span><input data-course-field="minRemaining" type="number" min="1" max="9999" step="1"></label>
          <label><span>多班选择策略</span><select data-course-field="selectionStrategy"><option value="maxRemaining">剩余容量最多</option><option value="first">页面中的第一班</option></select></label>
        </div>
      </div>
    `;
  }

  function renderCourseBlocks(courses) {
    const cleanCourses = sanitizeConfig({ ...state.config, courses }).courses;
    cleanCourses.forEach((course) => ensureCourseRuntime(course));
    ui.courseList.innerHTML = cleanCourses.map((course, index) => courseBlockTemplate(index, course)).join('');
    [...ui.courseList.querySelectorAll('.cau-cw-course-block')].forEach((block, index) => {
      const course = cleanCourses[index];
      Object.entries(course).forEach(([key, value]) => {
        const input = block.querySelector(`[data-course-field="${key}"]`);
        if (input) input.value = String(value);
      });
    });
    updateCourseControls();
  }

  function readCourseBlocks() {
    return [...ui.courseList.querySelectorAll('.cau-cw-course-block')].map((block) => ({
      id: block.dataset.courseId,
      courseName: block.querySelector('[data-course-field="courseName"]').value,
      matchMode: block.querySelector('[data-course-field="matchMode"]').value,
      courseCode: block.querySelector('[data-course-field="courseCode"]').value,
      teacher: block.querySelector('[data-course-field="teacher"]').value,
      classNumber: block.querySelector('[data-course-field="classNumber"]').value,
      campus: block.querySelector('[data-course-field="campus"]').value,
      timeKeyword: block.querySelector('[data-course-field="timeKeyword"]').value,
      minRemaining: block.querySelector('[data-course-field="minRemaining"]').value,
      selectionStrategy: block.querySelector('[data-course-field="selectionStrategy"]').value,
    }));
  }

  function updateCourseControls() {
    if (!ui) return;
    const mode = ui.panel.dataset.mode === 'multi' ? 'multi' : 'normal';
    const blocks = [...ui.courseList.querySelectorAll('.cau-cw-course-block')];
    const controls = getCourseControlState(mode, blocks.length, state.running || state.inFlight || state.confirming);
    ui.modeTabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.disabled = controls.tabsDisabled;
    });
    ui.addCourse.hidden = controls.addHidden;
    ui.addCourse.disabled = controls.addDisabled;
    const addCourseDescription = blocks.length >= MAX_COURSES ? `最多可配置 ${MAX_COURSES} 门课程` : '增加待选课程';
    ui.addCourse.title = addCourseDescription;
    ui.addCourse.setAttribute('aria-label', addCourseDescription);
    blocks.forEach((block, index) => {
      block.hidden = index >= controls.visibleCourseCount;
      const remove = block.querySelector('[data-remove-course]');
      remove.hidden = controls.removeHidden;
      remove.disabled = controls.removeDisabled;
    });
    ui.targetHint.textContent = controls.isMulti
      ? '可配置 1–4 门课程并按顺序交替查询；每门课程都可独立设置最低余量和多班策略。'
      : '同名课程有多个班时，建议至少填写教师、课序号或时间；否则默认选择余量最多的班。';
    field('cau-cw-query').textContent = controls.queryLabel;
    field('cau-cw-continue-row').hidden = !controls.isMulti;
  }

  function writeConfigToPanel(config) {
    state.writingConfig = true;
    ui.panel.dataset.mode = config.mode;
    renderCourseBlocks(config.courses);
    field('cau-cw-interval').value = String(config.intervalMs / 1000);
    field('cau-cw-jitter').value = String(config.jitterMs);
    field('cau-cw-max-attempts').value = String(config.maxAttempts);
    field('cau-cw-show-full').checked = config.showFullCourses;
    field('cau-cw-auto-confirm').checked = config.autoConfirmAllPrompts;
    field('cau-cw-notify').checked = config.desktopNotification;
    field('cau-cw-sound').checked = config.sound;
    field('cau-cw-continue-all').checked = config.successPolicy === 'continue-until-all-selected';
    state.writingConfig = false;
  }

  function readConfigFromPanel() {
    return sanitizeConfig({
      mode: ui.panel.dataset.mode,
      courses: readCourseBlocks(),
      intervalMs: Number(field('cau-cw-interval').value) * 1000,
      jitterMs: field('cau-cw-jitter').value,
      maxAttempts: field('cau-cw-max-attempts').value,
      showFullCourses: field('cau-cw-show-full').checked,
      autoConfirmAllPrompts: field('cau-cw-auto-confirm').checked,
      desktopNotification: field('cau-cw-notify').checked,
      sound: field('cau-cw-sound').checked,
      successPolicy: field('cau-cw-continue-all').checked ? 'continue-until-all-selected' : 'stop-on-first',
    });
  }

  function markConfigDirty() {
    if (state.writingConfig || state.running || state.inFlight) return;
    state.configDirty = true;
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(() => flushAutoSave(true), 1800);
  }

  async function flushAutoSave(showNotice = true) {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
    if (!state.configDirty || state.running || state.inFlight || !ui) return state.config;
    try {
      const clean = await saveConfig(readConfigFromPanel());
      state.configDirty = false;
      if (showNotice) toast('配置已自动保存', false, 3000);
      return clean;
    } catch (error) {
      state.configDirty = true;
      handleFatal(error, '自动保存配置失败', false);
      return state.config;
    }
  }

  function configurationSummary(config, health) {
    const courses = activeCourseConfigs(config);
    const courseLines = courses.map((course, index) => {
      const filters = [
        course.teacher && `教师：${course.teacher}`,
        course.classNumber && `课序号：${course.classNumber}`,
        course.courseCode && `课程编号：${course.courseCode}`,
        course.campus && `校区：${course.campus}`,
        course.timeKeyword && `时间：${course.timeKeyword}`,
      ].filter(Boolean).join('；');
      return `<div><strong>${index + 1}. ${escapeHtml(course.courseName)}</strong> · 最低余量 ${course.minRemaining}${filters ? `<br><small>${escapeHtml(filters)}</small>` : ''}</div>`;
    }).join('');
    const policy = config.mode === 'multi' && config.successPolicy === 'continue-until-all-selected'
      ? '全部课程选中后停止'
      : '任意一门成功后停止';
    const healthText = health?.healthy ? '页面健康检查通过' : '页面健康状态异常';
    return `
      <div><strong>模式：</strong>${config.mode === 'multi' ? `多选模式（${courses.length} 门）` : '正常模式'}</div>
      ${courseLines}
      <div><strong>刷新：</strong>${formatSeconds(config.intervalMs)} + 0–${config.jitterMs} ms 随机抖动</div>
      <div><strong>成功策略：</strong>${policy}</div>
      <div><strong>弹窗：</strong>${config.autoConfirmAllPrompts ? '自动确认本次选课流程中的全部确认框' : '手动处理确认框'}</div>
      <div><strong>页面：</strong>${healthText}</div>`;
  }

  function confirmStart(config, health) {
    ui.confirmSummary.innerHTML = configurationSummary(config, health);
    ui.modal.hidden = false;
    const confirmButton = ui.modal.querySelector('[data-confirm]');
    confirmButton.focus();
    return new Promise((resolve) => {
      const finish = (answer) => {
        ui.modal.hidden = true;
        ui.modal.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey, true);
        resolve(answer);
      };
      const onClick = (event) => {
        if (event.target.closest('[data-confirm]')) finish(true);
        else if (event.target.closest('[data-cancel]') || event.target === ui.modal) finish(false);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') finish(false);
      };
      ui.modal.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey, true);
    });
  }

  function bindPanelEvents() {
    field('cau-cw-collapse').addEventListener('click', () => {
      ui.panel.classList.toggle('cau-cw-collapsed');
      field('cau-cw-collapse').textContent = ui.panel.classList.contains('cau-cw-collapsed') ? '+' : '—';
    });

    ui.modeTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        if (state.running || state.inFlight) return;
        const config = readConfigFromPanel();
        config.mode = tab.dataset.mode === 'multi' ? 'multi' : 'normal';
        state.config = sanitizeConfig(config);
        writeConfigToPanel(state.config);
        markConfigDirty();
        log(`已切换到${state.config.mode === 'multi' ? '多选模式' : '正常模式'}。`);
      });
    });

    ui.addCourse.addEventListener('click', () => {
      if (state.running || state.inFlight) return;
      const courses = readCourseBlocks();
      if (courses.length >= MAX_COURSES) {
        toast(`最多只能监控 ${MAX_COURSES} 门课程`, true);
        return;
      }
      courses.push({ ...DEFAULT_COURSE, id: `course-${Date.now().toString(36)}` });
      renderCourseBlocks(courses);
      markConfigDirty();
      log(`已增加待选课程块，当前共 ${courses.length} 门。`);
    });

    ui.courseList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-course]');
      if (!button || state.running || state.inFlight) return;
      const courses = readCourseBlocks();
      if (courses.length <= 1) return;
      const index = Number(button.dataset.removeCourse);
      if (!Number.isInteger(index) || index < 0 || index >= courses.length) return;
      const [removed] = courses.splice(index, 1);
      renderCourseBlocks(courses);
      markConfigDirty();
      log(`已删除${removed.courseName ? `“${removed.courseName}”` : `待选课程 ${index + 1}`}，当前共 ${courses.length} 门。`);
    });

    field('cau-cw-save').addEventListener('click', async () => {
      try {
        const config = await saveConfig(readConfigFromPanel());
        state.configDirty = false;
        writeConfigToPanel(config);
        log('配置已保存到 Chrome 扩展存储（不包含账号和密码）。', 'success');
        toast('配置已保存');
      } catch (error) {
        handleFatal(error, '保存配置失败', false);
      }
    });

    ui.panel.addEventListener('input', (event) => {
      if (event.target === ui.arm) return;
      markConfigDirty();
      if (event.target.matches('[data-course-field="courseName"]')) {
        const block = event.target.closest('.cau-cw-course-block');
        const title = block?.querySelector('.cau-cw-course-title b');
        const index = Number(block?.dataset.courseIndex || 0) + 1;
        if (title) title.textContent = event.target.value.trim()
          ? `待选课程 ${index}（${event.target.value.trim()}）`
          : `待选课程 ${index}`;
      }
    });
    ui.panel.addEventListener('change', (event) => {
      if (event.target !== ui.arm) markConfigDirty();
    });
    ui.panel.addEventListener('pointerleave', () => {
      if (state.configDirty) flushAutoSave(true);
    });

    field('cau-cw-start').addEventListener('click', startMonitoring);
    field('cau-cw-pause').addEventListener('click', () => pauseMonitoring('用户手动停止。'));
    field('cau-cw-enter').addEventListener('click', async () => {
      try {
        await enterFreeCoursePage();
        log('已进入自由选课页面。', 'success');
      } catch (error) {
        handleFatal(error, '无法进入自由选课页面');
      }
    });
    field('cau-cw-query').addEventListener('click', queryOnceManually);
    field('cau-cw-clear-log').addEventListener('click', () => {
      ui.log.replaceChildren();
      log('日志已清空。');
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && (state.running || state.inFlight)) pauseMonitoring('已通过 Esc 紧急停止。');
    }, true);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.running) {
        log('页面进入后台；浏览器可能降低定时器频率，建议保持此标签页可见。');
      }
    });
  }

  function validateConfig(config, requireAuthorization) {
    const courses = activeCourseConfigs(config);
    courses.forEach((course, index) => {
      if (!course.courseName) throw new Error(`必须填写第 ${index + 1} 门课程的课程名称。`);
    });
    if (config.intervalMs < 3000) throw new Error('刷新间隔不能低于 3 秒。');
    if (requireAuthorization && !ui.arm.checked) {
      throw new Error('开始自动监控前，请勾选“本次授权”。');
    }
  }

  function setPhase(phase, detail = '', options = {}) {
    const previous = state.phase;
    state.phase = phase;
    if (ui) {
      ui.runState.textContent = PHASE_LABELS[phase] || phase;
      ui.runState.className = phase === PHASES.ERROR_PAUSED ? 'cau-cw-running' :
        phase === PHASES.STOPPED ? 'cau-cw-paused' : 'cau-cw-running';
    }
    if (options.silent || (!detail && previous === phase)) return;
    const message = detail ? `${PHASE_LABELS[phase] || phase}：${detail}` : PHASE_LABELS[phase] || phase;
    log(message, options.level || (phase === PHASES.ERROR_PAUSED ? 'error' : phase === PHASES.SUCCESS ? 'success' : 'phase'), {
      phase,
      course: options.course,
    });
  }

  async function queryOnceManually() {
    if (state.running || state.inFlight) {
      toast('当前正在运行，请先停止');
      return;
    }
    try {
      setPhase(PHASES.CHECKING_CONFIG);
      const config = await saveConfig(readConfigFromPanel());
      state.configDirty = false;
      writeConfigToPanel(config);
      validateConfig(config, false);
      const courses = activeCourseConfigs(config);
      state.stopRequested = false;
      state.inFlight = true;
      ensureAudioContext();
      setPhase(PHASES.WAITING_PAGE);
      let doc;
      try { doc = await enterFreeCoursePage(); } catch (error) {
        stopForPageMismatch({ message: friendlyError(error) });
        return;
      }
      const health = await checkPageHealth();
      if (!health.healthy) {
        stopForPageMismatch(health);
        return;
      }
      updateButtons();
      for (let index = 0; index < courses.length; index += 1) {
        if (index > 0 && !(await waitForSharedInterval(config))) break;
        if (state.stopRequested) break;
        const courseConfig = courses[index];
        state.attempts += 1;
        const runtime = ensureCourseRuntime(courseConfig);
        setCourseStatus(courseConfig, `第 ${runtime.attempts + 1} 次查询中`, 'yellow', { attempts: runtime.attempts + 1 });
        setPhase(PHASES.QUERYING, targetLabel(courseConfig), { course: courseConfig });
        ui.attempts.textContent = `${state.attempts} 次`;
        ui.next.textContent = '查询中';
        ui.result.textContent = `正在查询 ${targetLabel(courseConfig)}`;
        const rows = await performQuery(doc, courseConfig);
        state.lastRows = rows;
        renderQuerySummary(rows, courseConfig);
        const matches = matchingRows(rows, courseConfig);
        const available = chooseEligibleRows(rows, courseConfig);
        setCourseStatus(
          courseConfig,
          !matches.length ? '无匹配' : `第 ${runtime.attempts + 1} 次查询 · 找到 ${matches.length} 个班${available.length ? ` · ${available.length} 班有余量` : ''}`,
          !matches.length ? 'gray' : available.length ? 'green' : 'yellow',
          { matches: matches.length },
        );
      }
      if (!state.stopRequested && courses.length > 1) log(`已完成 ${courses.length} 门课程的单轮查询。`, 'success');
    } catch (error) {
      handleFatal(error, '单次查询失败', false);
    } finally {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      state.nextRunAt = 0;
      state.inFlight = false;
      state.stopRequested = false;
      if (state.phase !== PHASES.ERROR_PAUSED) setPhase(PHASES.STOPPED, '', { silent: true });
      ui.next.textContent = '—';
      updateButtons();
    }
  }

  async function waitForSharedInterval(config) {
    const jitter = Math.floor(Math.random() * (config.jitterMs + 1));
    state.nextRunAt = Date.now() + config.intervalMs + jitter;
    setPhase(PHASES.WAITING_NEXT, `下一次查询约 ${formatSeconds(config.intervalMs + jitter)} 后开始`);
    updateCountdown();
    clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(updateCountdown, 250);
    while (Date.now() < state.nextRunAt) {
      if (state.stopRequested) return false;
      await sleep(Math.min(150, Math.max(20, state.nextRunAt - Date.now())));
    }
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    state.nextRunAt = 0;
    return !state.stopRequested;
  }

  async function startMonitoring() {
    if (state.running || state.inFlight || state.confirming) return;
    state.confirming = true;
    updateButtons();
    try {
      setPhase(PHASES.CHECKING_CONFIG);
      const config = await saveConfig(readConfigFromPanel());
      state.configDirty = false;
      writeConfigToPanel(config);
      validateConfig(config, true);
      ensureAudioContext();
      setPhase(PHASES.WAITING_PAGE);
      try { await enterFreeCoursePage(); } catch (error) {
        stopForPageMismatch({ message: friendlyError(error) });
        return;
      }
      const health = await checkPageHealth();
      if (!health.healthy) {
        stopForPageMismatch(health);
        return;
      }
      const confirmed = await confirmStart(config, health);
      if (!confirmed) {
        setPhase(PHASES.STOPPED, '用户返回修改配置。');
        return;
      }
      state.running = true;
      state.attempts = 0;
      state.consecutiveErrors = 0;
      state.transientFailures = 0;
      state.courseIndex = 0;
      state.stopRequested = false;
      state.selectedCourseIds.clear();
      activeCourseConfigs(config).forEach((course) => setCourseStatus(course, '等待查询', 'yellow', { attempts: 0, matches: 0 }));
      ui.result.textContent = '等待首次查询';
      const courses = activeCourseConfigs(config);
      log(`开始${config.mode === 'multi' ? `轮询 ${courses.length} 门课程：${courses.map((course) => `“${course.courseName}”`).join('、')}` : `监控“${courses[0].courseName}”`}，共享基础间隔 ${formatSeconds(config.intervalMs)}。`, 'success');
      updateButtons();
      scheduleNext(0);
    } catch (error) {
      toast(error.message, true);
      log(error.message, 'error');
      setPhase(PHASES.ERROR_PAUSED, friendlyError(error), { level: 'error' });
    } finally {
      state.confirming = false;
      updateButtons();
    }
  }

  function pauseMonitoring(reason, options = {}) {
    const wasActive = state.running || state.inFlight;
    state.stopRequested = true;
    clearTimeout(state.timer);
    clearInterval(state.countdownTimer);
    state.timer = null;
    state.countdownTimer = null;
    state.running = false;
    state.nextRunAt = 0;
    if (ui) {
      if (wasActive) {
        activeCourseConfigs(state.config).forEach((course) => {
          if (state.selectedCourseIds.has(course.id)) return;
          setCourseStatus(course, options.success ? '因其他课程成功而停止' : '已暂停', options.success ? 'gray' : 'red');
        });
      }
      ui.next.textContent = '—';
      setPhase(options.phase || (options.success ? PHASES.SUCCESS : options.error ? PHASES.ERROR_PAUSED : PHASES.STOPPED), reason, {
        level: options.success ? 'success' : options.error ? 'error' : '',
      });
      updateButtons();
    }
  }

  function updateButtons() {
    if (!ui) return;
    ui.start.disabled = state.running || state.inFlight || state.confirming;
    ui.pause.disabled = (!state.running && !state.inFlight) || state.stopRequested;
    field('cau-cw-query').disabled = state.running || state.inFlight || state.confirming;
    updateCourseControls();
  }

  function scheduleNext(delayOverride = null) {
    if (!state.running) return;
    clearTimeout(state.timer);
    clearInterval(state.countdownTimer);
    const jitter = Math.floor(Math.random() * (state.config.jitterMs + 1));
    const errorBackoff = Math.min(60000, state.consecutiveErrors * state.consecutiveErrors * 1500);
    const transientBackoff = Math.min(15000, state.transientFailures * 2500);
    const delay = delayOverride ?? (state.config.intervalMs + jitter + errorBackoff + transientBackoff);
    setPhase(PHASES.WAITING_NEXT, delay === 0 ? '准备首次查询' : `下一轮将在 ${formatSeconds(delay)} 后开始`);
    state.nextRunAt = Date.now() + delay;
    updateCountdown();
    state.countdownTimer = setInterval(updateCountdown, 250);
    state.timer = setTimeout(() => {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      tick();
    }, delay);
  }

  function updateCountdown() {
    if ((!state.running && !state.inFlight) || !state.nextRunAt) {
      if (ui) ui.next.textContent = '—';
      return;
    }
    const seconds = Math.max(0, (state.nextRunAt - Date.now()) / 1000);
    ui.next.textContent = `${seconds.toFixed(1)} 秒`;
  }

  async function tick() {
    if (!state.running || state.inFlight || state.stopRequested) return;
    if (state.config.maxAttempts > 0 && state.attempts >= state.config.maxAttempts) {
      pauseMonitoring(`已达到最多查询次数（${state.config.maxAttempts}），监控停止。`);
      return;
    }

    state.inFlight = true;
    state.attempts += 1;
    ui.attempts.textContent = `${state.attempts} 次`;
    ui.next.textContent = '查询中';
    updateButtons();

    const courses = activeCourseConfigs(state.config);
    if (state.courseIndex >= courses.length) state.courseIndex = 0;
    const courseConfig = courses[state.courseIndex];

    try {
      const runtime = ensureCourseRuntime(courseConfig);
      setCourseStatus(courseConfig, `第 ${runtime.attempts + 1} 次查询中`, 'yellow', { attempts: runtime.attempts + 1 });
      setPhase(PHASES.WAITING_PAGE, targetLabel(courseConfig), { course: courseConfig });
      const doc = await enterFreeCoursePage();
      const health = await checkPageHealth();
      if (!health.healthy) {
        stopForPageMismatch(health);
        return;
      }
      setPhase(PHASES.QUERYING, targetLabel(courseConfig), { course: courseConfig });
      ui.result.textContent = `正在查询 ${targetLabel(courseConfig)}`;
      const rows = await performQuery(doc, courseConfig);
      state.lastRows = rows;
      state.consecutiveErrors = 0;
      renderQuerySummary(rows, courseConfig);
      if (!state.running || state.stopRequested) return;

      const eligible = chooseEligibleRows(rows, courseConfig);
      if (!eligible.length) {
        const matches = matchingRows(rows, courseConfig);
        setCourseStatus(
          courseConfig,
          matches.length ? `第 ${runtime.attempts + 1} 次查询 · ${matches.length} 班暂无余量` : '无匹配',
          matches.length ? 'yellow' : 'gray',
          { matches: matches.length },
        );
        state.transientFailures = 0;
        advanceCourseIndex();
        scheduleNext();
        return;
      }

      const target = eligible[0];
      setCourseStatus(courseConfig, `找到 ${eligible.length} 个可选班级`, 'green', { matches: eligible.length });
      setPhase(PHASES.CANDIDATE_FOUND, describeRow(target), { course: courseConfig });
      const descriptor = describeRow(target);
      if (eligible.length > 1) {
        log(`${targetLabel(courseConfig)}：发现 ${eligible.length} 个有余量的匹配班级，将按“${strategyLabel(courseConfig.selectionStrategy)}”选择：${descriptor}`);
      } else {
        log(`${targetLabel(courseConfig)}：发现余量，准备选择：${descriptor}`, 'success');
      }

      if (isAlreadySelected(target)) {
        const stopped = finishSuccess(`检测到目标班级已经在选课结果中：${descriptor}`, courseConfig);
        if (!stopped) {
          advanceCourseIndex();
          scheduleNext();
        }
        return;
      }

      const result = await selectCourse(target);
      if (result === 'retry' || result === 'continue') {
        state.transientFailures = result === 'retry' ? state.transientFailures + 1 : 0;
        advanceCourseIndex();
        scheduleNext();
      }
    } catch (error) {
      state.consecutiveErrors += 1;
      setCourseStatus(courseConfig, `异常：${friendlyError(error)}`, 'red');
      log(`第 ${state.attempts} 次查询异常：${friendlyError(error)}`, 'error');
      if (isStructureError(error)) {
        stopForPageMismatch({ message: friendlyError(error) });
      } else if (isSessionError(error)) {
        handleFatal(error, '登录会话可能已失效');
      } else if (state.consecutiveErrors >= 5) {
        handleFatal(error, '连续 5 次查询异常，已为保护账号而暂停');
      } else {
        ui.result.textContent = `异常 ${state.consecutiveErrors} 次`;
        advanceCourseIndex();
        scheduleNext();
      }
    } finally {
      state.inFlight = false;
      updateButtons();
    }
  }

  function advanceCourseIndex() {
    const courses = activeCourseConfigs(state.config);
    const count = courses.length;
    if (!count) {
      state.courseIndex = 0;
      return;
    }
    for (let offset = 1; offset <= count; offset += 1) {
      const candidate = (state.courseIndex + offset) % count;
      if (!state.selectedCourseIds.has(courses[candidate].id)) {
        state.courseIndex = candidate;
        return;
      }
    }
    state.courseIndex = 0;
  }

  function getMainFrame() {
    return PAGE.document.getElementById('mainFrame');
  }

  function getFrameDocument() {
    const frame = getMainFrame();
    if (!frame) throw new Error('找不到选课内容框架 mainFrame。');
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (!doc) throw new Error('选课框架尚未加载。');
      return doc;
    } catch (error) {
      throw new Error('无法读取选课内容，可能已跳转到登录页或页面结构发生变化。', { cause: error });
    }
  }

  function pageLooksLoggedOut(doc) {
    let path = '';
    try { path = doc.location.pathname; } catch (_) { return true; }
    return Boolean(
      doc.querySelector('#userAccount, input[name="userAccount"]') ||
      /\/login/i.test(path) ||
      /欢迎登录|请先登录系统/.test(normalize(doc.body?.innerText).slice(0, 600))
    );
  }

  function isFreeCoursePage(doc) {
    let path = '';
    try { path = String(doc?.location?.pathname || '').replace(/\/+$/, ''); } catch (_) { return false; }
    return /\/jsxsd\/xsxkkc\/comeInFawxk$/i.test(path) &&
      Boolean(doc?.querySelector?.('#kcxx') && findQueryButton(doc));
  }

  function findFreeCourseLink(frameDoc) {
    const documents = [PAGE.document, frameDoc].filter(Boolean);
    const candidates = documents.flatMap((doc) => [...doc.querySelectorAll('a[href], a[onclick], button[onclick]')]);
    return candidates.find((link) => {
      if (link.disabled || link.getAttribute('aria-disabled') === 'true' || !isElementVisible(link)) return false;
      const source = `${link.getAttribute('href') || ''} ${link.getAttribute('onclick') || ''}`;
      const label = normalize(link.textContent || link.value || '');
      return /comeInFawxk/i.test(source) || label === '自由选课' || label.includes('自由选课');
    }) || null;
  }

  function activateFreeCourseLink(link) {
    if (typeof link?.click === 'function') {
      link.click();
      return;
    }
    const ownerWindow = link?.ownerDocument?.defaultView || PAGE;
    link?.dispatchEvent?.(new ownerWindow.MouseEvent('click', { bubbles: true, cancelable: true, view: ownerWindow }));
  }

  async function enterFreeCoursePage() {
    let doc = getFrameDocument();
    if (pageLooksLoggedOut(doc)) throw new Error('登录会话已失效，请重新登录后再开始。');
    if (isFreeCoursePage(doc)) {
      updatePageStatus('自由选课', true);
      return doc;
    }

    const link = findFreeCourseLink(doc);
    if (!link) throw new Error('找不到顶部“自由选课”入口。');
    updatePageStatus('正在切换', false);
    activateFreeCourseLink(link);
    doc = await waitUntil(() => {
      const candidate = getFrameDocument();
      if (pageLooksLoggedOut(candidate)) throw new Error('切换页面时登录会话失效。');
      return isFreeCoursePage(candidate) ? candidate : null;
    }, 12000, 150);
    updatePageStatus('自由选课', true);
    return doc;
  }

  function updatePageStatus(label = null, ok = null) {
    if (!ui) return;
    if (label) {
      ui.pageState.textContent = label;
      ui.pageState.style.color = ok ? '#087333' : '#8a6410';
      return;
    }
    try {
      const doc = getFrameDocument();
      if (pageLooksLoggedOut(doc)) return updatePageStatus('需要登录', false);
      if (isFreeCoursePage(doc)) return updatePageStatus('自由选课', true);
      updatePageStatus('其他选课页', false);
    } catch (_) {
      updatePageStatus('未就绪', false);
    }
  }

  function renderHealth(health) {
    if (!ui || !health) return;
    const items = {
      page: [health.pageRecognized, health.pageRecognized ? '已识别' : '未识别'],
      entry: [health.entryReady, health.entryReady ? '正常' : '未就绪'],
      table: [health.tableReady, health.tableReady ? '已加载' : '未加载'],
      native: [health.nativeReady, health.nativeReady ? '可用' : '不可用'],
      bridge: [health.bridgeReady, health.bridgeReady ? '可用' : '不可用'],
    };
    Object.entries(items).forEach(([key, [ok, label]]) => {
      const element = ui.healthItems[key];
      if (!element) return;
      element.className = `cau-cw-health-item ${ok ? 'ok' : health.pageRecognized ? 'warn' : 'bad'}`;
      element.querySelector('b').textContent = label;
    });
    ui.healthSummary.textContent = health.healthy ? '全部正常' : health.message;
    ui.healthSummary.style.color = health.healthy ? '#237b48' : '#a06d09';
    state.health = health;
  }

  async function checkPageHealth() {
    const base = {
      pageRecognized: isTargetUrl(location.href),
      entryReady: false,
      tableReady: false,
      nativeReady: false,
      bridgeReady: false,
    };
    if (!base.pageRecognized) {
      const health = { ...base, healthy: false, message: '页面结构未识别' };
      renderHealth(health);
      return health;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CAU_HEALTH_CHECK' });
      if (!response?.ok || !response.result) throw new Error(response?.error || '后台未返回检查结果');
      const result = response.result;
      const health = {
        ...base,
        pageRecognized: Boolean(result.frameReady),
        entryReady: Boolean(result.entryReady),
        tableReady: Boolean(result.tableReady),
        nativeReady: Boolean(result.nativeReady),
        bridgeReady: Boolean(result.bridgeReady),
      };
      health.healthy = health.pageRecognized && health.entryReady && health.tableReady && health.nativeReady && health.bridgeReady;
      health.message = health.healthy ? '全部正常' : '部分组件未就绪';
      renderHealth(health);
      return health;
    } catch (error) {
      const health = { ...base, pageRecognized: true, healthy: false, message: `检查失败：${friendlyError(error)}` };
      renderHealth(health);
      return health;
    }
  }

  function stopForPageMismatch(health) {
    const detail = health?.message ? `（${health.message}）` : '';
    const message = `页面结构未识别，已停止自动操作。请检查脚本版本或确认选课页面正确。${detail}`;
    pauseMonitoring(message, { error: true, phase: PHASES.ERROR_PAUSED });
    toast(message, true, 5200);
    return message;
  }

  function setInputValue(element, value) {
    element.value = value;
    const EventConstructor = element.ownerDocument.defaultView.Event;
    element.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    element.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  }

  function findQueryButton(doc) {
    return [...doc.querySelectorAll('input[type="button"], button')]
      .find((element) => normalize(element.value || element.textContent) === '查询');
  }

  function isElementVisible(element) {
    if (!element) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  async function performQuery(doc, config) {
    if (pageLooksLoggedOut(doc)) throw new Error('登录会话已失效，请重新登录。');
    const input = doc.querySelector('#kcxx');
    const button = findQueryButton(doc);
    if (!input || !button) throw new Error('找不到课程输入框或查询按钮，页面结构可能已变化。');

    setInputValue(input, config.courseName);
    const hideFullCheckbox = doc.querySelector('#sfym');
    if (config.showFullCourses && hideFullCheckbox?.checked) {
      hideFullCheckbox.checked = false;
      const EventConstructor = hideFullCheckbox.ownerDocument.defaultView.Event;
      hideFullCheckbox.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    }

    const queryStartedAt = performance.now();
    button.click();
    await sleep(280);
    await waitUntil(() => {
      if (pageLooksLoggedOut(doc)) throw new Error('查询过程中登录会话失效。');
      const table = doc.querySelector('#dataView');
      if (!table) return false;
      const processing = doc.querySelector('#dataView_processing');
      if (isElementVisible(processing)) return false;
      const info = doc.querySelector('#dataView_info');
      const bodyRows = table.querySelectorAll('tbody tr');
      return Boolean(info && bodyRows.length > 0 && performance.now() - queryStartedAt >= 350);
    }, 15000, 120);

    const rows = parseCourseRows(doc);
    log(`第 ${state.attempts || 1} 次查询完成：${targetLabel(config)}，返回 ${rows.length} 个班级。`);
    return rows;
  }

  function parseCourseRows(doc) {
    const table = doc.querySelector('#dataView');
    if (!table) throw new Error('查询结束后未找到课程表。');
    const headers = [...table.querySelectorAll('thead th')].map((cell) => normalize(cell.textContent));
    const indexOf = (name) => headers.findIndex((header) => header.includes(name));
    const indexes = {
      noticeId: indexOf('通知单号'),
      courseCode: indexOf('课程编号'),
      courseName: indexOf('课程名'),
      classNumber: indexOf('课序号'),
      teacher: indexOf('上课教师'),
      time: indexOf('上课时间'),
      campus: indexOf('上课校区'),
      remaining: indexOf('剩余容量'),
      operation: indexOf('操作'),
    };
    const required = ['noticeId', 'courseCode', 'courseName', 'remaining', 'operation'];
    if (required.some((key) => indexes[key] < 0)) {
      throw new Error(`课程表列与预期不符：${headers.join('、')}`);
    }

    return [...table.querySelectorAll('tbody tr')].flatMap((row, order) => {
      const cells = [...row.cells];
      if (!cells.length || row.querySelector('.dataTables_empty')) return [];
      const textAt = (key) => indexes[key] >= 0 ? normalize(cells[indexes[key]]?.innerText) : '';
      const remainingText = textAt('remaining');
      const match = remainingText.match(/-?\d+/);
      const remaining = match ? Number(match[0]) : Number.NaN;
      const operationCell = cells[indexes.operation];
      const selectLink = operationCell?.querySelector('a[href*="xsxkFun"], a[onclick*="xsxkFun"]') || null;
      return [{
        row,
        order,
        noticeId: textAt('noticeId'),
        courseCode: textAt('courseCode'),
        courseName: textAt('courseName'),
        classNumber: textAt('classNumber'),
        teacher: textAt('teacher'),
        time: textAt('time'),
        campus: textAt('campus'),
        remaining,
        remainingText,
        selectLink,
      }];
    });
  }

  function rowMatches(row, config) {
    const expectedName = compact(config.courseName);
    const actualName = compact(row.courseName);
    const numericSuffix = /[（(][0-9一二三四五六七八九十]+[)）]$/u;
    const nameMatches = config.matchMode === 'contains'
      ? actualName.includes(expectedName)
      : actualName === expectedName ||
        (!numericSuffix.test(expectedName) && actualName.replace(numericSuffix, '') === expectedName);
    if (!nameMatches) return false;
    if (config.courseCode && compact(row.courseCode) !== compact(config.courseCode)) return false;
    if (config.teacher && !compact(row.teacher).includes(compact(config.teacher))) return false;
    if (config.classNumber && compact(row.classNumber) !== compact(config.classNumber)) return false;
    if (config.campus && !compact(row.campus).includes(compact(config.campus))) return false;
    if (config.timeKeyword && !compact(row.time).includes(compact(config.timeKeyword))) return false;
    return true;
  }

  function matchingRows(rows, config) {
    return rows.filter((row) => rowMatches(row, config));
  }

  function chooseEligibleRows(rows, config) {
    const eligible = matchingRows(rows, config)
      .filter((row) => Number.isFinite(row.remaining) && row.remaining >= config.minRemaining && row.selectLink);
    if (config.selectionStrategy === 'maxRemaining') {
      eligible.sort((a, b) => (b.remaining - a.remaining) || (a.order - b.order));
    } else {
      eligible.sort((a, b) => a.order - b.order);
    }
    return eligible;
  }

  function renderQuerySummary(rows, config) {
    const matches = matchingRows(rows, config);
    const prefix = activeCourseConfigs(state.config).length > 1 ? `第 ${config.targetIndex + 1} 门：` : '';
    if (!matches.length) {
      ui.result.textContent = `${prefix}没有匹配课程`;
      log(`${targetLabel(config)}：本次没有找到符合全部条件的课程。`);
      return;
    }
    const available = matches.filter((row) => Number.isFinite(row.remaining) && row.remaining >= config.minRemaining && row.selectLink);
    if (available.length) {
      const max = Math.max(...available.map((row) => row.remaining));
      ui.result.textContent = `${prefix}${available.length} 班有余量（最多 ${max}）`;
    } else {
      const capacities = matches.map((row) => row.remainingText || '?').join(', ');
      ui.result.textContent = `${prefix}${matches.length} 班匹配，余量 ${capacities}`;
    }
  }

  function strategyLabel(strategy) {
    return strategy === 'first' ? '页面中的第一班' : '剩余容量最多';
  }

  function describeRow(row) {
    const parts = [row.courseName];
    if (row.classNumber) parts.push(`课序号 ${row.classNumber}`);
    if (row.teacher) parts.push(row.teacher);
    parts.push(`余量 ${row.remainingText || '?'}`);
    return parts.join(' / ');
  }

  function isAlreadySelected(target) {
    try {
      const kbDoc = PAGE.document.getElementById('kbFrame')?.contentDocument;
      if (!kbDoc) return false;
      return [...kbDoc.querySelectorAll('tr')].some((row) => {
        const firstCell = normalize(row.cells?.[0]?.innerText);
        return firstCell === target.noticeId && /选中|退选/.test(normalize(row.innerText));
      });
    } catch (_) {
      return false;
    }
  }

  async function verifySelected(target, timeoutMs = 10000) {
    try {
      return await waitUntil(() => isAlreadySelected(target), timeoutMs, 300);
    } catch (_) {
      return false;
    }
  }

  function captchaIsVisible(doc) {
    return isElementVisible(doc.querySelector('#verifyCodeDiv'));
  }

  function parseSelectionArguments(target) {
    const link = target.selectLink;
    const source = `${link?.getAttribute('href') || ''} ${link?.getAttribute('onclick') || ''}`;
    const match = source.match(
      /xsxkFun\s*\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([A-Za-z0-9_-]*)['"]\s*\)/,
    );
    if (!match) throw new Error('无法安全解析页面原生选课参数，已停止而不会猜测参数。');
    const args = { jx0404id: match[1], kcid: match[2], cfbs: match[3] };
    if (args.jx0404id !== target.noticeId) {
      throw new Error('选课按钮参数与当前课程通知单号不一致，已停止。');
    }
    return args;
  }

  async function invokeNativeSelection(doc, args, autoConfirmAll) {
    if (!doc?.defaultView || !doc.documentElement) {
      throw new Error('课程查询页面已失效，请刷新后重试。');
    }
    const response = await chrome.runtime.sendMessage({
      type: 'CAU_SELECT_COURSE',
      args,
      autoConfirmAll: Boolean(autoConfirmAll),
    });
    if (!response?.ok) throw new Error(response?.error || 'Chrome 扩展后台未返回选课结果。');
    const result = response.result || {};
    return {
      messages: Array.isArray(result.messages) ? result.messages.map(normalize) : [],
      confirmations: Array.isArray(result.confirmations) ? result.confirmations.map(normalize) : [],
    };
  }

  async function selectCourse(target) {
    const link = target.selectLink;
    if (!link?.isConnected) throw new Error('选课按钮已失效，课程表可能刚刚刷新。');
    const doc = link.ownerDocument;
    const args = parseSelectionArguments(target);
    let outcome;

    try {
      const courseConfig = activeCourseConfigs(state.config)[state.courseIndex];
      setPhase(PHASES.SUBMITTING, describeRow(target), { course: courseConfig });
      if (state.config.autoConfirmAllPrompts) {
        log('已按本次授权启用本次选课流程的全部“确定”弹窗自动确认。');
      } else {
        log('正在调用学校原生选课流程，请手动处理全部确认框。');
      }
      setPhase(PHASES.WAITING_DIALOGS, '正在处理学校页面的确认与结果弹窗', { course: courseConfig });
      outcome = await invokeNativeSelection(doc, args, state.config.autoConfirmAllPrompts);
      outcome.confirmations.forEach((text) => {
        log(`已自动点击“确定”：${text}`);
      });
      outcome.messages.forEach((text) => {
        log(`教务系统返回：${text}`, /成功|已选/.test(text) ? 'success' : '');
      });
    } catch (error) {
      throw new Error(`调用页面原生选课流程失败：${friendlyError(error)}`);
    }

    await sleep(450);
    if (captchaIsVisible(doc)) {
      const message = '教务系统要求验证码。脚本已暂停，请在页面中手动完成验证码，然后重新开始监控。';
      pauseMonitoring(message, { error: true });
      importantNotice('需要手动验证码', message);
      return 'stop';
    }

    const combined = outcome.messages.join('；');
    if (/请先登录|重新登录|登录超时|会话.*失效/.test(combined)) {
      const error = new Error(combined || '登录会话已失效。');
      handleFatal(error, '登录会话已失效');
      return 'stop';
    }

    const responseSaysSuccess = /选课成功|成功选上|操作成功|已选中|已经选择|已选过|重复选择/.test(combined);
    const courseConfig = activeCourseConfigs(state.config)[state.courseIndex];
    setPhase(PHASES.VERIFYING, '正在核对选课结果区域', { course: courseConfig });
    const verified = await verifySelected(target, responseSaysSuccess ? 3000 : 10000);
    if (verified || responseSaysSuccess) {
      const stopped = finishSuccess(
        `选课成功：${describeRow(target)}${combined ? `；系统消息：${combined}` : ''}`,
        courseConfig,
      );
      return stopped ? 'success' : 'continue';
    }

    if (/已满|容量不足|没有余量|无课余量|余量不足|名额.*满|人数.*满/.test(combined)) {
      setPhase(PHASES.SLOT_LOST, '提交时余量已被占用，将继续监控', { course: courseConfig });
      setCourseStatus(courseConfig, '余量被抢走 · 等待重试', 'yellow');
      log('余量在提交时被其他人占用，将退避后继续监控。');
      ui.result.textContent = '提交时已满，继续监控';
      return 'retry';
    }

    if (/冲突|限选|学分|未到选课时间|不允许|培养方案|不能选择|禁止/.test(combined)) {
      const message = combined || '教务系统拒绝了本次选课。';
      setCourseStatus(courseConfig, '教务规则拒绝 · 已暂停', 'red');
      pauseMonitoring(`不可重试的选课结果：${message}`, { error: true, phase: PHASES.ERROR_PAUSED });
      importantNotice('选课助手已暂停', message);
      return 'stop';
    }

    const message = combined || '页面没有给出可验证的成功结果。';
    setPhase(PHASES.UNCERTAIN, `${message} 将在下一轮前再次核对。`, { course: courseConfig, level: 'error' });
    setCourseStatus(courseConfig, '结果不确定 · 将继续核对', 'red');
    importantNotice('选课结果不确定', `${message} 助手将继续监控，并在再次提交前重新核对选课结果。`);
    return 'retry';
  }

  function finishSuccess(message, courseConfig) {
    if (courseConfig?.id) state.selectedCourseIds.add(courseConfig.id);
    setCourseStatus(courseConfig, '已选中', 'green');
    ui.result.textContent = '选课成功';
    const courses = activeCourseConfigs(state.config);
    const continueAll = state.config.mode === 'multi' &&
      state.config.successPolicy === 'continue-until-all-selected' &&
      state.selectedCourseIds.size < courses.length;
    if (continueAll) {
      setPhase(PHASES.SUCCESS, message, { course: courseConfig, level: 'success' });
      importantNotice('选课成功', message, true);
      const remaining = courses.length - state.selectedCourseIds.size;
      ui.result.textContent = `已成功 ${state.selectedCourseIds.size} 门，继续 ${remaining} 门`;
      log(`已按“全部选中后停止”策略继续监控，剩余 ${remaining} 门。`, 'success');
      return false;
    }
    pauseMonitoring(message, { success: true, phase: PHASES.SUCCESS });
    importantNotice('选课成功', message, true);
    return true;
  }

  function isSessionError(error) {
    return /登录|会话|userAccount|跨域/.test(friendlyError(error));
  }

  function isStructureError(error) {
    return /找不到|页面结构|内容框架|课程框架|课程输入框|查询按钮|课程表列|原生 xsxkFun|桥接/.test(friendlyError(error));
  }

  function friendlyError(error) {
    if (!error) return '未知错误';
    return normalize(error.message || error);
  }

  function handleFatal(error, prefix, stopRunning = true) {
    const message = `${prefix}：${friendlyError(error)}`;
    if (stopRunning && state.running) pauseMonitoring(message, { error: true });
    else log(message, 'error');
    ui.result.textContent = prefix;
    importantNotice(prefix, message);
  }

  function formatSeconds(ms) {
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  }

  function timeLabel() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function log(message, level = '', meta = {}) {
    if (!ui) return;
    const item = document.createElement('li');
    if (level) item.className = level;
    const phase = meta.phase ? `[${PHASE_LABELS[meta.phase] || meta.phase}] ` : '';
    const course = meta.course?.courseName ? `[${meta.course.courseName}] ` : '';
    item.textContent = `[${timeLabel()}] ${phase}${course}${message}`;
    ui.log.appendChild(item);
    while (ui.log.children.length > 120) ui.log.firstElementChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  let toastTimer = null;
  function toast(message, isError = false, durationMs = 3000) {
    document.getElementById(`${SCRIPT_ID}-toast`)?.remove();
    clearTimeout(toastTimer);
    const element = document.createElement('div');
    element.id = `${SCRIPT_ID}-toast`;
    element.textContent = message;
    if (isError) element.style.background = '#a63d35';
    document.body.appendChild(element);
    toastTimer = setTimeout(() => element.remove(), durationMs);
  }

  function ensureAudioContext() {
    if (!state.config.sound || state.audioContext) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) state.audioContext = new AudioContext();
    } catch (_) {
      // 音频不可用不影响核心功能。
    }
  }

  function beep(success = false) {
    if (!state.config.sound) return;
    ensureAudioContext();
    const context = state.audioContext;
    if (!context) return;
    try {
      if (context.state === 'suspended') context.resume();
      const frequencies = success ? [660, 880, 1100] : [780, 520, 780];
      frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + index * 0.18;
        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.16);
      });
    } catch (_) {
      // 提示音失败不影响通知和日志。
    }
  }

  function importantNotice(title, message, success = false) {
    toast(`${title}：${message}`, !success);
    beep(success);
    if (!state.config.desktopNotification) return;
    chrome.runtime.sendMessage({ type: 'CAU_NOTIFY', title, message })
      .then((response) => {
        if (!response?.ok) throw new Error(response?.error || '通知未发送');
      })
      .catch((error) => log(`桌面通知发送失败：${friendlyError(error)}`));
  }

  async function init() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    try {
      state.config = await loadConfig();
    } catch (error) {
      console.warn('[CAU Course Watcher] 配置载入失败，将使用默认值。', error);
      state.config = sanitizeConfig(DEFAULT_CONFIG);
    }
    createPanel();
    setInterval(updatePageStatus, 2500);
    checkPageHealth();
    setInterval(() => {
      if (!state.inFlight) checkPageHealth();
    }, 4000);
  }

  init();
})();
