"""验证 Entry 平台凭据的认证加密和错误处理。"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from entry.crypto import CredentialCipher, CredentialError


def test_credential_cipher_round_trip_does_not_store_plaintext() -> None:
    cipher = CredentialCipher(Fernet.generate_key().decode(), "local-v1")

    encrypted = cipher.encrypt("model-api-key")

    assert isinstance(encrypted, bytes)
    assert b"model-api-key" not in encrypted
    assert cipher.decrypt(encrypted, "local-v1") == "model-api-key"


def test_credential_cipher_rejects_missing_key() -> None:
    with pytest.raises(CredentialError, match="MT_CREDENTIAL_KEY"):
        CredentialCipher("", "local-v1")


def test_credential_cipher_rejects_unknown_key_id() -> None:
    cipher = CredentialCipher(Fernet.generate_key().decode(), "local-v1")
    encrypted = cipher.encrypt("model-api-key")

    with pytest.raises(CredentialError, match="密钥版本"):
        cipher.decrypt(encrypted, "other-v2")


def test_credential_cipher_hides_invalid_ciphertext() -> None:
    cipher = CredentialCipher(Fernet.generate_key().decode(), "local-v1")

    with pytest.raises(CredentialError) as caught:
        cipher.decrypt(b"not-a-fernet-token", "local-v1")

    assert "not-a-fernet-token" not in str(caught.value)
