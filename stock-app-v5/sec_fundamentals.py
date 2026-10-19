"""Read-only SEC annual consolidated XBRL facts, with explicit time/context limits.

No orders, institutional flows, analyst estimates, credentials, or invented values.
Official APIs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
"""
import copy, datetime as dt, hashlib, json, math, os, pathlib, re, threading, time
import urllib.request
from zoneinfo import ZoneInfo

UTC=dt.timezone.utc
NY=ZoneInfo('America/New_York')
ROOT=pathlib.Path(__file__).resolve().parent
CACHE_FILE=ROOT/'data/sec-financial-cache.json'
LOCK=threading.RLock()
NETWORK_LOCK=threading.Lock()
LAST_REQUEST=0.0
MAX_BYTES=12*1024*1024
CACHE_SECONDS=12*3600
ERROR_CACHE_SECONDS=3600
TICKERS_URL='https://www.sec.gov/files/company_tickers.json'
USER_AGENT=os.environ.get('SEC_USER_AGENT','LocalStockResearch/5.0 personal educational research')
if '\r' in USER_AGENT or '\n' in USER_AGENT or not 0<len(USER_AGENT)<=512:
    raise ValueError('SEC_USER_AGENT须为不超过512字的单行声明。')
ANNUAL_FORMS={'10-K','10-K/A','20-F','20-F/A','40-F','40-F/A'}
ACCESSION=re.compile(r'^\d{10}-\d{2}-\d{6}$')
SYMBOL=re.compile(r'^[A-Z0-9][A-Z0-9.-]{0,14}$')
# Navigation hints never establish a security identity. Every use must be
# confirmed by the current official submissions API before company facts load.
CIK_NAVIGATION_HINTS={
    'AAPL':320193,'MSFT':789019,'AMZN':1018724,'NVDA':1045810,
    'META':1326801,'GOOG':1652044,'GOOGL':1652044,'AVGO':1730168,
    'TSLA':1318605,'BRK-B':1067983,'JPM':19617,'V':1403161,
    'WMT':104169,'LLY':59478,'MA':1141391,'XOM':34088,'ORCL':1341439,
    'COST':909832,'JNJ':200406,'ABBV':1551152,'PLTR':1321655,
    'PG':80424,'HD':354950,'BAC':70858,'GE':40545,'AMD':2488,
    'UNH':731766,'CSCO':858877,'KO':21344,'PFE':78003,'PEP':77476,
    'PM':1413329,'IBM':51143,'T':732717,'RTX':101829,'INTC':50863,
    'CVX':93410,'CAT':18230,'GS':886982,'MU':723125,'AMAT':6951,
    'UBER':1543151,'MCD':63908,'INTU':896878,'LRCX':707549,'AXP':4962,
    'SHOP':1594805,'ADBE':796343,'CRM':1108524,'DIS':1744489,
    'ABT':1800,'ANET':1596532,'BA':12927,'SCHW':316709,
    'NFLX':1065280,'QCOM':804328,'TXN':97476,'AMGN':318154,
    'GILD':882095,'BKNG':1075531,'NOW':1373715,'ISRG':1035267,
    'ADP':8670,'MS':895421,'C':831001,'BLK':1364742,'SPGI':64040,
    'UNP':100885,'UPS':1090727,'HON':773840,'LOW':60667,'NEE':753308,
    'NKE':320187,'DE':315189,'MDT':1613103,'SBUX':829224,'PGR':80661,
    'PANW':1327567,'DELL':1571996,'CRWD':1535527,'WFC':72971,
}
FIELDS={
    'revenue':('duration', [('us-gaap','RevenueFromContractWithCustomerExcludingAssessedTax'),('us-gaap','Revenues'),('us-gaap','SalesRevenueNet'),('ifrs-full','Revenue')]),
    'netIncome':('duration',[('us-gaap','NetIncomeLoss'),('ifrs-full','ProfitLoss')]),
    'operatingCashFlow':('duration',[('us-gaap','NetCashProvidedByUsedInOperatingActivities'),('ifrs-full','CashFlowsFromUsedInOperatingActivities')]),
    'capitalExpenditure':('duration',[('us-gaap','PaymentsToAcquirePropertyPlantAndEquipment'),('ifrs-full','PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities')]),
    'assets':('instant',[('us-gaap','Assets'),('ifrs-full','Assets')]),
    'liabilities':('instant',[('us-gaap','Liabilities'),('ifrs-full','Liabilities')]),
    'equity':('instant',[('us-gaap','StockholdersEquity'),('us-gaap','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'),('ifrs-full','Equity')]),
    'cashAndEquivalents':('instant',[('us-gaap','CashAndCashEquivalentsAtCarryingValue'),('ifrs-full','CashAndCashEquivalents')]),
    'assetsCurrent':('instant',[('us-gaap','AssetsCurrent'),('ifrs-full','CurrentAssets')]),
    'liabilitiesCurrent':('instant',[('us-gaap','LiabilitiesCurrent'),('ifrs-full','CurrentLiabilities')]),
}

def now():return dt.datetime.now(UTC)
def stamp(value):return value.astimezone(UTC).isoformat()
def finite(value):return type(value) in (int,float) and math.isfinite(value)
def parse_day(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):raise ValueError('缺少ISO报告或申报日期。')
    return dt.date.fromisoformat(value)
def clean_symbol(value):
    if not isinstance(value,str) or not SYMBOL.fullmatch(value.strip().upper()):raise ValueError('SEC查询证券代码不合法。')
    return value.strip().upper().replace('.','-')
def strict_json(raw):
    def bad(_):raise ValueError('SEC数据含非有限JSON数值。')
    return json.loads(raw,parse_constant=bad)

def fetch(url):
    global LAST_REQUEST
    if not (url==TICKERS_URL or re.fullmatch(r'https://data\.sec\.gov/(?:submissions/CIK\d{10}\.json|api/xbrl/companyfacts/CIK\d{10}\.json)',url)):
        raise ValueError('仅允许固定SEC公开接口。')
    with NETWORK_LOCK:
        wait=.65-(time.monotonic()-LAST_REQUEST)
        if wait>0:time.sleep(wait)
        LAST_REQUEST=time.monotonic()
        req=urllib.request.Request(url,headers={'User-Agent':USER_AGENT,'Accept':'application/json'})
        with urllib.request.urlopen(req,timeout=10) as response:
            if response.geturl()!=url:raise ValueError('SEC接口发生重定向，未接受未知来源响应。')
            raw=response.read(MAX_BYTES+1)
        if len(raw)>MAX_BYTES:raise ValueError('SEC响应超过12MB，未截断或替换数据。')
    return strict_json(raw),hashlib.sha256(raw).hexdigest()

def rows_for(facts,taxonomy,tag,received):
    units=facts.get(taxonomy,{}).get(tag,{}).get('units',{})
    rows=units.get('USD',[]) if isinstance(units,dict) else []
    output=[];today=received.astimezone(NY).date()
    for row in rows:
        if not isinstance(row,dict) or row.get('form') not in ANNUAL_FORMS or not finite(row.get('val')):continue
        if not ACCESSION.fullmatch(str(row.get('accn',''))):continue
        try:
            end=parse_day(row.get('end'));filed=parse_day(row.get('filed'))
            if end>today or filed>today:continue
            start=parse_day(row['start']) if 'start' in row else None
        except (ValueError,TypeError):continue
        if start is not None and not 300<=(end-start).days<=400:continue
        output.append({**row,'taxonomy':taxonomy,'tag':tag,'unit':'USD'})
    return output

def parse_companyfacts(payload,cik,symbol,received,source_sha256,identity):
    """Keep one actual annual filing/period. Missing/custom/nonUSD facts stay null."""
    if received.tzinfo is None:raise ValueError('接收时间须有时区。')
    if type(payload.get('cik')) is not int or payload['cik']!=cik:raise ValueError('SEC公司事实CIK与证券身份不符。')
    symbol=clean_symbol(symbol)
    if identity.get('cik')!=cik or symbol not in identity.get('symbols',[]):raise ValueError('SEC申报身份未证实当前证券代码。')
    facts=payload.get('facts',{})
    if not isinstance(facts,dict):raise ValueError('SEC事实结构错误。')
    all_rows={key:[r for taxonomy,tag in alternatives for r in rows_for(facts,taxonomy,tag,received) if ('start' in r)==(kind=='duration')] for key,(kind,alternatives) in FIELDS.items()}
    durations=[r for key in ('revenue','netIncome','operatingCashFlow') for r in all_rows[key]]
    if not durations:raise ValueError('缺少USD同口径年度收入、利润或经营现金事实；未换币或补零。')
    # The newest reporting end precedes latest filing date: do not prefer an old comparative just because it was refiled.
    selected=max(durations,key=lambda r:(r['end'],r['filed'],r['accn'],r['start']))
    context={k:selected[k] for k in ('start','end','filed','accn','form')}
    result={};missing=[];conflicts=[]
    for key,(kind,alternatives) in FIELDS.items():
        matches=[r for r in all_rows[key] if r['accn']==context['accn'] and r['end']==context['end'] and r['filed']==context['filed'] and (kind=='instant' or r['start']==context['start'])]
        value=None
        for taxonomy,tag in alternatives:
            candidates=[r for r in matches if r['taxonomy']==taxonomy and r['tag']==tag]
            if not candidates:continue
            values={r['val'] for r in candidates}
            if len(values)>1:conflicts.append(key);break
            row=candidates[0]
            value={'value':row['val'],'unit':'USD','taxonomy':taxonomy,'tag':tag,**context,'periodKind':kind}
            break
        result[key]=value
        if value is None:missing.append(key)
    def v(key):return result[key]['value'] if result[key] else None
    ocf,capex,net,ac,lc=(v(k) for k in ('operatingCashFlow','capitalExpenditure','netIncome','assetsCurrent','liabilitiesCurrent'))
    derived={'freeCashFlowSimple':ocf-capex if ocf is not None and capex is not None and capex>=0 else None,
             'operatingCashToNetIncome':ocf/net if ocf is not None and net is not None and net>0 else None,
             'currentRatio':ac/lc if ac is not None and lc is not None and ac>=0 and lc>0 else None}
    prior=None;current=result['operatingCashFlow']
    if current:
        candidates=[r for r in all_rows['operatingCashFlow'] if r['taxonomy']==current['taxonomy'] and r['tag']==current['tag'] and r['accn']==context['accn'] and r['filed']==context['filed'] and 300<=(parse_day(context['end'])-parse_day(r['end'])).days<=400]
        if candidates:
            end=max(r['end'] for r in candidates);same=[r for r in candidates if r['end']==end]
            if len({(r['start'],r['val']) for r in same})==1:
                row=same[0];prior={k:row[k] for k in ('start','end','filed','accn','val','tag','taxonomy','unit')}
    derived['operatingCashChange']=ocf-prior['val'] if current and prior else None
    derived['operatingCashChangePercent']=100*(ocf/prior['val']-1) if current and prior and prior['val']>0 else None
    source=f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010}.json'
    return {'source':'SEC EDGAR consolidated annual XBRL facts','sourceURL':source,'asOf':context['end']+'T00:00:00+00:00','availableAt':stamp(received),'receivedAt':stamp(received),
            'availabilityBasis':'Actually observed in the public SEC API at receipt; original intraday acceptance time not claimed. This cache is not a historical point-in-time database.',
            'symbol':symbol,'issuerCIK':cik,'entityName':str(payload.get('entityName',''))[:200],
            'identity':identity,'reportPeriod':context,'sourcePayloadSHA256':source_sha256,
            'filingURL':f'https://www.sec.gov/Archives/edgar/data/{cik}/{context["accn"]}-index.html',
            'currency':'USD','facts':result,'missingFacts':missing,'conflictingFacts':conflicts,'derived':derived,'priorOperatingCashFlow':prior,
            'coverage':'Selected consolidated standard-taxonomy USD annual facts, not all original annual-report pages/notes or issuer custom tags.',
            'cashFlowMeaning':'Corporate annual operating cash flow; not stock-market capital flow, institutional account activity or current cash balance.',
            'fullOriginalFilingRead':False,'realInstitutionalFlow':False,'priceTargets':None,'probability':None}

try:
    CACHE=strict_json(CACHE_FILE.read_bytes())
    if not isinstance(CACHE,dict):CACHE={}
except (OSError,ValueError):CACHE={}

def save_cache():
    CACHE_FILE.parent.mkdir(exist_ok=True)
    temp=CACHE_FILE.with_suffix('.tmp')
    temp.write_text(json.dumps(CACHE,ensure_ascii=False,allow_nan=False)+'\n')
    temp.replace(CACHE_FILE)

def ticker_map():
    cached=CACHE.get('_tickers',{})
    if time.time()-cached.get('time',0)<7*86400:return cached['value']
    failed=CACHE.get('_tickerMapError',{})
    if time.time()-failed.get('time',0)<ERROR_CACHE_SECONDS:return {}
    try:data,digest=fetch(TICKERS_URL)
    except (OSError,ValueError):
        CACHE['_tickerMapError']={'time':time.time(),'reason':'SEC公开代码表暂不可用；只尝试由当前官方申报再次核实的CIK导航提示。'}
        return {}
    if not isinstance(data,dict):raise ValueError('SEC代码映射结构错误。')
    mapping={}
    for row in data.values():
        if not isinstance(row,dict) or type(row.get('cik_str')) is not int or not 0<row['cik_str']<10**10:continue
        try:symbol=clean_symbol(row.get('ticker'))
        except ValueError:continue
        if symbol in mapping and mapping[symbol]['cik']!=row['cik_str']:raise ValueError('SEC当前代码对应多个CIK，未猜测身份。')
        mapping[symbol]={'cik':row['cik_str'],'name':str(row.get('title',''))[:200],'mappingSHA256':digest,'mappingURL':TICKERS_URL}
    if not mapping:raise ValueError('SEC代码映射为空。')
    CACHE['_tickers']={'time':time.time(),'value':mapping};return mapping

def company(symbol):
    symbol=clean_symbol(symbol);mapped=ticker_map().get(symbol)
    if not mapped and symbol in CIK_NAVIGATION_HINTS:
        mapped={'cik':CIK_NAVIGATION_HINTS[symbol], 'lookupHintOnly':True,
                'lookupHintIsNotVerifiedCurrentIdentity':True}
    if not mapped:raise ValueError('SEC当前代码表未映射该证券，未用相近公司代替。')
    cik=mapped['cik'];submission,submission_sha=fetch(f'https://data.sec.gov/submissions/CIK{cik:010}.json')
    if not isinstance(submission,dict) or not str(submission.get('cik','')).isdigit() or int(submission['cik'])!=cik:raise ValueError('SEC申报返回身份不符。')
    symbols=[]
    for value in submission.get('tickers',[]):
        try:symbols.append(clean_symbol(value))
        except ValueError:continue
    identity={**mapped,'symbols':symbols,'submissionSHA256':submission_sha,'submissionURL':f'https://data.sec.gov/submissions/CIK{cik:010}.json'}
    if symbol not in symbols:raise ValueError('当前SEC申报未确认证券代码；拒绝使用CIK导航提示。')
    identity['currentTickerConfirmedByOfficialSubmissions']=True
    data,digest=fetch(f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010}.json')
    if not isinstance(data,dict):raise ValueError('SEC公司事实结构错误。')
    return parse_companyfacts(data,cik,symbol,now(),digest,identity)

def enrich(stocks,symbols,budget_seconds=45):
    """Bounded rotating acquisition. Quotes remain usable if public filings fail."""
    started=time.monotonic();attempted=0
    with LOCK:
        pending=sorted(symbols,key=lambda s:CACHE.get(s,{}).get('time',0))
        for symbol in pending:
            entry=CACHE.get(symbol,{})
            ttl=CACHE_SECONDS if entry.get('value') else ERROR_CACHE_SECONDS
            if time.time()-entry.get('time',0)<ttl:continue
            if time.monotonic()-started>=budget_seconds:break
            try:CACHE[symbol]={'time':time.time(),'value':company(symbol),'error':None}
            except (OSError,ValueError,TypeError,KeyError) as exc:
                # Preserve the prior record/its real receipt timestamp; do not stamp old facts as fresh.
                CACHE[symbol]={'time':time.time(),'value':entry.get('value'),'error':str(exc)[:250] if isinstance(exc,ValueError) else 'SEC公开接口暂不可用；未补造财务数据。'}
            attempted+=1
        available=0
        for symbol in symbols:
            if symbol not in stocks:continue
            entry=CACHE.get(symbol,{})
            value=copy.deepcopy(entry.get('value'))
            if value:
                age=(now()-dt.datetime.fromisoformat(value['receivedAt'])).total_seconds()
                if not 0<=age<=7*86400:value=None
            stocks[symbol]['fundamentals']=value
            stocks[symbol]['fundamentalsStatus']={'status':'available_selected_annual_facts' if value else 'unavailable','error':entry.get('error'),'source':'SEC EDGAR','lastSuccessfulReceipt':value.get('receivedAt') if value else None,'notFullFilingOrCurrentMarketFlows':True}
            available+=bool(value)
        if attempted:save_cache()
    return {'requested':len(symbols),'availableSelectedAnnualFacts':available,'attemptedThisRefresh':attempted,'automaticRotatingBudgetSeconds':budget_seconds,'refreshTTLHours':12,'allOriginalReportsRead':False,'source':'SEC EDGAR public API','coverage':'USD standard taxonomy only; missing/custom/nonUSD/future/conflicting fields not filled.'}
