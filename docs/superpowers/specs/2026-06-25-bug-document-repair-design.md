# Bug 文档修复设计

- 日期：2026-06-25
- 分支：main
- 状态：已通过规格自审，待用户 review
- 来源：`E:/project/obsidian-vault/迭代计划.md`

## 1. 目标

修复 bug 文档中的 12 项问题，保持 DB Scout Workbench 现有 Tauri 2 + Vue 3 + Rust 架构不变。实现分两批推进，但验收范围仍覆盖完整清单：

1. 批量导出遇到超长文本时报 `Text length must not exceed 32767 characters`。
2. 右下角详细单元格信息区域改到表格下方，仍支持拖拽大小，不再显示原拖拽 icon。
3. 详细单元格信息区域支持编辑并保存。
4. F2 进入单元格编辑后，左右方向键应移动输入光标，不应跳到其他单元格。
5. 支持保存正常空字符串，只有明确设置 `null` 才保存为 NULL。
6. 表设计支持新增字段。
7. 排序按真实值大小排序，不按字符串展示顺序排序。
8. `Ctrl+P` 聚焦并选中数据库搜索框。
9. 增加快捷栏打开软件界面，默认 `Shift+F`，设置里提供快捷键修改入口。
10. 点击界面右上角关闭时不真正退出，只最小化或隐藏；真正退出从托盘菜单触发。
11. 字段手动拖拽宽度不再限制最大宽度。
12. 点击单元格时显示当前行列高亮。

## 2. 分批策略

### 第一批：表格与数据正确性

包含第 1、2、3、4、5、6、7、8、11、12 项。它们主要集中在 `src/workbench`、表设计 DDL、mock/demo 排序和前端交互，可用 JS 单测、Rust DDL 单测、构建和浏览器验证闭环。

### 第二批：桌面壳层能力

包含第 9、10 项。它们需要 Tauri 原生窗口、托盘、全局快捷键与配置入口，风险边界和验证方式不同，单独计划与验证。

## 3. 非目标

- 不改变数据库编辑的核心命令契约：`update_cell`、`insert_row`、`fetch_table_page` 等仍保持原语义。
- 不支持删除字段。表设计新增字段会实现；删除字段不纳入本轮修复，以避免误删数据。
- 不让自动列宽因为超长文本撑满整张表。只取消手动拖拽最大宽度限制，自动适配仍保持保守。
- 不把超长 XLSX 单元格静默丢弃。必须让导出完成，并向用户暴露截断信息。
- 不把 `Ctrl+P` 或快捷键在文本编辑状态下强行抢焦点。

## 4. 关键设计

### 4.1 批量导出超长文本

Excel 单元格文本上限是 32767 字符，`xlsx` 在写入超长文本时会抛错。新增导出清洗层：

- 在 `useBatchTransfer.js` 和单表 `useExport.js` 写 sheet 前统一调用单元格规范化函数。
- 字符串长度超过 32767 时截断到限制内，记录表名、列名、行序号和原始长度。
- 批量导出结果中显示“已截断 N 个超长单元格”，详细信息放入 `batchExport.progress.errors` 或等价结果字段。
- 普通非字符串值保持原值，`null` 仍导出为空单元格或 `NULL` 展示由现有逻辑决定。

### 4.2 详情区移到底部并可保存

把当前 `InspectorPanel.vue` 内的单元格详情编辑区拆成独立底部组件 `CellDetailPanel.vue`：

- 右侧 inspector 保留表信息、字段备注、AI 面板切换能力。
- 表格下方增加底部详情区，显示当前选中单元格、格式高亮和可编辑 textarea。
- 详情区高度由新的垂直布局状态控制，使用横向分隔条拖拽，不显示原来的居中拖拽 icon。
- 保存复用现有 `saveTextPanel`：失焦、`Ctrl+S` 都能保存；保存成功继续使用现有保存反馈。
- 多 pane 场景使用当前 focused pane 的 `selectedCell`、`textDraft`、`saveTextPanel`，避免保存到非焦点 pane。

### 4.3 F2 编辑时方向键行为

当前 grid 根节点处理方向键会导致 F2 编辑后左右跳格。修复规则：

- 普通数据单元格 input 拦截 `ArrowLeft` / `ArrowRight`，不冒泡到 grid 导航。
- 在输入框内，左右键交给浏览器移动光标。
- `ArrowUp` / `ArrowDown` 保持现有表格导航保存/移动行为。
- 新增行 input 同样优先让左右键移动文本光标；`Tab`、`Enter`、`Escape` 维持现有新增行规则。

### 4.4 空字符串与 NULL 区分

当前部分清洗逻辑会把空字符串当成“无值”。修复规则：

- 编辑已有单元格时，`""` 是合法新值，提交给 `update_cell`。
- 只有用户明确触发“设为 NULL”或详情区传入 `null` 时，才保存 NULL。
- `validateRequired` 仍阻止非空字段保存空字符串；可空字符串字段允许保存 `""`。
- 新增行草稿的 `cleanDraftValues` 不再把所有空字符串删除；对显式编辑过的字段保留 `""`。

### 4.5 表设计新增字段

前端：

- `TableDesignEditor.vue` 增加“新增字段”按钮。
- 新字段草稿使用 `originalName: ""` 或 `isNew: true` 标记，默认字段名如 `new_column`、类型 `varchar(255)`、可空。
- `buildTableDesignPayload` 保留新字段标记，验证新增字段名称、类型、重复名和默认值。

Rust DDL：

- `ddl.rs` 不再在 `validate_draft_shape` 中拒绝新增字段。
- 对新字段生成 `ADD COLUMN \`name\` definition`。
- 支持 `FIRST` 或 `AFTER \`previous_column\``，按草稿顺序落位。
- 主键新增字段为主键时，按现有主键变更逻辑统一 `DROP PRIMARY KEY` / `ADD PRIMARY KEY`。
- 继续禁止删除字段，避免数据破坏。

### 4.6 排序按真实值

真实 MySQL/ClickHouse 路径已交给数据库 `ORDER BY`。问题主要来自 mock/demo 或字符串列类型判断不足：

- mock/demo 排序根据列元数据推断类型。
- 整数、小数、浮点按数值比较。
- 日期时间按时间值比较。
- 其他类型按 locale/string 比较。
- 空值固定排在末尾，升序/降序都保持稳定。
- 增加截图中的 ID 场景回归：`1, 2, 10, 11, 100, 101...`。

### 4.7 `Ctrl+P` 聚焦数据库搜索框

- `WorkbenchSidebar.vue` 暴露搜索输入 ref 或聚焦方法。
- `MySqlWorkbench.vue` 注册全局前端 keydown。
- 当焦点在 textarea、input、select 或 contenteditable 中时不抢键，除非该焦点就是数据库搜索框。
- 触发后展开/聚焦数据库搜索框，并选中现有查询文本。

### 4.8 手动列宽取消最大限制

- `useColumnResize.js` 手动拖拽从 `Math.min(MAX_COL_WIDTH, ...)` 改为只受最小宽度约束。
- `colStyle` 对手动宽度继续设置 `width/minWidth/maxWidth`，让横向滚动承担超宽列。
- 自动适配继续使用 `MAX_COL_WIDTH`，避免大表打开时被超长内容撑爆。

### 4.9 单元格选中行列高亮

- `DataGrid.vue` 根据 `selectedCell` 计算当前行 key 与列名。
- 当前行已有 `row-active`，补充当前列 class，例如 `col-active`。
- 高亮样式轻量，低于 selected/range/error/pending 状态优先级。
- 新增行和普通数据行都支持。

### 4.10 快捷键设置与 `Shift+F` 唤起窗口

需要新增 Tauri 全局快捷键能力：

- Rust 依赖加入 `tauri-plugin-global-shortcut`。
- 默认注册 `Shift+F` 为“显示并聚焦主窗口”。
- 前端设置面板增加“快捷键”入口，弹窗列出可修改快捷键。
- 快捷键配置保存在本地，启动时注册；修改后注销旧快捷键并注册新快捷键。
- 第一版至少包含：
  - 显示/聚焦主窗口：默认 `Shift+F`
  - 聚焦数据库搜索：默认 `Ctrl+P`

### 4.11 关闭按钮最小化/隐藏与托盘退出

- 前端 `closeWindow()` 改为请求最小化或隐藏，不再调用 `window.close()`。
- Rust 监听窗口关闭事件，拦截用户关闭并隐藏窗口。
- 新增系统托盘图标和右键菜单：
  - 显示窗口
  - 退出
- 只有托盘“退出”设置退出标记后才允许进程关闭。
- 保持最小化按钮仍为普通最小化。

## 5. 错误处理

- 导出截断是可恢复警告，不让整个批量导出失败。
- 表设计新增字段的 DDL 预览必须展示将执行的 `ADD COLUMN`。
- 快捷键注册失败时在设置弹窗中显示错误，不影响主应用启动。
- 托盘创建失败时关闭按钮退化为最小化，并在状态栏提示桌面壳能力不可用。

## 6. 测试与验证

### JS 单测

- `useBatchTransfer.test.js`：超长单元格导出不抛错，并记录截断警告。
- `useExport.test.js`：单表导出同样处理超长文本。
- `useGridEditor.test.js`：F2 编辑左右键不触发表格导航；空字符串保存会调用 `update_cell`。
- `valueValidation.test.js`：空字符串与 `null` 区分。
- `useTableDesign.test.js` / `tableDesign.test.js`：新增字段 payload 和验证。
- `mockBackend.test.js`：数值排序按数值。
- `useColumnResize.test.js`：手动拖拽不受 `MAX_COL_WIDTH` 限制，自动适配仍受限。
- shell/CSS 测试：底部详情区挂载、高亮 class、`Ctrl+P` 聚焦入口、快捷键设置入口。

### Rust 单测

- `ddl.rs`：新增字段生成 `ADD COLUMN`。
- `ddl.rs`：新增字段后保持现有字段修改、主键变更、表备注修改不回归。
- 壳层静态或单元测试：托盘退出标记与关闭拦截路径存在，快捷键命令注册路径存在。

### 手动验证

1. 批量导出含超长文本的表，导出完成并显示截断提示。
2. 打开表，详情区在表格下方，拖拽高度正常，编辑后失焦或 `Ctrl+S` 保存。
3. F2 编辑单元格，左右键只移动光标。
4. 保存空字符串字段成功；明确设为 NULL 时保存 NULL。
5. 表设计新增字段，预览出现 `ADD COLUMN`，应用后表结构刷新。
6. ID 排序按数值大小。
7. `Ctrl+P` 聚焦左侧数据库搜索框并选中文本。
8. 手动拖宽列超过 400px，横向滚动正常。
9. 点击单元格显示行列高亮。
10. `Shift+F` 能从后台唤起窗口。
11. 点击右上角关闭后应用不退出，托盘右键“退出”才关闭。

### 命令验证

- 显式枚举 `src/workbench/**/*.test.js` 后执行 `node --test`。
- `cargo test --manifest-path src-tauri/Cargo.toml`。
- `npm.cmd run build`。
- `git diff --check`。

## 7. 实现顺序

1. 第一批先做数据正确性：导出超长文本、空字符串保存、排序、F2 左右键。
2. 再做表格布局体验：底部详情区、行列高亮、列宽、`Ctrl+P`。
3. 再做表设计新增字段，包含 Rust DDL 与前端编辑器。
4. 第二批做 Tauri 壳层：托盘、关闭拦截、`Shift+F`、快捷键设置入口。
5. 全量验证与手动 UI 验证。

## 8. 风险

- 底部详情区会改变主布局，需要验证 split pane、多 tab、AI panel 与右侧 inspector 不互相挤压。
- 新增字段 DDL 必须谨慎处理字段顺序和主键，避免生成危险 SQL。
- 全局快捷键在不同平台的可用组合可能不同，设置入口需要给出注册失败反馈。
- 托盘行为在 Windows/macOS 上可能不同，至少先保证 Windows 路径可靠。
