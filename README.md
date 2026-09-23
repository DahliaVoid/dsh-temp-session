# dsh-temp-session

DeepSeek Harness Web (dsh) 插件：**工作区可选化 + 免工作区临时会话**。

- 未选定工作区时，Hero 工作区入口显示 **「选择工作区（可选）」**（点击行为与原选择菜单完全一致）；
- 已选定工作区时，入口内**下拉箭头原位变成 ×**：鼠标悬停到大按钮上时箭头自动变 ×，点击 × 取消工作区选择（回到未选定状态）；点击按钮其他区域仍是正常打开工作区选择；
- 未选择工作区的会话 = **临时会话**：独占一个独立目录 `$DSH_HOME/tmp-sessions/session-<uuid>`（默认即 `~/.dsh/tmp-sessions/…`），会话的 cwd、沙盒写边界、侧边栏归组（Ungrouped）全部自动以该目录为准，与 dsh 安装目录及彼此之间相互独立；
- 侧边栏通用 **「新建会话」** 按钮（未指定工作区时）默认直接创建临时会话；工作区行内的 **+** 仍创建该工作区的会话（原行为不变）；
- **桌面客户端（DeepSeek Harness Desktop / dsh-tauri ≥ 0.15.9）自带的「未分组」新建会话会被本插件屏蔽**，
  从侧边栏、分组行到 Hero 芯片全部回到本插件的语义（详见「屏蔽桌面客户端的『未分组』新建会话」）。

## 来源与依赖

- 宿主半区：`lib/index.js` —— 注册 `POST /api/dsh-temp-session/reserve`（预留独立目录）、启动清理、临时会话语义提示注入、**内核客户端补丁安装器**。零 `@deepseek-ai/*` 运行依赖。
- 浏览器半区：`lib/client.js` —— 纯 DOM/状态对账 + store 订阅，无构建步骤、无第三方 import。
- 适配对象：dsh 0.1.2-rc.x ~ 0.1.5-rc.3 的 web profile（桌面客户端即以内置 0.1.5-rc.3 内核 + 自带 UI 插件运行）；
  详见下方「行为细节」的内核适配说明。
- 回归测试：`test/client-behaviour.test.mjs`（`npm test`）——自带最小 DOM 桩，锁住芯片对账与桌面屏蔽的判定，不依赖浏览器。

## 内核客户端补丁（可选工作区的关键）

dsh 在 `workspaces.phase === "ready"` 时会把"无工作区会话"的 `chipTitle` 置空，
进而使组合输入框整体失效（必须选工作区）。该逻辑是 React 闭包状态，插件层面
无法覆盖，因此本插件在**每次启动时**对安装的内核文件
`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 做一行幂等替换
（去掉 `workspaces.phase === "ready"` 这一条件），让无工作区会话也能获得 cwd
标签 → 输入框可输入、可发送。

- 首次修补前自动备份为 `client.js.dsh-temp-session.bak`；已修补则跳过；
- 补丁带标记 `/* dsh-temp-session */`，可随时检查（`Select-String -SimpleMatch`）；
- 恢复原状：把 `.bak` 复制回 `client.js`（或升级 dsh 内核后重新安装本插件）；
- 若内核升级改动了目标代码，插件启动日志会输出 **"conversation bundle drifted"**，
  此时需更新插件版本以匹配新内核。

## 屏蔽桌面客户端的「未分组」新建会话（0.1.4）

**背景**：DeepSeek Harness Desktop（dsh-tauri）从 0.15.9 起，由自带 UI 插件
`dsh-tauri-ui` 提供了一套与本插件同义的「未分组」新建会话，会顶掉本插件的效果：

| 桌面侧的实现 | 落点 | 对插件的破坏 |
|---|---|---|
| 内核补丁在 `<html>` 上写 `data-dsh-composer-cwd="1"`，桌面插件据此把能力位 `composer.workspace-less` 置为可用 | `<html>` 属性 | ——（这是桌面功能的"总开关"） |
| 侧边栏通用「新建会话」与「未分组」分组行的 **+** 用 `document` **捕获期** click 监听拦下（`preventDefault` + `stopImmediatePropagation`），改去建会话 | `$DSH_HOME/ungrouped`（共享目录！） | 本插件的 `uiWorkspace.startSession` 拦截**根本收不到事件** |
| hero 的 `conversation.hero.workspace` 是 **single 槽**，桌面插件以 `priority: -1` 遮蔽官方 `WorkspacePicker`，再用 CSS 把官方芯片（`aria-label="选择工作区"`）置为 `display:none` | `$DSH_HOME/ungrouped` | 本插件对账命中的是**看不见的官方芯片**，于是「选择工作区（可选）」与悬停 × 全部失联 |

**本插件的做法是"逐点断电 + 兜底改道"，不触碰桌面插件的其他功能（设置侧边栏、
面板、模型配置等一律照旧）**：

1. **能力位断电**：启动时摘掉 `<html>` 上的 `data-dsh-composer-cwd`，并用
   `MutationObserver` 保持摘除。桌面插件对该能力位是**调用期实时求值**，因此此后：
   - 侧边栏两个捕获期拦截器会主动让位（只 warn + return，不再 `preventDefault`），
     事件回到官方处理 → 本插件的 `uiWorkspace.startSession` 拦截生效 → **本插件的临时会话**；
   - 桌面 hero 芯片若尚未注册（本插件先于桌面插件 apply 的时序）也不再注册，
     官方 `WorkspacePicker` 留在原位。
2. **芯片对账取"当前可见的那一个"**：桌面芯片顶替官方选择器后就装修它——文案照样是
   「选择工作区（可选）」/ 工作区标题，已选定工作区时悬停照样出 ×。不再往 `display:none`
   的节点上写没人看得见的东西。
3. **兜底改道**：包装 `sessions.create` —— 凡"不带 `workspaceId`，且不带 `cwd`
   或 `cwd` 末段为 `ungrouped`"的创建（正是桌面插件的两条路径），一律改走本插件预留的
   临时目录。即使桌面芯片菜单里的「未分组」项被点到，落地的也是本插件的临时会话，
   而不是共享目录；带 `workspaceId`（上游 `connectWorkspace`）或带 `sessionId`
   （本插件自己的预留创建、其他插件）的调用**原样放行**。
4. **主机半区顺手清理**：启动时同时注销 `$DSH_HOME/ungrouped` 被物化出来的
   Workspace 记录（伪项目分组），会话与日志照旧不动。

以上逻辑**只在桌面特征存在时生效**（`<html>` 上有 `data-dsh-composer-cwd`，或 DOM 里
有 `.dshp-hero-workspace`）；纯净 dsh / 内置 Web 界面下全部空转。

> **执行时序（实测 0.16.0）**：客户端启动清单里本插件是第 43 条，`dsh-tauri` 是第 44 条、
> `dsh-tauri-ui` 是第 45 条，而能力位属性由第 19 条（`dsh-client-ui-conversation`）在模块
> 物化时就写好。因此本插件 apply 时属性已在，摘除发生在桌面插件注册之前——在**当前**桌面
> 版本上，第 1 条就足以让桌面功能整体不激活（官方 `WorkspacePicker` 与官方芯片原样保留），
> 第 2、3 条是对"桌面插件已先注册"这类时序变化的兜底。
> 副作用：启动日志里会出现一条桌面插件的 `「未分组」新建会话不可用：缺少桌面壳 composer 补丁`
> 警告（它自己在能力位为假时的提示），属预期。

**已知边界**：桌面芯片的菜单里仍会保留一条「未分组」项——hero 的
`conversation.hero.workspace` 是 single 槽，桌面插件先于本插件注册，插件层面无法撤销
它的注册（官方 `WorkspacePicker` 组件也未导出，无法由插件重新顶回）。点击该项现在
创建的是**本插件的临时会话**（见第 3 条），语义与「不选工作区」完全一致；若不希望
出现该入口，请用侧边栏通用「新建会话」，与 0.1.3 及以前的行为相同。

## 安装

方式一：

```bat
dsh plugin --profile web add dsh-temp-session
:: 或 GitHub 安装：
dsh plugin --profile web add github:DahliaVoid/dsh-temp-session
```

`dsh plugin add` 会把包写入 `~/.dsh/profiles/web/package.json` 的依赖与 `dsh.profile.bundles`，无需手改。

方式二（本机开发安装，用 `link:` 指向源码目录）：

```bat
dsh plugin --profile web add link:PATH_TO_DSH_TEMP_SESSION
```

> 注意：`dsh plugin` 内部经 cmd shell 拼接参数，**路径含空格时会被截断**（例如用户名含空格时）。
> 此时改为直接调 pnpm（在 `~/.dsh/profiles/web` 下执行）：
> `pnpm add "link:PATH_TO_DSH_TEMP_SESSION"`
> 然后再手动把 `dsh-temp-session` 追加进 `dsh.profile.bundles`。

方式三（手动）：编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-temp-session": "^0.1.0"          // 已发布：用版本；未发布：用 link: 指向本地源码目录
  },
  "dsh": {
    "profile": {
      "bundles": [ /* 追加 */ "dsh-temp-session" ]
    }
  }
}
```

随后在 profile 目录（`~/.dsh/profiles/web`）执行 `pnpm install`（或直接由 desktop 的插件面板管理）。

**生效方式**：修改 profile 后需**重启 Harness 进程**（桌面版：退出并重新打开 App；内置 Web 界面会随内核重启加载新 bundle 行）。

## 目录约定

| 项目 | 值 |
|---|---|
| 临时会话根目录 | `~/.dsh/tmp-sessions/`（行配置 `tempRoot` 可改） |
| 单个会话目录 | `<tempRoot>/session-<uuid>` |
| 临时会话日志 | 仍写入 `~/.dsh/sessions/`（与普通会话一致） |
| 桌面客户端的历史「未分组」目录 | `~/.dsh/ungrouped`（本插件屏蔽该功能后不再产生新会话，其 Workspace 记录会被注销） |

## 行为细节与已知边界

- **沙盒**：临时会话的 `workspace-write` 写边界 = 该会话自己的临时目录（会话创建后 `header.cwd` 即为此目录，`dsh-sandbox-policy` 据此解析）。dsh 沙盒对**读取**不设限（设计如此），因此"不读取 dsh 主目录"由 cwd/上下文提示软性引导实现；如需硬性读隔离，需要上游扩展新的沙盒模式。
- **重启物化**：workspace 注册表会按会话 cwd 把目录物化为一条 Workspace 记录；本插件在每次启动时自动注销 `tmp-sessions/` 下目录的这类记录，使临时会话始终以 Ungrouped 出现（会话与日志不受影响）；同时注销桌面客户端「未分组」功能在 `~/.dsh/ungrouped` 留下的同类记录。
- **空白临时会话**：未发送任何消息的临时会话不产生日志，重启后自然消失（符合"临时"语义）。
- **自动预建**：启动期仅当"无当前会话、无最近工作区可自动连接"时才自动预建临时空白会话；有工作区时仍保留上游"自动恢复最近会话"的行为，通过 × 到达未选定状态。运行期中（删除/归档当前会话导致 `current` 归零）则始终自动补建——上游的初始选择是一次性启动策略，此后不会再行动，不补位的话 hero 输入框会因"无当前会话"被内核判为 inert（显示"选择一个工作区开始"且无法输入）。
- **内核适配（0.1.2-rc.x）**：`workspaces` 快照改为 `{ items, archivedSessionIds, state, phase, error }`（0.1.1-rc.x 的 `baselinesReady`/`recentWorkspaceId` 已移除），"新建会话"无参入口也从 `workspaces.startSession` 迁至 `uiWorkspace.startSession`。0.1.2 起插件：
  - `autoEnsure` 就绪守卫改用 `phase === "ready"`，最近工作区按上游同款算法（`items` + 会话列表 `byId` 的 `updatedAt` 最大值）实时复算；
  - 拦截 `uiWorkspace.startSession()` 的无参调用（工作区行的 + 与显式选工作区仍走原路径），旧 `workspaces.startSession` 补丁保留以兼容早期内核；
  - reconcile 在"已选定工作区"分支把芯片标签断言回工作区标题——修复清空全部工作区后首次创建会话时标签残留下"选择工作区（可选）"的问题（该时序下 reconcile 可能先于工作区归属的快照事件写入可选文案，而 React 对标签节点不再重渲染，只能由插件自身修回）。
- **临时会话身份校验（0.1.3）**：桌面外壳 / 第三方插件也可能创建"空白 + 无工作区"的会话
  （例如按项目目录预建的空会话，cwd 是真实项目目录）。0.1.3 起复用/识别临时会话时增加
  硬校验：**cwd 末段必须等于会话 id 且 id 形如 `session-<uuid>`**（本插件创建的临时会话
  永远是 `<tempRoot>/session-<uuid>`），不再把外来空白会话误当临时会话复用
  （此前会表现为"临时对话跑进了 `~/.dsh/profiles/web` 等外部目录"）。
- **遗留空白会话**：从工作区 × 切换后，原空白会话会被保留（隐藏但可复用，之后再次选择该工作区时会被复用），不会重复堆积。
- **桌面屏蔽（0.1.4）**：判定与改道逻辑详见上方「屏蔽桌面客户端的『未分组』新建会话」；
  纯净 dsh 下这些代码全部空转，`sessions.create` 只在桌面特征出现后才被包装，并在插件卸载时还原。
  回归测试见 `test/client-behaviour.test.mjs`（`npm test`）。

## 卸载

```bat
dsh plugin --profile web remove dsh-temp-session
```

或从 `~/.dsh/profiles/web/package.json` 删除依赖与 bundles 条目，然后重启 Harness。
