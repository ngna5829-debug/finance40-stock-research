#!/usr/bin/env python3
"""Local personal market research. Read-only upstream APIs; no orders or key files."""
import argparse
import concurrent.futures
import copy
import csv
import datetime as dt
import http.server
import hashlib
import json
import math
import os
import pathlib
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from zoneinfo import ZoneInfo
import sec_fundamentals

ROOT = pathlib.Path(__file__).resolve().parent
PORT = 8775
APP = 'regime-stock-research'
VERSION = '5.0'
LOADED_CODE_SHA256 = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
LOADED_AT = dt.datetime.now(dt.timezone.utc).isoformat()
UTC = dt.timezone.utc
NY = ZoneInfo('America/New_York')
LOCK = threading.RLock()
CACHE = {}
STOP = threading.Event()
REFRESH_TOKEN = secrets.token_urlsafe(32)
KEY = os.environ.get('APCA_API_KEY_ID') or os.environ.get('ALPACA_API_KEY', '')
SECRET = os.environ.get('APCA_API_SECRET_KEY') or os.environ.get('ALPACA_API_SECRET', '')
DEFAULT_PROVIDER = os.environ.get('MARKET_DATA_PROVIDER', 'public')
FEED = os.environ.get('ALPACA_DATA_FEED', 'iex')
AUTO_SECONDS = 300
MAX_WORKERS = 4
NETWORK_TIMEOUT = 12
NETWORK_RETRIES = 1
TASK_TIMEOUT = 600
MAX_BODY = 8192
MAX_RESPONSE = 12 * 1024 * 1024
SYMBOL = re.compile(r'^[A-Z0-9.^-]{1,15}$')
ALIASES = {'BRK-B':'BRK.B', 'BRK-A':'BRK.A', 'BF-B':'BF.B', 'BF-A':'BF.A'}
NASDAQ_ALIASES = dict(ALIASES)
SOURCE_CLASS_IDENTITIES = {symbol:{symbol,provider,provider.replace('.','/')} for symbol,provider in ALIASES.items()}
BENCHMARKS = {'SPY':'SPY', 'QQQ':'QQQ', 'IWM':'IWM', 'VIX':'^VIX', 'DJI':'^DJI', 'DJT':'^DJT'}
NASDAQ_SCREENER = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true'
NASDAQ_RANKED = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=100&sort=marketcap&order=desc'
NASDAQ_DIRECTORY = 'https://www.nasdaqtrader.com/dynamic/SymDir/'
NASDAQ_HEADERS = {'User-Agent':'Mozilla/5.0 Personal market research', 'Accept':'application/json', 'Origin':'https://www.nasdaq.com', 'Referer':'https://www.nasdaq.com/market-activity/stocks/screener'}
NYSE_SOURCE = 'https://www.nyse.com/trade/hours-calendars'
EXCLUDED_SECURITY = re.compile(r'preferred|depositary shares representing|\bnotes\b|\bbonds?\b|\bwarrants?\b|\brights?\b|\bZONES\b|exchange.traded|closed.end fund|income fund|\bETN\b', re.I)
PUBLISHED_HOLIDAYS = {
 2026: '01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25'.split(),
 2027: '01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24'.split(),
 2028: '01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25'.split()
}
PUBLISHED_EARLY = {2026:['11-27','12-24'], 2027:['11-26'], 2028:['07-03','11-24']}
STATUS = {'taskId':None, 'state':'idle', 'status':'idle', 'phase':'waiting', 'completed':0, 'total':0, 'successCount':0, 'errorCount':0, 'errors':{}, 'startedAt':None, 'finishedAt':None, 'provider':DEFAULT_PROVIDER, 'lastError':None, 'nextAutoRefreshAt':None, 'maxWorkers':MAX_WORKERS}
SNAPSHOT = None
LAST_START = 0.0
HOST_LOCKS = {}
HOST_LAST = {}


def now_utc():
    return dt.datetime.now(UTC)


def iso(value=None):
    return (value or now_utc()).isoformat()


def finite(value, positive=False, nonnegative=False):
    if type(value) not in (int,float) or not math.isfinite(value):
        return False
    return (not positive or value>0) and (not nonnegative or value>=0)


def clean_output(value):
    """JSON must never carry NaN/Infinity, even in optional upstream fields."""
    if isinstance(value, float) and not math.isfinite(value): return None
    if isinstance(value, dict): return {str(k):clean_output(v) for k,v in value.items()}
    if isinstance(value, (list,tuple)): return [clean_output(v) for v in value]
    return value


def strict_json(raw):
    def invalid_constant(_): raise ValueError('上游JSON包含非法NaN或Infinity。')
    return json.loads(raw, parse_constant=invalid_constant)


def canonical_symbol(value):
    if not isinstance(value,str): raise ValueError('股票代码须为文字。')
    symbol = value.strip().upper()
    if not SYMBOL.fullmatch(symbol): raise ValueError('股票代码不合法。')
    return symbol.replace('.','-') if not symbol.startswith('^') else symbol


def require_source_identity(raw,target,provider):
    # Class formats are a finite explicit one-to-one map, never fuzzy matching.
    target=canonical_symbol(target)
    accepted=SOURCE_CLASS_IDENTITIES.get(target,{target})
    if not isinstance(raw,str) or raw.strip().upper() not in accepted:
        raise ValueError(provider+'返回证券身份不符或缺失；未用其它证券补位。')


def throttle(host):
    with LOCK:
        guard = HOST_LOCKS.setdefault(host, threading.Lock())
    with guard:
        wait = .15 - (time.monotonic()-HOST_LAST.get(host,0))
        if wait>0: time.sleep(wait)
        HOST_LAST[host] = time.monotonic()


def fetch_bytes(url, headers=None, timeout=NETWORK_TIMEOUT, retries=NETWORK_RETRIES):
    """Only internal fixed URLs call this; no browser-supplied proxy endpoints."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https': raise ValueError('上游数据连接必须为HTTPS。')
    class ProtectedRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, response_headers, newurl):
            target=urllib.parse.urlsplit(newurl)
            if target.scheme!='https':raise ValueError('上游重定向不是HTTPS。')
            if headers and any(name.lower().startswith('apca-') for name in headers) and target.hostname!=parsed.hostname:
                raise ValueError('拒绝向不同域名转发行情凭据。')
            return super().redirect_request(request,fp,code,msg,response_headers,newurl)
    opener=urllib.request.build_opener(ProtectedRedirect())
    for attempt in range(retries+1):
        throttle(parsed.hostname)
        request = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0 PersonalMarketResearch/3.0', 'Accept':'application/json', **(headers or {})})
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE+1)
                if len(raw)>MAX_RESPONSE: raise ValueError('上游响应超过允许大小。')
                return raw
        except urllib.error.HTTPError as exc:
            code = exc.code
            if code in (429,500,502,503,504) and attempt<retries:
                try: delay = min(3,max(.4,float(exc.headers.get('Retry-After','.6'))))
                except (TypeError,ValueError): delay = .6
                time.sleep(delay)
                continue
            raise ValueError(f'上游HTTP {code}；本次未补入模拟数据。') from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt<retries:
                time.sleep(.6)
                continue
            raise ValueError('上游连接超时或不可用；本次未补入模拟数据。') from None
    raise ValueError('上游连接失败。')


def fetch_json(url, headers=None, timeout=NETWORK_TIMEOUT):
    return strict_json(fetch_bytes(url,headers,timeout).decode('utf-8-sig'))


def fetch_text(url):
    return fetch_bytes(url, {'Accept':'text/plain'}).decode('utf-8-sig')


def cache_get(key, ttl):
    with LOCK: cached = CACHE.get(key)
    if cached and time.time()-cached[0]<ttl:
        return copy.deepcopy(cached[1]), max(0,time.time()-cached[0])
    return None,0


def cache_put(key, value):
    with LOCK: CACHE[key] = (time.time(),copy.deepcopy(value))


def nth_weekday(year,month,weekday,n):
    first = dt.date(year,month,1)
    return first+dt.timedelta(days=(weekday-first.weekday())%7+7*(n-1))


def easter(year):
    a=year%19; b=year//100; c=year%100; d=b//4; e=b%4; f=(b+8)//25; g=(b-f+1)//3
    h=(19*a+b-d-g+15)%30; i=c//4; k=c%4; l=(32+2*e+2*i-h-k)%7; m=(a+11*h+22*l)//451
    return dt.date(year,(h+l-7*m+114)//31,(h+l-7*m+114)%31+1)


def observed(day, new_year=False):
    if day.weekday()==5: return None if new_year else day-dt.timedelta(days=1)
    if day.weekday()==6: return day+dt.timedelta(days=1)
    return day


def holidays(year):
    if year in PUBLISHED_HOLIDAYS:
        return {dt.date.fromisoformat(f'{year}-{md}') for md in PUBLISHED_HOLIDAYS[year]}
    memorial = dt.date(year,5,31)
    memorial -= dt.timedelta(days=memorial.weekday())
    days = [observed(dt.date(year,1,1),True),nth_weekday(year,1,0,3),nth_weekday(year,2,0,3),easter(year)-dt.timedelta(days=2),memorial,observed(dt.date(year,7,4)),nth_weekday(year,9,0,1),nth_weekday(year,11,3,4),observed(dt.date(year,12,25))]
    if year>=2022: days.append(observed(dt.date(year,6,19)))
    if year==2025: days.append(dt.date(2025,1,9))
    return set(d for d in days if d)


def trading_day(day):
    return day.weekday()<5 and day not in holidays(day.year)


def early_day(day):
    if day.year in PUBLISHED_EARLY:
        return day.strftime('%m-%d') in PUBLISHED_EARLY[day.year]
    # Fallback years are clearly marked estimated, not source verified.
    return day==nth_weekday(day.year,11,3,4)+dt.timedelta(days=1) or (day.month==12 and day.day==24 and trading_day(day)) or (day.month==7 and day.day==3 and trading_day(day))


def session_close(day):
    return dt.datetime.combine(day,dt.time(13 if early_day(day) else 16),NY)


def previous_session(day):
    cursor = day-dt.timedelta(days=1)
    while not trading_day(cursor): cursor-=dt.timedelta(days=1)
    return cursor


def market_state(at=None):
    current = (at or now_utc()).astimezone(NY)
    day = current.date()
    is_day = trading_day(day)
    opening = dt.datetime.combine(day,dt.time(9,30),NY) if is_day else None
    closing = session_close(day) if is_day else None
    if not is_day:
        state='closed'; reason='周末休市' if day.weekday()>4 else 'NYSE假日休市'
    elif current<opening:
        state='pre_market'; reason='纽约常规交易会话尚未开盘'
    elif current<closing:
        state='open'; reason='纽约常规交易会话进行中'
    elif current.hour<20:
        state='after_hours'; reason='常规交易已收市；本桥不把盘后报价作为已完成日线'
    else:
        state='closed'; reason='常规交易已收市'
    completed = day if is_day and current>=closing+dt.timedelta(minutes=30) else previous_session(day)
    next_day = day if is_day and current<opening else day+dt.timedelta(days=1)
    while not trading_day(next_day): next_day+=dt.timedelta(days=1)
    next_open = dt.datetime.combine(next_day,dt.time(9,30),NY)
    return {'state':state,'isOpen':state=='open','exchangeTime':current.isoformat(),'sessionDate':day.isoformat(),'regularOpen':opening.isoformat() if opening else None,'regularClose':closing.isoformat() if closing else None,'nextOpen':next_open.isoformat(),'expectedCompletedSession':completed.isoformat(),'calendarSource':NYSE_SOURCE,'calendarVerified':day.year in PUBLISHED_HOLIDAYS,'calendarBasis':'published_nyse_2026_2028' if day.year in PUBLISHED_HOLIDAYS else 'estimated_us_equity_calendar','reason':reason,'asOf':iso(at),'limitation':'由交易所已发布正常日历推导；没有实时交易所停市公告，不能证明当日没有临时休市。'}


def universe_data(scope='us_listed', force=False):
    if scope not in ('us_listed','us_country'): raise ValueError('股票范围须为us_listed或us_country。')
    cached,age = cache_get(('universe',scope),900)
    if cached and not force:
        cached.update(cacheStatus='memory_cache',cacheAgeSeconds=round(age,1))
        return cached
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        full = pool.submit(fetch_json,NASDAQ_SCREENER,NASDAQ_HEADERS)
        ranked = pool.submit(fetch_json,NASDAQ_RANKED,NASDAQ_HEADERS)
        nasdaq = pool.submit(fetch_text,NASDAQ_DIRECTORY+'nasdaqlisted.txt')
        other = pool.submit(fetch_text,NASDAQ_DIRECTORY+'otherlisted.txt')
        raw, rank_data, texts = full.result(),ranked.result(),[nasdaq.result(),other.result()]
    data = raw.get('data') or {}
    rows = data.get('rows')
    if not isinstance(rows,list) or not rows or any(not isinstance(r,dict) for r in rows): raise ValueError('Nasdaq未返回合法全量股票列表；未补用静态排名。')
    directory={}; directory_dates=[]
    for text in texts:
        entries = list(csv.DictReader(text.splitlines(),delimiter='|'))
        if not entries or not any(e.get('Security Name') for e in entries): raise ValueError('官方Symbol Directory无有效证券记录。')
        directory_dates.extend(line.split('|')[0] for line in text.splitlines() if line.startswith('File Creation Time'))
        for entry in entries:
            for key in ('Symbol','ACT Symbol','CQS Symbol','NASDAQ Symbol'):
                if entry.get(key): directory[entry[key].replace('/','.').replace(' ','.')] = entry
    def cap(row):
        try: value=float(str(row.get('marketCap','')).replace(',','').replace('$',''))
        except (ValueError,TypeError): return 0
        return value if math.isfinite(value) and value>0 else 0
    selected=[];seen=set();excluded={}
    for row in sorted(rows,key=cap,reverse=True):
        symbol=str(row.get('symbol','')).strip().replace('/','.').replace(' ','.')
        entry=directory.get(symbol);reason=None
        if cap(row)<=0: reason='nonpositive_market_cap'
        elif not entry: reason='not_in_official_directory'
        elif entry.get('Test Issue')!='N': reason='test_issue'
        elif entry.get('ETF')!='N': reason='etf'
        elif EXCLUDED_SECURITY.search(str(row.get('name',''))+' '+str(entry.get('Security Name',''))): reason='nonordinary_instrument'
        elif symbol in ('GOOG','BRK.A'): reason='known_duplicate_share_class'
        elif scope=='us_country' and row.get('country')!='United States': reason='outside_source_country_scope'
        elif not SYMBOL.fullmatch(symbol): reason='invalid_symbol'
        elif symbol in seen: reason='duplicate_symbol'
        if reason:
            excluded[reason]=excluded.get(reason,0)+1
            continue
        seen.add(symbol)
        if len(selected)>=100: continue
        source_url=str(row.get('url') or '')
        selected.append({'rank':len(selected)+1,'symbol':symbol.replace('.','-'),'sourceSymbol':str(row.get('symbol','')),'alpacaSymbol':symbol,'yahooSymbol':symbol.replace('.','-'),'name':str(row.get('name') or ''),'officialSecurityName':entry.get('Security Name'),'sector':row.get('sector') or '来源未分类','industry':row.get('industry') or None,'country':row.get('country') or None,'marketCapUsd':cap(row),'directoryVerified':True,'sourceURL':'https://www.nasdaq.com'+source_url if source_url.startswith('/') else 'https://www.nasdaq.com/market-activity/stocks/screener'})
    if len(selected)!=100: raise ValueError(f'真实来源与官方目录筛选后只有{len(selected)}只；没有伪造补满100只。')
    value={'stocks':selected,'source':'https://www.nasdaq.com/market-activity/stocks/screener','sourceEndpoint':NASDAQ_SCREENER,'sourceDateEndpoint':NASDAQ_RANKED,'scope':scope,'label':'美国上市普通股/ADR最近可得市值前100' if scope=='us_listed' else '来源country=United States的普通股前100','scopeDescription':'美国上市，包含外国注册公司及ADR' if scope=='us_listed' else 'Nasdaq来源country字段严格等于United States','asOf':data.get('asOf') or data.get('asof') or (rank_data.get('data') or {}).get('asof') or None,'capturedAt':iso(),'cacheStatus':'fresh_upstream','cacheAgeSeconds':0,'isRealtimeMarketCap':False,'marketCapMethod':'按来源marketCap降序；Alphabet保留GOOGL，Berkshire保留BRK.B，不合并同公司股类市值。','limitation':'最近价格日期不等于每项市值已经独立校验；此为过滤证券类型的公开市值代理排行，非实时或审计后的公司市值排行。','filterAudit':{'sourceRows':len(rows),'excludedCounts':excluded,'directorySources':[NASDAQ_DIRECTORY+'nasdaqlisted.txt',NASDAQ_DIRECTORY+'otherlisted.txt'],'directoryFileDates':directory_dates}}
    cache_put(('universe',scope),value)
    return value


def chart(symbol, history=True):
    # Public chart query spellings can differ in availability. No login, crumb,
    # proxy, paywall or fabricated data is used; each ordinary same-source URL
    # has a bounded attempt and the successful URL remains in evidence.
    root='https://query1.finance.yahoo.com/v8/finance/chart/'+urllib.parse.quote(symbol,safe='')
    span='2y' if history else '5d'
    end=int(now_utc().timestamp());start=end-(760 if history else 8)*86400
    period_url=root+'?period1='+str(start)+'&period2='+str(end)+'&interval=1d'
    urls=[period_url,root+'?range='+span+'&interval=1d',root+'?range='+span+'&interval=1d&includePrePost=false&events=div,splits',root+'?range='+span+'&interval=1d&includePrePost=false&events=div%2Csplits']
    last_error=None
    deadline=time.monotonic()+30
    for url in urls:
        if time.monotonic()>=deadline:break
        try:
            response=fetch_json(url, {'Referer':'https://finance.yahoo.com/quote/'+urllib.parse.quote(symbol,safe='')+'/'},timeout=min(6,max(1,(deadline-time.monotonic())/2)))
            if not isinstance(response,dict):raise ValueError('公开行情响应不合法。')
            result=(response.get('chart',{}).get('result') or [None])[0]
            if not isinstance(result,dict):raise ValueError('公开行情没有返回此证券。')
            return result,url
        except ValueError as exc:
            last_error=exc
            if 'HTTP 429' in str(exc):break
    raise ValueError(str(last_error) if last_error else '公开行情同源端点均不可用。') from None


def quote_from_chart(result, symbol):
    meta=result.get('meta') or {}
    require_source_identity(meta.get('symbol'),symbol,'公开报价')
    if meta.get('currency')!='USD': raise ValueError('来源未明确USD币种；未混入美元股票数据。')
    price=meta.get('regularMarketPrice');timestamp=meta.get('regularMarketTime')
    stamp=None
    if timestamp is not None:
        if not finite(timestamp,positive=True): raise ValueError('公开报价时间非法。')
        stamp=dt.datetime.fromtimestamp(timestamp,UTC)
        if stamp>now_utc()+dt.timedelta(seconds=60): raise ValueError('公开报价时间位于未来。')
    if price is not None and not finite(price,positive=True): raise ValueError('公开报价价格非法。')
    previous=None
    quotes=(result.get('indicators',{}).get('quote') or [{}])[0]
    if stamp:
        quote_day=stamp.astimezone(NY).date()
        for i,t in enumerate(result.get('timestamp',[])):
            if finite(t,positive=True) and dt.datetime.fromtimestamp(t,NY).date()<quote_day:
                values=quotes.get('close') or []
                if i<len(values) and finite(values[i],positive=True): previous=values[i]
    return {'price':price if finite(price,positive=True) else None,'timestamp':stamp.isoformat() if stamp else None,'previousClose':previous,'currency':'USD','source':'Yahoo Finance网页行情','feed':'public_delay_unknown','isRealtime':False,'status':'available' if finite(price,positive=True) and stamp else 'unavailable','ageSeconds':max(0,(now_utc()-stamp).total_seconds()) if stamp else None}


def valid_bar(bar):
    if any(not finite(bar.get(k),positive=True) for k in ('open','high','low','close')) or not finite(bar.get('volume'),nonnegative=True): raise ValueError('K线存在非法、零价或非有限OHLCV。')
    if bar['high']<max(bar['open'],bar['close'],bar['low']) or bar['low']>min(bar['open'],bar['close'],bar['high']): raise ValueError('K线OHLC价位关系非法。')


def parse_history(result,symbol):
    require_source_identity((result.get('meta') or {}).get('symbol'),symbol,'公开历史')
    if (result.get('meta') or {}).get('currency')!='USD': raise ValueError('来源未明确USD币种。')
    times=result.get('timestamp') or []
    quotes=(result.get('indicators',{}).get('quote') or [{}])[0]
    adjusted=(result.get('indicators',{}).get('adjclose') or [{}])[0].get('adjclose') or []
    if not isinstance(times,list) or not times: raise ValueError('没有历史K线，不产生可分析数据。')
    bars=[];raw_bars=[];dropped=0;incomplete=0;previous=None
    current=now_utc().astimezone(NY);expected=market_state()['expectedCompletedSession']
    is_index=symbol.startswith('^')
    for i,timestamp in enumerate(times):
        if not finite(timestamp,positive=True): raise ValueError('K线时间非法。')
        stamp=dt.datetime.fromtimestamp(timestamp,NY)
        date=stamp.date().isoformat()
        if previous is not None and date<=previous: raise ValueError('K线日期乱序或重复。')
        previous=date
        if stamp.date()>current.date(): raise ValueError('K线日期位于未来。')
        if not trading_day(stamp.date()): raise ValueError('日线包含休市日记录；来源口径异常。')
        if date>expected:
            incomplete+=1
            continue
        fields={key:(quotes.get(key) or [])[i] if i<len(quotes.get(key) or []) else None for key in ('open','high','low','close','volume')}
        if any(v is None for v in fields.values()):
            dropped+=1
            continue
        bar={'date':date,**fields};valid_bar(bar)
        raw_bars.append(copy.deepcopy(bar))
        if not is_index:
            if i>=len(adjusted) or not finite(adjusted[i],positive=True): raise ValueError('缺少有效adjclose，不能证明历史价格口径一致，未补用原始价。')
            factor=adjusted[i]/bar['close']
            for key in ('open','high','low','close'):bar[key]=round(bar[key]*factor,6)
            valid_bar(bar)
        bars.append(bar)
    if not bars: raise ValueError('没有已完成且有效的日线。')
    return bars,raw_bars,{'sourceRows':len(times),'returnedBars':len(bars),'droppedMissingOHLCV':dropped,'incompleteTodayExcluded':incomplete,'adjcloseRequiredForEveryReturnedBar':not is_index,'historyExpectedCompletedSession':expected,'sampleSufficient':len(bars)>=210,'latestBarIsExpectedSession':bars[-1]['date']==expected,'hasMeaningfulVolume':not is_index}


def nasdaq_stock(symbol,force=False):
    """Last-resort real raw daily observations, explicitly excluded from candidates."""
    symbol=canonical_symbol(symbol)
    if symbol.startswith('^'):raise ValueError('此指数没有经过核验的Nasdaq股票历史备用。')
    cached,age=cache_get(('nasdaq_history',symbol),900)
    if cached and not force:
        cached.update(cacheStatus='memory_raw_history',cacheAgeSeconds=round(age,1),quoteCacheAgeSeconds=round(age,1))
        return cached
    asset='etf' if symbol in ('SPY','QQQ','IWM') else 'stocks'
    current=now_utc().astimezone(NY);expected=market_state()['expectedCompletedSession']
    params={'assetclass':asset,'limit':'5000','fromdate':(current.date()-dt.timedelta(days=760)).isoformat(),'todate':current.date().isoformat(),'offset':'0'}
    provider_symbol=NASDAQ_ALIASES.get(symbol,symbol)
    root='https://api.nasdaq.com/api/quote/'+urllib.parse.quote(provider_symbol,safe='')+'/historical?'
    urls=[];source_rows=[];total=None;pages=0
    while True:
        url=root+urllib.parse.urlencode(params);response=fetch_json(url,NASDAQ_HEADERS,timeout=8)
        data=response.get('data') or {}
        require_source_identity(data.get('symbol'),symbol,'Nasdaq备用')
        table=data.get('tradesTable') or {};rows=table.get('rows')
        if not isinstance(rows,list) or not rows or any(not isinstance(row,dict) for row in rows):raise ValueError('Nasdaq备用没有合法OHLCV历史。')
        count=data.get('totalRecords')
        try:declared=int(str(count).replace(',',''))
        except (TypeError,ValueError):raise ValueError('Nasdaq备用缺少可核验总行数；没有冒称完整历史。') from None
        if declared<=0 or (total is not None and total!=declared):raise ValueError('Nasdaq备用历史总行数异常。')
        total=declared;source_rows.extend(rows);urls.append(url);pages+=1
        if len(source_rows)>=total:break
        if pages>=8:raise ValueError('Nasdaq备用分页超限；未返回截断历史。')
        params['offset']=str(len(source_rows))
    if len(source_rows)!=total:raise ValueError('Nasdaq备用行数与总量不一致。')
    bars=[];dropped=0;incomplete=0;previous=None
    def number(value):
        try:return float(str(value).replace('$','').replace(',','').strip())
        except (TypeError,ValueError):return None
    for source in source_rows:
        try:day=dt.datetime.strptime(str(source.get('date','')),'%m/%d/%Y').date()
        except ValueError:raise ValueError('Nasdaq备用日线日期格式非法。') from None
        date=day.isoformat()
        if previous is not None and date>=previous:raise ValueError('Nasdaq备用日线不是严格降序或有重复。')
        previous=date
        if day>current.date() or not trading_day(day):raise ValueError('Nasdaq备用日线未来/休市日污染。')
        if date>expected:incomplete+=1;continue
        values={key:number(source.get(key)) for key in ('open','high','low','close','volume')}
        if any(value is None for value in values.values()):dropped+=1;continue
        bar={'date':date,**values};valid_bar(bar);bars.append(bar)
    bars.reverse()
    if not bars:raise ValueError('Nasdaq备用没有已完成的有效日线。')
    quality={'sourceRows':len(source_rows),'returnedBars':len(bars),'droppedMissingOHLCV':dropped,'incompleteTodayExcluded':incomplete,'adjcloseRequiredForEveryReturnedBar':False,'historyExpectedCompletedSession':expected,'sampleSufficient':len(bars)>=210,'latestBarIsExpectedSession':bars[-1]['date']==expected,'hasMeaningfulVolume':True,'priceAdjustmentVerified':False,'rangeRowsComplete':len(source_rows)==total,'historyPages':pages,'warnings':['仅原样OHLCV，未取得复权/公司行动元数据；可画图但禁止作为校准后的技术候选依据。','末根日线收盘价没有精确成交时间，不把接收时间当作价格时间。']}
    quote={'price':bars[-1]['close'],'timestamp':None,'asOfDate':bars[-1]['date'],'previousClose':bars[-2]['close'] if len(bars)>1 else None,'currency':'USD','currencyBasis':'美国上市股票/ETF端点价格单位，非发行人财务报告币种','source':'Nasdaq公开历史日线末收盘价','sourceURL':urls[0],'feed':'public_daily_close_only','isRealtime':False,'status':'available_daily_close','priceKind':'daily_close','timePrecision':'session_date','ageSeconds':None}
    value={'symbol':symbol,'providerSymbol':provider_symbol,'bars':bars,'rawBars':copy.deepcopy(bars),'quote':quote,'source':'Nasdaq官方公开网页历史（复权口径未确认）','sourceURL':urls[0],'historySourceURLs':urls,'feed':'public_daily_close_only','historyFeed':'nasdaq_public_historical','historyAsOf':bars[-1]['date'],'receivedAt':iso(),'quoteReceivedAt':iso(),'delay':'只有最新完成日线的收盘价；精确价格时刻与网页延迟未知，非实时报价','isRealtime':False,'adjustment':'raw_unadjusted_or_unknown','priceBasis':'raw_unadjusted_or_unknown_ohlcv','priceAdjustmentVerified':False,'volumeBasis':'nasdaq_source_returned_volume_unverified_adjustment','volumeAdjustment':'来源成交量原样；拆股调整口径未知','volumeAdjustmentVerified':False,'cacheStatus':'fresh_raw_upstream','cacheAgeSeconds':0,'quoteCacheAgeSeconds':0,'quality':quality,'dataQuality':copy.deepcopy(quality),'fundamentals':None,'fundamentalsStatus':{'status':'unavailable','reason':'此历史接口没有具报告期和发布日期的正式财务字段。'},'realFlows':None,'news':None,'tapeQuotes':None}
    cache_put(('nasdaq_history',symbol),value)
    return value


def public_stock(symbol,force=False):
    symbol=canonical_symbol(symbol)
    fallback,fallback_age=cache_get(('nasdaq_history',symbol),900)
    if fallback and not force:
        fallback.update(cacheStatus='memory_raw_history',cacheAgeSeconds=round(fallback_age,1),quoteCacheAgeSeconds=round(fallback_age,1))
        return fallback
    history,history_age=cache_get(('public_history',symbol),900)
    quote_cache,quote_age=cache_get(('public_quote',symbol),60)
    need_history=force or history is None
    fetched_result=None;source_url=None
    if need_history:
        try:fetched_result,source_url=chart(symbol,True)
        except ValueError as exc:
            try:
                fallback=nasdaq_stock(symbol,force)
                fallback['quality']['preferredSourceFailure']=str(exc)
                fallback['dataQuality']['preferredSourceFailure']=str(exc)
                return fallback
            except ValueError as backup_error:
                raise ValueError('公开chart与Nasdaq备用均失败：'+str(backup_error)) from None
        bars,raw_bars,quality=parse_history(fetched_result,symbol)
        history={'symbol':symbol,'providerSymbol':symbol,'bars':bars,'rawBars':raw_bars,'historyAsOf':bars[-1]['date'],'quality':quality,'receivedAt':iso(),'sourceURL':source_url}
        cache_put(('public_history',symbol),history)
        history_age=0
    if force or quote_cache is None:
        try:
            result,quote_url= (fetched_result,source_url) if fetched_result is not None else chart(symbol,False)
            quote=quote_from_chart(result,symbol)
            quote['sourceURL']=quote_url
            quote_cache={'quote':quote,'quoteReceivedAt':iso(),'quoteSourceURL':quote_url}
            cache_put(('public_quote',symbol),quote_cache);quote_age=0
        except ValueError:
            # A freshly failed quote is unavailable, not an old quote marked current.
            quote_cache={'quote':{'price':None,'timestamp':None,'previousClose':None,'currency':'USD','source':'Yahoo Finance网页行情','feed':'public_delay_unknown','isRealtime':False,'status':'unavailable','ageSeconds':None},'quoteReceivedAt':iso()}
            history['quality']['quoteRefreshError']='本次最新报价未取得；历史日线保留其原取数时间。'
    quote=copy.deepcopy(quote_cache['quote'])
    if quote.get('timestamp'):
        quote['ageSeconds']=max(0,(now_utc()-dt.datetime.fromisoformat(quote['timestamp'])).total_seconds())
    return {**history,**quote_cache,'quote':quote,'source':'Yahoo公开网页行情（实验、非官方API）','feed':'public_delay_unknown','historyFeed':'public_daily','delay':'此网页chart接口延迟未核实；以源报价时间为准，非逐笔实时报价保证','isRealtime':False,'adjustment':'指数采用原始指数点位' if symbol.startswith('^') else '历史OHLC按每根adjclose/close调整；quote原始价；volume不自行调整','priceBasis':'raw_index_level' if symbol.startswith('^') else 'adjclose_ratio_ohlc','volumeBasis':'source_returned_volume_unverified_split_convention','volumeAdjustment':'来源volume原样传递，拆股口径未独立确认','volumeAdjustmentVerified':False,'cacheStatus':'fresh_upstream' if need_history else 'memory_history_fresh_quote' if quote_age==0 else 'memory_cache','cacheAgeSeconds':round(history_age,1),'quoteCacheAgeSeconds':round(quote_age,1),'fundamentals':None,'fundamentalsStatus':{'status':'unavailable','reason':'没有具发布日期和报告期的正式财务报表字段；市值排名不代替基本面。'},'realFlows':None,'news':None,'tapeQuotes':None}


def alpaca_headers():
    if not KEY or not SECRET: raise ValueError('未设置Alpaca环境密钥；未开始受限数据请求。')
    return {'APCA-API-KEY-ID':KEY,'APCA-API-SECRET-KEY':SECRET}


def alpaca_history(symbols,force=False):
    headers=alpaca_headers();now=now_utc();mapping={s:ALIASES.get(s,s.replace('-','.')) for s in symbols}
    cached={};missing=[]
    for symbol in symbols:
        value,age=cache_get(('alpaca_history',symbol),900)
        if value and not force:
            value['cacheAgeSeconds']=round(age,1);value['cacheStatus']='memory_history_fresh_quote';cached[symbol]=value
        else: missing.append(symbol)
    pages=0
    if missing:
        # Complete pagination of the batch. A failed page rejects the entire batch.
        params={'symbols':','.join(mapping[s] for s in missing),'timeframe':'1Day','start':(now-dt.timedelta(days=760)).isoformat(),'end':(now-dt.timedelta(minutes=20)).isoformat(),'limit':10000,'feed':'sip','adjustment':'all','sort':'asc','currency':'USD'}
        by_symbol={mapping[s]:[] for s in missing};tokens=set()
        while True:
            response=fetch_json('https://data.alpaca.markets/v2/stocks/bars?'+urllib.parse.urlencode(params),headers)
            for provider_symbol,rows in (response.get('bars') or {}).items():
                if provider_symbol not in by_symbol: continue
                if not isinstance(rows,list): raise ValueError('Alpaca历史响应结构非法。')
                for bar in rows:
                    if not isinstance(bar,dict) or not isinstance(bar.get('t'),str): raise ValueError('Alpaca历史行结构非法。')
                    stamp=dt.datetime.fromisoformat(bar['t'].replace('Z','+00:00'))
                    if not stamp.tzinfo: raise ValueError('Alpaca历史时间缺时区。')
                    date=stamp.astimezone(NY).date().isoformat()
                    if date>now.astimezone(NY).date().isoformat(): raise ValueError('Alpaca日线位于未来。')
                    row={'date':date,**{name:bar.get(field) for name,field in [('open','o'),('high','h'),('low','l'),('close','c'),('volume','v')]}}
                    valid_bar(row)
                    by_symbol[provider_symbol].append(row)
            pages+=1;token=response.get('next_page_token')
            if not token:break
            if not isinstance(token,str) or token in tokens or pages>=30: raise ValueError('Alpaca分页重复或超限；未返回截断历史。')
            tokens.add(token);params['page_token']=token
        expected=market_state()['expectedCompletedSession']
        for symbol in missing:
            source_rows=by_symbol[mapping[symbol]];rows=[row for row in source_rows if row['date']<=expected]
            if any(rows[i]['date']>=rows[i+1]['date'] for i in range(len(rows)-1)) or any(not trading_day(dt.date.fromisoformat(r['date'])) for r in rows):raise ValueError('Alpaca日线乱序、重复或休市日污染。')
            if not rows: continue
            value={'symbol':symbol,'providerSymbol':mapping[symbol],'bars':rows,'historyAsOf':rows[-1]['date'],'receivedAt':iso(),'historyPages':pages,'cacheStatus':'fresh_upstream','cacheAgeSeconds':0,'quality':{'sourceRows':len(source_rows),'returnedBars':len(rows),'incompleteTodayExcluded':len(source_rows)-len(rows),'droppedMissingOHLCV':0,'sampleSufficient':len(rows)>=210,'latestBarIsExpectedSession':rows[-1]['date']==expected,'historyExpectedCompletedSession':expected,'hasMeaningfulVolume':True}}
            cache_put(('alpaca_history',symbol),value);cached[symbol]=value
    snapshots=fetch_json('https://data.alpaca.markets/v2/stocks/snapshots?'+urllib.parse.urlencode({'symbols':','.join(mapping.values()),'feed':FEED}),headers)
    if not isinstance(snapshots,dict):raise ValueError('Alpaca快照结构非法。')
    result={};errors={}
    for symbol in symbols:
        if symbol not in cached:
            errors[symbol]='Alpaca未返回此证券有效历史。';continue
        snap=snapshots.get(mapping[symbol]) or {};trade=snap.get('latestTrade') or {};previous=snap.get('prevDailyBar') or {}
        price=trade.get('p');stamp=trade.get('t');quote_time=None
        if stamp:
            try:quote_time=dt.datetime.fromisoformat(stamp.replace('Z','+00:00'))
            except (TypeError,ValueError):raise ValueError('Alpaca报价时间非法。') from None
            if not quote_time.tzinfo or quote_time>now_utc()+dt.timedelta(seconds=60):raise ValueError('Alpaca报价缺时区或位于未来。')
        if price is not None and not finite(price,positive=True):raise ValueError('Alpaca报价价格非法。')
        quote={'price':price if finite(price,positive=True) else None,'timestamp':quote_time.isoformat() if quote_time else None,'previousClose':previous.get('c') if finite(previous.get('c'),positive=True) else None,'currency':'USD','source':'Alpaca Market Data','feed':FEED,'isRealtime':True,'status':'available' if finite(price,positive=True) and quote_time else 'unavailable','ageSeconds':max(0,(now_utc()-quote_time).total_seconds()) if quote_time else None}
        result[symbol]={**cached[symbol],'quote':quote,'quoteReceivedAt':iso(),'source':'Alpaca Market Data','sourceURL':'https://data.alpaca.markets/v2/stocks/bars','feed':FEED,'historyFeed':'sip','delay':'IEX最近成交：单一交易所实时feed，非全市场逐笔' if FEED=='iex' else 'SIP最近成交：需全市场实时行情订阅权限；本桥为轮询快照','isRealtime':True,'adjustment':'历史all调整；quote未调整，不混合计算涨跌','priceBasis':'alpaca_all_adjusted_ohlc','volumeBasis':'sip_volume_split_adjusted_by_provider','volumeAdjustment':'all含拆股价量调整（Alpaca文档）','volumeAdjustmentVerified':True,'quoteCacheAgeSeconds':0,'fundamentals':None,'fundamentalsStatus':{'status':'unavailable','reason':'Alpaca报价与日线不含正式财务报表。'},'realFlows':None,'news':None,'tapeQuotes':None}
    return result,errors


def provider_clock(state):
    if not KEY or not SECRET:return state
    base=os.environ.get('APCA_API_BASE_URL','https://paper-api.alpaca.markets').rstrip('/')
    if base not in ('https://paper-api.alpaca.markets','https://api.alpaca.markets'):return state
    try:
        clock=fetch_json(base+'/v2/clock',alpaca_headers())
        stamp=dt.datetime.fromisoformat(str(clock['timestamp']).replace('Z','+00:00'))
        if type(clock.get('is_open')) is not bool or not stamp.tzinfo or abs((now_utc()-stamp).total_seconds())>120:raise ValueError('市场时钟时点无效。')
        state={**state,'isOpen':clock['is_open'],'clockSource':'Alpaca /v2/clock','clockAsOf':stamp.isoformat(),'clockReceivedAt':iso(),'nextOpen':clock.get('next_open') or state['nextOpen'],'providerIsOpen':clock['is_open']}
        if clock['is_open']: state.update(state='open',reason='正规provider clock确认常规交易开放')
        elif state['state']=='open':state.update(state='closed',reason='正规provider clock确认当前休市（与正常日历存在差别）')
        return state
    except Exception:
        return {**state,'clockStatus':'unavailable','clockLimitation':'正规市场时钟未取到；当前状态仅由已发布日历推导。'}


def update_status(**updates):
    with LOCK: STATUS.update(updates)


def run_refresh(task_id,provider,scope,force):
    global SNAPSHOT
    started=time.monotonic();stocks={};errors={}
    try:
        update_status(phase='universe')
        universe=universe_data(scope,force)
        symbols=[row['symbol'] for row in universe['stocks']]
        all_symbols=list(dict.fromkeys(list(BENCHMARKS.values())+symbols))
        update_status(phase='market',total=len(all_symbols))
        if provider=='alpaca':
            regular=[s for s in all_symbols if not s.startswith('^')]
            try:
                data,batch_errors=alpaca_history(regular,force);stocks.update(data);errors.update(batch_errors)
            except Exception as exc:
                errors.update({symbol:str(exc) if isinstance(exc,ValueError) else 'Alpaca请求失败；未反映私有响应。' for symbol in regular})
            update_status(completed=len(regular),successCount=len(stocks),errorCount=len(errors),errors=dict(errors))
            public_symbols=[s for s in all_symbols if s.startswith('^')]
        else:public_symbols=all_symbols
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures={pool.submit(public_stock,s,force):s for s in public_symbols}
            for future in concurrent.futures.as_completed(futures):
                symbol=futures[future]
                try:stocks[symbol]=future.result()
                except Exception as exc:errors[symbol]=str(exc) if isinstance(exc,ValueError) else '公开行情响应异常；未填入模拟数据。'
                update_status(completed=len(stocks)+len(errors),successCount=len(stocks),errorCount=len(errors),errors=dict(errors))
                if time.monotonic()-started>TASK_TIMEOUT:
                    for pending,pending_symbol in futures.items():
                        if pending_symbol not in stocks and pending_symbol not in errors:
                            pending.cancel()
                            errors[pending_symbol]='本轮刷新超过任务时限；未取得该证券新数据。'
                    update_status(completed=len(stocks)+len(errors),successCount=len(stocks),errorCount=len(errors),errors=dict(errors))
                    break
        update_status(phase='fundamentals')
        try:
            fundamentals_coverage=sec_fundamentals.enrich(stocks,symbols,budget_seconds=45)
        except Exception:
            fundamentals_coverage={'requested':len(symbols),'availableSelectedAnnualFacts':0,'error':'公开财报采集未完成；已取得行情保留，未补造基本面。'}
        available=sum(1 for s in symbols if s in stocks)
        benchmark_data={key:stocks[value] for key,value in BENCHMARKS.items() if value in stocks}
        state=provider_clock(market_state()) if provider=='alpaca' else market_state()
        snapshot={'generatedAt':iso(),'capturedAt':iso(),'provider':provider,'source':'自动联网：公开网页行情' if provider=='public' else '自动联网：Alpaca（指数另标公开来源）','universeSource':universe['source'],'universeAsOf':universe['asOf'],'universe':universe,'stocks':stocks,'benchmarks':benchmark_data,'marketState':state,'errors':errors,'coverage':{'requestedStocks':100,'availableStocks':available,'requestedBenchmarks':len(BENCHMARKS),'availableBenchmarks':len(benchmark_data)},'snapshotStatus':'complete' if not errors else 'partial' if stocks else 'empty','dataMode':'polling_public_delay_unknown' if provider=='public' else 'polling_alpaca_feed_plus_public_indices','quoteHistoryPolicy':'完整日线用于指标；原始最新报价单独显示。报价时间与取数时间分开，不把缓存标作实时。','moneyFlowPolicy':'未取得真实机构/订单资金净流；OBV/CMF仅是价格成交量代理，不能识别机构。','limitations':['公开chart是非官方实验接口，可被限流或停止；本地缓存有独立年龄。','市值名单是最近可得公开排名，不是逐笔实时公司合计市值。','此系统没有下单接口，没有真实机构净流入、完整盘口、新闻或正式财务报表。','现代DJI/DJT数据与1920年代工业/铁路指数成分不同，不能冒称原书实验已复现。','没有WebSocket逐笔同步序列，即使有实时feed账号，本桥也只轮询最近一次成交。'],'refreshTaskId':task_id}
        snapshot['fundamentalsCoverage']=fundamentals_coverage
        snapshot['limitations'][2]='此系统没有下单接口，没有真实机构净流入、完整盘口或新闻；SEC财报只含已取得的同口径年度XBRL事实，不代表已读完整当期报告。'
        with LOCK:SNAPSHOT=clean_output(snapshot)
        final='complete' if not errors else 'partial' if stocks else 'failed'
        update_status(state=final,status=final,phase='done',finishedAt=iso(),lastError=None if stocks else '所有行情来源本轮失败，快照为空。')
    except Exception as exc:
        message=str(exc) if isinstance(exc,ValueError) else '刷新任务失败；没有创建模拟快照。'
        update_status(state='failed',status='failed',phase='failed',finishedAt=iso(),lastError=message,errors=errors)
    finally:
        update_status(nextAutoRefreshAt=iso(now_utc()+dt.timedelta(seconds=AUTO_SECONDS)))


def start_refresh(provider=None,scope='us_listed',force=False,automatic=False):
    global LAST_START
    provider=provider or DEFAULT_PROVIDER
    if provider not in ('public','alpaca'):raise ValueError('provider须为public或alpaca。')
    if scope not in ('us_listed','us_country'):raise ValueError('scope须为us_listed或us_country。')
    if type(force) is not bool:raise ValueError('force须为布尔值。')
    if provider=='alpaca' and (not KEY or not SECRET):raise ValueError('没有Alpaca环境密钥，不能开始该provider请求。')
    with LOCK:
        if STATUS['state']=='running':return {'taskId':STATUS['taskId'],'status':'running','reused':True}
        if LAST_START and time.monotonic()-LAST_START<20 and not automatic:raise RuntimeError('刷新请求过密；至少等待20秒。')
        LAST_START=time.monotonic();task_id=secrets.token_hex(8)
        STATUS.update(taskId=task_id,state='running',status='running',phase='queued',completed=0,total=0,successCount=0,errorCount=0,errors={},startedAt=iso(),finishedAt=None,provider=provider,lastError=None)
        worker=threading.Thread(target=run_refresh,args=(task_id,provider,scope,force),daemon=True,name='market-refresh')
        worker.start()
        return {'taskId':task_id,'status':'running','reused':False}


def scheduler():
    start_refresh(automatic=True)
    while not STOP.wait(AUTO_SECONDS):
        with LOCK:provider=STATUS.get('provider',DEFAULT_PROVIDER)
        try:start_refresh(provider,automatic=True)
        except Exception:update_status(lastError='定时刷新无法启动；请核对provider与连接。')


def status_data():
    with LOCK:return copy.deepcopy(STATUS)


def snapshot_data():
    with LOCK:data=copy.deepcopy(SNAPSHOT);status=copy.deepcopy(STATUS)
    if data is None:
        return {'stocks':{},'benchmarks':{},'errors':{},'coverage':{'requestedStocks':100,'availableStocks':0,'requestedBenchmarks':6,'availableBenchmarks':0},'snapshotStatus':'empty','generatedAt':None,'capturedAt':None,'marketState':market_state(),'latestRefreshStatus':status,'limitations':['尚未取得真实联网快照，未提供模拟行情。']}
    data['latestRefreshStatus']=status
    data['snapshotAgeSeconds']=max(0,(now_utc()-dt.datetime.fromisoformat(data['capturedAt'])).total_seconds())
    # Recompute actual data ages on reads without changing provider timestamps.
    for stock in data['stocks'].values():
        stock['cacheAgeSeconds']=max(0,(now_utc()-dt.datetime.fromisoformat(stock['receivedAt'])).total_seconds())
        stock['quoteCacheAgeSeconds']=max(0,(now_utc()-dt.datetime.fromisoformat(stock['quoteReceivedAt'])).total_seconds())
        stamp=stock.get('quote',{}).get('timestamp')
        if stamp:stock['quote']['ageSeconds']=max(0,(now_utc()-dt.datetime.fromisoformat(stamp)).total_seconds())
    data['benchmarks']={key:data['stocks'][symbol] for key,symbol in BENCHMARKS.items() if symbol in data['stocks']}
    old_clock=data['marketState'];data['marketState']=market_state()
    if old_clock.get('clockAsOf'):
        data['marketState'].update({k:v for k,v in old_clock.items() if k.startswith('clock') or k=='providerIsOpen'})
        # Stale provider clock cannot keep a changing schedule state open/closed.
        stamp=dt.datetime.fromisoformat(old_clock['clockAsOf'])
        if (now_utc()-stamp).total_seconds()<120:
            data['marketState'].update(state=old_clock['state'],isOpen=old_clock['isOpen'],reason=old_clock['reason'])
    return clean_output(data)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args):pass
    def allowed_host(self):return self.headers.get('Host') in (f'127.0.0.1:{PORT}',f'localhost:{PORT}')
    def allowed_origin(self):return self.headers.get('Origin') in (None,'null',f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}')
    def end_headers(self):
        origin=self.headers.get('Origin')
        if origin and self.allowed_origin():self.send_header('Access-Control-Allow-Origin',origin)
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Vary','Origin')
        super().end_headers()
    def reply(self,value,status=200):
        raw=json.dumps(clean_output(value),ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(raw)));self.end_headers()
        try:self.wfile.write(raw)
        except (BrokenPipeError,ConnectionResetError):pass
    def security(self):
        if not self.allowed_host() or not self.allowed_origin():self.reply({'error':'不允许的Host或网页来源。'},403);return False
        return True
    def do_OPTIONS(self):
        if not self.security():return
        self.send_response(204);self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type, X-Bridge-Token');self.end_headers()
    def do_GET(self):
        if not self.security():return
        parsed=urllib.parse.urlsplit(self.path);params=urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path in ('/api/health','/health'):
                self.reply({'ok':True,'app':APP,'version':VERSION,'buildId':LOADED_CODE_SHA256[:12],'loadedCodeSha256':LOADED_CODE_SHA256,'loadedAt':LOADED_AT,'port':PORT,'refreshToken':REFRESH_TOKEN,'providerCapabilities':{'public':True,'alpaca':bool(KEY and SECRET)},'alpacaConnected':bool(KEY and SECRET),'defaultProvider':DEFAULT_PROVIDER,'feed':FEED,'autoRefreshSeconds':AUTO_SECONDS,'maxWorkers':MAX_WORKERS,'credentials':'仅环境变量与进程内存；不写文件、不回传密钥','marketState':market_state()});return
            if parsed.path=='/api/status':self.reply(status_data());return
            if parsed.path=='/api/snapshot':self.reply(snapshot_data());return
            if parsed.path=='/api/universe':
                self.reply(universe_data(params.get('scope',['us_listed'])[0],False));return
            if parsed.path in ('/api/stock','/api/observation'):
                symbol=canonical_symbol(params.get('symbol',[''])[0]);snapshot=snapshot_data();stock=snapshot['stocks'].get(symbol)
                if stock is None:self.reply({'error':'当前真实快照没有此证券数据。','symbol':symbol,'taskStatus':snapshot['latestRefreshStatus']},404);return
                if parsed.path=='/api/stock':self.reply({'stock':stock,'marketState':snapshot['marketState'],'taskStatus':snapshot['latestRefreshStatus']});return
                self.reply({key:stock.get(key) for key in ('symbol','quote','source','feed','delay','isRealtime','receivedAt','quoteReceivedAt','cacheAgeSeconds','quoteCacheAgeSeconds')}|{'marketState':snapshot['marketState']});return
            if parsed.path.startswith('/api/'):self.reply({'error':'接口不存在。'},404);return
            # Serve only the sibling app, never arbitrary home/environment files.
            resolved=(ROOT/urllib.parse.unquote(parsed.path).lstrip('/')).resolve()
            if ROOT not in resolved.parents and resolved!=ROOT:self.reply({'error':'不允许的文件路径。'},403);return
            if resolved.is_dir():
                index=resolved/'index.html'
                if not index.exists():self.reply({'error':'不提供目录列表。'},404);return
                resolved=index
            if resolved.suffix.lower() not in ('.html','.js','.css','.json','.md','.txt','.svg','.png','.gif','.jpg','.jpeg','.webp','.ico','.pdf','.csv') or resolved.name.startswith('.'):
                self.reply({'error':'此文件不提供网页访问。'},403);return
            super().do_GET()
        except ValueError as exc:self.reply({'error':str(exc)},400)
        except Exception:self.reply({'error':'数据服务暂不可用；未输出内部异常或密钥。'},502)
    def do_POST(self):
        if not self.security():return
        if urllib.parse.urlsplit(self.path).path!='/api/refresh':self.reply({'error':'只提供只读数据刷新；接口不存在。'},404);return
        supplied=self.headers.get('X-Bridge-Token','')
        if not secrets.compare_digest(supplied,REFRESH_TOKEN):self.reply({'error':'缺少本进程刷新token；先读取/api/health。'},403);return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=MAX_BODY:raise ValueError('请求大小不合法。')
            if self.headers.get('Content-Type','').split(';')[0].strip()!='application/json':raise ValueError('刷新参数须为application/json。')
            body=strict_json(self.rfile.read(length).decode('utf-8'))
            if not isinstance(body,dict) or set(body)-{'provider','scope','force'}:raise ValueError('刷新参数只能包含provider、scope、force。')
            self.reply(start_refresh(body.get('provider'),body.get('scope','us_listed'),body.get('force',False)),202)
        except RuntimeError as exc:self.reply({'error':str(exc)},429)
        except (ValueError,UnicodeDecodeError) as exc:self.reply({'error':str(exc)},400)
        except Exception:self.reply({'error':'无法启动刷新；没有发出订单或保存密钥。'},502)


def main():
    global PORT,ROOT,AUTO_SECONDS,FEED,DEFAULT_PROVIDER
    parser=argparse.ArgumentParser(description='Read-only local market research server')
    parser.add_argument('--port',type=int,default=8775);parser.add_argument('--directory',type=pathlib.Path,default=ROOT);parser.add_argument('--feed',choices=['iex','sip'],default=FEED);parser.add_argument('--provider',choices=['public','alpaca'],default=DEFAULT_PROVIDER);parser.add_argument('--interval',type=int,default=300);parser.add_argument('--no-auto',action='store_true');parser.add_argument('--open',action='store_true',help='Open the local research page')
    args=parser.parse_args();PORT=args.port;ROOT=args.directory.resolve();FEED=args.feed;DEFAULT_PROVIDER=args.provider;AUTO_SECONDS=max(60,args.interval)
    if DEFAULT_PROVIDER=='alpaca' and not (KEY and SECRET):parser.error('Alpaca provider requires existing environment credentials')
    STATUS['provider']=DEFAULT_PROVIDER
    server=http.server.ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    if not args.no_auto:threading.Thread(target=scheduler,daemon=True,name='market-scheduler').start()
    print(f'Local research server: http://127.0.0.1:{PORT} — automatic read-only refresh',flush=True)
    if args.open:webbrowser.open(f'http://127.0.0.1:{PORT}/')
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:STOP.set();server.server_close()


if __name__=='__main__':main()
