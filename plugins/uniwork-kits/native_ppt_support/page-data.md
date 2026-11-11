# 材料页数据：自由排版与原生对象

用于忠实重建图片、流程、表格，以及明确要求带可编辑数据图表的统计报告。普通主题与报告提炼默认走DSL逐页write-page，不因有附件或页数多切换到本接口。本材料接口的坐标、版式和视觉选择仍由任务设计决定，不限固定模板。材料齐全后，直接写页面JSON，不再编写绘图库包装器、测色脚本或安装依赖。坐标和字号统一 **pt**，默认960×540。原图有明确尺寸时统一按比例换算一次即可，不做没有具体缺陷的反复像素校准。

调用：`TencentPpt(action="build-material",file_path="项目/成品.pptx",page_file="项目/pages.json",expected_pages=页数)`。不需要create空稿。

```json
{"canvas":{"width":960,"height":540},"pages":[
  {"background":"FFFFFF","source_text":["采购审批","金额≥10,000元？","退回补充材料"],"elements":[
    {"type":"text","x":40,"y":25,"w":850,"h":50,"text":"采购审批","style":{"size":30,"bold":true,"color":"153858"}},
    {"type":"shape","shape":"diamond","x":350,"y":160,"w":230,"h":120,"fill":"FFF3D9","line":"C89220","text":"金额≥10,000元？","style":{"size":18}},
    {"type":"shape","shape":"rect","x":80,"y":340,"w":230,"h":60,"fill":"FCEDED","line":"BB5D5D","text":"退回补充材料","style":{"size":18}},
    {"type":"line","points":[[350,220],[195,220],[195,340]],"color":"3475BA","width":1.5,"arrow":true}
  ]}
]}
```

## 对象

- `text`：x,y,w,h,text,style。文字框默认左上、无内边距。
- `shape`：x,y,w,h,shape,fill,line,line_width,text,style。shape支持rect/roundRect/diamond/ellipse/pentagon/chevron/homePlate/rightArrow/leftArrow；原图是直角框就用rect，不能美化成圆角。fill/line可为null；默认无阴影。文字默认水平垂直居中。
- 文字`style`：size,font,color,bold,align(left/center/right/justify),valign(top/middle/bottom),margin,line_spacing(倍率)。换行写`\n`，不要按字数猜折行。没有理由不改原文。
- 富文本：用`runs:[{"text":"缺乏","color":"1F2937"},{"text":"统一语义层","color":"1E56F5","bold":true}]`替代text。多段落用`paragraphs:[{"runs":[...]}]`。保留原图强调范围，不把整句都改成蓝色。
- `line`：points=[[x,y],...],color,width,arrow。原生开放折线，最后一段带箭头；不是整页图片，也不自动吸附节点。原文箭头标签用独立text。
- `table`：x,y,w,h,rows二维数组；单元格可以是字符串，或`{"text":"根因","fill":"1E56F5","style":{"color":"FFFFFF","bold":true}}`，也支持runs。style是单元格默认文字样式。可指定column_widths和row_heights，分别与总宽高一致。`borders:{"bottom":{"color":"CFDFEF","width":1}}`表示只有底部浅色横线，未指定边不画线；可在单元格覆盖borders。源材料的行列表格用原生table，不用许多文字框和直线拼表格。
- `chart`：x,y,w,h,chart(column/bar/line/pie/doughnut),categories,series。例：`"categories":["7月","8月","9月"],"series":[{"name":"用电量","values":[12800,11600,10240],"color":"168047"}]`。使用原生图表及内嵌Excel数据，legend可指定true/false。
- `image`：x,y,w,h,path(已存在的本地文件),fit(contain或cover)。默认保持比例完整显示；cover居中裁切，不拉伸照片。

普通柱状图无需编写Python或查询图表私有API。以下对象可直接放入elements；标题、单位和说明仍用text对象自由排版：
```json
{"type":"chart","x":60,"y":150,"w":600,"h":310,"chart":"column","categories":["预算","实际"],"series":[{"name":"金额（万元）","values":[28,25.2],"color":"245A81"}],"legend":false}
```

## 原文与检查

每页`source_text`保存**首次核对后的原文**，与排版elements分开；构建逐页比对，不能改source_text掩盖生成错误。报告提炼允许缩写正文，但忠实重建的专业词、数字、比较符、表头不得改写。先确认“贷款/存款”“根因/原因”“业务流程/业务逻辑”以及金额分支，疑点只补看对应原图区域。不要凭常识纠正用户原文。

截图重建页同时填写`source_image:"prepare-material返回的原始截图绝对路径"`，不填裁剪碎片。宿主会把原截图和已保存PPT预览上下拼成review_previews，顶部SOURCE、底部SAVED PPT。用现有视觉工具直接对比原图与成品的原文、框形及局部蓝色/加粗范围，不能只对照先前的识图文字记录。普通数据报告没有原截图时不填写source_image。

错误会返回页号和对象号，原稿保持不变。只修对应JSON或换用已有脚本路径，不重识别所有材料。预览出现真实遮挡、漏字或箭头错误才修复；没有实际问题不做反复字号校准。source_text一致只证明构建忠实于记录，不能代替与原图的核对。

需要上述对象没有覆盖的复杂图表/自定义几何/局部改稿，读material-info返回的script_guide，继续用完整python-pptx API，不受固定模板限制。不要同时写JSON和等价Python脚本。
