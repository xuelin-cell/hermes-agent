# 材料重建：可编辑对象与精确排版

适用：图片、扫描页或文档中的流程、表格、组织结构等，需要保留原内容并重建为原生可编辑对象。明确要求带可编辑数据的图表也使用材料路线；普通主题图文和报告提炼默认走DSL逐页write-page，不使用本路线。本文件是复杂原生API或局部改稿的脚本补充；已有PPT少量修改优先SDK。

## 一次准备后开始制作

- 保真重建直接沿用原图的内容、层级与风格；不套用主题创作的叙事扩写、逐页换构图、scenario搜索或额外配图。一张原始截图对应一页，保持材料顺序，不自行增加总览或拆页，不为了凑页新增事实和解释。
- 首次读材料时明确原文字、节点、边、页数和顺序，后续复用。疑点只补看对应区域；不要为已支持能力找源码、查不存在的SDK对齐参数或安装生成库。
- 用Write在outputs项目目录写Python脚本，定义`build(prs)`。宿主提供当前应用的python-pptx 1.0.2和辅助模块，默认画布960×540 **pt**。不执行pip，不调用系统Python，不自行保存、不渲染、不交付。
- 辅助模块只在build-material的应用子进程中自动注入；不要用Bash/system Python检查能否import。确需查看函数时直接读material-info返回的helper_reference，不查找后端源码。
- `from ppt_material_helpers import add_shape, add_text, add_route, connect`。原生`pptx` API仍全部可用，表格、图表、图片、富文本不受辅助函数限制。
- `add_shape(slide, kind, x,y,w,h, text='', fill='E8F2FA', line='145A8C', width=1, **text_style)`：kind可用rect/roundRect/diamond/ellipse/pentagon/chevron/homePlate/rightArrow/leftArrow，或原生MSO_SHAPE枚举。节点文字直接写text，不用另外叠文本框。
- text_style支持`size`、`font`、`color`、`bold`、`align='left|center|right|justify'`、`valign='top|middle|bottom'`、`margin`、`line_spacing`。节点文字默认水平和垂直居中，换行用`\n`。
- `add_text(slide,x,y,w,h,text,**style)`是独立文本框，默认左上对齐；其余文字样式相同。
- `add_route(slide,[(x,y),...],color='145A8C',width=1.5,arrow=True,dash=None)`：单个原生直线/开放折线对象。折点可编辑，箭头在最后一段终点，不吸附节点。
- `connect(slide,source_shape,target_shape,source_site=3,target_site=1,elbow=False,...)`可写原生节点连接关系。矩形连接点0顶/1左/2底/3右，其他形状按原生定义；不得把普通折线宣称成吸附连接器。
- Python脚本负责本任务的自由设计和对象坐标，辅助函数不提供固定卡片模板。原图无关的事实、解释性文案不自行新增。

## 调用与检查

已有page_file页面数据需要改稿时，修改原JSON中具体问题页，使用同一工作稿路径与`edit_pages=[从0开始的问题页号]`再次build-material。JSON仍保留完整pages数组及原画布，宿主只替换指定页，拒绝改变页数/画布及范围外的页面。复用已识别原文和source_image；不要为了改一页切换脚本、另建v2/v3或重新识别整稿。缺少支持的对象能力时才改用script_file，继续保留原工作稿并声明edit_pages。

核对只读本版本返回的review_previews；不要用page-*.png或其它渲染器的图片代替本版本核对凭证。预览有具体内容/版式问题才局部修复；保存被占用时先处理该路径的占用，不改名重建。不为寻找微小渲染差异另写像素测量或多渲染器对照链。原文、框形、强调色、箭头方向和可编辑性仍须实际确认，不能因为结构检查通过就省略。

1. `build-material(file_path=工作稿, script_file=脚本, expected_pages=用户页数)`：一次执行脚本，生成候选稿，保存、结构检查，再用现有SDK渲染待核对页。没有LibreOffice依赖。内部文件不会以交付卡片展示。
2. 宿主按批提供待核对页图片。用`review-material`的`reviewed_pages`列出通过页，`review_issues`列出确认的问题页和位置，`unconfirmed_pages`列出无法确认的页及原因。每批只看一轮。
3. 视觉核对发现问题只修对应页；所有页面核对通过后finalize。未完成核对不宣称最终交付。
4. 继续已有工作稿时，用`preview-material(file_path=工作稿)`恢复待核对页并继续交付。已有通过记录且未修改的页无需重新核对。

build返回`{'required_text': ['原文片段', ...], 'reference_images': ['第1页原图绝对路径', ...]}`，reference_images与页面一一对应；没有原截图的数据报告页可用空字符串。宿主核对关键原文，并在review_previews提供原图与成品上下对照图。结构一致不能代替原图核验，尤其检查局部蓝色强调、框形、数字与连接方向。源表格用原生表格，不用文本框和线条拼成表格。

## 最小脚本示例（示意文字，不是用户内容）

```python
from ppt_material_helpers import add_shape, add_text, connect

def build(prs):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_text(slide, 45, 25, 850, 50, '原图标题', size=28, bold=True)
    left = add_shape(slide, 'roundRect', 80, 180, 240, 80,
                     text='原文节点一', size=20, bold=True)
    right = add_shape(slide, 'roundRect', 570, 180, 240, 80,
                      text='原文节点二', size=20)
    connect(slide, left, right)
    return {'required_text': ['原图标题', '原文节点一', '原文节点二']}
```
