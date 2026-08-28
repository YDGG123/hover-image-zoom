<div align="center">

# 🖼️ 鼠标悬停图片自动放大预览

**一款好用的网页图片放大工具 · 鼠标悬停即可自动放大 · 支持自定义配置 · 适配所有网页**

[![Version](https://img.shields.io/badge/version-3.3.1-blue)](https://github.com/YDGG123/hover-image-zoom/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-red)](https://greasyfork.org/zh-CN/scripts/553648)
[![ScriptCat](https://img.shields.io/badge/脚本猫-安装-orange)](https://scriptcat.org/zh-CN/script-show-page/7717)

</div>

---

## 📥 安装

> 前置要求：浏览器需先安装以下任一脚本管理器
>
> | 管理器 | Chrome/Edge | Firefox | 说明 |
> |--------|------------|---------|------|
> | **脚本猫** | ✅ | ✅ | 国产，推荐中文用户 |
> | **Tampermonkey（油猴）** | ✅ | ✅ | 最流行 |
> | **Violentmonkey（暴力猴）** | ✅ | ✅ | 开源轻量 |

### 安装方式（任选其一）

<div align="center">

**🟠 从脚本猫安装（推荐）**

[![ScriptCat Install](https://img.shields.io/badge/点击安装-脚本猫-orange?style=for-the-badge)](https://scriptcat.org/zh-CN/script-show-page/7717)

**🔴 从 Greasy Fork 安装**

[![GreasyFork Install](https://img.shields.io/badge/点击安装-Greasy%20Fork-red?style=for-the-badge)](https://greasyfork.org/zh-CN/scripts/553648)

**⚫ 从 GitHub 直接安装**

[![GitHub Install](https://img.shields.io/badge/点击安装-GitHub-black?style=for-the-badge&logo=github)](https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/鼠标悬停图片自动放大预览.user.js)

</div>

> 💡 **注意**：从 GitHub 直装后，脚本管理器会自动检查仓库更新；从商店安装则由商店负责更新推送。

---

## ✨ 核心功能

### 🎯 一键悬停，即看大图
鼠标移到任何网页图片上，稍作停留即自动弹出放大视图，无需点击、无需跳转。支持**悬停延迟自定义**（0–2000毫秒），快慢随心。

### 🖼️ 智能缩放，适配各种图片
- **自动识别小图**：小于阈值的图片（如缩略图、表情包）按最佳尺寸放大，不糊不畸变
- **竖屏/横屏智能判断**：竖图按高度缩放、横图按宽度缩放，始终以最优比例展示
- **放大倍数可调**：1–5 倍自由设定，还有最小倍数保护，避免过度模糊

### 🎛️ 丰富配置，深度自定义
通过右键悬浮按钮打开设置面板，支持十余项参数调节：

| 配置项 | 说明 |
|--------|------|
| 悬停延迟 | 触发放大的等待时间 |
| 放大倍数 | 大图最大缩放比例 |
| 最大宽/高 | 限制放大图的尺寸上限 |
| 滚轮速度 | 放大态下滚轮滚动大图的灵敏度 |
| 小图阈值/尺寸 | 精细控制小图的放大策略 |

所有配置**按域名独立保存**，不同网站可有不同偏好。

### 🚫 主页排除，兼容性保障
遇到主页图片显示异常？在设置中一键**禁用当前主页**的放大功能，不影响其他子页面。支持管理排除列表，随时恢复。

### 🛡️ 冲突避让，不干扰原生功能
自动检测网站自带的灯箱/相册/点击放大功能（如 Fancybox、Lightbox 等），悬停放大与它们**和平共处，互不干扰**。

### ⌨️ 便捷操作
- **悬浮开关按钮**：屏幕右下角常驻控制按钮，左键启停、右键设置、可拖拽、可最小化吸附到屏幕边缘
- **快捷键**：`Alt + Z` 快速开关功能
- **ESC** 关闭设置面板

---

## 📺 附加彩蛋：B站播放器辅助

在 Bilibili 视频全屏/网页全屏模式下：

- **滚轮调音量**：脚本接管滚轮，流畅调节音量并实时显示音量提示（带图标），解决原生滚轮在网页全屏下失灵的问题
- **方向键守卫**：阻止方向键引发页面穿透滚动，同时保留 B站原生的快进/快退、音量调节逻辑
- **音量变化监听**：无论是滚轮还是拖动音量条，任何音量变化都会弹出美观的居中提示

> 该功能可在设置面板中独立开关，仅对 Bilibili 网站生效。

---

## 🏗️ 技术亮点

- **统一滚轮调度**：全脚本仅一个 `wheel` 监听器，按优先级分发，杜绝事件冲突
- **懒加载兼容**：自动检测未加载完成的图片，加载完毕后自动纳入管理，完美适配 Discuz 论坛、瀑布流等懒加载场景
- **MutationObserver 智能监听**：页面动态新增的图片（无限滚动、选项卡切换）自动识别处理，无需刷新
- **悬停自愈机制**：首次悬停未处理的图片时自动补处理并触发放大，零遗漏
- **性能优化**：使用 `requestIdleCallback` 分批处理图片、`requestAnimationFrame` 节流 Mutation 回调，大量图片页面也不卡顿
- **内存安全**：彻底清理事件监听器与 DOM 引用，长时间使用不泄漏

---

## 🔄 更新日志

### v3.3.1
- 统一滚轮调度架构，模块瘦身
- B站滚轮音量改为脚本接管（原生在网页全屏下不可靠）
- 增强懒加载兼容（Discuz 轮播图/选项卡适配）
- 新增悬停自愈机制
- 适配脚本猫 / 油猴 / 暴力猴 多管理器

<details>
<summary>查看更早版本</summary>

- v3.3.0 — 新增主页排除功能、点击冲突避让
- v3.2.x — 新增B站播放器辅助模块
- v3.1.x — 新增配置面板、悬浮按钮拖拽/最小化
</details>

---

## 💬 反馈与贡献

- 🐛 发现问题？[提交 Issue](https://github.com/YDGG123/hover-image-zoom/issues)
- 💡 功能建议？欢迎开 Issue 讨论
- 🔧 欢迎提交 Pull Request

## 📄 许可证

[MIT](./LICENSE) © 益达哥哥
