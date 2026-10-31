"""Own only the relay gateway subprocess launched by this forwarder."""
import asyncio
import json
import os
from pathlib import Path
import aiohttp

RELAY_PORT = 9123


class Gateway:
    def __init__(self, home, python):
        self.home = Path(home)
        self.process = None
        self.settings = None
        self.python = python
        self.port = RELAY_PORT
        self.lock = asyncio.Lock()
        self.watcher = None

    async def start(self, settings, env):
        async with self.lock:
            if not (self.settings == settings and self.process and self.process.returncode is None):
                await self._stop()
                # Configuration is written by the matching Hermes interpreter, preserving
                # its normal YAML validation and profile-aware path handling.
                script = '''import json,sys
from hermes_cli.config import read_user_config_raw,save_config
cfg=read_user_config_raw(); settings=json.loads(sys.stdin.read())
platforms=cfg.setdefault('platforms',{})
platform=settings.get('platform','uniagentgate')
if platform not in ('uniagentgate','dingtalk','weixin','wecom','feishu'): raise ValueError('Unsupported platform')
if any(name not in ('uniagentgate','dingtalk','weixin','wecom','feishu') and isinstance(value,dict) and value.get('enabled') for name,value in platforms.items()):
 raise RuntimeError('Direct platform configuration must be removed before relay startup')
cfg['cloud_messaging']={'enabled':True,**settings}
for name in ('uniagentgate','dingtalk','weixin','wecom','feishu'):
 platforms[name]={'enabled':True}
cfg.setdefault('display',{}).setdefault('platforms',{}).setdefault(platform,{})['tool_progress']='off'
platforms[platform]['typing_indicator']=False
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
        # Discovery can be slow; drain/stop must still acquire the lifecycle lock.
        return await self.ready(settings)

    async def ready(self, settings):
        # Process existence is not readiness: the registered adapter must be listening.
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as http:
            async with asyncio.timeout(180):
                while self.process and self.process.returncode is None:
                    if self.settings != settings: raise RuntimeError('Relay gateway generation changed')
                    try:
                        async with http.get(f'http://127.0.0.1:{self.port}/ready', headers={
                                'Authorization': 'Bearer '+settings['upgrade_secret']}) as response:
                            if response.status == 200:
                                result = await response.json()
                                if result.get('capability') == 'entry-forward-relay-v1':
                                    return result
                    except (aiohttp.ClientError, asyncio.TimeoutError):
                        pass  # Startup listener is not available yet.
                    await asyncio.sleep(.2)
        raise RuntimeError('Relay gateway exited before readiness')

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
