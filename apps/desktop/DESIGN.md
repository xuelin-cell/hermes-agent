# Desktop Design System

Conventions for the Electron desktop app (`apps/desktop`). Read this before
adding a component, overlay, or style. The rule of thumb: **one source per
concern, tokens over literals, flat over boxed.** If you reach for a raw color,
a one-off shadow, a bespoke button, or a hardcoded `px-*` on a control — stop,
there's already a primitive for it.

This file owns the visual and interaction contract. Read
[`AGENTS.md`](./AGENTS.md) for architecture, state, resolver, transport, and
testing rules.

This doc contains two kinds of content, maintained differently:

- **Principles** (flatness, intent, feedback, motion, cancellation) are durable.
  They hold as components come and go.
- **Named contracts** (tokens, `Button` variants, primitive names) are the
  design system's current API. They are maintained *with* the code: if you
  change a primitive, token, or variant, update its entry here **in the same
  change** — a stale name in this file is a bug, exactly like a stale type.

When a rule and the code disagree, fix whichever is wrong rather than forking a
one-off at the call site.

## 元景数字员工默认视觉

设计来源：[MasterGo 24:09019](https://mastergo.com/file/204500798093134?layer_id=24%3A09019)。
仅调整现有功能的视觉，不新增设计稿中的功能。`themes/uniwork.ts` 定义明暗配色，
`themes/uniwork.css` 定义共享几何、字体层级和界面状态。默认主题为 `uniwork`；
旧默认 Nous 的本机选择只迁移一次，其他主题、字体偏好和明暗设置保留。

- 明亮模式：白色主界面，浅灰侧栏，橙黄 `#F5765A` 强调，正文 `#101219`，
  次级文字 `#32374A` / `#686F82`，边框 `#E6E9ED`。实心按钮使用略深的朱红保证小字号白字对比度；暗色模式沿用同一朱红色系。
- 正文及常规控件 14px / 22px，辅助文字 12px / 20px，欢迎标题最高 36px。
  正文优先设计稿的 DFPKingGothicGB / PingFang SC，标题优先 Alimama ShuHeiTi；
  字体未安装时回退到微软雅黑等系统中文字体。没有捆绑未授权的商业字体。
  代码继续使用内置 JetBrains Mono，用户配置字体仍然有效。
- 常规输入框和按钮使用 `--control-radius`（8px）、`--control-font-size`、
  `--control-line-height`；紧凑辅助变体保留尺寸覆盖。输入区域框内对标 Claude：圆角 20px，
  细中性边框加很淡的阴影，悬停 / 聚焦只加深边框、不用强调色描边；模型名和思考强度读成一个按钮（各自菜单不变）；
  发送按钮为 32px 圆形，空输入时灰底白箭头。
  分类标签为 32px 高胶囊，已选分类放在编辑区内，使用带 12px 左内边距及文字/关闭按钮间隔的圆角胶囊；选分类后同一推荐行切换为模板按钮，底部工具栏独立成行；浮层保持统一边框和阴影，不给各页面另造样式。
- 设置、技能、连接器、历史、聊天和浮层共用语义令牌；主题外的品牌色不可散落到页面。
  保留现有导航、快捷键、开发者模式边界和后台行为。
- 欢迎标题为“元景数字员工，助你高效完成任务”，下方居中显示远端 modules 的名称和顺序。
  不读取任何层级的 enabled，也不根据模块 id 或名称路由；使用云端 workspace 字段，`codex` 使用高级界面，`work` 或未提供时使用简洁界面。
  一级模块、分类和模板的图标统一读取各自的 `icon` 字段（Lucide 名称，如 `presentation`、`file-text`），不按标签 ID、名称或工作区补图标。未提供、不支持或加载失败时只显示文字。标签 ID 仅用于渲染和临时选中状态，不作为本地业务映射表。
  当前项目共用同一 agent/chat 核心，不引入 hexagent 的 Codex app-server；简洁/高级模式负责现有侧栏和开发面板。
  代码工作区使用现有项目树，多个项目及其会话在同一侧栏内展开；项目行显示数量和新建按钮，点击只折叠/展开，不进入单项目视图。置顶会话仍保留在所属项目，对话只显示单行标题；办公/学习工作区使用原有会话视图。
  这层展示覆盖不改写持久化的侧栏分组偏好，筛选菜单只提供当前工作区支持的分组选项。
  优先保留显式选中的模块，再按当前执行模式匹配，最后取首个模块。
  分类条为 524×40px、36px 圆角、4px 内边距、12px 间距；窄屏横向滚动。
  首页外保留导航入口；工作区页面点击标签返回聊天面板，不重建会话或修改系统提示。
  下方分类与模板只读取所选模块，缺少内容时不借用其他模块；切换模块清除分类选择但保留草稿。
  分类选择会清空草稿，模板点击填入 prompt 并聚焦输入框，移除 chip 返回分类行并保留草稿。
  欢迎目录 IPC 返回原始 modules 与 version，不保存前端派生字段；旧分类数组不得提升为一级模块。
  配置仅来自 `/app/gateway/uniwork/system-config?key=welcome_config_v3_{locale}`，不使用内置 JSON 默认目录：必须携带当前有效登录用户的 Token；无身份或过期时不发送匿名请求，保留上次成功获取的云端缓存，响应返回后再核对身份。首次启动或缓存损坏时不显示默认标签；请求失败且没有缓存时提供刷新入口。
  标准解析外层 JSON 和 configValue 字符串；空模块、无效响应及请求失败保留旧配置，比较实际模块内容，版本号相同但 prompt 等内容更新时也刷新缓存。
  缓存键为 `uniwork.welcome.modules.v3.{locale}`。当前语言 modules 为 null/undefined 时回退另一语言，显式空数组不回退。

## Principles

`desktop-mt` 连接器页按 HexAgent 参考界面使用「推荐 / MCP」双标签。推荐目录为最多三列的圆角卡片，窄容器切换为两列或一列；图标、名称、介绍和供应商保持一致层级，背景、文字与选中标记仍使用当前主题语义令牌。详情沿用原生 Dialog。授权未接入的推荐项只展示详情和明确说明，不收集凭据或显示虚构的连接状态。MCP 标签保留原生管理与 Profile 范围，切换标签保留编辑草稿。

1. **Flat, not boxed.** No card-in-card, no divider borders inside a panel.
   Group with whitespace and a single hairline, never nested rounded boxes.
2. **Borderless elevation for floating panels.** Overlays float on
   `shadow-nous` + a `--stroke-nous` hairline, not thick framed boxes. In-panel
   structure may use token hairlines sparingly.
3. **One primitive per concern.** One `Button`, one set of control variants,
   one `SearchField`, one `Loader`, one `ErrorState`. Migrate onto them; don't
   fork.
4. **Tokens, not literals.** Reference CSS vars (`--ui-*`, `--shadow-nous`,
   `--theme-*`), never raw hex / ad-hoc rgba in components.
5. **Style lives in the primitive.** Variants and sizes own padding, radius,
   color, chrome. Call sites pass a `variant`/`size`, not `className` overrides
   that re-specify those.
6. **Intent before automation.** Surface useful actions and previews, but do not
   open panes, move focus, or navigate because a tool happened to produce
   something.
7. **Immediate feedback.** Direct manipulation updates the view first. Network
   or disk persistence reconciles afterward and rolls back visibly on failure.

## Information architecture

- **Chat is the home surface.** The transcript and composer stay primary; tools,
  previews, files, review, and terminal complement the conversation.
- **Pages are durable destinations.** Chat, Skills, Messaging, and Artifacts
  remain in shell chrome. Do not hide a distinct product noun inside an
  unrelated page.
- **Route overlays are short tasks.** Settings, Command Center, Cron, Profiles,
  Agents, and Starmap render as `OverlayView` cards and return to the previous
  route on close. Model/session pickers and dialogs layer above the current
  surface; they are not navigation stacks.
- **Panes are working context.** Preview, files, review, and terminal remain
  attached to the current task. Their state survives temporary hiding and chat
  switches where the underlying tool is meant to persist.
- **One action, one home.** A command may have keyboard, palette, and visible
  affordances, but they invoke the same action and state. Do not fork behavior
  per entry point.
- **Projects own workspace cwd.** Use Sidebar → Projects for local folders and
  worktrees; do not reintroduce a per-session/right-sidebar folder-picker flow.

Profile icons and condensed profile rows offer **Open in new window** and
**Set as default** in their existing context menus. Opening a profile creates a
full peer window without switching the source window. The desktop default
applies at startup and to generic new chats; explicit profile/project actions
and profile-specific windows keep their own destinations. Changing the default
does not move existing sessions or replace the active conversation.
Ordinary **New Window** (`⌘⇧N` / `Ctrl+Shift+N`) inherits its opener's device and
profile only at startup, not as a window-specific default. Later device/profile
selections remain authoritative for new chats unless a desktop default is set.

Navigation must preserve context. A background session finishing, a tool result
arriving, or a project refresh may update badges and cached data; it must not
replace the foreground transcript or steal focus.

## Surfaces & elevation

Floating panels (base `Dialog`, route overlays, boot/install/update surfaces,
model-picker, onboarding, prompt overlays, notifications) use:

```
shadow-nous           /* downward-weighted, layered contact→ambient falloff */
border-(--stroke-nous) /* currentColor hairline, theme-adaptive */
```

Both are CSS vars in `src/styles.css` — tune in one place, everything inherits.
Don't add per-overlay `shadow-[…]` or `border-(--ui-stroke-secondary)`
one-offs; if elevation needs to change, change the token.

Menus and popovers use their own shared `shadow-md` +
`--ui-stroke-secondary` primitive treatment. Every floating list —
`DropdownMenu`, `Select`, and Popover + cmdk pickers
(`<PopoverContent variant="menu">` + `<Command variant="menu">`) — paints
through `src/components/ui/menu.ts`, so a list reads the same wherever it
opens. Typed fields with suggestions use `ComboboxInput`, never
`<input list>` + `<datalist>` (Chromium paints that as its own OS popup).

Drag affordances may use tokenized
dashed targets and local blur. These are semantic surface classes, not licenses
for call-site shadow or border inventions.

**Queued cards:** `CardStack` (`src/components/ui/card-stack.tsx`) consumes a live,
keyed list, retaining the current item when more arrive. Inline and floating
approvals and both toast placements share its gesture handling and geometry.
The Cursor-reference treatment uses one 96%-scale silhouette 7px above the
front, 220ms promotion, and 180ms upward clearance; no rotation or lateral throw
on button/keyboard decisions. Consumers supply the existing surface tokens and
own the exact-request response. Gestures never grant approval. Departing cards
are immediately inert; toasts can expand to the full live list. One persistent
transcript-level host owns approvals, independent of tool rows and assistant
message boundaries. Prepared approvals can precede tool.start: execution must
not relocate or remount the stack. While approvals remain, a real activity line
above the cards changes from awaiting approval to current-turn command status;
represented execution rows appear only when explicitly expanded. Empty text
continuations must not introduce paragraph gaps. Keep inline approvals beside
the conversation and let genuine content scroll normally; do not inject padding
or write scroll offsets to pin the decision. Preview this order with delayed
start and completion events, not pre-created tool rows. Final approval removal
retires both the painted card and its measured layout footprint; restoring tool
rows must not insert their full height before the outgoing stack can settle.
No completion callback may clear the measurement of a newly arrived card.
Reduced motion settles immediately without retaining empty clearance.

## Window background behavior

Settings → Appearance → Window layout offers **Minimize to tray**, off by default and
scoped to the current account on this device. When enabled, minimizing ordinary
windows or closing the main window hides them without stopping their work.
The tray's **Show Hermes** restores hidden windows. **Quit Hermes** and ordinary
main-window close (when tray mode is off) use the same unconditional confirmation
and verified account shutdown as app quit. App quit preserves the login record;
account sign-out clears it and relaunches to sign-in. Both retain account files.
On macOS the tray lives in the menu bar; the Dock icon hides only when no normal
window remains visible and returns on restore. If the tray is unavailable,
ordinary minimize/close behavior is retained rather than hiding an unreachable app.

## Window glass

Glass defaults to **29% Tint, Sidebar only** in both light and dark appearances.
Fade defaults to zero so the content column and text stay opaque. Native frost
keeps its platform/appearance defaults. Explicitly saved settings take precedence;
changing defaults must not overwrite a user's existing choices. The shared
`apps/shared/src/translucency.ts` resolver owns these defaults for both the
renderer and Electron's first window paint.

## Stroke & color tokens

| Token | Use |
| --- | --- |
| `--ui-stroke-primary…quaternary` | hairlines, in descending strength |
| `--ui-stroke-tertiary` | the default in-panel divider / list hairline — and every bordered surface in the transcript |
| `--stroke-nous` | the overlay hairline (pairs with `shadow-nous`) |
| `--ui-text-primary / -secondary / -tertiary` | text hierarchy |
| `--ui-bg-quaternary` | soft control fill (secondary button) |
| `--ui-widget-surface-background` | fill for inline chat widgets (`WIDGET_SHELL_CLASS`) |
| `--chrome-action-hover` | hover fill for quiet controls |
| `--theme-primary`, `--ui-accent` | brand/accent |
| `--dt-primary-deep` | deepest accent fill (UniWork design maroon `#430D0D` / dark `#693127`); other themes fall back to `--dt-primary-solid` |

Never hardcode `border-gray-*`, `bg-white`, `text-black`, etc. The two tiles in
`BrandMark` (white in light mode, `#0d1117` in dark) are the sanctioned literals
(the mark needs a fixed backdrop).

## Buttons — one component

`src/components/ui/button.tsx` is the single source. Pick a `variant` + `size`;
do **not** pass `h-*`, `px-*`, `py-*`, or icon-size overrides.

**Variants:** `default` (primary), `destructive`, `secondary` (soft fill —
the default non-primary look), `outline` (transparent + 1px inset ring, no
fill/shadow), `ghost`, `floating` (a control loose from any surface — opaque
popover fill + `shadow-md`, hover lifts the glyph only), `link`, `text`
(boxless quiet inline — "Cancel", "Clear"), `textStrong` (bold underlined
inline affordance — "Change", "Open logs").
`grip` is the quiet, fill-free drawer handle; pair it with size `grip` for a
48×16 hit area around a small horizontal ridge.

**Sizes:** `default`, `xs`, `sm`, `lg`, `inline` (flush, zero box — for buttons
that sit inside a heading/sentence; replaces `h-auto px-0 py-0`), `micro`
(status-stack/table-footers), `compact` (12px text, 16px line height, 6px horizontal
and 2px vertical padding for small actions with a hover background), and the icon family `icon` / `icon-xs` /
`icon-sm` / `icon-lg` / `icon-titlebar`.

**Tooltips only when hover teaches something new.** `<Tip>` is for discovery,
not a tax on every icon. Ask: does hover reveal something the user cannot
already see or infer? If not, skip the tip; keep an `aria-label` for a11y.

Tip unlabeled chrome when the job (or a keybind / truncated path / host /
other detail) is not already on screen — toolbar / titlebar / statusbar icons,
`TipKeybindLabel` shortcuts, ownership chips, unlabeled icon grids.

Do **not** tip:

- Menu triggers (kebabs / ⋯ / `ActionsMenu` / `DropdownMenuTrigger`) — the
  affordance is "open menu"; verbs live in the menu. Never tip
  `"Actions for ${row title}"` / `"Project actions"` / `"Actions"`.
- Close / dismiss X buttons — the glyph is the label (`aria-label` only).
- Controls whose visible label already says what the tip would ("click to…",
  paraphrases of the same words, timer labels restating "Running").

Never use native HTML `title=` on buttons — unstyled, ~500ms OS delay, clashes
with the themed `Tip`. `src/components/ui/__tests__/no-native-title.test.ts`
fails on any `<button>` / `<Button>` that still carries `title=`.

**Tooltip timing.** A hover is not a click — the cursor crosses triggers on
the way somewhere else. `Tip` waits 200ms before the first open so a sweep
does not flash a trail. After a tip has opened the page is warm: the next
trigger within 300ms opens instantly. The cooldown starts on close, so a
hover a second later waits again. Once triggered, entrance has no animation.
Exit fades over 100ms and moves 0.125rem toward the anchor; reduced motion
disables the exit animation. `OverflowTip` stays on its own longer delay
(list titles must not trail while scanning). Bubbles use a 0.25rem radius.

**Tooltip placement.** Choose intent through `placement`: `control` above (default), `toolbar` below, `row` to the right, and `left-rail` / `right-rail` inward. Explicit `side` and `align` override the preference. Radix flips and shifts for collisions, keeps the arrow attached, and hides detached triggers. Controls and toolbars use their owning pane as a boundary; row descriptions and rails may extend into the window. Use `boundary="viewport"` for an intentional escape. Short labels size to content; descriptions wrap within 24rem and the available space, in one rounded bubble.

**Slash descriptions.** Keep autocomplete rows single-line and ellipsized, but reveal the complete catalog description to the right of the hovered row. Use the shared bounded tooltip, collision padding, and word wrapping; it must not intercept row selection. Catalog and completion producers preserve the full author-supplied description.

**Model search.** Model filters and their highlighted labels treat hyphens, dots, underscores and spaces equivalently. Preserve original label spelling inside marks. The shared highlighter remains literal for other surfaces such as the command palette; model callers explicitly opt in. Model identifier search does not use dictionary spellcheck.

**Keybind hints in tooltips.** On a tipped button bound to a rebindable hotkey,
use `<TipKeybindLabel actionId="..." />` — it reads the i18n label and the
current combo from `$bindings`. Pass `text={...}` only when the label is
context-dependent (e.g. "Show" / "Hide"). Never hardcode combos; always use
`useKeybindHint` or `TipKeybindLabel`.

Notes:
- Text buttons use theme control radius, type size and line height; padding determines
  height. Compact/icon variants keep their explicit dimensions.
- SVGs inherit `size-3.5` (`size-3` at `xs`). Don't re-set icon size.
- Polymorph with `asChild` when the button must render as a link/Slot.

## Badges — one component

`src/components/ui/badge.tsx`. Variants: `default` (tinted primary), `muted`,
`warn`, `destructive`, `outline`, `solid` (primary fill — icon-corner counts).
Sizes: `default`, `xs`, `overlay` (titlebar glyph counts).

Badges are inert. A metadata chip that does something (filter by category or
tag, search a platform or tool) is a `Button` `size="xs"`: `chip` for facet
values (soft fill + a 0.5px inset shadow ring on hover, so no reflow), `ghost`
for quieter search values. Don't style a Badge to look clickable or add a
separate chip component.

## Reel

The profile rail keeps its create/import actions outside the scrolling squares.
Clipped horizontal edges reuse `edgeMask(edges, 'x')` from `fade-scroll.tsx`;
the default axis remains vertical for `FadeScroll`. Fitting content is unmasked,
and profile drag gestures temporarily remove the mask so the dragged square stays legible.

`src/components/ui/reel.tsx`: one horizontal, snap-scrolling row (catalog
category shelves, screenshot strips). Children keep their width and snap to
the start; set it once from the parent (`className="*:w-68"`). Use it instead of
hand-rolling `flex overflow-x-auto snap-x`.

## Context-sensitive dialogs

Sudo password dialogs keep the backdrop unblurred (`DialogContent`'s
`blurBackdrop={false}`) and show the complete, selectable command before the
password field. Long commands wrap and scroll; missing backend context is
explicit, never inferred from another tool row. Other dialogs retain the shared
blurred backdrop.

A dialog opened from inside another (an image lightbox over a catalog detail)
stacks above it automatically, so its backdrop dims the parent too. Media
viewers use a heavier scrim through `overlayClassName`. Controls that belong to
the dialog but mustn't scroll with its body (prev/next pagers) go in `chrome`,
which may sit past the dialog's edges.

## Form controls

- **`controlVariants`** (`src/components/ui/control.ts`) is the shared shape for
  `Input` / `Textarea` / `SelectTrigger`. New text-entry controls compose it.
- **`SearchField`** — borderless, underline-on-focus, auto-width. The only
  search input. Don't build boxed search bars; don't wrap it in a bordered tile.
  `variant="box"` is the one bordered form: a full-width rounded field for
  pages where search is the primary affordance (the Skills/Plugins catalogs).
  Empty lists hide their search field.
- **`SegmentedControl`** — the choice control for small mutually-exclusive sets
  (color mode, tool-call display, usage period). Replaces radio piles and
  pill rows. A two-state view switch (list/cards, list/tree) is not a segmented
  control: it's one ghost `icon-xs` `Button` showing the mode it switches to.
- **`Switch`** (`size="xs"`) — bare, with `aria-label`. No bordered text wrapper.
- **`FanMenu`** (`src/components/ui/fan-menu.tsx`) — one hub control that
  fans sibling toggles out on hover: `direction` `vertical` | `horizontal`
  (split around the hub) | `arc`. Discs are `Button` `floating` off /
  `default` on; tips face outside the fan according to its geometry. Use it where a row of rarely
  touched toggles is costing input width (the composer's voice controls).

## Layout

- **Gutters:** `PAGE_INSET_X` (`src/app/layout-constants.ts`) for page side
  padding; `PAGE_INSET_NEG_X` to bleed a child to the edge. Don't hardcode
  `px-6`/`px-8` on pages.
- **Master/detail overlays:** `OverlaySplitLayout` + `OverlaySidebar` /
  `OverlayMain`. Cron, profiles, etc. ride this — don't rebuild a titlebar
  shell.
- **Filter rails** reuse the same pieces: `SidebarPanelLabel` (its `meta` slot
  carries the result count), `SidebarDateDivider` group headings, and `nested`
  `OverlayNavItem` rows. Facets are multi-select: each row is `pressed`, with a
  `CheckboxMark` in `leading` (the row is the control; a real `Checkbox` would
  nest a button), and an "All" row clears the group. No radio glyphs. A text
  "Clear" sits on the label row while anything is filtered. Cap long facets
  (tags) to the top values plus the selection; search covers the tail.
- **Settings subpages:** `OverlayNav` keeps navigation and disclosure separate:
  labels navigate; the shared `DisclosureCaret` button opens a branch without
  changing the page. Active paths reveal automatically, inactive paths stay
  folded unless manually opened. General comes first wherever present; parent
  labels and parent URLs open the first ordered subpage, never an overview or
  the last visited child. Explicit child links retain their destination;
  every parent and child uses the same Settings breadcrumb, without a duplicate
  icon-and-title heading. Page-level `SectionHeading page` retains actions and
  counts under breadcrumb-owned chrome; embedded callers keep their headings.
  Narrow windows keep every destination available in the shared navigation dropdown.
  Search and saved field links resolve to the owning child before highlighting.
- **Rows:** `ListRow` (settings `primitives.tsx`) for label/description/action
  rows. Flat, flush-left; no per-row indentation that fights flush headers.
- **No dividers between rows** unless the list genuinely needs them; prefer
  spacing. When you do need one, it's a single `--ui-stroke-tertiary` hairline.

## Panel titlebars

Top-edge panels extend into the native titlebar band. Their tab strips remain
inside their own zones so tab drops, focus, and split boundaries use the same
geometry. Panels without room beside the measured window controls place their
tabs on a full-width row below the controls. Minimized row groups use vertical
restore rails, including groups with multiple tabs. Sidebar buttons and shortcuts
restore minimized or fully hidden side groups without changing the selected tab.
Lower panels keep local headers. Empty header space moves the window;
tabs and actions remain no-drag, with native-control space reserved from the
existing traffic-light and Window Controls Overlay measurements.

The left cluster shows sidebar, settings, layout editor, and HUD controls. Flip
and the right-sidebar toggle sit on the right; haptics remain in settings.
In Simple interface mode only sidebar, settings and the layout editor render,
and the reserved cluster width shrinks with them (`TITLEBAR_FIXED_TOOLS` is the
one table both the buttons and the width reservation read).
Holding Cmd (Ctrl off macOS) reveals small slot numbers over the target strip's
status dots after 400ms, without changing tab widths. Hints follow the same
binding and hovered/focused-zone resolver as the number shortcuts.

Tab close buttons fade the label with a content mask, not a painted gradient.
The tab reads its surface token directly so glass tint is painted only once.

Sticky user messages clip covered scrolling content, including the gap above
them. Their wrappers stay unpainted; only the rounded user bubble owns a fill.
Clipping follows the pinned prompt and its live height without changing layout,
so glass and message-bubble transparency do not reveal scrolling text.

## Feedback & empty/error/loading states

资料库的个人云盘通过受限主进程 IPC 使用当前桌面账号，凭据不进入 Renderer。目录支持分页读取、搜索、文件夹导航、新建、重命名、回收站、签名链接预览和下载。加载使用 PageLoader，失败提供重试，旧请求不覆盖新目录；新建与重命名使用共享 Dialog，删除使用 ConfirmDialog。缺少完整手机号的旧密文登录记录提示退出重登，不读取旧 Web 登录缓存。本地产物仍按原有会话与文件链路工作。

- **Loading:** `Loader` (`src/components/ui/loader.tsx`) — animated math/ascii
  curves (`lemniscate-bloom` for long ops). Never ship the literal text
  "Loading…".
- **Errors:** `ErrorState` + the canonical `ErrorIcon` (no bg chip). One look
  for the React boundary, in-dialog errors, and the boot-failure banner. Pass
  nodes for title/description so Radix `DialogTitle`/`Description` can flow
  through for a11y.
- **Logs:** `LogView` — no bg, hairline border, tight padding, small mono.
  Every place we surface raw logs uses it.
- **Empty:** `EmptyState` for plain page bodies; `PanelEmpty` for overlay
  master/detail empties with an icon and action. Don't hand-roll a third
  centered empty.
- **Confirmation:** `ConfirmDialog` is the only way we ask "are you sure". It
  opens focused on Confirm, so `Enter` confirms and `Esc` cancels, and it owns
  the pending → done → close beat and the inline error — a call site passes an
  async `onConfirm` and nothing else. A third way out (e.g. "Remove from
  sidebar" beside "Delete worktree") goes in the one `secondaryAction` slot.
  Never `window.confirm`: it's an unstyled blocking Chromium modal. A handler
  that wants the answer inline instead of a mounted dialog calls `confirm()`
  from `src/store/confirm.ts`, which renders this same primitive through the
  single `ConfirmHost` at the shell — the way `notify()` backs notifications.

## Artifact share lifetime

HTML/Markdown 产物分享弹窗默认 1 天，支持 1/3/7 天或自定义 1～7 天。
修改有效期独立于内容更新，从保存时重新计算；更新内容默认保留原期限。
会话内分享卡片与预览入口共用原生记录，并显示到期时间、到期状态和撤销入口。
历史无期限链接保留原状态，用户可主动设置。过期后重新发布生成新链接。
公司网关目前不接收期限，主进程启动补清理并每 5 分钟重试删除；删除失败时
保留记录，界面明确提示公网链接可能暂时仍可访问。应用关闭期间延迟至下次启动。

## Chat, tools & boot surfaces

- The transcript and composer are built on `@assistant-ui/react`. Extend the
  existing components under `src/components/assistant-ui` and
  `src/app/chat/composer`; do not fork a second markdown, message, tool-call, or
  approval renderer for one feature.
- **Inline widgets** — a tool result that renders as a panel the user reads or
  acts on (clarify, artifact card) wears `WIDGET_SHELL_CLASS`
  (`src/components/chat/widget-shell.ts`): shared radius, the
  `--ui-widget-surface-background` fill, no border. Its actions sit *outside*
  the panel, below it. Don't give one widget its own radius or fill.
- Bordered surfaces in the transcript (tables, fences, callouts, attachments)
  use `--ui-stroke-tertiary`. Not `border-border` — that's the app-wide
  default and reads too hot against the thread.
- Interactive directive chips in the composer expose their action on hover.
  The action stays visible for a 500ms grace period while the pointer crosses
  from the chip to the floating pill; leaving both dismisses it.
- A tool result may expose an inline action that opens a preview. It must not
  open the rail automatically.
- Tool rows reserve destructive red for explicit failures. Missing read paths and
  ambiguous exit-1 results use neutral notices, with details still available.
  Errors described inside returned data are not tool failures. Expanded failures
  show the actual explanation; supporting output keeps its normal text color.
- Nested transcript scrollers keep their height caps and hand vertical scrolling
  back to the thread at either edge (`overscroll-behavior-y: auto`), even when
  their content fits. Only the outer thread contains vertical overscroll;
  horizontal code/output boundaries may remain contained. Thinking previews
  follow new tokens only while near the bottom, preserving the user's reading
  position until they scroll back down.
- Composer status groups start collapsed except todos. Progress updates and queue
  pause/resume preserve the user's disclosure choice. Error banners meet the
  stack's top edge without a blank padding strip. File and preview links remain
  visible at the bottom of the stack, below the queue and all status groups.
  A centered ridge on the composer's top edge hides/reveals the entire stack,
  including the git row, with a short downward/upward drawer slide. Its choice
  persists per conversation and owner, not globally. Hidden sections stay
  mounted but inert so their disclosure choices survive; reduced motion is instant.
- Popping out a composer makes it the window's only visible composer. It keeps
  its viewport placement while hover or keyboard focus selects a chat pane;
  moving back into the editor retains that recipient. Drafts, attachments and
  queues stay session-owned. Docking restores the individual pane composers.
  In either placement, moving into a chat pane gives its editor typing focus
  immediately and preserves its caret. Layout-only hover events and delayed
  focus callbacks cannot replace that choice, and a live transcript selection
  is never cleared by focus-follow. Movement within the same pane
  must not flush React; deliberate Tab navigation and clicked controls still work.
  An inline message edit is a typing target of its own: opening one keeps focus
  in the edit editor, and neither its mount-time focus nor mouse movement while
  it is open hands the caret back to the pane composer.
  Active dictation or voice conversation pins the recipient until capture ends,
  keeping the microphone's stop controls and shortcut attached to its owner.
- Status-stack rows use `StatusRow` with a leading `dismiss` action, a state
  icon and optional trailing actions. `StatusDismissButton` owns the Codicon
  close button for previews, background tasks and queued prompts; do not swap
  it for a trash icon or a CSS glyph. Icons and controls align to the first text
  line, including messages with attachment metadata.
- `status-stack.css` owns the shared columns and `0.25rem` nesting step. Rows
  own their padding and full-width hover fill. `StatusControlRow` uses the same
  columns for goal/loop/heartbeat details; `StatusPendingIcon` supplies the
  dashed marker for tasks and criteria. The first row keeps its normal padding;
  the stack adds no extra top inset.
- Keep the rounded status card stationary, with the bounded scroll viewport
  inside it. The outer scroll boundary uses `overscroll-behavior-y: contain`;
  nested rosters and transcripts use `auto` so wheel input can hand off at an
  edge without trapping it or scrolling the chat behind the stack.
- Install, onboarding, connecting, boot failure, and reauthentication are
  distinct states with shared visual primitives. Preserve their recovery
  semantics when unifying appearance.
- Guide startup has a dedicated landing screen with the shared long-operation
  Loader and a localized startup label. It remains active until the guide's
  saved conversation is loaded. No greeting, composer, Skip setup, or statusbar
  appears early. Reduced motion uses a static BrandMark and the same label.
  On readiness, reveal the real conversation and fade controls in over 100ms.
  Never fabricate progress, delay readiness for motion, or replace a resumed
  conversation with a new greeting.
- Respect `AppShell` overlay ownership. Persistent terminal/content layers,
  route overlays, dialogs, and boot surfaces must not compete through ad-hoc
  z-index literals. Pick a rung of the ladder in `styles.css` instead —
  `--z-modal-backdrop` / `--z-modal` / `--z-modal-popover`, `--z-over-modal`
  (toasts, tooltips, command surfaces) and `--z-over-modal-content`,
  `--z-switcher-backdrop` / `--z-switcher`, then the boot chain
  `--z-connecting` → `--z-onboarding` → `--z-setup` → `--z-crash`. Plain
  `z-10`/`z-20` are still right for stacking *within* one component.

## Iconography & brand

- **Tabler** is the default component/chrome set. Import its curated aliases and
  `iconSize` scale from `src/lib/icons.ts`; do not import icon packages directly
  in feature code.
- **`Codicon`** is the compact editor/tool/status vocabulary. Use
  `src/components/ui/codicon.tsx`, including `codiconIcon()` where a
  Tabler-shaped component is required.
- Pick the vocabulary by semantic context and reuse the existing icon for an
  action. Do not introduce a third icon set or mix styles within one control
  group.
- **`BrandMark`** (`src/components/brand-mark.tsx`) is the brand glyph — the
  `nous-girl` mark on a fixed tile, theme-aware: black girl on white in light
  mode, white girl on the `#0d1117` dark tile in dark mode (keyed off
  `renderedMode` so bright surfaces in dark skins stay on the light mark).
  The marks are generated by `scripts/generate_icons.py` from the girl SVGs
  + squircle backgrounds (`assets/nous-girl-*.svg` × `assets/backgrounds/`).
  It replaced scattered Sparkles glyphs in updates / onboarding / about. Use it
  for hero/brand moments; don't reintroduce decorative star/sparkle icons.

## Motion

- Visible windows keep animating when another app takes focus. Hidden/minimized
  windows and inactive panes may pause; background polling stays focus-gated.
- Animated integer counts reuse `AnimatedInt` in `src/components/ui/diff-count.tsx`.
  Its spring updates the DOM directly without per-frame React renders.
- Quick, functional transitions (~100ms on controls). Respect
  `prefers-reduced-motion` for anything beyond a fade.
- Choreographed exits (e.g. onboarding's "matrix" fade-down) stagger per-element
  then settle the surface — the outer container's fade is *delayed* so it
  doesn't swallow the inner animation. Don't let a global fade race the detail.
- Motion follows state; it never delays state. Selection, drag targets, cancel,
  and pressed feedback paint in the current frame.
- Do not animate layout geometry with `transition-all` on a hot interaction.
  Name the properties, avoid backdrop-filter repaints during movement, and
  remove animation before masking a performance problem.

## Direct manipulation & performance

`Masonry` (`components/ui/masonry.tsx`) packs natural-height cards into responsive
lanes, using CSS `display: grid-lanes` where supported. Older Electron versions
use one ResizeObserver and frame-batched placement; child DOM/source order stays
intact through resizing, media loading, and disclosure. It owns the shared gap;
`--masonry-min-width` optionally changes the minimum lane width. It knows nothing
about what it holds: catalog results and discovery shelves opt into their hover
treatment (sibling dimming, the pointer-following glow) from the catalog's own CSS.

The app should feel instant under real load — long transcripts, several panes,
live streams. Design toward that:

- Direct manipulation paints first; persistence reconciles after and rolls back
  visibly on failure.
- Keep interaction feedback cheap: hot-path state stays local or narrowly
  derived, not wired into heavy trees; pointer work coalesces per frame.
- One drop region has one visual owner, and drop targets speak one affordance
  language across files, sessions, tabs, and panes. Overlapping targets resolve
  to the active one instead of stacking overlays.
- Forgiving geometry beats pixel-perfect triggers; edge actions live near their
  edge, not clustered in the center.
- Expensive stateful surfaces stay mounted when hidden. Visibility is not
  lifecycle.

Prove speed with realistic content. A fast empty-state demo says nothing about a
long transcript or a busy terminal.

## Keyboard & cancellation

- Keyboard ownership follows focus. The focused surface wins its keys; shell
  shortcuts must not steal a terminal's or editor's bindings.
- Focusing the Sessions sidebar preserves the last active chat's visual emphasis.
  Dimming still distinguishes session panes; sidebar navigation must not desaturate
  the chat or transfer its active highlight to a hidden primary tab.
- Focused and hovered chat panes both retain full color and opacity. Only panes
  that are neither focused nor hovered recede, with 20% desaturation.
- Register global shortcuts through the shared layer, not ad-hoc listeners.
- One cancel gesture does one thing: cancel the active interaction, or close the
  topmost dismissable surface — never both, never the control underneath.
- Cancellation is synchronous in the UI even if cleanup is async: overlays,
  cursors, and pending gesture state clear at once.
- Flows that deliberately cannot be dismissed (install/onboarding, destructive
  confirmation) must make that explicit.

## i18n

- Every user-facing string goes through `useI18n()` (`src/i18n/context.tsx`).
  No literals in JSX.
- **Update all locales together** — every catalog registered in
  `src/i18n/catalog.ts`. A string change in `en.ts` that skips the others is a
  regression (drifted punctuation, stale labels). Keep trailing-punctuation and
  tone consistent across all of them. `fr`, `de`, and `es` are complete
  `Translations` objects, so a key missing there fails the type check; the
  `defineLocale()` overlays fall back to English instead.

## State (TypeScript)

The detailed state contract lives in the scoped
[`AGENTS.md`](./AGENTS.md). Visual code follows these essentials:

- Shared/cross-component state → small **nanostores**, not prop-drilling.
  Each feature owns its atoms; shared atoms live in `src/store`.
- Rendering components subscribe with `useStore`; non-render actions read with
  `$atom.get()`.
- Subscribe to derived coarse facts instead of high-frequency source atoms when
  the component does not render the full value.
- Colocated action modules over god hooks. A hook owns one narrow job.
- Keep persistence beside the atom that owns it. Route roots stay thin.
- Prefer `interface` for public props; extend React primitives
  (`React.ComponentProps<'button'>`, `Omit<…>`).

空白应用区域不显示全局右键菜单（新建会话、窗口、命令面板、状态栏等）；链接、图片、文本编辑、终端以及项目/会话/文件自己的上下文操作继续保留。

## Affordances

- `cursor-pointer` at the primitive level (Button, dropdown/select) — don't
  hardcode it per call site.
- Global focus-ring reset; titlebar actions have no active-background state.
- `Esc` closes every dismissable overlay/dialog (install/onboarding excluded);
  close is an x-icon, not the word "Close".

## Before you add something — checklist

登录表单复用 `Input`、`Button` 的 `size="auth"`：44px 最小高度、10px 圆角及 14px 正文，用于独立登录卡片。`Button size="captcha"` 提供 96×44px 的无内边距图片操作位。普通桌面控件的默认尺寸保持原有约定。验证码以同一行中的图片按钮呈现，点击、Enter 或 Space 均可刷新；图片加载和失败仍保留该位置。

桌面 MaaS 登录页使用 `src/app/login/login.css` 的局部深色 token、蓝青渐变背景和主按钮，保持上述控件尺寸与行为。宽窗展示品牌／表单双栏，窄窗保留完整表单并允许纵向滚动。配色只绑定 `.desktop-login`，不改变根主题、用户偏好、登录后的启动画面或退出等待页；品牌与宣传文案使用国际化，说明限定为已实现的本地工作空间。

登录或恢复身份后，直接使用 `ConnectingScreen` 的官方 `CONNECTING` 动画；该纯展示组件也由 `GatewayConnectingOverlay` 使用。账号与套餐卡片不作为启动中间页，不添加进度解释或额外文案。主进程在后台准备账号环境，原版首窗就绪后交接，桌面的连接完成动画保持原有行为。

账号运行中到期复用右下角状态栏和通知：保留脱敏账号、简短到期文字与退出入口，完整说明通过已有 Tip 与一次非阻塞通知提供。提示不抢焦点、不打开确认框、不关闭已有确认、不改变任务生命周期。登录阶段尚未准备环境时，到期仍恢复登录表单。

退出账号的等待页复用同一个 `ConnectingScreen`：沿用当前窗口背景和明暗模式，仅显示本地化“正在退出账号…”与官方闪烁光标，不添加卡片、进度条或解释文字。该页面由独立的非持久 Chromium 分区加载，不带 preload 或账号操作能力；成功后仍重启 Electron 到登录页。

完整退出应用经原有确认后，立即隐藏旧窗口并移除托盘；主进程继续完成停止与验证，不显示正常等待页。取得进程快照后才销毁旧页面，避免提前断开 PTY 丢失归属。停止失败才打开纯展示页和既有重试对话框，不能跳过检查直接切换账号。普通关闭到托盘继续运行的规则不变。

- [ ] Reuse a primitive (`Button`, `SearchField`, `SegmentedControl`,
      `ListRow`, `Loader`, `ErrorState`, `LogView`, `ConfirmDialog`) instead of
      forking one?
- [ ] Tokens (`--ui-*`, `shadow-nous`, `--stroke-nous`) — zero raw colors /
      one-off shadows?
- [ ] No `className` overriding a primitive's padding / size / radius / chrome?
- [ ] Tips only where hover teaches something new (no kebab / menu-trigger
      tips; unlabeled chrome that needs discovery gets `<Tip>` + `aria-label`)?
- [ ] No native `title=` on buttons?
- [ ] Keybind hints on tipped buttons use `useKeybindHint` / `TipKeybindLabel`?
- [ ] Overlay uses `shadow-nous` + `border-(--stroke-nous)`, no hard border?
- [ ] Flat — no card-in-card, no gratuitous row dividers?
- [ ] No automatic navigation, focus steal, or pane opening from background
      events?
- [ ] Direct manipulation paints immediately and rolls back cleanly on failure?
- [ ] Hot interactions avoid broad subscriptions, layout thrash, and
      `transition-all`?
- [ ] Keyboard ownership and single-action `Esc` behavior are correct?
- [ ] All registered locales updated for any new/changed string?
- [ ] `cursor-pointer`, focus ring, and `Esc`-to-close behave?
- [ ] Touched a primitive, token, or variant? Its named-contract entry in this
      file is updated in the same change.

工作区标签切换时，窗口底部统一预留状态栏的 20px 高度；简洁模式隐藏状态栏内容及轮询，但保留同高空位，输入框和侧栏账号区域不随模式切换而上下跳动。

## 代码工作区导航与编辑器

代码开发项目列表隐藏 `isNoProject` 的虚拟 Home 分组，仅显示实际项目；未归属会话仍保留，可在办公/学习会话列表或搜索中访问。代码开发只显示新建会话、编辑器、技能与工具三个导航入口；办公和学习展示完整导航（包括定时任务），继续遵循用户隐藏及排序偏好。编辑器位于 `/editor`，跟随当前会话确认归属的目录，不借用尚未完成切换的旧目录。参考 hexagent 的 WorkspaceEditor，左侧为按需展开的文件树和真实 Git 变更列表，右侧为代码编辑或差异。复用现有 CodeMirror 与本地/远程文件及 Git 适配器，不引入第二套后端协议。

未保存缓冲只驻留内存，按连接、配置档、项目及文件隔离，切换文件和页面后可恢复。保存前重新读取基线；检测到外部变更时保留草稿并阻止覆盖，用户可明确放弃草稿并重新加载。二进制、截断和超限文本禁止编辑。文件与差异请求遵循最新点击，并在目录或连接切换后丢弃旧响应。

## 套餐用量

点击侧栏头像打开账号卡片（MasterGo 24:09213），宽 363px、圆角 24px、内边距 8px，
依次显示真实套餐、套餐实际用量、截止日期、设置及安全退出。用量行展开的详情紧跟该行，
不重复套餐名与截止日期；设置进入现有设置页；套餐行提供刷新与订阅按钮。订阅由主进程以当前身份换取一次性
market ticket，拼接含完整手机号的市场地址后交系统浏览器打开；失败只提示分类原因，
手机号、ticket 与原始响应不跨 IPC，也不缓存。刷新按钮绕过 30 秒缓存并合并并发，
定时与焦点恢复仍走缓存。图标取自原设计 SVG，
缺失截止日期显示破折号，不用登录令牌有效期冒充套餐截止日期。面板使用主题前景色、朱红进度条、
浅灰轨道与辅助文字，不引入设计系统外的品牌颜色；订阅为设计稿深绛红的实心胶囊，
查看详情与展开区域首行的用量摘要同排居右，不单独占行，文字与外链图标在浅色模式使用深绛红（`--dt-primary-deep`），深色模式使用主题强调色（`--theme-primary`）保证可读性，点击复用订阅的网站跳转，
使用 `Button variant="ghost" size="compact"`，保持 12px 文字，水平内边距 6px、垂直内边距 2px，悬浮底色留出空间，不给文字或图标加下划线。
仅发起操作的入口显示忙碌状态，另一入口的文字及按钮状态不变；两处共用防重复打开保护和失败提示，不触发用量行的展开或收起。
仅展开时查询，焦点恢复与每分钟更新，主进程对同一账号合并并发查询并缓存 30 秒。
失败保留同账号的旧结果并标记刷新失败，登录失效或账号不匹配则清空。Coding 与 Token 载荷按服务端 planType 选择，缺失值
显示暂无数据，不补造零用量。凭据、模型地址与原始响应不跨 IPC，不持久化用量。
源功能参考 `hexagent/libs/hexagent_demo/frontend/src/uniclawUsage.ts` 与 `components/Sidebar.tsx`。

账号卡片图标直接内嵌随包编译的 SVG，不通过外部 CSS 遮罩加载。
Coding 套餐摘要展示服务端存在的首个周期及已用百分比，Token 套餐展示已用百分比；
用量行折叠时显示摘要和向右箭头，展开时隐藏摘要，仅保留居右的向下箭头，用量由下方明细承载；整行点击只切换详情的展开状态。
截止日期按本地日期格式展示（`xxxx年x月x日 到期`，已到期只保留“已到期”标记），
已用量/总量与右对齐的剩余用量同排展示，已用量与剩余数值同色加深，不展示并发数据；
Token 已使用百分比紧随“已使用”标签。额度使用紧凑值，精确值提示仅限额度数字区域，不覆盖“查看详情”；百分比固定两位小数，
用量单位直接显示 `my-plan` 接口 `tokenPlanUsage.quotaUnit` 返回的字符串，不限制为 tokens 或 credits、不转换或补默认单位；缺失或非字符串时不显示单位。
重置时间按当天、48 小时内和更远分级。无用量时明确显示暂无数据。
旧主进程缺少用量桥接时提示完全重启，查询失败时可直接重试。

开发启动使用 Vite 热更新及 esbuild 主进程打包，不在 `npm run dev` 前置运行 TypeScript 声明产出或清理类型缓存。主进程先打包再等待 Vite 就绪，与前端启动并行；完整静态校验仍使用 `npm run typecheck`，发布构建流程保持独立。

扩展页顶部导航按 [MasterGo 99:8258](https://mastergo.com/file/204500798093134?layer_id=99%3A8258)：按桌面实际显示比例使用高 32px、内边距 4px 10px、图文间距 4px、标签间距 12px、16px/24px 600 字重、20px 图标和 10px 圆角；选中项使用石墨色底与白字，深色模式跟随语义令牌。专家、技能和连接器使用设计稿原始 SVG，代码工作区沿用技能、插件、连接器的顺序。

技能页二级选项卡按 MasterGo 99:4055：32px 高、8px 间距、6px 顶部圆角与 1px 浅灰边框；未选中使用 #F7F8FA 背景和常规字重，选中项与内容背景相连并加粗，不显示主题色下划线。已安装数量作为行内括号文本显示。深色模式使用既有语义令牌。

技能分类标签按 MasterGo 99:3973：32px 高、16px 圆角、5px 12px 内边距、8px 横纵间距、14px/22px 正文；选中和悬浮使用 #F0F0F0 胶囊背景及深灰加粗文字，其余为无底色灰字。深色模式使用语义背景令牌，分类文案继续使用真实数据。

连接器的推荐 / MCP 二级选项卡与技能页保持相同尺寸、顶部圆角、浅灰未选中背景及加粗选中态；分隔线延伸至内容区边缘，选中项下方用不透明页面背景衔接，浅色和深色模式均不显示主题色下划线。

连接器搜索复用技能搜索框的尺寸、边框和图标，放在扩展页标题栏右侧；切换 MCP 时只隐藏并禁用交互，保留标题栏占位。连接器二级标签栏与技能页统一 16px 顶部间距、32px 横向内边距（窄窗 16px）及 8px 标签间距。

主窗口关闭按钮默认隐藏到托盘，不触发退出确认，也不销毁页面或停止后台任务；此行为独立于“最小化到托盘”偏好。托盘可恢复窗口，右键退出仍走既有确认及安全清理流程。托盘创建失败时保留原退出路径，避免应用隐藏后无法恢复。

后端尚未就绪时的启动准备卡片固定使用简体中文标题和进度说明；底部显示面向用户的中文启动/安装状态，原始进程命令、路径及英文诊断保留在日志，不在启动进度行直接展示。就绪后的模型配置流程继续遵循用户语言设置。

首次启动的界面缩放默认为 100%，主题模式默认为明亮；主进程、渲染器初值和首帧背景保持一致。已保存的缩放及明亮/深色/跟随系统选择优先，恢复实际大小也回到 100%。

推荐连接器卡片与技能卡片统一：268px 最小列宽自动排布、16px 网格间距、16px 16px 13px 内边距、38px 图标、30px 添加按钮，标题 14px、描述及供应商 12px。图标和操作居顶，标题下置，描述最多两行，不再设置 174px 最小高度；窄窗继续自适应列数。

Markdown 文件预览使用完整表格单元格边线，单元格内边距 12px 16px、正文行高 28px；段落和列表同样保持 28px 行高。链接使用蓝色及下划线，深色模式使用更亮的蓝色，预览与 Markdown 分享入口共用渲染器。

Markdown 预览对长链接和连续字符串按可用宽度换行，代码块保持空格并独立横向滚动；图片按原比例自适应宽度，不限制图表高度。六级标题均有明确层级，嵌套列表缩小段落空隙；链接保留作者提供的标题说明。

左侧扩展入口与工作区同步：代码模式显示“技能 · 插件 · 连接器”，日常办公和学习生活显示“专家 · 技能 · 连接器”；入口可访问名称、悬浮提示与显示文案一致。

会话正文参照 UniWork 双侧布局：用户气泡按内容收缩并右对齐，最大占正文列的 85%，附件与操作同侧；模型回复保留左侧正文列。气泡内文本保持原本阅读方向，不用 RTL 模拟对齐。粘性提示的外层维持全宽，避免影响滚动及置顶行为。
