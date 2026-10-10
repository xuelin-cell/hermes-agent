import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from hermes_cli.web_routers import uniwork_auth


def test_sms_login_owns_application_fields():
    with patch.object(uniwork_auth, "_proxy", new=AsyncMock(return_value={"code": 0})) as proxy:
        result = asyncio.run(
            uniwork_auth.sms_login(
                uniwork_auth.SmsLoginRequest(phone="13800138000", smsCode="123456")
            )
        )

    assert result == {"code": 0}
    proxy.assert_awaited_once_with(
        "POST",
        "/gateway/login/smsLogin",
        json={
            "phone": "13800138000",
            "smsCode": "123456",
            "origin": "app",
            "application": "uniwork",
        },
    )


def test_send_code_rejects_invalid_phone_before_upstream():
    with patch.object(uniwork_auth, "_proxy", new=AsyncMock()) as proxy:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                uniwork_auth.send_code(
                    uniwork_auth.CaptchaCodeRequest(
                        phone="123", captchaCode="abcd", captchaId="captcha-id"
                    )
                )
            )

    assert exc.value.status_code == 422
    proxy.assert_not_awaited()
