# 编辑已有 PPTX

1. prepare 获取 outputs，把上传原件复制到独立项目目录，保留原件。生成后的修改继续用原 working_file。
2. inspect 到新的空 out 目录，读取目标页面。
3. schema(tool_name) 查询所需 slide_* 参数，mcp 仅修改目标对象。file_id 由宿主自动注入，页号与对象下标从 0 开始。
4. mcp(save_file) 保存后 finalize。保持未变页，既有最终快照不覆盖。
5. 不运行 edsdk.py，不扫描其他应用编辑器池。

## 入口工具

| 工具 | 说明 |
|---|---|
| `TencentPpt prepare` | 返回本会话工作目录；不创建文件 |
| `TencentPpt inspect` | 读取指定工作稿，输出到新的 out 目录 |
| `TencentPpt schema` | 查询一个目标 slide_* 工具的实际参数 |
| `TencentPpt mcp` | 在指定工作稿内调用该工具，宿主提供 file_id |
| `TencentPpt mcp(save_file)` | 保存当前修改，再 finalize 交付新版本 |

不调用其它宿主的 get_pool_status、present_files、open_file、close_file 或 create_slide。

选具体 `slide_*` 工具、坐标与层级约定：阅读 [slide-tools.md](references/cli/slide-tools.md)。
