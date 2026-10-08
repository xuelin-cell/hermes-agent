"""SigV4 签名按 AWS 文档里的已知向量核对，URL 编码按规范。"""

from __future__ import annotations

from datetime import datetime, timezone

from entry.s3lite import EMPTY_SHA256, S3Lite, _uri_encode, sign_v4

AK = "AKIAIOSFODNN7EXAMPLE"
SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
WHEN = datetime(2013, 5, 24, 0, 0, 0, tzinfo=timezone.utc)


def test_sign_v4_matches_aws_get_object_example() -> None:
    # AWS《Signature Version 4 签名示例》里的 GET Object 用例（examplebucket/test.txt，带 Range）
    headers = sign_v4(
        method="GET", host="examplebucket.s3.amazonaws.com", path="/test.txt", query={},
        headers={"Range": "bytes=0-9"}, payload_hash=EMPTY_SHA256,
        access_key=AK, secret_key=SK, region="us-east-1", now=WHEN,
    )
    assert headers["authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )
    assert headers["x-amz-date"] == "20130524T000000Z"


def test_sign_v4_query_order_and_header_case_do_not_change_signature() -> None:
    # 规范要求查询参数按键排序、头名小写后排序：两种写法必须得到同一个签名
    a = sign_v4(
        method="GET", host="examplebucket.s3.amazonaws.com", path="/", query={"prefix": "J", "max-keys": "2"},
        headers={"Range": "bytes=0-9"}, payload_hash=EMPTY_SHA256, access_key=AK, secret_key=SK, region="us-east-1", now=WHEN,
    )
    b = sign_v4(
        method="GET", host="examplebucket.s3.amazonaws.com", path="/", query={"max-keys": "2", "prefix": "J"},
        headers={"range": "bytes=0-9 "}, payload_hash=EMPTY_SHA256, access_key=AK, secret_key=SK, region="us-east-1", now=WHEN,
    )
    assert a["authorization"] == b["authorization"]
    # 查询串变了签名就得变
    c = sign_v4(
        method="GET", host="examplebucket.s3.amazonaws.com", path="/", query={"max-keys": "3", "prefix": "J"},
        headers={"range": "bytes=0-9"}, payload_hash=EMPTY_SHA256, access_key=AK, secret_key=SK, region="us-east-1", now=WHEN,
    )
    assert c["authorization"] != a["authorization"]
    assert a["x-amz-content-sha256"] == EMPTY_SHA256


def test_uri_encode_keeps_slash_only_in_path() -> None:
    assert _uri_encode("volumes/hermes-mt-u-abc/.state/e000001-x/20260930T013118Z.tar.gz", True) == \
        "volumes/hermes-mt-u-abc/.state/e000001-x/20260930T013118Z.tar.gz"
    assert _uri_encode("a b/c+d", True) == "a%20b/c%2Bd"
    assert _uri_encode("a/b", False) == "a%2Fb"
    assert _uri_encode("~ok-_.", False) == "~ok-_."


class _FakeHttp:
    pass


def test_path_style_and_virtual_host_targets() -> None:
    c = S3Lite(_FakeHttp(), "http://192.168.121.94:9000", "cube-volumes", AK, SK)  # type: ignore[arg-type]
    assert c._target("volumes/x/OWNER") == ("192.168.121.94:9000", "/cube-volumes/volumes/x/OWNER")
    assert c._target("") == ("192.168.121.94:9000", "/cube-volumes/")
    v = S3Lite(_FakeHttp(), "https://obs.example.com", "bkt", AK, SK, path_style=False)  # type: ignore[arg-type]
    assert v._target("a/b") == ("bkt.obs.example.com", "/a/b")
