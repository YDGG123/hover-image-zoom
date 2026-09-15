# HoverVista 规则包

> 供 `HoverVista-5.9+` 使用：把「站点专属的图片地址变换规则」做成可更新数据。

**站点数：24　规则条数：72**

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
- JSON 必须是**标准 JSON**（键名要加引号）。

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

## 收录站点

| 域名 | 规则数 | 域名 | 规则数 |
|---|---:|---|---:|
| `1688.com` | 5 | `qzone.qq.com` | 4 |
| `acfun.cn` | 2 | `sinaimg.cn` | 2 |
| `bilibili.com` | 4 | `taobao.com` | 5 |
| `book.qq.com` | 2 | `v.qq.com` | 3 |
| `chuangshi.qq.com` | 2 | `video.qq.com` | 3 |
| `dgtle.com` | 1 | `weibo.cn` | 2 |
| `douban.com` | 3 | `weibo.com` | 2 |
| `duitang.com` | 1 | `xiaohongshu.com` | 1 |
| `jd` | 3 | `xiaomi.com` | 3 |
| `mp.weixin.qq.com` | 2 | `xiaomiyoupin.com` | 3 |
| `pixiv.net` | 6 | `y.qq.com` | 5 |
| `pixivision.net` | 6 | `zhihu.com` | 2 |

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
