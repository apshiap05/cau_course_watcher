# Release process

本项目从 `v1.3.0` 开始统一 Chrome 扩展、Tampermonkey 用户脚本和 GitHub Release 的版本号。

## 哪些改动需要 Release

以下改动完成后必须发布新 Release：

- 新功能、功能行为变化或重要界面变化。
- 修复会影响查询、匹配、轮询、选课、弹窗或配置保存的问题。
- Chrome 权限、Manifest、安装包结构或兼容性变化。

仅修改拼写、链接、注释或开发文档时通常不单独发布 Release，除非用户明确要求。

## 发布规则

1. 按语义化版本确定新版本号：不兼容变化升主版本，新功能升次版本，兼容性修复升补丁版本。
2. 同时更新以下位置的版本号：
   - `chrome-extension/manifest.json`
   - `chrome-extension/content.js` 面板标题
   - `chrome-extension/popup.html`
   - `userscript/cau-course-watcher.user.js` 的 `@version`
   - 根 README 和两个版本的 README
   - `CHANGELOG.md`
3. 运行全部语法检查、Manifest 解析、单元测试和适用的离线浏览器渲染检查。
4. 扫描源码和待发布资产，确认不包含密码、令牌、Cookie 或其他凭据。
5. 提交并推送 `main`；如果远端领先，先抓取并无损合并，禁止用强制推送覆盖。
6. 等待该 `main` 提交的 GitHub Actions 成功。
7. 在该已验证提交上创建新的带注释语义化标签，例如 `v1.3.0`。禁止移动或复用旧标签。
8. 创建对应 GitHub Release，标题使用 `CAU Course Watcher vX.Y.Z`，既不设为草稿，也不设为预发布。
9. Release 至少附带：
   - `CAU-Course-Watcher-Chrome-vX.Y.Z.zip`
   - `cau-course-watcher-vX.Y.Z.user.js`
10. Release Notes 只写本次版本的实际更新内容；不写安装/升级方法、配置迁移、测试结果、安全边界或其他与更新内容无关的项目。
11. 发布后核对 Release 标签、目标提交、两个附件名称和下载地址，并确认仓库工作区干净、`main` 与 `origin/main` 同步。

## 历史版本

历史 Release 和标签用于审计与回退，正常发布不得删除、覆盖或强制移动。发现旧 Release 内容不完整时，应在新的 Release Notes 中说明，并发布新的修订版本；只有用户明确要求时才修改历史 Release 本身。
