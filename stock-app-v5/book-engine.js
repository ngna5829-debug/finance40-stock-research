(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./book-checks.js'));else root.BookEngine=factory(root.BookChecks);})(typeof globalThis!=='undefined'?globalThis:this,function(Checks){
  'use strict';
  if(!Checks)throw Error('Book evidence checks are required');
  const GROUP_CHECKS={
    '交易结构与行为':[['tapeQuotes','逐笔成交与同步买卖报价'],['executionRecords','实际委托、成交与费用记录']],
    '企业经济与竞争':[['fundamentals','带公开时点的财务原件'],['sectorPeers','同产品与地理市场的竞争资料'],['managementEvidence','治理及经营调查']],
    '信用货币与流动性':[['fundingEvidence','融资期限、撤回条件及现金可用性'],['creditConditions','当前信贷、利率及支付制度证据']],
    '储蓄财政与制度':[['portfolioAndRiskBudget','个人目标、期限与全账户风险预算'],['legalAndTaxEvidence','当前适用合同、税及制度来源']]
  };
  const MODEL_BOUNDARY='确定性逐书资料检查；只绑定明确列出的原书机制，现代计算另列；语言模型调用为零。';
  const recordValid=Checks.recordValid;
  const uniq=a=>[...new Set(a)];
  const INPUT_LABELS={intraday_decision_horizon:'与原书相容的即时研究期限',timestamped_trades:'带时点的逐笔成交',synchronized_bid_ask:'同步买卖报价',source:'明确资料来源',execution_costs:'实际执行费用',bid_ask:'当前买卖价差',risk_budget:'个人可承受损失',execution_plan:'可执行的进出计划',dated_company_fundamentals:'完整带日期的企业财务调查（年度事实片段不足以代替）',dated_sector_peers:'带日期的行业竞争调查',dated_management_investigation:'带日期的经营与治理调查',dated_ownership_evidence:'带日期的持有人资料',short_interest:'可核空头持仓',trade_identity:'交易账户身份',personal_risk_budget:'个人可承受损失',executable_exit_plan:'可执行的退出计划',improved_dated_fundamentals:'新公布的企业变化证据',portfolio_cash_flows:'全账户现金收支',portfolio_exposure_map:'全账户共同风险',original_closing_bid_series:'原书要求的收盘买价序列',asof_important_swing_points:'当时已可识别的重要转折',original_quote_basis:'原书报价口径',dated_constituents:'带日期的指数成分',share_class:'证券股类',par_value_linking_policy:'面值与成分衔接规则',identified_account_or_regulatory_evidence:'已识别账户或监管证据',valid_trade_costs:'有效交易费用假设',price_history:'有效历史价格',qualitative_company_due_diligence:'企业定性调查'};
  function dataFor(snapshot,symbol){const meta=(snapshot.universe?.stocks||[]).find(x=>x?.symbol===symbol)||{};return Object.assign({},snapshot.stocks?.[symbol]||{},{symbol,sector:meta.sector||snapshot.stocks?.[symbol]?.sector||null,benchmarks:snapshot.benchmarks,marketState:snapshot.marketState});}
  function create(base,catalogue){
    const books=catalogue.books||[],groups=catalogue.groups||{},groupNames=Object.keys(groups);
    if(new Set(books.map(b=>b.id)).size!==books.length)throw Error('Duplicate book identities');
    for(const b of books)if(!['B37','B38','B40'].includes(b.id)){
      const p=Checks.PROFILES[b.id],ids=new Set((b.runtimeRules||[]).map(x=>x.id));
      if(!p||p.ruleIds.some(id=>!ids.has(id)))throw Error('Incomplete distinct book mapping '+b.id);
    }
    function limitations(items){return (items||[]).filter(x=>!x.includes('仅3本有深读档案')).concat('本版40本有完整深读档案，'+books.filter(b=>b.ready).length+'本经独审；逐书资料检查只绑定列出的机制，未把全部原著规则或40模型完整自动化。');}
    function annotate(r,input){
      r.executionAllowed=false;r.hardGatesCanBeOverridden=false;r.limitations=limitations(r.limitations);
      const annual=Checks.annualInfo(input,r.asOf),native=new Map((r.bookExperts||[]).map(e=>[e.id,e]));
      const agents=books.map(b=>{
        const originals=b.runtimeRules||[],originalRequirements=uniq(originals.flatMap(x=>Array.isArray(x.requiredInputs)?x.requiredInputs:typeof x.requiredInputs==='string'?[x.requiredInputs]:[]));
        const old=native.get(b.id),ready=!!b.ready;
        const inspection=ready&&!old?Checks.evaluate(b,input,r,annual):null;
        const missingCodes=inspection?.missingInputs||(ready&&old?uniq((old.rules||[]).flatMap(x=>x.missingInputs||[])):(GROUP_CHECKS[b.group]||[]).filter(([k])=>!recordValid(input[k],r.asOf)).map(([,label])=>label));
        const missing=uniq(missingCodes.map(x=>INPUT_LABELS[x]||x));
        const nativeBindings=ready&&old?(old.rules||[]).map(x=>x.id).filter(id=>originals.some(x=>x.id===id)):[];
        const currentChecks=inspection?.checks||(ready&&old?(old.rules||[]).map(x=>({id:x.id,type:'native/'+x.id,title:x.claim,status:x.status==='abstain'?'unknown':'partial',reason:x.reason,missingInputs:(x.missingInputs||[]).map(v=>INPUT_LABELS[v]||v),sourceRuleIds:[x.id],measurements:x.observed,origin:'qualified_native_framework_condition_check'})):[]);
        const applied=inspection?inspection.boundRuleIds.map(id=>{const source=originals.find(x=>x.id===id);return {id,claim:source.authorMeaning||source.archiveFinding||source.title,authorConditions:source.authorConditions,boundary:source.boundary,status:'partial_modern_evidence_binding',reason:'原意与限制保留；相关当前检查见下方。全部原规则未自动化。',missingInputs:missing};}):old?.rules||[];
        return {id:b.id,name:b.title,author:b.author,group:b.group,focus:inspection?.focus||old?.scope||null,
          knowledgeStatus:ready?'independently_qualified_with_source_limits':b.fullSourceRead?'whole_dossier_pending_independent_QA':'full_source_reading_incomplete',
          status:!ready?'knowledge_pending':inspection?.status||old?.status||'abstain',
          reason:!ready?'整本独立复核尚未关闭，本股检查停用。':inspection?.reason||old?.reason||'资料不足，保持弃权。',
          missingInputs:missing,missingInputCodes:missingCodes,originalRequirements,ruleCount:originals.length,rules:applied,
          currentChecks,boundRuleIds:inspection?.boundRuleIds||nativeBindings,unboundRuleIds:inspection?.unboundRuleIds||(ready&&old?originals.map(x=>x.id).filter(id=>!nativeBindings.includes(id)):[]),
          ruleEvaluationMode:!ready?'knowledge_pending':old?'native_framework_checks':'book_specific_evidence_inspection_partial_bindings',
          completeOriginalStrategyOperationalized:false,ruleIds:originals.map(x=>x.id),
          sourceAnchors:{definitionPath:b.definitionPath,definitionSha256:b.definitionSha256,lookup:'IDs resolve to full original evidence in the hashed book definition; modern data computations are separately labeled.'},
          definitionPath:b.definitionPath,dossierPath:b.dossierPath,definitionSha256:b.definitionSha256,
          method:MODEL_BOUNDARY,currentDirectionEnabled:false,directionalVote:null,
          contributesToTechnicalScore:false,authorIdentityRecreated:false,deterministicChecksExecuted:ready,modelCalls:0};
      });
      const chiefs=groupNames.map((group,i)=>{
        const members=agents.filter(a=>a.group===group),checks=members.flatMap(a=>a.currentChecks.map(c=>({...c,bookId:a.id}))),missing=uniq(members.flatMap(a=>a.missingInputs));
        const observations=[...new Map(checks.filter(c=>['partial','caution'].includes(c.status)).map(c=>[c.type, c])).values()];
        return {id:'chief-'+i,name:group+'主审',group,bookIds:members.map(a=>a.id),readyMembers:members.filter(a=>a.knowledgeStatus==='independently_qualified_with_source_limits').length,bookCount:members.length,
          missingInputs:missing,observations,sourceRuleIds:uniq(members.flatMap(a=>a.boundRuleIds)),cautions:checks.filter(c=>c.status==='caution'),directionalVote:null,
          targetGroup:groupNames[(i+1)%groupNames.length],
          initial:observations.length?observations.slice(0,3).map(c=>c.bookId+' '+c.reason).join(' '):'本组没有可由现有输入确认的完整投资结论；技术观察 '+r.stanceLabel+'。',
          challenge:'请'+groupNames[(i+1)%groupNames.length]+'主审核 '+(missing.slice(0,4).join('、')||'原条件实质与尚未绑定条款')+'；当前 '+r.horizonDays+'交易日任务能否与这些证据的对象和期限相容？',
          adjudication:(checks.some(c=>c.status==='caution')?'本组保留 '+uniq(checks.filter(c=>c.status==='caution').map(c=>c.title)).join('、')+'的待查条件。 ':'')+(missing.length?'尚缺 '+missing.length+'类资料，完整投资结论弃权。':'资料结构不证明实质核验和全部规则已实现，完整投资结论弃权。')};
      });
      for(const chief of chiefs){
        const target=chiefs.find(c=>c.group===chief.targetGroup);
        chief.response=target.name+'响应：本轮可检查 '+target.observations.length+'种观察、仍缺 '+target.missingInputs.length+'类资料。'+(target.observations[0]?.reason||'没有新的合格外部证据。')+' 原要求仍未补齐，不以书本意见一致补值。';
      }
      r.bookExperts=agents;r.chiefExperts=chiefs;
      r.bookDueDiligence={status:books.some(b=>!b.ready)?'knowledge_pending':'partial_evidence_checks_not_investment_approval',deterministicBookEvaluations:agents.filter(a=>a.deterministicChecksExecuted).length,uniqueModernCheckTypes:uniq(agents.flatMap(a=>a.currentChecks.map(c=>c.type))),cautions:chiefs.flatMap(c=>c.cautions.map(x=>({bookId:x.bookId,type:x.type,reason:x.reason,sourceRuleIds:x.sourceRuleIds}))),annualEvidenceValid:annual.valid,annualEvidenceIssues:annual.issues,allOriginalStrategiesOperationalized:false,investmentApproved:false};
      r.debate=[
        {round:1,title:'冻结输入并分别执行逐书检查',items:chiefs.map(c=>({name:c.name,position:c.initial,evidence:c.readyMembers+'/'+c.bookCount+'本已独审；本轮不同检查 '+c.observations.length+'类。',sources:c.bookIds,sourceRuleIds:c.sourceRuleIds}))},
        {round:2,title:'四组针对其他组交叉质疑',items:chiefs.map(c=>({name:c.name,target:c.targetGroup,challenge:c.challenge,evidence:'仅使用 '+r.asOf+' 前可取得资料；同一财报或日线不算多份独立证据。',sources:c.bookIds,sourceRuleIds:c.sourceRuleIds}))},
        {round:3,title:'被质疑组核查并回答',items:chiefs.map(c=>({name:c.name,target:c.targetGroup,response:c.response,adjudication:'本轮没有新来源填补缺项，响应为确定性条件复核。',sources:c.bookIds}))},
        {round:4,title:'反例、单位、期限及重复证据审计',items:[{name:'共同证据审计',challenge:'年度经营现金是否被误当机构净买入？原书利润是否被误当证券回报？历史比率是否被直接当当前门槛？',evidence:'当前年度身份检查 '+(annual.valid?'通过，期间 '+annual.period.start+'—'+annual.period.end:'未通过：'+annual.issues.join('；'))+'；日线最后完成时段 '+(r.validation.latestDate||'未知')+'。',response:'同币、同年度、同申报版本才计算会计比率；CMF仅为价量代理。源规则与现代检查逐项分开。',adjudication:'所有书本方向票保持null，绝不将40份相关文本计算成上涨概率。'}]},
        {round:5,title:'四位主审保留条件和异议',items:chiefs.map(c=>({name:c.name,adjudication:c.adjudication,sources:c.bookIds,sourceRuleIds:c.sourceRuleIds}))},
        {round:6,title:'REGIME与数据硬门最终裁决',items:[{name:'独立风险门',evidence:(r.gates||[]).map(g=>g.reason).join('；')||'已编码技术门未触发。',adjudication:r.stanceLabel+'。'+(r.eligible?'允许技术候选研究；逐书检查没有给予完整投资批准。':'本轮不入技术候选。'),response:'书本与模型意见不能移除硬门；不授权下单。'}]}
      ];
      r.agentLogs=agents.map(a=>({expertId:a.id,knowledgeStatus:a.knowledgeStatus,method:a.method,status:a.status,missingInputs:a.missingInputs,ruleCount:a.ruleCount,boundRuleIds:a.boundRuleIds,currentChecks:a.currentChecks,completeOriginalStrategyOperationalized:false,definitionSha256:a.definitionSha256,directionalVote:null,modelCalls:0,deterministicChecksExecuted:a.deterministicChecksExecuted}));
      r.knowledgeSummary=catalogue.summary;r.modelRuntime={mode:'distinct_book_evidence_inspections',modelCalls:0,trainedModels:0,deterministicBookEvaluations:r.bookDueDiligence.deterministicBookEvaluations,localLLMOptional:true};
      return r;
    }
    function analyze(input,options={}){return annotate(base.analyze(input,Object.assign({},options,{includePendingExperts:false})),input);}
    function rankUniverse(snapshot,options={}){
      const batch=base.rankUniverse(snapshot,Object.assign({},options,{includePendingExperts:false}));
      batch.results=batch.results.map(r=>annotate(r,dataFor(snapshot,r.symbol)));
      const map=new Map(batch.results.map(r=>[r.symbol,r]));batch.ranked=batch.ranked.map(r=>map.get(r.symbol));batch.diversifiedShortlist=batch.diversifiedShortlist.map(r=>map.get(r.symbol));
      batch.summary.groundedBooks=books.filter(b=>b.ready).length;batch.summary.fullSourceReadBooks=books.filter(b=>b.fullSourceRead).length;batch.summary.pendingBooks=books.filter(b=>!b.ready).length;batch.summary.chiefGroups=groupNames.length;batch.summary.actualModelCalls=0;batch.limitations=limitations(batch.limitations);
      return batch;
    }
    function walkForward(...args){const r=base.walkForward(...args);r.limitations=limitations(r.limitations);return r;}
    return Object.assign({},base,{version:'5.1',analyze,rankUniverse,walkForward,catalogueSummary:catalogue.summary,bookRuleEvidenceScope:'40份逐书档案；只有列出的机制进行了现代证据检查，完整原策略和实际语言模型调用另记。'});
  }
  return {create,recordValid,GROUP_CHECKS};
});
