"""Public startup failures distinguish actionable causes without echoing secrets."""
import pytest

from entry.backend_errors import cube_failure_reason


@pytest.mark.parametrize(('status', 'message', 'expected'), [
    (500, 'CubeMaster returned error code 130408:', 'sandbox_node_unhealthy'),
    (500, "PermissionError: Permission denied: '/private/path'", 'sandbox_permission_denied'),
    (408, 'None', 'sandbox_operation_timeout'),
    (500, 'context deadline exceeded', 'sandbox_operation_timeout'),
    (500, 'secret-token=private', 'sandbox_unavailable'),
    (503, 'service unavailable', 'sandbox_unavailable'),
])
def test_cube_failure_exposes_only_a_stable_category(status, message, expected):
    reason = cube_failure_reason(status, message)
    assert reason == expected
    assert 'private' not in reason
