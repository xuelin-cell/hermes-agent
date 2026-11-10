"""Read-only source inventory; writes metadata, never migrates product code.

Run from the Hermes checkout using its existing Python. The registry is loaded
under namespace-only parents so UniClaw's application initializers do not run.
This inspects the real ALL_RULES; it is not a test of UniClaw's complete runtime.
"""

from __future__ import annotations

import ast
from collections import Counter
import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import types


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def render_inventory(report, hermes):
    output = hermes / "plugins/security-guardrail/docs/migration-inventory.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Guardrail 迁移清单（阶段二任务 1）", "",
             "日期：2026-11-10。当前仅完成盘点，以下目标均为拟迁入位置，未复制引擎。", "",
             f"源提交：`{report['source_commit']}`；Hermes 基线：`{report['hermes_commit']}`。", "",
             "源目录、完整 SHA-256、函数起止行、包导入、规则定义和测试直接引用见 "
             "[机器清单](../../../docs/guardrail/evidence/phase2-task1/source-manifest.json)。" 
             "生成方式为 git 跟踪文件 + AST 符号 + 隔离父包后读取真实 ALL_RULES，未启动 UniClaw 产品，也未运行其全部测试。", "",
             "## 盘点结果", "",
             f"{report['counts']['engine_python']} 个 Python 文件、{report['counts']['resources']} 个资源、"
             f"{report['counts']['rules']} 条规则、{report['counts']['source_test_files']} 个源测试文件。另记源测试包标记、合成数据和 UniClaw 许可。", "",
             "规则分组：" + "，".join(f"{key}={value}" for key, value in report['rule_groups'].items()) + "。",
             "规则结果：" + "，".join(f"{key}={value}" for key, value in report['rule_verdicts'].items()) + "。", "",
             "## 文件及测试去向", "",
             "所有保留规则目前状态均为待迁入/待适配；表内“保留”是迁移决定，不表示运行时已生效。", "",
             "| 源文件（相对范围根） | 处理 | 拟目标 | SHA-256 前 12 位 |", "|---|---|---|---|"]
    labels = {"migrate_with_host_adaptation": "保留；任务 2 调整包/宿主依赖",
              "exclude_security_center": "排除：安全中心专用",
              "split_shared_and_product_dependencies": "混合文件，按下文拆分",
              "port_and_review_cases": "保留行为用例；逐例改写产品夹具/ASK 策略",
              "retain_attribution": "随插件保留来源许可",
              "exclude_test_package_marker": "不照搬源测试包标记，按 Hermes 测试布局组织"}
    for entry in report["files"]:
        source = Path(report["source_root"]) / entry["source"]
        name = entry["relative"]
        if entry["kind"].startswith("source_test") or entry["kind"] == "test_support":
            name = "tests/" + name
        target = f"`{entry['proposed_target']}`" if entry["proposed_target"] else "不迁移"
        lines.append(f"| [{name}]({source.as_posix()}) | {labels[entry['disposition']]} | {target} | `{entry['sha256'][:12]}` |")
    lines += ["", "## 混合代码、产品耦合与排除边界", "",
              "| 源位置/符号 | 处理决定 |", "|---|---|",
              "| context.py:79 audit_tool_input、107 _audit_file_body、116 _audit_field_size、121 _copy_audit_value、158 PermissionAuditRecord；所有仅供它们使用的 _AUDIT_* 常量 | 排除审计采集/裁剪及记录类型，不迁入日志写入、存储和查询链路。 |",
              "| context.py:198 ask_policy、200 recent_permission_decisions、201 audit_failed 及其类型导入 | 排除安全中心策略字段和审计字段。PermissionContext 其他模式、工作区、用户/会话规则及方法保留必要语义，由插件状态承接。 |",
              "| engine.py:25 configurable 导入、94/136 入口 ask_policy 参数、257 起配置化 ASK 分支 | 移除逐条设置依赖；保留硬拒绝→固定放行→可信来源→用户拒绝/允许→会话允许→AUTO→ASK→默认允许顺序。ASK 以直接基线承接，差异单列。 |",
              "| contract.py:32 ModelProfile、87 _current_profile、114 current_app_dir_protection、142 check_tool_permission | 移除产品类型/环境探测耦合；使用 Hermes 可信上下文显式传入档位、保护目录和来源。排除 ask_policy 参数依赖；保留通用输出和独立判断入口。 |",
              "| configurable/__init__.py、types.py、policy.py；test_configurable.py | 全部属于本次排除的逐条允许/询问/拒绝设置，不迁移。 |",
              "| test_audit_input.py | 随排除的审计采集功能不迁移。 |",
              "| test_build_profile_mapping.py | 逐例拆分：不迁入读取 UniClaw 安装脚本/后端源码的断言；保留规则组映射和命令行为，改成显式输入测试，不新增读取源码的测试。 |",
              "| test_public_all_ask_rules.py、test_public_ask_semantic_boundaries.py、test_public_ask_workspace_matrix.py、test_guardrail.py 等共享测试 | 不按文件名删除；去掉安全中心策略装配，保留通用规则、优先级、用户/会话与匹配行为。任务 2 逐例记录改写对应关系。 |",
              "| path_policy.py、detectors/shell/delete_exempt.py、trusted_installers.py、profile.py、vm_boundary.py、host_boundary.py | 保留检测与可追溯实现，产品路径、便携 sessions、MCP 缓存、技能脚本、可信安装器及 VM 例外需显式宿主信息；Hermes 不自动取得 UniClaw 豁免。 |",
              "| detectors/shell/audit.py | 保留：这是阻止停用系统审计/删除系统日志的检测器，不是安全中心审计日志采集。 |",
              "| sensitive_protection/** | 保留算法、参数模型、验证器、资源及许可。SensitivePolicySnapshot 是独立检测 API 的必要输入，不与被排除的 AskPolicySnapshot 混同。 |", "",
              "模块外安全中心页面、routes/security.py、permissions_store.py 及 security/audit_{service,writer,store}.py 不迁入。测试原样复制并不代表测试适用；源测试包 __init__.py 不自动复制到 Hermes 测试目录。", "",
              "### 已明确的语义差异", "",
              "原引擎未传安全中心 ask_policy 时，AUTO 之后不会检查 ASK 基线而默认允许；附件选择移除逐条设置后在 ASK 模式直接检查适用基线。此差异必须有迁移对照测试，不能称所有默认行为完全不变。其他意外判断变化是迁移回归。cwd 与 workspace_root 分开是宿主信息适配，原规则条件保留。", "",
              "## 原规则逐项登记", "",
              "按真实 ALL_RULES 注册顺序列出。动态命令规则通过真实 CommandPolicy 对象追到命令声明，机器清单记录生成方式。测试直接提及规则 ID 仅是定位线索，不等于该规则已通过测试；没有直接提及的规则在任务 2 按行为补对照。", "",
              "| 序 | 规则 ID | 原结果 | OS | 分组 | 定义位置 | 原测试直接引用文件数 | 状态 |", "|---|---|---|---|---|---|---|---|"]
    for rule in report["rules"]:
        loc = rule["source_definitions"][0]
        source = Path(report["source_root"]) / loc["path"]
        lines.append(f"| {rule['order'] + 1} | `{rule['id']}` | {rule['verdict']} | {','.join(rule['operating_systems'])} | {rule['group']} | [{Path(loc['path']).name}:{loc['line']}]({source.as_posix()}:{loc['line']}) | {len(rule['literal_test_references'])} | 定义保留；待任务 2 迁入 |")
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    hermes = Path(__file__).resolve().parents[4]
    source = Path(sys.argv[1]).resolve()
    prefix = "libs/hexagent/hexagent/harness/guardrail"
    tests_prefix = "libs/hexagent/tests/unit_tests/harness/guardrail"
    paths = git(source, "ls-files", prefix, tests_prefix,
                "libs/hexagent/tests/unit_tests/harness/test_guardrail.py", "LICENSE").splitlines()
    dirty = git(source, "status", "--porcelain", "--", *paths)
    if dirty:
        raise SystemExit("Source inventory requires clean tracked source/test/license files")
    files = []
    text_by_path = {}
    for name in paths:
        path = source / name
        raw = path.read_bytes()
        item = {"source": name, "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw), "state": "inventoried_not_migrated"}
        if name.startswith(prefix + "/"):
            rel = name[len(prefix) + 1:]
            disposition = "migrate_with_host_adaptation"
            if rel.startswith("configurable/"):
                disposition = "exclude_security_center"
            elif rel in {"context.py", "contract.py", "engine.py"}:
                disposition = "split_shared_and_product_dependencies"
            item.update(kind="engine" if path.suffix == ".py" else "resource",
                        relative=rel, disposition=disposition,
                        proposed_target=None if disposition.startswith("exclude") else
                        "plugins/security-guardrail/guardrail/" + rel)
        elif name.startswith("libs/hexagent/tests/"):
            rel = name[len(tests_prefix) + 1:] if name.startswith(tests_prefix + "/") else "test_guardrail.py"
            excluded = path.name in {"test_audit_input.py", "test_configurable.py"}
            item.update(kind="source_test" if path.name.startswith("test_") else "test_support",
                        relative=rel, disposition="exclude_security_center" if excluded else "port_and_review_cases",
                        proposed_target=None if excluded else "tests/plugins/security_guardrail/original/" + rel)
            if rel == "__init__.py":
                item.update(disposition="exclude_test_package_marker", proposed_target=None)
        else:
            item.update(kind="license", relative=name, disposition="retain_attribution",
                        proposed_target="plugins/security-guardrail/licenses/UNICLAW_LICENSE")
        if path.suffix == ".py":
            text = raw.decode("utf-8-sig")
            text_by_path[name] = text
            tree = ast.parse(text)
            item["symbols"] = [{"name": n.name, "line": n.lineno, "end_line": n.end_lineno}
                               for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))]
            imports = []
            for n in ast.walk(tree):
                if isinstance(n, ast.ImportFrom) and n.module and n.module.startswith("hexagent"):
                    imports.append(n.module)
            item["hexagent_imports"] = sorted(set(imports))
        files.append(item)

    base = source / prefix
    for module, directory in (("hexagent", base.parents[1]), ("hexagent.harness", base.parent),
                              ("hexagent.harness.guardrail", base)):
        package = types.ModuleType(module)
        package.__path__ = [str(directory)]
        sys.modules[module] = package
    registry = importlib.import_module("hexagent.harness.guardrail.baseline_rules.registry")
    schema = importlib.import_module("hexagent.harness.guardrail.tool_schema")
    literals = {}
    for name, text in text_by_path.items():
        if "/baseline_rules/" not in name:
            continue
        for n in ast.walk(ast.parse(text)):
            if isinstance(n, ast.Constant) and isinstance(n.value, str):
                literals.setdefault(n.value, []).append({"path": name, "line": n.lineno})
    rules = []
    for index, rule in enumerate(registry.ALL_RULES):
        definitions = literals.get(rule.id, [])
        definition_method = "literal_rule_id"
        if not definitions:
            commands = importlib.import_module("hexagent.harness.guardrail.baseline_rules.shell.commands")
            for policies in vars(commands).values():
                if not isinstance(policies, tuple):
                    continue
                for policy in policies:
                    if any(getattr(entry, "rule", None) is rule for entry in getattr(policy, "rules", ())):
                        definitions = literals.get(policy.canonical_name, [])
                        definition_method = "generated_id_from_command; matched real CommandPolicy rule identity"
                        if definitions:
                            break
                if definitions:
                    break
        if not definitions:
            raise SystemExit("No source definition for " + rule.id)
        group = "shell" if "/shell/" in definitions[0]["path"] else Path(definitions[0]["path"]).stem
        references = [name for name, text in text_by_path.items()
                      if name.startswith("libs/hexagent/tests/") and rule.id in text]
        rules.append({"order": index, "id": rule.id, "group": group,
                      "verdict": rule.verdict.value, "category": rule.category.value,
                      "reason": rule.reason, "rule_set": rule.rule_set.value,
                      "operating_systems": sorted(os.value for os in rule.operating_systems),
                      "source_definitions": definitions, "literal_test_references": references,
                      "definition_method": definition_method,
                      "disposition": "retain_definition", "migration_state": "pending_task_2",
                      "runtime_state": "not_adapted"})
    if len({r["id"] for r in rules}) != len(rules):
        raise SystemExit("Duplicate source rule ID")
    report = {"source_root": str(source), "source_commit": git(source, "rev-parse", "HEAD"),
              "hermes_commit": git(hermes, "rev-parse", "HEAD"), "source_tracked_scope_clean": True,
              "method": "git tracked files + SHA256 + AST symbols + isolated real ALL_RULES import; no full application startup",
              "counts": {"engine_python": sum(f["kind"] == "engine" for f in files),
                         "resources": sum(f["kind"] == "resource" for f in files),
                         "source_test_files": sum(f["kind"] == "source_test" for f in files),
                         "rules": len(rules)},
              "rule_groups": dict(Counter(r["group"] for r in rules)),
              "rule_verdicts": dict(Counter(r["verdict"] for r in rules)),
              "rule_tiers": dict(Counter(r["id"].split(".")[0] for r in rules)),
              "files": files, "rules": rules,
              "canonical_tools": {key: [v.value for v in value]
                                  for key, value in schema.CANONICAL_TOOL_CLASSIFICATION.items()}}
    target = Path(__file__).with_name("source-manifest.json")
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    render_inventory(report, hermes)
    print(json.dumps({"counts": report["counts"], "groups": report["rule_groups"],
                      "verdicts": report["rule_verdicts"], "files": len(files)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
