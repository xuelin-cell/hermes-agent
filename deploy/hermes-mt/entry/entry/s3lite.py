"""够用的 S3 客户端（SigV4 + aiohttp，不依赖 boto3）。

只给卷外副本任务用：读卷上的归档、往备份前缀写副本、列前缀、删旧副本。
对象键都是我们自己生成的 ASCII 路径，签名按 AWS 规范做，MinIO / 华为 OBS / AWS 都认。
凭据只在内存里，任何异常信息里都不带它。
"""

from __future__ import annotations

import hashlib
import hmac
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import quote, urlsplit

import aiohttp

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_CHUNK = 1024 * 1024


class S3Error(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"s3 {status}: {message}")
        self.status = status


def _uri_encode(text: str, keep_slash: bool) -> str:
    safe = "-_.~" + ("/" if keep_slash else "")
    return quote(text, safe=safe)


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def sign_v4(
    *,
    method: str,
    host: str,
    path: str,
    query: dict[str, str],
    headers: dict[str, str],
    payload_hash: str,
    access_key: str,
    secret_key: str,
    region: str,
    now: datetime,
    service: str = "s3",
) -> dict[str, str]:
    """返回要发出去的全部请求头（含 Authorization）。``path`` 是已经编码过的 URI 路径。"""
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    all_headers = {k.lower().strip(): v.strip() for k, v in headers.items()}
    all_headers["host"] = host
    all_headers["x-amz-date"] = amz_date
    all_headers["x-amz-content-sha256"] = payload_hash
    signed_names = sorted(all_headers)
    canonical_headers = "".join(f"{k}:{all_headers[k]}\n" for k in signed_names)
    signed_headers = ";".join(signed_names)
    canonical_query = "&".join(
        f"{_uri_encode(k, False)}={_uri_encode(v, False)}" for k, v in sorted(query.items())
    )
    canonical_request = "\n".join([
        method.upper(), path, canonical_query, canonical_headers, signed_headers, payload_hash,
    ])
    scope = f"{date}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    k_date = _hmac(("AWS4" + secret_key).encode("utf-8"), date)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    k_signing = _hmac(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    all_headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return all_headers


class S3Lite:
    def __init__(
        self,
        http: aiohttp.ClientSession,
        endpoint: str,
        bucket: str,
        access_key: str,
        secret_key: str,
        region: str = "us-east-1",
        path_style: bool = True,
    ):
        parts = urlsplit(endpoint)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError("S3 端点要写成 http(s)://host[:port]")
        self._http = http
        self._scheme = parts.scheme
        self._host = parts.netloc
        self._bucket = bucket
        self._ak = access_key
        self._sk = secret_key
        self._region = region
        self._path_style = path_style

    # ---- 请求拼装 ----------------------------------------------------------------

    def _target(self, key: str) -> tuple[str, str]:
        """返回 (host, 已编码的 URI 路径)。"""
        encoded_key = _uri_encode(key, True)
        if self._path_style:
            return self._host, f"/{self._bucket}/{encoded_key}" if key else f"/{self._bucket}/"
        return f"{self._bucket}.{self._host}", f"/{encoded_key}"

    def _headers(self, method: str, key: str, query: dict[str, str], payload_hash: str,
                 extra: dict[str, str] | None = None) -> tuple[str, dict[str, str]]:
        host, path = self._target(key)
        headers = sign_v4(
            method=method, host=host, path=path, query=query, headers=extra or {},
            payload_hash=payload_hash, access_key=self._ak, secret_key=self._sk,
            region=self._region, now=datetime.now(timezone.utc),
        )
        url = f"{self._scheme}://{host}{path}"
        if query:
            url += "?" + "&".join(f"{_uri_encode(k, False)}={_uri_encode(v, False)}" for k, v in sorted(query.items()))
        return url, headers

    @staticmethod
    async def _raise(resp: aiohttp.ClientResponse) -> None:
        text = (await resp.text())[:300]
        raise S3Error(resp.status, text.replace("\n", " "))

    # ---- 操作 ---------------------------------------------------------------------

    async def list(self, prefix: str) -> list[dict[str, Any]]:
        """列前缀下的全部对象：[{"key", "size", "last_modified"}]，自动翻页。"""
        out: list[dict[str, Any]] = []
        token = ""
        while True:
            query = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
            if token:
                query["continuation-token"] = token
            url, headers = self._headers("GET", "", query, EMPTY_SHA256)
            async with self._http.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                if resp.status != 200:
                    await self._raise(resp)
                root = ET.fromstring(await resp.text())
            ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
            for item in root.findall(f"{ns}Contents"):
                out.append({
                    "key": item.findtext(f"{ns}Key") or "",
                    "size": int(item.findtext(f"{ns}Size") or 0),
                    "last_modified": item.findtext(f"{ns}LastModified") or "",
                })
            if (root.findtext(f"{ns}IsTruncated") or "false").lower() != "true":
                return out
            token = root.findtext(f"{ns}NextContinuationToken") or ""
            if not token:
                return out

    async def head(self, key: str) -> dict[str, Any] | None:
        """对象的大小与用户元数据（``x-amz-meta-*``，键去掉前缀、小写）；不存在返回 None。

        s3fs 把文件的属主 / 权限 / 时间存在用户元数据里（uid、gid、mode、mtime）；
        往卷前缀写对象时不带这些，挂载后就是 root 的 000 权限文件。
        """
        url, headers = self._headers("HEAD", key, {}, EMPTY_SHA256)
        async with self._http.head(url, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as resp:
            if resp.status == 404:
                return None
            if resp.status != 200:
                await self._raise(resp)
            meta = {k[len("x-amz-meta-"):].lower(): v for k, v in resp.headers.items() if k.lower().startswith("x-amz-meta-")}
            return {"size": int(resp.headers.get("Content-Length") or 0), "metadata": meta}

    @staticmethod
    def _meta_headers(metadata: dict[str, str] | None) -> dict[str, str]:
        return {f"x-amz-meta-{k.lower()}": str(v) for k, v in (metadata or {}).items()}

    async def get_bytes(self, key: str, max_bytes: int = 4 * 1024 * 1024) -> bytes | None:
        """小对象整段读回来；不存在返回 None；超过 max_bytes 报错。"""
        url, headers = self._headers("GET", key, {}, EMPTY_SHA256)
        async with self._http.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=120)) as resp:
            if resp.status == 404:
                return None
            if resp.status != 200:
                await self._raise(resp)
            if resp.content_length and resp.content_length > max_bytes:
                raise S3Error(0, f"{key} 太大（{resp.content_length} 字节）")
            data = await resp.content.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise S3Error(0, f"{key} 太大")
            return data

    async def get_to_file(self, key: str, dest: Path) -> tuple[int, str]:
        """流式下载到文件，返回 (大小, sha256)。不存在抛 S3Error(404)。"""
        url, headers = self._headers("GET", key, {}, EMPTY_SHA256)
        digest = hashlib.sha256()
        size = 0
        async with self._http.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=3600, sock_read=120)) as resp:
            if resp.status != 200:
                await self._raise(resp)
            with open(dest, "wb") as fh:
                async for chunk in resp.content.iter_chunked(_CHUNK):
                    fh.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
        return size, digest.hexdigest()

    async def put_file(self, key: str, src: Path, sha256_hex: str, content_type: str = "application/octet-stream",
                       metadata: dict[str, str] | None = None) -> None:
        """上传一个本地文件；``sha256_hex`` 必须是文件内容的哈希（签名里要用）。``metadata`` 原样存成用户元数据。"""
        size = src.stat().st_size
        url, headers = self._headers("PUT", key, {}, sha256_hex, {"content-type": content_type, **self._meta_headers(metadata)})
        headers["content-length"] = str(size)

        async def body() -> AsyncIterator[bytes]:
            with open(src, "rb") as fh:
                while True:
                    chunk = fh.read(_CHUNK)
                    if not chunk:
                        return
                    yield chunk

        async with self._http.put(url, data=body(), headers=headers,
                                  timeout=aiohttp.ClientTimeout(total=3600, sock_read=120)) as resp:
            if resp.status not in (200, 201):
                await self._raise(resp)

    async def put_bytes(self, key: str, data: bytes, content_type: str = "application/json",
                        metadata: dict[str, str] | None = None) -> None:
        url, headers = self._headers("PUT", key, {}, hashlib.sha256(data).hexdigest(),
                                     {"content-type": content_type, **self._meta_headers(metadata)})
        async with self._http.put(url, data=data, headers=headers, timeout=aiohttp.ClientTimeout(total=120)) as resp:
            if resp.status not in (200, 201):
                await self._raise(resp)

    async def delete(self, key: str) -> None:
        url, headers = self._headers("DELETE", key, {}, EMPTY_SHA256)
        async with self._http.delete(url, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as resp:
            if resp.status not in (200, 204, 404):
                await self._raise(resp)
