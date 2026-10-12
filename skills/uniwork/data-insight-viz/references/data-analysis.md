# 数据分析

两条路：`scripts/analyze.py`（DuckDB / SQL，用于装载、剖析、聚合）和 pandas
（用于自定义清洗与统计）。**默认先用脚本**——它带缓存，重复查询是瞬时的。

| 用 analyze.py | 用 pandas |
|---|---|
| 首次装载与剖析 | 复杂清洗、条件逻辑 |
| 聚合、筛选、排序、JOIN | 自定义统计与假设检验 |
| 大数据集（100MB+，DuckDB 更快） | 时间序列重采样/滚动窗口 |
| 一次性查询、直接导出文件 | 需要链式迭代探索 |

支持格式：`.xlsx` `.xlsm` `.xls` `.csv` `.tsv` `.tab` `.ods`（脚本另可读 `.json` `.parquet`）。

---

## scripts/analyze.py

```
python scripts/analyze.py --files FILE [FILE ...] --action {inspect,query,summary}
                          [--sql SQL] [--table TABLE] [--output-file PATH]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--files` | 是 | 一个或多个数据文件路径（空格分隔） |
| `--action` | 是 | `inspect` 看结构 · `query` 跑 SQL · `summary` 出统计摘要 |
| `--sql` | `query` 时必填 | 要执行的 SQL |
| `--table` | `summary` 时必填 | 表名 / sheet 名 |
| `--output-file` | 否 | 导出路径，按扩展名决定 CSV / JSON / MD |

```bash
# 1. 先看结构：sheet 名、列名、类型、行数、样例行
python scripts/analyze.py --files data.xlsx --action inspect

# 2. 统计摘要：数值列的 min/max/mean/median/std、缺失率
python scripts/analyze.py --files data.xlsx --action summary --table Sheet1

# 3. 查询并导出
python scripts/analyze.py --files data.xlsx --action query \
  --sql "SELECT category, COUNT(*) AS cnt, AVG(amount) AS avg_amount
         FROM Sheet1 GROUP BY category ORDER BY cnt DESC" \
  --output-file out/by_category.csv
```

**表名来自 sheet 名或文件名——先跑 `inspect` 确认实际表名再写 SQL。**
多个文件一起传给 `--files` 就能在一条 SQL 里 JOIN。

首次运行会自动 `pip install duckdb openpyxl`。数据文件按 SHA256 哈希缓存成
DuckDB 库放在临时目录，文件没变就直接命中缓存。

DuckDB 支持完整 SQL：CTE、窗口函数、`DATE_TRUNC('month', col)`、`QUALIFY` 等。

---

## Phase 1 剖析清单

跑完 `inspect` + `summary` 后要能回答：

- **规模**：行数、列数、文件大小
- **每列**：类型、唯一值数、缺失数与缺失率
- **质量**：重复行、类型不一致（数字被存成文本是最常见的）、明显的哨兵值（0/-1/9999 当缺失用）
- **数值列**：min / max / mean / median / std
- **时间范围**（如有时间列）：`SELECT MIN(d), MAX(d) FROM t`，并确认有无断档
- **样例**：头尾各几行，肉眼确认解析没错位

清洗动作按剖析结果决定：缺失值（填充还是删行）、去重、类型转换、异常值、文本规范化。
**每一步清洗都要记下来**——最终报告的"方法论/局限性"段落要写。

---

## 值得抄的统计配方

通用 pandas 操作不在此赘述。以下几段是分析里容易做错、值得固定下来的。

### 趋势是不是真的（别只看斜率）

```python
from scipy import stats
import numpy as np

monthly = df.resample("ME", on="date")["amount"].sum().reset_index()
x = np.arange(len(monthly))
slope, intercept, r, p, se = stats.linregress(x, monthly["amount"])

# 斜率为正不代表有趋势——必须看 p 值
if p < 0.05:
    direction = "显著上升" if slope > 0 else "显著下降"
else:
    direction = "无显著趋势"   # 这种情况报告里就不要写"呈上升态势"
print(f"{direction}: {slope:.2f}/月, R²={r**2:.3f}, p={p:.4f}")
```

### 找出强相关的变量对

```python
corr = df.select_dtypes("number").corr()
pairs = [
    (corr.columns[i], corr.columns[j], corr.iloc[i, j])
    for i in range(len(corr.columns))
    for j in range(i + 1, len(corr.columns))
    if abs(corr.iloc[i, j]) > 0.7
]
```
相关不是因果——报告里措辞用"与…同向变动"，不要写"导致"。

### 异常值：两种口径给出的答案不一样

```python
def outliers_iqr(s, k=1.5):
    q1, q3 = s.quantile(0.25), s.quantile(0.75)
    return (s < q1 - k * (q3 - q1)) | (s > q3 + k * (q3 - q1))

def outliers_z(s, t=3):
    return ((s - s.mean()) / s.std()).abs() > t
```
IQR 对偏态分布更稳健；z-score 假设近似正态。两者数量差很多，说明分布偏斜——
这本身就是一条洞察，而且意味着图上该用中位数而不是均值。

### 分档要用 rank 打破并列

```python
# 直接 qcut 遇到大量并列值会报 "Bin edges must be unique"
df["score"] = pd.qcut(df["total_spent"].rank(method="first"), 5, labels=[1, 2, 3, 4, 5])
```

---

## 交给图表之前

分析结果要落成图能直接吃的形状：

- 聚合到最终粒度（按月？按类别？），别让图表层再算
- 类别数超过 ~7 就在这里折叠出"其他"——不要指望配色去救（`choosing-a-form.md`）
- 数值确认是数字类型，不是字符串（`validate_echarts.py` 会警告，但源头在这里）
- 缺失值决定是补 0 还是断线，两者在折线图上含义完全不同
- 记下每张图的数据来源字段与筛选条件，填进 `report-template.md` 的"数据来源"
