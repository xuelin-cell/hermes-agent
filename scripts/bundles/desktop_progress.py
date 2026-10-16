"""桌面打包的阶段编号与耗时日志，不改变构建执行顺序。"""
from contextlib import contextmanager
import time


@contextmanager
def build_step(number: int, name: str, *, total: int = 6):
    """即时输出阶段开始、完成或失败；编号表示阶段进度而非耗时比例。"""
    label = f"[{number}/{total}] {name}"
    print(f"{label} - 开始", flush=True)
    started = time.perf_counter()
    try:
        yield
    except BaseException:
        print(f"{label} - 失败，耗时 {time.perf_counter() - started:.1f} 秒", flush=True)
        raise
    else:
        print(f"{label} - 完成，耗时 {time.perf_counter() - started:.1f} 秒", flush=True)
