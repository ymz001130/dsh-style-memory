/**
 * dsh-style-memory 静态常量：词表、模式规则、权重、默认配置、提示文本。
 *
 * 设计原则：
 * - 纯数据、零依赖，便于单元测试与调参；
 * - 词表与模式分「强信号 / 弱信号」两级，弱信号也要参与打分，但会被
 *   用户的个人基线（learn 出来的指标区间）中和，避免把正常书面语误判；
 * - 所有中文词条按「AI 腔」与「人味」两栏分开，检测时双向计入。
 */

export const PLUGIN_NAME = 'dsh-style-memory';
export const PLUGIN_LABEL = '风格记忆';
export const VERSION = '0.6.2';

/** 系统提示段名称与顺序：排在 dsh-strict-rules(650) 之后、工具指导(1000+)之前。 */
export const SECTION_NAME = 'style-memory:profile';
export const SECTION_ORDER = 660;

/** 文种画像。global 为总画像，其余按文种覆盖。 */
export const GENRES = ['global', 'lecture', 'thesis', 'ppt', 'chat'];
export const GENRE_LABELS = {
  global: '通用写作',
  lecture: '讲稿/讲课',
  thesis: '论文/学术写作',
  ppt: 'PPT/大纲',
  chat: '日常对话'
};

/** 0-100 分档位。 */
export const SCORE_BANDS = [
  { min: 80, band: 'ai_heavy', label: '高度 AI 腔' },
  { min: 60, band: 'ai_clear', label: '明显 AI 腔' },
  { min: 35, band: 'mixed', label: '混合/待改' },
  { min: 0, band: 'human', label: '像人写的' }
];

/** 默认配置。字段可在 $DSH_HOME/style-memory/config.json 覆盖。 */
export const DEFAULT_CONFIG = {
  enabled: true,
  inject: {
    enabled: true,
    maxChars: 400,
    subagentMaxChars: 200
  },
  detect: {
    gateThreshold: 60,
    weightedSumPart: 0.5,
    strongSignalPart: 0.3,
    majorityPart: 0.2
  },
  gate: {
    enabled: true,
    threshold: 60,
    maxAttempts: 3,
    failOpen: true,
    extensions: ['.docx', '.pptx']
  },
  learn: {
    autoPair: true,
    autoPairMinSimilarity: 0.35,
    minEvidence: 1,
    minConfidence: 0.62,
    maxTextChars: 200000,
    minSpanChars: 3,
    minChars: 60,
    maxRulesPerGenre: 400
  },
  chat: {
    enabled: true,
    minPhraseFrequency: 3,
    maxPhraseLen: 24,
    keepMessageStats: true
  },
  retention: {
    days: 90,
    maxSnapshots: 200,
    consolidateBeforeCleanup: true
  },
  consolidation: {
    enabled: true,
    everyLearns: 20
  }
};

/**
 * AI 腔强信号词条：命中即扣分，主观上几乎不会出现在自然中文里。
 * cat 用于归类展示；w 为单项权重（1-3）；fix 为改写建议。
 */
export const AI_STRONG_PHRASES = [
  { p: '值得注意的是', cat: 'meta', w: 2, fix: '直接说事，删掉这个开头' },
  { p: '需要指出的是', cat: 'meta', w: 2, fix: '删掉，直接给结论' },
  { p: '需要说明的是', cat: 'meta', w: 2, fix: '删掉，直接说明' },
  { p: '不可否认的是', cat: 'meta', w: 2, fix: '删掉这句让步' },
  { p: '毋庸置疑', cat: 'meta', w: 2, fix: '删掉，直接陈述' },
  { p: '众所周知', cat: 'meta', w: 2, fix: '删掉，给出具体出处或事实' },
  { p: '由此可见', cat: 'meta', w: 2, fix: '直接接结论，不必提示推理' },
  { p: '不难发现', cat: 'meta', w: 2, fix: '直接说发现了什么' },
  { p: '在一定程度上', cat: 'hedge', w: 1, fix: '要么给程度，要么删掉' },
  { p: '从某种意义上说', cat: 'hedge', w: 2, fix: '删掉，直接判断' },
  { p: '总而言之', cat: 'summary', w: 2, fix: '删掉结尾总结，停在具体事实上' },
  { p: '综上所述', cat: 'summary', w: 2, fix: '删掉，不要回音壁' },
  { p: '总的来说', cat: 'summary', w: 1, fix: '删掉，或换成具体结论' },
  { p: '归根结底', cat: 'summary', w: 1, fix: '删掉，直接说机制' },
  { p: '一言以蔽之', cat: 'summary', w: 3, fix: '删掉这种文绉绉的收束' },
  { p: '简而言之', cat: 'summary', w: 1, fix: '删掉，直接用短句说' },
  { p: '换言之', cat: 'meta', w: 1, fix: '删掉，直接说第二遍' },
  { p: '具体而言', cat: 'meta', w: 1, fix: '删掉，直接举例' },
  { p: '具体来说', cat: 'meta', w: 1, fix: '删掉，直接举例' },
  { p: '与此同时', cat: 'connector', w: 1, fix: '删掉显性连接词，让语义接力' },
  { p: '不可或缺', cat: 'emphasis', w: 2, fix: '删掉，说明缺了会怎样' },
  { p: '至关重要', cat: 'emphasis', w: 2, fix: '删掉，给具体后果' },
  { p: '具有重要的理论意义', cat: 'cliche', w: 3, fix: '删掉，给具体贡献' },
  { p: '具有重要的现实意义', cat: 'cliche', w: 3, fix: '删掉，给具体影响' },
  { p: '具有重要的指导意义', cat: 'cliche', w: 3, fix: '删掉，说指导了什么' },
  { p: '奠定了坚实的基础', cat: 'cliche', w: 2, fix: '删掉，说解决了哪一步' },
  { p: '提供了新的思路', cat: 'cliche', w: 2, fix: '删掉，说清思路是什么' },
  { p: '提供了有益的参考', cat: 'cliche', w: 2, fix: '删掉，说参考的具体内容' },
  { p: '起到了积极的推动作用', cat: 'cliche', w: 2, fix: '删掉，说推动了什么' },
  { p: '发挥了重要作用', cat: 'cliche', w: 2, fix: '删掉，说作用是什么' },
  { p: '在...的大背景下', cat: 'cliche', w: 2, fix: '删掉背景铺陈，直接从问题开始' },
  { p: '随着...的不断发展', cat: 'cliche', w: 3, fix: '删掉万能开头' },
  { p: '随着...的不断推进', cat: 'cliche', w: 3, fix: '删掉万能开头' },
  { p: '在这个快速发展的时代', cat: 'cliche', w: 3, fix: '删掉时代背景，直接说事' }
];

/**
 * AI 腔弱信号词/短语：单独出现不算错，密度高才是 AI 腔。
 * 检测时按每千字频次与用户基线比较。
 */
export const AI_WEAK_PHRASES = [
  { p: '此外', cat: 'connector', w: 0.5 },
  { p: '然而', cat: 'connector', w: 0.5 },
  { p: '因此', cat: 'connector', w: 0.5 },
  { p: '从而', cat: 'connector', w: 0.6 },
  { p: '进而', cat: 'connector', w: 0.6 },
  { p: '首先', cat: 'enumerate', w: 0.8 },
  { p: '其次', cat: 'enumerate', w: 0.8 },
  { p: '最后', cat: 'enumerate', w: 0.3 },
  { p: '再次', cat: 'enumerate', w: 0.8 },
  { p: '一方面', cat: 'enumerate', w: 0.8 },
  { p: '另一方面', cat: 'enumerate', w: 0.8 },
  { p: '有助于', cat: 'cliche', w: 0.8 },
  { p: '旨在', cat: 'cliche', w: 0.8 },
  { p: '以期', cat: 'cliche', w: 1.0 },
  { p: '显著', cat: 'emphasis', w: 0.7 },
  { p: '有效地', cat: 'emphasis', w: 0.8 },
  { p: '极大地', cat: 'emphasis', w: 0.8 },
  { p: '充分地', cat: 'emphasis', w: 0.8 },
  { p: '深入地', cat: 'emphasis', w: 0.8 },
  { p: '全面地', cat: 'emphasis', w: 0.6 },
  { p: '系统地', cat: 'emphasis', w: 0.6 },
  { p: '本质上', cat: 'emphasis', w: 0.8 },
  { p: '核心在于', cat: 'emphasis', w: 1.0 },
  { p: '关键在于', cat: 'emphasis', w: 0.8 },
  { p: '研究表明', cat: 'citation', w: 1.2 },
  { p: '研究发现', cat: 'citation', w: 1.0 },
  { p: '有学者指出', cat: 'citation', w: 1.2 },
  { p: '据调查显示', cat: 'citation', w: 1.2 },
  { p: '相关研究', cat: 'citation', w: 0.8 },
  { p: '学术界普遍认为', cat: 'citation', w: 1.5 },
  { p: '大量研究', cat: 'citation', w: 1.0 },
  { p: '众多研究', cat: 'citation', w: 1.0 },
  { p: '一系列', cat: 'precision', w: 0.6 },
  { p: '大量', cat: 'precision', w: 0.4 },
  { p: '众多', cat: 'precision', w: 0.6 },
  { p: '诸多', cat: 'precision', w: 0.6 },
  { p: '赋能', cat: 'jargon', w: 1.5 },
  { p: '助力', cat: 'jargon', w: 1.5 },
  { p: '抓手', cat: 'jargon', w: 2.0 },
  { p: '闭环', cat: 'jargon', w: 1.5 },
  { p: '颗粒度', cat: 'jargon', w: 2.0 },
  { p: '底层逻辑', cat: 'jargon', w: 2.0 },
  { p: '顶层设计', cat: 'jargon', w: 1.5 },
  { p: '生态位', cat: 'jargon', w: 1.8 },
  { p: '护城河', cat: 'jargon', w: 1.8 },
  { p: '降本增效', cat: 'jargon', w: 1.8 },
  { p: '沉淀', cat: 'jargon', w: 0.8 },
  { p: '打通', cat: 'jargon', w: 0.8 },
  { p: '对齐', cat: 'jargon', w: 0.5 },
  { p: '顶层', cat: 'jargon', w: 0.8 }
];

/**
 * 句法/篇章层模式。w 为命中一次的基础扣分权重，severity 用于展示排序。
 * 所有模式都必须能落到具体句子上，避免只给一个笼统分数。
 */
export const AI_PATTERNS = [
  {
    id: 'not-only-but-also',
    cat: 'parallel',
    w: 2,
    severity: 'high',
    re: /不仅[^。！？；\n]{0,50}(而且|更是|还)/g,
    why: '“不仅…而且/更是”是典型 AI 递进式排比',
    fix: '拆成两句事实陈述，或只保留后半句'
  },
  {
    id: 'not-just-but-more',
    cat: 'parallel',
    w: 2.5,
    severity: 'high',
    re: /不只是[^。！？；\n]{0,40}更是/g,
    why: '“不只是…更是”被公认为 AI 语言寄生虫',
    fix: '直接并列陈述，不做递进'
  },
  {
    id: 'both-and',
    cat: 'parallel',
    w: 1.5,
    severity: 'medium',
    re: /既[^。！？；\n]{0,40}又[^。！？；\n]{0,20}/g,
    why: '“既…又…”成对出现，像模板句',
    fix: '挑更重要的一面说，另一面另起一句'
  },
  {
    id: 'on-one-hand',
    cat: 'parallel',
    w: 1.5,
    severity: 'medium',
    re: /一方面[^。！？；\n]{0,80}另一方面/g,
    why: '“一方面…另一方面”是 AI 对称结构',
    fix: '改成两个具体判断，不必对称'
  },
  {
    id: 'firstly-secondly',
    cat: 'enumerate',
    w: 2,
    severity: 'high',
    re: /首先[^。！？；\n]{0,100}其次[^。！？；\n]{0,100}(再次|最后)?/g,
    why: '“首先/其次/最后”机械排比，是 AI 讲稿高频模板',
    fix: '改成自然衔接，或只保留一条线索'
  },
  {
    id: 'first-second',
    cat: 'enumerate',
    w: 2,
    severity: 'high',
    re: /第一[，、：][^。！？；\n]{0,100}第二[，、：]/g,
    why: '“第一/第二”机械枚举',
    fix: '换成自然过渡，或把并列项写成一句话'
  },
  {
    id: 'from-perspective',
    cat: 'meta',
    w: 1.2,
    severity: 'medium',
    re: /从[^。！？；\n]{1,15}(角度|视角|层面)(来看|看|出发)?/g,
    why: '“从…角度看”是 AI 万能过渡',
    fix: '删掉视角提示，直接说观察'
  },
  {
    id: 'in-aspect',
    cat: 'meta',
    w: 1.0,
    severity: 'low',
    re: /在[^。！？；\n]{1,15}方面/g,
    why: '“在…方面”绕弯子',
    fix: '直接说这件事本身'
  },
  {
    id: 'for-someone',
    cat: 'meta',
    w: 0.8,
    severity: 'low',
    re: /对于[^。！？；\n]{1,20}而言/g,
    why: '“对于…而言”是书面套话',
    fix: '直接做主语或状语'
  },
  {
    id: 'provide-reference',
    cat: 'cliche',
    w: 1.5,
    severity: 'medium',
    re: /为[^。！？；\n]{1,25}提供(了)?[^。！？；\n]{0,10}(参考|借鉴|依据|思路|方向|保障)/g,
    why: '“为…提供参考/借鉴”是 AI 结论句模板',
    fix: '说清楚提供了什么具体结论'
  },
  {
    id: 'important-meaning',
    cat: 'cliche',
    w: 2,
    severity: 'high',
    re: /具有[^。！？；\n]{0,15}(重要|关键|核心)[^。！？；\n]{0,8}(意义|价值|作用)/g,
    why: '“具有重要意义/价值”是没有信息量的评价',
    fix: '删掉评价，给出具体贡献或数据'
  },
  {
    id: 'essential-part',
    cat: 'cliche',
    w: 1.5,
    severity: 'medium',
    re: /(是|作为)[^。！？；\n]{0,20}的(重要|关键|核心|必要)(组成)?部分/g,
    why: '“是…的重要组成部分”是空话',
    fix: '说它具体做了什么'
  },
  {
    id: 'to-this-end',
    cat: 'cliche',
    w: 1.0,
    severity: 'low',
    re: /(旨在|以期|为了进一步)/g,
    why: '“旨在/以期”是公文式目的句',
    fix: '直接说做了什么'
  },
  {
    id: 'meta-chapter',
    cat: 'meta',
    w: 2.5,
    severity: 'high',
    re: /(本章将|本节将|本文将|接下来(我们)?(将|会)?(介绍|讨论|分析|阐述|展开))/g,
    why: '元叙述：告诉读者“我要讲什么”而不是直接讲',
    fix: '删掉，直接进入内容'
  },
  {
    id: 'let-us',
    cat: 'meta',
    w: 1.5,
    severity: 'medium',
    re: /让我们[^。！？；\n]{0,30}(来看|一起|思考|回顾)/g,
    why: '“让我们…”是 AI 讲稿的引导句',
    fix: '删掉，直接给内容'
  },
  {
    id: 'note-that',
    cat: 'meta',
    w: 2,
    severity: 'high',
    re: /(值得注意|需要指出|需要说明|需要强调)(的)?是/g,
    why: '“值得注意的是”是 AI 最典型的口头禅',
    fix: '删掉，直接说事'
  },
  {
    id: 'no-denying',
    cat: 'hedge',
    w: 2,
    severity: 'high',
    re: /(不可否认|毋庸置疑|毫无疑问|显而易见|不言而喻)/g,
    why: '“不可否认/毋庸置疑”是 AI 让步套话',
    fix: '删掉，直接陈述'
  },
  {
    id: 'summary-marker',
    cat: 'summary',
    w: 2.5,
    severity: 'high',
    re: /(综上所述|总而言之|总的来说|归根结底|一言以蔽之|简而言之|综上)/g,
    why: '总结癖：把前面的话再说一遍，形成回音壁',
    fix: '删掉总结，停在具体事实上'
  },
  {
    id: 'em-dash-chain',
    cat: 'punctuation',
    w: 1.2,
    severity: 'medium',
    re: /——[^。！？；\n]{1,40}——/g,
    why: '连续破折号是 AI 中文写作的标点签名',
    fix: '改成逗号分句或直接陈述'
  },
  {
    id: 'colon-list',
    cat: 'punctuation',
    w: 1.2,
    severity: 'medium',
    re: /[^。！？；\n]{6,}：(?=\s*(第[一二三四五六七八九十]|[0-9]{1,2}[.、)）]|[①-⑳]|[-*•]|[（(]?[一二三四五六七八九十]+[)）、]))/g,
    why: '冒号引出编号列表/分点是 AI 的高频结构',
    fix: '改成自然叙述，或把冒号换成句号'
  },
  {
    id: 'generic-evidence',
    cat: 'citation',
    w: 1.5,
    severity: 'medium',
    re: /(研究表明|研究发现|有学者指出|据调查显示|相关研究显示|学术界普遍认为|大量研究表明)/g,
    why: '泛化引用：没有具体出处的研究结论',
    fix: '补上作者/年份/期刊，或删掉'
  },
  {
    id: 'empty-claim',
    cat: 'emphasis',
    w: 1.5,
    severity: 'medium',
    re: /(极大地|显著地|有效地|充分地|深入地|全面地|系统地)(提升|改善|促进|推动|提高|增强)/g,
    why: '空泛强化词，没有具体变化量',
    fix: '给数字、给对照，或删掉副词'
  },
  {
    id: 'meta-markers',
    cat: 'meta',
    w: 1.2,
    severity: 'medium',
    re: /(值得一提的是|回到|前面提到|如前所述|正如前文|上一节|下一节|本节|本章|本文)/g,
    why: '元叙述：文章在讲自己而不是讲内容',
    fix: '删掉，直接进入内容'
  },
  {
    id: 'not-x-but-y',
    cat: 'parallel',
    w: 1.8,
    severity: 'high',
    re: /不是[^。！？；\n]{1,25}[，,](?:而是|是)/g,
    why: '「不是…而是…」对立句是 AI 爱用的修辞模板',
    fix: '改成两句具体陈述，或只留结论，不要用对立排比'
  },
  {
    id: 'rhetorical-close',
    cat: 'meta',
    w: 1.5,
    severity: 'high',
    re: /(神奇的是|有趣的是|我们注意到|这提示我们|这是不是说明|是不是说|说明了什么|这告诉我们)/g,
    why: '「神奇的是/我们注意到/是不是说…呢」是 AI 汇报腔的反问式收束',
    fix: '直接陈述事实，不要自问自答，也不要替读者惊叹'
  },
  {
    id: 'agenda-preview',
    cat: 'meta',
    w: 0.8,
    severity: 'low',
    re: /(我会从[^。！？；\n]{1,15}(说起|入手|开始)|接下来(介绍|讲|说)|先介绍|再介绍|最后(介绍|总结))/g,
    why: '预告议程/路线图是 AI 讲稿的开场习惯',
    fix: '删掉预告，直接进入内容'
  },
  {
    id: 'final-judgement',
    cat: 'emphasis',
    w: 1.4,
    severity: 'medium',
    re: /(说到底|底层逻辑|最考验的是|真正的[^。！？；\n]{1,8}是|更重要的[^。！？；\n]{0,6}是)/g,
    why: '总结式判断句，常用来替读者拔高，是 AI 收束习惯',
    fix: '删掉判断，停在前面的具体事上'
  }
];

/**
 * 人类书写特征（正向信号）。命中越多，越不像 AI，评分时用于抵消。
 * 注意：这些特征是提示性的，不是“人类证明”，避免绝对化。
 */
export const HUMAN_FEATURES = [
  { id: 'colloquial', cat: 'tone', label: '口语化表达', re: /(其实|说白了|你看|咱们|咱们|咱|挺|老是|反正|怎么说呢|说实话|实话说|不瞒你说|你懂的)/g, w: 1.5 },
  { id: 'modality', cat: 'tone', label: '语气词', re: /(嘛|呗|呀|啊|呢|吧|哦|唉|哎)[。！？，,]\s*/g, w: 1.0 },
  { id: 'first-person', cat: 'person', label: '第一人称叙述', re: /(我|我们)(在|跟|给|看|见|说|讲|做|想|觉得|遇到|发现)/g, w: 0.8 },
  { id: 'specific-number', cat: 'evidence', label: '具体数字', re: /\d+(\.\d+)?\s*(例|人|岁|天|周|月|年|cm|mm|%|分|次|页|字)/g, w: 1.2 },
  { id: 'direct-quote', cat: 'evidence', label: '直接引语', re: /“[^”]{4,}”/g, w: 0.8 },
  { id: 'example', cat: 'evidence', label: '具体举例', re: /(比如|例如|举个例子|就像|比如说)/g, w: 0.8 },
  { id: 'short-sentence', cat: 'rhythm', label: '短句穿插', re: null, w: 1.0 },
  { id: 'question', cat: 'tone', label: '直接设问', re: /[？?]/g, w: 0.5 },
  { id: 'dialect', cat: 'tone', label: '方言/口语词', re: /(得劲|甭|咋|啥|啥时候|整|弄|搁|忒|贼)/g, w: 1.5 },
  { id: 'hedge-real', cat: 'tone', label: '真实不确定表达', re: /(可能|也许|大概|不好说|说不准|不一定|看情况|我个人)/g, w: 0.6 },
  { id: 'narrative', cat: 'structure', label: '具体场景叙述', re: /(有一次|那天|后来|当时|那天门诊|上门诊|门诊上|病房里|记得)/g, w: 1.2 }
];

/** 指标名与中文标签（检测结果展示用）。 */
export const METRIC_LABELS = {
  chars: '总字数',
  sentences: '句子数',
  meanLen: '平均句长',
  stdLen: '句长标准差',
  cv: '句长变异系数',
  shortRatio: '短句占比(≤12字)',
  longRatio: '长句占比(≥35字)',
  colonDensity: '冒号密度(/千字)',
  dashDensity: '破折号密度(/千字)',
  semicolonDensity: '分号密度(/千字)',
  parenDensity: '括号密度(/千字)',
  quoteDensity: '引号密度(/千字)',
  questionDensity: '问号密度(/千字)',
  exclaimDensity: '感叹号密度(/千字)',
  connectiveDensity: '显性连接词密度(/千字)',
  paragraphMean: '平均段长',
  paragraphCv: '段长变异系数',
  vocabularyRichness: '用字丰富度',
  listMarkerDensity: '列表标记密度(/千字)',
  parallelTriplets: '三项排比密度(/千字)',
  quoteRatio: '引语占比'
};

/** 提示与模板文本（保持简短，避免占用过多上下文）。 */
export const SECTION_HEADER = '## 用户写作风格档案（style-memory，自动学习）';

export const SECTION_FOOTER = '写正文或交付文档前先按上面的档案自检；按规则写，不要逐字照搬卡片里的示例句子。交付文档（present）时插件会检测 AI 特征，超过阈值会拦截一次并给诊断。需要时可用 style_analyze 分析与 style_learn 提交你的修订稿。';

export const TOOL_HINTS = '可用工具：style_analyze(分析文本/文件)、style_learn(提交原稿与修订稿学习)、style_profile(查看/回滚/整理档案)；命令 /style 查看状态。';

export const LEARN_NOTICE_PREFIX = '[风格记忆] ';

export const GATE_DENIAL_HEADER = '风格记忆·交付前检查：这份文档的 AI 特征分偏高，先按下面的诊断改一轮再交付。';
