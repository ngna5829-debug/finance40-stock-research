#!/usr/bin/env python3
import json,urllib.parse
import agents_runtime
import market_bridge as market

class Handler(market.Handler):
    def do_GET(self):
        parsed=urllib.parse.urlsplit(self.path)
        if not parsed.path.startswith('/api/agents/'):return super().do_GET()
        if not self.security():return
        try:
            if parsed.path=='/api/agents/models':self.reply(agents_runtime.models());return
            if parsed.path=='/api/agents/status':self.reply(agents_runtime.status(urllib.parse.parse_qs(parsed.query).get('id',[''])[0]));return
            self.reply({'error':'会话接口不存在。'},404)
        except ValueError as e:self.reply({'error':str(e)},400)
    def do_POST(self):
        parsed=urllib.parse.urlsplit(self.path)
        if not parsed.path.startswith('/api/agents/'):return super().do_POST()
        if not self.security():return
        if not market.secrets.compare_digest(self.headers.get('X-Bridge-Token',''),market.REFRESH_TOKEN):self.reply({'error':'需要本进程token。'},403);return
        try:
            n=int(self.headers.get('Content-Length','0'))
            if not 0<n<=8192:raise ValueError('会话请求体过大或为空。')
            d=json.loads(self.rfile.read(n))
            if not isinstance(d,dict):raise ValueError('会话请求必须为JSON对象。')
            if parsed.path=='/api/agents/run':self.reply(agents_runtime.start(market.snapshot_data(),market.canonical_symbol(d.get('symbol','')),d.get('model','')),202);return
            if parsed.path=='/api/agents/cancel':self.reply(agents_runtime.cancel(d.get('id','')));return
            self.reply({'error':'会话接口不存在。'},404)
        except (ValueError,TypeError) as e:self.reply({'error':str(e)},400)

if __name__=='__main__':
    # Health describes all four actually loaded modules, including SEC extraction.
    files=[market.pathlib.Path(__file__),market.pathlib.Path(market.__file__),market.pathlib.Path(agents_runtime.__file__),market.pathlib.Path(market.sec_fundamentals.__file__)]
    market.LOADED_CODE_SHA256=market.hashlib.sha256(b''.join(p.name.encode()+b'\0'+p.read_bytes() for p in files)).hexdigest()
    market.Handler=Handler
    market.main()
