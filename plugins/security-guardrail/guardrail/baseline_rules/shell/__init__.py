"""Shell baseline rule definitions."""

from .ask import ASK_RULES
from .command_scope import SHELL_COMMAND_SCOPES
from .commands import COMMAND_POLICIES, COMMAND_RULES
from .terminal import TERMINAL_RULES

RULES = (*COMMAND_RULES, *TERMINAL_RULES, *ASK_RULES)

__all__ = ["ASK_RULES", "COMMAND_POLICIES", "COMMAND_RULES", "RULES", "SHELL_COMMAND_SCOPES", "TERMINAL_RULES"]
