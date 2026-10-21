'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'ui/liquid-glass.css'), 'utf8').trimEnd();
const engine = fs.readFileSync(path.join(root, 'ui/liquid-glass.js'), 'utf8').trimEnd();
const check = process.argv.includes('--check');
let stale = false;
function output(file, content) {
  const target = path.join(root, file);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') === content) return;
  if (check) { console.error(`Stale generated UI: ${file}`); stale = true; }
  else fs.writeFileSync(target, content);
}
for (const file of ['chrome-extension/content.js', 'userscript/cau-course-watcher.user.js']) {
  let source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  source = source.replace(/\n\/\* BEGIN SHARED GLASS CSS \*\/[\s\S]*?\/\* END SHARED GLASS CSS \*\/\n/, '');
  source = source.replace(/\n+  \/\/ BEGIN SHARED GLASS ENGINE[\s\S]*?  \/\/ END SHARED GLASS ENGINE\n+/, '\n\n');
  source = source.replace('    `;\n    document.documentElement.appendChild(style);', `\n/* BEGIN SHARED GLASS CSS */\n${css}\n/* END SHARED GLASS CSS */\n    \u0060;\n    document.documentElement.appendChild(style);`);
  source = source.replace('  function createPanel() {', `  // BEGIN SHARED GLASS ENGINE\n${engine.split('\n').map((line) => line ? `  ${line}` : '').join('\n')}\n  // END SHARED GLASS ENGINE\n\n  function createPanel() {`);
  if (!source.includes('    installLiquidGlass(panel, modal);')) {
    source = source.replace('    bindPanelEvents();', '    bindPanelEvents();\n    installLiquidGlass(panel, modal);');
  }
  output(file, source);
}
output('chrome-extension/liquid-glass.js', `${engine}\ninstallLiquidGlass(document.querySelector('main'));\n`);
if (stale) process.exitCode = 1;
else console.log(check ? 'Shared glass UI: synchronized' : 'Shared glass UI: built');
