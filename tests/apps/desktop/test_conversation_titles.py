"""真实SessionDB隔离验证；不调用真实模型或用户Home。"""
import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

# 导入原生模块前固定隔离Home，禁止启动时的依赖修复触碰真实账号。
_import_home = tempfile.TemporaryDirectory()
os.environ["HERMES_HOME"] = _import_home.name
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("title_runtime_test", ROOT / "apps/desktop/assets/uniwork-titles/runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
from hermes_state import SessionDB

class TitleRuntimeTest(unittest.TestCase):
    """使用独立数据库走提交、自动升级、手动竞争及重启恢复的真实持久路径。"""
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home = Path(self.directory.name).resolve()
        self.patches = [patch.object(runtime, "kick"), patch.object(runtime, "publish")]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in self.patches: item.stop()
        self.directory.cleanup()

    def create(self, sid="s1", home=None, text="写一份产品推广方案", source="desktop", **kwargs):
        """模拟prompt.submit已经完成的会话及首条用户消息落盘。"""
        home = home or self.home
        home.mkdir(parents=True, exist_ok=True)
        db = SessionDB(db_path=home / "state.db")
        db.create_session(sid, source=source, **kwargs)
        db.append_message(sid, "user", text)
        db.close()
        return sid

    def run_job(self, result, home=None, during=None):
        """只替换外部模型边界，其余领取、事务及保存逻辑保持真实。"""
        home = home or self.home
        with runtime.state(home) as db:
            db.execute("UPDATE jobs SET due=0,lease=0")
            db.execute("INSERT OR IGNORE INTO starts SELECT root FROM jobs")
        calls=[]
        def model(intent, material):
            calls.append((intent, material))
            if during: during()
            return result
        runtime.run_one(home, model)
        return calls

    def title(self, sid="s1", home=None):
        """重新打开数据库模拟进程重启后的权威读取。"""
        db=SessionDB(db_path=(home or self.home)/"state.db")
        try: return db.get_session_title(sid),db.get_session_title_source(sid)
        finally: db.close()

    def test_title_waits_until_main_request_starts(self):
        self.create(); runtime.seed(self.home,"s1","临时","产品推广")
        with runtime.state(self.home) as db: db.execute("UPDATE jobs SET due=0")
        calls=[]
        self.assertFalse(runtime.run_one(self.home,lambda *_: calls.append(True)))
        self.assertEqual(calls,[])
        self.assertEqual(len(self.run_job({"status":"ready","title":"产品推广方案"})),1)

    def test_first_title_once_and_restart(self):
        self.create()
        self.assertTrue(runtime.seed(self.home,"s1","写一份产品推广方案","写一份产品推广方案",from_ui=True))
        self.assertEqual(self.title(),("写一份产品推广方案","derived"))
        self.assertEqual(len(self.run_job({"status":"ready","title":"产品推广方案制定"})),1)
        self.assertEqual(self.title(),("产品推广方案制定","llm"))
        self.assertFalse(runtime.seed(self.home,"s1","改写","新要求",from_ui=True))
        self.assertEqual(self.run_job({"status":"ready","title":"不应覆盖"}),[])

    def test_manual_rename_wins_inflight(self):
        self.create(); runtime.seed(self.home,"s1","临时标题","推广方案")
        def rename():
            db=SessionDB(db_path=self.home/"state.db")
            db.set_session_title("s1","用户自己的名称"); db.close()
        self.run_job({"status":"ready","title":"模型迟到的名称"},during=rename)
        self.assertEqual(self.title(),("用户自己的名称","user"))

    def test_compression_during_model_call_saves_to_current_tip(self):
        self.create(); runtime.seed(self.home,"s1","临时","产品推广")
        def compress():
            db=SessionDB(db_path=self.home/"state.db")
            db.end_session("s1","compression")
            db.create_session("tip",source="desktop",parent_session_id="s1")
            db.close()
        self.run_job({"status":"ready","title":"压缩后推广方案"},during=compress)
        self.assertEqual(self.title("tip"),("压缩后推广方案","llm"))
        self.assertFalse(runtime.seed(self.home,"s1","重复","新主题"))

    def test_greeting_waits_for_real_intent_without_model_call(self):
        self.create(text="你好"); runtime.seed(self.home,"s1","你好","你好")
        self.assertEqual(self.run_job({"status":"ready","title":"不应生成"}),[])
        runtime.seed(self.home,"s1","写产品计划","写产品计划",from_ui=True)
        self.assertEqual(len(self.run_job({"status":"ready","title":"产品计划编写"})),1)

    def test_real_hooks_under_multiplex_a_b_a(self):
        from agent.secret_scope import is_multiplex_active, set_multiplex_active, current_secret_scope_home
        from hermes_constants import get_hermes_home
        previous = is_multiplex_active()
        a,b=self.home/"profiles"/"a",self.home/"profiles"/"b"
        for directory in [a,b]: self.create(home=directory)
        try:
            set_multiplex_active(True)
            for directory,label in [(a,"A项目计划"),(b,"B项目合同"),(a,"A项目计划")]:
                with runtime.title_scope(directory):
                    self.assertEqual(get_hermes_home(),directory)
                    self.assertEqual(current_secret_scope_home(),str(directory))
                    runtime.before(session_id="s1",user_message=label,is_first_turn=True,platform="cli")
                    runtime.api_started(session_id="s1")
            self.assertEqual(self.title(home=a),("A项目计划","derived"))
            self.assertEqual(self.title(home=b),("B项目合同","derived"))
        finally:
            set_multiplex_active(previous)

    def test_account_profile_a_b_a(self):
        a,b=self.home/"account-a"/"profiles"/"same",self.home/"account-b"/"profiles"/"same"
        for home in (a,b): self.create(home=home)
        runtime.seed(a,"s1","A临时","A业务")
        runtime.seed(b,"s1","B临时","B业务")
        self.run_job({"status":"ready","title":"B业务方案"},home=b)
        self.assertEqual(self.title(home=a), ("A临时","derived"))
        self.run_job({"status":"ready","title":"A业务方案"},home=a)
        self.assertEqual(self.title(home=a),("A业务方案","llm"))
        self.assertEqual(self.title(home=b),("B业务方案","llm"))

    def test_file_uses_content_not_random_name(self):
        self.create(text="@file:834912.pdf")
        runtime.seed(self.home,"s1","834912.pdf","")
        self.assertEqual(self.run_job({"status":"ready","title":"不该生成"}),[])
        runtime.material(self.home,"s1",{"content":"租赁合同：出租人和承租人的押金、租期及违约责任。"})
        calls=self.run_job({"status":"ready","title":"房屋租赁合同条款"})
        self.assertEqual(calls[0][0],"")
        self.assertIn("押金",calls[0][1]); self.assertNotIn("834912",str(calls))
        self.assertEqual(self.title(),("房屋租赁合同条款","llm"))

    def test_image_description_and_fast_result_before_seed(self):
        self.create(text="[image attached: /tmp/34953.png]")
        runtime.material(self.home,"s1","操作手册截图，介绍账户登录和密码重置步骤")
        runtime.seed(self.home,"s1","34953.png","")
        calls=self.run_job({"status":"ready","title":"账户登录与密码重置"})
        self.assertIn("密码", calls[0][1])
        self.assertEqual(self.title()[0],"账户登录与密码重置")

    def test_clear_intent_does_not_resend_unneeded_material(self):
        self.create();runtime.seed(self.home,"s1","产品推广","制定产品推广方案")
        runtime.material(self.home,"s1","无需重复发送的长材料"*100)
        calls=self.run_job({"status":"ready","title":"产品推广方案制定"})
        self.assertEqual(calls[0][1],"")

    def test_startup_resumes_enabled_project_jobs_only(self):
        a,b=self.home/"profiles"/"a",self.home/"profiles"/"b"
        for directory in [a,b]:
            self.create(home=directory); runtime.seed(directory,"s1","临时","主题")
        (a/"config.yaml").write_text("plugins:\n  enabled: [uniwork-titles]\n")
        (b/"config.yaml").write_text("plugins:\n  enabled: [uniwork-titles]\n  disabled: [uniwork-titles]\n")
        runtime.kick.reset_mock()
        runtime.resume_pending(self.home)
        self.assertEqual([call.args[0] for call in runtime.kick.call_args_list],[self.home,a])

    def test_recover_accepted_message_before_seed_without_renaming_old_chats(self):
        self.create("old")
        marker=self.home/"plugin-data"/runtime.NAME/"enabled-at"
        marker.parent.mkdir(parents=True,exist_ok=True)
        marker.write_text(str(time.time()))
        self.create("new",text="@file:/tmp/操作手册.pdf")
        runtime.recover_missing(self.home)
        self.assertEqual(self.title("old"),(None,None))
        self.assertEqual(self.title("new"),("操作手册.pdf","derived"))

    def test_duplicate_suffix_and_length(self):
        for sid in ["s1","s2"]:
            self.create(sid); runtime.seed(self.home,sid,"同一份文件.pdf","同一主题")
            self.run_job({"status":"ready","title":"同一个业务主题概括"})
        self.assertEqual(self.title("s2")[0],"同一个业务主题概括 #2")
        self.assertLessEqual(len(runtime.clean("汉"*40)),24)
        self.assertEqual(runtime.clean("👩‍💻"*24),"👩‍💻"*24)
        for sid in ["limit1", "limit2"]:
            self.create(sid); runtime.seed(self.home,sid,"临时文件名称保持原展示规则","同一主题")
            self.run_job({"status":"ready","title":"汉"*16})
        self.assertEqual(self.title("limit1")[0],"汉"*16)
        self.assertLessEqual(len(self.title("limit2")[0]),16)
        self.assertTrue(self.title("limit2")[0].endswith(" #2"))


    def test_paid_attempts_bounded_and_restart_no_reset(self):
        self.create(); runtime.seed(self.home,"s1","临时","问题")
        for _ in range(3): self.assertEqual(len(self.run_job({"status":"deferred","attempted":True,"retryAfter":2})),1)
        runtime.seed(self.home,"s1","临时","问题",from_ui=True)
        self.assertEqual(self.run_job({"status":"ready","title":"不该再请求"}),[])
        self.assertEqual(self.title()[1],"derived")

    def test_no_fake_rows_or_old_fixed_names(self):
        self.assertFalse(runtime.seed(self.home,"missing","标题","问题"))
        self.create(source="cron"); self.assertFalse(runtime.seed(self.home,"s1","标题","问题"))
        self.create("named"); db=SessionDB(db_path=self.home/"state.db")
        db.set_session_title("named","业务固定名称"); db.close()
        self.assertFalse(runtime.seed(self.home,"named","新标题","问题"))

    def test_input_wrappers_are_not_intent(self):
        self.assertEqual(runtime.parsed_input('@file:`/tmp/random name.pdf`')[1],"")
        self.assertEqual(runtime.parsed_input('[image attached: /tmp/45.png]\nWhat do you see in this image?')[1],"")
        self.assertEqual(runtime.parsed_input('@file:/tmp/45.pdf\n请帮我分析合同风险')[1],"请帮我分析合同风险")

    def test_actual_mcp_image_tool_material_without_waiting_for_answer(self):
        """真实使用的识图工具名能补材料，编辑和生成工具不误入命名材料。"""
        self.create(text="@image:/tmp/random.png")
        runtime.seed(self.home,"s1","random.png","")
        with runtime.title_scope(self.home):
            for name in ["mcp__UniAI_Toolkit__edit_image", "mcp__UniAI_Toolkit__generate_image", "terminal"]:
                runtime.after_tool(session_id="s1",tool_name=name,result="不应被读取的文本",status="ok")
            with runtime.state(self.home) as jobs:
                self.assertEqual(jobs.execute("SELECT material FROM jobs").fetchone()[0],"")
            with self.assertLogs("uniwork.titles",level="INFO") as logs:
                runtime.after_tool(session_id="s1",tool_name="mcp__UniAI_Toolkit__analyze_image",result={"description":"机密材料：联通元景产品功能介绍"},status="ok")
            self.assertIn("source=tool",str(logs.output))
            self.assertNotIn("机密材料",str(logs.output))
        calls=self.run_job({"status":"ready","title":"联通元景产品介绍"})
        self.assertIn("联通元景",calls[0][1])
        self.assertEqual(self.title(),("联通元景产品介绍","llm"))

    def test_attachment_terminal_result_is_reused_before_final_answer(self):
        self.create(text="@file:/tmp/89413.xlsx")
        runtime.seed(self.home,"s1","89413.xlsx","")
        self.run_job({"status":"insufficient","reason":"missing_material","attempted":False})
        with patch.dict(os.environ,{"HERMES_HOME":str(self.home)}):
            for command, result in [
                ("ls -la /tmp/89413.xlsx", {"exit_code":0,"output":"89413.xlsx"}),
                ("cat /tmp/other.txt", {"exit_code":0,"output":"无关材料"}),
                ("cat /tmp/89413.xlsx.other", {"exit_code":0,"output":"同名前缀的其他文件"}),
                ("cat /tmp/89413.xlsx", {"exit_code":1,"output":"读取失败"}),
            ]:
                runtime.after_tool(session_id="s1",tool_name="terminal",args={"command":command},result=result,status="ok")
            with runtime.state(self.home) as jobs:
                self.assertEqual(jobs.execute("SELECT material FROM jobs").fetchone()[0],"")
            output="各档位智驾车型价格汇总\n价格档位|代表车型|价格区间\n10万以下|海鸥|6.98–8.58万"
            runtime.after_tool(session_id="s1",tool_name="terminal",args={"command":"python -c \"import openpyxl; w=openpyxl.load_workbook('/tmp/89413.xlsx'); print(list(w.active.values))\""},result=__import__('json').dumps({"output":output,"exit_code":0,"error":None}),status="ok")
        calls=self.run_job({"status":"ready","title":"各档位智驾车型价格汇总"})
        self.assertEqual(calls,[("",output)])
        self.assertEqual(self.title(),("各档位智驾车型价格汇总","llm"))
        db=SessionDB(db_path=self.home/"state.db")
        self.assertEqual([m['role'] for m in db.get_messages('s1')],['user'])
        db.close()

    def test_material_ready_none_retries_then_succeeds(self):
        """复现纯图片：先等待、拿到材料后NONE不再永久等待。"""
        self.create(); runtime.seed(self.home,"s1","图片.png","")
        self.assertEqual(self.run_job({"status":"ready","title":"不应请求"}),[])
        runtime.material(self.home,"s1","已读图片：联通元景产品介绍")
        with self.assertLogs("uniwork.titles",level="INFO") as logs:
            self.run_job({"status":"insufficient","reason":"no_topic","attempted":True})
        self.assertIn("reason=no_topic",str(logs.output))
        with runtime.state(self.home) as jobs:
            job=jobs.execute("SELECT * FROM jobs").fetchone()
            self.assertEqual((job["status"],job["attempts"]),("pending",1))
        self.run_job({"status":"ready","title":"联通元景产品介绍"})
        self.assertEqual(self.title(),("联通元景产品介绍","llm"))

    def test_existing_waiting_recovers_only_remaining_budget(self):
        """旧waiting仅在材料存在且剩余预算时恢复，不重置计数或重复请求已完成任务。"""
        for sid in ["retry","empty","spent","done"]:
            self.create(sid);runtime.seed(self.home,sid,sid,"")
        with runtime.state(self.home) as jobs:
            jobs.execute("UPDATE jobs SET status='waiting',attempts=1,checks=2,material='已读取的主题'")
            jobs.execute("UPDATE jobs SET material='' WHERE root='empty'")
            jobs.execute("UPDATE jobs SET attempts=3 WHERE root='spent'")
            jobs.execute("UPDATE jobs SET status='done' WHERE root='done'")
        runtime.recover_waiting(self.home)
        with runtime.state(self.home) as jobs:
            states={row["root"]:(row["status"],row["attempts"],row["checks"]) for row in jobs.execute("SELECT * FROM jobs")}
        self.assertEqual(states,{"retry":("pending",1,2),"empty":("waiting",1,2),"spent":("waiting",3,2),"done":("done",1,2)})

    def test_repeated_none_with_material_exhausts_without_false_title(self):
        """已有材料仍无有效标题，最多三次；重启或新材料不刷新预算。"""
        self.create();runtime.seed(self.home,"s1","图片.png","")
        runtime.material(self.home,"s1","模糊的图片内容")
        for _ in range(3):
            self.assertEqual(len(self.run_job({"status":"insufficient","reason":"no_topic","attempted":True})),1)
        runtime.recover_waiting(self.home)
        runtime.material(self.home,"s1","后来又出现的材料")
        self.assertEqual(self.run_job({"status":"ready","title":"不能再请求"}),[])
        self.assertEqual(self.title(),("图片.png","derived"))

    def test_output_limit_does_not_repeat_identical_requests(self):
        """响应预算耗尽不是瞬时故障，同样参数不再反复请求，保持临时标题。"""
        self.create();runtime.seed(self.home,"s1","挑选名言","挑三条名言并解释")
        self.assertEqual(len(self.run_job({"status":"unavailable","reason":"truncated","attempted":True})),1)
        runtime.material(self.home,"s1","主回答晚到的材料")
        runtime.recover_waiting(self.home)
        self.assertEqual(self.run_job({"status":"ready","title":"不能再请求"}),[])
        self.assertEqual(self.title(),("挑选名言","derived"))

if __name__ == "__main__": unittest.main()
