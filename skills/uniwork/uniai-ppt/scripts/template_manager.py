# -*- coding: utf-8 -*-
"""
Template Manager for PPTX Pro Skill
Provides template matching and management capabilities.

Usage:
    python template_manager.py list                    # List all templates
    python template_manager.py match "modern blue"     # Match by style
    python template_manager.py info corporate-blue     # Get template info
    python template_manager.py add template.pptx       # Add new template

Template matching modes:
    1. Exact name match: User specifies template name directly
    2. Style match: User describes style, find best matching template
    3. Free style: No template, create from scratch
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import List, Dict, Optional, Tuple

# 模板目录分成"只读的内置"和"可写的用户"两处。
#
# 以前这里是 ``TEMPLATES_DIR = <技能根>/templates`` 外加一句 import 期的 ``mkdir()``——
# 于是连 ``template_manager.py list`` 这种纯读命令都会往技能安装目录里写东西，``add``
# 更是直接把用户的 pptx 拷进去。技能目录是只读的安装目录，会被技能市场的更新整个覆盖：
# 存进去的模板既可能被清掉，也可能被打进下一次分发包发给别人。
SCRIPT_DIR = Path(__file__).parent
BUILTIN_TEMPLATES_DIR = SCRIPT_DIR.parent / "templates"          # 只读，绝不往这写

def _user_templates_dir() -> Path:
    """用户模板目录：优先 PPTX_TEMPLATES_DIR，其次 HEXAGENT_DATA_DIR，最后当前工作目录。"""
    env = os.environ.get("PPTX_TEMPLATES_DIR")
    if env:
        return Path(env)
    data = os.environ.get("HEXAGENT_DATA_DIR")
    if data:
        return Path(data) / "ppt-templates"
    return Path.cwd() / "ppt-templates"

TEMPLATES_DIR = _user_templates_dir()                            # 唯一可写的那个


def _search_dirs() -> List[Path]:
    """查找顺序：用户目录优先（同名可覆盖内置），再内置目录。"""
    dirs = [TEMPLATES_DIR]
    if BUILTIN_TEMPLATES_DIR != TEMPLATES_DIR:
        dirs.append(BUILTIN_TEMPLATES_DIR)
    return [d for d in dirs if d.exists()]


def _ensure_writable_dir() -> Path:
    """只在**真的要写**的时候才建目录——纯读命令不该产生任何副作用。"""
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    return TEMPLATES_DIR


# Built-in style keywords for matching
STYLE_KEYWORDS = {
    # Professional/Business
    "professional": ["business", "corporate", "formal", "executive", "enterprise"],
    "corporate": ["business", "professional", "formal", "enterprise"],
    "business": ["professional", "corporate", "formal"],

    # Colors
    "blue": ["corporate", "professional", "tech", "trust"],
    "dark": ["modern", "elegant", "professional", "premium"],
    "light": ["clean", "minimal", "simple"],
    "colorful": ["creative", "vibrant", "modern"],
    "minimal": ["clean", "simple", "white", "light"],

    # Styles
    "modern": ["clean", "minimal", "tech", "contemporary"],
    "classic": ["traditional", "formal", "elegant"],
    "creative": ["artistic", "vibrant", "unique", "colorful"],
    "elegant": ["premium", "sophisticated", "refined"],
    "tech": ["technology", "modern", "blue", "digital"],
    "minimalist": ["minimal", "clean", "simple", "white"],

    # Industries
    "technology": ["tech", "modern", "blue", "digital"],
    "finance": ["professional", "corporate", "blue", "formal"],
    "education": ["clean", "simple", "colorful"],
    "medical": ["clean", "blue", "professional"],
    "marketing": ["creative", "colorful", "vibrant"],
}


def load_template_metadata(template_name: str) -> Optional[Dict]:
    """Load metadata for a template (user dir first, then built-ins)."""
    for d in _search_dirs():
        metadata_path = d / f"{template_name}.json"
        if metadata_path.exists():
            with open(metadata_path, "r", encoding="utf-8") as f:
                return json.load(f)
    return None


def save_template_metadata(template_name: str, metadata: Dict):
    """Save metadata for a template"""
    metadata_path = _ensure_writable_dir() / f"{template_name}.json"
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)


def list_templates() -> List[Dict]:
    """List all available templates with their metadata"""
    templates = []
    seen = set()
    for pptx_file in [f for d in _search_dirs() for f in sorted(d.glob("*.pptx"))]:
        template_name = pptx_file.stem
        if template_name in seen:
            continue          # 用户目录同名的优先，内置的跳过
        seen.add(template_name)
        metadata = load_template_metadata(template_name)
        if metadata:
            templates.append({
                "name": template_name,
                "path": str(pptx_file),
                **metadata
            })
        else:
            # Auto-generate basic metadata
            templates.append({
                "name": template_name,
                "path": str(pptx_file),
                "display_name": template_name.replace("-", " ").replace("_", " ").title(),
                "style_tags": [],
                "description": "No description available",
            })
    return templates


def match_template(query: str) -> Tuple[Optional[str], str]:
    """
    Match a template by name or style description.

    Returns:
        Tuple of (template_name, match_type)
        - template_name: Name of matched template, or None for free style
        - match_type: "exact", "style", or "free"
    """
    query_lower = query.lower().strip()

    # Check for free style indicators
    free_style_indicators = ["free style", "freestyle", "no template", "none", "scratch", "自由", "不使用模板", "空白"]
    for indicator in free_style_indicators:
        if indicator in query_lower:
            return None, "free"

    # Get all templates
    templates = list_templates()
    if not templates:
        return None, "free"

    # 1. Try exact name match
    for template in templates:
        if template["name"].lower() == query_lower:
            return template["name"], "exact"
        if query_lower in template["name"].lower():
            return template["name"], "exact"

    # 2. Try style matching
    query_words = query_lower.replace("-", " ").replace("_", " ").split()
    best_match = None
    best_score = 0

    for template in templates:
        style_tags = template.get("style_tags", [])
        if not style_tags:
            continue

        score = 0
        for word in query_words:
            # Direct tag match
            if word in [t.lower() for t in style_tags]:
                score += 2
            # Keyword expansion match
            if word in STYLE_KEYWORDS:
                expanded = STYLE_KEYWORDS[word]
                for tag in style_tags:
                    if tag.lower() in expanded:
                        score += 1

        if score > best_score:
            best_score = score
            best_match = template["name"]

    if best_match and best_score >= 1:
        return best_match, "style"

    # 3. No match found, suggest free style
    return None, "free"


def get_template_info(template_name: str) -> Optional[Dict]:
    """Get detailed info about a template"""
    template_path = next((d / f"{template_name}.pptx" for d in _search_dirs()
                          if (d / f"{template_name}.pptx").exists()),
                         TEMPLATES_DIR / f"{template_name}.pptx")
    if not template_path.exists():
        return None

    metadata = load_template_metadata(template_name) or {}

    return {
        "name": template_name,
        "path": str(template_path),
        "exists": True,
        "display_name": metadata.get("display_name", template_name),
        "style_tags": metadata.get("style_tags", []),
        "description": metadata.get("description", "No description"),
        "slides_count": metadata.get("slides_count", "unknown"),
        "layouts": metadata.get("layouts", []),
    }


def add_template(pptx_path: str, display_name: str = None, style_tags: List[str] = None,
                 description: str = None) -> str:
    """Add a new template to the templates directory"""
    source_path = Path(pptx_path)
    if not source_path.exists():
        return f"Error: Template file not found: {pptx_path}"

    if not source_path.suffix.lower() == ".pptx":
        return f"Error: File must be a .pptx file"

    template_name = source_path.stem.lower().replace(" ", "-").replace("_", "-")
    dest_path = _ensure_writable_dir() / f"{template_name}.pptx"

    # Copy template file
    shutil.copy2(source_path, dest_path)

    # Create metadata
    metadata = {
        "name": template_name,
        "display_name": display_name or source_path.stem.replace("-", " ").replace("_", " ").title(),
        "style_tags": style_tags or [],
        "description": description or f"Template added from {source_path.name}",
        "slides_count": "unknown",
        "layouts": [],
    }

    save_template_metadata(template_name, metadata)

    return f"Template '{template_name}' added successfully to {dest_path}"


def print_template_list():
    """Print formatted list of templates"""
    templates = list_templates()
    if not templates:
        print("No templates found.")
        print(f"User templates dir : {TEMPLATES_DIR}")
        print(f"Built-in templates : {BUILTIN_TEMPLATES_DIR} (read-only)")
        print("\nTo add a template, use:")
        print("  python template_manager.py add template.pptx")
        return

    print(f"\nAvailable Templates ({len(templates)}):\n")
    print(f"{'Name':<25} {'Display Name':<30} {'Style Tags'}")
    print("-" * 80)
    for t in templates:
        tags = ", ".join(t.get("style_tags", [])) or "none"
        print(f"{t['name']:<25} {t.get('display_name', t['name']):<30} {tags}")


def print_template_info(template_name: str):
    """Print detailed info about a template"""
    info = get_template_info(template_name)
    if not info:
        print(f"Template '{template_name}' not found.")
        return

    print(f"\nTemplate: {info['display_name']}")
    print(f"Internal name: {info['name']}")
    print(f"Path: {info['path']}")
    print(f"Description: {info['description']}")
    print(f"Style tags: {', '.join(info['style_tags']) or 'none'}")
    print(f"Slides count: {info['slides_count']}")
    print(f"Layouts: {', '.join(info['layouts']) or 'unknown'}")


def main():
    parser = argparse.ArgumentParser(description="Template Manager for PPTX Pro")
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # List command
    subparsers.add_parser("list", help="List all templates")

    # Match command
    match_parser = subparsers.add_parser("match", help="Match template by name or style")
    match_parser.add_argument("query", help="Template name or style description")

    # Info command
    info_parser = subparsers.add_parser("info", help="Get template info")
    info_parser.add_argument("name", help="Template name")

    # Add command
    add_parser = subparsers.add_parser("add", help="Add new template")
    add_parser.add_argument("file", help="Path to .pptx template file")
    add_parser.add_argument("--name", help="Display name")
    add_parser.add_argument("--tags", nargs="+", help="Style tags")
    add_parser.add_argument("--description", help="Template description")

    args = parser.parse_args()

    if args.command == "list":
        print_template_list()

    elif args.command == "match":
        template_name, match_type = match_template(args.query)
        if template_name:
            print(f"Matched template: {template_name}")
            print(f"Match type: {match_type}")
            print_template_info(template_name)
        else:
            print(f"No template matched for '{args.query}'")
            print("Will create presentation from scratch (free style).")

    elif args.command == "info":
        print_template_info(args.name)

    elif args.command == "add":
        result = add_template(args.file, args.name, args.tags, args.description)
        print(result)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
