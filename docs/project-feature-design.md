# 数字员工 Project 功能技术方案

**版本**：v1.0  
**日期**：2026-11-04  
**作者**：Hermes Agent 团队  
**状态**：待评审

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [现状分析](#2-现状分析)
3. [总体架构](#3-总体架构)
4. [数据模型设计](#4-数据模型设计)
5. [核心接口设计](#5-核心接口设计)
6. [数据流设计](#6-数据流设计)
7. [用户数据存储策略](#7-用户数据存储策略)
8. [与现有系统的集成](#8-与现有系统的集成)
9. [安全与权限](#9-安全与权限)
10. [实现计划与里程碑](#10-实现计划与里程碑)
11. [风险与应对](#11-风险与应对)
12. [附录](#12-附录)

---

## 1. 背景与目标

### 1.1 背景

数字员工平台基于 Hermes Agent 构建，核心能力是「包（plugin/kit/expert）」的安装与路由。用户可以通过安装专家（expert profile）来获得特定领域的 AI 助手，通过安装套件（kit skills）来扩展 agent 的能力。

当前平台的任务载体层级如下：

```
专家档案 (expert profile)
  └── 会话 (session)
        └── 轮次 (turn)
```

缺少一个**面向任务、跨会话**的工作空间抽象。用户在进行长周期任务（如「写一份行业报告」）时，需要跨多次会话、可能跨多个专家来协作，当前缺少一个统一的容器来归拢这些活动。

### 1.2 目标

**核心目标**：在数字员工上实现一个 Project 功能，作为介于「专家」和「会话」之间的工作空间抽象，使任务、产出文件、子任务、专家召唤记录可以归拢到一个可命名的实体下。

**设计原则**（继承自 Hermes AGENTS.md）：

| 原则 | 说明 | 在本方案中的体现 |
|------|------|------------------|
| Per-conversation prompt caching is sacred | 长对话重用缓存前缀；任何修改过去上下文、交换工具集、中途重载记忆或重建系统提示的操作都会使用户成本倍增 | Project 上下文在会话开始时注入一次并冻结，不中途切换；绑定操作不触碰 system prompt |
| Core is a narrow waist | 每次调用模型都携带所有模型工具；新增核心工具门槛很高 | Project 作为 CLI 命令 + skill 实现（Footprint Ladder rung 2），不增加核心工具 schema |
| Never hardcode `~/.hermes` | 硬编码会破坏 profile（PR #3575 的 5 个 bug） | 所有路径通过 `get_hermes_home()` 解析；Project 元数据存于 `<home>/projects/` |
| Profile 是独立岛屿 | Profile 之间不实时继承配置；`--clone` 已覆盖「从我的默认配置开始」 | Project 不做跨 profile 实时同步；通过 `sync` 命令手动触发，复用 `expert_sync.py` 的同步框架 |
| `.env` 只放密钥 | 行为配置走 `config.yaml`；非密钥配置拒绝「在 .env 里设 X」 | Project 自身的配置项（关联数据源、输出格式偏好）写入 `meta.json` 的 `config` 字段 |
| Tests must not write to `~/.hermes/` | 测试的 autouse fixture 重定向 `HERMES_HOME` | Project 测试遵循同样约束，使用 temp `HERMES_HOME` |

### 1.3 范围

**In scope（本方案覆盖）**：

- Project 的数据模型与存储布局
- `hermes project` CLI 命令族（create / list / open / close / status / attach）
- Project Skill（`SKILL.md`），引导 agent 调用 CLI 命令
- 会话与 Project 的绑定机制（`on_session_start` hook + system prompt section）
- 产出文件归集机制（`on_transform_tool_result` hook）
- 与专家系统的关联（通过 `expert_profile` 字段弱引用）
- 用户数据存储策略与安全隔离

**Out of scope（本方案不覆盖，留待后续）**：

- Project 的多人协作（当前是单用户多专家）
- Project 与 Kanban 的深度集成（P1 增强，通过 observer hook 桥接）
- Project 的版本管理与 diff（P2 增强）
- 跨 profile 的 Project 实时同步（违反 profile 独立性原则，不做）

### 1.4 名词约定

| 术语 | 定义 |
|------|------|
| Project | 一个可命名的、跨会话的任务容器，profile-scoped |
| Home | 一个 profile 的根目录，由 `get_hermes_home()` 解析 |
| Expert | 一个专家，对应一个独立 profile（`installer.py::install_expert`） |
| Kit | 一个套件，装进某个 home 的 skills（`store.py::kit_root`） |
| Session | 一次会话，由 `session_id` 标识 |
| Turn | 一次模型调用轮次，由 `turn_id` 标识 |
| Workspace | 一个 Project 的工作目录，存放产出文件 |
| Binding | 会话与 Project 的关联关系 |

---

## 2. 现状分析

### 2.1 现有任务载体

数字员工平台当前的任务载体如下：

| 载体 | 实现 | 生命周期 | 跨会话 |
|------|------|----------|--------|
| 专家档案 | `installer.py::install_expert` | 持久，直到 `uninstall --delete-profile` | 是（profile 级） |
| 套件 | `installer.py::install_into_home` | 持久，直到 `uninstall` | 是（home 级） |
| 会话 | `hermes_state_*.py` | 持久（SessionDB） | 是（session 级） |
| 轮次 | `agent/turn_*.py` | 短暂 | 否 |

**缺口**：缺少一个介于「专家」和「会话」之间的、面向任务而非角色的工作空间。用户在进行长周期任务时，需要：

1. 跨多次会话延续同一个任务上下文
2. 归拢多个会话的产出文件
3. 在同一个任务下召唤不同专家
4. 对任务进行命名、描述、归档

### 2.2 现有存储布局

```
<home>/                          # 由 get_hermes_home() 解析
├── config.yaml                  # 全局配置（模型、provider、behavior）
├── .env                         # 密钥（API key、token 等）
├── imported-plugins/            # 套件/专家索引（store.py）
│   ├── index.json               # 已装包的注册表
│   └── <plugin>/<version>/      # 原包副本
├── skills/                      # 技能目录
│   └── kits/<plugin>/           # 套件技能
├── projects/                    # 【新增】Project 工作空间
│   ├── index.json               # Project 注册表
│   └── <project-id>/            # 单个 Project 的工作目录
│       ├── meta.json            # Project 元数据
│       ├── workspace/           # 产出文件落盘区
│       │   ├── drafts/
│       │   └── assets/
│       ├── sessions.jsonl       # 归属于此 Project 的会话记录（append-only）
│       └── tasks.json           # 此 Project 下的子任务清单
└── logs/                        # 日志（agent.log / errors.log / gateway.log）
```

### 2.3 现有路由机制

数字员工的路由分为两层（对应 UniClaw 的 hit-rate layer 1/2）：

1. **Layer 1（触发词）**：`triggers.py` 在安装时为每个能力生成中文触发词，存入 `index.json` 的 `triggers` 字段
2. **Layer 2（命中匹配）**：`router.py::on_pre_llm_call` 每轮将最新用户消息与触发词匹配，把命中的能力作为 hint 注入当前用户消息

**关键约束**：hint 只追加到当前用户消息，不触碰 system prompt，保证缓存前缀不变。

Project 功能可以在此路由层做增强：当会话绑定了某个 Project 时，`on_pre_llm_call` 可以在 hint 里优先推荐属于当前 Project 的技能。这是可选增强，不破坏现有路由逻辑。

### 2.4 现有专家系统

专家系统的核心流程：

```
hermes kit install <expert-package>
  → installer.install_expert(plan, home, receipt, ...)
    → profiles.create_profile(profile, ...)        # 创建独立 profile
    → _mirror_credentials(home, phome)             # 镜像密钥
    → _apply_bot_identity(home, ...)               # 写入名字和头像
    → install_into_home(plan, phome, ...)           # 把技能/MCP 装进专家 profile
    → expert_sync.sync_expert(home, phome)          # 同步默认配置档案的模型/密钥/生图工具
  → 在默认档案的索引里记一笔（stub entry）
```

专家系统的关键特征：

- **独立 profile**：每个专家有自己的 home，包含自己的 `.env`、`config.yaml`、skills、MCP
- **profile 独立**：profile 之间不实时继承配置，`--clone` 已覆盖「从默认配置开始」的需求
- **同步机制**：`expert_sync.py` 在插件加载时和 `hermes kit sync` 时，把默认 profile 的模型/密钥/生图工具推送到专家 profile

Project 功能需要与专家系统协同：

- Project 可以关联一个专家 profile（通过 `expert_profile` 字段）
- 专家在被召唤时，可以检查是否有关联的 Project
- Project 的上下文可以通过 `system_prompt_section` 注入到专家会话

---

## 3. 总体架构

### 3.1 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户交互层                                    │
│  CLI (hermes project ...)  │  Desktop UI  │  Gateway (IM)           │
└──────────────┬─────────────┴───────────────┴────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Project CLI 命令层                               │
│  cli.py (setup + handle)                                            │
│  ├── create  ├── list   ├── open   ├── close                       │
│  ├── status  ├── attach ├── purge  ├── sync                        │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Project 存储层                                   │
│  project_store.py                                                   │
│  ├── create_project()   ├── load_project()                         │
│  ├── bind_session()     ├── list_projects()                        │
│  ├── archive_project()  ├── purge_project()                        │
│  └── safe_rmtree() (复用 store.py)                                  │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Project 上下文注入层                             │
│  project_context.py                                                 │
│  ├── system_prompt_section (注册为 uniwork.project.context)         │
│  └── on_session_start hook (绑定会话到 Project)                     │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Project 产出归集层                               │
│  project_landing.py                                                 │
│  └── on_transform_tool_result hook (拦截产出文件)                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 分层职责

| 层 | 模块 | 职责 |
|----|------|------|
| 交互层 | CLI / Desktop / Gateway | 接收用户/agent 的 project 操作请求 |
| 命令层 | `project_cli.py` | 解析参数，调用存储层，格式化输出 |
| 存储层 | `project_store.py` | Project 元数据的 CRUD，文件系统操作 |
| 上下文注入层 | `project_context.py` | 在会话开始时渲染 project 上下文到 system prompt |
| 产出归集层 | `project_landing.py` | 拦截 agent 产出文件，归集到 project workspace |

### 3.3 与 Hermes 核心的关系

遵循 Footprint Ladder，Project 功能选择 **rung 2（CLI 命令 + skill）**：

```
Footprint Ladder:
1. Extend existing code     ← Project 不扩展已有核心代码
2. CLI command + skill      ← 【本方案选择】Project 作为 CLI 命令 + skill
3. Service-gated tool       ← Project 不需要结构化参数/返回
4. Plugin                   ← Project 是平台核心能力，不适合放第三方插件
5. MCP server               ← Project 不是工具，不适合做 MCP server
6. New core tool            ← Project 不需要成为核心工具
```

**选择 rung 2 的理由**：

1. Project 是配置/状态/基础设施类能力，天然适合 CLI 命令表达
2. 不增加核心工具 schema（每次调用模型都携带所有模型工具）
3. Agent 通过 `terminal` 工具运行 `hermes project` 子命令，不需要新的核心工具
4. 与 `hermes kit` 的命令模式完全对称，一致性好

### 3.4 缓存安全策略

**核心原则**：Project 上下文在会话开始时注入一次并冻结，不中途切换。

**实现机制**：

1. **会话开始时绑定**：`on_session_start` hook 读取 session_info 里的 `project_id`，绑定会话到 Project
2. **系统提示注入**：注册一个 `system_prompt_section`（`uniwork.project.context`），在会话开始时渲染 project 上下文并冻结
3. **不中途切换**：会话中途切换 project 需要开新会话（遵循 `hermes kit enable/disable` 的「下一场新会话生效」模式）

**与 `host_rules.py` 的对比**：

| 方面 | `host_rules.py`（专家） | `project_context.py`（Project） |
|------|-------------------------|---------------------------------|
| 注入时机 | 会话开始时渲染一次 | 会话开始时渲染一次 |
| 注入位置 | system prompt section | system prompt section |
| 缓存安全 | 不触碰 system prompt | 不触碰 system prompt |
| 数据来源 | `store.load_index(home)` 中的专家记录 | `project_store.load_project(home, project_id)` |

---

## 4. 数据模型设计

### 4.1 Project 注册表（index.json）

位于 `<home>/projects/index.json`，记录当前 profile 下所有 Project 的轻量元数据：

```json
{
  "version": 1,
  "projects": {
    "2026q4-new-energy-report": {
      "name": "2026Q4 新能源行业报告",
      "goal": "完成一份覆盖光伏/储能/充电桩的行业研究报告",
      "created_at": "2026-11-04T10:00:00",
      "updated_at": "2026-11-04T14:30:00",
      "expert_profile": "equity-research",
      "status": "active",
      "workspace_path": "projects/2026q4-new-energy-report/workspace"
    }
  }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 用户可读的项目名 |
| `goal` | string | 项目目标描述，注入到 system prompt |
| `created_at` | ISO 8601 | 创建时间 |
| `updated_at` | ISO 8601 | 最后更新时间 |
| `expert_profile` | string? | 关联的专家 profile 名（可选） |
| `status` | enum | `active` / `archived` / `deleted` |
| `workspace_path` | string | 相对于 home 的工作目录路径 |

**project-id 生成规则**（仿 `installer.py::profile_name_for`）：

```python
def project_id_for(name: str) -> str:
    """从项目名生成 project-id：小写字母数字和 - _，最长 64。"""
    slug = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-_")[:64]
    if not slug or not slug[0].isalnum():
        slug = f"project-{slug}".strip("-")[:64]
    # 添加短哈希避免重名
    suffix = hashlib.sha256(name.encode("utf-8")).hexdigest()[:6]
    return f"{slug}-{suffix}"
```

### 4.2 Project 元数据（meta.json）

位于 `<home>/projects/<project-id>/meta.json`，记录完整的 Project 元数据：

```json
{
  "id": "2026q4-new-energy-report-a1b2c3",
  "name": "2026Q4 新能源行业报告",
  "goal": "完成一份覆盖光伏/储能/充电桩的行业研究报告",
  "description": "面向投资决策的行业分析报告",
  "created_at": "2026-11-04T10:00:00",
  "updated_at": "2026-11-04T14:30:00",
  "closed_at": null,
  "status": "active",
  "expert_profile": "equity-research",
  "config": {
    "output_format": "markdown",
    "data_source": "eastmoney",
    "language": "zh"
  },
  "workspace": {
    "path": "workspace",
    "drafts_dir": "workspace/drafts",
    "assets_dir": "workspace/assets"
  },
  "stats": {
    "session_count": 0,
    "task_count": 0,
    "file_count": 0
  }
}
```

### 4.3 会话归属记录（sessions.jsonl）

位于 `<home>/projects/<project-id>/sessions.jsonl`，采用 append-only 格式记录归属到此 Project 的会话：

```jsonl
{"session_id": "sess-abc123", "platform": "desktop", "bound_at": "2026-11-04T10:00:00", "profile": "default", "project_id": "proj-xyz789"}
{"session_id": "sess-def456", "platform": "cli", "bound_at": "2026-11-04T11:30:00", "profile": "default", "project_id": "proj-xyz789"}
```

**设计考量**：

- **Append-only**：会话记录只追加，不修改；归档时标记 `closed_at`
- **JSONL 格式**：每行一个 JSON 对象，便于流式读取和追加
- **与 SessionDB 解耦**：不修改 `hermes_state_*.py`，只通过 `on_session_start` hook 记录关联

### 4.4 子任务清单（tasks.json）

位于 `<home>/projects/<project-id>/tasks.json`，记录此 Project 下的子任务：

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "task-001",
      "title": "收集光伏行业数据",
      "status": "completed",
      "assigned_to": "equity-research",
      "created_at": "2026-11-04T10:05:00",
      "completed_at": "2026-11-04T11:00:00",
      "output_refs": ["workspace/drafts/光伏数据.md"]
    },
    {
      "id": "task-002",
      "title": "分析储能市场竞争格局",
      "status": "in_progress",
      "assigned_to": "equity-research",
      "created_at": "2026-11-04T11:10:00",
      "completed_at": null,
      "output_refs": []
    }
  ]
}
```

### 4.5 产出文件归集

当 agent 产出文件时，`project_landing.py::on_transform_tool_result` hook 拦截产出，归集到 project workspace：

```
agent 调用 terminal 工具产出文件 (e.g., /tmp/report.md)
  → on_transform_tool_result 拦截
  → 检查当前会话是否绑定了 project
    → 如果绑定：
      → 将产出文件复制/软链接到 projects/<project-id>/workspace/drafts/
      → 记录到 project 的 file manifest
      → 返回增强后的工具结果（包含归集路径）
    → 如果未绑定：
      → 原样返回，不做归集
```

### 4.6 实体关系图

```
┌─────────────┐         ┌─────────────┐
│   Profile   │1───────*│   Project   │
│  (home)     │         │             │
└──────┬──────┘         └──────┬──────┘
       │                       │
       │1                     *│
       │                       │
       ▼                       ▼
┌─────────────┐         ┌─────────────┐
│   Session   │*───────*│ Project     │
│             │         │ Session     │
│             │         │ Binding     │
└─────────────┘         └─────────────┘
                              │
                             *│
                              │
                              ▼
                        ┌─────────────┐
                        │ Project     │
                        │ Task        │
                        └─────────────┘
                              │
                             *│
                              │
                              ▼
                        ┌─────────────┐
                        │ Workspace   │
                        │ File        │
                        └─────────────┘
```


---

## 5. 核心接口设计

### 5.1 CLI 命令族（`hermes project`）

仿照 `cli.py::setup` 注册 `hermes kit` 的模式，在 plugin 的 `register()` 里注册 `hermes project` 命令：

```python
# 在 plugins/uniwork-kits/__init__.py 的 register() 里
ctx.register_cli_command(
    "project",
    "创建和管理数字员工的工作项目",
    project_cli.setup,      # argparse 子命令注册
    project_cli.handle,     # 分发器
    description="...",
)
```

#### 5.1.1 命令总览

| 命令 | 作用 | 对应存储层方法 |
|------|------|----------------|
| `hermes project create <name>` | 新建 project | `project_store.create_project()` |
| `hermes project list [--status]` | 列出所有 project | `project_store.list_projects()` |
| `hermes project open <id>` | 在当前会话上下文绑定 project | `project_store.bind_session()` |
| `hermes project close <id>` | 归档 project | `project_store.archive_project()` |
| `hermes project status <id>` | 查看 project 元数据、会话数、任务数 | `project_store.get_project_status()` |
| `hermes project attach <id>` | 把当前会话挂到 project 下 | `project_store.bind_session()` |
| `hermes project purge <id>` | 物理删除 project | `project_store.purge_project()` |
| `hermes project sync` | 同步默认配置档案的模型/密钥到关联的专家 profile | 复用 `expert_sync.py` |

#### 5.1.2 命令详细设计

**`hermes project create`**

```bash
hermes project create "2026Q4 新能源行业报告" \
  --goal "完成一份覆盖光伏/储能/充电桩的行业研究报告" \
  --expert equity-research \
  --config output_format=markdown,data_source=eastmoney
```

参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | positional | 项目名称 |
| `--goal` | string | 项目目标描述 |
| `--expert` | string? | 关联的专家 profile 名 |
| `--config` | KEY=VALUE,... | 项目配置项 |

输出示例：

```
✓ 已创建项目「2026Q4 新能源行业报告」
  ID: 2026q4-new-energy-report-a1b2c3
  工作目录: ~/.hermes/projects/2026q4-new-energy-report-a1b2c3/workspace
  关联专家: equity-research

下一步:
  - 在对话中说「打开项目 2026q4-new-energy-report」
  - 或在桌面端侧边栏选择此项目
```

**`hermes project list`**

```bash
hermes project list
hermes project list --status active
hermes project list --status archived
```

输出示例：

```
活跃项目 (2):
  2026q4-new-energy-report-a1b2c3  2026Q4 新能源行业报告  [equity-research]
  q3-financial-review-d4e5f6        Q3 财报回顾           [equity-research]

已归档项目 (1):
  2025-annual-plan-g7h8i9          2025 年度规划         [default]
```

**`hermes project status`**

```bash
hermes project status 2026q4-new-energy-report-a1b2c3
```

输出示例：

```
项目: 2026Q4 新能源行业报告
ID: 2026q4-new-energy-report-a1b2c3
状态: active
目标: 完成一份覆盖光伏/储能/充电桩的行业研究报告
关联专家: equity-research
创建时间: 2026-11-04 10:00:00
最后更新: 2026-11-04 14:30:00

会话数: 3
任务数: 5 (完成 2, 进行中 2, 待开始 1)
文件数: 8

最近会话:
  - sess-abc123  2026-11-04 10:00  desktop
  - sess-def456  2026-11-04 11:30  cli
  - sess-ghi789  2026-11-04 14:00  desktop
```

### 5.2 Project Skill（`SKILL.md`）

一个 `SKILL.md` 引导 agent 在需要时调用 `hermes project` 命令。Skill 位于 `skills/uniwork/project/`（或随 plugin 分发）。

**Skill 职责**：

1. 引导 agent 识别用户的长周期任务意图
2. 引导 agent 调用 `hermes project create` 创建 project
3. 引导 agent 在 project 上下文中工作时，遵循 project 的 goal 和 config
4. 引导 agent 在产出文件时，将文件归集到 project workspace

**Skill 内容骨架**：

```markdown
---
name: project
description: 管理数字员工的工作项目。当用户开始一个需要多轮对话的长周期任务时，创建一个 project 来归拢产出文件、子任务和会话记录。
---

# 项目管理 Skill

## 何时创建项目

当用户提出一个需要跨多次会话完成的长周期任务时，例如：
- "帮我写一份行业研究报告"
- "我要做一个产品竞品分析"
- "分析这家公司的财务数据并出具报告"

此时应创建一个项目来管理这个任务。

## 创建项目

使用以下命令创建项目：

\`\`\`bash
hermes project create "项目名称" --goal "项目目标描述"
\`\`\`

## 在项目中工作

项目创建后，在对话中引用项目名称即可在项目上下文中工作。
产出文件会自动归集到项目的工作目录。

## 查看项目状态

\`\`\`bash
hermes project status <project-id>
\`\`\`

## 归档项目

任务完成后，归档项目：

\`\`\`bash
hermes project close <project-id>
\`\`\`
```

### 5.3 Plugin Context 扩展点

#### 5.3.1 `on_session_start` Hook

```python
def on_session_start(session_info: dict, **kwargs) -> Optional[dict]:
    """会话开始时，如果 session 携带了 project_id，绑定会话到 project。"""
    project_id = session_info.get("project_id")
    if not project_id:
        return None
    
    home = Path(get_hermes_home())
    project = project_store.load_project(home, project_id)
    if not project:
        return None
    
    # 记录会话归属
    project_store.bind_session(home, project_id, {
        "session_id": session_info["session_id"],
        "platform": session_info.get("platform", ""),
        "bound_at": _now(),
    })
    
    return None  # 不修改 session_info，只记录
```

#### 5.3.2 System Prompt Section

```python
def project_context_section(session_info: dict) -> str:
    """渲染当前绑定的 project 上下文到 system prompt。"""
    project_id = session_info.get("project_id")
    if not project_id:
        return ""
    
    home = Path(get_hermes_home())
    project = project_store.load_project(home, project_id)
    if not project or project.get("status") != "active":
        return ""
    
    return f"""## 当前项目上下文

你当前在项目「{project['name']}」下工作。

**项目目标**: {project.get('goal', '未指定')}

**项目配置**: {json.dumps(project.get('config', {}), ensure_ascii=False)}

**工作目录**: {project.get('workspace', {}).get('path', '未指定')}

请在此项目上下文中工作，产出文件归集到项目工作目录。
"""
```

注册（在 plugin 的 `register()` 里）：

```python
ctx.register_system_prompt_section(
    "uniwork.project.context",
    project_context.project_context_section,
    max_chars=2000,
)
```

### 5.4 产出归集 Hook

```python
def on_transform_tool_result(
    tool_name: str = "",
    args: Any = None,
    result: Any = "",
    session_id: str = "",
    turn_id: str = "",
    task_id: str = "",
    **_: Any,
) -> Optional[str]:
    """在工具结果后面补充 project 归集信息。"""
    try:
        # 1. 检查当前会话是否绑定了 project
        project_id = project_store.get_session_project(home, session_id)
        if not project_id:
            return None  # 未绑定，原样返回
        
        # 2. 检查是否是产出文件的工具调用
        if not _is_file_producing_tool(tool_name, args):
            return None
        
        # 3. 提取产出文件路径
        file_path = _extract_output_path(tool_name, args, result)
        if not file_path:
            return None
        
        # 4. 归集到 project workspace
        landing_path = project_store.land_file(
            home, project_id, file_path, tool_name=tool_name
        )
        
        # 5. 在工具结果后面补充归集信息
        original = result if isinstance(result, str) else str(result or "")
        return original.rstrip() + f"\n\n[已归集到项目工作目录: {landing_path}]"
    except Exception:
        logger.warning("[project] tool result hook failed", exc_info=True)
        return None
```


---

## 6. 数据流设计

### 6.1 创建 Project

```
用户/agent 执行 `hermes project create "2026Q4 新能源行业报告" --goal "..."`
  │
  ▼
project_cli.handle(args)
  │  解析 create 子命令
  ▼
project_store.create_project(home, name, goal, expert_profile, config)
  │
  ├── 生成 project-id（名称 slug + 短哈希）
  ├── mkdir -p projects/<project-id>/workspace/{drafts,assets}
  ├── 写 meta.json（utils.atomic_json_write）
  ├── 更新 index.json（原子写入）
  └── 返回 project-id
  │
  ▼
project_cli 格式化输出
  │
  ▼
用户看到创建结果，获得 project-id
```

### 6.2 会话绑定 Project

```
会话开始
  │
  ▼
on_session_start hook 触发
  │
  ├── 读取 session_info.project_id
  ├── 如果有 project_id:
  │     ├── project_store.bind_session(home, project_id, session_info)
  │     │     └── append 到 projects/<project-id>/sessions.jsonl
  │     └── 返回 None（不修改 session_info）
  └── 如果没有 project_id: 跳过
  │
  ▼
system_prompt_section 渲染（uniwork.project.context）
  │
  ├── 读取 session_info.project_id
  ├── project_store.load_project(home, project_id)
  ├── 渲染 project 上下文文本
  └── 注入到 system prompt（冻结）
  │
  ▼
会话进行中，project 上下文已在 system prompt 中
  │
  ▼
agent 产出文件时:
  │
  ▼
on_transform_tool_result hook 触发
  │
  ├── project_store.get_session_project(home, session_id)
  ├── 如果绑定了 project:
  │     ├── 提取产出文件路径
  │     ├── project_store.land_file(home, project_id, file_path)
  │     └── 在工具结果后补充归集路径
  └── 如果未绑定: 原样返回
```

### 6.3 专家协作流程

```
hermes project create "2026Q4 新能源行业报告" --expert equity-research
  │
  ▼
project_store.create_project() 记录 expert_profile
  │
  ▼
用户在桌面端召唤专家 equity-research
  │
  ▼
专家会话开始时:
  │
  ├── on_session_start hook 检查 session_info.project_id
  ├── 如果匹配 project.expert_profile:
  │     ├── 绑定会话到 project
  │     └── 注入 project 上下文到专家会话的 system prompt
  └── 如果不匹配: 正常专家会话，不注入 project 上下文
  │
  ▼
专家在 project 上下文中工作
  │
  ▼
专家产出文件时:
  │
  ▼
on_transform_tool_result hook 归集文件到 project workspace
  │
  ▼
专家完成会话，产出文件已归集到 project workspace
```

### 6.4 跨专家协作流程

```
Project: 2026Q4 新能源行业报告
  │
  ├── 会话 1: 召唤 equity-research 专家
  │     ├── 在 project 上下文中工作
  │     ├── 产出: workspace/drafts/光伏数据.md
  │     └── 产出: workspace/drafts/储能数据.md
  │
  ├── 会话 2: 召唤 ppt-writer 套件（在 default profile 下）
  │     ├── on_session_start 检查 project_id
  │     ├── 绑定会话到 project
  │     ├── 注入 project 上下文（含已产出的文件列表）
  │     └── agent 读取 workspace/drafts/ 下的文件，制作 PPT
  │
  └── 会话 3: 用户在 default profile 下对话
        ├── 绑定会话到 project
        ├── 注入 project 上下文
        └── agent 可以引用之前会话的产出文件
```

### 6.5 Project 归档流程

```
用户执行 `hermes project close 2026q4-new-energy-report-a1b2c3`
  │
  ▼
project_cli.handle(args)
  │  解析 close 子命令
  ▼
project_store.archive_project(home, project_id)
  │
  ├── 更新 meta.json: status = "archived", closed_at = now
  ├── 更新 index.json: status = "archived"
  └── 不删除 workspace 文件（归档不等于删除）
  │
  ▼
project_cli 格式化输出
  │
  ▼
用户看到归档结果
```

### 6.6 Project 删除流程

```
用户执行 `hermes project purge 2026q4-new-energy-report-a1b2c3`
  │
  ▼
project_cli.handle(args)
  │  解析 purge 子命令
  ▼
project_store.purge_project(home, project_id)
  │
  ├── 检查 project.status 是否为 "archived"（必须先归档才能删除）
  ├── store.safe_rmtree(projects/<project-id>, home)  # 安全删除
  ├── 更新 index.json: 移除该 project 条目
  └── 返回删除结果
  │
  ▼
project_cli 格式化输出
  │
  ▼
用户看到删除结果
```

---

## 7. 用户数据存储策略

### 7.1 存储分层

| 数据类型 | 存储位置 | 格式 | 生命周期 |
|----------|----------|------|----------|
| Project 注册表 | `<home>/projects/index.json` | JSON | 跟随 profile |
| Project 元数据 | `<home>/projects/<id>/meta.json` | JSON | 跟随 profile |
| 会话归属记录 | `<home>/projects/<id>/sessions.jsonl` | JSONL | 跟随 profile |
| 子任务清单 | `<home>/projects/<id>/tasks.json` | JSON | 跟随 profile |
| 产出文件 | `<home>/projects/<id>/workspace/` | 文件系统 | 跟随 profile |
| Project 配置 | `meta.json` 的 `config` 字段 | JSON | 跟随 profile |
| 涉及密钥 | `.env` | KEY=VALUE | 跟随 profile |

### 7.2 与专家系统的存储对比

| 方面 | 专家系统 | Project 系统 |
|------|----------|--------------|
| 元数据位置 | `<home>/imported-plugins/index.json` | `<home>/projects/index.json` |
| 工作目录 | 专家自己的 profile home | `<home>/projects/<id>/workspace/` |
| 密钥存储 | 专家自己的 `.env` | Project 配置在 `meta.json`，密钥仍在 `.env` |
| 同步机制 | `expert_sync.py` 推送默认 profile 的模型/密钥 | Project 不做跨 profile 同步 |
| 删除策略 | `uninstall --delete-profile` 删整个 profile | `purge` 删 project 目录，不影响 profile |

### 7.3 数据一致性策略

**原子写入**：所有 JSON 文件使用 `utils.atomic_json_write` 原子写入（先写临时文件再 rename），避免并发写入导致文件损坏。

**并发控制**：Project 操作通过文件锁（`fcntl.flock`）保证同一 profile 下的操作串行化。跨 profile 的操作各自独立，不需要全局锁。

**数据恢复**：`sessions.jsonl` 采用 append-only 设计，即使最后一条记录损坏，前面的记录仍然可用。`meta.json` 和 `index.json` 在每次写入前备份为 `.bak` 文件，损坏时可回滚。

### 7.4 数据隔离策略

**Profile 隔离**：每个 profile 的 Project 数据完全隔离，存储在各自 home 的 `projects/` 下。跨 profile 引用 Project 是不允许的（遵循 profile 独立性原则）。

**Workspace 隔离**：每个 Project 有独立的 workspace 目录，产出文件归集到对应的 workspace。不同 Project 的产出文件不会交叉。

**安全删除**：删除 Project 时通过 `store.safe_rmtree` 安全删除，拒绝删除 home 外的文件、不跟随符号链接。

### 7.5 配置项存储策略

Project 自身的配置项（如关联的数据源、输出格式偏好）写入 `meta.json` 的 `config` 字段，**不写入 `.env`**。

**设计原则**（继承自 Hermes AGENTS.md）：

- `.env` 只放密钥（API key、token 等）
- 行为配置走 `config.yaml`
- 非密钥配置拒绝「在 .env 里设 X」

**Project 配置项分类**：

| 配置项 | 存储位置 | 说明 |
|--------|----------|------|
| 关联数据源 | `meta.json` 的 `config.data_source` | 如 `eastmoney`、`akshare` |
| 输出格式偏好 | `meta.json` 的 `config.output_format` | 如 `markdown`、`docx` |
| 语言偏好 | `meta.json` 的 `config.language` | 如 `zh`、`en` |
| 关联专家 profile | `meta.json` 的 `expert_profile` | 如 `equity-research` |

### 7.6 数据迁移策略

**版本字段**：`index.json` 和 `meta.json` 都有 `version` 字段，当前为 `1`。未来字段变更时，通过版本号做迁移。

**迁移函数**：在 `project_store.py` 里实现 `_migrate_index(data, from_version)` 和 `_migrate_meta(data, from_version)`，在加载数据时自动迁移。

**向后兼容**：迁移函数只添加新字段、不删除旧字段。旧版本的数据在新版本中仍然可用。


---

## 8. 与现有系统的集成

### 8.1 与专家系统的集成

**集成点**：Project 通过 `expert_profile` 字段关联专家 profile。

**集成方式**：

1. 创建 Project 时指定 `--expert equity-research`，Project 元数据记录关联的专家 profile 名
2. 专家会话开始时，`on_session_start` hook 检查会话是否携带 `project_id`：
   - 如果匹配 Project 的 `expert_profile`，绑定会话到 Project
   - 如果不匹配，正常专家会话，不注入 Project 上下文
3. Project 上下文通过 `system_prompt_section` 注入到专家会话

**不修改专家安装流程**：Project 功能不修改 `installer.py::install_expert` 的任何逻辑，只通过 `expert_profile` 字段做弱引用。

### 8.2 与路由系统的集成

**集成点**：`router.py::on_pre_llm_call` 在会话绑定了 Project 时，可以在 hint 里优先推荐属于当前 Project 的技能。

**集成方式**：

1. Project 可以记录关联的 kit/expert skills（通过 `config.related_skills` 字段）
2. `on_pre_llm_call` 检查会话是否绑定了 Project
3. 如果绑定，在路由 hint 里优先推荐 Project 关联的技能

**这是可选增强**，不破坏现有路由逻辑。P0 阶段不实现此集成。

### 8.3 与任务系统（Kanban）的集成

**集成点**：Project 的 `tasks.json` 是轻量本地清单，不与 Kanban 数据库耦合。

**集成方式**：

1. Project 的 `tasks.json` 记录此 Project 下的子任务（轻量版）
2. 如果需要，可以通过 `kanban_task_claimed` / `kanban_task_completed` 等 observer hook 把 Project 事件桥接到 Kanban
3. 但这是 P1 增强，P0 阶段不实现

### 8.4 与桌面端的集成

**集成点**：Project 列表和详情可以通过现有的 `catalog.py` 只读视图模式暴露给桌面端。

**集成方式**：

1. `catalog.py` 增加 `list_projects()` 只读视图，返回 Project 列表
2. 桌面端侧边栏增加 Project 列表 surface
3. 桌面端选中 Project 时，通过 JSON-RPC 调用 `project_store.bind_session()` 绑定会话

### 8.5 与同步机制的集成

**集成点**：Project 不做跨 profile 实时同步，但可以手动触发同步。

**集成方式**：

1. `hermes project sync` 命令复用 `expert_sync.py` 的同步框架
2. 同步默认配置档案的模型/密钥/生图工具到关联的专家 profile
3. 但 Project 自身的元数据不跨 profile 同步（遵循 profile 独立性原则）

### 8.6 集成矩阵

| 现有系统 | 集成方式 | 修改现有代码 | 阶段 |
|----------|----------|--------------|------|
| 专家系统 | `expert_profile` 弱引用 | 否 | P0 |
| 路由系统 | `on_pre_llm_call` 优先推荐 | 否（可选增强） | P1 |
| Kanban | observer hook 桥接 | 否 | P1 |
| 桌面端 | `catalog.py` 只读视图 | 否 | P2 |
| 同步机制 | 复用 `expert_sync.py` | 否 | P1 |

---

## 9. 安全与权限

### 9.1 安全边界

Project 功能的安全边界遵循 Hermes 的安全模型：

1. **Profile 隔离**：Project 数据存储在各自 profile 的 home 下，跨 profile 不可访问
2. **文件系统安全**：删除操作通过 `store.safe_rmtree` 安全删除，拒绝删除 home 外的文件、不跟随符号链接
3. **密钥隔离**：Project 配置在 `meta.json`，密钥仍在 `.env`，不混用

### 9.2 输入验证

所有用户输入都经过验证：

1. **Project 名称**：限制长度（≤128 字符）、禁止路径分隔符（`/`、`\`）、禁止空字节
2. **Project ID**：只允许 `[a-z0-9_-]`，最长 64 字符
3. **配置项**：KEY 必须是 `[A-Za-z0-9_]`，VALUE 限制长度

### 9.3 路径穿越防护

所有文件操作都检查路径是否在 home 内：

```python
def is_within(parent: Path, child: Path) -> bool:
    """child 是否在 parent 目录里面。"""
    try:
        child.resolve().relative_to(parent.resolve())
    except (OSError, ValueError):
        return False
    return True
```

### 9.4 权限模型

Project 功能不需要额外的权限模型，因为：

1. Project 是 profile-scoped 的，只有拥有该 profile 的用户才能访问
2. Project 的产出文件归集到 workspace，不涉及跨用户共享
3. Project 的会话绑定是只读操作，不修改 session 的核心数据

---

## 10. 实现计划与里程碑

### 10.1 实现阶段

| 阶段 | 目标 | 交付物 | 预估工期 |
|------|------|--------|----------|
| P0 | 最小可用 Project 功能 | `project_store.py`、`project_cli.py`、`SKILL.md`、基础测试 | 1-2 周 |
| P1 | 会话绑定与上下文注入 | `project_context.py`、`on_session_start` hook、`system_prompt_section`、产出归集 hook | 1-2 周 |
| P2 | 桌面端集成与跨专家协作 | 桌面端 Project 侧边栏、`catalog.py` 只读视图、跨专家协作流程 | 2-3 周 |

### 10.2 P0 详细任务

| # | 任务 | 说明 |
|---|------|------|
| 1 | `project_store.py` | Project 元数据的 CRUD，文件系统操作，复用 `store.py` 的安全删除 |
| 2 | `project_cli.py` | `hermes project create/list/open/close/status/attach/purge/sync` 命令 |
| 3 | `SKILL.md` | Project Skill，引导 agent 调用 CLI 命令 |
| 4 | `__init__.py` 注册 | 在 plugin 的 `register()` 里注册 `hermes project` CLI 命令 |
| 5 | 基础测试 | Project 的 CRUD 测试，使用 temp `HERMES_HOME` |

### 10.3 P1 详细任务

| # | 任务 | 说明 |
|---|------|------|
| 1 | `project_context.py` | System prompt section 渲染 Project 上下文 |
| 2 | `on_session_start` hook | 会话开始时绑定会话到 Project |
| 3 | `on_transform_tool_result` hook | 产出文件归集到 project workspace |
| 4 | 路由集成（可选） | `on_pre_llm_call` 在会话绑定 Project 时优先推荐关联技能 |
| 5 | 测试 | 会话绑定、上下文注入、产出归集的测试 |

### 10.4 P2 详细任务

| # | 任务 | 说明 |
|---|------|------|
| 1 | 桌面端 Project 侧边栏 | 桌面端新增 Project 列表 surface |
| 2 | `catalog.py` 只读视图 | Project 列表的只读视图 |
| 3 | 跨专家协作流程 | 同一 Project 下召唤不同专家协作的完整流程 |
| 4 | 测试 | 桌面端集成、跨专家协作的测试 |

### 10.5 测试策略

遵循 Hermes 的测试原则：

1. **使用 `scripts/run_tests.sh`**，不直接用 `pytest`
2. **测试不写入 `~/.hermes/`**，使用 temp `HERMES_HOME`
3. **行为契约测试**，非 change-detector 测试
4. **E2E 验证**，不只用 mock

**Project 测试覆盖**：

- Project 的 CRUD（create / read / update / delete）
- 会话绑定与上下文注入
- 产出文件归集
- 安全删除与路径穿越防护
- Profile 隔离

### 10.6 文件清单

```
plugins/uniwork-kits/
├── project_store.py        # 新增：Project 存储层
├── project_cli.py          # 新增：Project CLI 命令
├── project_context.py      # 新增：Project 上下文注入
├── project_landing.py      # 新增：Project 产出归集
├── __init__.py             # 修改：注册 hermes project 命令
└── tests/
    └── test_project.py     # 新增：Project 测试
```

---

## 11. 风险与应对

### 11.1 技术风险

| 风险 | 影响 | 应对 |
|------|------|------|
| 缓存失效 | 会话中途切换 Project 导致缓存前缀失效，成本倍增 | Project 上下文在会话开始时注入一次并冻结，不中途切换；切换 Project 需开新会话 |
| Profile 泄漏 | Project 操作在错误的 profile 下执行 | 所有操作通过 `get_hermes_home()` 解析当前 profile 的 home；CLI 命令显式接受 `--profile` 参数 |
| 文件系统竞争 | 多个会话同时操作同一 Project 的 workspace | 文件锁（`fcntl.flock`）保证同一 profile 下的操作串行化；workspace 内的文件归集是原子操作 |
| 数据损坏 | JSON 文件写入中断导致损坏 | 原子写入（先写临时文件再 rename）；每次写入前备份为 `.bak`；加载时做 schema 校验 |

### 11.2 产品风险

| 风险 | 影响 | 应对 |
|------|------|------|
| Project 与 Kanban 概念重叠 | 用户困惑何时用 Project 何时用 Kanban | P0 阶段 Project 的 `tasks.json` 是轻量本地清单；明确文档说明 Project 面向「跨会话任务归拢」，Kanban 面向「团队任务看板」 |
| 专家系统复杂度增加 | Project 关联专家增加系统复杂度 | P0 阶段不实现专家关联，只做基础 Project 功能；P1 阶段再做集成 |
| 用户习惯成本 | 用户不习惯 Project 概念 | Skill 引导 agent 在识别到长周期任务时主动建议创建 Project |

### 11.3 运维风险

| 风险 | 影响 | 应对 |
|------|------|------|
| 存储膨胀 | Project workspace 积累大量产出文件 | `hermes project status` 显示文件数和总大小；`purge` 命令支持清理 workspace |
| 跨版本兼容 | 版本升级后旧 Project 数据不兼容 | `index.json` 和 `meta.json` 都有 `version` 字段；迁移函数自动迁移旧数据 |

---

## 12. 附录

### 12.1 术语表

| 术语 | 定义 |
|------|------|
| Project | 一个可命名的、跨会话的任务容器，profile-scoped |
| Home | 一个 profile 的根目录，由 `get_hermes_home()` 解析 |
| Expert | 一个专家，对应一个独立 profile |
| Kit | 一个套件，装进某个 home 的 skills |
| Session | 一次会话，由 `session_id` 标识 |
| Turn | 一次模型调用轮次，由 `turn_id` 标识 |
| Workspace | 一个 Project 的工作目录，存放产出文件 |
| Binding | 会话与 Project 的关联关系 |
| SOUL.md | 专家的人设文件 |
| Footprint Ladder | Hermes 的新能力决策阶梯（extend → CLI+skill → service-gated tool → plugin → MCP → core tool） |

### 12.2 参考文件

| 文件 | 说明 |
|------|------|
| `plugins/uniwork-kits/installer.py` | 套件/专家安装器，Project 存储层复用其安全删除和原子写入模式 |
| `plugins/uniwork-kits/store.py` | On-disk layout 和 installer 的 registry，Project 存储层复用其索引模式 |
| `plugins/uniwork-kits/router.py` | Per-turn kit hints，Project 上下文注入复用其 cache-safe 模式 |
| `plugins/uniwork-kits/host_rules.py` | 专家的系统提示段，Project 上下文注入参考其 section 注册模式 |
| `plugins/uniwork-kits/expert_sync.py` | 专家同步机制，Project sync 命令复用其同步框架 |
| `plugins/uniwork-kits/catalog.py` | 只读视图，Project 列表只读视图参考其模式 |
| `plugins/uniwork-kits/cli.py` | `hermes kit` CLI 命令，Project CLI 命令参考其 setup/handle 模式 |
| `plugins/uniwork-kits/__init__.py` | Plugin 入口，Project CLI 命令在此注册 |

### 12.3 CLI 命令速查

```bash
# 创建项目
hermes project create "项目名称" --goal "项目目标" --expert equity-research

# 列出项目
hermes project list
hermes project list --status active
hermes project list --status archived

# 查看项目状态
hermes project status <project-id>

# 打开/绑定项目到当前会话
hermes project open <project-id>

# 归档项目
hermes project close <project-id>

# 物理删除项目（需先归档）
hermes project purge <project-id>

# 同步默认配置档案的模型/密钥到关联的专家 profile
hermes project sync
```

### 12.4 数据流时序图

```
用户        CLI         project_store    on_session_start   system_prompt_section   on_transform_tool_result
 │           │                │                  │                    │                       │
 │──create──▶│                │                  │                    │                       │
 │           │──create_project▶│                  │                    │                       │
 │           │◀──project-id───│                  │                    │                       │
 │◀──result──│                │                  │                    │                       │
 │           │                │                  │                    │                       │
 │──open────▶│                │                  │                    │                       │
 │           │──bind_session─▶│                  │                    │                       │
 │◀──result──│                │                  │                    │                       │
 │           │                │                  │                    │                       │
 │           │                │                  │◀──session_start────│                       │
 │           │                │                  │──bind_session──────▶│                       │
 │           │                │                  │                    │──render context──▶    │
 │           │                │                  │                    │                       │
 │           │                │                  │                    │                       │
 │──agent produces file──────────────────────────────────────────────────────────────────────▶│
 │           │                │                  │                    │                       │──land_file──▶
 │◀──result with landing path──────────────────────────────────────────────────────────────────│
```

---

**文档结束**

本方案遵循 Hermes 的设计哲学：**核心保持窄腰，能力在边缘扩展**。Project 功能作为 CLI 命令 + skill 实现（Footprint Ladder rung 2），不增加核心工具 schema，通过 plugin context 的 `on_session_start` hook 和 `system_prompt_section` 与现有系统集成，保持缓存安全和 profile 隔离。
