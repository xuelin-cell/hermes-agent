"""验证阶段日志与真实子进程输出的先后关系及失败传播。"""
import subprocess
import sys

import pytest

from scripts.bundles.desktop_progress import build_step


# 阶段开始必须先于子进程输出，完成信息必须在子进程退出后出现。
def test_stage_logs_wrap_real_child_output(capfd):
    with build_step(2, "校验依赖"):
        subprocess.run([sys.executable, "-c", "print('child output', flush=True)"], check=True)
    output = capfd.readouterr().out
    assert output.index("[2/6] 校验依赖 - 开始") < output.index("child output")
    assert output.index("child output") < output.index("[2/6] 校验依赖 - 完成，耗时")


# 失败阶段保持原始异常，不输出完成，单独准备模式采用自己的总步数。
def test_failed_child_keeps_error_and_never_reports_completion(capfd):
    with pytest.raises(subprocess.CalledProcessError) as error:
        with build_step(1, "准备依赖", total=1):
            subprocess.run([sys.executable, "-c", "raise SystemExit(3)"], check=True)
    assert error.value.returncode == 3
    output = capfd.readouterr().out
    assert "[1/1] 准备依赖 - 开始" in output
    assert "[1/1] 准备依赖 - 失败，耗时" in output
    assert "完成" not in output
