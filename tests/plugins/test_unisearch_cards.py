"""Canonical card behavior ported from UniClaw d413208e1, preserving contributor attribution."""

import json
import pytest
from .test_unisearch import load_package

load_package()
from unisearch_test_plugin import common, weather, finance, train

for module in (common, weather, finance, train):
    globals().update({
        name: value
        for name, value in vars(module).items()
        if name.startswith("_") and not name.startswith("__")
    })


def _wrap_response(response_obj: dict) -> dict:
    """腾讯所有响应都包了一层 "Response"。"""
    return {"Response": response_obj}


def _mock_client_with_response(payload: dict) -> AsyncMock:
    """构造一个返回指定 payload 的 mock httpx client。"""
    mock_client = AsyncMock()
    mock_response = MagicMock()
    mock_response.json.return_value = payload
    mock_response.raise_for_status = MagicMock()
    mock_response.status_code = 200
    mock_client.post.return_value = mock_response
    return mock_client


class TestCanonicalWeather:
    """跨 variant 通用 normalize: passage / 老 display_info / 国际 schema → CanonicalWeather.

    覆盖 3 个 active variant (vrid 70269801 / 70269811 / 70269909, 探针 dump),
    + 2 个老 schema (国内 day[] / 国际 subitem.subdisplay)。
    """

    # ── _parse_weather_passage: 文本格式 → canonical dict ───────────────

    def test_passage_domestic_full_fields_parsed(self) -> None:
        """国内 variant (70269811) 含限行 - 必需 + 可选字段全部识别。"""
        # 模拟一段典型 passage (探针 dump 的精简版).
        passage = (
            "城市：北京\n"
            "白天天气状态：多云\n"
            "最高温度（摄氏度）：30\n"
            "最低温度（摄氏度）：23\n"
            "日期：2026-05-28\n"
            "星期：周四\n"
            "当日风向：北风\n"
            "当日风力：3级\n"
            "湿度：76\n"
            "小时级空气质量等级：优\n"
            "小时级空气质量值：38\n"
            "尾号限行：4和6\n"
            "\n"
            "最高温度（摄氏度）：32\n"
            "最低温度（摄氏度）：18\n"
            "日期：2026-05-29\n"
            "星期：周五\n"
            "白天天气状态：晴\n"
            "当日风向：东风\n"
            "当日风力：2级\n"
            "\n"
            "# 天气预报来源：中国气象局\n"
            "# 今日日期：2026-05-28\n"
        )
        result = _parse_weather_passage(passage)
        assert result is not None
        assert result["location"] == "北京"
        assert result["today"]["summary"] == "多云"
        assert result["today"]["temp_low"] == "23"
        assert result["today"]["temp_high"] == "30"
        assert result["today"]["wind"] == "北风 3级"
        assert result["today"]["humidity"] == "76"
        assert result["today"]["aqi"] == "优 38"
        assert result["today"]["forbidden"] == "4和6"
        assert result["source"] == "中国气象局"
        # 一天 forecast
        assert len(result["forecast"]) == 1
        assert result["forecast"][0]["temp_high"] == "32"
        assert result["forecast"][0]["summary"] == "晴"
        assert result["forecast"][0]["wind"] == "东风 2级"

    def test_passage_international_sparse_fields(self) -> None:
        """国际 variant (70269909) 字段少 — 缺的字段应是 None, 不抛错。"""
        passage = (
            "国家：日本\n"
            "城市：东京\n"
            "当天天气状态：Sunny\n"
            "最高温度（摄氏度）：26\n"
            "最低温度（摄氏度）：18\n"
            "日期：2026-05-28\n"
            "星期：周四\n"
            "风向：东风\n"
            "风力：2级\n"
        )
        result = _parse_weather_passage(passage)
        assert result is not None
        # 国际版地点拼接 "国家 城市"
        assert "东京" in (result["location"] or "")
        assert result["today"]["summary"] == "Sunny"
        assert result["today"]["temp_high"] == "26"
        assert result["today"]["wind"] == "东风 2级"
        # 国际版没的字段应为 None
        assert result["today"]["humidity"] is None
        assert result["today"]["aqi"] is None
        assert result["today"]["forbidden"] is None

    def test_passage_without_temp_returns_none(self) -> None:
        """passage 里没温度数据 → 返回 None (前端拿不到 canonical 不渲染)。"""
        passage = "城市：北京\n星期：周四\n# 天气预报来源：中国气象局\n"
        assert _parse_weather_passage(passage) is None

    def test_passage_empty_string_returns_none(self) -> None:
        """空 passage → None, 不抛错。"""
        assert _parse_weather_passage("") is None

    def test_passage_meta_lines_with_hash_prefix(self) -> None:
        """'# 键：值' 全局元数据正确分离, 不混进 day 数据。"""
        passage = (
            "白天天气状态：晴\n"
            "最高温度（摄氏度）：30\n"
            "最低温度（摄氏度）：20\n"
            "日期：2026-05-28\n"
            "\n"
            "# 天气预报来源：中国气象局\n"
            "# 更新时间：2026-05-28 10:00\n"
        )
        result = _parse_weather_passage(passage)
        assert result is not None
        assert result["source"] == "中国气象局"
        assert result["updated"] == "2026-05-28 10:00"

    def test_passage_synonym_wind_keys_normalized(self) -> None:
        """'白天风向' / '当日风向' / '风向' 三个同义 key 都映射到 wind_direction。"""
        for wind_key in ("当日风向", "白天风向", "风向"):
            passage = (
                f"白天天气状态：晴\n"
                f"最高温度（摄氏度）：30\n"
                f"最低温度（摄氏度）：20\n"
                f"日期：2026-05-28\n"
                f"{wind_key}：南风\n"
            )
            result = _parse_weather_passage(passage)
            assert result is not None
            assert result["today"]["wind"] == "南风", f"failed for key {wind_key!r}"

    # ── _canonical_weather: 3-fallback dispatcher ───────────────────────

    def test_canonical_legacy_domestic_display_info_day(self) -> None:
        """老国内 schema (jsonData.display_info.day[]) → canonical."""
        item = {
            "vr": True,
            "vr_category": "weather",
            "jsonData": {
                "display_info": {
                    "location": "上海",
                    "day": [
                        {
                            "date": "2026-05-28",
                            "other_week": "周四",
                            "summary": "多云",
                            "number_low": "20",
                            "number_high": "28",
                            "type_wind": "东风",
                            "type_windlevel": "3级",
                            "humidity": "70",
                            "forbidden": "1和6",
                        },
                        {
                            "date": "2026-05-29",
                            "other_week": "周五",
                            "summary": "晴",
                            "number_low": "22",
                            "number_high": "30",
                        },
                    ],
                }
            },
        }
        result = _canonical_weather(item)
        assert result is not None
        assert result["location"] == "上海"
        assert result["today"]["summary"] == "多云"
        assert result["today"]["temp_low"] == "20"
        assert result["today"]["wind"] == "东风 3级"
        assert result["today"]["humidity"] == "70%"
        assert result["today"]["forbidden"] == "1和6"
        assert len(result["forecast"]) == 1
        assert result["forecast"][0]["temp_high"] == "30"

    def test_canonical_legacy_intl_subitem_subdisplay(self) -> None:
        """老国际 schema (display.subitem.subdisplay.day[]) → canonical."""
        item = {
            "vr": True,
            "vr_category": "weather",
            "jsonData": {"display_info": {}},
            "display": {
                "subitem": {
                    "key": "Japan_Tokyo",
                    "subdisplay": {
                        "day": [
                            {
                                "date": "2026-05-28",
                                "week": "Thu",
                                "description": "Sunny",
                                "low": "18",
                                "high": "26",
                                "wind": "E",
                                "wind1": "2",
                            },
                        ]
                    },
                }
            },
        }
        result = _canonical_weather(item)
        assert result is not None
        assert result["location"] == "Japan Tokyo"
        assert result["today"]["summary"] == "Sunny"
        assert result["today"]["temp_high"] == "26"
        assert result["today"]["wind"] == "E 2"

    def test_canonical_new_passage_schema(self) -> None:
        """新 passage schema (70269811 等) → canonical."""
        item = {
            "vr": True,
            "vr_category": "weather",
            "jsonData": {"display_info": {}},
            "display": {},
            "passage": (
                "城市：杭州\n"
                "白天天气状态：多云\n"
                "最高温度（摄氏度）：29\n"
                "最低温度（摄氏度）：23\n"
                "日期：2026-05-28\n"
                "星期：周四\n"
            ),
        }
        result = _canonical_weather(item)
        assert result is not None
        assert result["location"] == "杭州"
        assert result["today"]["summary"] == "多云"
        assert result["today"]["temp_high"] == "29"

    def test_canonical_all_paths_empty_returns_none(self) -> None:
        """3 个 schema path 都没数据 → None (前端不渲染卡)。"""
        item = {
            "vr": True,
            "vr_category": "weather",
            "jsonData": {"display_info": {}},
            "display": {},
            # 没 passage
        }
        assert _canonical_weather(item) is None

    def test_canonical_legacy_day_missing_temp_returns_none(self) -> None:
        """老 schema day 数组但缺 number_low/high → 跳过该 day, 全部缺则 None。"""
        item = {
            "vr": True,
            "vr_category": "weather",
            "jsonData": {
                "display_info": {
                    "location": "X",
                    # day 只有 summary 没温度 — 不符合必需条件
                    "day": [{"date": "2026-05-28", "summary": "晴"}],
                }
            },
        }
        # legacy 不符合 → 但因为没 passage, 整体返回 None
        assert _canonical_weather(item) is None

    # ── _extract_cards 注入 _canonical 到 raw ──────────────────────────


_PASSAGE_STOCK_A = (
    "# 股票：贵州茅台_600519_a\n"
    "# 详情页地址：https://wzq.tenpay.com/mm/detail?scode=600519&type=1\n"
    "# 股票名称：贵州茅台\n"
    "# 股票代码：600519\n"
    "# 股票代码前缀：sh\n"
    "# 股票类型：A股\n"
    "# 实时股价：1275.98\n"
    "# 涨跌额：-27.02\n"
    "# 涨跌幅：-2.07\n"
    "# 交易状态：已收盘\n"
    "# 更新时间：2026-05-28 15:00:00\n"
    "# 今日开盘价：1290.00\n"
    "# 昨日收盘价：1303.00\n"
    "# 今日最高价：1304.00\n"
    "# 今日最低价：1271.00\n"
    "# 成交量：45890\n"
    "# 市盈率TTM：19.28\n"
    "# 总市值：15950.79"
)

_PASSAGE_STOCK_HK = (
    "# 股票：腾讯控股_00700_hk\n"
    "# 股票名称：腾讯控股\n"
    "# 股票代码：00700\n"
    "# 股票代码前缀：hk\n"
    "# 股票类型：港股\n"
    "# 实时股价：425.000\n"
    "# 涨跌额：-9.400\n"
    "# 涨跌幅：-2.16\n"
    "# 交易状态：已收盘\n"
    "# 今日开盘价：431.000"
)

_PASSAGE_EXCHANGERATE = (
    "# 跳转地址：https://m.cngold.org/quote/fx/jchl_USDCNY.html\n"
    "# 今日美元人民币价格走势图_金投网\n"
    "# 外汇兑换：美元人民币\n"
    "# 更新信息：\n"
    "更新时间戳：1779962641\n"
    "交易状态：on\n"
    "# 行情信息：\n"
    "跳转地址：https://m.cngold.org/quote/fx/jchl_USDCNY.html\n"
    "汇率值类型：USD/CNY\n"
    "最新信息：\n"
    "汇率：6.7805\n"
    "涨跌状态：up\n"
    "外汇兑换币种：USD/CNY\n"
    "涨跌值：+0.0012\n"
    "涨跌幅：+0.0177%\n"
    "统计信息列表：\n\n"
    "汇率值类型：最高\n"
    "汇率值：6.7890\n"
    "涨跌状态：up\n\n"
    "汇率值类型：最低\n"
    "汇率值：6.7770\n"
    "涨跌状态：down\n\n"
    "汇率值类型：昨收\n"
    "汇率值：6.7793\n"
    "涨跌状态：draw\n\n"
    "汇率值类型：今开\n"
    "汇率值：6.7781\n"
    "涨跌状态：down\n\n"
    "# 数据来源：金投网"
)

_PASSAGE_GOLD_QUOTE = (
    "# 转跳地址：http://m.cngold.org/quote/gjs/gjhj_xhhj.html?key=au\n"
    "# 今日现货黄金价格走势图_金投网\n"
    "# 贵金属名称：黄金\n"
    "# 更新信息：\n"
    "更新时间：1779962617\n"
    "交易状态：on\n"
    "# 行情信息：\n\n"
    "转跳地址：http://m.cngold.org/quote/gjs/gjhj_xhhj.html?key=au\n"
    "价格值类型：国内价格(元/克)\n"
    "最新信息：\n"
    "价格：957.95\n"
    "涨跌状态：down\n"
    "价格单位：元/克\n"
    "涨跌值：-13.47\n"
    "涨跌幅：-1.39%\n"
    "统计信息列表：\n\n"
    "价格值类型：最高\n"
    "价格值：973.31\n"
    "涨跌状态：up\n\n"
    "价格值类型：最低\n"
    "价格值：951.75\n"
    "涨跌状态：down\n\n"
    "价格值类型：昨收\n"
    "价格值：971.42\n"
    "涨跌状态：draw\n\n"
    "价格值类型：今开\n"
    "价格值：971.15\n"
    "涨跌状态：down\n\n\n"
    "转跳地址：http://m.cngold.org/quote/gjs/gjhj_xhhj.html\n"
    "价格值类型：国际价格(美元/盎司)\n"
    "最新信息：\n"
    "价格：4394.18\n"
    "涨跌状态：down\n"
    "价格单位：美元/盎司\n"
    "涨跌值：-61.78\n"
    "涨跌幅：-1.39%\n"
    "统计信息列表：\n\n"
    "价格值类型：最高\n"
    "价格值：4464.64\n"
    "涨跌状态：up\n\n"
    "价格值类型：最低\n"
    "价格值：4365.76\n"
    "涨跌状态：down\n\n"
    "价格值类型：昨收\n"
    "价格值：4455.96\n"
    "涨跌状态：draw\n\n"
    "价格值类型：今开\n"
    "价格值：4454.74\n"
    "涨跌状态：down\n\n\n"
    "# 数据来源：金投网"
)

_PASSAGE_GOLD_MERCHANT = (
    "# 详情：\n\n"
    "在售商家类型：金店\n"
    "商家列表：\n\n"
    "品牌名称：周大福\n"
    "商品：黄金\n"
    "价格（元）：1353元/克\n\n"
    "品牌名称：周六福\n"
    "商品：黄金\n"
    "价格（元）：1348元/克\n\n"
    "品牌名称：六福珠宝\n"
    "商品：黄金\n"
    "价格（元）：1351元/克\n\n"
    "在售商家类型：银行\n"
    "商家列表：\n\n"
    "品牌名称：建设银行\n"
    "商品：龙鼎金条\n"
    "价格（元）：989.39元/克\n\n"
    "品牌名称：工商银行\n"
    "商品：如意金条\n"
    "价格（元）：993.23元/克\n\n"
    "# PC端转跳地址：https://quote.cngold.org/gjs/swhj_city_460.html\n"
    "# 更新时间：2026-05-28"
)

_PASSAGE_TRAIN = (
    "# 火车车次：G1\n"
    "# PC端转跳地址：https://trains.ctrip.com/trainbooking/TrainSchedule/G1/\n"
    "# 始发站：北京南\n"
    "# 终点站：上海虹桥\n"
    "# 火车类型：高铁\n"
    "# 车次：G1\n"
    "# 全程时间：4小时54分钟\n"
    "# 出发时间：06:30\n"
    "# 到达时间：11:24\n"
    "# 本车次经停站信息：\n\n"
    "经停站名称：北京南\n"
    "到站时间：----\n"
    "发车时间：06:30\n"
    "停留时长：----\n\n"
    "经停站名称：沧州西\n"
    "到站时间：07:18\n"
    "发车时间：07:20\n"
    "停留时长：2分钟\n\n"
    "经停站名称：上海虹桥\n"
    "到站时间：11:24\n"
    "发车时间：11:24\n"
    "停留时长：----\n\n"
    "# 数据更新时间：2026-05-29"
)

_PASSAGE_TRAIN_SENTINELS = (
    "# 火车车次：G7车次\n"
    "# 始发站：北京南\n"
    "# 终点站：上海虹桥\n"
    "# 火车类型：高铁\n"
    "# 全程时间：4时37分\n"
    "# 出发时间：09:00\n"
    "# 到达时间：13:37\n"
    "# 本车次经停站信息：\n\n"
    "经停站名称：北京南\n"
    "到站时间：发站\n"
    "发车时间：09:00\n"
    "停留时长：----\n\n"
    "经停站名称：济南西\n"
    "到站时间：10:22\n"
    "发车时间：10:25\n"
    "停留时长：3分钟\n\n"
    "经停站名称：上海虹桥\n"
    "到站时间：13:37\n"
    "发车时间：终点站\n"
    "停留时长：----\n\n"
    "# 车次：G7"
)


def _mk_vr_item(category: str, vrid: str, passage: str) -> dict[str, object]:
    """构造一个最小 VR item dict (跟 Tencent _parse_pages 输入同形)。"""
    return {
        "vr": True,
        "vr_category": category,
        "vrid": vrid,
        "title": f"test_{vrid}",
        "url": "",
        "site": "test",
        "passage": passage,
        "date": "2026-05-28 18:00:00",
        "favicon": "",
    }


class TestCanonicalStock:
    # 缺少结构化文本时不生成不完整卡片。
    def test_returns_none_when_no_passage(self) -> None:
        assert _canonical_stock({"vr_category": "stock"}) is None
        assert _canonical_stock({"passage": ""}) is None
        assert _canonical_stock({"passage": "   "}) is None

    # 缺少名称时不生成误导性的报价卡片。
    def test_returns_none_when_name_missing(self) -> None:
        item = _mk_vr_item("stock", "70280301", "# 实时股价：100")
        assert _canonical_stock(item) is None

    # 缺少价格时保留文字路径，不生成报价卡片。
    def test_returns_none_when_price_missing(self) -> None:
        item = _mk_vr_item("stock", "70280301", "# 股票名称：贵州茅台")
        assert _canonical_stock(item) is None

    # 完整A股数据保持名称、价格和交易字段。
    def test_full_a_share_fixture(self) -> None:
        item = _mk_vr_item("stock", "70280301", _PASSAGE_STOCK_A)
        c = _canonical_stock(item)
        assert c is not None
        assert c["name"] == "贵州茅台"
        assert c["code"] == "600519"
        assert c["code_prefix"] == "sh"
        assert c["market"] == "A股"
        assert c["price"] == "1275.98"
        assert c["change_value"] == "-27.02"
        assert c["change_pct"] == "-2.07"
        assert c["trend"] == "down"  # derived from negative change_value
        assert c["trade_status"] == "已收盘"
        assert c["open"] == "1290.00"
        assert c["prev_close"] == "1303.00"
        assert c["high"] == "1304.00"
        assert c["low"] == "1271.00"
        assert c["volume"] == "45890"
        assert c["pe_ttm"] == "19.28"
        assert c["market_cap"] == "15950.79"
        assert c["updated"] == "2026-05-28 15:00:00"

    # 港股数据保持市场字段。
    def test_hk_share_market_field(self) -> None:
        item = _mk_vr_item("stock", "70280305", _PASSAGE_STOCK_HK)
        c = _canonical_stock(item)
        assert c is not None
        assert c["market"] == "港股"
        assert c["code_prefix"] == "hk"

    # 正涨跌值映射为上涨状态。
    def test_trend_up_when_positive_change(self) -> None:
        item = _mk_vr_item(
            "stock",
            "70280301",
            "# 股票名称：测试\n# 实时股价：100\n# 涨跌额：+5.00",
        )
        c = _canonical_stock(item)
        assert c is not None and c["trend"] == "up"

    # 模型文本与卡片使用相同名称、代码、市场及报价。
    def test_format_includes_name_code_market_price_change(self) -> None:
        item = _mk_vr_item("stock", "70280301", _PASSAGE_STOCK_A)
        c = _canonical_stock(item)
        assert c is not None
        text = _format_stock_canonical(c)
        assert "贵州茅台" in text
        assert "600519" in text
        assert "A股" in text
        assert "1275.98" in text
        assert "-27.02" in text
        assert "今开 1290.00" in text


class TestCanonicalExchangerate:
    # 缺少结构化文本时不生成不完整卡片。
    def test_returns_none_when_no_passage(self) -> None:
        assert _canonical_exchangerate({}) is None

    # 没有最新报价段时不使用其他统计值冒充现价。
    def test_returns_none_when_no_latest_segment(self) -> None:
        item = _mk_vr_item("exchangerate", "70269501", "# 外汇兑换：美元人民币")
        assert _canonical_exchangerate(item) is None

    # 汇率完整样例保持报价与元数据。
    def test_usd_cny_full_fixture(self) -> None:
        item = _mk_vr_item("exchangerate", "70269501", _PASSAGE_EXCHANGERATE)
        c = _canonical_exchangerate(item)
        assert c is not None
        assert c["name"] == "USD/CNY"
        assert len(c["quotes"]) == 1
        q = c["quotes"][0]
        assert q["value"] == "6.7805"
        assert q["trend"] == "up"
        assert q["change_value"] == "+0.0012"
        assert q["change_pct"] == "+0.0177%"
        assert c["source"] == "金投网"

    # 报价统计段与其对应标签保持一一关联。
    def test_stats_extracted_4_entries(self) -> None:
        item = _mk_vr_item("exchangerate", "70269501", _PASSAGE_EXCHANGERATE)
        c = _canonical_exchangerate(item)
        assert c is not None
        stats = c["quotes"][0]["stats"]
        labels = [s["label"] for s in stats]
        assert labels == ["最高", "最低", "昨收", "今开"]
        values = {s["label"]: s["value"] for s in stats}
        assert values == {
            "最高": "6.7890",
            "最低": "6.7770",
            "昨收": "6.7793",
            "今开": "6.7781",
        }

    # 汇率文字包含现价及统计说明。
    def test_format_contains_rate_and_stats(self) -> None:
        item = _mk_vr_item("exchangerate", "70269501", _PASSAGE_EXCHANGERATE)
        c = _canonical_exchangerate(item)
        assert c is not None
        text = _format_quote_canonical(c)
        assert "USD/CNY" in text
        assert "6.7805" in text
        assert "↑" in text  # up arrow
        assert "最高 6.7890" in text


class TestCanonicalGoldQuote:
    # 缺少结构化文本时不生成不完整卡片。
    def test_returns_none_when_no_passage(self) -> None:
        assert _canonical_gold({}) is None

    def test_returns_none_when_unrecognized_style(self) -> None:
        """No 贵金属名称 and no 在售商家类型 → can't dispatch."""
        item = _mk_vr_item("gold", "99999999", "# 随便：内容")
        assert _canonical_gold(item) is None

    def test_quote_style_dual_quotes_extracted(self) -> None:
        """70227501 has 国内 + 国际 2 prices."""
        item = _mk_vr_item("gold", "70227501", _PASSAGE_GOLD_QUOTE)
        c = _canonical_gold(item)
        assert c is not None
        assert c["style"] == "quote"
        assert c["name"] == "黄金"
        assert len(c["quotes"]) == 2
        labels = [q["label"] for q in c["quotes"]]
        assert labels == ["国内价格(元/克)", "国际价格(美元/盎司)"]
        assert c["quotes"][0]["value"] == "957.95"
        assert c["quotes"][0]["unit"] == "元/克"
        assert c["quotes"][1]["value"] == "4394.18"
        assert c["quotes"][1]["unit"] == "美元/盎司"

    # 各报价的统计值不串入另一报价。
    def test_quote_style_stats_grouped_per_quote(self) -> None:
        """Each quote's 4 stats segments must group to its own quote, not bleed across."""
        item = _mk_vr_item("gold", "70227501", _PASSAGE_GOLD_QUOTE)
        c = _canonical_gold(item)
        assert c is not None
        q1_stats = c["quotes"][0]["stats"]
        q2_stats = c["quotes"][1]["stats"]
        assert len(q1_stats) == 4
        assert len(q2_stats) == 4
        assert q1_stats[0] == {"label": "最高", "value": "973.31", "trend": "up"}
        assert q2_stats[0] == {"label": "最高", "value": "4464.64", "trend": "up"}

    # 行情样式保留来源和交易元数据。
    def test_quote_style_metadata(self) -> None:
        item = _mk_vr_item("gold", "70227501", _PASSAGE_GOLD_QUOTE)
        c = _canonical_gold(item)
        assert c is not None
        assert c["source"] == "金投网"
        assert c["trade_status"] == "on"
        assert c["updated"] == "1779962617"

    # 黄金行情文字来自相同规范化数据。
    def test_format_gold_quote(self) -> None:
        item = _mk_vr_item("gold", "70227501", _PASSAGE_GOLD_QUOTE)
        c = _canonical_gold(item)
        assert c is not None
        text = _format_gold_canonical(c)
        assert "黄金" in text
        assert "国内价格(元/克)" in text
        assert "957.95" in text
        assert "国际价格(美元/盎司)" in text
        assert "4394.18" in text


class TestCanonicalGoldMerchant:
    # 多商家报价保留原有分组。
    def test_merchant_style_groups_extracted(self) -> None:
        item = _mk_vr_item("gold", "70099201", _PASSAGE_GOLD_MERCHANT)
        c = _canonical_gold(item)
        assert c is not None
        assert c["style"] == "merchant"
        assert len(c["merchant_groups"]) == 2
        assert c["merchant_groups"][0]["type"] == "金店"
        assert c["merchant_groups"][1]["type"] == "银行"

    # 商品属于正确商家分组，不在相邻分组间混用。
    def test_merchant_items_per_group(self) -> None:
        item = _mk_vr_item("gold", "70099201", _PASSAGE_GOLD_MERCHANT)
        c = _canonical_gold(item)
        assert c is not None
        jewelry = c["merchant_groups"][0]["items"]
        bank = c["merchant_groups"][1]["items"]
        assert len(jewelry) == 3
        assert len(bank) == 2
        assert jewelry[0] == {
            "brand": "周大福",
            "product": "黄金",
            "price": "1353元/克",
        }
        assert bank[0] == {
            "brand": "建设银行",
            "product": "龙鼎金条",
            "price": "989.39元/克",
        }

    # 多商家报价保留来源与更新时间。
    def test_merchant_metadata(self) -> None:
        item = _mk_vr_item("gold", "70099201", _PASSAGE_GOLD_MERCHANT)
        c = _canonical_gold(item)
        assert c is not None
        assert c["updated"] == "2026-05-28"
        assert c["url"] is not None and "cngold.org" in c["url"]

    # 多商家文字与卡片展示保持同源。
    def test_format_gold_merchant(self) -> None:
        item = _mk_vr_item("gold", "70099201", _PASSAGE_GOLD_MERCHANT)
        c = _canonical_gold(item)
        assert c is not None
        text = _format_gold_canonical(c)
        assert "金店" in text
        assert "银行" in text
        assert "周大福 黄金: 1353元/克" in text


class TestCanonicalTrain:
    """passage 路径 (vrid 70083601/70330101): 单车次 + 详细 stops."""

    # 两个数据来源都不存在时不造出车次。
    def test_returns_none_when_no_passage_no_subitem(self) -> None:
        assert _canonical_train({}) is None

    # 缺少车次编号时不生成火车卡片。
    def test_returns_none_when_missing_number(self) -> None:
        item = _mk_vr_item(
            "train",
            "70083601",
            "# 始发站：北京\n# 终点站：上海",
        )
        assert _canonical_train(item) is None

    # 缺少起终站时不生成路线卡片。
    def test_returns_none_when_missing_stations(self) -> None:
        item = _mk_vr_item("train", "70083601", "# 火车车次：G1")
        assert _canonical_train(item) is None

    def test_full_g1_fixture_wraps_in_trains_list(self) -> None:
        """新 canonical shape: {trains: [...], updated, url}, 单车次时 trains 长 1."""
        item = _mk_vr_item("train", "70083601", _PASSAGE_TRAIN)
        c = _canonical_train(item)
        assert c is not None
        assert "trains" in c and len(c["trains"]) == 1
        t = c["trains"][0]
        assert t["number"] == "G1"
        assert t["from_station"] == "北京南"
        assert t["to_station"] == "上海虹桥"
        assert t["type"] == "高铁"
        assert t["depart_time"] == "06:30"
        assert t["arrive_time"] == "11:24"
        assert t["duration"] == "4小时54分钟"
        assert t["price"] is None  # passage variant 无 ticket
        assert c["updated"] == "2026-05-29"

    def test_stops_parsed_with_dash_normalized(self) -> None:
        """First stop has 到站时间=---- and 停留时长=---- → both should be None."""
        item = _mk_vr_item("train", "70083601", _PASSAGE_TRAIN)
        c = _canonical_train(item)
        assert c is not None
        stops = c["trains"][0]["stops"]
        assert len(stops) == 3  # 北京南 / 沧州西 / 上海虹桥
        assert stops[0] == {
            "name": "北京南",
            "arrive": None,
            "depart": "06:30",
            "stay": None,
        }
        assert stops[1] == {
            "name": "沧州西",
            "arrive": "07:18",
            "depart": "07:20",
            "stay": "2分钟",
        }
        assert stops[2]["stay"] is None  # Terminal stop: stay=---- → None
        assert c["trains"][0]["stops_count"] == 3

    def test_start_terminus_sentinels_normalized(self) -> None:
        """70330101 uses 发站/终点站 instead of ---- as sentinels."""
        item = _mk_vr_item("train", "70330101", _PASSAGE_TRAIN_SENTINELS)
        c = _canonical_train(item)
        assert c is not None
        stops = c["trains"][0]["stops"]
        assert stops[0]["arrive"] is None  # 发站 → None
        assert stops[-1]["depart"] is None  # 终点站 → None

    # 火车文字保留路线与经停站说明。
    def test_format_train_includes_route_and_stops(self) -> None:
        item = _mk_vr_item("train", "70083601", _PASSAGE_TRAIN)
        c = _canonical_train(item)
        assert c is not None
        text = _format_train_canonical(c)
        assert "G1" in text
        assert "高铁" in text
        assert "北京南" in text
        assert "上海虹桥" in text
        assert "经停 3 站" in text


class TestCanonicalTrainLegacy:
    """老 display.subitem schema (vrid 703300 路线多车次 / 703301 单车次).

    用户实测路线 query (X到Y高铁) 偶尔出 703300, passage 路径覆盖不到, 走这个 fallback.
    """

    def test_returns_none_when_no_subitem(self) -> None:
        """无 passage + 无 display.subitem → None."""
        item = {"vr": True, "vr_category": "train", "vrid": "703300"}
        assert _canonical_train(item) is None

    def test_legacy_array_subitem_multi_train_route(self) -> None:
        """703300 路线 query: display.subitem 是 array, 每个 entry 一车次."""
        item = {
            "vr": True,
            "vr_category": "train",
            "vrid": "703300",
            "display": {
                "subitem": [
                    {
                        "key": "G1",
                        "subdisplay": {
                            "number": "G1",
                            "type": "高铁",
                            "start_station": "北京南",
                            "start_time": "06:30",
                            "end_station": "上海虹桥",
                            "end_time": "11:24",
                            "alltime": "4小时54分钟",
                            "station": [{}, {}, {}, {}, {}, {}, {}],  # 7 站
                            "ticket": {"price": "553", "ticket_type": "二等座"},
                        },
                    },
                    {
                        "key": "G5",
                        "subdisplay": {
                            "number": "G5",
                            "type": "高铁",
                            "start_station": "北京南",
                            "start_time": "07:00",
                            "end_station": "上海虹桥",
                            "end_time": "11:38",
                            "alltime": "4小时38分钟",
                            "station": [{}, {}, {}, {}, {}],
                            "ticket": {"price": "553", "ticket_type": "二等座"},
                        },
                    },
                ]
            },
        }
        c = _canonical_train(item)
        assert c is not None
        assert len(c["trains"]) == 2
        t1, t2 = c["trains"]
        assert t1["number"] == "G1"
        assert t1["from_station"] == "北京南"
        assert t1["to_station"] == "上海虹桥"
        assert t1["depart_time"] == "06:30"
        assert t1["arrive_time"] == "11:24"
        assert t1["duration"] == "4小时54分钟"
        assert t1["stops"] is None  # 老 schema 无详细经停时刻表
        assert t1["stops_count"] == 7
        assert t1["price"] == "553"
        assert t1["ticket_type"] == "二等座"
        assert t2["number"] == "G5"
        assert t2["stops_count"] == 5

    def test_legacy_dict_subitem_single_train(self) -> None:
        """703301 老单车次: display.subitem 是 dict (不是 array)."""
        item = {
            "vr": True,
            "vr_category": "train",
            "vrid": "703301",
            "display": {
                "subitem": {
                    "key": "G7",
                    "subdisplay": {
                        "number": "G7",
                        "type": "高铁",
                        "start_station": "北京南",
                        "start_time": "09:00",
                        "end_station": "上海虹桥",
                        "end_time": "13:37",
                        "alltime": "4小时37分钟",
                        "station": [{}, {}, {}, {}],
                    },
                }
            },
        }
        c = _canonical_train(item)
        assert c is not None
        assert len(c["trains"]) == 1
        assert c["trains"][0]["number"] == "G7"
        assert c["trains"][0]["stops_count"] == 4
        assert c["trains"][0]["price"] is None  # 这个 subdisplay 无 ticket

    def test_legacy_falls_back_to_alternate_number_field(self) -> None:
        """文档写的 num / checi_num 字段名作为 number 兜底."""
        item = {
            "vr": True,
            "vr_category": "train",
            "vrid": "703301",
            "display": {
                "subitem": {
                    "subdisplay": {
                        "checi_num": "D310",  # 没 number, 用 checi_num
                        "type": "动车",
                        "start_station": "A",
                        "end_station": "B",
                    }
                }
            },
        }
        c = _canonical_train(item)
        assert c is not None
        assert c["trains"][0]["number"] == "D310"

    def test_legacy_subitem_without_number_skipped(self) -> None:
        """subdisplay 没 number 字段 → 该 entry 被跳过."""
        item = {
            "vr": True,
            "vr_category": "train",
            "vrid": "703300",
            "display": {
                "subitem": [
                    {"subdisplay": {"type": "高铁"}},  # 没 number 跳过
                ]
            },
        }
        assert _canonical_train(item) is None  # 全部跳过 → 无 trains → None

    def test_legacy_format_multi_train_with_price(self) -> None:
        """多车次 + 含 ticket → format 含价格."""
        item = {
            "vr": True,
            "vr_category": "train",
            "vrid": "703300",
            "display": {
                "subitem": [
                    {
                        "subdisplay": {
                            "number": "G1",
                            "type": "高铁",
                            "start_station": "北京南",
                            "start_time": "06:30",
                            "end_station": "上海虹桥",
                            "end_time": "11:24",
                            "alltime": "4小时54分钟",
                            "station": [{}] * 7,
                            "ticket": {"price": "553", "ticket_type": "二等座"},
                        }
                    },
                ]
            },
        }
        c = _canonical_train(item)
        assert c is not None
        text = _format_train_canonical(c)
        assert "G1" in text
        assert "¥553" in text
        assert "二等座" in text
        assert "经停 7 站" in text

    def test_passage_path_takes_precedence_over_legacy(self) -> None:
        """同时有 passage 和 display.subitem → passage 路径优先 (新数据更详细)."""
        item = _mk_vr_item("train", "70083601", _PASSAGE_TRAIN)
        item["display"] = {
            "subitem": {
                "subdisplay": {
                    "number": "OLD",
                    "start_station": "X",
                    "end_station": "Y",
                }
            }
        }
        c = _canonical_train(item)
        assert c is not None
        # 应该来自 passage (G1), 不是 legacy (OLD)
        assert c["trains"][0]["number"] == "G1"


class TestRendererCanonicalIntegration:
    """_render_stock/exchangerate/gold/train 优先走 canonical, fallback 到老 schema."""

    def test_render_stock_uses_canonical_when_jsondata_empty(self) -> None:
        """老 jsonData 路径取不到数据时, canonical 接管, LLM 拿到完整文本."""
        item = _mk_vr_item("stock", "70280301", _PASSAGE_STOCK_A)
        text = _render_stock(item)
        assert "贵州茅台" in text  # canonical 路径生效
        assert "1275.98" in text
        assert text != ""  # 不是 fallback 兜底 ""

    # 汇率文字渲染沿规范化数据，避免双份解析漂移。
    def test_render_exchangerate_uses_canonical(self) -> None:
        item = _mk_vr_item("exchangerate", "70269501", _PASSAGE_EXCHANGERATE)
        text = _render_exchangerate(item)
        assert "USD/CNY" in text
        assert "6.7805" in text

    # 黄金行情文字沿规范化报价。
    def test_render_gold_quote_uses_canonical(self) -> None:
        item = _mk_vr_item("gold", "70227501", _PASSAGE_GOLD_QUOTE)
        text = _render_gold(item)
        assert "国内价格(元/克)" in text
        assert "957.95" in text

    # 多商家文字沿规范化分组。
    def test_render_gold_merchant_uses_canonical(self) -> None:
        item = _mk_vr_item("gold", "70099201", _PASSAGE_GOLD_MERCHANT)
        text = _render_gold(item)
        assert "金店" in text
        assert "周大福" in text

    # 火车文字沿规范化车次与路线。
    def test_render_train_uses_canonical(self) -> None:
        item = _mk_vr_item("train", "70083601", _PASSAGE_TRAIN)
        text = _render_train(item)
        assert "G1" in text
        assert "北京南" in text
        assert "经停 3 站" in text

    def test_render_stock_fallback_to_jsondata_when_no_passage(self) -> None:
        """无 passage 但有老 jsonData.display_info.group → fallback path 仍然工作."""
        item = {
            "vr": True,
            "vr_category": "stock",
            "vrid": "70280999",
            "jsonData": {
                "display_info": {
                    "group": [
                        {
                            "name": "老 schema 股票",
                            "code_stock": "000001",
                            "type": "A股",
                            "price": "100.00",
                            "number_closed": "99.00",
                            "number_open": "99.50",
                            "number_high": "101.00",
                            "number_low": "98.00",
                        }
                    ]
                }
            },
        }
        text = _render_stock(item)
        assert "老 schema 股票" in text


def test_weather_rejects_non_text_summary_before_ui_canonical():
    """异常旧天气摘要不能成为前端canonical，文本和其他搜索结果仍可独立处理。"""
    from .test_unisearch import load_package

    provider, _ = load_package()
    from unisearch_test_plugin.weather import _canonical_weather

    bad = {
        "jsonData": {
            "display_info": {
                "day": [
                    {"summary": {"bad": True}, "number_low": "10", "number_high": "20"}
                ]
            }
        }
    }
    assert _canonical_weather(bad) is None
