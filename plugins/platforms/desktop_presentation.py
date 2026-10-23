"""桌面受管平台的展示策略，只使用适配器专用交互接口。"""

from gateway.platforms.base import SendResult


class DesktopPresentationMixin:
    """普通发送和媒体路径不变，只收敛配置通知与专用交互。"""

    def _desktop_quiet(self) -> bool:
        """按本适配器的配置判断，不读取其它账号或全局环境。"""
        return self.config.extra.get("desktop_quiet") is True

    async def send_private_notice(
        self, chat_id, user_id, content, reply_to=None, metadata=None
    ):
        """只在原版配置通知入口隐藏完整的 Home 教程，普通回复不经过这里。"""
        tutorial = (
            f"📬 No home channel is set for {self.platform.value.title()}. "
            "A home channel is where Hermes delivers cron job results and cross-platform "
            "messages.\n\nType /sethome to make this chat your home channel, or ignore to skip."
        )
        if (
            self._desktop_quiet()
            and self.platform.value != "weixin"
            and content == tutorial
        ):
            return SendResult(
                success=True, raw_response={"suppressed_notice": "home_channel"}
            )
        return await super().send_private_notice(
            chat_id, user_id, content, reply_to=reply_to, metadata=metadata
        )

    async def send_clarify(
        self, chat_id, question, choices, clarify_id, session_key, metadata=None
    ):
        """只翻译专用澄清界面的操作说明，问题和选项原样保留。"""
        if not self._desktop_quiet():
            return await super().send_clarify(
                chat_id, question, choices, clarify_id, session_key, metadata
            )
        from tools.clarify_gateway import get_pending_for_session, mark_awaiting_text

        text = f"❓ {question}"
        if choices:
            entry = get_pending_for_session(session_key, include_choice_prompts=True)
            multi = (
                entry is not None
                and entry.clarify_id == clarify_id
                and entry.multi_select
            )
            hint = "请回复序号、选项文字，或直接输入你的回答。"
            if multi:
                hint = "可多选，请用逗号或空格分隔序号（如 1, 3），也可以回复选项文字或自己的回答。"
            text += (
                "\n\n"
                + "\n".join(f"  {i}. {choice}" for i, choice in enumerate(choices, 1))
                + "\n\n"
                + hint
            )
            mark_awaiting_text(clarify_id)
        return await self.send(chat_id=chat_id, content=text, metadata=metadata)

    async def send_slash_confirm(
        self, chat_id, title, message, session_key, confirm_id, metadata=None
    ):
        """从已登记的确认读取命令，仍由原版处理用户的批准和取消。"""
        from tools.slash_confirm import get_pending

        pending = get_pending(session_key)
        details = {
            "new": "将开始新会话，不再沿用当前会话上下文。",
            "reset": "将重置当前会话，不再沿用当前会话上下文。",
            "clear": "将清空当前会话上下文。",
            "undo": "将撤回上一轮会话内容；已经执行的文件或外部操作不会自动撤销。",
        }
        if (
            self._desktop_quiet()
            and pending
            and pending["confirm_id"] == confirm_id
            and pending["command"] in details
        ):
            command = pending["command"]
            content = (
                f"⚠️ 请确认 /{command}\n\n{details[command]}\n\n"
                "回复 /approve：仅本次确认\n"
                "回复 /always：确认并关闭后续此类会话操作的确认提示\n"
                "回复 /cancel：取消，保留当前会话"
            )
            return await self.send(chat_id=chat_id, content=content, metadata=metadata)
        return await super().send_slash_confirm(
            chat_id, title, message, session_key, confirm_id, metadata
        )

    def _format_exec_approval(
        self, command, description="dangerous command", smart_denied=False
    ):
        """在正式审批展示接口保留命令、风险和期限，只改固定说明。"""
        if not self._desktop_quiet():
            return super()._format_exec_approval(command, description, smart_denied)
        from gateway.platforms.base_exec_approval import approval_timeout_seconds

        if self._EA_REASON_BUDGET:
            description = self._ea_fit(str(description or ""), self._EA_REASON_BUDGET)
        preview = self._ea_fit(
            str(command or ""),
            self._exec_approval_cmd_budget(description, smart_denied),
        )
        reason = "危险命令" if description == "dangerous command" else description
        text = (
            "⚠️ 需要你确认才能执行命令\n\n"
            f"{self._EA_CODE_OPEN}{self._ea_escape(preview)}{self._EA_CODE_CLOSE}"
            f"需要确认的原因：{self._ea_escape(str(reason or ''))}\n\n"
            f"{approval_timeout_seconds()} 秒内未确认则不会执行。"
        )
        return text + (
            "\n\n此操作已被安全检查拒绝；所有者的本次批准只适用于这一项操作。"
            if smart_denied
            else ""
        )

    def _exec_approval_actions(self, *, allow_permanent, allow_session, smart_denied):
        """复用原版权限选项，只替换展示标签，不修改动作标识。"""
        actions = super()._exec_approval_actions(
            allow_permanent=allow_permanent,
            allow_session=allow_session,
            smart_denied=smart_denied,
        )
        labels = {
            "once": "仅本次允许",
            "session": "本会话允许",
            "always": "始终允许",
            "deny": "拒绝",
        }
        return (
            [(labels[choice], choice, style) for _, choice, style in actions]
            if self._desktop_quiet()
            else actions
        )

    async def _send_exec_approval_prompt(self, prompt):
        """无原生按钮的平台用原版文本批准命令，发送失败仍走原版失败路径。"""
        if not self._desktop_quiet():
            return await super()._send_exec_approval_prompt(prompt)
        commands = {
            "once": "/approve",
            "session": "/approve session",
            "always": "/approve always",
            "deny": "/deny",
        }
        options = "\n".join(
            f"{label}：{commands[choice]}" for label, choice, _ in prompt.actions
        )
        return await self.send(
            chat_id=prompt.chat_id,
            content=f"{prompt.text}\n\n{options}",
            metadata=prompt.metadata,
        )
