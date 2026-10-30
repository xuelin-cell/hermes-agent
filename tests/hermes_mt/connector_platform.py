"""Loopback HTTP/MCP/OAuth and TLS mail services for real connector runtimes."""
import asyncio
import base64
import hashlib
import json
import shlex
import ssl
import subprocess
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from aiohttp import web

from tests.hermes_mt.test_connectors import REPO, ConnectorPlatform


class Platform:
    def __init__(self):
        self.other = ConnectorPlatform()
        self.grants = {}
        self.clients = {}
        self.refreshes = []
        self.tokens = {}
        self.tools = json.loads((REPO / 'apps/desktop/services/open-connector/catalog/apps/aminer.json').read_text())['actions']

    def grant(self, url, owner):
        query = parse_qs(urlsplit(url).query)
        state = query['state'][0]
        self.grants[state] = (owner, query)
        return {'state': state, 'code': state}

    async def handle(self, request):
        host = request.headers.get('X-Fixture-Host')
        if host == 'ima.qq.com':
            return await self.other.handle(request)
        body = await request.json() if 'application/json' in request.content_type else dict(await request.post())
        if request.path.endswith('/register'):
            client = uuid4().hex
            self.clients[client] = body['redirect_uris'][0]
            return web.json_response({'client_id': client})
        if request.path.endswith('/token'):
            if body['grant_type'] == 'refresh_token':
                owner = body['refresh_token'].split('-')[0]
                self.refreshes.append(owner)
            else:
                owner, query = self.grants.pop(body['code'])
                expected = base64.urlsafe_b64encode(hashlib.sha256(body['code_verifier'].encode()).digest()).decode().rstrip('=')
                assert expected == query['code_challenge'][0]
                assert body['redirect_uri'] == query['redirect_uri'][0]
                assert body['client_id'] == query['client_id'][0]
                if host != 'upass.10jqka.com.cn':
                    assert self.clients[body['client_id']] == body['redirect_uri']
            token = owner + '-' + uuid4().hex + '-secret'
            self.tokens[token] = owner
            return web.json_response({'access_token': token, 'token_type': 'Bearer', 'refresh_token': owner + '-refresh', 'expires_in': 1})
        token = request.headers.get('Authorization', '').removeprefix('Bearer ')
        if host == 'mcp.aminer.cn':
            # AMiner uses an auth token directly, with all original validators/executors.
            owner = token.split('-')[0]
            if token not in {'alice-academic', 'bob-academic'}:
                return web.Response(status=401)
        else:
            owner = self.tokens.get(token)
            if not owner:
                return web.Response(status=401)
        if body.get('method') == 'initialize':
            value = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'fixture', 'version': '1'}}
        elif body.get('method') == 'tools/list':
            tools = self.tools if host == 'mcp.aminer.cn' else [{'name': 'lookup', 'inputSchema': {'type': 'object', 'properties': {}}}]
            value = {'tools': [{'name': tool['name'], 'inputSchema': tool['inputSchema']} for tool in tools]}
        elif body.get('method') == 'tools/call':
            if body.get('params', {}).get('arguments', {}).get('title') == 'blocked':
                self.blocked.set()
                await self.release.wait()
            value = {'content': [{'type': 'text', 'text': json.dumps({'owner': owner})}]}
        else:
            return web.Response(status=202)
        return web.json_response({'jsonrpc': '2.0', 'id': body['id'], 'result': value})


class Mail:
    def __init__(self):
        self.logins = []

    async def imap(self, reader, writer):
        owner = ''
        writer.write(b'* OK [CAPABILITY IMAP4rev1] ready\r\n')
        await writer.drain()
        try:
            while line := await reader.readline():
                tag, command, *rest = shlex.split(line.decode())
                command = command.upper()
                if command == 'CAPABILITY':
                    writer.write(b'* CAPABILITY IMAP4rev1\r\n')
                elif command == 'LOGIN':
                    owner = rest[0].split('@')[0]
                    if owner not in {'alice', 'bob'} or rest[1] != owner.ljust(16, 'x'):
                        writer.write((tag + ' NO bad credentials\r\n').encode())
                        await writer.drain()
                        continue
                    self.logins.append(('imap', owner))
                elif command in {'LIST', 'LSUB'}:
                    writer.write(('* ' + command + ' (\\HasNoChildren) "/" "' + owner + '-inbox"\r\n').encode())
                elif command == 'LOGOUT':
                    writer.write(b'* BYE goodbye\r\n')
                writer.write((tag + ' OK completed\r\n').encode())
                await writer.drain()
                if command == 'LOGOUT':
                    break
        finally:
            writer.close()
            await writer.wait_closed()

    async def smtp(self, reader, writer):
        stage, owner = '', ''
        writer.write(b'220 fixture ESMTP\r\n')
        await writer.drain()
        try:
            while line := await reader.readline():
                text = line.decode().strip()
                if text.startswith('EHLO'):
                    writer.write(b'250-fixture\r\n250 AUTH LOGIN\r\n')
                elif text == 'AUTH LOGIN':
                    stage = 'user'
                    writer.write(b'334 VXNlcm5hbWU6\r\n')
                elif stage == 'user':
                    owner = base64.b64decode(text).decode().split('@')[0]
                    stage = 'password'
                    writer.write(b'334 UGFzc3dvcmQ6\r\n')
                elif stage == 'password':
                    valid = owner in {'alice', 'bob'} and base64.b64decode(text).decode() == owner.ljust(16, 'x')
                    writer.write(b'235 authenticated\r\n' if valid else b'535 denied\r\n')
                    if valid:
                        self.logins.append(('smtp', owner))
                    stage = ''
                elif text == 'QUIT':
                    writer.write(b'221 bye\r\n')
                    await writer.drain()
                    break
                else:
                    writer.write(b'250 ok\r\n')
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()


def tls_context(directory):
    cert, key = directory / 'cert.pem', directory / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
                    '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return context
