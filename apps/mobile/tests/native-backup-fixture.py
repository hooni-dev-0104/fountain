"""Isolated loopback HTTPS backup protocol fixture; no production account/data access."""
import argparse, hashlib, http.server, json, ssl, threading, time, uuid
from datetime import datetime, timedelta, timezone
DATA = bytes((i * 31 + i // 65536 * 17) & 255 for i in range(3 * 262144 + 123))
SHA = hashlib.sha256(DATA).hexdigest()
STATE = {}
LOCK = threading.Lock()
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, status, data, headers=None):
        raw = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        for key, value in (headers or {}).items(): self.send_header(key, value)
        self.send_header('Content-Length', str(len(raw))); self.end_headers()
        try: self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError): pass
    def token(self): return self.headers.get('Cookie', '').removeprefix('fountain_session=')
    def do_POST(self):
        if self.path != '/api/session': return self.reply(404, {})
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        mode = body.get('mode', 'normal')
        if mode not in ('normal', 'hash', 'range', 'denied', 'cancel'): return self.reply(400, {})
        token = uuid.uuid4().hex
        with LOCK: STATE[token] = {'mode': mode, 'pieces': 0}
        self.reply(200, {'authenticated': True}, {'Set-Cookie': 'fountain_session='+token+'; Path=/; Secure; HttpOnly; SameSite=Strict'})
    def do_DELETE(self):
        with LOCK: STATE.pop(self.token(), None)
        self.reply(200, {})
    def do_GET(self):
        with LOCK: state = STATE.get(self.token())
        if state is None: return self.reply(401, {'authenticated': False})
        if self.path == '/api/session':
            denied = state['mode'] == 'denied' and state['pieces'] > 0
            return self.reply(200, {'authenticated': True, 'mode': 'accounts', 'required': True,
                'workspace_id': 'native-backup-qa', 'cache_binding': self.token(),
                'expires_at': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat(),
                'member': {'id': 'fixture-owner', 'active': True, 'role': 'member' if denied else 'owner'}})
        job_id = '00000000-0000-0000-0000-000000000001'
        if self.path == '/api/backup/jobs/'+job_id:
            return self.reply(200, {'id': job_id, 'phase': 'ready', 'size': len(DATA),
                'sha256': '0'*64 if state['mode']=='hash' else SHA, 'progress': 1,
                'expires_at': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()})
        if self.path != '/api/backup?job_id='+job_id: return self.reply(404, {})
        import re
        match = re.fullmatch(r'bytes=(\d+)-(\d+)', self.headers.get('Range',''))
        if not match: return self.reply(400, {})
        start,end = map(int, match.groups())
        if not (0 <= start <= end < len(DATA) and end-start < 262144): return self.reply(416, {})
        if state['mode']=='cancel': time.sleep(2)
        with LOCK: state['pieces'] += 1
        content_range = f'bytes {start}-{end}/{len(DATA)}'
        if state['mode']=='range': content_range = f'bytes {start+1}-{end}/{len(DATA)}'
        self.reply(206, DATA[start:end+1], {'Content-Range':content_range,'Content-Type':'application/octet-stream'})
if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--certificate',required=True);parser.add_argument('--key',required=True);parser.add_argument('--port',type=int,default=61602)
    options=parser.parse_args();server=http.server.ThreadingHTTPServer(('127.0.0.1',options.port),Handler)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(options.certificate,options.key);server.socket=context.wrap_socket(server.socket,server_side=True)
    print(json.dumps({'ready':True,'port':options.port,'bytes':len(DATA),'sha256':SHA}),flush=True);server.serve_forever()
