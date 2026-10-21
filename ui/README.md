# 液态玻璃 UI

`liquid-glass.css` 与 `liquid-glass.js` 是两种发行版的共享材质源。运行 `node tools/build-ui.cjs` 同步内联代码和扩展弹出页引擎；`node tools/build-ui.cjs --check` 检查产物一致性。两种发行版均可直接安装，无 CDN、运行时依赖或额外权限。

参考项目：

- [apple-liquid-glass-webgl](https://oliverrr2424.github.io/webgl-apple-liquid-glass/docs/zh/) 的真实页面背景和光学层/DOM 内容分离思路。
- [xiaojiaenen/liquid-glass](https://github.com/xiaojiaenen/liquid-glass) 的边缘折射、鼠标反光与跨浏览器降级思路。
- [xiaop-liquid-glass](https://github.com/xiaop-coder/xiaop-liquid-glass) 的圆角 SDF 位移贴图、分层材质、磁吸与涟漪交互思路。

本实现为独立原生 DOM 实现，未复制这些库的源代码，也未嵌入其组件。面板和确认窗使用各自尺寸的圆角矩形 SDF 法线贴图，通过 SVG backdrop filter 折射背后的真实网页；中间保持中性位移，边缘位移不超过约 7px。Chrome/Edge 使用折射，其他引擎保留透明模糊与高光。跨域 iframe 不被读取或复制。

嵌套卡片、输入框使用低透明度色层，避免多次重模糊；原绿色、授权黄色、停止红色、状态语义和原有操作保持一致。弹出页有独立背景，因为浏览器扩展 popup 窗口无法读取底下标签页的像素；真正透出教务网页的界面是注入网页的面板、提示和确认窗。

尺寸变化才重算贴图。指针位置用 requestAnimationFrame 平滑插值，收敛即停止；触屏不启用磁吸。支持运行时减少动态效果/透明度设置，隐藏页面暂停动画，pagehide 清理监听与观察器，兼容往返缓存恢复。所有光学图像由本机 canvas 生成，无截图权限、网络请求或教务数据采集。

离线检查：`node tools/build-ui.cjs --check`。CI 使用现有的无头 Chrome 检查两种发行版的材质初始化和位移贴图。开发环境安装 Playwright 并有 Google Chrome 时，可运行 `node tests/liquid-glass.browser.cjs`，验证真实鼠标移动、空闲帧停止、增删课程、正常/多选模式、确认窗、减少动态效果/透明度以及 360/390/720/768px 窄屏布局；预览图片输出到忽略目录 `.preview/`。其中非 Chromium 路径只模拟 UA 以验证降级逻辑，不代表已在实际 Firefox/Safari 上运行。
