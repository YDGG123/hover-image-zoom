# HoverVista 规则包

> 供 `HoverVista-5.9+` 使用：把「站点专属的图片地址变换规则」做成可更新数据。

**站点数：324　规则条数：673（全部在 `hd`）　`clean` 规则：0（原因见下）**

> 上表数字与 `index.json` 的 `stats` 同源，可用 `探针/hv-rulepack-guard.sh` 一键复算校验（签名/哈希/stats 三者一致才算绿）。
> ⚠️ 本文件里的手写清单**容易过期**，一切以 `index.json` 为准（原先此处手写了 24 站的表，早已与 327 域的现实脱节，故删除）。
> 2026-09-24 变更：**Turner 三站退役**（`tbs.com` / `tntdrama.com` / `trutv.com`，三域 301 到 Squarespace，旧规则无标的）⇒ 327→324 域；
> `cameo.com` 新增 `ps-cameo.com-3`（现形态 `cdn2.cameo.com/resizer/…`）⇒ +1 条；批量修掉 52 条「替换值吃掉扩展名分隔点」的规则 ⇒ 条数不变。

## 上线方式

把本目录整体推到仓库 `YDGG123/hover-image-zoom` 的 **`main` 分支 `rules/` 目录**即可：

```
https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/rules/index.json
https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/rules/<domain>.json
```

脚本里已写死这个地址，无需改动。

## 结构与字段

`index.json`：`{ pack, version, updatedAt, domains: [域名…] }`

`<domain>.json`：
```json
{
 "domain": "bilibili.com",
 "label": "哔哩哔哩",
 "note": "来源说明",
 "hd":   [ { "id": "r1", "name": "原图还原", "loop": false,
             "steps": [ ["正则pattern", "flags", "替换串"] ] } ],
 "clean": []
}
```

- `hd`：**顺序全跑**，把缩略图地址升级成原图（对应脚本 `upgradeImgUrl`）。
- `clean`：**命中即停**，清理背景图地址（对应 `cleanBgUrl`）。
- `steps` 用 `[pattern, flags, replace]` 三元组，由 `new RegExp(pattern, flags)` 编译。
- `match`（可选）：`new RegExp(match, 'i')`，用于限定规则的适用域名。
  ⚠️ **不写 `match` 的规则对任何 URL 都执行**（管线是 `if (r.match && !r.match.test(u)) continue;`），
  其作用域**完全**靠「按当前页面域名取对应规则文件」。所以只有两种写法是安全的：
  ① `pattern` 自己就钉了主机；② 显式写 `match`。**新增「匹配面很宽」的规则时必须同时加 `match`**，
  否则在该站页面上悬停**第三方主机的图**也会被这条规则改写。
  守卫：`探针/hv-rulepack-generic.mjs`（外来主机暴露面必须为 0）＋ `探针/hv-rulepack-match-guard.mjs`（补的 `match` 不许掐死本站形态）。
  **现存 660 条无 `match` 规则已于 2026-09-24 全部结案**（见下）——不必再逐条补 `match`。
- JSON 必须是**标准 JSON**（键名要加引号）。

### 660 条无 `match` 规则：已全部结案，不需要补（2026-09-24）

**结论：不批量补 `match`。** 660 条全部落进「结构上不可能图裂」或「最坏白跑一次探测」两类，一条不剩。
唯一会**图裂**的类别是「`replace` 把主机改掉」（产出指向别家主机），实测 **0 条**。

第四闸 `探针/hv-rulepack-generic.mjs` 的分桶（自证：六桶求和 == 考察对象 660）：

| 桶 | 条数 | 性质 |
|---|---:|---|
| ★ 真实暴露（**改掉主机** ⇒ 图裂） | **0** | — |
| ⚠️ 主机未变·只改路径/query | 4 | 外来主机上前提是 404 ⇒ 被在线 `probeCandidates` 淘汰 |
| ⚠️ 路径型（pattern 不含 `//`，只约束路径） | 37 | 同上，主机不变 |
| ✅ `pattern` 已钉主机（结构上不可能命中外来主机） | 561 | 主判据：`//` 之后、第一个**括号深度 0 的 `/`** 之前出现 `\.<TLD>` |
| ✅ 对外来主机不命中（样本实测） | 58 | — |
| ⚠️ 样本不可用（未下结论） | **0** | 已由「钉主机」判据 + 生成器/替换器修复收敛 |

为什么**不补**：补 `match` 必须知道每站的**图域**，猜错即「**掐死本站能力**」（正是第五闸专防的那类静默失效）；
而收益 = 消除一个**用户无感**的空探测（改错尺寸的候选会被在线探测淘汰，且被 `pickBestCandidate(…, minPx=源图长边)` 的反负升级闸门兜住）。
**代价高、收益为零，故不动。** 交叉复核装置：`探针/hv-rulepack-rephost-scan.mjs`（纯静态，不依赖样本生成）——
它按「`rep` 是否硬编码主机 ∧ `pattern` 是否钉主机」独立复算，同样给出 **0**。

> ⚠️ 别再手工补：真要纵深防御，只对**已钉主机**的规则补同主机 `match`（**零能力损失**）才有意义；
> 「主机未变」的那 41 条必须先逐站真机取到图域才谈得上补。

### `clean` 为什么恒为空数组（2026-09-24 查明）

**结论：设计如此，不是漏搬。** 包内全部域都 `"clean": []`，根因是**抽取器只实现了 `hd` 一侧**：

- `HoverVista-测试/历史用例/规则包/extract-photoshow.js` 行 **175** 里 `clean` 是**写死的空数组**
  （`const out = { domain, label, adaptedFrom, note, hd, clean: [] }`）——它只搬竞品 `srcRegExp`/`processor`（= 高清链）。
- 因此「背景图地址净化」在包层**零覆盖**，实际全靠脚本内置净化链 `URL_RULES` 兜底
  （只有 2 条：`alicdn` + 一条 `match:null` 的宽兜底 `generic`）。

**为何不删这个字段**：脚本侧 `rebuildEffectiveRules()` **确实消费** `entry.clean`（`const extraClean = (entry.clean || []).map(…)`），
`rulepack-sign.js` / `rulepack-sweep.js` 也都在统计与校验它 —— 这是**已实现的能力**，只是**数据源暂未提供**。
删字段只能省几十字节，却要改全部域文件 + 重签 + 升版本；而"误导"问题一行文档即可解决 ⇒ **保留字段**。

**将来真要发 `clean` 规则时的落地路径**：① 扩充抽取器（新增 clean 侧数据源）→ ② 逐域填 `clean` →
③ `探针/hv-rulepack-guard.sh` 五闸自动覆盖（签名/哈希/集成/暴露面/反向）。
`match` 对 `clean` 同样必需 —— 净化链是**命中即停**，一条过宽的 clean 规则会把不相关的背景图 URL 改坏。

## 三档优先级

**用户自定义规则 > 规则包（本站）> 内置规则**，由脚本的 `rebuildEffectiveRules()` 合并。

## 安全约束（脚本侧已强制）

- 远端**只提供数据**，不执行任何代码；
- 单条规则最多 60 步；正则编译失败即丢弃该步；结构非法整条丢弃；
- 拉取失败 / JSON 非法 / 网络不通 → **保留现状**，静默降级到本地缓存或内置规则。

## 怎么判断规则在当前网站生效了

面板「**图片地址规则**」区顶部状态条会直接告诉你：

```
example.com：生效 6 条规则（自定义 0 / 规则包 1 / 内置 5）
✅ 最近一次实际命中【原图还原】  …/thumb.jpg  →  …/raw.jpg  |  规则包为本站提供：示例站
```

- 「最近一次实际命中」记录的是**真实解析图片地址时**发生的变化（规则名 + 前后地址）；
  面板里的测试框**不会**污染它。
- 预览图上出现「**原图**」标记，也表示这一张确实升级成功了。

## 文档

- `VALIDATION.md` —— **实测验证报告**（各站命中率与核对结果，改规则前先看）
- `index.json` 的 `stats` —— 逐域 `{clean, hd}` 条数（**唯一权威的收录清单**）

## 收录站点

收录 **324** 个域，完整清单与逐域规则数见 `index.json` 的 `domains` / `stats`
（本地可用 `探针/hv-rulepack-gate.mjs` 离线复算每个域的 SHA-256 与条数）。
本文件**不再手写站点表** —— 手写表会随包增长而失真（此前那版写着 24 站，实际早已 320+ 域）。

## 来源与改编说明（重要）

- **第一梯队（实测手写）**：`douban.com` / `zhihu.com` / `taobao.com` / `1688.com` 的尺寸规则，
  用真实浏览器取样后写，还原结果已逐条核对。
- **第二梯队（改编自竞品）**：其余站点，改编自竞品 **PhotoShow 4.92.2** 的 `sites/*.js`。
  按「可借鉴、不照搬」处理：**只取字符串型 `processor`，函数型一律未采用**（不做代码搬运）；
  PhotoShow 的 `@IMG@` 占位符已展开为标准扩展名集合 `(?:jpe?g|png|webp|gif|bmp|avif)`。
- 未逐条核对的规则请以 `VALIDATION.md` 的分站结论为准。

## 贡献新规则

1. 在目标网站用脚本面板「图片地址规则」区调好正则（**即时测试框**可直接看效果）；
2. 点「📤 导出为可提交的规则包片段」，得到 `<domain>.json` 的 JSON；
3. 提交 PR 或 Issue 即可。
