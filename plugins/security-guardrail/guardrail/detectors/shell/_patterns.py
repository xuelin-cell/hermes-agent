"""Shared constants for shell command detectors."""

_CMDPOS = (
    r"(?:^|[;&|\n`]|\$\()"
    r"\s*"
    r"(?:sudo\s+(?:-[^\s]+\s+)*)?"
    r"(?:env\s+(?:\w+=\S*\s+)*)?"
    r"(?:(?:exec|nohup|setsid|time)\s+)*"
    r"\s*"
)


_BLOCK_DEVICE = r"(sd|nvme|hd|mmcblk|vd|xvd|dm-|mapper/|md|loop)[a-z0-9]*"
