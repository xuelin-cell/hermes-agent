"""Own only the relay gateway subprocess launched by this forwarder."""
import asyncio
import json
import os
from pathlib import Path


class Gateway:
    def __init__(self, home, python):
        self.home = Path(home)
        self.process = None
        self.settings = None
        self.python = python
        self.lock = asyncio.Lock()
        self.watcher = None

    async def start(self, settings, env):
        async with self.lock:
            if self.settings == settings and self.process and self.process.returncode is None:
                return {'ok':True,'pid':self.process.pid}
            await self._stop()
            # Configuration is written by the matching Hermes interpreter, preserving
            # its normal YAML validation and profile-aware path handling.
            script = '''import json,sys
from hermes_cli.config import read_user_config_raw,save_config
cfg=read_user_config_raw(); settings=json.loads(sys.stdin.read())
platforms=cfg.setdefault('platforms',{})
if any(name!='uniagentgate' and isinstance(value,dict) and value.get('enabled') for name,value in platforms.items()):
 raise RuntimeError('Direct platform configuration must be removed before relay startup')
cfg['cloud_messaging']={'enabled':True,**settings}
platforms['uniagentgate']={'enabled':True}
cfg.setdefault('display',{}).setdefault('platforms',{}).setdefault('uniagentgate',{})['tool_progress']='off'
platforms['uniagentgate']['typing_indicator']=False
save_config(cfg)
'''
            update = await asyncio.create_subprocess_exec(self.python,'-c',script,stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,env=env)
            await update.communicate(json.dumps(settings).encode())
            if update.returncode != 0: raise RuntimeError('Cannot configure relay gateway')
            child_env = dict(env)
            child_env.pop('HERMES_DESKTOP',None)
            await self.spawn(child_env)
            self.settings = dict(settings)
            self.watcher = asyncio.create_task(self.supervise(child_env))
            await asyncio.sleep(.1)
            if self.process.returncode is not None: raise RuntimeError('Relay gateway exited')
            return {'ok':True,'pid':self.process.pid}

    async def spawn(self, env):
        logs = self.home / 'logs'
        logs.mkdir(parents=True,exist_ok=True)
        fd = os.open(logs / 'cloud-messaging.log',os.O_WRONLY | os.O_APPEND | os.O_CREAT,0o600)
        with os.fdopen(fd,'ab') as output:
            self.process = await asyncio.create_subprocess_exec(self.python,'-m','plugins.cloud_messaging.worker',str(os.getpid()),env=env,stdout=output,stderr=output)

    async def supervise(self, env):
        while True:
            if await self.process.wait() == 0:
                return
            await asyncio.sleep(5)
            await self.spawn(env)

    async def stop(self):
        async with self.lock:
            await self._stop()

    async def _stop(self):
        if self.watcher:
            self.watcher.cancel()
            await asyncio.gather(self.watcher,return_exceptions=True)
            self.watcher = None
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try: await asyncio.wait_for(self.process.wait(),30)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process, self.settings = None, None
