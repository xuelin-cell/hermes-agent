"""Model selection for Desktop sessions backed by the UniWork account catalog."""

from dataclasses import dataclass


@dataclass(frozen=True)
class _Target:
    model: str
    provider: str

    @classmethod
    def read(cls, value):
        value = value if isinstance(value, dict) else {}
        return cls(str(value.get("model") or "").strip(), str(value.get("provider") or "").strip().lower())

    def matches(self, other):
        return self.model == other.model and self.provider.removeprefix("custom:") == other.provider.removeprefix("custom:")


def _catalog_target(cfg: dict, plan: dict, current: _Target, selection: dict | None) -> _Target:
    # Match the endpoint API used by the composer, including its legacy/custom endpoint order.
    from hermes_cli.web_routers.config_env import _custom_endpoint_response

    endpoints = _custom_endpoint_response(cfg)["endpoints"]
    by_provider = {f"custom:{row['id'].lower()}": row for row in endpoints}
    models, selectable = [], []
    fast_config = plan.get("fast")
    fast = _Target.read(fast_config)
    fast_id = fast_config.get("id") if isinstance(fast_config, dict) else None
    for value in plan["models"]:
        target = _Target.read(value)
        endpoint = by_provider.get(target.provider)
        if target.model and endpoint and target.model in endpoint["models"]:
            models.append(target)
            is_fast = value.get("id") == fast_id if fast_id else target.matches(fast)
            if not is_fast:
                selectable.append(target)
    custom = [
        _Target(row["model"], "custom" if row["source"] == "direct-config" else f"custom:{row['id'].lower()}")
        for row in endpoints if not row["id"].startswith("desktop-mt-maas-") and row["model"]
    ]
    models.extend(custom)
    selectable.extend(custom)
    for candidate, choices in (
        (current, models), (_Target.read(selection), selectable), (_Target.read(plan.get("main")), models)
    ):
        if target := next((item for item in choices if item.matches(candidate)), None):
            return target
    # The client takes the first selectable model; the backend also accepts the
    # first full-catalog entry when the selectable list is empty.
    if selection is not None and selectable:
        return selectable[0]
    if models:
        return models[0]
    raise ValueError("No available model in the UniWork catalog.")


def _configured_catalog(session: dict, current: _Target):
    if session.get("source") != "desktop" or session.get("follow_profile_config"):
        return None
    # With no composer request, keep native provider choices (e.g. Developer Mode).
    if (session.get("uniwork_model_selection") is None and current.model
            and current.provider != "custom" and not current.provider.startswith("custom:")):
        return None
    from tui_gateway.server import _load_cfg

    cfg = _load_cfg()
    plan = cfg.get("uniwork_model_catalog")
    if isinstance(plan, dict) and isinstance(plan.get("models"), list):
        return cfg, plan
    return None


def prepare_deferred_model(session: dict, kwargs: dict) -> None:
    """A retired provider must be resolved before a cold session builds its agent."""
    if session.get("source") != "desktop":
        return
    override = kwargs.get("model_override") or session.get("model_override") or {}
    if not isinstance(override, dict) or override.get("code_mode"):
        return
    from tui_gateway.server import _config_model_target

    current = _Target.read(override)
    if not current.model:
        model, provider = _config_model_target()
        current = _Target(model, provider)
    if not (catalog := _configured_catalog(session, current)):
        return
    target = _catalog_target(*catalog, current, {})
    if not target.matches(current) or (override and not kwargs.get("model_override")):
        kwargs["model_override"] = {"model": target.model, "provider": target.provider}
        kwargs.pop("provider_override", None)
        session["uniwork_model_before_fallback"] = current


def prepare_turn_model(session: dict, turn) -> bool:
    """Resolve the latest catalog under the session's profile scope before inference."""
    agent = session["agent"]
    if getattr(agent, "_desktop_code_mode", False):
        return False
    model = str(getattr(agent, "model", "") or "")
    provider = str(getattr(agent, "provider", "") or "").lower()
    if provider == "custom":
        requested = str(getattr(agent, "requested_provider", "") or "").lower()
        if requested.startswith("custom:"):
            provider = requested
        else:
            from hermes_cli.runtime_provider_custom import canonical_custom_identity
            provider = canonical_custom_identity(base_url=getattr(agent, "base_url", None), model=model) or provider
    live = _Target(model, provider)
    saved = _Target.read(session.get("model_override"))
    current = saved if saved.model and not turn.one_turn_restore else live
    if not saved.model and not turn.one_turn_restore:
        current = session.get("uniwork_model_before_fallback", live)
    if not (catalog := _configured_catalog(session, current)):
        return False

    target = _catalog_target(*catalog, current, session.get("uniwork_model_selection"))
    if not target.matches(live):
        from tui_gateway.model_switch import _snapshot_agent_model_runtime
        from tui_gateway.server import _resolve_agent_model_runtime

        model, runtime = _resolve_agent_model_runtime({"model": target.model, "provider": target.provider}, None)
        snapshot = _snapshot_agent_model_runtime(agent)
        # Keep the saved selection and avoid announcing a fallback as a manual switch.
        agent.switch_model(new_model=model, new_provider=runtime.get("requested_provider") or runtime["provider"],
                           api_key=runtime.get("api_key", ""), base_url=runtime.get("base_url", ""),
                           api_mode=runtime.get("api_mode"))
        turn.one_turn_restore = turn.one_turn_restore or snapshot
    return True
