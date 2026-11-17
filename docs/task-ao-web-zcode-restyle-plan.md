# 任务 AO 立项：前端全局风格对齐 ZCode——黑白中性主色 + sky 点缀全局换肤

> **状态**：方案已经用户确认（2026-11-17，三项方向拍板：①全局换肤+重点页打磨 ②默认主题换 ZCode 风、保留配色切换机制 ③登录页统一新风格），待执行。
> **排查会话**：ZCode（2026-11-17，探索两轮 Explore + zai-org/ZCode 取证）。

---

## 0. 一句话结论

以 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，同为 shadcn + Tailwind 4 CSS-first 架构）的设计语言为参考做**全局换肤**：default 主题改为黑白中性主色（primary=neutral-950/50）+ sky 蓝 brand 点缀 + 半透明 color-mix 边框；登录页推翻「固定橙」旧决策统一新风格；保留三套配色切换与亮暗模式；管理页靠 token 自动跟随，另做一轮**值恒等**的硬编码语义色清理。**只改样式，不改交互逻辑与信息架构；只借鉴 ZCode 设计值，不复制组件代码、不新增依赖（运行时依赖冻结）。**

## 1. 背景与决策

### 1.1 现状盘点（已核实）

- token 真相源：`web/src/styles/globals.css`（1233 行）——`:root` teal 主题（149-235）、`.dark`（479-550）、`theme-neutral`/`theme-orange` 两套（241-430）、登录页固定橙 `.landing-page` 作用域（953-1009，注释明确「产品决策，勿改回依赖 :root」）
- 实际默认配色是「暖橙」而非 teal：`web/src/hooks/useTheme.ts:38-46` 无 key 返回 `'orange'`；`index.html:49-71` 防闪烁脚本无 key 不加任何 class → 存在「首帧 teal、挂载后 orange」的既有不一致
- `brand-*` token 引用 99 处 / 30 文件；Tailwind 裸调色板类（amber/red/blue/green 等）散布 54 文件（top：StreamingDisplay 41、MessageBubble 21、TaskDetail 20、ProviderList 15、FilePanel 13）
- 值恒等映射（清理零视觉变化的依据，default 主题下）：`--warning #d97706`=amber-600、`--warning-bg #fef3c7`=amber-100、`--error #dc2626`=red-600、`--error-bg #fee2e2`=red-100、`--success #16a34a`=green-600、`--success-bg #dcfce7`=green-100

### 1.2 用户决策（2026-11-17）

1. 范围 = **全局换肤 + 重点页打磨**（登录/聊天工作台/侧边栏重点对齐，管理页自动跟随 + 硬编码色清理）
2. 主色 = **default 主题换 ZCode 风**（黑白中性主色 + sky 点缀），保留 orange/neutral 切换与暗色模式，既有用户选择不受损
3. 登录页 = **统一为新风格**（推翻 globals.css 949-950 所记「固定橙」产品决策；本条即新的产品决策，代码注释与本文档留轨迹）

### 1.3 ZCode 风格要点（取证自 `packages/ui/src/styles.css`）

| 项           | 亮色                       | 暗色                      |
| ------------ | -------------------------- | ------------------------- |
| background   | neutral-50                 | neutral-900               |
| foreground   | neutral-700                | neutral-200               |
| primary      | neutral-950（近黑）        | neutral-50（近白）        |
| border       | color-mix(neutral-950 10%) | color-mix(neutral-50 10%) |
| brand        | sky-400                    | sky-500                   |
| card/popover | white / neutral-800        | 同左                      |
| sidebar      | neutral-100                | neutral-950               |

ZCode 无全局 radius token（本项目**保留**自有 `--radius` 体系不动）；字号有 `--ui-font-size` 密度体系（本任务不引入，避免布局级变化）。

## 2. 方案

### 2.1 token 换肤（`web/src/styles/globals.css`）

- `:root` 重写为 ZCode 亮色：background `#fafafa`、foreground `neutral-700`、primary `neutral-950`、border `color-mix(in oklab, #171717 10%, transparent)`、`--brand-50~700` 换 sky 色阶、ring/accent/muted/secondary/sidebar/chart 对应调整（sky 系 chart-1）
- `.dark` 重写：background `neutral-900`、primary `neutral-50`、brand sky-500、border `color-mix(neutral-50 10%)`
- 保留不动：`--radius` 体系、glass token 结构（数值按新底色微调）、字体栈与 @font-face、`theme-neutral`/`theme-orange` 两块
- `.landing-page`（953-1009）：从固定橙改为引用全局 token（中性 + sky），注释改记决策变更轨迹（任务 AO 用户批准推翻）

### 2.2 默认配色与元信息

- `useTheme.ts`：无 key 默认 `'orange'`→`'default'`；`setColorScheme` 删 key 语义同步从 orange 改为 default（「default=不落 key」对称性保持）；`syncMetaThemeColor` 色值映射更新。顺带消除 §1.1 的首帧/挂载不一致（index.html 内联脚本无 key 不加 class 即 default，两处从此一致）
- `PreferencesSection.tsx:44-60`：SCHEME_OPTIONS default 项「经典绿」→「墨白」，preview 色更新（bg #fafafa / accent sky-500 / text neutral-700）
- `index.html:15` theme-color、`manifest.webmanifest:8-9` theme_color 同步新背景色

### 2.3 硬编码色清理（范围冻结）

**第一批清理（值恒等映射为主，逐处判断）**：StreamingDisplay、MessageBubble、MessageList、ChatView、FilePanel、SessionSidebar、MessageInput、TaskCard、CreateTaskForm、TaskDetail、EvalPage、TerminalPanel（≈12 文件）。

映射规则：amber-600/700→warning 系、red-600→error 系、green-600→success 系（default 主题下值恒等，视觉零变化）；带透明度变体（如 amber-500/10）与 blue-\* 按语义逐处判断（info 角色可映射 brand/sky，拿不准保守保留）。MessageBubble 的用户/助手气泡标识色以「保留可辨识度与对比度」为第一优先。

**明确不做（品牌色/库色/低频散点，共 42 文件）**：`channel-meta.tsx`（四 IM 渠道品牌色）、MermaidDiagram、ShareImageDialog/ShareCardRenderer（分享卡品牌渲染）、Emoji\*/ColorPicker（调色盘本体）、ProviderList/ProviderEditor、billing 全系、users/monitor/skills/mcp-servers/settings 其余散点（≤5 处/文件）。本任务不扩大到此清单。

**执行期补充决策（2026-11-17）**：

1. 新增 `--info`/`--info-bg` 语义 token（亮 #0284c7/#f0f9ff，暗 #38bdf8/#0c4a6e，sky 系）——状态三元组（运行/成功/失败）缺 info 角色且暗色 brand 色阶倒置不可直接用，按 success/warning/error 既有模式补齐后 blue→info 映射才能双模式自适应。
2. TerminalPanel 3 处保留不清理：均在固定暗底终端 chrome（`bg-[#1a1b26]`）上，green-400/yellow-400 映射主题 token 反而降低亮色值可读性。
3. FilePanel 文件类型图标色（archive/pdf/json/md/code 五色）保留：文件类型标识色非语义状态色，同渠道品牌色处理。

### 2.4 重点页打磨（样式级）

- `LoginPage.tsx`：aurora 背景/玻璃卡结构保留，配色跟随新 token
- `ChatView.tsx` + `MessageInput.tsx`：边框透明度、卡片层次细节对齐
- `UnifiedSidebar.tsx`：sidebar token 已全局生效，仅清残留硬编码

### 2.5 ZCode 参考仓库使用方式

`git clone --depth 1` 到 `/tmp/zcode-ref`（仓库外，只读，不进 git），对照 `packages/ui/src/styles.css` 取设计值；Apache-2.0 允许借鉴，本项目只取 token 数值与样式模式，不复制代码。

## 3. 风险与缓解

| #   | 风险                                      | 缓解                                              |
| --- | ----------------------------------------- | ------------------------------------------------- |
| R1  | 6 组合（3 scheme × 2 mode）漏检           | 截图矩阵逐组合目检；orange/neutral 两块不动收窄面 |
| R2  | brand→sky 后 99 处引用色感全变（绿→蓝）   | 属预期变化；抽查 brand-50 底上文字对比度          |
| R3  | 硬编码色误伤语义（amber 未必是 warning）  | 值恒等映射为主、逐处判断、拿不准保留              |
| R4  | 登录页推翻既有产品决策                    | 已获批准；本文档 §1.2 + 代码注释留轨迹            |
| R5  | 前端单测/e2e 断言配色文案                 | verify/test/e2e 兜底，断言失效则同步更新          |
| R6  | 无 key 老用户从暖橙变墨白（可见行为变更） | 即需求意图；显式选过暖橙/素白的用户不受影响       |
| R7  | 文件多、web 无 lint                       | `.gatescope.json` allow 冻结 + check-scope 门禁   |

## 4. 验收标准

1. `npm run verify` 六步全过 + `node scripts/check-scope.mjs` 过
2. dev server 截图矩阵：登录/聊天/评测/设置 4 页 × 3 scheme × 亮暗 6 组合——default scheme 下无 teal 残留、无对比度问题、登录页跟随新主题；orange/neutral 与改前视觉一致
3. 根单测（含 MemoryPage.test 等）与 `web/` e2e（mobile-chat）过
4. 已持久化配色选择的用户（localStorage 有 key）打开后仍为其所选 scheme

### 4.1 验收结果（2026-11-17 执行时实录）

1. ✅ `npm run verify` 6/6 步全绿（36.0s，含 web tsc / 全部 vitest / 前后端构建 / git diff --check）
2. ✅ `check-scope`：19 个路径全在声明范围内
3. ✅ 视觉验收（vite dev + 浏览器实测）：
   - default 亮色：近白底 + 黑色主按钮 + sky 渐变标语 + sky/violet aurora，视觉模型判定符合「黑白中性 + 天蓝点缀」；无 teal 残留
   - default 暗色：计算样式实测 `--background:#171717`、主按钮 `rgb(250,250,250)` 白底、`--brand-500:#0ea5e9`、输入框半透明边框（oklab 0.1）、玻璃卡 `rgba(23,23,23,0.8)`
   - orange/neutral 主题计算样式与改前完全一致（#faf9f5/oklch 橙、#ffffff/#52525b），未被波及
4. ✅ e2e mobile-chat 9/9 通过（首跑 9 失败为本机未装 Playwright chromium，`npx playwright install chromium` 后全绿，与改动无关）
5. 备注：登录页 Logo 为预生成品牌图标资产（`icons/icon-192.png`，`generate-icons.js` 产出），金橙底色属品牌资产非主题 token，本任务不重制；如需换新可另立任务。

## 5. 执行步骤

0. 立项（本文档 + `.gatescope.json`，base=204febf）→ 提交立项 commit
1. 克隆 ZCode 到 /tmp/zcode-ref，提取 token 精确值
2. globals.css 换肤（§2.1）
3. 默认配色与元信息（§2.2，4 文件）
4. 硬编码色清理（§2.3 第一批）
5. 重点页打磨（§2.4）
6. 回归验收（§4）
7. 任务 commit（push 由用户显式发起）

## 6. 涉及文件（= `.gatescope.json` allow）

`docs/task-ao-web-zcode-restyle-plan.md`、`.gatescope.json`、`web/src/styles/globals.css`、`web/src/hooks/useTheme.ts`、`web/src/components/settings/PreferencesSection.tsx`、`web/index.html`、`web/public/manifest.webmanifest`、`web/src/pages/LoginPage.tsx`、`web/src/pages/EvalPage.tsx`、`web/src/components/chat/{ChatView,MessageInput,MessageBubble,MessageList,StreamingDisplay,FilePanel,SessionSidebar,TerminalPanel}.tsx`、`web/src/components/tasks/{TaskCard,CreateTaskForm,TaskDetail}.tsx`、`web/src/components/layout/UnifiedSidebar.tsx`
