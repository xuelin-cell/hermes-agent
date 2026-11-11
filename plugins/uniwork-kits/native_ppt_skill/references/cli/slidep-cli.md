# slidep CLI

slidep 已安装到 Node 托管环境中，可直接使用。

---

## slidep create

创建空白 PPTX 文件。

```bash
slidep create <file> [options]
```

| 参数/选项 | 说明 |
|-----------|------|
| `<file>` | 输出 PPTX 文件路径（必填） |
| `--base-url <url>` | editor_sdk base URL（默认 `$TENCENT_DOCS_LOCAL_MCP` 或 `http://localhost:39099`） |
| `--timeout <ms>` | HTTP 超时毫秒数（默认 120000） |

**stdout**（成功）：

```json
{ "ok": true, "file_id": "...", "file_path": "/abs/path.pptx", "latest_version": 1 }
```

**示例**：

```bash
slidep create output.pptx
```

---

## slidep lint

校验 DSL 页内容，只做本地布局检查。

```bash
slidep lint <file> --dsl-file <path> --page-index N
```

| 参数/选项 | 说明 |
|-----------|------|
| `<file>` | 目标 PPTX 文件路径（必填，作为 lint 上下文） |
| `--dsl <string>` | 内联 DSL 字符串（与 `--dsl-file` 互斥） |
| `--dsl-file <path>` | 从文件读取 DSL（与 `--dsl` 互斥） |
| `--page-index <n>` | 0-based 页码上下文（默认 0），用于诊断中的 `slide_index` |

行为要点：

- 布局检查纯本地执行，不依赖 editor_sdk。

**stdout**（成功）：

```json
{ "ok": true, "file": "/abs/path.pptx", "page_index": 0, "slide_count": 1, "diagnostics": [] }
```

**diagnostics 条目**：

| 来源 | ruleId | severity | 说明 |
|---|---|---|---|
| 布局 | `no-overflow` / `zero-size-text` / `component-overlap` / `child-containment` / `zero-position` | error / warning | 页面布局问题，`slide_index` 为 DSL 内页序号加上 `--page-index` |

**stdout**（有 error，退出码 1）：

```json
{ "ok": false, "file": "...", "page_index": 0, "slide_count": 1, "diagnostics": [{ "ruleId": "...", "severity": "error", "message": "...", "slide_index": 0 }] }
```

只要存在 `severity: "error"` 的诊断，`ok` 即为 false 且退出码为 1；只有 warning 时仍算通过。

**示例**：

```bash
# 只做布局检查
slidep lint output.pptx --dsl-file slides/01.slide

slidep lint output.pptx --dsl '<Slide>...</Slide>'
```

---

## slidep upsert-dsl

向 PPTX 插入或替换 DSL 页。

```bash
slidep upsert-dsl <file> [options]
```

| 参数/选项 | 说明 |
|-----------|------|
| `<file>` | 目标 PPTX 文件路径（必填） |
| `--dsl <string>` | 内联 DSL 字符串（与 `--dsl-file` 互斥） |
| `--dsl-file <path>` | 从文件读取 DSL（与 `--dsl` 互斥） |
| `--page-index <n>` | 0-based 页码，指定则替换该页；省略或 -1 则追加（默认 -1） |
| `--base-url <url>` | editor_sdk base URL（默认 `$TENCENT_DOCS_LOCAL_MCP` 或 `http://localhost:39099`） |
| `--timeout <ms>` | HTTP 超时毫秒数（默认 120000） |

**示例**：

```bash
slidep upsert-dsl output.pptx --dsl-file slides/01.slide
slidep upsert-dsl output.pptx --dsl-file slides/01.slide --page-index 0
```

---

## slidep inspect

将 PPT/PPTX 转成 Markdown，供理解和问答流程使用。解析过程不调用模型、不修改源文件。

```bash
slidep inspect <file> --out <path>
```

| 参数/选项 | 说明 |
|-----------|------|
| `<file>` | 本地 `.ppt` / `.pptx` 文件路径（必填） |
| `--out <path>` | 必填。指定尚不存在的 `.md` 文件，或指定新建/空目录；目录模式默认写入 `slides.md` |
| `--base-url <url>` | editor_sdk base URL（默认 `$TENCENT_DOCS_LOCAL_MCP` 或 `http://localhost:39099`） |
| `--timeout <ms>` | HTTP 超时毫秒数（默认 120000） |

行为要点：

- 成功时 stdout 为空；调用方读取 `--out` 指定的 Markdown 文件。
- `### 结构` 只写确定的关系：图表/表格上的标注、带起止引用的连接线、源文件中的“标题 + 正文”组。
- 线、箭头、自由形状、阶段色块等无法可靠解释的结构不写成关系；无法从文件结构确认时按信息不足处理。
- `.md` 目标已存在或输出目录非空时直接报错，不会覆盖或删除已有文件；需要重新生成时换一个 `--out`。

**示例**：

```bash
slidep inspect input.pptx --out ./input-review.md
slidep inspect input.pptx --out ./input-inspect
```
