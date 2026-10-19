(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StockEngine = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = '3.0.0', DAY = 86400000, MIN_BARS = 210;
  var finite = function (n) { return typeof n === 'number' && Number.isFinite(n); };
  var clamp = function (n, a, b) { return Math.max(a, Math.min(b, n)); };
  var round = function (n, places) { return finite(n) ? Number(n.toFixed(places === undefined ? 4 : places)) : null; };
  var BOOK_NAMES = ['聪明的投资者','证券分析','怎样选择成长股','股市投资致富之道','彼得·林奇的成功投资','战胜华尔街','股市天才','价值投资的秘密','投资最重要的事','周期','安全边际','穷查理宝典','笑傲股市','笑傲股市之股票买卖原则','股票魔法师','股票魔法师Ⅱ','超级强势股','股票投资就问三个问题','投资策略实战分析','如何富裕地退休','心理学与股票市场','逆向投资策略','有效资产管理','投资的四大支柱','赢得输家的游戏','指数革命','长赢投资','共同基金常识','漫步华尔街','投资的常识','魔鬼投资学','实力、运气与成功','股市长线法宝','投资者的未来','非理性繁荣','巴菲特致股东的信','盘口解读研究','我如何交易与投资股票和债券','股票作手操盘术','股市晴雨表'];
  var LABELS = {trend_up:'技术上行环境',range:'混合或区间环境',risk_off:'风险收缩环境',unknown:'环境资料不足'};
  var METHODS = '固定工程默认；未经参数优化或样本外校准；不归于原书';
  var LIMITATIONS = [
    '技术排序分不是上涨概率，也不是40位专家投票；没有已校准的5/20交易日预测。',
    '确定性规则检查与质疑记录未调用40个独立语言模型。仅3本有深读档案，其余37本原文不足，保持弃权。',
    'B37/B38出自同一作者，不构成两个独立证据来源。指数、均线、RSI、OBV、CMF之间也有相关性。',
    '日线成交量、OBV和CMF不能识别机构身份或真实净资金流；公开行情不自动视为实时。',
    '来源和可用时间由输入提供；程序不能独立证明供应商行情、复权、日历或财务披露正确。',
    '缺个人风险预算、借券与实际执行条件，不生成仓位、不授权下单；参考价线不是预测目标。'
  ];

  function stamp(value) {
    if (value instanceof Date) return value.getTime();
    if (finite(value)) { var n = value < 1e12 ? value * 1000 : value; return Math.abs(n) <= 8640000000000000 ? n : NaN; }
    if (typeof value !== 'string' || !value.trim()) return NaN;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      var t = Date.parse(value + 'T00:00:00Z');
      return finite(t) && new Date(t).toISOString().slice(0,10) === value ? t : NaN;
    }
    // Require an explicit timezone rather than silently interpreting local wall time.
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return NaN;
    if (!finite(stamp(value.slice(0,10)))) return NaN;
    return Date.parse(value);
  }
  function dateKey(t) { return finite(t) ? new Date(t).toISOString().slice(0,10) : null; }
  function iso(t) { return finite(t) ? new Date(t).toISOString() : null; }
  function timeOf(b) { return b && stamp(b.date !== undefined ? b.date : b.time !== undefined ? b.time : b.timestamp); }
  function error(code, reason, index) { return {code:code,reason:reason,message:reason,index:index === undefined ? null : index}; }
  function businessDays(from, to, holidays) {
    if (!finite(from) || !finite(to) || to < from) return null;
    var excluded = new Set(holidays || []), days = 0;
    for (var t = Math.floor(from / DAY) * DAY + DAY; t <= Math.floor(to / DAY) * DAY; t += DAY) {
      var dow = new Date(t).getUTCDay();
      if (dow !== 0 && dow !== 6 && !excluded.has(dateKey(t))) days++;
    }
    return days;
  }
  function validateBars(input, options) {
    options = options || {};
    var asOf = options.asOf === undefined ? Date.now() : stamp(options.asOf);
    var minimum = options.minBars === undefined ? MIN_BARS : options.minBars;
    var errors = [], warnings = [], bars = [], lastTime = -Infinity;
    if (!finite(asOf)) errors.push(error('INVALID_AS_OF','分析截止时间无效，需明确UTC时区。'));
    else if(asOf>Date.now()+60000)errors.push(error('FUTURE_AS_OF','分析截止时间在未来，不能视为已发生市场。'));
    if (!Number.isInteger(minimum) || minimum < 1) errors.push(error('INVALID_MIN_BARS','样本门槛必须为正整数。'));
    if (!Array.isArray(input)) errors.push(error('BARS_MISSING','未提供日线OHLCV数组。'));
    else {
      input.forEach(function (raw, i) {
        var t = timeOf(raw), b = {timestamp:t,date:dateKey(t),open:raw && raw.open,high:raw && raw.high,low:raw && raw.low,close:raw && raw.close,volume:raw && raw.volume};
        bars.push(b);
        if (!finite(t)) errors.push(error('INVALID_DATE','日线日期无效。',i));
        else {
          if (t <= lastTime) errors.push(error('NON_INCREASING_DATE','日期须严格递增，不能重复或倒序。',i));
          lastTime = t;
          if (finite(asOf) && t > asOf) errors.push(error('FUTURE_BAR','日线晚于分析截止时间。',i));
          if (raw && raw.availableAt !== undefined) {
            var available = stamp(raw.availableAt);
            if (!finite(available) || available > asOf || available < t) errors.push(error('BAR_NOT_AVAILABLE','该日线公开时间无效或晚于决策截止。',i));
          }
        }
        if (![b.open,b.high,b.low,b.close].every(function (n) { return finite(n) && n > 0; })) errors.push(error('INVALID_OHLC','OHLC须为有限正数，不接受数字字符串、NaN或Infinity。',i));
        else if (b.high < b.low || b.high < b.open || b.high < b.close || b.low > b.open || b.low > b.close) errors.push(error('IMPOSSIBLE_OHLC','最高最低价未包住开盘和收盘价。',i));
        if (!finite(b.volume) || b.volume < 0) errors.push(error('INVALID_VOLUME','成交量须为有限非负数。',i));
      });
      if (input.length < minimum) errors.push(error('INSUFFICIENT_SAMPLE','至少需要'+minimum+'根日线，当前'+input.length+'根；门槛为工程默认。'));
    }
    var latest = bars.length ? bars[bars.length - 1] : null;
    var state = options.marketState || {}, expected = state.expectedCompletedSession;
    var expectedTime = typeof expected === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expected) ? stamp(expected) : NaN;
    var calendarTime=stamp(state.asOf),calendarTimeValid=finite(calendarTime)&&calendarTime<=asOf&&asOf-calendarTime<=DAY;
    var calendarVerified = state.calendarVerified === true && finite(expectedTime) && expectedTime <= asOf && calendarTimeValid;
    if (state.calendarVerified === true && (!finite(expectedTime)||expectedTime>asOf)) errors.push(error('INVALID_SESSION_CALENDAR','已验证日历的最后完成session无效或晚于分析截止。'));
    if(state.calendarVerified===true&&!calendarTimeValid)warnings.push('日历状态观察时间缺失、晚于研究截止或超过24小时；忽略旧expectedCompletedSession，改用截止时点工作日新鲜度检查。');
    var lag = latest && finite(asOf) && asOf<=Date.now()+60000 ? businessDays(latest.timestamp, asOf, options.holidays) : null;
    if (latest && calendarVerified) {
      if (latest.timestamp > expectedTime) errors.push(error('INCOMPLETE_SESSION','包含尚未结束交易时段的日线；只能使用最后已完成session '+expected+'。'));
      if (options.checkFreshness !== false && latest.timestamp < expectedTime) errors.push(error('STALE_DATA','缺少最新已完成session '+expected+'；当前最后日线为'+latest.date+'。'));
    } else if (options.checkFreshness !== false) {
      var maxStale = options.maxStaleTradingDays === undefined ? 3 : options.maxStaleTradingDays;
      if (!finite(maxStale) || maxStale < 0) errors.push(error('INVALID_FRESHNESS_LIMIT','新鲜度限制必须非负。'));
      if (lag !== null && lag > maxStale) errors.push(error('STALE_DATA','最新日线已过去'+lag+'个工作日，超过'+maxStale+'日。'));
      warnings.push('未有完整可验证的交易所session日历；退化为UTC工作日及输入休市日，无法独立确认当天日线已收盘。');
    }
    return {valid:errors.length === 0,errors:errors,warnings:warnings,bars:bars,count:bars.length,minBars:minimum,latestDate:latest && latest.date,asOf:iso(asOf),staleTradingDays:lag,expectedCompletedSession:calendarVerified ? expected : null,calendarVerified:calendarVerified,calendarObservedAt:iso(calendarTime),calendarMethod:calendarVerified ? '输入提供的截止前24小时内交易所状态及最后已完成session' : 'UTC周一至周五减去输入holidays；不是完整交易所日历'};
  }
  function sma(values, period, end) {
    end = end === undefined ? values.length - 1 : end;
    if (end < period - 1) return null;
    var sum = 0;
    for (var i = end - period + 1; i <= end; i++) sum += values[i];
    return sum / period;
  }
  function rsi(values, period) {
    if (values.length <= period) return null;
    var up = 0, down = 0;
    for (var i = 1; i <= period; i++) { var d = values[i] - values[i - 1]; up += Math.max(d,0); down += Math.max(-d,0); }
    up /= period; down /= period;
    for (var j = period + 1; j < values.length; j++) { var delta = values[j] - values[j - 1]; up = (up*(period-1)+Math.max(delta,0))/period; down = (down*(period-1)+Math.max(-delta,0))/period; }
    return down === 0 ? (up === 0 ? 50 : 100) : 100 - 100/(1+up/down);
  }
  function atr(bars, period) {
    if (bars.length < period) return null;
    var trs = bars.map(function (b,i) { return i === 0 ? b.high-b.low : Math.max(b.high-b.low,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close)); });
    var a = sma(trs,period,period-1);
    for (var i = period; i < trs.length; i++) a = (a*(period-1)+trs[i])/period;
    return a;
  }
  function std(values) {
    if (values.length < 2) return null;
    var mean = values.reduce(function (a,b) { return a+b; },0)/values.length;
    return Math.sqrt(values.reduce(function (a,b) { return a+(b-mean)*(b-mean); },0)/(values.length-1));
  }
  function calc(bars) {
    var n = bars.length, last = bars[n-1], closes = bars.map(function (b) {return b.close;}), vols = bars.map(function (b) {return b.volume;});
    if (!last) return null;
    function ret(p) { return n > p ? 100*(last.close/closes[n-p-1]-1) : null; }
    var tail = bars.slice(-20), volume = tail.reduce(function (a,b) {return a+b.volume;},0);
    var mf = tail.reduce(function (a,b) { return a+(b.high === b.low ? 0 : (2*b.close-b.high-b.low)/(b.high-b.low))*b.volume; },0);
    var obv = 0, obvs = [0];
    for (var i = 1; i < n; i++) { obv += Math.sign(closes[i]-closes[i-1])*vols[i]; obvs.push(obv); }
    var cmf = tail.length === 20 && volume > 0 ? mf/volume : null;
    var obvSlope = n > 20 && volume > 0 ? (obv-obvs[n-21])/volume : null;
    var lr = [];
    for (var j = Math.max(1,n-20); j < n; j++) lr.push(Math.log(closes[j]/closes[j-1]));
    var sixty = bars.slice(-60), peak = -Infinity, maxDD = 0;
    sixty.forEach(function (b) {peak = Math.max(peak,b.close); maxDD = Math.max(maxDD,100*(1-b.close/peak));});
    var a = atr(bars,14), averageVol = sma(vols,20,n-2);
    return {price:round(last.close),sma20:round(sma(closes,20)),sma50:round(sma(closes,50)),sma60:round(sma(closes,60)),sma200:round(sma(closes,200)),rsi14:round(rsi(closes,14)),atr14:round(a),atrPct:round(a === null ? null : 100*a/last.close),volRatio:round(averageVol > 0 ? last.volume/averageVol : null),return5:round(ret(5)),return20:round(ret(20)),return60:round(ret(60)),volatility20:round(lr.length === 20 ? std(lr)*Math.sqrt(252)*100 : null),drawdown60:round(100*(1-last.close/peak)),maxDrawdown60:round(maxDD),cmf20:round(cmf),obv:round(obv,0),obvSlope20:round(obvSlope),avgDollarVolume20:round(tail.length === 20 ? tail.reduce(function(s,b){return s+b.close*b.volume;},0)/20 : null,0),rs5:null,rs20:null,rs60:null,relativeStrength:null,flowsProxy:{method:'日线OHLCV计算的CMF20 / OBV',direction:cmf === null || obvSlope === null ? 'unknown' : cmf > 0.05 && obvSlope > 0 ? 'positive_proxy' : cmf < -0.05 && obvSlope < 0 ? 'negative_proxy' : 'mixed',isRealInstitutionalFlow:false,label:'量价代理，不能证明机构身份、真实净流入或未来买卖'},units:{returns:'百分数',rs:'同期输入历史价格口径的收益差，百分点；股息调整取决于source priceBasis，未独立现金股息记账',atrPct:'百分数',volatility20:'20日对数收益样本标准差×√252，百分数',drawdown:'百分数，正数表示回撤',cmf20:'[-1,1]',obvSlope20:'20日OBV变化/20日成交量和'}};
  }
  function indicators(bars, options) { var v = validateBars(bars,options); return {validation:v,indicators:v.valid ? calc(v.bars) : null}; }
  function benchRecord(input, symbol) {
    var b = (input.benchmarks || {})[symbol];
    return Array.isArray(b) ? {symbol:symbol,bars:b} : b || {};
  }
  function benchValidate(input, symbol, options, min) {
    var b = benchRecord(input,symbol), v = validateBars(b.bars,Object.assign({},options,{minBars:min || MIN_BARS}));
    var accepted = {SPY:['SPY'],QQQ:['QQQ'],IWM:['IWM'],VIX:['VIX','^VIX'],DJI:['DJI','^DJI'],DJT:['DJT','^DJT']}[symbol];
    if (b.symbol && accepted.indexOf(String(b.symbol).toUpperCase()) < 0 || b.providerSymbol && accepted.indexOf(String(b.providerSymbol).toUpperCase()) < 0) {
      v.errors.push(error('BENCHMARK_IDENTITY_MISMATCH',symbol+'输入实际证券标识不匹配。')); v.valid = false;
    }
    if(['SPY','QQQ','IWM'].indexOf(symbol)>=0&&(b.priceBasis==='raw_unadjusted_or_unknown_ohlcv'||b.priceAdjustmentVerified===false)){
      v.errors.push(error('UNVERIFIED_PRICE_BASIS',symbol+'的历史价格公司行为口径明确未验证，不作为强技术环境/RS基准。'));v.valid=false;
    }
    return {symbol:symbol,record:b,validation:v,indicators:v.valid ? calc(v.bars) : null};
  }
  function readRegime(input, options) {
    input = input || {}; options = Object.assign({},options || {});
    if (options.asOf === undefined) options.asOf = input.asOf;
    if (!options.marketState) options.marketState = input.marketState;
    var spy = benchValidate(input,'SPY',options), qqq = benchValidate(input,'QQQ',options), iwm = benchValidate(input,'IWM',options), vix = benchValidate(input,'VIX',options,20);
    var valid = spy.validation.valid && qqq.validation.valid, id = 'unknown', evidence = [];
    function above(b) { var m = b.indicators; return m.price > m.sma20 && m.sma20 > m.sma60 && m.price > m.sma200; }
    if (!valid) evidence.push('SPY/QQQ缺少有效、新鲜的210根日线，环境不能确认。');
    else {
      if (vix.validation.valid && vix.indicators.price >= 30 || spy.indicators.price < spy.indicators.sma200 && qqq.indicators.price < qqq.indicators.sma200) id = 'risk_off';
      else if (above(spy) && above(qqq)) id = 'trend_up';
      else id = 'range';
      [spy,qqq].forEach(function(b){var m=b.indicators;evidence.push(b.symbol+' close '+m.price+'；MA20/60/200='+m.sma20+'/'+m.sma60+'/'+m.sma200+'。');});
    }
    if (vix.validation.valid) evidence.push('VIX最后已完成日线 '+vix.indicators.price+'；30为工程风险门槛。');
    else evidence.push('VIX不可用；波动风险观察缺失，不补造数值。');
    if (iwm.validation.valid) evidence.push('IWM '+(above(iwm) ? '同步上行' : '未同步上行')+'，仅作小盘辅助背景，不增加独立票数。');
    else evidence.push('IWM不可用；小盘辅助背景不足。');
    return {id:id,label:LABELS[id],valid:valid,evidence:evidence,definition:'SPY/QQQ均close>MA20、MA20>MA60且close>MA200为trend_up；两者close<MA200或有效VIX≥30为risk_off；其他range。',thresholdOrigin:METHODS,vetoNewLong:id !== 'trend_up',benchmarks:{SPY:{valid:spy.validation.valid,indicators:spy.indicators,errors:spy.validation.errors,latestDate:spy.validation.latestDate},QQQ:{valid:qqq.validation.valid,indicators:qqq.indicators,errors:qqq.validation.errors,latestDate:qqq.validation.latestDate},IWM:{valid:iwm.validation.valid,indicators:iwm.indicators,errors:iwm.validation.errors},VIX:{valid:vix.validation.valid,indicators:vix.indicators,errors:vix.validation.errors}},warnings:[].concat(spy.validation.warnings,qqq.validation.warnings),independenceNote:'这些是相关市场资料，不是独立书本或专家投票。'};
  }
  function relative(bars, spy) {
    var out = {benchmark:'SPY',method:'对齐stock最近5/20/60根的起止日期，按输入历史价格口径比较收益；是否含股息调整由供应商priceBasis决定，未独立现金股息记账；不得取不同日期',periods:{},valid:true};
    var lookup = new Map(spy.map(function(b){return [b.date,b];})), end = bars[bars.length-1];
    [5,20,60].forEach(function(p) {
      var start = bars[bars.length-p-1], b0 = start && lookup.get(start.date), b1 = lookup.get(end.date);
      var stockDates = start ? bars.slice(-p-1).map(function(b){return b.date;}) : [];
      var spyDates = b0 && b1 ? spy.filter(function(b){return b.date >= start.date && b.date <= end.date;}).map(function(b){return b.date;}) : [];
      var aligned = stockDates.length === p+1 && JSON.stringify(stockDates) === JSON.stringify(spyDates);
      var a = aligned ? 100*(end.close/start.close-1) : null, s = aligned ? 100*(b1.close/b0.close-1) : null;
      out.periods[p] = {valid:aligned,startDate:start && start.date,endDate:end.date,stockReturn:round(a),benchmarkReturn:round(s),excessPercentagePoints:round(aligned ? a-s : null),reason:aligned ? null : '起止日期或完整交易session序列不一致。'};
      if (!aligned) out.valid = false;
    });
    return out;
  }
  function costModel(options) {
    var c = options.costs || {}, commission = c.commissionBps === undefined ? 1 : c.commissionBps, slippage = c.slippageBps === undefined ? 5 : c.slippageBps;
    var valid = finite(commission) && finite(slippage) && commission >= 0 && slippage >= 0 && commission+slippage < 10000;
    return {valid:valid,commissionBps:finite(commission)?commission:null,slippageBps:finite(slippage)?slippage:null,oneWayBps:valid?commission+slippage:null,roundTripPct:valid?2*(commission+slippage)/100:null,origin:c.commissionBps === undefined && c.slippageBps === undefined ? '工程默认单边1bp佣金+5bp滑点，未经实盘校准' : '用户输入成本假设，不证明实际成交',includes:'佣金和假设滑点；税费、融资、借券及真实冲击可能未覆盖'};
  }
  function datedEvidence(raw, asOf, minFields) {
    var errors = [], missing = [], fields = {}, cutoff = stamp(asOf);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {available:false,status:'unavailable',reason:'未提供带出处和公开日期的原始资料。',errors:[],missingFields:minFields || [],observedFields:{}};
    if (typeof raw.source !== 'string' || !raw.source.trim()) missing.push('source');
    var observed = stamp(raw.asOf), available = stamp(raw.availableAt);
    if (!finite(observed)) missing.push('asOf');
    else if (observed > cutoff) errors.push('观察日期晚于分析截止。');
    if (!finite(available)) missing.push('availableAt');
    else if (available > cutoff) errors.push('资料在分析截止后才公开。');
    if (finite(observed) && finite(available) && available < observed) errors.push('公开日期早于资料观察日期，口径无法核实。');
    if (finite(observed) && cutoff-observed > 550*DAY) errors.push('资料观察日期超过550日；工程新鲜度限制。');
    (minFields || []).forEach(function(k) { if (raw[k] === undefined || raw[k] === null) missing.push(k); });
    ['pe','pb','roe','revenueGrowth','earningsGrowth','netMargin','debtToEquity','operatingCashFlow','freeCashFlow','marketCap','revenue','netIncome','totalDebt','cash'].forEach(function(k) {
      if (raw[k] !== undefined && raw[k] !== null) { if (!finite(raw[k])) errors.push(k+'不是有限数字。'); else fields[k]=raw[k]; }
    });
    var okay = !errors.length && !missing.length;
    return {available:okay,status:okay?'available':'insufficient',reason:okay?'带来源及当时公开时间；仅证明资料可用于研究，不等于企业调查已完成。':'缺少或无法确认必要的原始资料。',errors:errors,missingFields:missing,observedFields:fields,source:raw.source || null,asOf:iso(observed),availableAt:iso(available)};
  }
  function assessFundamentals(raw, asOf) {
    var f = datedEvidence(raw,asOf,['revenueGrowth','earningsGrowth','netMargin','debtToEquity','operatingCashFlow']);
    f.valuationComplete = f.available && finite(raw && raw.pe) && raw.pe > 0;
    f.isInvestmentRecommendation = false;
    return f;
  }
  function scoreTechnical(m, horizon) {
    if (!m) return {score:null,components:[],label:'行情无效，未评分。'};
    var components = [];
    function add(id,label,value,weight,observed,method) {components.push({id:id,label:label,points:round(value,2),maxPoints:weight,observed:observed,method:method,origin:'modern_engineering_default',bookAttribution:null});}
    add('close_ma20','收盘在20日均线上',m.price>m.sma20?12:0,12,{price:m.price,sma20:m.sma20},'条件成立12分，否则0分');
    add('ma20_ma60','20/60日均线趋势',m.sma20>m.sma60?10:0,10,{sma20:m.sma20,sma60:m.sma60},'条件成立10分，否则0分');
    add('long_context','收盘在200日均线上',m.price>m.sma200?8:0,8,{price:m.price,sma200:m.sma200},'条件成立8分，否则0分');
    add('rs20','20日相对SPY',finite(m.rs20)?15*clamp(0.5+m.rs20/10,0,1):0,15,m.rs20,'-5至+5个百分点线性映射0至15分；缺失0分且风险门禁用');
    add('rs60','60日相对SPY',finite(m.rs60)?10*clamp(0.5+m.rs60/20,0,1):0,10,m.rs60,'-10至+10个百分点线性映射0至10分');
    var momentum = horizon === 5 ? m.return5 : m.return20;
    add('momentum','所选期限的近期价格动量',10*clamp(0.5+momentum/(horizon===5?10:20),0,1),10,momentum,'5日±5%或20日±10%映射；是历史价格变化，不是前向收益');
    add('rsi','RSI中间位置',m.rsi14>=45 && m.rsi14<=70?5:m.rsi14>70?2:0,5,m.rsi14,'45–70为5分，超过70为2分，其余0分；工程区间');
    add('cmf','CMF收盘位置量价代理',finite(m.cmf20)?10*clamp(0.5+m.cmf20,0,1):0,10,m.cmf20,'[-0.5,+0.5]映射0至10分，不指认资金身份');
    add('obv','OBV价格方向量价代理',finite(m.obvSlope20)?5*clamp(0.5+m.obvSlope20/2,0,1):0,5,m.obvSlope20,'[-1,+1]映射0至5分；与其他价格指标相关');
    add('atr','波动风险折扣',10*clamp(1-m.atrPct/8,0,1),10,m.atrPct,'ATR%从0至8%，10至0分；未校准风险折扣');
    add('drawdown','60日最大回撤折扣',5*clamp(1-m.maxDrawdown60/25,0,1),5,m.maxDrawdown60,'0至25%回撤，5至0分');
    return {score:round(components.reduce(function(a,c){return a+c.points;},0),2),components:components,label:'0–100技术排序分，固定工程权重；非胜率、非原著公式',calibrated:false};
  }
  function citation(book, id, pdf, printed) {
    return {bookId:book,ruleId:id,pdfPages:pdf,printedPages:printed || [],definitionPath:'outputs/book-experts-v2/'+book+'/专家定义.json',dossierPath:'outputs/book-experts-v2/'+book+'/章节深读.md',evidenceScope:'支持原书语义和资料限制；不证明现代指标效力或未来收益'};
  }
  function rule(id, claim, status, reason, evidence, missing, observed) { return {id:id,claim:claim,status:status,reason:reason,evidence:evidence,missingInputs:missing || [],observed:observed || null,directionalVote:null}; }
  function tapeAudit(raw, symbol, asOf) {
    var missing = [], errors = [], cutoff = stamp(asOf);
    if (!raw || typeof raw !== 'object') return {valid:false,missing:['timestamped_trades','synchronized_bid_ask','source','execution_costs'],errors:[],scope:'无逐笔行情，日线不能替代。'};
    if (!raw.source) missing.push('source');
    if (raw.symbol !== symbol) errors.push('逐笔证券标识与目标不一致。');
    var trades = raw.trades, quotes = raw.bidAsk;
    if (!Array.isArray(trades) || !trades.length) missing.push('timestamped_trades');
    if (!Array.isArray(quotes) || !quotes.length) missing.push('synchronized_bid_ask');
    var latest = 0;
    function inspect(rows,isQuote) {
      if (!Array.isArray(rows)) return;
      var previous = -Infinity;
      rows.forEach(function(r) {
        var t = stamp(r.timestamp || r.time);
        if (!finite(t) || t > cutoff || t < previous) errors.push('逐笔时间无效、倒序或晚于截止。');
        if (finite(t)) {latest=Math.max(latest,t);previous=t;}
        if (isQuote) {if (!finite(r.bid)||!finite(r.ask)||r.bid<=0||r.ask<r.bid) errors.push('bid/ask无效。');}
        else if (!finite(r.price)||r.price<=0||!finite(r.size)||r.size<=0) errors.push('逐笔成交价格或数量无效。');
      });
    }
    inspect(trades,false);inspect(quotes,true);
    if (latest && cutoff-latest > 60000) errors.push('逐笔与决策时刻相隔超过60秒；工程同步检查。');
    if (Array.isArray(trades) && Array.isArray(quotes) && trades.length && quotes.length) {
      var qt = quotes.map(function(q){return stamp(q.timestamp||q.time);});
      if (trades.some(function(t){var tt=stamp(t.timestamp||t.time);return !qt.some(function(q){return q<=tt && tt-q<=5000;});})) errors.push('成交前5秒内缺同步报价；工程同步检查。');
    }
    return {valid:missing.length===0 && errors.length===0,missing:missing,errors:errors,scope:'只审计资料边界；未将原著读盘自动数值化，不输出5/20日方向。'};
  }
  function bookExperts(input, context, options) {
    var m=context.indicators, fund=context.fundamentals, horizon=options.horizonDays, asOf=context.asOf, experts=[];
    var tape=tapeAudit(input.tapeQuotes,input.symbol,asOf);
    var c37=[citation('B37','B37-R01',[15,16,182,184],[9,10,176,178]),citation('B37','B37-R02',[81,82,86],[75,76,80]),citation('B37','B37-R04',[84,89,91,162,163,164],[78,83,85,156,157,158]),citation('B37','B37-R10',[67,68,160,161],[61,62,154,155]),citation('B37','B37-R13',[153,154,155,156,157],[147,148,149,150,151]),citation('B37','B37-R14',[33,34,108,165,166,167],[27,28,102,159,160,161])];
    var r37=[
      rule('B37-R01','原书后期缩到即时约半小时运动，不是5/20日概率模型。','boundary_applied','选定'+horizon+'交易日与原读盘时间尺度不符；不延长原书预期。',c37[0],['intraday_decision_horizon']),
      rule('B37-R02','末笔成交已过去，判断须有当前买卖报价。','abstain',tape.valid?'逐笔资料初步有效，但自动读盘判断尚未经验证。':'缺有效同步逐笔成交/报价，日线不能代替。',c37[1],tape.missing.concat(tape.errors),{tapeValid:tape.valid}),
      rule('B37-R04','量的意义依股性、时段和价格反应，不能指认机构身份。','boundary_applied','CMF/OBV仅保留量价代理，删除主力吸筹或派发断言。',c37[2],[],{cmf20:m&&m.cmf20,obvSlope20:m&&m.obvSlope20}),
      rule('B37-R10','作者收回可靠预估波幅的初期设想。','boundary_applied','ATR参考距离不当预测振幅或利润目标；保留第IV→X→XII章修订。',c37[3],[]),
      rule('B37-R13','日内与长线任务须分开；失败不能临时改名长线。','boundary_applied','记录'+horizon+'交易日研究期限，不声称读盘专家支持中长期个股。',c37[4],[]),
      rule('B37-R14','保护退出须计滑点；空头收紧保护应下调止损。','abstain','只提供假设成本，未有真实盘口/资本预算/退出计划，不能给个人止损仓位。',c37[5],['bid_ask','risk_budget','execution_plan'])
    ];
    experts.push({id:'B37',name:'盘口解读研究',author:'Richard D. Wyckoff',knowledgeStatus:'chapter_dossier_ready_qualified',status:'abstain',reason:'日线与5/20日任务不满足原书逐笔、同步买卖报价及即时运动条件。知识边界已执行，个股方向弃权。',scope:'即时/约半小时读盘；不能从daily bars模拟带子',rules:r37,evidence:c37,directionalVote:null,sourceIndependence:'与B38同作者，不能当两票独立验证',tapeAudit:tape,currentDirectionEnabled:false});
    var peers=datedEvidence(input.sectorPeers,asOf,['peers']), management=datedEvidence(input.managementEvidence,asOf,['assessment']);
    var missing38=[];if(!fund.available)missing38.push('dated_company_fundamentals');if(!peers.available)missing38.push('dated_sector_peers');if(!management.available)missing38.push('dated_management_investigation');
    var c38=[citation('B38','B38-R03',[35,50,108,109]),citation('B38','B38-R04',[45,60,140,143]),citation('B38','B38-R11',[105,108]),citation('B38','B38-R12',[107,113]),citation('B38','B38-R13',[114,118]),citation('B38','B38-R17',[138,140]),citation('B38','B38-R20',[157,160]),citation('B38','B38-R26',[210,211])];
    var r38=[
      rule('B38-R03','图表是记录工具，不能代替企业调查。',m?'partial_observation':'abstain',m?'记录实际日线价格；20/60均线及技术分是现代补充，不是原书机械公式。':'无有效价格历史。',c38[0],m?[]:['price_history'],m?{price:m.price,sma20:m.sma20,sma60:m.sma60}:null),
      rule('B38-R04','周转须按费用后的净结果衡量。',context.costs.valid?'boundary_applied':'abstain',context.costs.valid?'显式单边成本及往返成本；未将历史波动当已实现利润。':'成本假设无效。',c38[1],context.costs.valid?[]:['valid_trade_costs'],context.costs),
      rule('B38-R11','先查长趋势、行业、企业变化、管理、财务盈利与技术位置。','abstain',missing38.length?'六项调查未完成：'+missing38.join('、')+'。':'资料初步齐全，但资料解释、企业变化与价值审查未自动化；不从比率给出投资结论。',c38[2],missing38.length?missing38:['qualitative_company_due_diligence']),
      rule('B38-R12','长趋势优先，逆市例外需行业和公司依据。','boundary_applied','当前大市='+context.regime.id+'；系统独立硬门不得被个股高分覆盖。',c38[3],missing38,{regime:context.regime.id,rs20:m&&m.rs20}),
      rule('B38-R13','潜在清算、持仓和回补需真实供求资料。','abstain','OHLCV/CMF/OBV不能识别持有人、购买力或真实净买入。',c38[4],['dated_ownership_evidence','short_interest','trade_identity']),
      rule('B38-R17','时间与价格停止须对照原任务。','boundary_applied','研究期限冻结'+horizon+'日；价格线仅ATR参考，不当实际止损或可保证退出。',c38[5],['personal_risk_budget','executable_exit_plan']),
      rule('B38-R20','低价不是摊平依据，须新增企业调查。','abstain','本引擎不因回撤或价格下跌自动加仓。',c38[6],['improved_dated_fundamentals','portfolio_cash_flows']),
      rule('B38-R26','不同证券名称不等于独立风险。','boundary_applied','未将同作者两书、相关价格指标与ETF当独立多数票。',c38[7],['portfolio_exposure_map'])
    ];
    experts.push({id:'B38',name:'我如何交易与投资股票和债券',author:'Richard D. Wyckoff',knowledgeStatus:'chapter_dossier_ready_qualified',status:m?'partial':'abstain',reason:m?'日线允许有限价格观察和成本/期限约束；企业价值与投资方向因调查缺口弃权。':'有效价格资料不足，全部方向弃权。',scope:'价格观察、投资调查和资本约束；本书未规定本引擎20/60参数',rules:r38,evidence:c38,directionalVote:null,currentDirectionEnabled:false,sourceIndependence:'与B37同作者，不合成多数票',fundamentalInvestigation:{fundamentals:fund.status,sectorPeers:peers.status,management:management.status}});
    var bp={asOf:asOf,marketState:input.marketState,holidays:input.holidays};
    var dji=benchValidate(input,'DJI',bp), djt=benchValidate(input,'DJT',bp);
    function actualIndex(b,key) {return b.validation.valid && (b.record.providerSymbol==='^'+key || b.record.symbol===key || b.record.symbol==='^'+key) && typeof b.record.source==='string' && !!b.record.source.trim();}
    var actual=actualIndex(dji,'DJI')&&actualIndex(djt,'DJT'), dow=null;
    if(actual){
      function state(b){var q=b.indicators;return q.price>q.sma20&&q.sma20>q.sma60?'up':q.price<q.sma20&&q.sma20<q.sma60?'down':'mixed';}
      var a=state(dji),b=state(djt);
      dow={status:'modern_observation',DJI:{trend:a,price:dji.indicators.price,sma20:dji.indicators.sma20,sma60:dji.indicators.sma60,source:dji.record.source},DJT:{trend:b,price:djt.indicators.price,sma20:djt.indicators.sma20,sma60:djt.indicators.sma60,source:djt.record.source},alignment:a===b?a:'unconfirmed',definition:'真实现代DJI/DJT的20/60均线观察，仅工程描述。',isOriginalDowConfirmation:false,boundary:'现代成分、运输而非原铁路组、末笔收盘而非原收盘买价；未自动复原原书重要转折/次级反应。'};
    }
    var c40=[citation('B40','B40-01-time_layers',[23,24,50],[5,6,32]),citation('B40','B40-03-joint_confirmation',[80,81,194,200],[62,63,172,178]),citation('B40','B40-16-quote_basis',[194,293,294],[172,269,270]),citation('B40','B40-17-composition_continuity',[22,294,295,296,297],[4,270,271,272,273]),citation('B40','B40-12-no_flow_identity_from_volume',[250,252,253,258],[226,228,229,234]),citation('B40','B40-22-wait_without_signal',[261,262],[237,238]),citation('B40','B40-24-no_reason_switch',[282,287,288],[258,263,264])];
    var r40=[
      rule('B40-01-time_layers','主要、次级与日常运动不能互换。','boundary_applied','5/20日研究不被称为原书主要趋势；单日与均线观察不能证明主要行情。',c40[0],[]),
      rule('B40-03-joint_confirmation','整体趋势需两组平均共同支持重要转折。','abstain',actual?'已读真实现代DJI/DJT，但只做工程均线观察；未有原口径和重要转折确认。':'缺有效、可识别来源的真实DJI/DJT；SPY/QQQ不替代原双平均。',c40[1],['original_closing_bid_series','asof_important_swing_points'],dow),
      rule('B40-16-quote_basis','原书是每日收盘买价口径。','abstain','现代OHLC close不自动等于closing bid，不宣称原书双平均确认。',c40[2],['original_quote_basis']),
      rule('B40-17-composition_continuity','成分、股类、面值和链接规则决定可比性。','abstain','现代DJI/DJT不是原书工业与铁路组的原始组成，未完成成分连续性重建。',c40[3],['dated_constituents','share_class','par_value_linking_policy']),
      rule('B40-12-no_flow_identity_from_volume','成交量不足以证明机构身份和净买入。','abstain','公开日量只是换手计量，不伪造机构资金。',c40[4],['identified_account_or_regulatory_evidence']),
      rule('B40-22-wait_without_signal','晴雨表可没有明确指示。','boundary_applied','缺双确认或条件混合时保留弃权；现代排序不能覆盖原书证据缺口。',c40[5],[]),
      rule('B40-24-no_reason_switch','长期价值与短促行情的理由不能事后交换。','boundary_applied','当前只为'+horizon+'交易日技术研究，不能标成企业价值认定或盈利保证。',c40[6],[])
    ];
    experts.push({id:'B40',name:'股市晴雨表',author:'William Peter Hamilton',knowledgeStatus:'chapter_dossier_ready_qualified',status:actual?'partial':'abstain',reason:actual?'实际现代DJI/DJT已观察；原道氏双平均与主要趋势结论因资料口径不足仍弃权。':'原双平均资料不足，方向弃权；SPY/QQQ只用于独立现代环境。',scope:'大市分层运动；不自动选出某股5/20日收益',rules:r40,evidence:c40,directionalVote:null,currentDirectionEnabled:false,modernDowObservation:dow});
    if(options.includePendingExperts !== false){BOOK_NAMES.forEach(function(name,i){var id='B'+String(i+1).padStart(2,'0');if(['B37','B38','B40'].indexOf(id)<0)experts.push({id:id,name:name,status:'abstain',knowledgeStatus:'pending_full_text',reason:'尚无授权完整原文与逐章深读，不执行书本策略、不推测作者意见。',rules:[],evidence:[],directionalVote:null,currentDirectionEnabled:false});});}
    return experts.sort(function(a,b){return a.id.localeCompare(b.id);});
  }
  function fingerprint(value) {
    var s=JSON.stringify(value),hash=2166136261;
    for(var i=0;i<s.length;i++){hash^=s.charCodeAt(i);hash=Math.imul(hash,16777619);}
    return 'fnv1a-'+(hash>>>0).toString(16).padStart(8,'0');
  }
  function sourceText(book){return book.evidence.map(function(c){return c.bookId+' '+c.ruleId+' PDF '+c.pdfPages.join('/');});}
  function debate(context) {
    var m=context.indicators,experts=context.bookExperts,score=context.score,gateList=context.gates;
    var books=experts.filter(function(b){return b.knowledgeStatus!=='pending_full_text';}),b37=books.find(function(b){return b.id==='B37';}),b38=books.find(function(b){return b.id==='B38';}),b40=books.find(function(b){return b.id==='B40';});
    function item(name,position,evidence,challenge,response,adjudication,sources){return {name:name,position:position,evidence:evidence,challenge:challenge,response:response,adjudication:adjudication,sources:sources||[]};}
    var observed=m?['价格='+m.price,'MA20/60='+m.sma20+'/'+m.sma60,'20日RS='+m.rs20+'个百分点','ATR='+m.atrPct+'%','CMF='+m.cmf20]:['目标OHLCV无效，未产生指标。'];
    var concrete=m?'价格距MA20 '+round(100*(m.price/m.sma20-1),2)+'%；20日RS '+m.rs20+'，技术排序 '+score+'。':'无有效指标，不能支持候选。';
    var challenges=[
      item('B37 期限与数据质疑','弃权5/20日读盘方向',sourceText(b37),'现代模型把daily volume和ATR当带子或未来波幅了吗？目标为'+context.horizonDays+'日，逐笔资料有效='+b37.tapeAudit.valid+'。','现代模型撤除读盘和主力身份表述；仅保留OHLCV技术评分，ATR为已观测风险距离。','保留现代分，否定B37方向背书。',b37.evidence),
      item('B38 企业调查质疑','投资价值判断弃权',sourceText(b38),'财务资料='+context.fundamentals.status+'；行业/管理调查='+JSON.stringify(b38.fundamentalInvestigation)+'。价格强能否代替企业盈利？','排序范围收缩为技术机会。未给企业便宜、优质、可长期持有等结论，调查缺口不补造。','企业价值子命题不成立；技术描述条件保留。',b38.evidence),
      item('B40 双平均质疑','原道氏确认弃权',sourceText(b40),b40.modernDowObservation?'现代DJI/DJT的均线一致能否当原收盘买价、原铁路组成和重要转折确认？':'缺实际DJI/DJT，是否曾用SPY/QQQ替代原工业/铁路双平均？','现代模型将SPY/QQQ限定为工程regime；DJI/DJT如有效只描述现代均线，不作为原主要趋势背书。','原道氏结论弃权；现代市场环境独立计算。',b40.evidence)
    ];
    var responseEvidence=m?['60日最大回撤='+m.maxDrawdown60+'%','波动率20='+m.volatility20+'%年化','平均日成交额='+m.avgDollarVolume20,'成本往返='+context.costs.roundTripPct+'%']:['价格输入无效'];
    var riskReason=gateList.length?gateList.map(function(g){return g.code+'：'+g.reason;}).join('；'):context.eligible?'已通过当前技术候选门；尚无已校准概率、个人预算或交易授权。':'数据和环境硬门通过，但技术排序未达到60的工程入选线；仍不产生概率或交易授权。';
    return [
      {round:0,title:'冻结输入与任务',items:[item('资料审计','截止时间冻结', ['asOf='+context.asOf,'horizon='+context.horizonDays+'交易日','snapshot='+context.snapshotFingerprint], '之后公开的数据会污染当时判断吗？','未来日线/报价/财务可用时间分别校验；不从当前财务回填历史。','只采用截止前可用资料。',[])]},
      {round:1,title:'独立观察与弃权',items:[item('现代技术模型',m?'技术排序研究':'弃权',observed,null,concrete,'评分未校准，方向不是概率。',[])].concat(books.map(function(b){return item(b.id+' '+b.name,b.status,b.rules.map(function(r){return r.id+'：'+r.reason;}),null,b.reason,'directionalVote=null；只执行有页码的条件/边界。',b.evidence);})),pendingBookCount:37},
      {round:2,title:'逐项交叉质疑',items:challenges},
      {round:3,title:'回应、替代解释与修正',items:[item('现代模型回应','保留限定的技术描述',responseEvidence,'量价正值也可能来自被动再平衡、回补、新闻跳空；RS与均线高度相关，不能相乘当胜率。','删除机构身份、原作者买入建议和概率措辞。只保留'+context.horizonDays+'日观察任务，固定分数是排序工具。','证据适用范围已收缩；未证明上涨或净利润。',[]),item('执行风险质疑者','成本与波动独立检查',responseEvidence,'实际价差/冲击未知；即使分高，往返成本或高ATR是否吞噬可承受空间？',riskReason,'硬门与评分独立，不接受相关多数票覆盖。',[])]},
      {round:4,title:'证据裁决与未解决分歧',items:[item('证据裁决者','原著结论与现代补充分别裁决',books.map(function(b){return b.id+' '+b.status+'；方向弃权';}),'3本有知识，是否意味着3个原书策略均可执行并背书当前股票？','不能。B37期限/逐笔不符；B38调查未完成；B40原始双确认不足。37本原文不足。','仅现代技术排序可作候选研究；不合成原书一致意见或胜率。',books.reduce(function(a,b){return a.concat(b.evidence);},[]))]},
      {round:5,title:'独立环境与风险硬门',items:[item('独立风险门',context.eligible?'允许进入技术候选清单':'否决新多头候选',context.regime.evidence.concat(gateList.map(function(g){return g.code+'：'+g.reason;})),'高技术分能否覆盖risk_off、过期、坏日线或缺基准？','不能；门控发生在评分之后且不受书本数量影响。',riskReason,[])]}
    ];
  }
  function normalize(input,options){
    var out=Object.assign({},input||{}),symbol=options.symbol||out.symbol;
    if(out.stocks){out=Object.assign({},out,out.stocks[symbol]||{}, {symbol:symbol,benchmarks:out.benchmarks,marketState:out.marketState});}
    out.symbol=typeof symbol==='string'?symbol.trim().toUpperCase():symbol;
    out.asOf=options.asOf!==undefined?options.asOf:out.asOf!==undefined?out.asOf:out.capturedAt||out.generatedAt||iso(Date.now());
    return out;
  }
  function analyze(input,options){
    options=Object.assign({horizonDays:5},options||{});input=normalize(input,options);
    var asOf=stamp(input.asOf),gates=[],warnings=[],horizon=options.horizonDays;
    function gate(code,reason,details){if(!gates.some(function(g){return g.code===code;}))gates.push({code:code,reason:reason,severity:'hard',source:'independent_engineering_risk_gate',details:details||null});}
    if(typeof input.symbol!=='string'||!input.symbol||!/^[A-Z0-9.^=-]{1,20}$/.test(input.symbol))gate('SYMBOL_MISSING','缺少有效目标证券标识。');
    if(typeof input.symbol==='string'&&/=F$/.test(input.symbol)||input.instrumentType==='FUTURE')gate('UNSUPPORTED_INSTRUMENT','此研究引擎限股票；期货合约、展期与保证金机制未实现。');
    if(input.stocks&&input.stocks[input.symbol]===undefined)gate('SYMBOL_NOT_IN_SNAPSHOT','快照中不存在目标证券，不补造行情。');
    if(horizon!==5&&horizon!==20)gate('INVALID_HORIZON','当前只接受5或20个交易日研究期限。');
    if(!finite(asOf))gate('INVALID_AS_OF','分析截止时间无效。');
    else if(asOf>Date.now()+60000)gate('FUTURE_AS_OF','分析截止时间在未来，不能生成当前市场结论。');
    var vo={asOf:input.asOf,marketState:input.marketState,holidays:input.holidays,minBars:MIN_BARS};
    var validation=validateBars(input.bars,vo),m=validation.valid?calc(validation.bars):null;
    validation.errors.forEach(function(e){gate(e.code,e.reason,{index:e.index});});warnings=warnings.concat(validation.warnings);
    if(input.priceBasis==='raw_unadjusted_or_unknown_ohlcv'||input.priceAdjustmentVerified===false)gate('UNVERIFIED_PRICE_BASIS','历史价格公司行为口径明确未确认；可观察原图，但不能用潜在拆股/分配断点入候选。',{priceBasis:input.priceBasis||null});
    if(!input.priceBasis)warnings.push('未提供历史价格复权口径元数据，程序不能证明公司行为处理正确。');
    var quote=input.quote;
    if(quote){
      if(!finite(quote.price)||quote.price<=0)gate('INVALID_QUOTE','报价价格须为有限正数。');
      var qt=stamp(quote.timestamp);
      if(!finite(qt)&&quote.priceKind==='daily_close'&&quote.status==='available_daily_close'){
        var dailyTime=stamp(quote.asOfDate);
        if(!finite(dailyTime)||dailyTime>asOf||quote.asOfDate!==validation.latestDate)gate('INVALID_DAILY_CLOSE_DATE','日收盘quote缺对应最后有效完整session日期。');
        warnings.push('该quote只是'+(quote.asOfDate||'未知日期')+'日收盘观察，来源没有精确成交时间；不能称为当前或实时成交报价。');
      }else if(!finite(qt))gate('INVALID_QUOTE_TIME','报价缺有效UTC时间，无法判断当时可用性。');
      else if(finite(asOf)&&qt>asOf)gate('FUTURE_QUOTE','报价晚于分析截止时间。');
      if(quote.currency&&quote.currency!=='USD')gate('CURRENCY_MISMATCH','价格币种不是USD，本美股技术筛选不做隐含换汇。');
      if(finite(qt)&&validation.expectedCompletedSession&&dateKey(qt)<validation.expectedCompletedSession)gate('STALE_QUOTE','报价早于最后已完成市场session。');
    }else warnings.push('没有带时间的最新quote，所有技术研究仅依据最后完整日线收盘；不声称可按该价即时交易。');
    var regime=readRegime(input,vo),spy=benchValidate(input,'SPY',vo);
    if(!regime.valid)gate('MISSING_BENCHMARK','SPY/QQQ缺失、无效或过期，现代环境不能确认。',regime.benchmarks);
    if(regime.id!=='trend_up')gate('REGIME_VETO','当前'+regime.label+'；工程策略暂停新的多头候选。',{regime:regime.id});
    if(m&&spy.validation.valid){
      var rs=relative(validation.bars,spy.validation.bars);m.relativeStrength=rs;
      m.rs5=rs.periods[5].excessPercentagePoints;m.rs20=rs.periods[20].excessPercentagePoints;m.rs60=rs.periods[60].excessPercentagePoints;
      if(!rs.valid)gate('BENCHMARK_DATE_MISMATCH','股票与SPY最近交易session不完整对齐，不能做同口径相对强弱。',rs);
    }
    var costs=costModel(options);
    if(!costs.valid)gate('INVALID_COSTS','佣金/滑点必须为有限非负bps，单边总成本需小于100%。');
    if(m){
      if(m.atrPct>6)gate('HIGH_ATR','ATR14超过价格6%，工程高波动门暂停候选。',{atrPct:m.atrPct});
      if(m.avgDollarVolume20<10000000)gate('LOW_LIQUIDITY','20日平均成交额低于1000万美元，工程流动性门暂停候选。',{averageDollarVolume:m.avgDollarVolume20});
      if(costs.valid&&costs.roundTripPct>=m.atrPct)gate('COST_DOMINATES_ATR','假设往返费用不少于一份已观测ATR距离，工程费用门暂停候选。',{roundTripPct:costs.roundTripPct,atrPct:m.atrPct});
      if(m.cmf20===null||m.obvSlope20===null)gate('VOLUME_PROXY_UNAVAILABLE','最近20日总成交量为零或不足，不计算虚构量价代理。');
    }
    if(input.volumeAdjustmentVerified!==true)warnings.push('价格与成交量复权一致性未经独立验证，CMF/OBV/成交額代理可能受公司行为影响。');
    if(input.isRealtime!==true)warnings.push('输入为公开或未验证实时行情；结论是截至资料时点的研究快照。');
    var earningsDate=input.earningsDate || input.quote&&input.quote.earningsDate || input.fundamentals&&input.fundamentals.earningsDate;
    if(earningsDate){var et=stamp(earningsDate);if(!finite(et))gate('INVALID_EARNINGS_DATE','提供的财报日期无效。');else if(et>=Math.floor(asOf/DAY)*DAY){var eventDistance=businessDays(Math.floor(asOf/DAY)*DAY,et,input.holidays);if(eventDistance!==null&&eventDistance<=2)gate('EARNINGS_NEAR','已知财报在未来0–2个工作日内，工程事件门暂停新多头候选。',{earningsDate:earningsDate,workingDays:eventDistance,calendarBasis:'UTC工作日/输入holidays，不证明交易所事件日历'});}}
    else warnings.push('缺少带日期的财报事件资料，事件风险未知；技术观察不构成企业投资批准。');
    var fundamental=assessFundamentals(input.fundamentals,input.asOf),score=scoreTechnical(m,horizon),eligible=gates.length===0&&score.score>=60;
    var stance=gates.length?'veto':score.score===null?'abstain':eligible?'research_candidate':'watch';
    var expertList=bookExperts(input,{indicators:m,fundamentals:fundamental,regime:regime,costs:costs,asOf:iso(asOf)},options);
    var levels=m?{support20:round(Math.min.apply(null,validation.bars.slice(-20).map(function(b){return b.low;}))),resistance20:round(Math.max.apply(null,validation.bars.slice(-20).map(function(b){return b.high;}))),support60:round(Math.min.apply(null,validation.bars.slice(-60).map(function(b){return b.low;}))),resistance60:round(Math.max.apply(null,validation.bars.slice(-60).map(function(b){return b.high;}))),atrReferenceLower:round(m.price-2*m.atr14),atrReferenceUpper:round(m.price+2*m.atr14),priceTargetsCalibrated:false,label:'已发生区间极值及±2ATR风险参考，非预测目标/自动止损，参数为工程默认。'}:null;
    var result={version:VERSION,symbol:input.symbol||null,asOf:iso(asOf),horizonDays:horizon,horizonLabel:horizon+'个交易日技术机会研究',analysisKind:'uncalibrated_technical_research',probability:null,validation:validation,indicators:m,fundamentals:fundamental,regime:regime,gates:gates,score:score.score,rankingScore:score.score,scoreLabel:score.label,scoreComponents:score.components,scoreCalibrated:false,eligible:eligible,strongConclusionAllowed:false,stance:stance,stanceLabel:{veto:'硬门否决',abstain:'资料不足，弃权',research_candidate:'技术候选研究',watch:'观察，不入候选'}[stance],decision:{technicalOpportunity:eligible,eligible:eligible,executionAllowed:false,reason:gates.length?gates.map(function(g){return g.reason;}).join('；'):eligible?'仅进入未经校准的技术候选研究，投资价值与下单条件尚未成立。':'排序不足60，工程筛选暂观察。'},levels:levels,bookExperts:expertList,customModels:[{id:'modern_technical',name:'现代技术排序模型',isBookExpert:false},{id:'independent_risk',name:'独立风险质疑者',isBookExpert:false}],costs:costs,warnings:warnings,limitations:LIMITATIONS.slice(),dataQuality:{source:input.source||null,feed:input.feed||null,priceAsOf:validation.latestDate,quoteAsOf:quote&&quote.timestamp||null,quotePrice:quote&&finite(quote.price)?quote.price:null,quotePriceKind:quote&&quote.priceKind||'timestamped_quote_or_unknown',quoteDate:quote&&quote.asOfDate||null,usedForIndicators:'最后完整日线OHLCV，不混用quote实时价格',priceBasis:input.priceBasis||null,priceAdjustmentVerified:input.priceAdjustmentVerified===true?true:input.priceAdjustmentVerified===false?false:null,volumeBasis:input.volumeBasis||null,isRealtime:input.isRealtime===true,volumeAdjustmentVerified:input.volumeAdjustmentVerified===true,calendarVerified:validation.calendarVerified},snapshotFingerprint:fingerprint({symbol:input.symbol,asOf:input.asOf,bars:input.bars,quote:input.quote,fundamentals:input.fundamentals,benchmarks:input.benchmarks,marketState:input.marketState})};
    result.debate=debate(result);
    result.agentLogs=expertList.filter(function(b){return b.knowledgeStatus!=='pending_full_text';}).map(function(b){return {expertId:b.id,method:'确定性资料/时间尺度/原意边界检查，未调用独立LLM',status:b.status,ruleResults:b.rules,sourceAnchors:b.evidence,contributesToScore:false,directionalVote:null};});
    return result;
  }
  function correlationPair(a,b){
    if(!a||!b||!a.validation.valid||!b.validation.valid)return {valid:false,coefficient:null,reason:'缺有效股票日线。'};
    var aa=a.validation.bars.slice(-61),bb=b.validation.bars.slice(-61);
    if(aa.length!==61||bb.length!==61||aa.some(function(x,i){return x.date!==bb[i].date;}))return {valid:false,coefficient:null,reason:'60日收益的61个价格session不完全同步。'};
    var x=[],y=[];
    for(var i=1;i<61;i++){x.push(Math.log(aa[i].close/aa[i-1].close));y.push(Math.log(bb[i].close/bb[i-1].close));}
    var mx=x.reduce(function(s,v){return s+v;},0)/60,my=y.reduce(function(s,v){return s+v;},0)/60,xx=0,yy=0,xy=0;
    for(var j=0;j<60;j++){xx+=(x[j]-mx)*(x[j]-mx);yy+=(y[j]-my)*(y[j]-my);xy+=(x[j]-mx)*(y[j]-my);}
    if(xx<1e-20||yy<1e-20)return {valid:false,coefficient:null,reason:'至少一组收益方差近零，相关系数未定义。'};
    return {valid:true,coefficient:round(clamp(xy/Math.sqrt(xx*yy),-1,1),6),count:60,startDate:aa[0].date,endDate:aa[60].date,method:'同步60个日对数收益Pearson相关；未证明未来分散效果'};
  }
  function researchShortlist(ranked,snapshot){
    var selected=[],excluded=[],pairs=[],counts={},unknownSectors=[];
    var entries=Array.isArray(snapshot.universe)?snapshot.universe:snapshot.universe&&Array.isArray(snapshot.universe.stocks)?snapshot.universe.stocks:[];
    function sector(symbol){var s=(snapshot.stocks||{})[symbol]||{},entry=entries.find(function(e){return e&&typeof e==='object'&&e.symbol===symbol;});var f=s.fundamentals||{};return s.sector||f.sector||entry&&entry.sector||null;}
    ranked.forEach(function(r){
      var group=sector(r.symbol),reject=null;
      if(selected.length>=10)reject={code:'SHORTLIST_MAX10',reason:'研究清单最多10只；并未按个人风险预算配置。'};
      else if(group&&counts[group]>=2)reject={code:'SECTOR_CAP',reason:'已知行业'+group+'已有2只；工程研究上限。'};
      if(!reject){for(var i=0;i<selected.length;i++){var p=correlationPair(r,selected[i]);pairs.push(Object.assign({symbol:r.symbol,withSymbol:selected[i].symbol},p));if(!p.valid){reject={code:'CORRELATION_UNAVAILABLE',reason:p.reason,withSymbol:selected[i].symbol};break;}if(p.coefficient>0.85){reject={code:'CORRELATION_CAP',reason:'同步60日收益相关系数大于0.85，避免重复纳入；工程阈值未经校准。',withSymbol:selected[i].symbol,correlation:p.coefficient};break;}}}
      if(reject)excluded.push(Object.assign({symbol:r.symbol},reject));
      else{selected.push(r);if(group)counts[group]=(counts[group]||0)+1;else unknownSectors.push(r.symbol);}
    });
    return {diversifiedShortlist:selected,selectionExclusions:excluded,correlationInputs:{windowTradingDays:60,priceObservations:61,maxCorrelation:0.85,industryCap:2,maxCount:10,pairs:pairs,knownSectorCounts:counts,unknownSectorSymbols:unknownSectors,industryCoverageVerified:unknownSectors.length===0,thresholdOrigin:METHODS,label:'额外分散研究过滤，保留原ranked/eligible；不是最优组合、仓位或交易建议，行业资料未知时无法验证行业分散。'}};
  }
  function rankUniverse(snapshot,options){
    snapshot=snapshot||{};options=Object.assign({horizonDays:5},options||{});
    var raw=Array.isArray(snapshot.universe)?snapshot.universe:snapshot.universe&&Array.isArray(snapshot.universe.stocks)?snapshot.universe.stocks:Object.keys(snapshot.stocks||{}).filter(function(s){return ['SPY','QQQ','IWM','VIX','DJI','DJT','^VIX','^DJI','^DJT'].indexOf(s.toUpperCase())<0;}),symbols=[],duplicates=[];
    raw.forEach(function(s){var symbol=typeof s==='string'?s:s&&s.symbol;if(typeof symbol==='string'){symbol=symbol.toUpperCase();if(symbols.indexOf(symbol)>=0)duplicates.push(symbol);else symbols.push(symbol);}});
    var results=symbols.map(function(symbol){return analyze(snapshot,Object.assign({},options,{symbol:symbol}));});
    var ranked=results.filter(function(r){return r.eligible;}).sort(function(a,b){return b.score-a.score||a.symbol.localeCompare(b.symbol);});
    ranked.forEach(function(r,i){r.rank=i+1;});
    return Object.assign({version:VERSION,asOf:results.length?results[0].asOf:iso(stamp(options.asOf||snapshot.capturedAt||snapshot.generatedAt)),horizonDays:options.horizonDays,results:results,ranked:ranked,summary:{total:results.length,valid:results.filter(function(r){return r.validation.valid;}).length,eligible:ranked.length,vetoed:results.filter(function(r){return r.stance==='veto';}).length,notEligible:results.length-ranked.length,groundedBooks:3,pendingBooks:37,bookVotesCombined:false,duplicatesRemoved:duplicates},limitations:LIMITATIONS.concat(['当前universe来自输入，未证明历史成分；不能以当前大盘股名单倒推历史普遍收益。'])},researchShortlist(ranked,snapshot));
  }
  function walkForward(bars,context,options){
    context=context||{};options=Object.assign({horizonDays:5},options||{});
    var horizon=options.horizonDays,costs=costModel(options),cutoff=options.asOf||context.asOf||iso(Date.now());
    var v=validateBars(bars,{asOf:cutoff,minBars:MIN_BARS+2,checkFreshness:false}),base={version:VERSION,available:false,status:'unavailable',reason:null,baseline:'固定long/cash技术基线：close>MA20且MA20>MA60、ATR%≤6、SPY/QQQ工程环境上行；下一session开盘执行',isBookExpertBacktest:false,probabilityCalibrated:false,train:null,holdout:null,metrics:null,trades:[],path:[],costs:costs,assumptions:['参数固定，训练段不搜索/优化；留出只用于报告，不再训练。','信号日只用该日及之前的stock和benchmark资料，下一session开盘进入。','持有指定5/20根日线后收盘退出；交易不重叠，两端均扣假设单边成本。','不重用今天财务、消息或机构资料；仅回测技术基线。'],limitations:LIMITATIONS.concat(['单只证券的当前可用历史；没有历史universe、退市证券、组合暴露或供应商当时版本。','未把原书作者叙述或三个知识档案自动编码成可回测策略。','信号日close在当天收盘后才可知，交易在下一session；实际缺口、停牌和高冲击仍可能不同。','持仓内路径每日盯市；持有期收益到退出日才可观察。无交易不能推算胜率。'])};
    if(!v.valid){base.reason='输入日线非法或不足。';base.validation=v;return base;}
    if(stamp(cutoff)>Date.now()+60000){base.reason='截止时间在未来，不能把未发生市场当已实现留出。';return base;}
    if(context.priceBasis==='raw_unadjusted_or_unknown_ohlcv'||context.priceAdjustmentVerified===false){base.reason='目标股票历史公司行为口径明确未验证；允许原价观察，不报告不可比较的回测性能。';base.priceBasis=context.priceBasis||null;base.priceAdjustmentVerified=false;return base;}
    if(horizon!==5&&horizon!==20){base.reason='仅接受5/20交易日。';return base;}
    if(!costs.valid){base.reason='成本假设无效。';return base;}
    var split=options.trainBars===undefined?Math.max(MIN_BARS,Math.floor(v.count*0.7)):options.trainBars;
    if(!Number.isInteger(split)||split<MIN_BARS||split+horizon+1>v.count){base.reason='留出段不足以完成至少一笔指定持有期交易；训练至少210根。';return base;}
    base.priceBasis=context.priceBasis||'未提供，输入历史价格口径未知';base.adjustment=context.adjustment||null;base.historySource=context.source||null;base.returnBasis='历史输入价格比值的费用后基线；可能含供应商股息调整，未独立记账现金股息、拆股份额或逐笔实际成交';
    base.train={count:split,startDate:v.bars[0].date,endDate:v.bars[split-1].date,optimized:false};
    base.holdout={count:v.count-split,startDate:v.bars[split].date,endDate:v.bars[v.count-1].date,horizonDays:horizon,universePointInTime:false};
    var equity=1,peak=1,maxDrawdown=0,oneway=costs.oneWayBps/10000,skipped={noSignal:0,missingBenchmark:0,stockNotYetAvailable:0,insufficientFutureHoldingPeriod:0},path=[];
    var bhEntry=v.bars[split],bhExit=v.bars[v.count-1],bhPeak=1,bhDD=0;
    for(var bh=split;bh<v.count;bh++){var bhe=v.bars[bh].close/bhEntry.open/(1+oneway);if(bh===v.count-1)bhe*=1-oneway;bhPeak=Math.max(bhPeak,bhe);bhDD=Math.max(bhDD,1-bhe/bhPeak);}
    base.buyAndHold={entryDate:bhEntry.date,exitDate:bhExit.date,entryPrice:bhEntry.open,exitPrice:bhExit.close,netReturnPct:round(100*(bhExit.close/bhEntry.open*(1-oneway)/(1+oneway)-1)),grossReturnPct:round(100*(bhExit.close/bhEntry.open-1)),maxDrawdownPct:round(bhDD*100),costsChargedBothEnds:true,label:'同一留出首日开盘至末日收盘的买入持有，扣相同双端成本；不是原书策略'};
    function prefixContext(time){
      var out={asOf:iso(time+DAY-1),benchmarks:{},holidays:context.holidays};
      Object.keys(context.benchmarks||{}).forEach(function(key){var r=benchRecord(context,key);out.benchmarks[key]=Object.assign({},r,{bars:Array.isArray(r.bars)?r.bars.filter(function(b){var t=timeOf(b),a=b.availableAt===undefined?t:stamp(b.availableAt);return finite(t)&&t<=time&&finite(a)&&a<=time+DAY-1;}):r.bars});});
      return out;
    }
    for(var i=split-1;i<v.count-1;){
      var prefix=v.bars.slice(0,i+1),m=calc(prefix),ctx=prefixContext(v.bars[i].timestamp),reg=readRegime(ctx,{asOf:ctx.asOf,checkFreshness:true,maxStaleTradingDays:0,holidays:context.holidays});
      var stockKnown=bars.slice(0,i+1).every(function(raw){return raw.availableAt===undefined||stamp(raw.availableAt)<=v.bars[i].timestamp+DAY-1;});
      if(!stockKnown)skipped.stockNotYetAvailable++;
      var signal=stockKnown&&reg.id==='trend_up'&&m.price>m.sma20&&m.sma20>m.sma60&&m.atrPct<=6;
      if(!reg.valid)skipped.missingBenchmark++;
      if(!signal){skipped.noSignal++;i++;continue;}
      var entry=i+1,exit=entry+horizon-1;
      if(exit>=v.count){skipped.insufficientFutureHoldingPeriod++;break;}
      var entryPrice=v.bars[entry].open,exitPrice=v.bars[exit].close,starting=equity;
      for(var j=entry;j<=exit;j++){
        var interim=starting/(1+oneway)*v.bars[j].close/entryPrice;
        if(j===exit)interim*=1-oneway;
        peak=Math.max(peak,interim);maxDrawdown=Math.max(maxDrawdown,1-interim/peak);
        path.push({date:v.bars[j].date,equity:round(interim,8),position:1,signalDate:v.bars[i].date,knownAt:iso(v.bars[j].timestamp+DAY-1)});
      }
      equity=starting/(1+oneway)*exitPrice/entryPrice*(1-oneway);
      base.trades.push({signalDate:v.bars[i].date,entryDate:v.bars[entry].date,exitDate:v.bars[exit].date,entryPrice:entryPrice,exitPrice:exitPrice,horizonDays:horizon,grossReturnPct:round(100*(exitPrice/entryPrice-1)),netReturnPct:round(100*((exitPrice/entryPrice)*(1-oneway)/(1+oneway)-1)),roundTripCostModel:'买入现金/(1+c)，卖出收入×(1-c)',signalEvidence:{price:m.price,sma20:m.sma20,sma60:m.sma60,atrPct:m.atrPct,regime:reg.id},resultAvailableAfter:iso(v.bars[exit].timestamp+DAY-1)});
      i=exit+1;
    }
    base.available=true;base.status=base.trades.length?'completed':'no_trades';base.reason=base.trades.length?'完成固定技术基线留出观察；不是未来胜率。':'留出中没有满足条件的完整交易，不填收益或胜率。';
    base.path=path;base.skipped=skipped;
    if(base.trades.length){var wins=base.trades.filter(function(t){return t.netReturnPct>0;}).length;base.metrics={tradeCount:base.trades.length,netReturnPct:round(100*(equity-1)),maxDrawdownPct:round(100*maxDrawdown),positiveTradeFraction:round(wins/base.trades.length),positiveTradeFractionLabel:'本单只证券小样本留出中的正净收益比例，不是未来上涨概率',sampleTooSmall:base.trades.length<30,annualizedReturn:null};}
    base.isFullRankingStrategyBacktest=false;base.limitations.push('此固定20/60基线不等于当前完整评分、全部硬门或分散清单策略；该结果不能当整套选股系统已通过回测。');
    return base;
  }
  return {version:VERSION,analyze:analyze,rankUniverse:rankUniverse,validateBars:validateBars,indicators:indicators,readRegime:readRegime,walkForward:walkForward,bookRuleEvidenceScope:'v2已深读档案的有边界语义；未证明现代预测有效'};
}));
