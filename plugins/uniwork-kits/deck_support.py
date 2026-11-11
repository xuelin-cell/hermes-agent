"""PPT-only instructions naming bundled executable helpers, not extra tools."""
from pathlib import Path

ROOT = Path(__file__).with_name("pptx_support").as_posix()

BUILD = (
    f"PPT 公共能力已备好：先完整 read_file 阅读 {ROOT}/README.md，"
    f"theme.js 用 require('{ROOT}/helpers.cjs').createHelpers(pptx, 主题配色) 取得稳定函数，"
    "不要每份从零重写 text/image/card/header，也不要猜导出的名字。"
    "整页版式 layouts.imageText/cards 只是可选；封面、艺术页、特殊图表可自由设计，"
    "不能为了套版删掉内容、缩小正文或裁掉照片主体。"
    f"公共函数先用 node \"{ROOT}/check.cjs\" .tmp/ppt-helper-check.pptx.check 验证，"
    "再构建一两页本次真实内容验证自定义函数接口、颜色和图标；之后分批扩页。小样不得当成用户成品。\n"
    "全页完成后做一次针对性复核：需求和页数是否覆盖；数字与关键结论是否有具体来源；"
    "图片是否展示了这页要讲的特征（讲跪姿不能只用头像）；知识示意图的关系是否正确；"
    "渲染重点页核对遮挡、拥挤、可读性。有问题只改对应页或公共函数。"
    "几何自检通过不代表事实正确，识图工具的推测也要与来源核对。"
)

PHOTOS = (
    f"Commons 取图复用现成程序，不要再现写下载器：完整 read_file 阅读 {ROOT}/README.md 的输入格式，"
    "在本次目录写 subjects.json（subjects 数组：key/query/purpose），运行 "
    f"python \"{ROOT}/commons_images.py\" search --request subjects.json --out assets/candidates.json；"
    "完整读候选清单，按具体主体、需要展示的特征和构图选择 File: 文件名，再写 selection.json"
    "（images 数组：key/title/purpose），运行 "
    f"python \"{ROOT}/commons_images.py\" download --selection selection.json --out assets/photos.json。"
    "完整读结果；用 path/w/h 及源页、作者和许可。downloaded_needs_review 只代表下载成功，"
    "不代表物种或文物身份正确；有看图能力时核对实际可见特征，没有则按来源判断并说明不确定。"
    "失败会明确标出，不能换成另一主体凑数；服务不可达时可改用官网等可靠来源。"
    "遇到429/503会保存成功项并返回retry_after_seconds，冷却期间不要重跑、换UA或用curl反复探测同一接口；"
    "先做其他制作步骤或改用官方来源，冷却结束后重用同一清单路径续跑。"
)
