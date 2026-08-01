---
name: blackcat-release
description: 黑猫（DB Scout Workbench）一键打包并同步到 SVN 更新工作副本。当用户说“打包”“发版”“打 release 包”“package a release”“生成/同步 SVN 更新包”，或要求发布独立 AI 运行时时使用。先取得用户本次提供的 SVN 更新目录完整路径；未提供路径时必须在改版本号和打包前询问。随后生成中文更新公告、主安装包，并按需生成独立 AI 运行时，校验后把本次产物同步到指定 SVN 目录。
---

# 黑猫一键打包并同步 SVN

用户触发本 Skill 后，目标是让用户只提供本次 SVN 更新目录，剩余的版本、公告、打包、产物判断、校验和文件同步都由 AI 完成。

## 0. 打包前先取得 SVN 更新目录

这是阻塞步骤，必须在修改版本号、写公告或开始构建之前完成。

1. 先从用户当前消息中提取 SVN 更新目录的**完整本地路径**。
2. 用户已经提供路径时直接使用，不要重复询问。
3. 用户没有提供路径时，只问一个简短问题并等待回答：

   `请提供这次要同步到的 SVN 更新目录完整路径（应为名称包含 navicat 的本地 SVN 工作副本目录）。确认路径后我再开始打包。`

4. 收到路径后先做只读验证：
   - 必须是已存在的绝对目录，不能是 SVN URL、相对路径或 Skill 自己所在的目录；
   - 目录名必须包含 `navicat`（不区分大小写），这与黑猫当前更新器的目录规则一致；
   - 从该目录向上必须能找到 `.svn`，证明它位于 SVN 工作副本中；
   - 如果系统存在 `svn.exe`，先执行 `svn info <目录>`，再检查目标目录中的 `latest.json` 和 `agent-runtime.json` 是否有未解决冲突或本地待提交修改；有冲突/修改时停止，避免覆盖；确认干净后执行 `svn cleanup` 和 `svn update --non-interactive <目录>`。任一步失败都停止并报告。
   - 系统没有 `svn.exe` 时，使用工作副本中现有文件判断已发布版本，并在最终汇报中明确说明没有执行 `svn update`/`svn add`。
5. 不要把用户路径写回 `SKILL.md`、项目配置或脚本。路径只在本次发版中使用。

如果路径验证失败，在任何版本号文件被修改前停止。不要猜测另一个路径。

## 1. 判断本次需要发布哪些内容

黑猫程序和 AI 运行时是两个独立发布通道，不要每次都重复生成约 100 MB 的 AI 包。

- **普通“打包/发版”**：默认发布黑猫程序，即 `latest.json` 与 Windows 安装包。
- **首次启用独立 AI 运行时**：如果指定 SVN 目录没有 `agent-runtime.json`，本次自动改为“主程序 + AI 运行时”联合发布，并从 AI 运行时版本 `1` 开始。
- **AI 运行时更新**：用户明确提到“更新 AI 运行时”“更新 Node/Claude 底座”“发布 AI 包”时，读取 SVN 中现有的正整数版本并加 `1`。如果用户明确说“只更新 AI 运行时”，不要增加黑猫应用版本，也不要重打主安装包。
- **普通 AI 界面、提示词、Agent runner 或数据库工具逻辑变化**属于黑猫程序更新，不代表 Node/Claude 原生运行时变化，不要因此增加 AI 运行时版本。
- SVN 中已有完整有效的 AI 清单与对应 ZIP，且用户没有要求更新 AI 运行时时，沿用现有运行时，不要把本地目录里可能残留的旧 AI 产物误当成本次产物。

如果 SVN 中存在 `agent-runtime.json` 但它格式错误、对应 ZIP 缺失，或大小/SHA-256 不一致，把它视为损坏的发布状态：停止普通发版并如实报告，不要静默覆盖或猜版本。

## 2. 确定黑猫新版本号

仅当本次包含黑猫程序发布时执行：

- 读取 `package.json` 的 `version`（例如 `0.1.30`）。
- 默认补丁位 `+1`（`0.1.30` → `0.1.31`）。
- 用户明确指定版本号时使用指定值，但必须是 `x.y.z` 格式且必须高于 SVN `latest.json` 中已发布的版本。
- 不要覆盖 SVN 中已经存在的同版本安装包；版本冲突时停止并说明原因。

## 3. 生成更新公告

仅当本次包含黑猫程序发布时执行：

- 执行 `git log --oneline --grep="bump version" -n 1` 找到上一次发版提交。
  - 找到：执行 `git log <sha>..HEAD --oneline` 收集此后的提交。
  - 找不到或范围为空：退回 `git log --oneline -n 30`。
- 把提交总结成面向最终用户的中文公告：
  - 使用从 `1.` 开始的连续数字分点，每条一行；
  - 使用短句，聚焦用户能感知的功能、体验和重要修复；
  - 合并同类项，忽略无用户影响的内部重构、构建和测试；
  - 以 3–8 条为宜；没有可写内容时使用 `1. 若干问题修复与稳定性改进`；
  - 不使用 Markdown 标题或 `-`、`*` 项目符号。

## 4. 同步应用版本并打主安装包

仅当本次包含黑猫程序发布时执行：

```bash
npm run release:sync-version -- <新版本号>
```

把公告写入 `tmp/release-notes-<新版本号>.md`（UTF-8），然后执行：

```bash
npm run release:package -- --notes-file tmp/release-notes-<新版本号>.md
```

该命令会执行 Tauri 构建，生成：

- `target/release/bundle/nsis/blackcat_<新版本号>_x64-setup.exe`
- 工作区根目录的 `latest.json`

构建可能耗时较长，应使用足够长的超时并持续向用户报告进度。

## 5. 按需生成 AI 运行时

仅当第 1 步判断本次需要首次发布或升级 AI 运行时时执行。

```bash
npm run release:agent-runtime -- --version <AI正整数版本> --min-app-version <最低黑猫版本> --output-dir target/release/bundle/agent-runtime
```

- 联合发布时，`min-app-version` 使用本次新黑猫版本。
- 只更新 AI 运行时时，使用当前已发布黑猫版本，除非用户明确指定更高的最低版本。
- 生成：
  - `target/release/bundle/agent-runtime/agent-runtime.json`
  - 清单 `package` 字段指向的 `agent-runtime-v<N>-<platform>.zip`
- 同版本但内容发生变化时命令会拒绝覆盖；此时必须增加 AI 运行时版本，不能绕过保护。

## 6. 验证本次产物

主程序产物验证：

- 安装包存在且不超过 20 MiB；
- `latest.json.version` 是本次版本；
- `latest.json.platforms.windows-x86_64.path` 与安装包文件名一致；
- `notes` 与本次公告一致，非空行编号从 `1.` 开始连续递增；
- 安装包配置仍排除了 Node 和 Claude 原生 CLI。

AI 运行时产物验证：

- `version` 是正整数，且没有低于 SVN 已发布版本；
- ZIP 文件名与清单 `package` 一致；
- ZIP 实际字节数与 `size` 一致；
- ZIP 的 SHA-256 与清单 `sha256` 一致；
- `minAppVersion` 不高于本次准备发布或当前已发布的黑猫版本。

任一验证失败时不要同步 SVN 目录。

## 7. 同步到用户指定的 SVN 工作副本

使用 Skill 自带工具，不要临场拼接复制命令：

```bash
node .agents/skills/blackcat-release/scripts/sync-release-artifacts.mjs \
  --svn-dir "<用户提供的完整路径>" \
  --installer "target/release/bundle/nsis/blackcat_<版本>_x64-setup.exe" \
  --latest "latest.json"
```

如果本次还生成了 AI 运行时，在同一个命令中增加：

```bash
  --agent-manifest "target/release/bundle/agent-runtime/agent-runtime.json" \
  --agent-package "target/release/bundle/agent-runtime/<清单中的package>"
```

如果是“只更新 AI 运行时”，只传 `--svn-dir`、`--agent-manifest`、`--agent-package`。

同步工具会：

- 再次验证 SVN 路径、主清单、AI 清单、文件大小和 SHA-256；
- 先复制安装包/AI ZIP，最后覆盖对应 JSON 清单，避免清单短暂指向不存在的大文件；
- 写入后再次逐文件校验；
- 保留旧版本安装包和旧 AI ZIP，不做目录清理；
- 不执行 `svn commit`。

如果系统能使用 SVN 命令行，再对本次新文件执行 `svn add` 并展示这些目标的 `svn status`；不要把目录中的其他改动一起加入。系统没有 SVN 命令行时，文件同步仍算完成，明确告诉用户可在 TortoiseSVN 中看到待提交文件。

`svn commit` 会直接改变远端发布状态。只有用户在当前请求中明确要求“提交/发布到 SVN”时才能执行，并且提交范围只能是本次同步的文件；普通“打包”请求不自动提交。

## 8. 最终复核与汇报

从 SVN 目标目录重新读取并确认：

- `latest.json` 指向目标目录中真实存在的本次安装包；
- 如果本次同步 AI，`agent-runtime.json` 指向真实存在且哈希匹配的 ZIP；
- 源文件与 SVN 目标文件的大小和 SHA-256 一致。

向用户报告：

- 黑猫新版本号（如本次发布）；
- AI 运行时版本号（如本次发布）；
- 更新公告全文；
- 用户提供的 SVN 目标目录；
- 实际同步的文件完整路径；
- 是否执行了 `svn add`，以及是否执行了远端 `svn commit`。

不要再让用户手动复制文件。

## 失败处理

- SVN 路径缺失或错误：在改版本号和构建前停止并询问，不要猜路径。
- 构建失败：终止流程并报告错误要点。不要使用 `git checkout -- .`、`git reset --hard` 或其他可能覆盖用户工作的命令。
- 产物校验失败：不触碰 SVN 目标目录，先报告不一致项。
- SVN 同步失败：保留本地已验证产物，报告哪些目标已成功、哪些失败；不要删除 SVN 目录或回滚目录中的其他文件。
- 目标清单存在未处理的 SVN 冲突时：停止同步并让用户先解决冲突。

## 注意

- 不要执行 `git commit`、`git push`，也不要在普通打包请求中执行 `svn commit`。
- 不要把 SVN 路径永久写入 Skill 或项目文件。
- 不要将本地旧 AI 产物自动混入普通应用发版。
- `release:sync-version`、`release:package`、`release:agent-runtime` 是项目既有脚本；缺功能时修改脚本本身，不要在 Skill 中复制实现。
