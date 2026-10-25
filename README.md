# dsh-plugin-memo（备忘）

A lightweight **notes & todo** panel plugin for the [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web UI. Everything is stored locally on your machine — no account, no sync, no network calls.

DSH Web UI 的「备忘」插件：左侧栏一个入口，面板顶部一个 sheet 页签切换 **待办 / 备忘**；其中最大的「主要备忘」窗口同时出现在**右侧栏**（作为独立的「备忘」页签），可以一边聊天一边记。数据全部保存在本机，可直接阅读和备份。

## 功能

- **待办分栏**：左「工作」、右「个人」，各自输入后回车添加。
- **已完成单独成区**：每栏下半部分是「已完成」，新完成的排最上面、显示完成时间，灰色文字不划线，一眼能看清。
- **拖拽排序**：按住待办行拖动即可在栏内调整顺序（上半区/下半区各自排序），顺序持久化；拖动时有插入指示线。
- **行内编辑**：直接点待办文字就地修改，回车或点别处保存，`Esc` 取消；没有多余的编辑按钮。
- **多窗口备忘**：左侧 2×2 四个窗口 + 右侧一个完整大窗口，可同时记多处内容。
- **右侧栏备忘**：最大的「主要备忘」窗口也是右侧栏的一个页签，聊天时打开右侧栏即可随手记；与主面板共用同一份内容，两边输入实时同步。
- **自动保存**：备忘边写边存（600ms 防抖），失焦 / 切页签 / 关页面立即落盘；标题旁显示「保存中… / 已自动保存 · 时间」。
- **跟随 DSH 主题**：只用 `--dsw-alias-*` 主题 token，浅色/深色自动适配；中英文文案走 `ctx.locale`。
- **本地优先**：单文件 JSON 存储，串行写入 + 原子替换，文件损坏自动备份。

## 安装

插件是纯 JavaScript 包，无构建步骤、无第三方运行时依赖。

### 方式一：从 GitHub 安装（推荐）

在 DSH 里让助手执行 `plugin_manager` 的 `install_bundle`，目标填：

```
github:nin2c/dsh-plugin-memo
```

或在终端（选择合适的 profile，`desktop` / `web`）：

```bash
dsh plugin --profile desktop add github:nin2c/dsh-plugin-memo
```

然后重启 DSH（或让插件经理热加载）。安装后在左侧栏会出现「备忘」图标。

### 方式二：从本地目录安装

```bash
git clone https://github.com/nin2c/dsh-plugin-memo.git
```

再用 `plugin_manager` 的 `install_bundle` 指向该目录（本地目录会以 `link:` 方式安装）。

### 方式三：手动放进 profile

把本包加入 profile 的依赖与 `dsh.profile.bundles`，由 DSH 的 bundle 层加载。

## 使用

- 打开：左侧栏（Plugins / Schedules 同一条）点 📝 图标。
- 待办：输入 → 回车添加；勾选完成；点文字改内容；拖拽换位置；每栏可单独「清空已完成」。
- 备忘：直接在五个窗口里写，自动保存。
- **右侧栏备忘**：在对话页点右上角的右侧栏开关，右侧栏的指南页里点「备忘」卡片（或点 + 打开指南）；之后该会话的右侧栏布局会记住这个页签。它编辑的就是主面板里右侧那个「主要备忘」窗口，两边内容实时同步、同样自动保存。
- 数据：`$DSH_HOME/plugin-data/notes-todo/data.json`（默认 `~/.dsh/plugin-data/notes-todo/data.json`）。

> 数据目录名 `notes-todo` 是历史命名，包名已改为 `dsh-plugin-memo`，升级不会丢数据。

## 数据格式

```json
{
  "version": 2,
  "todos": [
    { "id": "t_…", "text": "…", "done": false, "category": "work", "createdAt": "…", "doneAt": null }
  ],
  "memos": {
    "topLeft": "…", "topRight": "…", "bottomLeft": "…", "bottomRight": "…", "main": "…"
  },
  "updatedAt": "…"
}
```

`category` 为 `work` 或 `personal`；数组顺序即待办显示顺序。旧版数据（v1 的 `notes` 列表、无分类待办、三窗口备忘）会在读取时自动迁移。

## 宿主 API

插件在宿主注册同源 HTTP 路由 `/notes-todo`（由 `webServer` 提供）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/notes-todo/api/ping` | 版本、数据文件路径、计数 |
| GET | `/notes-todo/api/state` | `{ ok, todos, memos, updatedAt }` |
| POST | `/notes-todo/api/mutate` | 一次原子操作，返回完整新状态 |
| POST | `/notes-todo/api/client-log` | 面板崩溃上报 |

`mutate` 的 `op`：`todo.add` / `todo.update` / `todo.toggle` / `todo.move` / `todo.delete` / `todo.clearCompleted` / `memo.set`。操作只在插件自己的 Host 与页面之间使用。

## 兼容性

- 面向 DSH 的 Web UI（Desktop / Web profile），使用官方插槽（`sidebar.panellist`、`main`、右侧栏的 `sidebar.right.pane.tab` 与 `ctx.sidebarRightTabs`）与 `webServer` 路由，不依赖 DSH 内部私有包。右侧栏扩展在缺少该能力的 DSH 版本上会自动跳过，面板功能不受影响。
- 在 DSH `0.2.1-rc.2`（Desktop profile）上开发与验证。
- 客户端只用 `require('react')` 与主题 token；宿主只使用 Node 内置模块，因此不需要构建。

## 开发

```bash
# 语法检查
npm run check
```

- `index.js` — 宿主半：`webServer` 前缀路由 + JSON 存储 + 数据迁移。
- `client.js` — Web 半：插件面板与右侧栏备忘页签的注册、React 视图、拖拽与行内编辑、自动保存与跨视图同步。
- `cordis.patch.yml` — 插入 `memo` 插件行。
- `locale/{en,zh}.json`、`icon.svg` — 插件管理页的标题、描述与图标。

源码是手写的可读 JavaScript，没有压缩产物；改完重新加载插件（或重启 DSH）即可生效。

## 隐私

- 不联网、不收集数据、无遥测。
- 所有内容只写本机 `$DSH_HOME/plugin-data/notes-todo/` 下的 JSON 文件。

## License

[MIT](LICENSE) © 2026 nin2c
