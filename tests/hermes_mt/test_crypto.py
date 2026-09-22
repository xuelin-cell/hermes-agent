"""验证 Entry 平台凭据的认证加密和错误处理。"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from entry.crypto import CredentialCipher, CredentialError


def test_credential_cipher_round_trip_does_not_store_plaintext() -> None:
    cipher = CredentialCipher(Fernet.generate_key().decode())

    encrypted = cipher.encrypt("model-api-key")

    assert isinstance(encrypted, bytes)
    assert b"model-api-key" not in encrypted
    assert cipher.decrypt(encrypted) == "model-api-key"


def test_credential_cipher_rejects_missing_key() -> None:
    with pytest.raises(CredentialError, match="MT_CREDENTIAL_KEY"):
        CredentialCipher("")


def test_credential_cipher_hides_invalid_ciphertext() -> None:
    cipher = CredentialCipher(Fernet.generate_key().decode())

    with pytest.raises(CredentialError) as caught:
        cipher.decrypt(b"not-a-fernet-token")

    assert "not-a-fernet-token" not in str(caught.value)
