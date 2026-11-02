"""为桌面及消息渠道的耗时元景业务（翻译、播客、视频）提供冻结的后台指导。"""

# 与 desktop-deliverables 的 DELIVERY_PLATFORMS 一致：这些平台的后台成品由宿主下载并作为附件发回。
# 钉钉没有发视频的接口，视频不走后台下载，保持原样。
DELIVERY_PLATFORMS = frozenset({"weixin", "feishu", "wecom", "dingtalk", "uniagentgate"})
VIDEO_PLATFORMS = frozenset({"desktop", "weixin", "feishu", "wecom"})


def section(session_info):
    """按会话来源渲染；子代理直接执行任务，不再被父会话委派规则影响。"""
    platform = session_info.get("platform")
    if platform != "desktop":
        from gateway.config import Platform

        try:
            source = Platform(platform)
        except ValueError:
            return ""
        # 复用上游平台识别，覆盖注册的消息适配器；无对话回传的接口不承诺后台通知。
        if source in {Platform.LOCAL, Platform.API_SERVER, Platform.WEBHOOK}:
            return ""
    tools = (
        "doc_translate（文档翻译）、ai_podcast_generate（播客）、txt2vid_generate（文生视频）或 img2vid_generate（图生视频）"
        if platform in VIDEO_PLATFORMS else
        "doc_translate（文档翻译）或 ai_podcast_generate（播客）"
    )
    guidance = (
        f"用户要用元景工具箱的 {tools} 时：\n"
        "- 不要在主会话直接调用这些工具。先收齐必要参数和文件，再用 delegate_task 的 tasks 提交一个后台子任务："
        "写明实际工具全名、完整参数和文件路径，要求子任务直接调用、不再委派，不要传密钥。\n"
        "- 拿到真实后台句柄就告诉用户已提交，结束本轮；之后不要轮询，也不要重复提交。\n"
        "- 失败或超时不要自动重试，也不要换别的方式重新生成；如实告诉用户，报错里有任务 ID 就一并给出。\n"
        "- 结果里的链接和 MEDIA 文件引用原样转给用户，不要修改，也不要再用终端下载或验证。"
    )
    notice = (
        "消息渠道收到真实句柄后，通过当前会话的正常回复确认已提交。完成或失败由 Hermes 原生后台回传送回原消息会话，"
        "不另用 send_message 重复通知，不广播到其他已绑定平台。"
    )
    if platform == "desktop":
        delivery = "翻译和播客的产物由宿主在子任务内缓存并返回本机路径；必须原样传递 MEDIA 文件引用。缓存失败则保留原链接并说明无法预览，不另建下载任务。"
    elif platform in DELIVERY_PLATFORMS:
        delivery = notice + (
            "子任务的成品由宿主下载到本机，把宿主提供的 MEDIA 文件引用原样带回最终回复，交给原渠道发送附件（宿主也会自动补上）；"
            "不把本机路径当作用户可访问的链接，不承诺桌面预览。"
            "下载失败或文件超过 20MB 时宿主保留原始链接，照原样转给用户，不另建下载任务。"
        )
    else:
        delivery = notice + (
            "子任务的翻译、播客成品由宿主缓存，"
            "把宿主提供的 MEDIA 文件引用原样带回最终回复，交给原渠道发送附件；不把本机路径当作用户可访问的链接，不承诺桌面预览。"
            "缓存失败或渠道不支持附件时保留原始链接，不另建下载任务。"
        )
    return guidance + delivery + "其他 MCP 工具、博客写作和其他子代理任务均按原流程。"
