# companion-one 功能总览（2026-11-09）

> 这份是「有什么、怎么配合、别打架」的地图；操作与排障看 `companion-one-交接.md`。

## 一、七个子系统

| 子系统 | 代码 | 干什么 | 什么时候动 |
|---|---|---|---|
| 上下文压缩 | `lib/acp.js` | compress / decompress / search_context / acp_status；surface replace 折叠历史，原文归档可回溯 | 压力 ≥45/75/95% 分级提示；模型主动调 |
| 七层记忆 | `lib/db.js` `lib/memory.js` | soul/user/project/fact/lesson/topic/rules；去重合并、事实键失效、FTS5+LIKE 检索 | 首轮快照、每轮关键词命中、压缩后重注入 |
| 陪伴行为 | `lib/companion.js` | scope 隔离、valid_until 过期、惦记的事（每日≤1）、危机 0–5 级 | 每轮真实用户消息 |
| 沟通风格 | `lib/style.js` | 句长/直接度/emoji/术语/标点五维，独立表 | 每轮学一次，注入限 90 token |
| 可塑人格 | `lib/persona.js` | reaction/chain/narrative 三表 + 四阀门 + ⑤ 区表达调音 | turn/end 复盘、生成前注入一次 |
| 面板 | `client.js` | 9 个页签 + 原生侧栏「陪伴速览」 | 用户操作 |
| 协作视图 | `lib/collab.js` | 探测大肥鱼 / 鱼记忆装没装、版本、条数；内嵌它们自己的页面 | 打开「协作」页时 |

## 二、工具（13 个）

**记忆**：`memory_add` `memory_search` `memory_update` `memory_list` `memory_forget`
**压缩**：`compress` `decompress` `search_context` `acp_status`（被 billion-context 占用时整体让位，改用对方的）
**陪伴**：`followup`（惦记的事）、`heart_voice`（心声）
**人格**：`persona`（status/promote/rollback/freeze）、`style_card`

## 三、面板 9 个页签

概览（开关/状态）· 记忆（七层浏览搜索编辑）· **设定**（soul 层增删改，用户可直接写 AI 自我设定）· **学习**（B 站联网学习 + 投喂语料）· 压缩（压力/块/解压检索）· 惦记（到期清单）· 风格（五维卡片，可关）· 人格（叙事版本/阀门/回滚/冻结）· **协作**（大肥鱼 / 鱼记忆：装没装、版本、条数、内嵌它们自己的页面）

协作页是**只读探测**：只用 `profileDir()` 到当前 profile 的 `node_modules` 里读 `package.json`，数据条数复用 `lib/fish.js`、`lib/fishmem.js`；不 import 对方模块、不写对方的库，任何一边读崩只退化成「待安装 / 0」。

原生侧栏「陪伴速览」：心情 + 压力 + 心声 + 惦记 + 记忆数 + 压缩块。

## 四、每轮注入的三层（顺序即优先级）

1. **事实层**（按需）：首轮快照（≤300 token）／关键词命中（≤120）／压缩后重注入（≤300）／危机分寸／惦记提醒
2. **身份层**（每轮一次）：四阀门（≤110）+ ⑤ 区表达规则（≤170）+ 风格卡（≤90），三者合并后总预算 **260 token**
3. **反馈层**（仅当上一轮冒鱼味）：纠偏一句（≤60）

> 2026-11-09 优化：身份层从「每一步都注入」改成「每条用户消息只注入一次」，并合并成一段。

## 五、主动记忆的三种入口

| 入口 | 触发 | 落库位置 |
|---|---|---|
| 模型调 `memory_add` | 模型判断值得记 | 任意层 |
| 显式指令 | 用户说「记住…/别忘了…」 | fact（source=`auto:explicit`） |
| 保守抽取 | 用户说「我叫…/我住在…/我在…工作/我养了…/我对…过敏/我喜欢…/我不喜欢…」 | fact（source=`auto:pattern`，每轮最多 1 条） |

三条都走同一个 `remember()`：同层相近自动合并，fact 层同键新值让旧值失效（可回溯）。

## 六、不会打架的四条规矩

1. **压缩让位**：检测到 `compress/decompress/search_context/acp_status/acp_cache` 任一已存在 → 压缩四件套整体不注册。
2. **重名加前缀**：其它工具名被占 → 注册成 `co_xxx`；再冲突就跳过并记日志，绝不抛穿。
3. **注入只加不改**：所有注入都是新增一条 `runtime-context` 消息，不改用户原文。
4. **插件噪音不算人话**：`source.kind` 非 user、或以 `[dsh-mnemon:` 这类固定前缀开头的文本，不参与心情/危机/风格学习。

## 七、配置项（apply 的 config）

```yaml
compression: true|false|'force'   # force = 即使别人占了也自己注册
memory: true
companion: true
style: true
persona: true
publicScene: false                # 公开场合收紧口癖
stableBudget: 260                 # 身份层每轮总预算（token）
firstTurnBudget: 300
hitBudget: 120
postCompactBudget: 300
windowTokens: 128000
autoCapture: true                 # 保守主动记忆
dbPath: ''                        # 默认 $DSH_HOME/companion-one/companion-one.db
```

## 八、数据表

`memory_{soul,user,project,fact,lesson,topic,rules}`、`memory_fts`、`compressed_blocks`、`compressed_messages`、`compressed_fts`、`follow_ups`、`style_card`、`persona_reaction`、`persona_chain`、`persona_narrative`、`heart_voice`、`session_state`、`kv`
