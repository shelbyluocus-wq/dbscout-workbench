---
name: blackcat-release
description: 黑猫（DB Scout Workbench）一键打包发版。当用户说"打包"、"发版"、"打 release 包"、"package a release"或要求生成 SVN 更新包时使用。自动完成版本号 +1、生成两版本间的中文更新公告、执行 npm run release:package 产出 blackcat_<version>_x64-setup.exe 并更新 latest.json。
---

# 黑猫一键打包发版

用户说"打包"即执行以下完整流程。不要跳步，不要中途询问版本号（除非用户自己指定了版本号）。

## 流程

### 1. 确定新版本号

- 读取 `package.json` 的 `version`（例如 `0.1.21`）。
- 补丁位 +1 得到新版本号（`0.1.21` → `0.1.22`）。
- 如果用户明确指定了版本号，用用户指定的（必须是 `x.y.z` 格式）。

### 2. 生成更新公告

- 执行 `git log --oneline --grep="bump version" -n 1` 找到上一次发版提交。
  - 找到：执行 `git log <sha>..HEAD --oneline` 收集此后的全部提交。
  - 找不到（或范围为空）：退回执行 `git log --oneline -n 30` 作为总结依据。
- 把这些提交总结成**面向最终用户**的中文更新公告：
  - 必须使用从 `1.` 开始的连续数字分点（`1.`、`2.`、`3.`……），每条一行。
  - 每条使用短句，聚焦用户可感知的变化（新功能、体验改进、重要修复）。
  - 合并同类提交，忽略纯内部重构/构建/测试类提交（除非影响用户）。
  - 3–8 条为宜；实在没有可写的内容就用一行 `1. 若干问题修复与稳定性改进`。
  - 纯文本即可，不要 Markdown 标题，不要使用 `-`、`*` 等项目符号代替数字序号。

### 3. 同步版本号

```bash
npm run release:sync-version -- <新版本号>
```

该命令同步 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src/workbench/appVersion.js`。

### 4. 打包并注入公告

- 把公告写入 `tmp/release-notes-<新版本号>.md`（UTF-8，一行一条，每行保留连续数字序号）。
- 执行：

```bash
npm run release:package -- --notes-file tmp/release-notes-<新版本号>.md
```

这一步会自动完成 `tauri build`（耗时较长，用足够长的超时并允许后台运行）、把安装包重命名为 `blackcat_<新版本号>_x64-setup.exe`、并把公告写入 `latest.json` 的 `notes` 字段。

### 5. 验证产物

- 确认 `target/release/bundle/nsis/blackcat_<新版本号>_x64-setup.exe` 存在。
- 读取 `latest.json`，确认 `version` 是新版本号、`notes` 是刚生成的公告、`platforms.windows-x86_64.path` 与安装包文件名一致。
- 确认 `notes` 中每个非空行都以连续的 `1.`、`2.`、`3.`……开头；编号缺失或不连续均视为校验失败。

### 6. 汇报

向用户报告：

- 新版本号；
- 更新公告全文；
- 安装包完整路径；
- 提醒用户手动把 `latest.json` 和安装包提交到 SVN 更新目录（本流程不做 SVN 提交）。

## 失败处理

- 构建失败：终止流程，如实报告错误日志要点。**不要**回滚已被 `release:sync-version` 修改的版本号文件；告知用户可用 `git checkout -- .` 或 `git restore` 恢复。
- `latest.json` 校验失败：报告具体不一致项，不要手工二次改写（先排查原因）。

## 注意

- 不要执行任何 `git commit` / `git push` / `svn commit`。
- `release:sync-version` 与 `release:package` 是项目既有脚本，不要重写它们的逻辑；缺功能时改脚本本身而不是在流程里绕。
