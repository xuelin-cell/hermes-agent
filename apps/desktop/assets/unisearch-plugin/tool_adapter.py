"""网页工具的 Profile 适配：套件独立策略，其他后端保留原生执行。"""

from __future__ import annotations

import asyncio
import copy
import json
import logging

from agent.web_search_registry import get_provider
from hermes_cli.config import get_config_path
from registration_lifecycle import replacement_coordinator
from tools import web_tools as native
from tools import web_tools_extract as extract_helpers
from tools import web_tools_truncate as output_helpers
from tools.interrupt import is_interrupted
from tools.registry import registry, tool_error
from tools.url_safety import async_is_safe_url
from tools.website_policy import check_website_access

logger = logging.getLogger(__name__)


def register_tools(ctx):
    """使用原生授权与生命周期注册，仅补本插件新建对象的原工具元数据。"""
    # 与原生注册保持相同锁顺序；避免其他线程看到尚未补齐预算的注册项。
    with replacement_coordinator.transaction(), registry._lock:
        originals = {
            name: registry.get_entry(name) for name in ("web_search", "web_extract")
        }
        for name, original in originals.items():
            if original is None or original is not registry.snapshot_registration(name):
                raise RuntimeError(
                    "UniSearch cannot replace a competing web tool override"
                )
            if original.is_async != (name == "web_extract"):
                raise RuntimeError(
                    "UniSearch web tool execution contract is incompatible"
                )
        for name, original in originals.items():
            handler = (
                _search_handler(original)
                if name == "web_search"
                else _extract_handler(original)
            )
            ctx.register_tool(
                name=name,
                toolset=original.toolset,
                schema=copy.deepcopy(original.schema),
                handler=handler,
                check_fn=original.check_fn,
                requires_env=list(original.requires_env),
                is_async=original.is_async,
                description=original.description,
                emoji=original.emoji,
                override=True,
            )
            replacement = registry.get_entry(name)
            if replacement is original or replacement.handler is not handler:
                raise RuntimeError("UniSearch profile tool registration failed")
            # 当前 ctx 接口未透传这两项；不修改原生全局对象或原生函数。
            replacement.max_result_size_chars = original.max_result_size_chars
            replacement.dynamic_schema_overrides = original.dynamic_schema_overrides


def _search_handler(original):
    """套件跳过统一缓存及救援；其他后端原样调用先前的原生函数。"""

    def handle(args, **kwargs):
        """保持原生参数预算和中断语义，再调用当前 Profile 的 Provider。"""
        if native._get_search_backend() != "unisearch":
            return original.handler(args, **kwargs)
        if is_interrupted():
            return tool_error("Interrupted", success=False)
        try:
            limit = min(max(int(args.get("limit", 5)), 1), 100)
        except (TypeError, ValueError):
            limit = 5
        provider = get_provider("unisearch")
        if provider is None:
            return tool_error("UniSearch provider unavailable", success=False)
        return json.dumps(
            provider.search(args.get("query", ""), limit=limit), ensure_ascii=False
        )

    return handle


def _policy_block(url):
    """显式绑定当前配置检查网站策略，缓存命中不得跳过此检查。"""
    try:
        return check_website_access(url, config_path=get_config_path())
    except Exception as exc:
        # 与原生网站策略的配置错误处理一致，不在诊断中输出 URL 或配置原文。
        logger.debug("Website policy check failed: %s", type(exc).__name__)
        return None


async def _extract_owned(provider, urls):
    """保留整批等待上限与取消传播；套件失败不进入其他服务的救援。"""
    try:
        call = provider.extract(urls, format="markdown")
        timeout = extract_helpers._extract_timeout_seconds()
        return await asyncio.wait_for(call, timeout) if timeout > 0 else await call
    except asyncio.CancelledError:
        raise
    except TimeoutError:
        return [extract_helpers._result_entry(url, "Extract timed out") for url in urls]
    except Exception as exc:
        logger.debug("Owned extract failed: %s", type(exc).__name__)
        return [extract_helpers._result_entry(url, "Extract failed") for url in urls]


def _extract_handler(original):
    """复用原生 URL 与正文处理，仅分离套件调用的缓存及失败救援。"""

    async def handle(args, **kwargs):
        """在 Provider 缓存之前完成安全与当前 Profile 网站策略检查。"""
        backend = native._get_extract_backend()
        if backend not in {"builtin_parse", "unicrawl"}:
            return await original.handler(args, **kwargs)
        urls = args.get("urls", [])[:5] if isinstance(args.get("urls"), list) else []
        normalized, positions, invalid, blocked = (
            extract_helpers._validate_extract_urls(urls)
        )
        if blocked is not None:
            return blocked
        provider = get_provider(backend)
        if provider is None:
            return tool_error("Fetch provider unavailable", success=False)
        fixed = dict(invalid)
        fetch_urls, fetch_positions = [], []
        for position, url in zip(positions, normalized):
            if not await async_is_safe_url(url):
                fixed[position] = extract_helpers._result_entry(
                    url,
                    "Blocked: URL targets a private or internal network address",
                )
                continue
            policy = _policy_block(url)
            if policy is not None:
                fixed[position] = {
                    **extract_helpers._result_entry(url, policy["message"]),
                    "blocked_by_policy": True,
                }
                continue
            fetch_urls.append(url)
            fetch_positions.append(position)
        if is_interrupted():
            return tool_error("Interrupted", success=False)
        results = await _extract_owned(provider, fetch_urls) if fetch_urls else []
        merged = extract_helpers._merge_in_order(
            len(urls), fixed, fetch_positions, fetch_urls, results
        )
        debug = {"pages_truncated": 0, "truncation_metrics": []}
        output_helpers._truncate_results(
            merged, output_helpers._effective_char_limit(args.get("char_limit")), debug
        )
        trimmed = output_helpers._trim_results(merged)
        if not trimmed:
            return tool_error("Content was inaccessible or not found")
        body = {
            "results": trimmed,
            "provider": provider.name,
            "provider_display_name": provider.display_name,
        }
        return output_helpers.convert_base64_images_to_links(
            json.dumps(body, ensure_ascii=False)
        )

    return handle
