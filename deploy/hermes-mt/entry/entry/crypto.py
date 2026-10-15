"""加密和解密 Entry 保存的用户级敏感凭据。"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken


class CredentialError(RuntimeError):
    """凭据加密配置或密文无法安全使用。"""


class CredentialCipher:
    """使用一把环境变量主密钥对平台凭据执行认证加密。"""

    def __init__(self, key: str):
        if not key:
            raise CredentialError("缺少 MT_CREDENTIAL_KEY，Entry 无法安全保存凭据")
        try:
            self._fernet = Fernet(key.encode("ascii"))
        except (ValueError, UnicodeEncodeError) as exc:
            raise CredentialError("MT_CREDENTIAL_KEY 不是有效的 Fernet 密钥") from exc

    def encrypt(self, value: str) -> bytes:
        """加密 UTF-8 文本；调用方负责拒绝无意义的空值。"""
        return self._fernet.encrypt(value.encode("utf-8"))

    def decrypt(self, ciphertext: bytes) -> str:
        """使用固定主密钥解密，不在异常中暴露密文。"""
        try:
            return self._fernet.decrypt(bytes(ciphertext)).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError, TypeError, ValueError) as exc:
            raise CredentialError("平台凭据密文无效或使用了错误的主密钥") from exc
