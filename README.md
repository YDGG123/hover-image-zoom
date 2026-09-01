<div align="center">

# 🖼️ 鼠标悬停图片自动放大预览

**一款好用的网页图片放大工具 · 双放大模式 · 站点级配置 · 内置B站辅助 · 适配所有网页**

[![Version](https://img.shields.io/badge/version-4.1.2-blue)](https://github.com/YDGG123/hover-image-zoom/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-red)](https://greasyfork.org/zh-CN/scripts/553648)
[![ScriptCat](https://img.shields.io/badge/ScriptCat-安装-orange)](https://scriptcat.org/zh-CN/script-show-page/7717)

</div>

---

## 📥 安装

> 前置要求：浏览器需先安装以下任一脚本管理器

| 管理器 | Chrome/Edge | Firefox | 说明 |
|--------|------------|---------|------|
| **脚本猫** | ✅ | ✅ | 国产，推荐中文用户 |
| **Tampermonkey（油猴）** | ✅ | ✅ | 最流行 |
| **Violentmonkey（暴力猴）** | ✅ | ✅ | 开源轻量 |

### 安装方式（任选其一）

<div align="center">

**🟠 从脚本猫安装（推荐）**

[![ScriptCat Install](https://img.shields.io/badge/点击安装-脚本猫-orange?style=for-the-badge)](https://scriptcat.org/zh-CN/script-show-page/7717)

**🔴 从 Greasy Fork 安装**

[![GreasyFork Install](https://img.shields.io/badge/点击安装-Greasy%20Fork-red?style=for-the-badge)](https://greasyfork.org/zh-CN/scripts/553648)

**⚫ 从 GitHub 直接安装**

[![GitHub Install](https://img.shields.io/badge/点击安装-GitHub-black?style=for-the-badge&logo=github)](https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/hover-image-zoom.user.js)

</div>

> 💡 **注意**：从 GitHub 直装后，脚本管理器会自动检查仓库更新；从商店安装则由商店负责更新推送。

---

## ✨ 核心功能

### 🎯 一键悬停，即看大图

鼠标移到任何网页图片上，稍作停留即自动弹出放大视图，无需点击、无需跳转。悬停延迟（0–2000ms）自由调节，快慢随心。

<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/YDGG123/hover-image-zoom@main/ocs/images/hover-zoom.gif" width="400" alt="悬停放大效果演示">
</div>

### 🖼️ 双放大模式，随心切换

- **✨ 智能自适应**：根据屏幕可用空间自动计算最佳放大尺寸，再大的图也不会超出屏幕，省心省力
- **📐 固定倍数**：自定义放大倍数（1–5×），竖长图（漫画、手机截图）按高度优先铺满，小图有专属放大尺寸，避免过度模糊

### 🎛️ 悬浮控制台 + 图形化配置

- 屏幕右侧半透明**悬浮控制台**，一键启停、支持拖拽，位置自动记忆
- 点击齿轮打开**玻璃拟态配置面板**，十余项参数可视化调整、即时保存
- 每个参数附说明提示，支持一键恢复默认
- 所有配置 🔴**按域名独立保存**🔴，不同网站可有不同偏好

<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/YDGG123/hover-image-zoom@main/ocs/images/config-panel.gif" width="300" alt="配置面板演示"><br><br>
  <img src="https://cdn.jsdelivr.net/gh/YDGG123/hover-image-zoom@main/ocs/images/float-console.gif" width="300" alt="悬浮控制台演示">
</div>

### 🏠 站点级管理

- 遇到主页显示异常？一键**禁用当前网站主页**的放大功能，内容子级页不受影响
- 每个网站的开关状态、参数配置完全独立

### 🛡️ 冲突避让，不干扰原生功能

自动检测网站自带的灯箱/相册/点击放大功能（如 Fancybox、Lightbox 等），悬停放大与它们**和平共处，互不干扰**；同时自动跳过图标、表情等无意义小图。

### ⌨️ 便捷操作

- **悬浮控制台**：右侧常驻，左键启停、齿轮进入设置、可拖拽
- **ESC** 关闭设置面板

---

## 📺 附加彩蛋：B站播放器辅助

> **放大模块会导致B站原生滚轮调整音量失效，需开启此辅助解决滚轮调整音量的问题**

在 Bilibili 视频全屏/网页全屏模式下：

- **滚轮调音量**：流畅调节音量并实时显示音量浮窗提示，修复放大部分导致的原生滚轮调音失效
- **方向键守卫**：阻止方向键引发页面穿透滚动，保留 B站原生快进/快退逻辑
- **音量变化监听**：无论是滚轮还是拖动音量条，任何音量变化都会弹出居中提示

> 该功能可在设置面板中独立开关，仅对 Bilibili 网站生效。

---

## 🏗️ 技术亮点

- **统一滚轮调度**：全脚本仅一个 `wheel` 监听器，按优先级分发，杜绝事件冲突
- **懒加载兼容**：自动检测未加载完成的图片，加载完毕后自动纳入管理，完美适配 Discuz 论坛、瀑布流等懒加载场景
- **MutationObserver 智能监听**：页面动态新增的图片（无限滚动、选项卡切换）自动识别处理，无需刷新
- **悬停自愈机制**：首次悬停未处理的图片时自动补处理并触发放大，零遗漏
- **性能优化**：`requestIdleCallback` 分批处理图片、`requestAnimationFrame` 节流回调，大量图片页面也不卡顿
- **内存安全**：彻底清理事件监听器与 DOM 引用，关闭脚本完整还原页面，长时间使用不泄漏

---

## 🔄 更新日志

### v4.2.2

- 修复：某些网站悬停时会盖上遮罩层，导致「误判鼠标离开」→ 无限递归崩溃
- 新增**问题反馈**：配置面板里可以直接反馈问题给我

<details>
<summary>查看更早版本</summary>

- **v4.1.2**
  - 全新**悬浮控制台**：右侧停靠式设计，状态一目了然，支持拖拽与位置记忆
  - 全新**图形化配置面板**：玻璃拟态风格，参数即时保存，附说明提示
  - 新增**双放大模式**：智能自适应 / 固定倍数，竖长图与小图有专属放大策略
  - 新增**站点级管理**：配置按域名独立保存，支持禁用指定网站主页
  - B站辅助模块整合进设置面板，可独立开关
- **v3.3.1** — 统一滚轮调度架构、懒加载兼容增强、悬停自愈机制
- **v3.3.0** — 新增主页排除功能、点击冲突避让
- **v3.2.x** — 新增B站播放器辅助模块
- **v3.1.x** — 新增配置面板、悬浮按钮拖拽/最小化

</details>

---

## 💬 反馈与贡献

- 🐛 发现问题？[提交 Issue](https://github.com/YDGG123/hover-image-zoom/issues)
- 💡 功能建议？欢迎开 Issue 讨论
- 🔧 欢迎提交 Pull Request

## 📄 许可证

[MIT](./LICENSE) © 益达哥哥
