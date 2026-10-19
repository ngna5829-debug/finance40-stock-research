"""Optional local document agents. No paid endpoint, orders, or automatic model download."""
import concurrent.futures,copy,datetime,hashlib,json,math,pathlib,re,secrets,threading,time,urllib.request

BASE='http://127.0.0.1:11434'
LOCK=threading.RLock()
JOBS={}
ROOT=pathlib.Path(__file__).resolve().parent

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
def request(path,body=None,timeout=8):
    # Fixed loopback destination: never fetch a user-supplied URL or cloud model.
    data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None
    req=urllib.request.Request(BASE+path,data=data,headers={'Content-Type':'application/json'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):raise ValueError('本机模型接口不接受重定向。')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    with opener.open(req,timeout=timeout) as r:return json.loads(r.read(4_000_000))
def remote_model(value):
    return bool(value.get('remote_host') or value.get('remote_model') or ':cloud' in str(value.get('name',value.get('model',''))).lower())
def models():
    try:
        data=request('/api/tags');return {'available':True,'endpoint':BASE,'models':[{'name':m.get('name'),'digest':m.get('digest'),'size':m.get('size')} for m in data.get('models',[]) if not remote_model(m)],'remoteModelTagsExcluded':sum(remote_model(m) for m in data.get('models',[])),'automaticModelDownload':False}
    except Exception:return {'available':False,'endpoint':BASE,'models':[],'reason':'本机Ollama未运行或无法读取已安装模型；未调用外部付费接口。'}
def catalogue():
    p=ROOT/'library/catalogue.json'
    if not p.exists():raise ValueError('完整知识目录尚未交付。')
    return json.loads(p.read_text())
def knowledge_packet(book):
    # Every authored rule meaning/condition is included; the original full book and
    # chapter dossiers stay in the archive, not in each model inference window.
    rules=book.get('runtimeRules',[])
    selected=rules
    intro={'bookId':book['id'],'title':book['title'],'author':book['author'],'group':book['group'],
        'knowledgeStatus':'complete_dossier_independently_reviewed','allRules':len(rules),'selectedRuleIds':[r['id'] for r in selected],
        # Original semantic fields already contain every clause. Do not duplicate
        # their normalized display aliases in the inference context.
        'rules':[{k:r[k] for k in ['id','title','originKind','notAuthorOriginalRule','archiveFinding','originalSemanticFields','sourceVoices']} for r in selected],
        'expertPrompt':book.get('systemPrompt',''),'bookInvocationContract':book.get('bookInvocationContract'),
        'allChapterTitles':[c.get('title',c.get('file')) for c in book.get('chapterRecords',[])],
        'definitionSha256':book.get('definitionSha256'),
        'contextSelection':'All original non-evidence rule fields are included without abridgment, preserving counterexamples, execution limits and separately labelled modern analysis. Quote voices from exact contexts are retained. Raw evidence is located through rule IDs and hashed definitions in the full archive; entire books/chapter dossiers are not sent in each inference.'}
    return intro
def validate_answer(value,allowed):
    if not isinstance(value,dict):raise ValueError('模型未返回JSON对象。')
    stance=value.get('stance')
    if stance not in ['abstain','conditional_research','challenge']:raise ValueError('模型尝试给出未允许的交易结论。')
    claims=value.get('claims',[])
    if not isinstance(claims,list) or len(claims)>3:raise ValueError('模型claim结构不合格。')
    for c in claims:
        if not isinstance(c,dict) or c.get('rule_id') not in allowed:raise ValueError('模型引用了本上下文没有提供的原书规则。')
        if set(c)!={'rule_id','text'}:raise ValueError('模型claim只接受rule_id与text，不能夹带额外预测或未限定字段。')
        if not isinstance(c.get('text'),str) or len(c['text'])>150:raise ValueError('模型claim缺文字或超出已声明长度。')
    for k in ['probability','targetPrice']:
        if value.get(k) is not None:raise ValueError('模型尝试添加未经验证的预测数值。')
    for k in ['executionAllowed','overrideHardGates']:
        if value.get(k) is not None and value.get(k) is not False:raise ValueError('模型尝试覆盖风险门。')
    for k in ['missing','challenges','revisions']:
        items=value.get(k,[])
        if not isinstance(items,list) or len(items)>3 or any(not isinstance(s,str) or len(s)>150 for s in items):raise ValueError('模型质疑或缺项记录不符合长度和文字结构。')
    return {'stance':stance,'claims':claims,'missing':value.get('missing',[]),'challenges':value.get('challenges',[]),'revisions':value.get('revisions',[]),'probability':None,'executionAllowed':False}
def call(job,identity,phase,packet,facts,challenge=None):
    if job['cancel'].is_set():raise InterruptedError('用户取消')
    system='你是有出处的书本研究代理，不模拟作者本人。仅依据提供的原书规则和冻结的市场资料。缺项必须弃权，不补数据、买卖点、概率、目标价，不覆盖REGIME风险门。原文规则是知识而非经验证现代因果规律。JSON返回 stance(abstain/conditional_research/challenge),claims[{rule_id,text}],missing[],challenges[],revisions[]；每项claim只能引用本次提供的rule_id。最多3项claim，每项150字以内，其他各最多3项150字。区分作者论述与现代分析。模型输出仍待核验。'
    payload={'identity':identity,'phase':phase,'bookKnowledge':packet,'frozenEvidence':facts,'crossChallenge':challenge}
    started=time.monotonic();body={'model':job['model'],'stream':False,'format':'json','truncate':False,'shift':False,'messages':[{'role':'system','content':system},{'role':'user','content':json.dumps(payload,ensure_ascii=False)}],'options':{'temperature':0,'num_predict':1000,'num_ctx':job['contextTokens']}}
    allowed={r['id'] for r in packet.get('rules',[])}
    entry={'identity':identity,'phase':phase,'model':job['model'],'startedAt':now(),'requestSha256':digest(body),'sourceRuleIds':sorted(allowed),'frozenSnapshotSha256':job['snapshotSha256'],'status':'running'}
    with LOCK:job['calls'].append(entry);job['attemptedModelCalls']+=1
    try:
        # One token per UTF8 byte is a conservative ceiling, plus output allowance.
        # Refuse oversized contexts rather than let the model silently drop book rules.
        context_byte_ceiling=sum(len(m['content'].encode()) for m in body['messages'])+1000
        entry['conservativeContextTokenCeiling']=context_byte_ceiling
        if context_byte_ceiling>job['contextTokens']:raise ValueError('完整规则及质疑上下文超过该本机模型上下文上限，未调用或截断知识。')
        with LOCK:job['actualHTTPModelCalls']+=1
        result=request('/api/chat',body,timeout=600)
        if remote_model(result):
            job['cancel'].set();job['paidCloudCalls']=None
            raise ValueError('返回包含远程模型标记，当前会话停止后续调用，远程计费状态未知。')
        value=json.loads(result.get('message',{}).get('content',''))
        answer=validate_answer(value,allowed)
        entry.update(status='completed',answer=answer,promptTokens=result.get('prompt_eval_count'),outputTokens=result.get('eval_count'),elapsedSeconds=round(time.monotonic()-started,3),completedAt=now())
        with LOCK:job['completedModelCalls']+=1
        return answer
    except Exception as e:
        entry.update(status='failed_or_output_rejected',reason=str(e)[:300],elapsedSeconds=round(time.monotonic()-started,3),completedAt=now())
        return {'stance':'abstain','claims':[],'missing':['本项模型调用失败或输出核验未通过'],'challenges':[],'revisions':[],'probability':None,'executionAllowed':False}
def timed_evidence(value,cutoff):
    if value is None:return None
    if not isinstance(value,dict) or not value.get('source'):return None
    try:
        limit=datetime.datetime.fromisoformat(cutoff.replace('Z','+00:00'))
        observed=datetime.datetime.fromisoformat(value['asOf'].replace('Z','+00:00'))
        available=datetime.datetime.fromisoformat(value['availableAt'].replace('Z','+00:00'))
        if any(x.tzinfo is None for x in (limit,observed,available)):return None
        if observed>limit or available>limit or available<observed:return None
        if value.get('receivedAt'):
            receipt=datetime.datetime.fromisoformat(value['receivedAt'].replace('Z','+00:00'))
            if receipt.tzinfo is None or receipt>limit:return None
    except (ValueError,TypeError,KeyError,AttributeError):return None
    return value

def frozen_facts(snapshot,symbol):
    stock=copy.deepcopy(snapshot['stocks'][symbol]);bars=stock.get('bars',[])
    metrics={'barCount':len(bars),'lastCompleteDate':bars[-1].get('date') if bars else None}
    for w in [20,50,200]:
        values=[b.get('close') for b in bars[-w:]]
        metrics['sma'+str(w)]=sum(values)/w if len(values)==w and all(isinstance(v,(float,int)) and math.isfinite(v) for v in values) else None
    evidence_keys=['fundamentals','news','realFlows','tapeQuotes','executionRecords','sectorPeers','managementEvidence','fundingEvidence','creditConditions','portfolioAndRiskBudget','legalAndTaxEvidence']
    evidence={key:timed_evidence(stock.get(key),snapshot.get('capturedAt')) for key in evidence_keys}
    rejected=[key for key in evidence_keys if stock.get(key) is not None and evidence[key] is None]
    return {'symbol':symbol,'snapshotCapturedAt':snapshot.get('capturedAt'),'quote':stock.get('quote'),
        'historySource':stock.get('source'),'priceBasis':stock.get('priceBasis'),'priceAdjustmentVerified':stock.get('priceAdjustmentVerified'),
        'last10CompleteBars':bars[-10:],'barSummary':metrics,'marketState':snapshot.get('marketState'),
        'fundamentals':evidence['fundamentals'],'news':evidence['news'],'realInstitutionalFlows':evidence['realFlows'],
        'tapeQuotes':evidence['tapeQuotes'],'executionRecords':evidence['executionRecords'],
        'sectorPeers':evidence['sectorPeers'],'managementEvidence':evidence['managementEvidence'],
        'fundingEvidence':evidence['fundingEvidence'],'creditConditions':evidence['creditConditions'],
        'portfolioAndRiskBudget':evidence['portfolioAndRiskBudget'],'legalAndTaxEvidence':evidence['legalAndTaxEvidence'],
        'rejectedUntimedOrFutureEvidence':rejected,
        'scope':'Model input includes10recentbars and simple means, not an entire historical backtest. Missing objects remain null.','probability':None,'executionAllowed':False}
def run(job,cat,snapshot):
    try:
        books=cat['books'];packets={b['id']:knowledge_packet(b) for b in books};facts=frozen_facts(snapshot,job['symbol'])
        job['frozenFacts']=facts;initial={};responses={};counter={};final={}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            fs={pool.submit(call,job,b['id'],'1_initial',packets[b['id']],facts):b['id'] for b in books}
            for f in concurrent.futures.as_completed(fs):initial[fs[f]]=f.result()
        if job['cancel'].is_set():raise InterruptedError('用户取消')
        job['stage']='2_four_chief_cross_challenge'
        for group,ids in cat['groups'].items():
            cited={c['rule_id'] for id in ids for c in initial[id].get('claims',[])}
            packet={'group':group,'allBookIds':ids,'rules':[r for id in ids for r in packets[id]['rules'] if r['id'] in cited],'sourceContextSelection':'Only rules cited by the group member initial claims; uncited rules remain in member contexts and full archive.'}
            counter[group]=call(job,'chief:'+group,'2_cross_challenge',packet,facts,{'allGroupsInitial':initial})
        job['stage']='3_forty_replies'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            fs={pool.submit(call,job,b['id'],'3_revise_or_abstain',packets[b['id']],facts,{'initial':initial[b['id']],'chiefChallenges':counter}):b['id'] for b in books}
            for f in concurrent.futures.as_completed(fs):responses[fs[f]]=f.result()
        if job['cancel'].is_set():raise InterruptedError('用户取消')
        job['stage']='4_four_chief_adjudications'
        for group,ids in cat['groups'].items():
            cited={c['rule_id'] for id in ids for c in responses[id].get('claims',[])}
            packet={'group':group,'allBookIds':ids,'rules':[r for id in ids for r in packets[id]['rules'] if r['id'] in cited],'sourceContextSelection':'Rules cited by member revised claims; other knowledge retained in member contexts.'}
            final[group]=call(job,'chief:'+group,'4_adjudicate',packet,facts,{'counter':counter,'allBookRevisions':responses})
        job.update(state='completed' if job['completedModelCalls']==job['expectedCalls'] else 'completed_with_errors_or_abstentions',stage='completed',initial=initial,crossChallenges=counter,replies=responses,chiefAdjudications=final,
            finalDecision={'executionAllowed':False,'probability':None,'hardGatesCanBeOverridden':False,'note':'模型质疑日志供研究，不改写技术引擎、行情输入或风险门；未独立验证所有自然语言论断。'},completedAt=now())
    except InterruptedError:job.update(state='cancelled',completedAt=now())
    except Exception as e:job.update(state='failed',reason=str(e)[:300],completedAt=now())
def start(snapshot,symbol,model):
    cat=catalogue()
    if len(cat.get('books',[]))!=40 or not all(b.get('ready') for b in cat['books']):raise ValueError('40本完整档案尚未全部通过独审，实际40书模型会话暂不启用。')
    ids=[b['id'] for b in cat['books']];group_ids=[id for group in cat.get('groups',{}).values() for id in group]
    if len(set(ids))!=40 or len(cat.get('groups',{}))!=4 or sorted(group_ids)!=sorted(ids):raise ValueError('必须为40本不同作品及四个互不重叠的主审组。')
    if symbol not in snapshot.get('stocks',{}):raise ValueError('冻结行情没有该股。')
    available=models()
    if model not in [m['name'] for m in available.get('models',[])]:raise ValueError('请先选择本机已安装且可读取的模型；不自动下载。')
    info=request('/api/show',{'model':model})
    if remote_model(info):raise ValueError('该模型指向远程服务；这里只启用本机已有模型。')
    lengths=[v for k,v in info.get('model_info',{}).items() if k.endswith('.context_length') and isinstance(v,int)]
    if not lengths:raise ValueError('不能确认该模型的上下文长度；不冒称所有原规则会进入模型。')
    context_tokens=min(max(lengths),131072)
    with LOCK:
        if any(j['state']=='running' for j in JOBS.values()):raise ValueError('已有一项40书会话运行，避免重复占用本机模型。')
        id=secrets.token_hex(8);job={'jobId':id,'symbol':symbol,'model':model,'modelDigest':next(m['digest'] for m in available['models'] if m['name']==model),
            'state':'running','stage':'1_forty_initials','createdAt':now(),'snapshotSha256':digest(snapshot),
            'knowledgeDefinitionHashes':{b['id']:b['definitionSha256'] for b in cat['books']},'expectedCalls':88,
            'attemptedModelCalls':0,'actualHTTPModelCalls':0,'completedModelCalls':0,'calls':[],'cancel':threading.Event(),'paidCloudCalls':0,'trainedModels':0,'sourceContextMode':'all_authored_rule_meanings_conditions_boundaries;exact_evidence_via_full_hashed_archive','contextTokens':context_tokens,'executionAllowed':False}
        JOBS[id]=job
    threading.Thread(target=run,args=(job,cat,copy.deepcopy(snapshot)),daemon=True).start();return status(id)
def status(id):
    with LOCK:
        if id not in JOBS:raise ValueError('会话不存在。')
        return copy.deepcopy({k:v for k,v in JOBS[id].items() if k!='cancel'})
def cancel(id):
    with LOCK:
        if id not in JOBS:raise ValueError('会话不存在。')
        JOBS[id]['cancel'].set()
    return {'jobId':id,'cancelRequested':True,'note':'当前一次模型HTTP调用可能需等返回；不再开始后续调用。'}
