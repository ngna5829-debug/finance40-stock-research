(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.BookChecks=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DAY=86400000,finite=Number.isFinite;
  // Editorial mappings to selected book mechanisms. These are modern evidence
  // inspections, not complete translations of all original strategies or votes.
  const rows=[
    ['P04','最终支付资源与共同变现','R03 R04 R20','balanceLiquidity fundingMaturity'],
    ['P05','资本用途、等待与再投资','R08 R03','reinvestment resourceNetwork'],
    ['P06','名义资本与真实生产能力','R01 R19','corporateActions resourceNetwork'],
    ['P07','挂牌报价、可成交性与费用','R04 R05 R29','priceLiquidity tradeCosts'],
    ['P08','预期盈利资本化与旧资本负担','R12 R19','earningsExpectations reinvestment'],
    ['P09','企业经营利润、成本与税负','R06 R15','profitability policyExposure'],
    ['P10','资本吸损与可取得资金','R14 R19','capitalBuffer fundingMaturity'],
    ['P11','购买力基准与外币支付错配','R19 R40','macroPrices currencyExposure'],
    ['P12','净支付资源及生产交换网络','R23 R27','cashGeneration resourceNetwork'],
    ['P13','账面货币与实际用途','R02 R34','balanceLiquidity macroPrices'],
    ['P14','机会成本与政策因果','R44 R45 R09','policyExposure causalEvidence'],
    ['P15','竞争市场与生产经济','R12 R10 R16','competition operatingEfficiency'],
    ['P16','现金任务与国际资金条件','R07 R06','fundingMaturity currencyExposure'],
    ['P17','流动性层次与期限转换','R04 R18','balanceLiquidity fundingMaturity'],
    ['P18','价格关系与信用保障','R01 R29','valuation currencyExposure'],
    ['P19','信用质量与扩张条件','R03 R27','creditConditions fundingMaturity'],
    ['P20','储备、互助与制度条件','R27 R36','balanceLiquidity legalMarketAccess'],
    ['P21','净产出、资本贡献与竞争条件','R41 R12','operatingEfficiency competition'],
    ['P22','运输网络及真实工程成本','R01 R02 R18','resourceNetwork operatingEfficiency'],
    ['P23','有效竞争范围与历史反事实','R52 R13','competition causalEvidence'],
    ['P24','价值比较对象与计量口径','R04 R06','macroPrices priceBasis'],
    ['P25','可保留所得及个人条件','R03 R07 R10','riskBudget personalCash'],
    ['P26','资本信用与账面流动性','R01 R48','capitalBuffer balanceLiquidity'],
    ['P27','收益基数与真实竞争','R70 R36','capitalBuffer competition'],
    ['P28','资金用途与共同风险','R01 R03','riskBudget portfolioExposure'],
    ['P29','收入权与支付服务成本','R11 R06','dividendRights tradeCosts'],
    ['P30','有限资本与共同卖盘','R01 R21','riskBudget portfolioExposure'],
    ['P31','购买力尺度与政策反馈','R20 R34','macroPrices causalEvidence'],
    ['P32','成交真实性与毛净收益口径','R50 R23','priceLiquidity operatingEfficiency'],
    ['P33','证券交割、币种与垫款链','R06 R38','currencyExposure identifiedFlows'],
    ['P34','收入持有与股息事件','R02 R23','dividendRights earningsExpectations'],
    ['P35','可召资金与停市制度风险','R06 R40','fundingMaturity legalMarketAccess'],
    ['P36','信用周期与事前可知性','R09 R08','cycleEvidence creditConditions'],
    ['P37','现资本机会与消息解释','R34 R27','dividendRights valuation'],
    ['P38','现金、利润及资金需求','R01 R13 R15 R17','cashProfit reinvestment workingCapital'],
    ['P39','当前现金与潜在资本保障','R18 R20 R27','balanceLiquidity fundingMaturity'],
    ['P40','结果预期与出售证据','R05 R12','earningsExpectations identifiedFlows']
  ];
  const PROFILES=Object.fromEntries(rows.map(([id,focus,refs,checks])=>[id,{id,focus,ruleIds:refs.split(' ').map(r=>id+'-'+r),checks:checks.split(' ')}]));
  function stamp(s){
    if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(s))return NaN;
    const day=Date.parse(s.slice(0,10)+'T00:00:00Z');
    if(!finite(day)||new Date(day).toISOString().slice(0,10)!==s.slice(0,10))return NaN;
    return Date.parse(s);
  }
  function recordValid(v,cutoff){
    if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.source!=='string'||!v.source.trim())return false;
    const now=stamp(cutoff),a=stamp(v.availableAt),t=stamp(v.asOf);
    if(![now,a,t].every(finite)||t>a||a>now)return false;
    if(v.receivedAt!==undefined){const receipt=stamp(v.receivedAt);if(!finite(receipt)||receipt>now||receipt<a)return false;}
    return true;
  }
  function dayStamp(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)?stamp(s+'T00:00:00Z'):NaN;}
  function annualInfo(input,cutoff){
    const f=input.fundamentals,p=f?.reportPeriod||{},issues=[];
    if(!recordValid(f,cutoff))issues.push('财务来源或公开/接收时点无效');
    if(f?.symbol!==input.symbol||f?.identity?.currentTickerConfirmedByOfficialSubmissions!==true||!f?.identity?.symbols?.includes(input.symbol)||!Number.isInteger(f?.issuerCIK)||f.issuerCIK<=0||f?.identity?.cik!==f?.issuerCIK)issues.push('发行人和当前证券身份未验证');
    const start=dayStamp(p.start),end=dayStamp(p.end),filed=dayStamp(p.filed),now=stamp(cutoff),available=stamp(f?.availableAt);
    if(![start,end,filed,now,available].every(finite)||end<start||filed<end||filed>available||end!==stamp(f?.asOf)||(end-start)/DAY<300||(end-start)/DAY>400)issues.push('年度区间、申报时点或报告身份不一致');
    if(f?.currency!=='USD'||!['10-K','10-K/A','20-F','20-F/A','40-F','40-F/A'].includes(p.form)||typeof p.accn!=='string'||!p.accn)issues.push('年度申报或美元口径不完整');
    const age=finite(now)&&finite(end)?(now-end)/DAY:null;
    if(age!==null&&age>550)issues.push('报告期末超过550日；工程新鲜度限制');
    const facts={},rejected={};
    if(!issues.length)for(const [k,x]of Object.entries(f.facts||{})){
      const duration=['revenue','netIncome','operatingCashFlow','capitalExpenditure'].includes(k);
      if(!x||!finite(x.value)||x.unit!=='USD'||x.accn!==p.accn||x.end!==p.end||x.filed!==p.filed||x.form!==p.form||!['us-gaap','ifrs-full'].includes(x.taxonomy)||typeof x.tag!=='string'||!x.tag||(duration&&(x.start!==p.start||x.periodKind!=='duration'))||(!duration&&x.periodKind!=='instant')||(['assets','liabilities','assetsCurrent','liabilitiesCurrent','cashAndEquivalents'].includes(k)&&x.value<0))rejected[k]='单位、期间、版本、符号或标准标签不一致';
      else facts[k]=x.value;
    }
    return {valid:!issues.length,issues,facts,rejected,period:p,source:f?.source||null,sourceURL:f?.sourceURL||null,filingURL:f?.filingURL||null,availableAt:f?.availableAt||null,receivedAt:f?.receivedAt||null,ageDays:age};
  }
  const millions=n=>finite(n)?(n/1e6).toLocaleString('en-US',{maximumFractionDigits:1})+'百万美元':'未知';
  const ratio=n=>finite(n)?n.toFixed(3):'未知';
  function row(type,title,status,reason,missing=[],measurements={}){return {type,title,status,reason,missingInputs:missing,measurements};}
  const REQUESTS={
    resourceNetwork:['supplyChainEvidence','供应、运输及对手市场资料',['links','capacityAndDemand']],
    policyExposure:['policyExposure','实际税制、关税及企业成本暴露',['applicableRules','companyExposure']],
    competition:['sectorPeers','同产品与地域的竞争市场',['peers','productMarket','geographicMarket']],
    fundingMaturity:['fundingEvidence','债务到期、担保及融资撤回条件',['obligations','availableFacilities']],
    currencyExposure:['currencyExposure','收入、负债、到期币种及对冲',['receipts','obligations','hedges']],
    creditConditions:['creditConditions','当前信贷价格、期限及可取得性',['ratesWithUnits','lendingConditions']],
    macroPrices:['purchasingPowerEvidence','物价篮子、币种与共同基期',['indexDefinition','currency','basePeriod','observations']],
    legalMarketAccess:['legalAndTaxEvidence','现行交易、停牌及合同条款',['jurisdiction','applicableRules']],
    causalEvidence:['causalEvidence','可比较时序及替代解释',['observations','comparison','alternativeCauses']],
    earningsExpectations:['eventEvidence','同期间实际结果与事前预期',['events','priorExpectations']],
    cycleEvidence:['cycleEvidence','事前冻结的周期定义与独立样本',['predeclaredDefinition','datedSample','outOfSampleResults']],
    valuation:['valuationEvidence','未来现金、证券权利与估值假设',['cashFlowScenarios','shareClasses','discountAssumptions']],
    portfolioExposure:['portfolioAndRiskBudget','全账户持仓与共同风险',['holdings','riskBudget']],
    riskBudget:['portfolioAndRiskBudget','个人用途、期限与可承受损失',['objectives','horizon','riskBudget','liquidCash']],
    personalCash:['personalCashEvidence','家庭持续收入、必要支出及应急资金',['income','expenses','emergencyNeeds']],
    dividendRights:['corporateActionEvidence','股息宣布、除息登记及支付权利',['announcements','exDates','recordDates','paymentDates']],
    corporateActions:['corporateActionEvidence','拆股、红股及证券权利变化',['actions','shareClasses','entitlements']],
    identifiedFlows:['identifiedFlowEvidence','有账户身份和交割依据的资金活动',['identifiedAccounts','settledTransactions']]
  };
  function requested(type,input,cutoff){
    const [key,label,fields]=REQUESTS[type],v=input[key];
    const present=recordValid(v,cutoff)&&fields.every(k=>v[k]!==undefined&&v[k]!==null&&(typeof v[k]!=='string'||v[k].trim())&&(!Array.isArray(v[k])||v[k].length));
    return present?row(type,label,'input_present','资料容器的来源、时点与必填键初查通过；子记录时点、来源实质、定性解释及全部原条件仍未核验。',[],{source:v.source,asOf:v.asOf,availableAt:v.availableAt,substantiveVerificationCompleted:false}):row(type,label,'unknown','未取得同一对象、截止前公开且结构完整的'+label+'；价格或年度财务不能替补。',[label]);
  }
  function inspect(type,input,result,annual){
    if(REQUESTS[type])return requested(type,input,result.asOf);
    const m=result.indicators;
    if(type==='priceBasis')return row(type,'历史价格计量口径',input.priceAdjustmentVerified===true?'partial':'unknown',input.priceAdjustmentVerified===true?'供应商复权历史可作有限价量比较；本轮没有逐项重建股类权利、现金股息及所有公司行为。':'历史价格公司行为口径未验证；名义报价变化不能直接当总收益。',input.priceAdjustmentVerified===true?['独立公司行为与证券权利桥接']:['已核公司行为口径'],{priceBasis:input.priceBasis||null,volumeBasis:input.volumeBasis||null,volumeAdjustmentVerified:input.volumeAdjustmentVerified===true});
    if(type==='priceLiquidity')return m?row(type,'报价与成交可用性','partial','最后完成日线价 '+m.price+'；20日收盘价乘量的平均值约 '+millions(m.avgDollarVolume20)+'。这是近似换手观察；没有同步买卖报价和实际订单，不能认证本次可执行价或机构净流。',['同步买卖报价与本次执行记录'],{price:m.price,completedSession:result.validation.latestDate,averageCloseTimesVolume20:m.avgDollarVolume20,cmf20:m.cmf20,realInstitutionalFlow:false}):row(type,'报价与成交可用性','unknown','完整日线未通过硬门。',['有效完成日线']);
    if(type==='tradeCosts')return row(type,'费用后的结果条件','partial',result.costs?.valid?'假设单边成本 '+result.costs.oneWayBps+'bp、往返 '+result.costs.roundTripPct+'%；没有实际价差、成交或融资成本，不能据毛波动认定实收利润。':'交易成本假设无效。',['实际成交、价差及全部费用记录'],{assumedCosts:result.costs||null,realizedProfitKnown:false});
    const labels={balanceLiquidity:'现金与账面资产分开',capitalBuffer:'报告权益与损失缓冲',profitability:'经营利润口径',operatingEfficiency:'总收益与新增效率分开',cashGeneration:'经营现金与净支付资源',cashProfit:'利润与经营现金对照',reinvestment:'再投资后的简化现金差',workingCapital:'流动资产与短期负债'};
    const needs={balanceLiquidity:['cashAndEquivalents','assets','liabilities'],capitalBuffer:['equity','assets','liabilities'],profitability:['revenue','netIncome'],operatingEfficiency:['revenue','netIncome'],cashGeneration:['operatingCashFlow'],cashProfit:['netIncome','operatingCashFlow'],reinvestment:['operatingCashFlow','capitalExpenditure'],workingCapital:['assetsCurrent','liabilitiesCurrent']};
    if(!needs[type])throw Error('Unknown book check '+type);
    const missing=needs[type].filter(k=>!finite(annual.facts[k]));
    if(!annual.valid||missing.length)return row(type,labels[type],'unknown',annual.valid?'同一年度版本缺少 '+missing.join('、')+'；未补零或混用别期。':annual.issues.join('；'),['同版本年度 '+needs[type].join('/')],{rejectedFacts:annual.rejected});
    const f=annual.facts,values={},note='年度 '+annual.period.start+' 至 '+annual.period.end+'，申报 '+annual.period.filed+'；不是今日现金或股价预测。';let reason='',status='partial';
    if(type==='balanceLiquidity'){Object.assign(values,{cash:f.cashAndEquivalents,assets:f.assets,liabilities:f.liabilities});reason='期末现金等价物 '+millions(f.cashAndEquivalents)+'，资产 '+millions(f.assets)+'，负债 '+millions(f.liabilities)+'。资产和潜在融资不等于可立即支付现金；全部负债也不等于有息债务。';}
    if(type==='capitalBuffer'){Object.assign(values,{reportedEquity:f.equity,assets:f.assets,liabilities:f.liabilities,equityToAssets:f.assets>0?f.equity/f.assets:null});reason='报告股东权益 '+millions(f.equity)+'，权益/资产 '+ratio(values.equityToAssets)+'；账面权益不是现金或监管资本，少数权益和资产可收回性还未桥接。';if(f.equity<0)status='caution';}
    if(['profitability','operatingEfficiency'].includes(type)){Object.assign(values,{revenue:f.revenue,netIncome:f.netIncome,annualNetMargin:f.revenue>0?f.netIncome/f.revenue:null});reason='年度收入 '+millions(f.revenue)+'、净利润 '+millions(f.netIncome)+'，净利润/收入 '+ratio(values.annualNetMargin)+'。这不是资本通常利润率、证券回报或新增净/毛收益比；分部成本、实物产出及竞争变化未核。';if(f.netIncome<0)status='caution';}
    if(type==='cashGeneration'){values.operatingCashFlow=f.operatingCashFlow;reason='年度经营现金流 '+millions(f.operatingCashFlow)+'。尚未扣全部投资、融资与到期义务；不能把毛收入、簿记额度或资产售价当可支付净资源。';if(f.operatingCashFlow<0)status='caution';}
    if(type==='cashProfit'){Object.assign(values,{netIncome:f.netIncome,operatingCashFlow:f.operatingCashFlow,operatingCashToPositiveNetIncome:f.netIncome>0?f.operatingCashFlow/f.netIncome:null});reason='净利润 '+millions(f.netIncome)+'，经营现金 '+millions(f.operatingCashFlow)+'；经营现金/正净利润 '+ratio(values.operatingCashToPositiveNetIncome)+'。差异可能来自营运资本、非现金项目或时点，不能直接判造假。';if(f.operatingCashFlow<0||f.netIncome<0)status='caution';}
    if(type==='reinvestment'){if(f.capitalExpenditure<0)return row(type,labels[type],'unknown','资本支出方向非预期的现金购置流出；停止简化相减。',['已核购置支出符号']);Object.assign(values,{operatingCashFlow:f.operatingCashFlow,cashPurchasePPandE:f.capitalExpenditure,simpleCashDifference:f.operatingCashFlow-f.capitalExpenditure});reason='经营现金减现金购置厂房设备 = '+millions(values.simpleCashDifference)+'；不是完整FCFF/FCFE，也未覆盖所有无形投资、收购、融资与股东分配。';if(values.simpleCashDifference<0)status='caution';}
    if(type==='workingCapital'){Object.assign(values,{currentAssets:f.assetsCurrent,currentLiabilities:f.liabilitiesCurrent,workingCapital:f.assetsCurrent-f.liabilitiesCurrent,currentRatio:f.liabilitiesCurrent>0?f.assetsCurrent/f.liabilitiesCurrent:null});reason='流动资产减流动负债 '+millions(values.workingCapital)+'，流动比率 '+ratio(values.currentRatio)+'。负差是待查账面条件，不证明必违约；行业、收款速度、到期和授信未核。';if(values.workingCapital<0)status='caution';}
    return row(type,labels[type],status,reason+note,[],{...values,reportPeriod:annual.period,source:annual.source,sourceURL:annual.sourceURL,filingURL:annual.filingURL,availableAt:annual.availableAt,receivedAt:annual.receivedAt});
  }
  function evaluate(book,input,result,annual){
    const p=PROFILES[book.id];if(!p)throw Error('No distinct profile '+book.id);
    const originals=new Map((book.runtimeRules||[]).map(r=>[r.id,r]));
    for(const id of p.ruleIds)if(!originals.has(id))throw Error('Missing original rule '+id);
    const financeAnchors={cashProfit:['P38-R13'],reinvestment:['P38-R15'],workingCapital:['P38-R01','P38-R17']};
    const checks=p.checks.map((t,i)=>({...inspect(t,input,result,annual),id:book.id+'-CHECK-'+(i+1),sourceRuleIds:book.id==='P38'?financeAnchors[t]:p.ruleIds.slice(),origin:'modern_evidence_inspection_referencing_book_mechanism_not_author_formula'}));
    const missing=[...new Set(checks.flatMap(c=>c.missingInputs))],cautions=checks.filter(c=>c.status==='caution');
    return {focus:p.focus,checks,missingInputs:missing,status:cautions.length?'research_caution':checks.every(c=>c.status==='unknown')?'abstain':'partial',boundRuleIds:p.ruleIds.slice(),unboundRuleIds:[...originals.keys()].filter(id=>!p.ruleIds.includes(id)),reason:p.focus+'：'+checks.map(c=>c.title+'—'+c.reason).join(' '),completeOriginalStrategyOperationalized:false,bookDirectionEnabled:false,executionAllowed:false};
  }
  return {PROFILES,recordValid,annualInfo,evaluate,inspect,stamp};
});
