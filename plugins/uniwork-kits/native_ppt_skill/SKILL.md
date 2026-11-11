---
name: pptx
display_name_zh: PPT
display_name_en: Presentation
description: "创建、理解和编辑可交付的PPT，支持主题、数据与材料重建。"
description_en: "Create, understand, and edit professional PowerPoint presentations. Generate a complete .pptx from a topic, outline, document, dataset, or reference material; answer questions about an existing deck (what a slide says, overall structure); and edit an existing pptx (titles, a specific page, add/remove slides). Triggers: make PPT, generate PPT, edit PPT, look at this PPT, what this slide says, pptx, slides."
version: v20261013
---

# PPT 演示文稿

本套件不安装、探测或调用OCR引擎（包括RapidOCR、PaddleOCR、Tesseract等）。截图用现有视觉工具；识图工具上传失败只处理该失败，不擅自安装新环境或改用OCR。无法核对时如实说明未确认部分，不宣称质量检查通过。

## 任务路由

| 任务类型 | 执行路径 |
|---| --- |
| 创建、生成PPT（含基于上传材料） | 阅读 [create-from-scratch](create-from-scratch.md) |
| 理解已有 PPT / 问答 | 阅读 [understand](understand.md) |
| 编辑已有 PPTX（含生成后的改稿） | 阅读 [edit-existing](edit-existing.md) |


## Hermes宿主适配

开始制作前阅读 [素材工具适配](host-tools.md)。普通主题创作和报告提炼沿用WorkBuddy workbuddy-pptx v20261013的原生DSL及write-page逐页写入检查，保留设计自由。上传材料先prepare-material一次提取原文和原图；精确重建或带数据图表使用material-info取得自由页面JSON或完整脚本能力。不修改原生引擎。

真实照片按image_search取得候选后，fetch-assets批量取得原图、来源和contact_sheet；一次对照总览的编号核对主体，不确定的个别图才放大。照片默认contain，保留完整主体和来源标记，不连续去水印、裁脚再反复识图。已取得素材不重复下载，不串行等待多个坏链接。

明确要求图表带可编辑数据的统计/经营稿走material-info页面JSON原生图表（自带嵌入Excel）。保留设计自由，不套固定模板；不能把DSL缓存值、堆叠错单位的图或画出来的柱子当成带数据图表。

- 所有工作文件写在 TencentPpt(action="prepare") 返回的 output_dir 下。项目目录、assets、slides 与 PPT 的相对关系沿用原生规范。
- 参考文档中的 slidep create/upsert-dsl/lint/validate/inspect，分别用 TencentPpt 的同名 action。file_path 对应 PPT 路径，dsl_file 对应 --dsl-file，page_index 对应 --page-index，out 对应 --out。不要另找系统里的 slidep、Node 或 SDK，也不要运行 edsdk.py 的端口自动探测。
- 普通主题创作和报告提炼仍先确定需求、内容结构、DESIGN.md、scenario 和 design-principle。普通创作按原生DSL组件逐页设计，读取当前页write-page结果并修复后再生成下一页，复杂CSS和特殊SVG插画仍然支持。各页构图自由变化，不套固定模板。材料保真重建按material-info的脚本、结构检查和预览核对执行；不叠加主题创作、固定模板或已通过页的整稿复检。
- 首次保存非空内容后显示“制作中·草稿”，无须为打开预览调用 PresentToUser。DSL稿所有页面原生lint通过后，TencentPpt(action="finalize", file_path=工作稿路径) 保存独立最终版本并返回实际交付回执。不得在最终交付前宣称完成；无须额外 PresentToUser 或 todo 维持进度。修稿继续改工作稿，再 finalize，已有最终版本不覆盖。
- 编辑后保存再finalize；SDK原生改稿按成功编辑和save_file的实际结果标记“修改已保存”，不冒称执行了DSL布局检查。
- 编辑流程里的 edsdk.py list/schema/call，分别用 TencentPpt(action="schema") 列表、schema(tool_name=...) 和 mcp(tool_name=..., file_path=..., arguments={原生参数})。宿主按路径打开并等待就绪，自动提供 file_id，模型不需要查全局编辑器池。编辑后用 mcp(tool_name="save_file", file_path=...) 保存。
- 输入 PPT 要先用常规文件工具复制到当前 outputs 中再处理；不覆盖用户上传原件。读取新生成的页面和用户材料沿用普通 read_file/视觉/搜索/生图工具。
- 本实验分支仅接入本地 Windows 运行时；没有切换回旧 PPT 优化链的后备路径。

批量不是默认路线，仅用户明确要求批量或对照实验时读取[批量实验](batch-experiment.md)。材料路线以实际预览核对与review-material结果为准，不套用DSL的lint交付条件。

## Hermes 实际工具协议

- 入口为 skill_view(name="pptx--pptx")，引用文档用 skill_view 的 file_path 或 read_file 读取。通过 TencentPpt(action="prepare") 返回的 skill_dir 定位完整组件与设计规范。
- 文档里的 slidep/edsdk 命令是原生参数参考。PPT 操作通过 TencentPpt 同名 action，使用返回的 working_file 和 write_file 实际保存的绝对源路径。不要运行端口探测或连接 WorkBuddy。
- 编辑工具先 TencentPpt(action="schema", tool_name=...)，再 mcp(file_path=工作稿, tool_name=..., arguments={...})。file_id 由宿主管理，保存用 mcp(tool_name="save_file")，然后 finalize。
- 材料用prepare-material→material-info→build-material。先得到已保存工作稿及预览；用现有视觉工具核对后review-material提交结果，全部确认再finalize。visual_pending_pages不为空时不可最终交付；失败只修具体页，不重新读取整份材料。
- 内部试验稿显式 purpose="internal"。0 页和内部稿不展示、不允许最终交付。
- 默认只交付用户要求的PPTX；DESIGN.md、页面源代码、脚本和中间预览留在工作目录，不作为成品附件。用户明确要求源文件时再提供。
- 用户已有完整材料时先保留内容、关系、顺序与可编辑性，未经要求不搜图或扩写。
