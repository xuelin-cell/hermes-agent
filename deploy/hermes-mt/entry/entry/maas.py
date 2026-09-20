"""MaaS 上游：图形验证码 → 短信发码 → 短信登录 → 套餐（my-plan）。

契约来自旧系统实际在跑的代码（不是文档）：
- 登录三条接口在 ``{maas_app}/login/*``，**没有** ``/gateway/``；
- 套餐在 ``{maas_app}/gateway/uniwork/my-plan``，**有** ``/gateway/``；
- JWT 我们不验签也不解码，只信登录那一跳；过期时间按上游返回的 ``expiresAt``（毫秒）
  或 ``expireIn``/``expires_in``（秒）算；
- my-plan 返回的 ``models`` 是一段 JSON **字符串**，不是嵌套对象；
- 上游对「没 token / 坏 token」回 500 而不是 401。
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import aiohttp

from .config import Settings

log = logging.getLogger("entry.maas")


class MaasError(Exception):
    def __init__(self, message: str, status: int = 502, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


@dataclass
class LoginResult:
    uid: str
    token: str
    expires_at_ms: int
    raw: dict = field(default_factory=dict)


@dataclass
class Plan:
    api_key: str
    models: list[dict]
    main_model_id: str
    raw: dict = field(default_factory=dict)

    def main_model(self) -> dict | None:
        """套餐指定的主模型条目；没指定就取第一个。"""
        if not self.models:
            return None
        if self.main_model_id:
            for m in self.models:
                if str(m.get("id", "")) == str(self.main_model_id):
                    return m
        return self.models[0]

    def endpoint(self) -> tuple[str, str]:
        """(base_url, model_name)，base_url 已补上末尾的 ``/v1``。

        ★ 必须用 my-plan 给的 base_url，不能用手写的通用网关地址：套餐 key 只在
        它自己的 **TokenPlan 专用路径** 上有效，打通用路径会被网关回
        ``{"code":1004,"msg":"当前请求路径错误，请使用 TokenPlan 专用路径发起请求"}``。
        ★ 上游给的 base_url **少末尾 `/v1`**，OpenAI 兼容传输会直接拼 ``chat/completions``，
        不补就 404。
        """
        m = self.main_model() or {}
        base = str(m.get("base_url", "") or "").rstrip("/")
        if base and not base.endswith("/v1"):
            base += "/v1"
        return base, str(m.get("model") or m.get("id") or "")

    def catalog(self) -> list[tuple[str, str]]:
        """套餐里全部可用模型：[(模型名, base_url 已补 /v1), …]，去重保序。

        ★ 不能只写主模型：界面的模型下拉是从 config.yaml 的 ``providers.<key>.models``
        来的，只写一个，用户就只看得到一个，套餐里其他模型等于不存在。
        """
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        for m in self.models:
            name = str(m.get("model") or m.get("id") or "").strip()
            base = str(m.get("base_url", "") or "").rstrip("/")
            if base and not base.endswith("/v1"):
                base += "/v1"
            if not name or name in seen:
                continue
            seen.add(name)
            out.append((name, base))
        return out

    def summary(self) -> str:
        """能安全写进日志的一行（绝不含 key）。"""
        base, model = self.endpoint()
        listed = ", ".join(f"{n}@{b or '?'}" for n, b in self.catalog())
        return f"models={len(self.models)} main={model or '?'} base_url={base or '?'} catalog=[{listed}]"


class Maas:
    def __init__(self, settings: Settings, session: aiohttp.ClientSession):
        self.s = settings
        self.http = session
        self.timeout = aiohttp.ClientTimeout(total=settings.upstream_timeout_s)

    async def _json(self, method: str, url: str, *, json_body: Any = None, token: str = "") -> Any:
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            async with self.http.request(method, url, json=json_body, headers=headers, timeout=self.timeout) as resp:
                text = await resp.text()
                if resp.status >= 400:
                    # 上游 4xx/5xx 的真正原因在响应体里，日志必须带上（截断），否则每次失败记录都一样。
                    log.warning("maas %s %s -> %s %s", method, url, resp.status, text[:300])
                    raise MaasError(f"上游 {resp.status}", status=502, payload=text[:300])
                try:
                    return json.loads(text)
                except json.JSONDecodeError as exc:
                    raise MaasError("上游返回不是 JSON", status=502, payload=text[:200]) from exc
        except aiohttp.ClientError as exc:
            log.warning("maas %s %s network error: %s", method, url, exc)
            raise MaasError(f"上游不可达: {type(exc).__name__}", status=502) from exc

    async def captcha(self) -> dict:
        data = await self._json("GET", f"{self.s.maas_app}/login/captcha")
        return data

    async def send_code(self, phone: str, captcha_code: str, captcha_id: str) -> dict:
        body = {"phone": phone, "captchaCode": captcha_code, "captchaId": captcha_id}
        return await self._json("POST", f"{self.s.maas_app}/login/sendCode", json_body=body)

    async def sms_login(self, phone: str, sms_code: str) -> LoginResult:
        body = {
            "phone": phone,
            "smsCode": sms_code,
            "origin": "app",
            "application": self.s.login_application,
        }
        data = await self._json("POST", f"{self.s.maas_app}/login/smsLogin", json_body=body)
        if not isinstance(data, dict):
            raise MaasError("登录响应形状不对", status=502)
        if data.get("code") not in (0, "0", None):
            # 业务失败（验证码错等）原样透传给前端
            raise MaasError(str(data.get("msg") or "登录失败"), status=401, payload=data)
        payload = data.get("data") if isinstance(data.get("data"), dict) else data
        uid = str(payload.get("uid") or "").strip()
        token = str(payload.get("token") or "").strip()
        if not uid or not token:
            raise MaasError("登录响应缺少 uid/token", status=502)
        now_ms = int(time.time() * 1000)
        expires_at = payload.get("expiresAt")
        if isinstance(expires_at, (int, float)) and expires_at > 0:
            expires_at_ms = int(expires_at)
        else:
            expire_in = payload.get("expireIn", payload.get("expires_in"))
            if isinstance(expire_in, (int, float)) and expire_in > 0:
                expires_at_ms = now_ms + int(expire_in) * 1000
            else:
                raise MaasError("登录响应缺少有效期", status=502)
        if expires_at_ms <= now_ms:
            raise MaasError("登录 token 已过期", status=502)
        return LoginResult(uid=uid, token=token, expires_at_ms=expires_at_ms, raw=payload)

    async def my_plan(self, token: str) -> Plan | None:
        """拿这个用户自己的模型 key。没套餐 = 真没凭据，返回 None，不用平台 key 兜底。"""
        try:
            data = await self._json("GET", self.s.myplan_url, token=token)
        except MaasError as exc:
            log.warning("my-plan 失败: %s", exc)
            return None
        payload = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), dict) else data
        if not isinstance(payload, dict):
            return None
        api_key = str(payload.get("apiKey") or "").strip()
        models_raw = payload.get("models")
        models: list[dict] = []
        main_model_id = ""
        if isinstance(models_raw, str) and models_raw.strip():
            try:
                parsed = json.loads(models_raw)
            except json.JSONDecodeError:
                parsed = {}
        elif isinstance(models_raw, dict):
            parsed = models_raw
        else:
            parsed = {}
        if isinstance(parsed, dict):
            models = [m for m in parsed.get("models", []) if isinstance(m, dict)]
            main_model_id = str(parsed.get("main_model_id") or "")
        if not api_key:
            return None
        return Plan(api_key=api_key, models=models, main_model_id=main_model_id, raw={k: v for k, v in payload.items() if k != "apiKey"})
