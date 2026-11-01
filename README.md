# dsh-style-memory

> GitHub: https://github.com/ymz001130/dsh-style-memory

DeepSeek Harness 的个人风格记忆插件。AI 出稿、你改稿；你的每一次修改被提炼成带置信度的风格规则，压进一张不超过 400 字的风格卡，下一个会话开始时自动注入系统提示。交付 Word、PPT 之前，AI 味偏重的稿子会先被拦下来，附上命中项和改法。

~~~text
出初稿 → 你改 → style_learn → 规则（含置信度）→ 风格卡（≤400 字）→ 新会话注入 → 交付前门禁
                                                                         └─ 没过 → 回到改写，再学一轮
~~~

## 解决什么

- 每个新会话模型都从默认腔调起步，写出来的是通用 AI 中文，不是你的中文。反复描述"别这么写"的成本，往往超过它省下的时间。
- 你手改过的稿子是最贴近真实偏好的样本，改完就沉进历史记录，没人提炼，下次照样从零开始。
- "像不像 AI"在交付前才发现，返工最贵，缺一个能量化、能重复的检查点。
- 风格偏好只活在当前上下文：换体裁、换会话、换子代理就丢。

装上之后：

| 之前 | 现在 |
|---|---|
| 每轮重复描述文风 | 会话开始自动注入风格卡 |
| 修改只影响这一篇 | 每次修订进档案，规则按证据累积 |
| 凭感觉判断 AI 味 | 0–100 分 + 命中问题 + 具体改法 |
| 交付前人工通读 | present 前自动检测，过线先拦 |
| 偏好只能写死在提示词 | 按体裁分桶，可查看、可回滚、可导出 |

设计依据、评分口径与验收标准见 [METHODOLOGY.md](METHODOLOGY.md)。

## 安装

前置条件：DSH 0.2.0-rc 及以上、0.3.0 以下（见 package.json 的 engines 要求），本机有桌面版自带的 dsh CLI。

脚本安装：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
~~~

手动用 CLI 安装（等价）：

~~~powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add .
~~~

两条路都是把本目录以链接方式加进 desktop profile。装完重启 DeepSeek Harness，插件管理页（设置 → 插件）显示「风格记忆 / Style Memory」（0.6.2）。首次使用不需要任何配置，数据目录在第一次写档案时自动创建，不要预先手建。

验证三件事：

1. 插件管理页能看到 0.6.2，能启停、能卸载。
2. 新会话里输入 /style，返回当前状态（默认即 status）。
3. 说"用 style_analyze 看一下这段……"能拿到分数与命中项。

## 使用

### 工具 style_analyze：打分与诊断

| 参数 | 类型 | 说明 |
|---|---|---|
| text | string，与 path 二选一 | 直接传待检测文本 |
| path | string，与 text 二选一 | 文件路径；纯文本、.md、.docx、.pptx 都可以，后两者只提取文字，不动格式 |
| genre | string，可选 | global / lecture / thesis / ppt / chat，决定用哪套规则与阈值，默认 global |
| detail | string，可选 | summary 只回分数、band、verdict 和主要问题；full 回全部命中项（类别、原因、改法、例句）、人类书写特征、命中个人规则、完整指标与改写建议 |

返回内容：

- score：0–100 的 AI 特征分，越高越像 AI 生成。
- band / verdict：档位与一句话结论。档位分四段：human 0–34（像人写的）、mixed 35–59（混合/待改）、ai_clear 60–79（明显 AI 腔，门禁线以上）、ai_heavy 80–100（高度 AI 腔）。
- top_issues：命中问题清单（summary 给前 8 条），每条带 category、label、severity、count、why、fix、samples，能直接照着改；detail 为 full 时换成 all_issues 给全量。
- human_features：检出的、倾向人类书写的特征。
- rule_hits：命中了哪几条你的个人规则，带置信度。
- suggestions：去重后的改写建议。
- profile：这次用的是哪版档案、哪个体裁、多少条生效规则。
- detail 为 full 时另给 metrics（全部指标）与 personal_deviation（相对你个人基线的偏离）。

会话里直接说：

> 用 style_analyze 看 D:\work\draft.md，genre thesis，detail full

### 工具 style_learn：从改前改后学习

| 参数 | 类型 | 说明 |
|---|---|---|
| original_text / original_path | 二选一 | AI 初稿，文本或路径 |
| revised_text / revised_path | 二选一 | 你改完的定稿，文本或路径 |
| genre | string，可选 | 学到的东西归到哪个体裁桶 |
| note | string，可选 | 你自己的一句话说明，例如"别用'值得注意的是'开头""段落别硬凑三段"；随这次学习一起记进学习历史 |

返回内容：

- added / updated / promoted / removed：新增、更新、转正、淘汰的规则数。
- top_proposals：本次识别到的候选规则，带类型、原句、改法、证据次数。
- stats / deltas：改动统计与逐项指标变化（句长、段落、标点、连接词等）。
- metrics_updated：被更新的个人指标区间个数。
- 画像卡预览与档案版本：学完之后风格卡长什么样、写入的是哪一版，供 /style undo 回滚。

规则分九类：禁用表达、改写偏好、偏好表达、结构习惯、开场习惯、结尾习惯、术语偏好、口头表达、人味特征。置信度不到 0.62 的规则只在档案里标「待验证」，不进风格卡。

### 设置页（client.js）

0.5 起插件带一个浏览器端面板：会话右侧标签栏出现「风格记忆」页签，显示当前画像卡、生效/候选规则、学习记录、证据计数、门禁与注入状态。0.6.2 起面板按实际背景亮度自动选高对比配色，规则每条一块（类型、证据、置信度，示例可折叠），生效规则展开、待验证规则折叠；长文本强制换行，不做横向滚动。打开面板、窗口重新获得焦点、页面从后台切回前台时会自动拉一次最新数据，并显示上次刷新时间；也可以点「刷新」手动拉取。不做客户端定时轮询，也不引入 SSE。数据来自插件的只读 HTTP 路由 `/style-memory/data`，不提供写操作。

### 命令行自检 scripts/check.mjs

不想进会话也能给稿子打分（读当前档案与门禁线）：

~~~powershell
node scripts/check.mjs "D:\work\draft.docx" --genre thesis
node scripts/check.mjs "D:\work\稿件目录"
node scripts/check.mjs --text "要检查的一段话"
~~~

输出：AI 特征分、命中个人规则、主要问题、改法、人味特征、当前风格卡。

### 命令行学习 scripts/learn.mjs

不想进会话也能把一对修订稿喂给档案：

~~~powershell
node scripts/learn.mjs --original "D:\work\ai-draft.docx" --revised "D:\work\mine.docx" --genre lecture
~~~

规格与工具 style_learn 一致，默认写当前数据目录；`--home` 可指向临时目录做演练。

### 工具 style_profile：档案管理

| action | 作用 |
|---|---|
| view | 完整档案：规则、置信度、证据数、体裁分布、版本 |
| card | 当前生效的风格卡原文（≤400 字） |
| rules | 只看规则表，可按 genre 过滤 |
| history | 学习流水，一次一行 |
| undo | 回滚到上一个档案版本 |
| reset | 清空档案回到初始状态，必须带 confirm: true，否则拒绝执行 |
| export | 导出档案到 path（JSON） |
| import | 从 path 导入并与现有档案合并 |
| stats | 生效与待验证规则数、证据计数、按体裁分布 |
| consolidate | 立即做一次规则整合：去重、合并、过期归档 |

参数：genre 可选；path 只用于 export / import；confirm 只用于 reset。

### 命令 /style

| 子命令 | 作用 |
|---|---|
| status | 默认子命令。开关状态、档案版本、规则条数、最近一次学习时间 |
| on | 恢复全部介入：门禁、自动学习、会话注入 |
| off | 整体停用：present 不再拦截、不再自动学习、系统提示不再注入风格卡（手动工具仍可用） |
| card | 打印当前风格卡 |
| profile | 打印规则表，等价 style_profile action=rules |
| undo | 回滚到上一个档案版本 |
| consolidate | 立即整合规则（模型可用时由模型判断，否则本地合并） |
| reset confirm | 清空档案；不带 confirm 时只提示不执行 |

### 风格卡与会话注入

插件注册系统提示段 style-memory:profile，order 660。每个会话开始时注入一张不超过 400 字的风格卡：主代理拿完整版，子代理拿 200 字以内的精简版。0.2 起卡片抽象规则优先：只写高层要求（不写交代式元叙述、不替读者总结、删掉解释性补白、把书面腔改成短句直说），只留极短锚点，不罗列你改过的原句，避免模型把卡当模板逐字照搬。样本留在数据目录，需要时按路径查。

### present 门禁

present 交付 .docx / .pptx 之前（门禁默认只看这两种；config.json 的 gate.extensions 可加上 .md / .txt）：

1. 提取文本（标题、正文；.pptx 含幻灯片文字与备注）。
2. 用同一套检测器打分。
3. 分数低于 60：正常交付，不打扰。
4. 分数 ≥ 60：首次拦截，返回 band、命中问题和改法。不给你"大概还行"这种没法动手的反馈。
5. 改完再交付会重新扫描，分数比上一次下降就放行。
6. 同一个文件连续 3 次没降下来，写一条审计后放行——门禁不负责把人卡死。

/style off 整体停用插件介入（门禁、自动学习、会话注入都暂停，手动工具仍可用）。门禁只看走 present 的交付；在回复里直接贴正文不经过它。

## 工作流程

出初稿 → 你改 → 回传 → 学习 → 注入 → 交付检测，六个动作一个循环。

1. 出初稿时把体裁说清楚：thesis 论文/学术写作、lecture 讲稿讲课、ppt PPT/大纲、chat 日常对话、global 通用写作。体裁决定用哪套阈值与规则。
2. 你按自己的习惯改，改多改少都行，改动越密学到的信号越密。
3. 把两版回传：original_path 给初稿，revised_path 给定稿，可选 note 写一句你的意图。
4. style_learn 对齐两版，剔除纯内容改动，抽出风格差分，更新规则并写一个新档案版本，返回画像卡预览。
5. 下一个会话开始，系统提示自动带上新的风格卡，主代理完整、子代理精简。
6. 交付前 present 门禁再扫一遍。规则攒多了用 /style consolidate 整合，学歪了用 /style undo 回滚。

一次完整对话大致长这样：

~~~text
初稿在 D:\work\draft.md，我改完的在 D:\work\final.md。
用 style_learn 学一下：original_path 是 D:\work\draft.md，revised_path 是 D:\work\final.md，
genre 用 thesis，note：开头别铺垫，段落不要每段都收尾总结。
~~~

看完再查档案：

~~~text
/style status
/style card
~~~

攒了三五轮之后：

~~~text
/style consolidate
~~~

## 数据目录与隐私

默认目录：%USERPROFILE%\.dsh\style-memory\（一般就是 C:\Users\你的用户名\.dsh\style-memory\）。根目录跟随 DSH_HOME，设了就用它；调试时可用 DSH_STYLE_MEMORY_HOME 整体改道。

| 路径 | 内容 |
|---|---|
| config.json | 开关、门禁阈值与尝试次数、注入字数、保留策略、学习参数 |
| profile.json | 规则库、置信度与证据数、指标区间、文种画像、版本与学习历史 |
| snapshots\ | 交付与学习留下的纯文本快照（index.json 是索引，每份文本是 <id>.txt） |
| history\ | 学习、检测、门禁事件的流水 |
| versions\ | 每次档案变更的版本快照，供 undo |
| audit.ndjson | 审计行：门禁拦截与放行、学习、整合、导入导出、开关操作 |

保留策略：快照保留 90 天、最多 200 个，超限自动清理。清理前会用当前模型做一次 LLM 整合理顺规则——把零散规则合并成稳定的几条，再删旧快照，避免"快照删了知识也丢了"。模型不可用时退化为纯统计合并，规则照样保留。

隐私：

- 全部落在本地，插件本身不发任何网络请求。
- 唯一的模型调用是整合时通过宿主 ctx.llm 借用当前会话的模型，拿不到就跳过这一步。
- 快照是纯文本，不含图片、样式、批注、修订记录；.docx / .pptx 只提取文字。
- chat.enabled 默认开着时，插件会从你的会话消息里统计高频口头表达（只在本机算，原文只留高频短语），不需要就在 config.json 里关掉。
- config.json、profile.json、snapshots 均为明文，敏感内容宁可手动删。
- /style reset 清空档案；export 出来的同样是明文 JSON，带走前自己评估。

## 已知边界

- 分数是启发式集成分，不是第三方 AI 检测器的判决，也不是"能过检测"的承诺。
- 中文特征为主，英文靠功能词分布与 Delta 兜底；中英混排、方言口语的体裁分桶偏粗。
- 单对样本不够稳：新规则置信度起步很低，要重复出现才进风格卡。
- 规则会过拟合。你把破折号全删了，插件可能学成"禁用破折号"；语气、节奏这类深层特征需要更多样本。
- 门禁只覆盖走 present 的 .docx / .pptx（可在 config.json 的 gate.extensions 里加 .md / .txt）；直接在回复里贴正文、人工另存的文件都不在范围内。
- 风格卡硬上限 400 字，规则多了只能保留高分项，细节得用 style_profile action=rules 查。
- 默认阈值按中文通用样本定，个人差异可能很大。建议用你自己的历史真稿跑一次 scripts/calibrate.mjs 校准，免得正常的长句被当成 AI 味。
- 降低本插件的分数，不等于降低外部检测器的判定。两者没有因果等价关系。

## 与 dsh-strict-rules 共存

两个插件互不依赖，desktop profile 里各占一行，可以分别安装、启停、卸载。

分工：dsh-strict-rules 管流程纪律（先问后做、未答重问、交付前润色、边做边确认），dsh-style-memory 管输出文风。R3 要求交付前做一轮去 AI 痕迹润色，本插件的门禁把这条变成可测的数字：strict-rules 校验"内容确实变了"，style-memory 校验"变得像人写的"。

两个门禁都挂在 present 前，先后取决于插件加载顺序，任一拦截都生效。两边都有放行兜底——strict-rules 连续 4 次内容未变放行，本插件同一文件连续 3 次未过放行——不会互相锁死。

系统提示段各自独立：本插件用 style-memory:profile（order 660），strict-rules 用自己的规则段与提醒，互不覆盖。

都装了的话，推荐顺序：style_analyze 打分 → 按改法改写 → rules_mark_polished 登记 → present。两道门一起过。

## 更新

~~~powershell
powershell -ExecutionPolicy Bypass -File .\update.ps1
~~~

脚本做五件事：先把插件源码备份到 %USERPROFILE%\.dsh\local-plugins\（含时间戳 zip，防止源码目录被误删或同步冲突）；再 node --check 检查 index.js 以及 lib/、scripts/、test/ 下的 JS；有 test/ 就跑 node --test；检查 desktop profile 的链接还在不在；最后提示重启。代码改完不重启不生效，新会话才会注入新卡。

版本策略：加功能升次版本，修 bug 升补丁版本，变更记在 CHANGELOG.md。

## 文件结构

~~~text
index.js            插件入口（name / inject / apply）
cordis.patch.yml    bundle 层：把插件行插入 desktop profile
lib/                检测器、学习器、档案存储、门禁与命令实现
scripts/            calibrate.mjs 阈值校准，blind_eval.mjs 盲测验收
test/               node --test 单元与回归测试
locale/en.json      英文标题与描述
locale/zh.json      中文标题与描述
icon.svg            插件管理器图标
README.md           安装与使用
METHODOLOGY.md      方法论、评分与验收
CHANGELOG.md        版本记录
install.ps1         安装到 desktop profile
uninstall.ps1       卸载
update.ps1          语法检查、测试、重启提示
LICENSE             MIT
~~~

## 卸载

~~~powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
~~~

重启后插件不再加载，系统提示里也不再出现风格卡。数据目录默认保留，重装可以直接接着用。要连数据一起清：

~~~powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -PurgeData
~~~

也可以自己删 %USERPROFILE%\.dsh\style-memory\。
