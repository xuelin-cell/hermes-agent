# uniai-xlsx 技能体检与整修（2026-08-14）

> 本技能原名 `excel`，2026-08-14 更名为 `uniai-xlsx`。

体检方法与 `uniai-docx` 相同：不看文档说什么，把每条规则和每段样例代码实际跑一遍。
结论也相同——**排版与财务规则写得很好，执行链有洞**。

## P0（已修）

| # | 问题 | 实测证据 | 处理 |
|---|---|---|---|
| 1 | `recalc.py` 没装 LibreOffice 时直接崩 | `FileNotFoundError: [Errno 2] No such file or directory: 'soffice'`——SKILL.md 明明写了兜底路径，但脚本走不到那里，模型拿到的是 traceback 而不是"该走兜底了"的信号 | 新增 `find_soffice()`（三平台常见路径 + `SOFFICE_BIN` 覆盖），缺失时返回 `{"status":"no_soffice","fallback":...}` |
| 2 | 声明支持 win32，宏目录却只有 macOS/Linux | `MACRO_DIR_MACOS if Darwin else MACRO_DIR_LINUX`——Windows 会去写 `~/.config/libreoffice/...`，宏永远装不上，重算永远失败 | 新增 `user_profile_dir()`，Windows 走 `%APPDATA%\LibreOffice\4\user` |
| 3 | SKILL.md 的样例片段违反自己的硬规则 | `if isinstance(c.value,(int,float)): 右对齐` —— 公式单元格的值是字符串 `'=SUM(...)'`，`isinstance` 为假 → **合计行永远不会被右对齐**，实测 `B5.alignment.horizontal is None`，而技能自己写着"数字列左对齐 = 不合格" | `style_table()` 改为**按列**判定；SKILL.md 里把这个坑写明 |
| 4 | 重算结果可能是假的 | `if "Module1" in error_msg or "RecalculateAndSave" not in error_msg` —— 任何普通错误消息都不含后者，于是几乎总是返回"macro not configured properly"，真实错因被吞掉；另外没有校验重算**是否真的发生过** | 错误分支重写；新增 `recalculated` 判定：公式格在 `data_only` 视图里全是 `None` 就是没算过，返回 `status: not_recalculated` |

## 新增

- **`scripts/xlsx_helpers.py`** —— 把"美观硬规则"变成函数：`add_title` / `write_table` /
  `add_total_row`（合计写公式）/ `style_table`（着色+数字格式+按列对齐+细边框+斑马纹+冻结）/
  `autofit_columns`（中文按 2 倍宽估，跳过标题合并格，否则一个长标题能把 A 列撑到 38 字符宽）/
  财务模型配色 `mark_input` / `mark_formula` / `mark_link`。主题色与 `uniai-docx` 同一套。
- **`scripts/check_xlsx.py`** —— 交付闸门，只依赖 openpyxl：派生值被硬编码成数字、
  公式错误、裸表头、数字列左对齐、缺数字格式、没冻结、中文用西文字体、列宽裁字、
  数据区合并单元格、强调色超标、公式未重算。对照测试：一份典型烂表 7 ERROR / 6 WARN 全命中，
  helper 产物 0 ERROR。
- **`scripts/selftest.py`** —— 五个主题各出样张 → 跑规则 → 验不变量（合计是公式、
  公式格右对齐、数字格式、冻结位置、表头配色、中文字体、列宽、无数据区合并）
  → 校验 SKILL.md 与代码一致。不依赖 LibreOffice。

## 经验（与 uniai-docx 完全一致的两条）

1. **规则给了、手段没给 = 模型必然违规。** 这次是"数字列必须右对齐"配了一段做不到这件事的
   样例代码——比不给还糟，因为看起来是对的。
2. **降级路径必须是结构化返回值，不是 traceback。** 文档里写了兜底不算数，
   脚本得真的走到那一步并把选项摆出来。

## 验证方式

```bash
python scripts/selftest.py                  # 全绿
python scripts/check_xlsx.py out.xlsx       # 单份工作簿的交付闸门
python scripts/recalc.py     out.xlsx       # 需要 LibreOffice；没有时返回 no_soffice + 兜底指引
```

体检环境：macOS 26.6、Python 3.9、openpyxl 3.1.5、pandas 2.3.3，**无 LibreOffice**。
因此 `recalc.py` 只验证了工具发现与降级路径，**真实重算链路（装宏 → 跑宏 → 回读缓存值）
未在本机跑通**；装上 LibreOffice 后应补一次真实重算确认。
