# 规则包实测验证报告

> 更新时间：2026-09-15（第二版，含补测站点）
> 方法：**真实浏览器渲染**目标站首页并滚动触发懒加载 → 收集页面上真实生效的图片地址
> （`img.currentSrc` + 背景图）→ 用本包规则跑一遍 → 统计命中并**人工核对还原结果是否正确**。

## 验证结果

| 站点 | 真实地址 | 命中 | 判定 |
|---|---:|---:|---|
| **bilibili.com** | 31 | 97% | ✅ `…@120w_120h_1c.avif` → 原图，正确 |
| **jd** | 351 | 100% | ✅ JD 的 CDN 路径格式统一，规则要求含 `jfs/`／`g*/`，中段插入 `n1/s9999x9999_` |
| **douban.com** | 65 | 高 | ✅ `/view/xxx/large/` → `/view/xxx/raw/`（第二版新写，已核对） |
| **zhihu.com** | 7 | 43% | ✅ 新增收录：`/80/v2-xxx_720w.png` → `v2-xxx.png`（已核对） |
| **taobao.com** | 137 | 45% | ✅ 第二版新增尺寸后缀规则，`…_580x580q90.jpg_.webp` → 真实文件（已核对） |
| **1688.com** | 取样偏少 | — | ✅ 与淘宝同款规则，用已记录的真实地址离线核对通过 |

**离线核对（6 个真实样本，6/6 全部给出正确原图地址）：**

```
1688   …cib.jpg_460x460q100.jpg_.webp   →  …cib.jpg
淘宝   …item_pic.png_580x580q90.jpg_.webp →  …item_pic.png
豆瓣   /view/group_topic/large/public/p745574088.jpg → /view/group_topic/raw/public/p745574088.jpg
豆瓣   /view/photo/s_ratio_poster/public/p2934946788.webp → /view/photo/raw/public/p2934946788.webp
知乎   pic2.zhimg.com/80/v2-xxx_720w.png → pic2.zhimg.com/v2-xxx.png
```

## 两组规则的来源（重要）

1. **第一梯队（按真实地址实测后手写）**：`douban.com`、`zhihu.com`、`taobao.com`、`1688.com`
   的尺寸后缀/尺寸段规则。这些是本次用真实浏览器取样后写的，已逐条核对。
2. **第二梯队（改编自竞品 PhotoShow 4.92.2）**：其余站点。**只取字符串型 processor，函数型一律未采用**，
   PhotoShow 的 `@IMG@` 占位符已展开为标准扩展名集合。
   ⚠️ 这部分**只验证过「能否命中」，未逐条核对还原结果是否可访问**。

## 怎么判断规则在当前网站生效了（脚本自带的办法）

打开面板 → 展开「**图片地址规则**」区，顶部状态条会直接告诉你：

```
127.0.0.1：生效 6 条规则（自定义 0 / 规则包 1 / 内置 5）
✅ 最近一次实际命中【测试变换】  …?w=3080  →  …?w=1200  |  规则包为本站提供：本地测试站
```

- 「**最近一次实际命中**」记录的是**真实解析图片地址时**发生的变化（规则名 + 前后地址），
  面板里的测试框不会污染它。
- 另外，预览图上出现「**原图**」标记时，说明这一张确实升级成功了。

## 未覆盖 / 待补

- `weibo.com` / `weibo.cn` / `xiaohongshu.com` 等需登录才能看到图，**未取样验证**。
- 部分站点规则来自竞品，未经逐条核对。
- 低覆盖站点优先修：taobao（非搜索页主图）、1688（重新取样）。

## 如何重新验证

用真实浏览器（不是 curl —— B站首页只抓到 1 个图片地址，1688 只抓到 8 个，curl 完全无效）
打开目标站、滚动几次，收集 `img.currentSrc` 后用包内规则跑一遍。脚本：`HoverVista-测试/历史用例/规则包/rulepack-validate.js`

---

## 第二版实测：可访问性核对（2026-09-15 14:30）

> 方法升级：不再只看"能否命中"，而是**在真实页面里加载还原后的地址**，比对尺寸是否更大。
> 这才是规则的最终判据——命中了但打不开 = 无效。

| 站点 | 取样 | 命中 | 更大可用 | 加载失败 | 判定 |
|---|---:|---:|---:|---:|---|
| douban.com | 40 | 40 | **39** | 1 | ✅ 270×381 → 1080×1517 |
| taobao.com | 40 | 36 | **36** | 0 | ✅ 580×580 → 800×800 |
| 1688.com | 40 | 6 | **6** | 0 | ✅ 460×460 → 1920×1920 |
| dgtle.com | 40 | 24 | 11 | 0 | ✅（13 张"没更大"=原图就那么大，无害） |
| bilibili.com | 31 | 30 | 1 | 0 | ✅（29 张"没更大"，多为已是原尺寸的 banner） |
| zhihu.com | 3 | 2 | 0 | 0 | ✅（原图与 720w 同尺寸，无害） |
| **duitang.com** | 30→40 | 27/40 | **26** | **0** | ✅ **修复后**（修复前 40/40 全失败） |

### 修复的规则 bug

**堆糖（duitang.com）**：竞品那条 `(.+\.(?:dtstatic|duitang)\.com/uploads/[^.]+).*((?:jpe?g|...)).*` → `$1$2`
会在扩展名前**丢掉一个点**（`mJNAf.thumb.200_0.png` → `mJNAfpng`），且贪婪 `.*` 在 `.jpg_webp`
这种双扩展名场景会抓错。**已重写为按真实形态的精确规则**：
`\.thumb\.\d+_\d+(?:_[a-z0-9]+)?\.(jpe?g|png|webp|gif|bmp|avif)(?:_webp)?$` → `.$1`
（修复前 40/40 全失败 → 修复后 26/27 更大可用）

**同构排查**：全包扫描"替换串 `$1$2` 且扩展名前无点"的模式，另修了 `taobao.com` / `1688.com`
各 1 处同构规则（`$1$2` → `$1.$2`）。其余命中项经核对捕获组内已含点，属误报。

### 结论

- **第一梯队规则（实测手写）全部有效**：豆瓣 / 知乎 / 淘宝 / 1688 / 堆糖
- **第二梯队（改编自竞品）**：B站、JD、dgtle 有效；堆糖已修复；其余未逐条核对
- 1 张豆瓣海报 raw 不存在 → 脚本会自动回落缩略图，**无害但有一次失败请求**

## 第二批：全量改编自 PhotoShow（v2026091504，2026-09-15）

- 来源：PhotoShow 4.92.2 `sites/` 共 410 站——字符串型 processor 可安全抽取 326 站，纯函数型 55 站不采用（不搬代码），无规则 29 站。
- 新增 **303 个站点文件 / 614 条规则**，全部通过「正则可编译 + 结构合法」校验（共 327 站 686 条）。
- 覆盖范围扩至国外站：pinterest、x.com/twitter、reddit、youtube、tumblr、unsplash、twitch、wikipedia/wikimedia 系列、steam、 imdb 类、电商（amazon 除外——函数型）等。
- **性质**：本批全部为第二梯队（改编自竞品、未逐站实测）。竞品规则可能随站点改版失效；规则只做「正则→替换」，命中后加载失败会自动回落原图，风险可控。
- 配套改动：`packDomainMatches` 支持「整段标签包含」匹配（jd / pinterest 等品牌式键名可命中 www.jd.com / pinterest.com）；此前 `jd.json`（domain "jd"）实际从未匹配过京东域名，此改动修复该隐患。

---

## 第三批：阿里系 CDN「去后缀」补全（v2026092401，2026-09-24）

> 背景：5.9.1 修「淘宝图不升级高清」时，能力只加进了**内置链**（`alicdn-orig`），
> **云端包没跟上**——`taobao.com` / `1688.com` 的 `*-alicdn-suffix` 只覆盖「带尺寸档」形态
> （`…_580x580q90.jpg_.webp`），**漏了详情页/天猫详情的「不带尺寸档」形态**（`…jpg_.webp`）。
> 后果：云端包对该形态候选为空，整条受益只能靠**内置兜底** ⇒ 「不改脚本版本也能改站点规则」
> 这个云端包的根本价值，在这一形态上失效。

### 改了什么

| 文件 | 规则 | 改动 |
|---|---|---|
| `taobao.com.json` | `tb-alicdn-suffix` | 单步 → 与内置 `ALICDN_SUFFIX_STEPS` 等价的 **3 步**；`loop: false → true`；新增 `match: alicdn\.com` |
| `1688.com.json` | `1688-alicdn-suffix` | 同上 |

3 步语义（**只做去后缀还原原图**，不额外请求尺寸档）：

1. `(_!![\w\-.,]+?\.(?:jpg|jpeg|png|webp))_[\w.\-]+$` → `$1`（`…_!!id.jpg_580x580q90.jpg_.webp` → `…_!!id.jpg`）
2. `\.(jpg|jpeg|png|webp)_[\w.]+$` → `.$1`（`…x.jpg_.webp` → `…x.jpg`）
3. `_\.(webp|jpg|jpeg|png)$` → 空（兜住前面没有扩展名的 `_.webp` 尾巴）

> ⚠️ **为什么必须加 `match`**：新步骤 ② 的匹配面比原单步宽得多（原步要求 `_\d+x\d+q\d+`），
> 不加域限定就会在**所有** URL 上跑；`match: alicdn\.com` 把作用域钉回阿里 CDN。

### 包层覆盖（`HoverVista-测试/探针/hv-rulepack-matrix.mjs` 的「仅云端包」列，**不拼内置**）

| 形态 | 改前 | 改后 |
|---|---:|---:|
| `…jpg_580x580q90.jpg_.webp`（搜索页/首页） | 1 | 1 |
| **`…jpg_.webp`（详情页）** | **0** | **1** |
| `…jpg_460x460q90.jpg_.webp`（首页） | 1 | 1 |
| `…png_460x460q90.jpg_.webp`（天猫） | 1 | 1 |
| **`…png_.webp`（天猫详情）** | **0** | **1** |

### 验签与分发

- `index.json`：`version 2026091601 → 2026092401`，重算 `hashes` / `stats`，重新 ECDSA P-256 签名。
- 工具：`HoverVista-测试/历史用例/规则包/rulepack-sign.js`（签名；`--verify` 自验）。
- 双闸离线复验：`HoverVista-测试/探针/hv-rulepack-gate.mjs`
  —— **切片脚本自己的验签函数 + 内嵌公钥**，不另写一份验签逻辑。
  - 改规则未重签 → ❌ `sig-invalid` + `hash-mismatch:1688.com, taobao.com`
  - 重签后 → ✅ 两闸通过 + 全库 327 域独立复算全绿
- 包内规则数：**327 站 / 690 条**（本次 +4 步）。

### 已知未修（另立独立项）

包内有 **11 条** `ps-*.3` 规则写作 `(…)\.(?:size)((?:ext)).*` → `$1$2`，扩展名前的点被吃掉
（`taobao.com` / `1688.com` 同款早在第二版已修为 `$1.$2`，这 11 条是漏网：
`alibaba-inc.com` `alibaba.com` `alicdn.com` `aliexpress` `alimama.com` `etao.com`
`fliggy.com` `goofish.com` `liangxinyao.com` `tmall` `wsy.com`）。
实测它们只在 `.NxNjpg` / `.searchjpg` 这类畸形态触发（真实 `.NxN.jpg` 形态**不命中**），
可达性≈死规则，影响极小 ⇒ 本轮**未改**；要修需连 pattern 一起重做并逐站实测，另开一轮。

## 第四批：无 `match` 规则会改写外来主机的图（v2026092402，2026-09-24）

> 详细报告：`文档/审查报告/HoverVista-5.9.1-test.4-云端包无match规则改写外来主机-审查发现.md`

### 机制

`applyUrlPipeline()` 第一道闸是 `if (r.match && !r.match.test(u)) continue;`
⇒ **没写 `match` 的规则对任何 URL 都执行**，作用域**完全**由「按当前页面域名取规则文件」决定。
于是 `pattern` 不钉主机的规则，在该站页面上悬停**第三方主机（CDN / 图床）的图**时也会被改写——
轻则白跑一次探测（候选会被在线 `probeCandidates` 淘汰），**重则被重定向到别家主机（图裂）**。

### 暴露面实测

装置：`HoverVista-测试/探针/hv-rulepack-generic.mjs`（纯 Node；口径 = 为每条规则造一个"本应被它匹配"的样本 →
自检样本真被命中 → 把主机整段换成 `hv-foreign-probe.invalid` → 用规则**自己真实的 `replace`** 跑原生 `String.replace`；
`replace` 里硬编码主机 = ★★ 重定向型）。

| 指标 | 改前 `v2026092401` | 改后 `v2026092402` |
|---|---:|---:|
| 考察对象（无 `match` 的 hd 规则） | 688 | 660 |
| **★ 真实暴露（改写主机）** | **28**（归并 9 pattern，含 ★★ 5） | **0** |
| ⚠️ 路径型（只改路径不改主机，不阻断） | 37 | 37 |
| ✅ 对外来主机不命中 | 573 | 573 |
| ⚠️ 样本不可用（未下结论） | 50 | 50 |
| **退出码** | **1** | **0** |

28 条逐域：`tbs` 6 · `tntdrama` 6 · `trutv` 6 · `cameo` 2 · `auctions.yahoo.co.jp` 1 · `javbus` 1 · `javsee` 1 · `seejav` 1 · `reddit` 1 · `discord` 1 · `justwatch` 1 · `kanald.com.tr` 1。
★★ 5 条（`replace` 硬编码主机）：`ps-auctions.yahoo.co.jp-1`（`//auctions.c.yimg.jp`）· `ps-javbus.com-1` / `ps-javsee-1` / `ps-seejav-1`（`//forum.javcdn.cc`）· `ps-reddit.com-1`（`//i.redd.it`）。

### 改了什么（`探针/_patch-rulepack-match.py`，严格断言式生成器）

| 优先级 | 动作 | 条数 |
|---|---|---:|
| P0 | `ps-auctions.yahoo.co.jp-1` 补 `match: yimg\.jp\|yahoo\.co\.jp` | 1 |
| P1 | 硬编码主机三族 + `cameo`(2) + `reddit` + `discord` + `justwatch` + `kanald` + Turner 三站(15) 补 `match` | 25 |
| P2 | 删除 `ps-{tbs,tntdrama,trutv}.com-6`（`$X0$2` 输出**字面量** `$X0`，实测不可达的死规则） | 3 |

Turner 三站与 `kanald` 的 `match` 取值为 **inferred**（站点自身域 / 同系自有域，**未逐站实测**）；
其余均以 `replace` 硬编码主机或兄弟规则为**强证据**。**不做**批量给 688 条补 `match`（573 条实测无害），
**不改** `applyUrlPipeline()` 加默认主机闸门（站点引用第三方图床是正常路径，会被误伤）。

### 发布守卫（新增 `探针/hv-rulepack-guard.sh`）

规则包**任何改动后、推送前**必跑，任一闸红即 `exit 1`：

| 闸 | 装置 | 管什么 | 本次 |
|---|---|---|---|
| ① | `rulepack-sign.js --verify` | `index` 验签 + 逐域 SHA-256 | ✅ |
| ② | `hv-rulepack-gate.mjs` | 脚本**自己的**验签函数 + 内嵌公钥 + 327 域哈希独立复算 | ✅ |
| ③ | `hv-rulepack-integrate.mjs` | 验签 → 装生效表 → 真改写 URL（9 断言） | ✅ 9/9 |
| ④ | `hv-rulepack-generic.mjs` | 作用域**太宽**：无 `match` 规则能否改写**外来主机** | ✅ 真实暴露 0 |
| ⑤ | `hv-rulepack-match-guard.mjs` | 作用域**太窄**：补的 `match` 有没有**掐死本站形态** | ✅ 25/25 通过 |

> ④ 与 ⑤ 是一对：只跑 ④ 会漏掉「补 `match` 补过头、把自己人也挡了」这一类回归。
> **`✅ 五闸全绿 —— 规则包可以推送`**。

**守卫的"改前复现"（纪律：新守卫必须先证明它会红）**：

- 第四闸：探针支持 `HV_RULES_DIR=<目录>` 指向另一份规则树。对照树 = `git show HEAD:rules/*.json` 还原原始导入版
  + 覆盖回当前的 `taobao.com.json` / `1688.com.json`，`diff -rq` 自证与工作树的差异**恰好只剩** 12 个本轮改动文件 + `index.json` + `VALIDATION.md`
  ⇒ **逐字等于 `v2026092401`**。改前跑出 **`EXIT 1` / 28 条暴露（★★ 5）**；改后 `EXIT 0` / 0 条。
- 第五闸：`_mk-rulepack-narrow.py` 把 `tbs.com`(5) + `cameo.com`(2) 的 `match` 改成 `nope\.invalid`
  ⇒ `HV_CUR_DIR=/tmp/hv-cur-narrow node hv-rulepack-match-guard.mjs` 报 **7 条「match 掐死本站样本」+ `EXIT 1`**；真包 `EXIT 0`。

### 真机复核：`inferred` 型 `match` 落到真实站点上

`hv-collect-realimgs.js`（真浏览器渲染后收 `img.currentSrc` + 背景图）+ `hv-rulepack-realimg.mjs`（离线判）：

| 域 | 真机样本 | `pattern` 命中 | 过 `match` | 判定 |
|---|---:|---:|---:|---|
| `kanald.com.tr` | 122（含 56 背景图） | 107 | **107** | ✅ inferred 升格为**实证** |
| `justwatch.com` | 1218（HTML） | 120 | **120** | ✅ |
| `tbs.com` / `tntdrama.com` / `trutv.com` | 各 3 | 0 | — | ⚠️ 未判定：三域**全部 301 → `www.international.tbs.com`（Squarespace）**，旧规则无标的 |
| `cameo.com` | 50 | **0** | — | ⚠️ 未判定：图已是 `cdn2.cameo.com/resizer/…?width=292`，规则写的老形态 ⇒ **规则整体过期** |

### 真机端到端（`探针/hv-rulepack-packlive-run.sh`）：**Q1–Q7 全绿 8/8**

装入 **`v2026092402`**；`Q6` 真实命中 = `pack:tb-alicdn-suffix`（`…saturn_solar.png_580x580q90.jpg` → `…saturn_solar.png`）；`Q5` 源 **460×460** → 预览 **800×800**；`Q7` 无残留。本地服访问日志证实索引与域文件**都取自本地真签名包**。

### 验签与分发

- `index.json`：`version 2026092401 → 2026092402`，重算 `hashes` / `stats`，重新 ECDSA P-256 签名。
- 包内：**327 域 / 687 条 hd**（本轮 −3 条），带 `match` 由 **2 → 27** 条。
- **尚未推送**（需哥哥授权）；推送前必跑 `hv-rulepack-guard.sh`。

### 已知未修（⚠️ 本节是**第四批当时**的快照；其中「660 条无 match」「cameo 规则过期」「Turner 三站退役」「11 条 `ps-*.3` 写法缺陷」四项**已在第五批关闭**，见文末）

- 仍有 **660 条无 `match`**：其中 573 条实测对外来主机无害；**50 条未判定**（47 条是探针生成器局限，非规则缺陷）；37 条「路径型」只改路径不改主机（另一性质，不阻断）。
- 云端包 `clean` 规则 327 域仍全为 `[]` —— **已查明是"设计如此"**（`extract-photoshow.js` 行 175 写死空数组，抽取器只搬竞品的高清链）。
  保留字段（脚本与签名工具确实消费它），原因与将来启用路径写进 `rules/README.md`。
- 11 条 `ps-*.3` 写法缺陷（第三批已挂账）仍未处理。
- **规则过期两例（新发现，非本轮缺陷）**：
  - `cameo.com`：真机 50 张图无一命中 —— 现形态 `cdn2.cameo.com/resizer/<id>.jpg?format=auto&width=292…`。
    **已取到升级证据**：去掉 `width/height/fit/crop` ⇒ **292×292 (11 KB) → 1200×1064 (99 KB)**（HTTP 200 + 实测 JPEG 尺寸）⇒ 下一轮可据此重写规则。
  - `tbs.com` / `tntdrama.com` / `trutv.com`：三域全部 301 → `www.international.tbs.com`（Squarespace），旧规则无标的 ⇒ 可考虑退役。



---

# 第五批（2026-09-24 下午）· `v2026092403`

四件事一次做完：**cameo 规则重写** · **Turner 三站退役** · **52 条「替换值吃掉分隔点」修复** · **660 条无 `match` 规则结案**。
工作文件（`.user.js`）**一行未动**；本轮只改 `rules/`。

## 1. `cameo.com` 规则重写（新增 `ps-cameo.com-3`）

- 旧两条规则对准的 `cdn.cameo.com/v/thumb-…` / `/thumbnails/` **已无标的**（真机 50 张图 0 命中）。
- 现形态是 Imgix 式 resizer：`cdn2.cameo.com/resizer/<id>.jpg?format=auto&width=292&quality=75&fit=crop&height=292&crop=center%2Ctop`。
- 新增规则只做「**剥掉尺寸类查询参数**」（保留 `format` / `quality`），4 步：
  1. `[?&](?:width|height|fit|crop)=[^&]*` → `''`（`g`）
  2. `([^?&]*)\?&` → `$1?`（`g`，修 「`?&` 残留」）
  3. `^(https?://[^?&]*)&` → `$1?`
  4. `\?$` → `''`（清掉尾随 `?`）
- **实测（`探针/hv-cameo-resizer-probe.py`，真网络 + `sips`）**：`width/height/fit/crop` 全去 ⇒ **292×292 (11 KB) → 1200×1064 (88–99 KB)**。
- **实测（`探针/hv-cameo-rule-probe.mjs`，切片脚本真实 `applyUrlRule`）**：

```
44 条真实 cameo URL → 41 条 resizer 全部改写 ✓、且 41/41 保留扩展名分隔点 ✓
样本 in  : …/resizer/4nEUBFeVG_avatar--HPX4iUtK.jpg?format=auto&width=292&quality=75&fit=crop&height=292&crop=center%2Ctop
产出 out : …/resizer/4nEUBFeVG_avatar--HPX4iUtK.jpg?format=auto&quality=75
外域 URL 三条规则一律不动 ✓；三条规则产出均无「扩展名粘连」废 URL ✓
```

## 2. Turner 三站退役

`tbs.com` / `tntdrama.com` / `trutv.com` 真机**三域全部 301 → `www.international.tbs.com`（Squarespace 建站）**，
页面图在 `images.squarespace-cdn.com` ⇒ 旧规则**无标的**。

处置（与「淘宝规则表退役」同法，**只 `mv` 不删**）：三个域文件移入
`HoverVista-测试/历史用例/规则包/retired-2026-09-24-turner/`，并从 `index.domains` 摘除 ⇒ **327 → 324 域**。
签名工具按 `index.domains` 枚举 ⇒ 重签后自动不再为它们生成哈希。

## 3. 修掉 52 条「替换值吃掉扩展名分隔点」的规则

写法规避：pattern 是「捕获组 → 字面 `\.` → 捕获组」，但 `replace` 写成 `$1$2`（漏了那个点）⇒
产出 `xxxjpg` 这种**必然 404** 的废 URL。判据与修法：

- 探针 `探针/hv-rulepack-repdot-guard.mjs`（**切片脚本真实 `applyUrlRule`**，非重实现）：把 pattern 生成样本 → 跑真实 replace →
  产出若出现「字母/数字**紧贴**图片扩展名且其后是串尾 / `?` / `#`」⇒ 判「分隔点被吃」。
- 批量修：`探针/_fix-rulepack-repdot.py`（**严格断言式**：每条 `old` 必须恰好命中 1 次，否则整体中止不写），
  把 rep 结尾的 `$N` 改成 `.$N`。
- **A/B**：改前 **41 条**红 → 改后 **0 条**绿。另 11 条阿里系 `-3` 是同族（`$1.$2` 写法），一并核对为 0。
- 3 条 `ps-mi.com-2` 类是**假阳性**（点在被匹配的捕获组**内部**），未动。

## 4. 660 条无 `match` 规则：结案，不补

第四闸分桶（新增**自证**：六桶求和必须 == 考察对象 660）：

| 桶 | 条数 | 性质 |
|---|---:|---|
| ★ 真实暴露（**改掉主机** ⇒ 图裂） | **0** | — |
| ⚠️ 主机未变·只改路径/query | 4 | 外站上多半 404 ⇒ 在线 `probeCandidates` 淘汰 |
| ⚠️ 路径型（pattern 不含 `//`） | 37 | 主机不变 |
| ✅ `pattern` 已钉主机 | 561 | 结构上不可能命中外来主机 |
| ✅ 对外来主机不命中（样本实测） | 58 | — |
| ⚠️ 样本不可用（未下结论） | **0** | 已收敛 |

**改前 A/B（`/tmp/hv-rules-prepatch` = `v2026092402` 之前的树）**：688 条 → **改掉主机 10（其中 ★★ 重定向 5）** + 主机未变 22 + 路径型 37 + 钉主机 561 + 不命中 58 + 未判定 0，`EXIT 1`。
**改后**：660 条 → **改掉主机 0** ⇒ `EXIT 0`。红/绿只由那 25 条 `match` + 3 条删除 + 判据细化造成，归因干净。

**静态交叉复核**（独立方法，不依赖样本生成）：`探针/hv-rulepack-rephost-scan.mjs` ——
按「`rep` 是否硬编码主机 ∧ `pattern` 是否钉主机」复算：`rep` 硬编码主机者 **17 条，其 pattern 全部钉主机 ⇒ 安全**；
「`rep` 硬编码主机 ∧ pattern 不钉主机」= **0**。与第四闸一致。

**为什么不补 `match`**：补需知道每站**图域**，猜错即「掐死本站能力」（第五闸专防的静默失效）；
收益仅消除**用户无感**的空探测（改错尺寸的候选被在线淘汰 + 被反负升级闸门兜住）⇒ 代价高、收益零。

### 本轮修掉的**装置自身**缺陷（4 处，全部是"探针在骗人"）

| # | 现象 | 真因 | 处置 |
|---|---|---|---|
| 1 | 第五闸把 `ps-cameo.com-3` 判成「样本生成不可用」 | `localCandidates` 用**带 `g` 标志**的 `RegExp` 反复 `test()`，而 `g` 带状态（`lastIndex` 累积）⇒ 对同一 `rx` 连测两个串会「从上次命中位置续测」 | 剥掉 `g`/`y` 再测；修后**未判定 50 → 0**，`ps-cameo.com-3` 才真正被纳入断言（A/B 掐死条数 3 → 4） |
| 2 | `rephost-scan` 把 youtube×2 / znzmo / znztv 误报「★危险」 | 主机判据写成「`//` 后 24 字符内出现 `x\.tld`」，对 `//(?:i\d*\.ytimg\|img\.youtube)\.com(…)`、`//image\d*\.znzmo(?:img)?\.com/…` 这类「**组 + `)\.com`**」写法认不出 | 改为「从 `//` 扫到**第一个括号深度 0 的路径 `/`** = 主机区，再在主机区测 `\.<TLD>`」；补认「字面标签 + `\.(?:com\|cn)`」⇒ 误报 4 → **0** |
| 3 | 4 条**主机未变**的规则被呈成「★真实暴露」 | 判据把「改写了外来主机的 URL」与「**把主机改掉了**」混为一谈（只有后者才图裂） | 拆分两桶（比较 `//host` 前后是否变化）⇒ 「★真实暴露」只留真正换主机的 |
| 4 | `twitch.tv/ps-twitch.tv-4` 落进「样本生成不可用」 | 生成器把 `\b` 当纯零宽、不产出字符 ⇒ 前一个字符是词字符时 `\bpreview` 永不命中 | `\b` 在「前一产出字符是词字符」时补一个 `-` |

## 5. 验签与分发

- `index.json`：`version 2026092402 → 2026092403`，`updatedAt 2026-09-24T14:42:00+08:00`，重算 `hashes`/`stats`，重签 `ECDSA-P256-SHA256`。
- 包内：**324 域 / 673 条 hd**（`clean` 0）；带 `match` 由 **27 → 13**：
  前批 25 条中 Turner 三站占 15 条 → 随退役一并消失（−15）⇒ 余 10；加手工写的 2 条（`1688-alicdn-suffix` / `tb-alicdn-suffix`）+ 本轮 cameo 新增 1 条 = **13**。
  （口径：`探针/hv-rulepack-generic.mjs` 报「hd 总数 673 / 带 match 13」，与 `index.json` 的 `stats` 一致。`clean` 无规则故不涉 `match`。）
- 发布守卫 **五闸全绿**（`探针/hv-rulepack-guard.sh`）：①验签 ✅ ②双闸离线复验 ✅ ③链路集成 `9/9` ✅ ④暴露面「改掉主机 0」✅ ⑤反向守卫 `11/11` ✅ ⇒ `EXIT 0`。
- 反守卫的**红**仍可复现：④ `HV_RULES_DIR=/tmp/hv-rules-prepatch` ⇒ `EXIT 1`（改掉主机 10 / ★★ 5）；⑤ `HV_CUR_DIR=<写窄的树>` ⇒ `EXIT 1`（4 条掐死）。
- **尚未推送**（推送需哥哥授权）。
