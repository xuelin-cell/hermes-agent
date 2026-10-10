import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from hermes_cli.web_routers import uniwork_drive


def test_drive_route_allowlist_rejects_arbitrary_target():
    request = uniwork_drive.DriveRequest(
        login="jwt", phone="13800138000", route="/admin/secrets", method="GET"
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(uniwork_drive.drive_request(request))
    assert exc.value.status_code == 403


def test_drive_request_keeps_access_token_server_side():
    response = MagicMock()
    response.status_code = 200
    response.is_success = True
    response.json.return_value = {
        "ok": True,
        "status": "succeeded",
        "data": {"items": []},
    }
    client = AsyncMock()
    client.request.return_value = response
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=client)
    context.__aexit__ = AsyncMock(return_value=None)
    request = uniwork_drive.DriveRequest(
        login="login-jwt", phone="13800138000", route="/asset-spaces", method="GET"
    )

    with patch.object(
        uniwork_drive, "_access_token", new=AsyncMock(return_value="cloud-secret")
    ), patch.object(uniwork_drive.httpx, "AsyncClient", return_value=context):
        result = asyncio.run(uniwork_drive.drive_request(request))

    assert result["data"] == {"items": []}
    assert "cloud-secret" not in str(result)
    assert (
        client.request.await_args.kwargs["headers"]["X-Drive-Access-Token"]
        == "cloud-secret"
    )


def test_drive_read_refreshes_rejected_cloud_token_and_retries_once():
    rejected = MagicMock(status_code=502, is_success=False)
    succeeded = MagicMock(status_code=200, is_success=True)
    request = uniwork_drive.DriveRequest(
        login="login-jwt", phone="13800138000", route="/assets?space_id=personal", method="GET"
    )
    upstream = AsyncMock(
        side_effect=[
            (rejected, {"ok": False, "error": {"code": "UPSTREAM_REJECTED", "provider_code": "9999"}}),
            (succeeded, {"ok": True, "status": "succeeded", "data": {"items": []}}),
        ]
    )
    tokens = AsyncMock(side_effect=["old-cloud-token", "new-cloud-token"])

    with patch.object(uniwork_drive, "_access_token", new=tokens), patch.object(
        uniwork_drive, "_upstream_request", new=upstream
    ):
        result = asyncio.run(uniwork_drive.drive_request(request))

    assert result["data"] == {"items": []}
    assert upstream.await_count == 2
    assert upstream.await_args_list[0].args[2] == "old-cloud-token"
    assert upstream.await_args_list[1].args[2] == "new-cloud-token"
    assert tokens.await_args_list[1].kwargs == {"force": True}


def test_drive_token_cache_is_scoped_to_login_session():
    assert uniwork_drive._cache_key("13800138000", "login-a") != uniwork_drive._cache_key(
        "13800138000", "login-b"
    )


def test_drive_preview_rejects_unsupported_or_large_files():
    with pytest.raises(HTTPException) as unsupported:
        asyncio.run(
            uniwork_drive.materialize_drive_preview(
                uniwork_drive.DrivePreviewRequest(
                    login="jwt", phone="13800138000", asset_id="a", name="archive.zip"
                )
            )
        )
    assert unsupported.value.status_code == 415

    with pytest.raises(HTTPException) as too_large:
        asyncio.run(
            uniwork_drive.materialize_drive_preview(
                uniwork_drive.DrivePreviewRequest(
                    login="jwt",
                    phone="13800138000",
                    asset_id="a",
                    name="report.pdf",
                    size_bytes=21 * 1024 * 1024,
                )
            )
        )
    assert too_large.value.status_code == 413


def test_drive_preview_materializes_bounded_file(tmp_path):
    request = uniwork_drive.DrivePreviewRequest(
        login="jwt",
        phone="13800138000",
        asset_id="asset-1",
        fid="fid-1",
        name="季度报告.pdf",
        size_bytes=4,
    )
    proxy = AsyncMock(
        return_value={
            "ok": True,
            "data": {"download_path": "/drive/content?fid=fid-1"},
        }
    )

    with patch.object(uniwork_drive, "drive_request", new=proxy), patch.object(
        uniwork_drive, "_access_token", new=AsyncMock(return_value="cloud-token")
    ), patch.object(
        uniwork_drive, "_download_preview_bytes", new=AsyncMock(return_value=b"%PDF")
    ) as download, patch.object(uniwork_drive, "get_hermes_home", return_value=tmp_path):
        result = asyncio.run(uniwork_drive.materialize_drive_preview(request))

    materialized = tmp_path / "cache" / "drive-previews" / Path(result["path"]).name
    assert materialized.read_bytes() == b"%PDF"
    assert result["name"] == "季度报告.pdf"
    assert download.await_args.args[0].endswith("/clouddrive/v1/drive/content?fid=fid-1")
