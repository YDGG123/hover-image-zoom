// ==UserScript==
// @name         悬景 · HoverVista｜鼠标悬停图片自动放大预览
// @namespace    https://github.com/YDGG123
// @version      5.9.0
// @description  网页图片鼠标悬停自动放大工具：智能自适应、高清图后台升级、滚轮边界控制、配置备份与恢复
// @author       益达哥哥
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      raw.githubusercontent.com
// @connect      *
// @run-at       document-end
// @license      GPL-3.0
// @homepageURL  https://github.com/YDGG123/hover-image-zoom
// @supportURL   https://github.com/YDGG123/hover-image-zoom/issues
// @downloadURL  https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/hover-image-zoom.user.js
// ==/UserScript==

/*
 * 悬景 · HoverVista — 鼠标悬停图片自动放大预览
 * Copyright (C) 2025-2026 益达哥哥
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function() {
    'use strict';

    // ★ 幂等守卫：同一文档只允许初始化一次。
    // 实测（Violentmonkey + @run-at document-end）脚本会偶发地在**同一文档内执行两次**
    // （example.com/example.net 可复现、example.org 不复现），导致 mainInit 跑两遍：
    // 两个 dock、两套 hover 流、两份仲裁实例互相抢锁 → 预览时有时无 / 闪烁。
    // 用 documentElement 上的标记做守卫：两次执行共享同一 DOM，能稳定拦住。
    if (document.documentElement.getAttribute('data-hv-inited') === '1') return;
    document.documentElement.setAttribute('data-hv-inited', '1');

// ★ 版本号动态取自脚本管理器（@version），避免每次升号后忘记同步这里的常量；
//   GM_info 不可用时回退到当前发布版本字符串。
const SCRIPT_VERSION = (function () {
    try {
        if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) return GM_info.script.version;
    } catch (e) { }
    return '5.9.0';
})();
// 调试模式（URL 带 ?hvdebug=1）：把智能升级器的诊断信息显示在信息浮层里，便于端到端排查
const HV_DEBUG = (function () { try { return /[?&]hvdebug=1/.test(location.search); } catch (e) { return false; } })();

    // ================
    // 存储读写封装
    // ================
    const storage = {
        get(key, defaultValue) {
            return GM_getValue(key, defaultValue);
        },
        set(key, value) {
            return GM_setValue(key, value);
        }
    };

    const storageGet = (key, defaultValue) => storage.get(key, defaultValue);
    const storageSet = (key, value) => storage.set(key, value);

    // ================
    // 历史记录（最近悬停看过的图片；只存本机 GM 存储，不上传）
    // ================
    const HISTORY_KEY = 'hvHistoryV1';
    const HISTORY_MAX = 60;
    function getHistory() {
        try {
            const v = storageGet(HISTORY_KEY, []);
            return Array.isArray(v) ? v : [];
        } catch (e) { return []; }
    }
    function pushHistory(entry) {
        try {
            if (!entry || !entry.u || /^(blob|data):/i.test(entry.u)) return;
            let list = getHistory();
            list = list.filter(function (x) { return x && x.u !== entry.u; }); // 同图去重：重新悬停=置顶刷新
            if (!entry.id) entry.id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            entry.ts = Date.now();
            list.unshift(entry);
            if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
            storageSet(HISTORY_KEY, list);
        } catch (e) { }
    }
    function updateHistoryEntry(id, data) {
        try {
            const list = getHistory();
            const it = list.find(function (x) { return x && x.id === id; });
            if (!it) return;
            Object.assign(it, data, { ts: Date.now() });
            const rest = list.filter(function (x) { return x !== it; });
            rest.unshift(it);
            storageSet(HISTORY_KEY, rest.slice(0, HISTORY_MAX));
        } catch (e) { }
    }
    function removeHistoryItem(id) {
        try { storageSet(HISTORY_KEY, getHistory().filter(function (x) { return x && x.id !== id; })); } catch (e) { }
    }
    function clearHistory() { try { storageSet(HISTORY_KEY, []); } catch (e) { } }
    // 预览激活时调用：首次记一条；同实例 HD 升级换图后更新同条（不产生重复）
    // 图集翻页 = 新实例（startPending→show→createInstance），每张各记一条
    function recordHistory(inst) {
        try {
            if (!inst || !inst.imgEl) return;
            const u = inst.infoSrc || inst.imgEl.currentSrc || inst.imgEl.src || '';
            if (!u || /^(blob|data):/i.test(u)) return;
            const s = inst.sourceImg;
            const thumb = s ? (s.currentSrc || s.src || '') : '';
            const data = {
                u: u,
                thumb: thumb,
                host: (parseImageInfo(u) || {}).host || '',
                w: inst.imgEl.naturalWidth || 0,
                h: inst.imgEl.naturalHeight || 0
            };
            if (inst.__histId) updateHistoryEntry(inst.__histId, data);
            else {
                inst.__histId = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                pushHistory(Object.assign({ id: inst.__histId }, data));
            }
        } catch (e) { }
    }

    function getDomain() {
        try { return new URL(window.location.href).hostname; }
        catch (e) { return window.location.hostname || 'unknown'; }
    }

    function debounce(fn, wait) {
        let t;
        return function(...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); };
    }

    // 仅前沿节流（无尾随重放：每次执行携带自己那一刻的真实事件，无过期数据）
    function throttleLeading(fn, wait) {
        let lastExec = 0;
        return function(...a) {
            const now = Date.now();
            if (now - lastExec >= wait) { lastExec = now; fn.apply(this, a); }
        };
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function isHomepage() {
        const p = window.location.pathname;
        return p === '/' || p === '/index.html' || p === '/index.php' || p === '';
    }

    // ================
    // 跨 frame 仲裁（v5.8.0：iframe 支持）
    // ================
    // 去掉 @noframes 后，同一页面顶层 + 各 iframe 都会跑一份脚本。
    // 预览是居中显示（不跟随鼠标坐标），所以各 frame 各自显示天然不冲突；
    // 唯一要防的是「两个 frame 同时 ACTIVE → 两个预览叠着出现」。
    // 方案：GM storage 广播活跃心跳（跨域 iframe 也有效），启动预览前先看有没有别人 ACTIVE。
    //   - ACTIVE 期间每 500ms 续约，1.5s 无心跳视为退出（防 frame 崩溃/被杀后锁死）
    //   - 准入检查通过后仍要「声明 → 复核 → 确认」两阶段提交：两帧同时通过检查时，
    //     由确定性选举（声明时刻最早者胜，平局看 frameId）选出唯一赢家，输者回退并进入静默期
    //   - 非顶层 frame 的 dock 按钮不创建（UI 入口只留顶层，避免 iframe 里也浮一个控制球）
    const IS_TOP = (function () {
        try { return window.top === window.self; } catch (e) { return false; }  // 跨域访问 window.top 会抛
    })();
    const ARBITER_KEY = 'image_zoom_active_frames';
    const ARBITER_TTL = 1500;
    const ARBITER_RENEW = 500;
    // ★ 竞态修复（P1）：准入检查与占位是两次独立读写，两个 frame 可能同时通过检查。
    //   因此占位后追加一个「复核窗口」：等心跳跨 frame 传播完，再按确定性规则选出唯一赢家，
    //   输的一方主动让出预览。SETTLE 要略大于一次 storage 往返回传时间。
    const ARBITER_SETTLE = 140;
    // 输掉仲裁后的静默期：期间不再发起新预览，避免两帧反复互抢（乒乓）
    const ARBITER_COOLDOWN = 800;
    // ★ 空闲上限：本 frame 多久没收到 mousemove 就放弃仲裁锁。
    // 光标同一时刻只可能落在一个 frame 里，所以"本 frame 长时间没有鼠标事件"＝光标已不在这里。
    // 没有这道闸，一个卡住的 frame（最典型：光标移出 iframe 后 iframe 收不到事件、
    // 预览永不收起）会无限续约，把全局其他标签页/frame 全部锁死。
    const ARBITER_IDLE = 5000;
    // frameId 必须高熵：两帧若碰撞成同一个 key，心跳会互相覆盖，仲裁直接失效。
    // （原实现只有毫秒时间戳 + 5 位 base36 随机，同毫秒创建的兄弟 frame 存在碰撞面）
    const frameId = 'f' + Date.now().toString(36) + '-' + (function () {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID().slice(0, 8);
            }
        } catch (e) { }
        return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    })();
    let arbiterTimer = null;
    let arbiterCooldownUntil = 0;
    // 本 frame 最近一次收到鼠标事件的时刻（供 ARBITER_IDLE 判定"光标是否还在这里"）
    let arbiterLastMoveAt = 0;
    window.addEventListener('mousemove', () => { arbiterLastMoveAt = Date.now(); }, { capture: true, passive: true });

    // ★ 图集翻页保持：翻页后显示的是「不在光标下」的另一张图，
    // 而心跳会校验「光标必须落在当前图内」，否则会立刻取消预览。
    // 这里在翻页时记下光标位置，保持期内让心跳跳过几何校验；
    // 光标一旦移动超过阈值（用户真的要去看别处）立即解除，恢复正常裁决。
    let galleryHoldAt = null;
    window.addEventListener('mousemove', (e) => {
        if (!galleryHoldAt) return;
        if (Math.abs(e.clientX - galleryHoldAt.x) > 4 || Math.abs(e.clientY - galleryHoldAt.y) > 4) {
            galleryHoldAt = null;
        }
    }, { capture: true, passive: true });

    function readActiveMap() {
        try {
            const raw = storageGet(ARBITER_KEY, {});
            return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        } catch (e) { return {}; }
    }

    function arbiterTouch(active) {
        try {
            const map = readActiveMap();
            const now = Date.now();
            for (const k of Object.keys(map)) {
                if (now - (map[k] && map[k].t || 0) > ARBITER_TTL) delete map[k];
            }
            if (active) {
                // t = 最后一次心跳（判活 / TTL 用）；c = 首次声明时刻，续约时保持不变。
                // 选举必须看 c：否则活跃帧每次续约都会把时间戳刷新成「现在」，
                // 晚到的竞争者就能靠 frameId 平局规则把它顶掉。
                const prev = map[frameId];
                map[frameId] = { t: now, c: (prev && prev.c) || now };
            } else {
                delete map[frameId];
            }
            storageSet(ARBITER_KEY, map);
        } catch (e) { }
    }

    // 别的 frame 是否有 ACTIVE 预览（自己的心跳不算）
    function arbiterOthersActive() {
        const map = readActiveMap();
        const now = Date.now();
        return Object.keys(map).some(k => k !== frameId && now - (map[k] && map[k].t || 0) <= ARBITER_TTL);
    }

    function arbiterStartRenew() {
        arbiterTouch(true);
        if (arbiterTimer) clearInterval(arbiterTimer);
        arbiterTimer = setInterval(() => {
            // ★ 后台页必须停止续约。心跳在 document.hidden 时会暂停（预览一直不被收起），
            // 若续约照跑，这个 frame 就会永远占着仲裁锁，导致**其他标签页 / 其他 frame
            // 全部无法触发预览**。实测：一个后台标签页带着活跃预览 → 全站失效。
            try {
                if (document.hidden) { arbiterStopRenew(); return; }
                // 光标已不在本 frame（长时间无鼠标事件）→ 让出仲裁锁，避免永久占用拖垮全局
                if (arbiterLastMoveAt && Date.now() - arbiterLastMoveAt > ARBITER_IDLE) { arbiterStopRenew(); return; }
                if (zoomFSM && zoomFSM.hasActiveZoom()) arbiterTouch(true);
                else { arbiterStopRenew(); }
            } catch (e) { arbiterStopRenew(); }
        }, ARBITER_RENEW);
    }

    function arbiterStopRenew() {
        if (arbiterTimer) { clearInterval(arbiterTimer); arbiterTimer = null; }
        arbiterTouch(false);
    }

    // ★ 切到后台立即释放仲裁，回到前台时若预览仍在再重新占位。
    // 否则本 frame 会在后台一直续约，把其他标签页 / frame 全部锁死。
    document.addEventListener('visibilitychange', () => {
        // zoomFSM 在本模块之后才声明（const），页面加载期间若触发 visibilitychange，
        // 直接访问会命中暂时性死区（TDZ）抛 ReferenceError。故整体包 try/catch。
        try {
            if (document.hidden) {
                if (arbiterTimer) arbiterStopRenew();
            } else if (zoomFSM && zoomFSM.hasActiveZoom()) {
                arbiterStartRenew();
            }
        } catch (e) { }
    });

    // 确定性选举：声明时刻 c 最早者胜；c 相同时按 frameId 字典序打破平局。
    // 各帧各自计算结果一致，因此不会出现「两边都以为自己是赢家」。
    //
    // ★ 关键：只有【明确看到别的帧更早的声明】才算输。
    // 自己条目读不到 ≠ 输 —— 多 frame 并发读写 GM 存储存在延迟（尤其 Violentmonkey 下
    // 同一页面有 iframe 时），条目会短暂读不到。若据此判负就会「收起 → 重新悬停 → 再判负」死循环，
    // 表现为预览反复闪烁、且旧容器来不及移除（一次悬停出现 2 个容器）。
    function arbiterElectionLost() {
        try {
            const map = readActiveMap();
            const now = Date.now();
            const mine = map[frameId];
            if (!mine) { arbiterTouch(true); return false; }   // 存储延迟：补一次心跳，不回滚
            const myC = mine.c || mine.t || 0;
            for (const k of Object.keys(map)) {
                if (k === frameId) continue;
                const o = map[k];
                if (!o || now - (o.t || 0) > ARBITER_TTL) continue;
                const oC = o.c || o.t || 0;
                if (oC < myC) return true;
                if (oC === myC && k < frameId) return true;
            }
            return false;
        } catch (e) {
            return false;      // 读取异常一律不回滚，避免误伤正常预览
        }
    }

    // 启动新预览的资格：① 不在输掉仲裁后的静默期；② 别的 frame 没有 ACTIVE 预览。
    // 本 frame 已 ACTIVE 时不会走到这里（调用点用 hasActiveZoom 挡在前面），切图不受影响。
    function arbiterCanAcquire() {
        if (Date.now() < arbiterCooldownUntil) return false;
        return !arbiterOthersActive();
    }

    const FADE_MS = 300;
    const HEARTBEAT_MS = 150;

    // 坐标权威源：只由 mousemove 写入。
    // 停稳裁决器与后续校验（心跳/TIMER_FIRE）使用
    const lastMouse = { x: -1, y: -1, t: 0 };

    // ★ 悬停等待指示器：停稳后继续等待 300ms 才出现，使用轻量的“三点聚焦”动画（增强可见度）。
    // 不拦截鼠标事件；进入 SHOWING/ACTIVE/FADING、切图或取消等待时立即隐藏。
    let hoverWaitIndicator = null;
    let hoverWaitIndicatorTimer = null;
    function ensureHoverWaitIndicator() {
        if (hoverWaitIndicator && hoverWaitIndicator.isConnected) return hoverWaitIndicator;
        const el = document.createElement('div');
        el.id = 'hoverWaitIndicator';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<i></i><i></i><i></i>';
        document.documentElement.appendChild(el);
        hoverWaitIndicator = el;
        return el;
    }
    function positionHoverWaitIndicator(x, y) {
        const el = ensureHoverWaitIndicator();
        el.style.left = Math.round(x) + 'px';
        el.style.top = Math.round(y) + 'px';
    }
    function showHoverWaitIndicator(x, y, duration) {
        const el = ensureHoverWaitIndicator();
        positionHoverWaitIndicator(x, y + 18);
        el.style.setProperty('--hover-wait-duration', Math.max(80, duration || config.delay || 800) + 'ms');
        el.classList.add('show');
    }
    function hideHoverWaitIndicator() {
        if (hoverWaitIndicatorTimer) { clearTimeout(hoverWaitIndicatorTimer); hoverWaitIndicatorTimer = null; }
        if (hoverWaitIndicator) hoverWaitIndicator.classList.remove('show');
    }
    function scheduleHoverWaitIndicator(img) {
        hideHoverWaitIndicator();
        if (!img || !img.isConnected) return;
        // 等待动画从进入 PENDING 状态就开始，并持续到放大图真正显示（LOADED/ACTIVE）。
        // 不再用固定 300ms 的显示窗口，也不让动画时长与 config.delay 绑定。
        const x = lastMouse.x;
        const y = lastMouse.y;
        if (x >= 0 && y >= 0) showHoverWaitIndicator(x, y, config.delay);
    }
    let pendingImageForIndicator = null;

    // ★ 光标是否在浏览器窗口内：mouseout(relatedTarget=null) 置 false，mousemove 置 true。
    // 原生窗口（文件管理器等）覆盖浏览器时，DOM 对遮挡毫无感知，
    // elementFromPoint 和 lastMouse 都会给出"光标仍在图上"的假象，必须靠此标记纠偏
    let pointerInWindow = true;
    // ★ 浏览器窗口当前是否有焦点。关闭“失焦时收起”后，用它区分
    // “鼠标真正离开浏览器”与“浏览器被文件管理器/其他应用暂时盖住”。
    let browserWindowFocused = true;
    // ★ 恢复保护只看这一个开关；原 suppressWindowExitUntil / resumeBlockX / resumeBlockY
    // 三处状态只有写入、从未被读取（保护逻辑并未接线），已删除以免误导后续维护。
    let resumeBlockedUntilMouseMove = false;

    const currentDomain = getDomain();

    // 「点图选图」进行中：压住悬停预览，让用户能直接点网页图片（设置模块里置位）
    let urlPickMode = false;


    // ★ 统一提示组件（重做样式）
    //   旧版是「黑底白字 + ✅」，在浅色页面上突兀且层级不清。
    //   新版：白底（暗色环境自动切深底）+ 品牌蓝圆形图标 + 细边框 + 柔和投影，
    //   进入用「淡入 + 轻微放大 + 上移」，三个入口共用同一套视觉，只换定位。
    function hvToast(message, opt) {
        opt = opt || {};
        const variant = opt.variant || 'mid';       // mid=屏幕中央 / center=面板中央 / bottom=底部
        const type = opt.type || 'ok';              // ok | err | warn
        const duration = opt.duration || 1600;
        let el = document.getElementById('hvToastEl');
        if (!el) {
            el = document.createElement('div');
            el.id = 'hvToastEl';
            el.className = 'hv-toast mid';
            el.innerHTML = '<span class="hv-t-ic"></span><span class="hv-t-tx"></span>';
            document.body.appendChild(el);
        }
        el.className = 'hv-toast ' + variant + (type === 'ok' ? '' : ' ' + type);
        el.querySelector('.hv-t-ic').textContent = type === 'ok' ? '✓' : '!';
        el.querySelector('.hv-t-tx').textContent = message;
        void el.offsetWidth;                        // 强制重排，让连续提示也能重播进入动画
        el.classList.add('on');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('on'), duration);
    }

    // 面板打开时统一显示在面板中央（面板本身居中，所以屏幕中央即面板中央）
    function showPanelCenterToast(message, type) {
        const overlay = document.getElementById('izModalOverlay');
        if (!overlay || overlay.style.display !== 'flex') return false;
        hvToast(message, { variant: 'center', type: type });
        return true;
    }

    function showToast(message, duration = 2000, type) {
        if (showPanelCenterToast(message, type)) return;
        hvToast(message, { variant: 'mid', duration: duration, type: type });
    }

    function showSaveToast(message, type) {
        if (showPanelCenterToast(message, type)) return;
        hvToast(message, { variant: 'bottom', type: type });
    }


    // ================
    // 1. 配置模块
    // ================

    // ================
    // 1. 配置
    // ================
    // 键位表默认值：动作名 → 按键列表。按键用 event.key 归一化后的形式（单字符小写）。
    // 后续新增动作（保存/复制/翻页/旋转/全屏）只需在这里加一项 + 在键位系统里注册实现。
    const KEYMAP_DEFAULTS = Object.freeze({
        close: ['Escape'],
        zoomIn: ['+', '='],
        zoomOut: ['-', '_'],
        resetZoom: ['0'],
        saveImage: ['s'],
        copyLink: ['c'],
        copyImage: ['C'],       // Shift+C：复制图片本体
        rotate: ['r'],
        flip: ['R'],            // Shift+R：水平翻转
        prevImage: ['ArrowLeft'],
        nextImage: ['ArrowRight'],
        fullscreen: ['f'],
        galleryZip: ['z']       // 图集打包下载（store 模式手写 ZIP，不引第三方库）
    });

    // 面板「键位」区展示用（顺序即展示顺序）
    const KEYMAP_ACTION_DEFS = [
        { key: 'close',      name: '关闭预览',     hint: '收起当前放大图' },
        { key: 'zoomIn',     name: '放大',         hint: '按步进放大约 8%' },
        { key: 'zoomOut',    name: '缩小',         hint: '按步进缩小约 7.4%' },
        { key: 'resetZoom',  name: '重置缩放',     hint: '回到进入预览时的大小' },
        { key: 'saveImage',  name: '保存高清图',   hint: '优先保存高清原图' },
        { key: 'copyLink',   name: '复制图片地址', hint: '复制真实来源地址' },
        { key: 'copyImage',  name: '复制图片',     hint: '复制图片本体（跨域可能失败）' },
        { key: 'rotate',     name: '旋转 90°',     hint: '顺时针；转四次回原状' },
        { key: 'flip',       name: '水平翻转',     hint: '再按一次还原' },
        { key: 'prevImage',  name: '上一张',       hint: '图集内往前翻' },
        { key: 'nextImage',  name: '下一张',       hint: '图集内往后翻' },
        { key: 'fullscreen', name: '全屏',         hint: '再按一次退出' },
        { key: 'galleryZip', name: '打包下载图集', hint: '图集模式下按 Z，把整组图打成 ZIP 下载' }
    ];

    // 按键显示名（字母保留大小写，大写即代表 Shift 组合）
    const KEYMAP_KEY_LABELS = {
        'Escape': 'Esc', 'ArrowLeft': '←', 'ArrowRight': '→', 'ArrowUp': '↑', 'ArrowDown': '↓',
        ' ': '空格', 'Enter': '回车', 'Tab': 'Tab', '+': '+', '=': '=', '-': '-', '_': '_'
    };
    function displayKeyName(k) {
        if (KEYMAP_KEY_LABELS[k]) return KEYMAP_KEY_LABELS[k];
        if (typeof k === 'string' && k.length === 1 && k >= 'A' && k <= 'Z') return 'Shift+' + k;
        return k;
    }

    // 把存储里的键表归一化成合法结构；缺失/非法一律回落到默认值
    function normalizeKeymap(raw) {
        const out = {};
        Object.keys(KEYMAP_DEFAULTS).forEach(function (k) {
            const v = raw && Array.isArray(raw[k])
                ? raw[k].filter(function (x) { return typeof x === 'string' && x.length > 0; })
                : null;
            out[k] = (v && v.length) ? Array.from(new Set(v)) : KEYMAP_DEFAULTS[k].slice();
        });
        return out;
    }

    // ★ 键位表是「全局」配置：按键是肌肉记忆，不应该随网站变化。
    //   它独立于按站点存储的 config（image_zoom_config_<域名>），只用这一个全局键。
    //   迁移：旧版本把 keymap 写在各站 config 里 —— 首次加载时把当前站的值搬到全局键，
    //   之后一律以全局键为准（站点 config 里的 keymap 仅作导出兼容镜像，不参与读取）。
    const KEYMAP_GLOBAL_KEY = 'image_zoom_keymap_global';
    function loadGlobalKeymap() {
        try {
            const raw = storageGet(KEYMAP_GLOBAL_KEY, null);
            if (raw && typeof raw === 'object') return normalizeKeymap(raw);
        } catch (e) { }
        return null;
    }
    function saveGlobalKeymap(km) {
        try { storageSet(KEYMAP_GLOBAL_KEY, normalizeKeymap(km)); } catch (e) { }
    }

    // 用户自定义的「图片地址变换规则」：归一化 + 合法性校验（正则必须能编译）
    // 结构：{ id, label, phase:'hd'|'clean', pattern, flags, replace, enabled, scope:'site'|'global', domain }
    // ★ scope='site' 时只在 domain 匹配的站点生效（面板里叫「仅本站」）；'global' 则所有站点生效。
    // ★ 迁移兼容：旧数据没有 domain 字段 → 视为 global（保持原全局行为），避免升级后已有规则静默失效。
    function normalizeUserUrlRules(raw) {
        const out = [];
        if (!Array.isArray(raw)) return out;
        raw.slice(0, 200).forEach(function (r, i) {
            if (!r || typeof r !== 'object') return;
            const pattern = typeof r.pattern === 'string' ? r.pattern : '';
            if (!pattern) return;
            const flags = (typeof r.flags === 'string' ? r.flags : '').replace(/[^gimsuy]/g, '');
            try { new RegExp(pattern, flags); } catch (e) { return; }   // 编译不过直接丢弃
            out.push({
                id: String(r.id || ('u' + Date.now() + '_' + i)),
                label: String(r.label || '').slice(0, 60),
                phase: r.phase === 'clean' ? 'clean' : 'hd',
                pattern: pattern,
                flags: flags,
                replace: typeof r.replace === 'string' ? r.replace : '',
                enabled: r.enabled !== false,
                scope: r.scope === 'global' ? 'global' : (r.scope === 'site' ? 'site' : (r.domain ? 'site' : 'global')),
                domain: typeof r.domain === 'string' ? r.domain.slice(0, 120) : ''
            });
        });
        return out;
    }

    const defaultConfig = {
        delay: 800,
        scale: 2,
        // ★ 3000（= 配置上限）等效「跟随视口」：预览可用空间 = min(视口-60, 此上限)，
        //   旧默认 1200/980 在宽屏上会把自适应/滚轮预览压得很小（validateConfig 里有存量迁移）。
        maxWidth: 3000,
        maxHeight: 3000,
        minScale: 1.4,
        zoomZIndex: 9999,
        scrollSpeed: 50,
        smallImgThreshold: 280,
        smallImgWidth: 500,
        smallImgHeight: 430,
        avoidClickConflict: true,
        blurDismiss: true,
        wheelZoom: true,
        videoHoverPreview: true,   // ★ 视频悬停预览（悬停视频/视频卡片时静音播放）
        showImageInfo: true,
        previewPlacement: 'center', // 显示位置：center=屏幕居中（默认）/ around=原图周围不遮挡
        previewTransition: 'dock',  // 入场动效：dock 从原图弹出（默认）/ spotlight 从原图绽开 / fade 直接淡入
        zoomMode: 'adaptive',
        minOriginalSize: 51,
        rulePackAuto: true,      // 规则包：启动时自动更新（失败静默降级到内置/缓存）
        userUrlRules: [],        // 用户自定义的图片地址变换规则（面板里增删改）
        keymap: normalizeKeymap(null)
    };

    const CONFIG_LIMITS = {
        delay: [0, 2000],
        scale: [1, 5],
        maxWidth: [300, 3000],
        maxHeight: [300, 3000],
        minScale: [1, 3],
        scrollSpeed: [5, 50],
        smallImgThreshold: [100, 500],
        smallImgWidth: [300, 1000],
        smallImgHeight: [300, 1000],
        minOriginalSize: [0, 500]
    };

    let config = { ...defaultConfig };
    let isEnabled = true;

    function validateConfig(cfg) {
        const v = { ...cfg };
        for (const [key, [min, max]] of Object.entries(CONFIG_LIMITS)) {
            const val = parseFloat(v[key]);
            v[key] = isNaN(val) ? defaultConfig[key] : Math.max(min, Math.min(max, val));
        }
        v.zoomMode = v.zoomMode === 'fixed' ? 'fixed' : 'adaptive';
        v.blurDismiss = typeof v.blurDismiss === 'boolean' ? v.blurDismiss : true;
        v.videoHoverPreview = typeof v.videoHoverPreview === 'boolean' ? v.videoHoverPreview : true;
        v.previewPlacement = ['center', 'around'].indexOf(v.previewPlacement) >= 0 ? v.previewPlacement : 'center';
        v.previewTransition = ['dock', 'spotlight', 'fade'].indexOf(v.previewTransition) >= 0 ? v.previewTransition : 'dock';
        // ★ 旧默认(1200/980)一次性迁移到「跟随视口」(3000/3000)：老用户存储里存着旧默认值，
        //   不迁移的话改默认不生效。用户手动改成其它值的（含恰好 1200 但 maxHeight 非默认）不动。
        if (v.maxWidth === 1200 && v.maxHeight === 980) { v.maxWidth = 3000; v.maxHeight = 3000; }
        v.wheelZoom = typeof v.wheelZoom === 'boolean' ? v.wheelZoom : true;
        v.showImageInfo = typeof v.showImageInfo === 'boolean' ? v.showImageInfo : true;
        v.keymap = normalizeKeymap(v.keymap);
        v.userUrlRules = normalizeUserUrlRules(v.userUrlRules);
        return v;
    }

    function loadConfig() {
        const saved = storageGet(`image_zoom_config_${currentDomain}`);
        if (saved) config = { ...defaultConfig, ...validateConfig(saved) };
        // ★ 键位表以全局键为准（跨网站共享）；全局键还不存在时，把本站旧值迁移上去。
        const gkm = loadGlobalKeymap();
        if (gkm) config.keymap = gkm;
        else saveGlobalKeymap(config.keymap);
    }

    function saveConfig() {
        storageSet(`image_zoom_config_${currentDomain}`, config);
    }

    function loadState() {
        isEnabled = storageGet(`image_zoom_enabled_${currentDomain}`) !== false;
        // ⚠ 不要用「主页禁用」覆盖 isEnabled：那会让面板总开关显示「已关闭」（存储其实是开），
        //   用户会误以为设置没保存、且下次点开关会把 false 真正写进存储。
        //   主页禁用的效果由各功能入口的 `!isEnabled || isHomepageZoomDisabled()` 双检查保证。
    }

    // 主页禁用状态
    function isHomepageDisabled() {
        return storageGet(`image_zoom_homepage_disabled_${currentDomain}`, false);
    }

    function isHomepageZoomDisabled() {
        return isHomepage() && isHomepageDisabled();
    }


    // ================
    // 配置备份 / 恢复（导出 · 导入）
    // ================
    // 备份文件格式：{ app, format, scriptVersion, exportedAt, keys: { <存储键>: <值> } }
    // 只搬运本脚本自己的键：以 image_zoom_ 开头（含各站点独立配置），外加 B 站音量开关。
    const BACKUP_FORMAT_VERSION = 1;
    const BACKUP_KEY_PREFIX = 'image_zoom_';
    const BACKUP_EXTRA_KEYS = ['bilibili_volume_enabled'];

    function isBackupKey(k) {
        return typeof k === 'string' && (k.indexOf(BACKUP_KEY_PREFIX) === 0 || BACKUP_EXTRA_KEYS.indexOf(k) >= 0);
    }

    function collectBackupKeys() {
        const keys = new Set();
        try {
            if (typeof GM_listValues === 'function') {
                (GM_listValues() || []).forEach(k => { if (isBackupKey(k)) keys.add(k); });
            }
        } catch (e) { }
        // 兜底：个别脚本管理器不提供 GM_listValues 时，至少带上全局键与当前站点的键
        if (keys.size === 0) {
            ['image_zoom_custom_rules', 'image_zoom_intro_seen', 'image_zoom_update_seen', 'image_zoom_dock_top', 'image_zoom_keymap_global']
                .concat(BACKUP_EXTRA_KEYS).forEach(k => keys.add(k));
            ['config_', 'enabled_', 'homepage_disabled_'].forEach(suffix => {
                keys.add(BACKUP_KEY_PREFIX + suffix + currentDomain);
            });
        }
        return Array.from(keys);
    }

    function exportConfigToFile() {
        try {
            const data = {};
            collectBackupKeys().forEach(k => {
                try {
                    const v = storageGet(k, undefined);
                    if (v !== undefined) data[k] = v;
                } catch (e) { }
            });
            const payload = {
                app: 'HoverVista',
                format: BACKUP_FORMAT_VERSION,
                scriptVersion: SCRIPT_VERSION,
                exportedAt: new Date().toISOString(),
                keys: data
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'HoverVista-配置备份-' + new Date().toISOString().slice(0, 10) + '.json';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
            showToast('已导出 ' + Object.keys(data).length + ' 项配置 📦');
        } catch (e) {
            showToast('导出失败：' + ((e && e.message) || e));
        }
    }

    // 把备份内容写回存储。成功返回 { ok, skipped }，失败返回 null（内部已提示）。
    function applyImportedConfig(payload) {
        const data = (payload && (payload.keys || payload.data)) || null;
        if (!data || typeof data !== 'object') { showToast('导入失败：配置内容为空'); return null; }
        let ok = 0, skipped = 0;
        Object.keys(data).forEach(k => {
            if (!isBackupKey(k)) { skipped++; return; }
            try {
                let v = data[k];
                // 站点参数走同一套校验，防止备份里的越界值被原样写回
                if (k.indexOf(BACKUP_KEY_PREFIX + 'config_') === 0 && v && typeof v === 'object') v = validateConfig(v);
                storageSet(k, v);
                ok++;
            } catch (e) { skipped++; }
        });
        if (ok === 0) { showToast('导入失败：没有可识别的配置项'); return null; }
        // 让当前会话立刻用上新配置，而不是等下次刷新
        loadConfig();
        loadState();
        try { bilibiliVolumeModule.setEnabled(storageGet('bilibili_volume_enabled', true)); } catch (e) { }
        return { ok, skipped };
    }

    function importConfigFromFile(file, onDone) {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { showToast('导入失败：文件超过 5MB'); return; }
        const reader = new FileReader();
        reader.onerror = () => showToast('导入失败：无法读取文件');
        reader.onload = () => {
            let payload = null;
            try { payload = JSON.parse(String(reader.result)); }
            catch (e) { showToast('导入失败：不是有效的 JSON 文件'); return; }
            if (!payload || payload.app !== 'HoverVista') { showToast('导入失败：这不是 HoverVista 的配置文件'); return; }
            if (typeof payload.format === 'number' && payload.format > BACKUP_FORMAT_VERSION) {
                showToast('导入失败：备份来自更新版本，请先升级脚本');
                return;
            }
            const res = applyImportedConfig(payload);
            if (res && typeof onDone === 'function') onDone(res);
        };
        reader.readAsText(file);
    }


    // ================
    // 2. ★★★ 触发资格判定（轮播 BUG 的根治点）★★★
    // ================
    // 此刻是否样式可见：fade 型轮播的 opacity:0 待播帧在这里被拒
    function isImgVisibleNow(img) {
        if (!img || !img.isConnected) return false;
        try {
            const cs = window.getComputedStyle(img);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            if (parseFloat(cs.opacity) < 0.05) return false;
            if (typeof img.checkVisibility === 'function' &&
                !img.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        } catch (e) { }
        return true;
    }

    function isImgClippedAway(img) {
        if (!img || !img.isConnected) return true;
        const ir = img.getBoundingClientRect();
        if (ir.width < 2 || ir.height < 2) return true;
        let node = img.parentElement;
        while (node && node !== document.body) {
            try {
                const cs = getComputedStyle(node);
                const hidden = (v) => v === 'hidden' || v === 'clip';
                if (hidden(cs.overflowX) || hidden(cs.overflowY)) {
                    const nr = node.getBoundingClientRect();
                    if (ir.right <= nr.left || ir.left >= nr.right ||
                        ir.bottom <= nr.top || ir.top >= nr.bottom) {
                        return true;
                    }
                }
            } catch (e) { }
            node = node.parentElement;
        }
        return false;
    }

    function inRect(x, y, r) {
        return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    // =================================================================
    // ★ 覆盖物性质判定（只服务触发资格，不碰状态机）
    // isMenuOverlay = 网站自己弹出的菜单/浮层 → 拦截
    // isBlankCover  = 无内容无样式的空白占位层 → 拦截
    // 半透明哑遮罩（淘宝类盖图场景）→ 明确放行，不误杀
    // canPierceBlocker = 装饰性空覆盖层（无文字、无媒体/交互子元素，且不在"覆盖式"语义浮层内）
    //                    → 允许穿透继续找下层图片，避免"图片被一层空 div 盖住就无法放大"
    // =================================================================

    // =============================
    // 🟡 COMPATIBILITY ZONE
    // 网站浮层/菜单兼容规则，谨慎修改
    // =============================
    function isMenuOverlay(el) {
        if (!el || el === document.body || el === document.documentElement) return false;

        // ★ el 自身是"空白透明层"时不是菜单：交给 isBlankCover 的规则
        //（pointer 覆盖层/轮播点击区放行），否则会被有背景的祖先连坐误杀
        if (isBlankCover(el)) return false;

        try {
            // 语义明确的 ARIA 浮层结构可以直接拦截。
            // 但 role="dialog" 常被 SPA 用作普通内容包裹层：仅当它确实是"覆盖式"(fixed/absolute)才拦截，
            // 否则会把包住卡片的 dialog 当成阻挡菜单，误杀其中的图片。
            const semLayer = el.closest('[role="menu"],[role="listbox"],[role="combobox"],[role="dialog"]');
            if (semLayer) {
                const srole = semLayer.getAttribute('role');
                if (srole === 'menu' || srole === 'listbox' || srole === 'combobox') return true;
                try {
                    const scs = getComputedStyle(semLayer);
                    if (scs.position === 'fixed' || scs.position === 'absolute') return true;
                } catch (e) { }
            }

            // ★ 向上检查有限层级：很多老式网站的弹窗实际命中的是内部
            // span/div/td，而真正的 fixed + z-index 浮层根节点在更上层。
            // 这样可阻止鼠标穿透弹窗去命中下面的图片。
            let node = el;
            let depth = 0;
            while (node && node !== document.body && node !== document.documentElement && depth < 12) {
                const cs = getComputedStyle(node);
                const positioned = cs.position === 'fixed' || cs.position === 'absolute';
                const zIndex = cs.zIndex !== 'auto' && parseFloat(cs.zIndex) > 0;
                const er = node.getBoundingClientRect();

                if (er.width >= 64 && er.height >= 32 && positioned && zIndex) {
                    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
                    const alpha = m ? (m[1].split(',').length === 4 ? parseFloat(m[1].split(',')[3]) : 1) : 0;
                    const visibleSurface = alpha > 0.5 || cs.backgroundImage !== 'none';
                    const semanticOverlay = node.matches && node.matches('[role="menu"],[role="listbox"],[role="combobox"],[role="dialog"]');
                    const keywordOverlay = node.matches && node.matches(
                        '[class*="dropdown" i],[class*="menu" i],[class*="popup" i],[class*="popover" i],[class*="subnav" i],' +
                        '[class*="modal" i],[class*="dialog" i],[class*="drawer" i],[class*="sheet" i],' +
                        '[class*="login" i],[class*="signin" i],[class*="sign-in" i],[class*="passport" i],' +
                        '[class*="float" i],[class*="layer" i],[class*="mask" i],[class*="panel" i],[class*="fwin" i]'
                    );

                    // ★ 关键词命中还须节点内有实际 UI 内容：
                    // 弹窗外壳(NGA #fwin_login 内含 form)→拦；空的半透明盖图遮罩→放行走路径C
                    const hasRealContent = node.querySelector
                        ? !!node.querySelector('form,input,select,textarea,button,a') || !!(node.textContent || '').trim()
                        : false;

                    if (visibleSurface || semanticOverlay || (keywordOverlay && hasRealContent)) return true;
                }
                node = node.parentElement;
                depth++;
            }
        } catch (e) { }
        return false;
    }

    function isBlankCover(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        try {
            const cs = getComputedStyle(el);

            // 必须完全不可见：无背景色/图、无边框、无阴影
            const bgT = cs.backgroundColor === 'transparent' ||
                cs.backgroundColor === 'rgba(0, 0, 0, 0)' ||
                /rgba\([^)]*,\s*0\)\s*$/.test(cs.backgroundColor);
            const invisible = bgT && cs.backgroundImage === 'none' &&
                parseFloat(cs.borderTopWidth) === 0 && cs.boxShadow === 'none';
            if (!invisible) return false;

            // 必须无内容：无文字、无任何媒体/交互子元素
            if (el.textContent && el.textContent.trim() !== '') return false;
            if (el.querySelector('img, svg, video, canvas, iframe, button, a, input, select, textarea')) return false;

            // ★ pointer 光标的透明层放行（轮播换页点击区多是这种，避免误杀）
            if (cs.cursor === 'pointer') return false;

            // ★ 轮播/滑块容器内的透明层一律放行
            if (el.closest('[class*="carousel"],[class*="slider"],[class*="swiper"],[class*="gallery"],[class*="slick"]')) return false;

            return true;
        } catch (e) { return false; }
    }

    function isHoverBlocker(el) {
        return isMenuOverlay(el) || isBlankCover(el);
    }

    // ★ 装饰性空覆盖层：无文字、无媒体/交互子元素。
    // 典型：盖在图片上的点击层 / 渐变浮层 / 空占位 div。
    // 例：Unsplash Discover 卡片 <figure><a><img></a><div class="overlay ..."></div></figure>
    // —— overlay 是 <a> 的兄弟节点，盖在图片上，会被判定为 blocker 而挡住放大。
    function isDecorativeCover(el) {
        if (!el || !el.querySelector) return false;
        try {
            if ((el.textContent || '').trim() !== '') return false;
            if (el.querySelector('img,svg,video,canvas,iframe,button,a,input,select,textarea,form,[role="button"],[role="link"]')) return false;
            return true;
        } catch (e) { return false; }
    }

    // ★ 是否允许"穿透"该拦截层继续找图：
    // 装饰性空层、且不在"覆盖式"语义浮层（菜单/弹窗/对话框，position:fixed/absolute）内 → 放行；
    // 真实菜单/弹窗即便内部为空也仍然拦截，避免悬停穿透浮层。
    function canPierceBlocker(el) {
        if (!isDecorativeCover(el)) return false;
        // ★ 仅对"覆盖式"的语义浮层拒绝穿透。
        // 若对任意 role=dialog/aria-modal 祖先都拒绝，被 dialog 包住的卡片会让覆盖层永远无法穿透。
        const sem = el.closest && el.closest('[role="menu"],[role="listbox"],[role="combobox"],[role="dialog"],[aria-modal="true"]');
        if (sem) {
            try {
                const cs = getComputedStyle(sem);
                if (cs.position === 'fixed' || cs.position === 'absolute') return false;
            } catch (e) { return false; }
        }
        return true;
    }

    // 实时资格：连接 + 样式可见 + 未被裁出可视区 + 尺寸达标 + 鼠标在实时矩形内
    // 祖先锚（遮罩盖图场景）：面积 ≤ 图片 8 倍、光标距图片矩形 ≤ 120px
    function canTriggerNow(img, x, y) {
        if (!isImgVisibleNow(img)) return null;
        const r = img.getBoundingClientRect();
        if (r.width < config.minOriginalSize || r.height < config.minOriginalSize) return null;

        if (inRect(x, y, r)) {
            return isImgClippedAway(img) ? null : img;
        }

        const PROXIMITY = 120;
        const imgArea = r.width * r.height;
        const nearImg = (rect) => x >= rect.left - PROXIMITY && x <= rect.right + PROXIMITY &&
            y >= rect.top - PROXIMITY && y <= rect.bottom + PROXIMITY;

        let node = img.parentElement;
        while (node && node !== document.body) {
            if (node.closest && node.closest('.image-zoom-container')) break;
            const nr = node.getBoundingClientRect();
            const nArea = nr.width * nr.height;
            if (inRect(x, y, nr) && nearImg(nr) && nArea <= imgArea * 8 &&
                nr.width < window.innerWidth * 0.9 && nr.height < window.innerHeight * 0.9) {
                return isImgClippedAway(img) ? null : node;
            }
            node = node.parentElement;
        }
        return null;
    }

    const COMMON_SELECTORS = [
        '[onclick*="zoom"]', '[onclick*="lightbox"]', '[onclick*="gallery"]', '[onclick*="preview"]',
        '[data-action*="zoom"]', '[data-lightbox]', '[data-gallery]', '[data-fancybox]',
        '.zoomable', '.lightbox', '.gallery-item', '.fancybox', '.stretched-link'
    ];

    function checkImageClickBehavior(img) {
        for (const selector of COMMON_SELECTORS) if (img.matches(selector)) return true;
        let parent = img.parentElement;
        while (parent && parent !== document.body) {
            const cls = (typeof parent.className === 'string' ? parent.className : (parent.getAttribute('class') || '')) || '';
            const pid = parent.id || '';
            if (/zoom|lightbox|gallery|fancybox|stretched-link/.test(cls) || /zoom|lightbox|gallery|fancybox/.test(pid)) return true;
            parent = parent.parentElement;
        }
        return false;
    }

    function isValidImage(img) {
        if (!img || img.tagName !== 'IMG' || !img.parentNode) return false;
        if (img.getClientRects().length === 0) return false;
        const style = window.getComputedStyle(img);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.05) return false;
        // ★ 优先 currentSrc：图片同时有 srcset 时，浏览器实际加载并渲染的是 currentSrc，
        // 而 src 可能是个从未被加载、甚至根本不是图片的兜底地址（用 src 会误判为无效图）。
        const src = img.currentSrc || img.src;
        if (!src || src.trim() === '') return false;
        // ★ data: URI：允许真实内联图片（data:image/*，含 SVG），仅拦截非图片 data: 与 1×1 占位/跟踪像素。
        //   旧版一刀切 `src.startsWith('data:')` 排除所有内联图，导致 data:image/svg+xml 等
        //   真实内联图永远不触发预览（2026-09-19 全功能实机测试问题 1）。
        if (src.startsWith('data:')) {
            if (!/^data:image\//i.test(src)) return false;                                     // 非图片 data: 一律拦截
            if (img.complete && img.naturalWidth <= 1 && img.naturalHeight <= 1) return false; // 1×1 占位/跟踪像素
        } else if (src.includes('placeholder')) {
            return false;
        }
        // ★ 文件型 1×1 占位/跟踪像素（2026-09-20 全覆盖实测 GAP-1）：
        //   原判据只写在 data: 分支，于是 `<img src="p1x1.png" width="280" height="200">`
        //   这类「1×1 被 CSS 撑大」的图能通过准入 → 预览弹出一个被拉伸到整屏的空白/纯色块，
        //   而且与 404 不同、它不会自动关闭（源图 complete 且 natural=1×1，走不到 ERROR）。
        //   这里把判据提升为通用分支：真实像素 ≤1×1 一律拦截。
        //   ⚠ 必须 naturalWidth > 0 —— naturalWidth===0 是「未加载/加载失败」，
        //   仍要留给后面的 GM 抓取救回逻辑，不能在此误拦（防盗链场景）。
        if (img.complete && img.naturalWidth > 0 && img.naturalWidth <= 1 && img.naturalHeight <= 1) return false;
        // 现代图片站可能给真实 <img> 设置 background-image 作为模糊/占位底图。
        // 只要 <img> 自身有真实 src、已加载且尺寸有效，就仍视为有效图片。
        // ★ 不再因「页面缩略图自身加载失败（防盗链 403 / 死链 / 仍在加载）」就判为无效图：
        //   这类图的 naturalWidth 为 0，但脚本会用 GM 身份重新抓取尝试救回（onerror 兜底）。
        //   真正无法预览的情况（无 src / data: / 占位图 / 不可见 / 尺寸过小）已在前面拦截。
        if (/^(?:javascript:|#)/i.test(src)) return false;
        const rect = img.getBoundingClientRect();
        return !(rect.width < 10 || rect.height < 10);
    }


    // 2. ★★★ 触发资格判定
    // ================
    // 3. 图片处理工具
    // ================
    // ================
    // URL 变换规则表（表驱动）
    // ================
    // 5.8.0 起把原先散在 upgradeImgUrl / cleanBgUrl / 高清升级内联链里的正则收编到此。
    // 目的：规则与执行分离，后续「阶段 2 规则包生态」可直接把这张表换成远程下发的 JSON。
    //
    // 规则格式：{ id, name, match, loop, steps: [[正则, 替换串], ...] }
    //   match  —— 命中条件；null 表示兜底（总是命中）
    //   loop   —— 为真时反复执行整组 steps，直到结果不再变化（处理多重叠加后缀）
    //   steps  —— 按序执行的 [正则, 替换]；正则自带 /g 时即全局替换
    const URL_RULES = [
        {
            id: 'alicdn',
            name: '阿里系 CDN 缩略图后缀',
            match: /alicdn\.com/i,
            loop: true,
            steps: [
                [/(_!![\w\-.,]+?\.(?:jpg|jpeg|png|webp))_[\w.\-]+$/i, '$1'],
                [/\.(jpg|jpeg|png|webp)_[\w.]+$/i, '.$1'],
                [/_\.(webp|jpg|jpeg|png)$/i, '']
            ]
        },
        {
            id: 'generic',
            name: '通用缩略图后缀',
            match: null,   // 兜底
            loop: true,
            steps: [
                [/![\w\-]+$/i, ''],
                [/_\d+x\d+(q\d+)?\.(jpg|jpeg|png|webp)(\.\w+)?$/i, ''],
                [/\.(jpg|jpeg|png|webp)_[\w.]+$/i, '.$1'],
                [/_\.(webp|jpg|jpeg|png)$/i, ''],
                [/\.webp$/i, '.jpg']
            ]
        }
    ];

    // 高清升级流水线：按顺序全跑（不是命中即停）
    const HD_UPGRADE_RULES = [
        {
            id: 'sized-dir',
            name: '尺寸目录 /s{宽}x{高}_',
            match: null, loop: false,
            steps: [[/\/s\d+x\d+_/g, '/']]
        },
        {
            id: 'avif',
            name: 'avif 后缀回落',
            match: null, loop: false,
            steps: [[/\.avif$/i, '']]
        },
        {
            id: 'remote-thumb',
            name: 'remote/thumb 缩略路径',
            match: null, loop: false,
            steps: [[/\/remote\/thumb\/\d+x\d+\//, '/']]
        },
        {
            // ★ 京东：请求与预览框上限一致的 CDN 高质量缩放档（s1200x1200，无水印）。
            //   s9999x9999 实测与 s1200 在同尺寸显示下锐度无差（拉普拉斯方差 9.02 vs 8.82），
            //   但 9999 图体积 20 倍、下载慢 → 两阶段显示的「源图拉伸糊窗」持续数秒（用户感知的模糊）。
            //   CDN 不放大超原图：小图请求 s1200 仍返回原尺寸。
            id: 'jd-s9999',
            name: '京东原图 s1200',
            match: /360buyimg\.com/,
            loop: false,
            steps: [[/^(\/\/[^/]+\/|[a-z][a-z0-9+.-]*:\/\/[^/]+\/).*?(jfs\/|g\d+\/)/i, '$1n1/s1200x1200_$2']]
        }
    ];

    // 执行单条规则（含 loop 收敛）
    // ★ 最近一次「规则真的改写了地址」的记录。
    //   用途：回答"规则在当前网站到底生效了吗"——面板会展示它。
    //   只在真实解析图片地址时记录；面板里的测试框不带 record，不会污染这里。
    let lastRuleHit = null;

    function applyUrlRule(url, rule, record) {
        let u = url, prev;
        do {
            prev = u;
            for (let i = 0; i < rule.steps.length; i++) {
                u = u.replace(rule.steps[i][0], rule.steps[i][1]);
            }
        } while (rule.loop && u !== prev);
        if (record && u !== url) {
            lastRuleHit = { id: rule.id, name: rule.name, from: url, to: u, at: Date.now() };
        }
        return u;
    }

    // 命中即停：取第一条 match 为 null 或能命中的规则（URL_RULES 语义）
    function applyFirstMatchedRule(url, rules, record) {
        for (let i = 0; i < rules.length; i++) {
            if (!rules[i].match || rules[i].match.test(url)) return applyUrlRule(url, rules[i], record);
        }
        return url;
    }

    // 顺序全跑：每条规则各自判断是否命中（HD_UPGRADE_RULES 语义）
    function applyUrlPipeline(url, rules, record) {
        let u = url;
        for (let i = 0; i < rules.length; i++) {
            const r = rules[i];
            if (r.match && !r.match.test(u)) continue;
            u = applyUrlRule(u, r, record);
        }
        return u;
    }

    // ★ 实际生效的规则表：默认＝内置；规则包加载后替换为「规则包规则（站专属，优先）+ 内置规则」
    let activeHdRules = HD_UPGRADE_RULES;
    let activeCleanRules = URL_RULES;

    // 高清升级入口：等价于旧的「s尺寸目录 → 去 avif → remote/thumb」三步链
    function upgradeImgUrl(url) {
        if (!url) return url;
        return applyUrlPipeline(url, activeHdRules, true);   // record=true：真实解析才记「最近命中」
    }

    // ============================================================
    // 防盗链绕过（浮图秀没有的能力）
    //   有些图床校验 Referer，页面上能显示的缩略图换了大图直连就 403/404。
    //   策略：直连失败时，用 GM_xmlhttpRequest 以「脚本身份」抓取（不受页面 Referer 限制），
    //        转成 blob URL 再交给 <img> 显示。带 LRU 缓存与静默回退（失败就保持源图，不影响主流程）。
    // ============================================================
    const BLOB_URL_CACHE = new Map();      // 原始 URL → blob URL
    const BLOB_CACHE_MAX = 24;

    function releaseBlobUrl(blobUrl) {
        if (!blobUrl) return;
        try { URL.revokeObjectURL(blobUrl); } catch (e) { }
        for (const [k, v] of BLOB_URL_CACHE) { if (v === blobUrl) { BLOB_URL_CACHE.delete(k); break; } }
    }

    function gmFetchBlobUrl(url) {
        return new Promise((resolve, reject) => {
            if (!url) return reject(new Error('empty url'));
            const hit = BLOB_URL_CACHE.get(url);
            if (hit) return resolve(hit);
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest unavailable'));
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                timeout: 15000,
                onload: (res) => {
                    try {
                        if (res.status >= 400 || !res.response) return reject(new Error('http ' + res.status));
                        const blobUrl = URL.createObjectURL(res.response);
                        if (BLOB_URL_CACHE.size >= BLOB_CACHE_MAX) {
                            const oldestKey = BLOB_URL_CACHE.keys().next().value;
                            const oldestVal = BLOB_URL_CACHE.get(oldestKey);
                            try { URL.revokeObjectURL(oldestVal); } catch (e) { }
                            BLOB_URL_CACHE.delete(oldestKey);
                        }
                        BLOB_URL_CACHE.set(url, blobUrl);
                        resolve(blobUrl);
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('gm fetch error')),
                ontimeout: () => reject(new Error('gm fetch timeout'))
            });
        });
    }

    // ============================================================
    // 智能高清升级器 v1（浮图秀没有的能力）
    //   单次「正则变换」只能赌一个地址；这里改为：生成多个候选 → 并行探测真实像素 →
    //   选「够用且最小」的那张（≥ 预览所需像素里最小的），都够不上就用最大的。
    //   好处：既不会因规则猜错而拿到小图，也不会为了清晰去抓一张巨图（省流量、加载快）。
    // ============================================================
    const HD_MAX_CANDIDATES = 4;

    function sizeHintOf(url) {
        const m = url.match(/\/s(\d+)x\d+_/i) || url.match(/[?&](?:w|width)=(\d+)/i) || url.match(/_(\d+)w\./i);
        if (!m) return 0;
        const n = parseInt(m[1], 10);
        return isNaN(n) ? 0 : n;
    }

    // 候选分两类：
    //   primary  —— 规则链各步的结果（人工/规则包策展出来的地址）
    //   variants —— 从 URL 里的尺寸指令推出来的更大档位（给「没有规则」或「规则结果不可用」时兜底）
    function buildHdCandidates(url) {
        const primary = [], variants = [];
        const pushTo = (arr) => (u) => {
            if (u && u !== url && arr.indexOf(u) < 0 && arr.length < HD_MAX_CANDIDATES) arr.push(u);
        };
        const pushP = pushTo(primary), pushV = pushTo(variants);
        let u = url;
        for (let i = 0; i < activeHdRules.length; i++) {
            const r = activeHdRules[i];
            if (r.match && !r.match.test(u)) continue;
            let nu = u;
            try { nu = applyUrlRule(u, r, false); } catch (e) { continue; }
            if (nu !== u) { u = nu; pushP(u); }
        }
        const hint = sizeHintOf(url);
        if (hint > 0) {
            [1200, 1600, 2400].forEach((t) => {
                if (t <= hint) return;
                const v = url.replace(/\/s\d+x\d+_/i, '/s' + t + 'x' + t + '_');
                if (v !== url) pushV(v);
            });
        }
        return { primary: primary, variants: variants };
    }

    // 并行探测候选：返回 [{url, w, h}]（失败的丢弃）。带整体超时，避免慢图拖住预览。
    function probeCandidates(list, timeoutMs) {
        return new Promise((resolve) => {
            const done = [];
            let left = list.length;
            const finish = () => resolve(done.filter(Boolean));
            if (!left) return finish();
            const timer = setTimeout(() => { if (left > 0) { left = 0; finish(); } }, timeoutMs || 3500);
            list.forEach((u, i) => {
                const im = new Image();
                const settle = (ok) => {
                    if (left <= 0) return;
                    if (ok) done[i] = { url: u, w: im.naturalWidth, h: im.naturalHeight };
                    left--;
                    if (left <= 0) { clearTimeout(timer); finish(); }
                };
                im.onload = () => settle(im.naturalWidth > 0 && im.naturalHeight > 0);
                im.onerror = () => settle(false);
                im.src = u;
            });
        });
    }

    // 择优选：优先「≥ 需求像素里最小的」，否则取最大的
    function pickBestCandidate(loaded, needMax) {
        if (!loaded || !loaded.length) return null;
        const need = Math.max(1, Number(needMax) || 0);
        const enough = loaded.filter((c) => Math.max(c.w, c.h) >= need)
            .sort((a, b) => Math.max(a.w, a.h) - Math.max(b.w, b.h));
        if (enough.length) return enough[0];
        return loaded.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    }

    function extractBgUrl(el) {
        if (!el || el.nodeType !== 1) return null;
        let m = (el.getAttribute('style') || '').match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
        let url = m ? m[1] : null;
        if (!url) {
            try {
                const bg = getComputedStyle(el).backgroundImage;
                if (bg && bg !== 'none') {
                    m = bg.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
                    if (m) url = m[1];
                }
            } catch (e) { }
        }
        return url ? cleanBgUrl(url) : null;
    }

    function cleanBgUrl(url) {
        // 与旧实现一致：先 trim 再去掉包裹引号，然后交给规则表（命中即停）
        const u = url.trim().replace(/^['"]|['"]$/g, '');
        return applyFirstMatchedRule(u, activeCleanRules);
    }

    // ============================================================
    // 规则包（阶段 2）
    //   远端：raw.githubusercontent.com/<repo>/main/rules/index.json
    //         + rules/<domain>.json（按域名一文件，方便 PR 贡献小 diff）
    //   作用：把「站点专属的图片地址变换规则」做成可更新的数据包，
    //         与内置规则合并后参与 cleanBgUrl / upgradeImgUrl。
    //   安全：远端只提供「正则 → 替换」的**数据**，不执行任何代码；
    //         拉取失败 / JSON 非法 / 正则编译失败一律保留现状，绝不影响基本功能。
    //   供应链加固：index.json 携带逐域 SHA-256 哈希 + 整包 ECDSA 签名（公钥内嵌本脚本），
    //         验签 / 哈希任一失败 → 整包拒绝并沿用旧缓存（见下方 HVSIGN 区块）。
    // ============================================================
    const RULE_PACK_URL = 'https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/rules/index.json';
    const RULE_PACK_URL_PREFIX = 'https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/rules/';
    const RULE_PACK_KEY = 'image_zoom_rule_pack_current';
    const RULE_PACK_PREV_KEY = 'image_zoom_rule_pack_prev';
    const RULE_PACK_META_KEY = 'image_zoom_rule_pack_meta';
    const RULE_PACK_MAX_STEPS = 60;      // 单条规则最多几步，防止恶意/失控数据
    const RULE_PACK_TIMEOUT = 12000;
    // ★ 防供应链护栏（补强）：步数上限挡不住「单个巨正则」的 ReDoS / 内存攻击，
    //   所以再加 pattern / replace 长度上限与单域规则条数上限——超限整条/整段丢弃。
    const RULE_PACK_MAX_PATTERN = 1000;  // 单个正则 pattern 最大长度
    const RULE_PACK_MAX_REPLACE = 500;   // 单个替换串最大长度
    const RULE_PACK_MAX_PER_DOMAIN = 50; // 单域 clean / hd 各自最多条数

    /* HVSIGN-BEGIN */
    // ===== 供应链加固：规则包签名校验（ECDSA P-256 + SHA-256，WebCrypto 原生） =====
    // 规则包发布流程：HoverVista-测试/rulepack-sign.js 对 rules/index.json 做两件事——
    //   ① 逐域文件算 SHA-256 写进 index.hashes；② 对「去掉 signature 后的规范化 JSON」整体签名。
    // 脚本端：先验签（index 整体），再逐文件比对哈希；任一步失败 → 整包拒绝、沿用旧缓存
    //（与拉取失败同等对待），面板会显示失败原因。私钥只在维护者本地，仓库里只有公钥能验的数据。
    const RULE_PACK_PUBKEY_SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMQjaMjNcAdjyvuhVpOzd4n6cyfKpuufMh+aMiAVN2m0MC/Z7072Hh0RIXcgzPZ4rAVm9bn+Cg9dN9nIdIq8wHQ==';

    function rulePackSha256Hex(str) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
            const arr = new Uint8Array(buf), out = [];
            for (let i = 0; i < arr.length; i++) out.push(arr[i].toString(16).padStart(2, '0'));
            return out.join('');
        });
    }

    // DER(0x30…) → P1363 裸 r||s（64 字节）；已是裸格式则原样返回
    function rulePackSigToRaw(sigBytes) {
        if (sigBytes.length === 64) return sigBytes;
        if (sigBytes[0] !== 0x30) throw new Error('sig-format');
        let i = 2;
        if (sigBytes[1] & 0x80) i = 2 + (sigBytes[1] & 0x7f);
        function nextInt() {
            if (sigBytes[i] !== 0x02) throw new Error('sig-format');
            const len = sigBytes[i + 1];
            const v = sigBytes.subarray(i + 2, i + 2 + len);
            i += 2 + len;
            return v;
        }
        const r = nextInt(), s = nextInt();
        const out = new Uint8Array(64);
        out.set(r.length > 32 ? r.subarray(r.length - 32) : r, 32 - Math.min(32, r.length));
        out.set(s.length > 32 ? s.subarray(s.length - 32) : s, 64 - Math.min(32, s.length));
        return out;
    }

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // index 整体验签；resolve 即通过，reject 带 sig-* 原因
    function verifyRulePackIndexSignature(index) {
        if (typeof crypto === 'undefined' || !crypto.subtle) return Promise.reject(new Error('sig-unsupported'));
        if (!index || typeof index.signature !== 'string' || !index.signature) return Promise.reject(new Error('sig-missing'));
        if (index.alg !== 'ECDSA-P256-SHA256') return Promise.reject(new Error('sig-alg'));
        const payload = Object.assign({}, index);
        delete payload.signature;
        const data = new TextEncoder().encode(JSON.stringify(payload));
        let spki, sig;
        try {
            spki = b64ToBytes(RULE_PACK_PUBKEY_SPKI);
            sig = b64ToBytes(index.signature);
        } catch (e) { return Promise.reject(new Error('sig-format')); }
        return crypto.subtle.importKey('spki', spki.buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
            .then(function (key) {
                let rawSig;
                try { rawSig = rulePackSigToRaw(sig); } catch (e) { throw new Error('sig-format'); }
                return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSig, data)
                    .then(function (ok) { if (!ok) throw new Error('sig-invalid'); });
            });
    }

    // 单个域文件哈希校验（与 index.hashes[domain] 比对）
    function verifyRulePackFileHash(rawText, domain, index) {
        const hashes = index && index.hashes;
        if (!hashes || typeof hashes[domain] !== 'string') return Promise.reject(new Error('hash-missing:' + domain));
        return rulePackSha256Hex(rawText).then(function (hex) {
            if (hex !== hashes[domain].toLowerCase()) throw new Error('hash-mismatch:' + domain);
        });
    }
    /* HVSIGN-END */

    function packStepToInternal(step) {
        // 远端格式：[pattern, flags, replace]
        if (!Array.isArray(step) || typeof step[0] !== 'string') return null;
        if (step[0].length > RULE_PACK_MAX_PATTERN) return null;
        const flags = typeof step[1] === 'string' ? step[1].replace(/[^gimsuy]/g, '') : '';
        const replace = typeof step[2] === 'string' ? step[2] : '';
        if (replace.length > RULE_PACK_MAX_REPLACE) return null;
        try { return [new RegExp(step[0], flags), replace]; } catch (e) { return null; }
    }

    // 把远端的一条规则转成内部格式；任何非法字段都丢弃该规则
    function packRuleToInternal(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const rawSteps = Array.isArray(raw.steps) ? raw.steps.slice(0, RULE_PACK_MAX_STEPS) : [];
        const steps = rawSteps.map(packStepToInternal).filter(Boolean);
        if (!steps.length) return null;
        let match = null;
        if (typeof raw.match === 'string' && raw.match) {
            try { match = new RegExp(raw.match, 'i'); } catch (e) { match = null; }
        }
        return {
            id: 'pack:' + (raw.id || 'rule'),
            name: raw.name || '规则包规则',
            match,
            loop: raw.loop === true,
            steps
        };
    }

    // 域名是否匹配（后缀匹配：sub.bilibili.com 命中 bilibili.com）
    // 兼容品牌式键名（无 TLD，如 jd / pinterest）：按整段标签包含，命中 www.jd.com / pinterest.com
    function packDomainMatches(domain, candidate) {
        if (!candidate || !domain) return false;
        if (domain === candidate || domain.endsWith('.' + candidate)) return true;
        return candidate.length >= 2 && ('.' + domain + '.').indexOf('.' + candidate + '.') >= 0;
    }

    // 重新计算「实际生效的规则表」：用户规则 > 站专属规则包规则 > 内置规则
    function rebuildEffectiveRules() {
        const domain = currentDomain;
        const pack = rulePackState.current;
        let clean = URL_RULES.slice();
        let hd = HD_UPGRADE_RULES.slice();
        if (pack && Array.isArray(pack.domains)) {
            for (let i = 0; i < pack.domains.length; i++) {
                const entry = pack.domains[i];
                if (!entry || !packDomainMatches(domain, entry.domain)) continue;
                const extraClean = (entry.clean || []).map(packRuleToInternal).filter(Boolean);
                const extraHd = (entry.hd || []).map(packRuleToInternal).filter(Boolean);
                clean = extraClean.concat(clean);   // 站专属命中即停 → 放前面
                hd = extraHd.concat(hd);            // 顺序全跑 → 站专属先跑
            }
        }
        // ★ 用户自定义规则优先级最高（用户明确为自己这台机器加的，应当先于一切生效）
        const userRules = (config && config.userUrlRules) || [];
        const userClean = [], userHd = [];
        userRules.forEach(function (r) {
            if (r.enabled === false) return;
            // ★ 作用域：scope='site' 只在记录的 domain 生效（面板默认「仅本站」）；'global' 才对所有站点生效
            if (r.scope === 'site' && r.domain && !packDomainMatches(currentDomain, r.domain)) return;
            const internal = packRuleToInternal({
                id: r.id, name: r.label || '自定义规则', loop: false,
                steps: [[r.pattern, r.flags, r.replace]]
            });
            if (!internal) return;
            (r.phase === 'clean' ? userClean : userHd).push(internal);
        });
        clean = userClean.concat(clean);
        hd = userHd.concat(hd);

        activeCleanRules = clean;
        activeHdRules = hd;
        return { clean: clean.length, hd: hd.length, userClean: userClean.length, userHd: userHd.length };
    }

    const rulePackState = {
        current: null,   // { version, updatedAt, domains: [...] }
        meta: null,      // { fetchedAt, source, version, error }
        loading: false
    };

    function loadRulePackFromStorage() {
        rulePackState.current = storageGet(RULE_PACK_KEY, null) || null;
        rulePackState.meta = storageGet(RULE_PACK_META_KEY, null) || null;
        rebuildEffectiveRules();
    }

    // 拉取（GM_xmlhttpRequest）→ 解析 → 校验 → 落盘 → 生效
    // 说明：不使用 fetch，因为用户脚本运行环境里 GM_xmlhttpRequest 才能正确处理跨域与 @connect
    function fetchRulePackText(url) {
        return new Promise(function (resolve, reject) {
            try {
                if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('no-gm-xhr')); return; }
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: RULE_PACK_TIMEOUT,
                    headers: { 'Accept': 'application/json' },
                    onload: function (res) {
                        if (res.status >= 200 && res.status < 300 && typeof res.responseText === 'string') resolve(res.responseText);
                        else reject(new Error('http-' + res.status));
                    },
                    ontimeout: function () { reject(new Error('timeout')); },
                    onerror: function () { reject(new Error('network')); }
                });
            } catch (e) { reject(e); }
        });
    }

    function updateRulePack(manual) {
        if (rulePackState.loading) return Promise.resolve({ ok: false, reason: 'busy' });
        rulePackState.loading = true;
        return fetchRulePackText(RULE_PACK_URL + '?t=' + Date.now()).then(async function (text) {
            let index;
            try { index = JSON.parse(text); } catch (e) { throw new Error('index-json'); }
            if (!index || !Array.isArray(index.domains)) throw new Error('index-shape');
            // ★ 供应链加固第一步：index 整体验签，签名不符 → 整包拒绝（沿用旧缓存）
            await verifyRulePackIndexSignature(index);
            const version = Number(index.version) || 0;
            const prevMeta = rulePackState.meta || {};
            // 只拉取「当前域名」相关的规则文件，避免整包下载
            const wanted = index.domains.filter(function (d) {
                return typeof d === 'string' && packDomainMatches(currentDomain, d);
            });
            // ★「版本相同→跳过」的前提：缓存里已有【当前站点】匹配的规则。
            //   缓存是全局的、domains 是「当时那个站」的——否则 A 站更新后访问 B 站会被短路，
            //   B 永远拉不到自己的规则；一次网络抖动也会把空 domains 固化进缓存。
            const cachedDomains = (rulePackState.current && rulePackState.current.domains) || [];
            const cachedMatch = cachedDomains.some(function (e) { return e && e.domain && packDomainMatches(currentDomain, e.domain); });
            if (!manual && version && prevMeta.version === version && rulePackState.current
                && (wanted.length === 0 || cachedMatch)) {
                rulePackState.loading = false;
                return { ok: true, unchanged: true, version: version };
            }
            return Promise.all(wanted.map(function (d) {
                return fetchRulePackText(RULE_PACK_URL_PREFIX + encodeURIComponent(d) + '.json')
                    .then(function (t2) {
                        const o = JSON.parse(t2);
                        return (o && typeof o === 'object') ? { raw: t2, obj: o } : null;
                    })
                    .catch(function () { return null; });
            })).then(async function (files) {
                // ★ 供应链加固第二步：逐域文件哈希校验（比对 index.hashes，防单文件被篡改/投毒）
                for (let fi = 0; fi < files.length; fi++) {
                    if (!files[fi]) continue; // 拉取失败的照旧跳过
                    await verifyRulePackFileHash(files[fi].raw, wanted[fi], index);
                }
                const domains = files.filter(Boolean).map(function (f) {
                    const o = f.obj;
                    return { domain: String(o.domain || ''), label: String(o.label || ''), clean: Array.isArray(o.clean) ? o.clean.slice(0, RULE_PACK_MAX_PER_DOMAIN) : [], hd: Array.isArray(o.hd) ? o.hd.slice(0, RULE_PACK_MAX_PER_DOMAIN) : [] };
                }).filter(function (e) { return e.domain; });
                const next = { version: version, updatedAt: String(index.updatedAt || ''), domains: domains };
                // ★ 回滚点：把「当前」挪到「上一版」再覆盖
                const old = rulePackState.current;
                if (old) storageSet(RULE_PACK_PREV_KEY, old);
                storageSet(RULE_PACK_KEY, next);
                const meta = { fetchedAt: Date.now(), source: 'remote', version: version, at: next.updatedAt, domains: domains.map(function (d) { return d.domain; }), verified: true };
                storageSet(RULE_PACK_META_KEY, meta);
                rulePackState.current = next;
                rulePackState.meta = meta;
                const eff = rebuildEffectiveRules();
                rulePackState.loading = false;
                return { ok: true, version: version, domains: meta.domains, clean: eff.clean, hd: eff.hd };
            });
        }).catch(function (e) {
            rulePackState.loading = false;
            const meta = Object.assign({}, rulePackState.meta || {}, { lastError: String(e && e.message || e), lastErrorAt: Date.now() });
            rulePackState.meta = meta;
            storageSet(RULE_PACK_META_KEY, meta);
            return { ok: false, reason: String(e && e.message || e) };
        });
    }

    // 回滚到上一版规则包
    function rollbackRulePack() {
        const prev = storageGet(RULE_PACK_PREV_KEY, null);
        if (!prev) return { ok: false, reason: 'no-prev' };
        const cur = rulePackState.current;
        storageSet(RULE_PACK_KEY, prev);
        if (cur) storageSet(RULE_PACK_PREV_KEY, cur);
        rulePackState.current = prev;
        const meta = Object.assign({}, rulePackState.meta || {}, { source: 'rollback', version: prev.version || 0, rolledBackAt: Date.now() });
        rulePackState.meta = meta;
        storageSet(RULE_PACK_META_KEY, meta);
        rebuildEffectiveRules();
        return { ok: true, version: prev.version || 0 };
    }


// 修复记录：本函数此前在文件内被重复定义两次（旧的一份带滚轮保护分支、被后一份整体覆盖），
// 现已合并为唯一实现——两份的行为分支都保留在这里，不会再出现“改了不生效”的副本。
    function cropBlackBars(imgEl) {
        try {
            if (imgEl.dataset.zoomCropped) return;
            const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
            if (!w || !h) return;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(imgEl, 0, 0);
            let data;
            try {
                data = ctx.getImageData(0, 0, w, h).data;
            } catch (e) {
                // ★ 跨域污染：无 crossOrigin 的跨域图 drawImage 后 canvas 被 taint，
                //   getImageData 抛 SecurityError（真实网站图基本都跨域 → 此前黑边永远裁不掉，
                //   竖图带黑边比例直接撑高容器超页；这是 test.98 用本地同源图测不出的盲区）。
                //   改用 GM_xmlhttpRequest 抓成同源 blob 再读像素裁剪（用户脚本特权，绕过 CORS）。
                cropBlackBarsViaGm(imgEl, w, h);
                return;
            }
            performBlackCrop(imgEl, imgEl, w, h, data);
        } catch (e) { }
    }

    // ★ 黑边裁剪主体：拿到「可读像素 data」后执行扫描 + 裁剪 + 布局。
    //   同源图由 cropBlackBars 直读调用；跨域图由 cropBlackBarsViaGm 用 GM 抓的 proxy 图调用。
    //   srcImg = 用来 drawImage 出裁剪结果的「同源」图源（同源时是 imgEl，跨域时是 proxy）——
    //   必须同源，否则 out.drawImage 会再次污染 canvas、toBlob 失败。
    function performBlackCrop(imgEl, srcImg, w, h, data) {
        try {
            let transparentCount = 0;
            const total = w * h, step = Math.max(1, Math.floor(total / 20000));
            let sampled = 0;
            for (let i = 0; i < total; i += step) {
                if (data[i * 4 + 3] < 10) transparentCount++;
                sampled++;
            }
            if (transparentCount / sampled > 0.05) return;
            // ★ 阈值放宽（test.105）：原 24 会把「不纯黑的黑边」（JPEG 压缩 / 深灰边框，RGB 25~40）
            //   判成内容 → 该侧黑边裁不掉（表现为「上面裁了下面没裁」）。提到 36 容忍常见不纯黑边。
            const threshold = 36;
            const isContent = (i) => data[i + 3] > 10 &&
                (data[i] > threshold || data[i + 1] > threshold || data[i + 2] > threshold);
            // ★ 判「整行/整列是否为黑边」：内容像素占比 < 15%（BAR_RATIO）
            //   或 整行/整列平均亮度 < 42（BAR_LUMA，覆盖「宽但整体很暗的不纯黑边」）即算黑边。
            //   （旧写法「是否含任一内容像素」只要 1 个亮点就判内容 → 该侧永远裁不掉。）
            const BAR_RATIO = 0.15;
            const BAR_LUMA = 42;   // 平均亮度(0~255)低于此值 → 直接判为黑边
            const rowIsBar = (y0) => {
                let cnt = 0, sum = 0;
                for (let x0 = 0; x0 < w; x0++) {
                    const i = (y0 * w + x0) * 4;
                    if (isContent(i)) cnt++;
                    sum += data[i] + data[i + 1] + data[i + 2];
                }
                return cnt < w * BAR_RATIO || (sum / (w * 3)) < BAR_LUMA;
            };
            // ★ 桥接扫描（test.106）：允许跳过黑边内部「孤立的内容行/列」（水印 / 文字 / 噪点带），
            //   只要跳过后仍能回到黑边行。真实案例：683×1500 论坛图，底部黑边 927~1499 共 573 行，
            //   但在 1480~1484 有一条 5 行的水印 → 旧「逐行连续」扫描在此停下，
            //   只裁了最底 15 行，整段下半黑边全留下（表现为「只裁上半」）。
            //   规则：连续非黑边行数 ≤ maxGap 时可跳过；超过则判定进入真实内容区、回退到最后一个黑边行。
            const MAX_GAP_R = Math.max(3, Math.round(h * 0.03));
            const MAX_GAP_C = Math.max(3, Math.round(w * 0.03));
            const scanEdge = (start, dir, len, isBarFn, maxGap) => {
                let pos = start, lastBar = start - dir, gap = 0;
                while (pos >= 0 && pos < len) {
                    if (isBarFn(pos)) { lastBar = pos; gap = 0; }
                    else { gap++; if (gap > maxGap) break; }
                    pos += dir;
                }
                return lastBar;   // 最后一个黑边行/列的位置（无则 start-dir）
            };
            // 阶段①：先裁上下黑边（行）
            let top = scanEdge(0, 1, h, rowIsBar, MAX_GAP_R) + 1;
            if (top >= h) return;
            let bottom = scanEdge(h - 1, -1, h, rowIsBar, MAX_GAP_R) - 1;
            if (bottom < top) return;
            // 阶段②：再裁左右黑边（列）—— ★ 只在已确定的 [top,bottom] 内容行范围内判定。
            //   否则「上下各占大半黑边」的图（本案例 74% 是黑边）会把**每一列**的内容占比与
            //   平均亮度都拉到黑边水平 → 整幅图所有列被判成黑边（实测宽 683 → 94，图被裁成一条）。
            const innerH = bottom - top + 1;
            const colIsBar = (x0) => {
                let cnt = 0, sum = 0;
                for (let y0 = top; y0 <= bottom; y0++) {
                    const i = (y0 * w + x0) * 4;
                    if (isContent(i)) cnt++;
                    sum += data[i] + data[i + 1] + data[i + 2];
                }
                return cnt < innerH * BAR_RATIO || (sum / (innerH * 3)) < BAR_LUMA;
            };
            let left = scanEdge(0, 1, w, colIsBar, MAX_GAP_C) + 1;
            let right = scanEdge(w - 1, -1, w, colIsBar, MAX_GAP_C) - 1;
            // ★ 单边最多裁 45%（旧值 25% 会把「超过 1/4 的大黑边」裁不干净，只裁掉一部分）
            const CROP_CAP = 0.45;
            top = Math.min(top, Math.floor(h * CROP_CAP));
            bottom = Math.max(bottom, h - 1 - Math.floor(h * CROP_CAP));
            left = Math.min(left, Math.floor(w * CROP_CAP));
            right = Math.max(right, w - 1 - Math.floor(w * CROP_CAP));
            const cw = right - left + 1, ch = bottom - top + 1;
            if (cw >= w * 0.9 && ch >= h * 0.9) return;
            if (cw < 20 || ch < 20) return;
            const out = document.createElement('canvas');
            out.width = cw;
            out.height = ch;
            out.getContext('2d').drawImage(srcImg, left, top, cw, ch, 0, 0, cw, ch);
            imgEl.dataset.zoomCropped = '1';
            out.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                if (imgEl.__zoomBlobUrl) URL.revokeObjectURL(imgEl.__zoomBlobUrl);
                imgEl.__zoomBlobUrl = url;
                imgEl.src = url;
                // ★ 滚轮缩放模式：裁剪完成后绝不能重新按容器 contain 重排。
                // 否则异步 toBlob 回调会把用户刚刚滚轮放大的尺寸重置，表现为
                // “第一滚轮先缩小一点”，竖图甚至会直接跳回最小尺寸。
                // 同时让容器始终与实际图片尺寸一致，避免出现透明的大框。
                // 注：当前唯一调用点是 !inst.wheelZoom 分支，所以下面这段滚轮保护
                // 目前不会进入；保留它是为了保证将来放开“滚轮 + 裁剪”时尺寸语义仍然正确。
                const box = imgEl.parentNode;
                const activeInst = box && box.__zoomInstance;
                if (box && box.classList.contains('image-zoom-container') && activeInst && activeInst.wheelZoom) {
                    const currentZoom = Number.isFinite(activeInst.currentZoom) ? activeInst.currentZoom : 1;
                    const visualW = parseFloat(imgEl.style.width) || box.clientWidth || w;
                    // ★ 必须按「裁剪后」的比例 cw/ch 重算容器与图片尺寸。
                    //   旧写法沿用裁剪前的 visualW/visualH（带黑边的比例）再配 object-fit:fill
                    //   → 裁剪后的图被拉伸回旧比例，且容器仍按「含黑边的高度」占位 → 依旧超出页面。
                    //   这里保持当前显示尺度、改用裁剪后比例，并等比收进可用空间
                    //   （自适应语义：自动尺寸不超视口；信息栏高度一并预留）。
                    const scale = Math.max(0.01, visualW / Math.max(1, w));
                    const availW = Math.max(160, window.innerWidth - 60);
                    const availH = Math.max(160, window.innerHeight - 60 - capbarReserve());
                    let nw = Math.max(1, Math.round(cw * scale));
                    let nh = Math.max(1, Math.round(ch * scale));
                    const kFit = Math.min(1, availW / nw, availH / nh);
                    if (kFit < 1) { nw = Math.max(1, Math.round(nw * kFit)); nh = Math.max(1, Math.round(nh * kFit)); }
                    activeInst.zoomBaseW = Math.max(1, nw / currentZoom);
                    activeInst.zoomBaseH = Math.max(1, nh / currentZoom);
                    box.style.setProperty('width', nw + 'px', 'important');
                    box.style.setProperty('height', nh + 'px', 'important');
                    box.style.setProperty('max-width', 'none', 'important');
                    box.style.setProperty('max-height', 'none', 'important');
                    box.style.setProperty('overflow', 'visible', 'important');
                    imgEl.style.setProperty('width', nw + 'px', 'important');
                    imgEl.style.setProperty('height', nh + 'px', 'important');
                    imgEl.style.setProperty('left', '0px', 'important');
                    imgEl.style.setProperty('top', '0px', 'important');
                    imgEl.style.setProperty('object-fit', 'fill', 'important');
                } else if (box && box.classList.contains('image-zoom-container')) {
                    // 容器尺寸保持不变（尊重当前模式的尺寸语义），
                    // 只按新宽高比在容器内做 contain 重排
                    const bw = box.clientWidth, bh = box.clientHeight;
                    const ratio = cw / ch;
                    let nw = bw, nh = Math.round(bw / ratio);
                    if (nh > bh) { nh = bh; nw = Math.round(bh * ratio); }
                    imgEl.style.width = nw + 'px';
                    imgEl.style.height = nh + 'px';
                    imgEl.style.left = Math.round((bw - nw) / 2) + 'px';
                    imgEl.style.top = Math.round((bh - nh) / 2) + 'px';
                }
            }, 'image/jpeg', 0.92);
        } catch (e) { }
    }

    // ★ 跨域图的黑边裁剪：GM_xmlhttpRequest 抓成同源 blob → 加载 proxy 图 → 读像素 → 走同一裁剪主体。
    //   只对 http(s) 跨域图启用；data:/blob: 本就同源（不会触发污染分支），无需处理。
    //   GM 抓取失败（断网/防盗链且 GM 也被拒）则放弃裁剪，保留原图，不影响预览本身。
    function cropBlackBarsViaGm(imgEl, w, h) {
        try {
            if (imgEl.dataset.zoomCropGm) return;   // 防重入（同一张图只抓一次）
            const src = imgEl.src;
            if (!/^https?:/i.test(src)) return;
            imgEl.dataset.zoomCropGm = '1';
            gmFetchBlobUrl(src).then((blobUrl) => {
                const proxy = new Image();
                proxy.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        ctx.drawImage(proxy, 0, 0);
                        const data = ctx.getImageData(0, 0, w, h).data;   // blob 同源，不污染
                        performBlackCrop(imgEl, proxy, w, h, data);
                    } catch (e) { }
                };
                proxy.onerror = () => { };
                proxy.src = blobUrl;
            }).catch(() => { });
        } catch (e) { }
    }


    // ================
    // 7. 站点规则（背景图模式）
    // ================
    const SITE_HOVER_PROXY_RULES = [
        {
            domains: ['taobao.com', 'tmall.com'],
            itemSelector: '.img-wrapper',
            cardSelector: '.tb-pick-content-item, li',
            pollInterval: 300
        }
    ];

    function getCustomRules() {
        try { return storageGet('image_zoom_custom_rules', []); } catch (e) { return []; }
    }
    function saveCustomRules(rules) {
        storageSet('image_zoom_custom_rules', rules);
    }

    // ★ 空字符串选择器不能直接丢给 closest()/querySelectorAll()：
    // closest('') 会抛 SyntaxError（"The provided selector is empty"）。
    // 规则里的卡片选择器允许留空（拾取器找不到卡片祖先时正是存空串），
    // 统一在这里归一为「非空字符串 或 null」，使用处再按 null 跳过。
    function toSelector(v) {
        return (typeof v === 'string' && v.trim()) ? v.trim() : null;
    }


    // ================
    // 背景图悬停模块
    // ================

    function setupBgRuleProxy() {
        const customRules = getCustomRules()
            .filter(r => r.enabled && r.imgMode === 'background')
            .map(r => ({
                domains: String(r.domains || '').split(',').map(s => s.trim()).filter(Boolean),
                itemSelector: toSelector(r.itemSelector),
                cardSelector: toSelector(r.cardSelector),
                pollInterval: Math.max(100, parseInt(r.pollInterval) || 300)
            }))
            .filter(r => r.itemSelector && r.domains.length);

        const domainMatch = (r) => r.domains.some(d => currentDomain === d || currentDomain.endsWith('.' + d));
        const rule = customRules.find(domainMatch) || SITE_HOVER_PROXY_RULES.find(domainMatch);
        if (!rule) return;

        let lastBgCard = null, bgDelayTimer = null;

        setInterval(() => {
            if (document.hidden) return;
            if (!pointerInWindow) return;   // ★ 光标不在浏览器内，不做背景图识别
            if (!isEnabled || isHomepageZoomDisabled()) return;
            if (zoomFSM.hasActiveZoom()) return;
            const x = lastMouse.x, y = lastMouse.y;
            if (x < 0) return;
            const el = document.elementFromPoint(x, y);
            if (!el || !el.closest) return;

            let wrapper = el.closest(rule.itemSelector);
            if (!wrapper) {
                // ★ 卡片选择器可能为空（归一为 null），空串会让 closest() 抛 SyntaxError，
                // 而定时代码每 pollInterval 跑一次，异常会持续刷控制台。
                const card0 = rule.cardSelector ? el.closest(rule.cardSelector) : null;
                if (card0) {
                    const w = card0.querySelector(rule.itemSelector);
                    if (w) {
                        const r = w.getBoundingClientRect();
                        if (inRect(x, y, r)) wrapper = w;
                    }
                }
            }

            if (wrapper) {
                const card = (rule.cardSelector ? el.closest(rule.cardSelector) : null) || wrapper;
                if (card !== lastBgCard) {
                    lastBgCard = card;
                    bgZoomLayer.hide();
                    if (bgDelayTimer) clearTimeout(bgDelayTimer);
                    const mx = x, my = y;
                    bgDelayTimer = setTimeout(() => {
                        bgDelayTimer = null;
                        if (Math.abs(lastMouse.x - mx) < 20 && Math.abs(lastMouse.y - my) < 20) {
                            const url = extractBgUrl(wrapper);
                            if (url) bgZoomLayer.show({ cleaned: url, raw: url }, 1);
                        } else {
                            // ★ 本次延迟显示已放弃，lastBgCard 必须回滚：
                            // 否则回到同一张卡片时 card === lastBgCard，背景图放大永久失效。
                            lastBgCard = null;
                        }
                    }, config.delay);
                }
            } else {
                const card = rule.cardSelector ? el.closest(rule.cardSelector) : null;
                if (!card || !card.querySelector(rule.itemSelector)) {
                    if (bgDelayTimer) { clearTimeout(bgDelayTimer); bgDelayTimer = null; }
                    bgZoomLayer.hide();
                    lastBgCard = null;
                }
            }
        }, rule.pollInterval);
    }

    // ================
    // 8. 背景图自动识别兜底
    // ================
    const bgZoomLayer = (function() {
        let container = null, url = null;

        function hide() {
            url = null;
            if (!container) return;
            const c = container;
            container = null;
            const im = c.querySelector('img');
            if (im) im.style.transform = 'scale(.6)';
            c.style.opacity = '0';
            setTimeout(() => c.remove(), 280);
        }

        function show(loadUrls, zOffset) {
            if (container && !container.isConnected) { container = null; url = null; }
            if (container && url === loadUrls.cleaned) return;
            hide();
            zoomFSM.dispatch('RESET'); // 背景图接管前硬重置 FSM，避免悬空引用
            const c = document.createElement('div');
            c.className = 'image-zoom-container';
            c.dataset.izOwner = 'bg';
            c.style.cssText = `position:fixed;inset:0;z-index:${config.zoomZIndex - (zOffset || 1)};opacity:0;
                transition:all .3s ease;pointer-events:none;display:flex;justify-content:center;align-items:center;
                padding:20px;box-sizing:border-box;`;
            const big = document.createElement('img');
            big.style.cssText = `max-width:${Math.min(window.innerWidth - 60, config.maxWidth)}px;
                max-height:${Math.min(window.innerHeight - 60, config.maxHeight)}px;object-fit:contain;border-radius:12px;
                image-rendering:auto;
                box-shadow:0 10px 34px rgba(0,0,0,.30),0 3px 10px rgba(0,0,0,.20),0 0 0 1px rgba(255,255,255,.10);`;
            let triedFallback = false;
            big.onerror = () => {
                if (!triedFallback && loadUrls.raw && loadUrls.raw !== big.src) {
                    triedFallback = true;
                    big.src = loadUrls.raw;
                    return;
                }
                hide();
            };
            big.onload = () => requestAnimationFrame(() => {
                c.style.opacity = '1';
            });
            big.src = loadUrls.cleaned;
            c.appendChild(big);
            document.body.appendChild(c);
            container = c;
            url = big.src;
        }

        return { show, hide };
    })();

    function setupAutoBackgroundHover() {
        let bgTimer = null, pendingUrl = null;
        const cancelBg = () => {
            if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
            pendingUrl = null;
        };

        document.addEventListener('mouseover', throttleLeading((e) => {
            if (!isEnabled || isHomepageZoomDisabled()) { cancelBg(); bgZoomLayer.hide(); return; }
            if (config.avoidClickConflict && isImageInLightboxMode()) { cancelBg(); bgZoomLayer.hide(); return; }
            if (e.target.closest && e.target.closest('#zoomDockZone, #izModalOverlay, #izIntroOverlay, #izUpdateNotice, #izHelpModal, .image-zoom-container')) return;
            if (isHoverBlocker(e.target) && !canPierceBlocker(e.target)) { cancelBg(); bgZoomLayer.hide(); return; }
            if (zoomFSM.hasActiveZoom()) { cancelBg(); return; }

            const x = e.clientX, y = e.clientY;
            // 光标下已有合格 img → 不做背景图识别
            if (pickVisibleImgUnderPoint(x, y)) { cancelBg(); return; }

            if (!(e.target instanceof Element)) { cancelBg(); return; }

            let node = e.target, bgEl = null, bgFromSibling = false;
            while (node && node !== document.body) {
                try {
                    const bg = getComputedStyle(node).backgroundImage;
                    if (bg && bg !== 'none' && bg.includes('url(')) { bgEl = node; break; }
                } catch (err) { }
                if (node.querySelectorAll) {
                    const kids = node.querySelectorAll('*');
                    if (kids.length <= 500) {
                        for (const kid of kids) {
                            if (kid === node) continue;
                            try {
                                const bg2 = getComputedStyle(kid).backgroundImage;
                                if (bg2 && bg2 !== 'none' && bg2.includes('url(')) {
                                    const kr = kid.getBoundingClientRect();
                                    if (kr.width >= 120 && kr.height >= 120 && inRect(x, y, kr)) {
                                        bgEl = kid;
                                        bgFromSibling = true;
                                        break;
                                    }
                                }
                            } catch (err) { }
                        }
                        if (bgEl) break;
                    }
                }
                node = node.parentElement;
            }
            if (!bgEl) { cancelBg(); bgZoomLayer.hide(); return; }

            if (!bgFromSibling) {
                const cs = getComputedStyle(bgEl);
                if (cs.backgroundRepeat.split(' ').some(v => v.startsWith('repeat') && v !== 'no-repeat')) {
                    cancelBg(); bgZoomLayer.hide(); return;
                }
                if (cs.backgroundPosition !== '0% 0%' && cs.backgroundSize !== 'cover' &&
                    cs.backgroundSize !== 'contain' && cs.backgroundSize !== '100% 100%') {
                    cancelBg(); bgZoomLayer.hide(); return;
                }
            }

            // 占屏接近全屏的背景基本是装饰底图，放大只会挡住页面内容，不是用户意图
            try {
                const br = bgEl.getBoundingClientRect();
                const vw = window.innerWidth, vh = window.innerHeight;
                const isDecorative = (br.width >= vw * 0.7 && br.height >= vh * 0.6) ||   // 宽屏 hero/banner
                    (br.width >= vw * 0.5 && br.height >= vh * 0.85) ||                    // 竖向大背景
                    (br.width * br.height >= vw * vh * 0.5);                               // 面积过半屏
                if (isDecorative || getComputedStyle(bgEl).backgroundAttachment === 'fixed') {
                    cancelBg(); bgZoomLayer.hide(); return;
                }
            } catch (err) { }

            const url = extractBgUrl(bgEl);
            if (!url) { cancelBg(); bgZoomLayer.hide(); return; }

            if (url === pendingUrl && bgTimer) return;
            cancelBg();
            pendingUrl = url;

            if (config.delay <= 0) {
                bgZoomLayer.show({ cleaned: url, raw: url }, 2);
                return;
            }
            bgTimer = setTimeout(() => {
                bgTimer = null;
                const r = bgEl.isConnected ? bgEl.getBoundingClientRect() : null;
                if (!inRect(lastMouse.x, lastMouse.y, r) || zoomFSM.hasActiveZoom()) {
                    pendingUrl = null;
                    return;
                }
                bgZoomLayer.show({ cleaned: url, raw: url }, 2);
            }, config.delay);
        }, 100), true);

        document.addEventListener('mouseout', (e) => {
            if (!e.relatedTarget) { cancelBg(); bgZoomLayer.hide(); }
        }, true);
    }

// 5.6.38 - 图片登记处理器
// 不改 processImage 行为。

    // ================
    // 4. 图片登记
    // ================
    function processImage(img) {
        if (!isEnabled || !img || !img.parentNode) return;
        // ★ 自有 UI 隔离：放大层自身的 <img> 也是 document.body 子树里的 IMG，
        // 会被 MutationObserver 当成页面新图送进来（追加容器 → 触发 childList）。
        // 这里统一拦掉，避免给自己的预览层打上 image-zoom-processed 并多跑一轮登记。
        if (img.closest && img.closest('.image-zoom-container')) return;
        try {
            if (!isValidImage(img)) return;
            if (img.classList.contains('image-zoom-processed')) return;
            img.classList.add('image-zoom-processed');
            img.__zoomHasClick = config.avoidClickConflict ? checkImageClickBehavior(img) : false;
            if (!img.__zoomHasClick) {
                img.classList.add('image-zoom-hover');
                const p = img.parentNode;
                if (p && p !== document.body) p.classList.add('image-zoom-hover');
            }
        } catch (error) { }
    }


    // ================
    // 4. 图片登记
    // ================
    // ================
    // 图片信息浮层（尺寸 · 格式 · 来源域名 · 是否已升级到原图）
    // ================
    // 只从 inst.infoSrc 取 URL，不取 imgEl.src —— 后者在黑边裁剪后会被换成 blob:，
    // 那样域名和格式都会丢失。
    function parseImageInfo(url) {
        try {
            const u = new URL(url, window.location.href);
            let host = '';
            try { host = String(u.hostname || '').replace(/^www\./, ''); } catch (e) { }
            let ext = '';
            if (u.protocol === 'data:') ext = 'DATA';
            else {
                const m = String(u.pathname || '').match(/\.([a-zA-Z0-9]{2,5})$/);
                if (m) ext = m[1].toUpperCase();
            }
            return { host, ext };
        } catch (e) { return { host: '', ext: '' }; }
    }

    // 图说（caption）：优先 alt，其次 title，再次最近的 figcaption。只认页面上的源图。
    function extractCaption(inst) {
        try {
            const s = inst && inst.sourceImg;
            if (!s || !s.getAttribute) return '';
            let t = (s.getAttribute('alt') || '').trim() || (s.getAttribute('title') || '').trim();
            if (!t) {
                const fig = s.closest ? s.closest('figure') : null;
                const fc = fig ? fig.querySelector('figcaption') : null;
                if (fc) t = (fc.textContent || '').trim();
            }
            if (!t) return '';
            t = t.replace(/\s+/g, ' ');
            return t.length > 120 ? t.slice(0, 119) + '…' : t;
        } catch (e) { return ''; }
    }

    function updateImageInfo(inst) {
        try {
            const box = inst && inst.container;
            if (!box) return;
            const existing = box.querySelector('#izImageInfo');
            const barExisting = box.querySelector('.hv-capbar');
            if (!config.showImageInfo) {
                if (barExisting) barExisting.remove();   // 信息栏整块移除（外壳保留）
                if (existing) existing.remove();
                const capGone = box.querySelector('#izImageCaption');   // 图说随开关一起隐藏
                if (capGone) capGone.remove();
                return;
            }

            const imgEl = inst.imgEl;
            if (!imgEl) return;
            const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
            const src = inst.infoSrc || imgEl.currentSrc || imgEl.src || '';
            // 空地址不能交给 new URL()：它会被解析成当前页面地址，凭空多出一个“来源域名”
            const info = src ? parseImageInfo(src) : { host: '', ext: '' };
            // 图片名称：URL 末段文件名（去掉扩展名与查询串，解码后截断）
            const fileName = (function () {
                try {
                    const last = String(src).split('?')[0].split('#')[0].split('/').pop() || '';
                    let n = decodeURIComponent(last).replace(/\.[A-Za-z0-9]{2,5}$/, '');
                    n = n.replace(/[_-]+/g, ' ').trim();
                    return n.length > 46 ? n.slice(0, 45) + '…' : n;
                } catch (e) { return ''; }
            })();

            const parts = [];
            if (w > 0 && h > 0) parts.push(w + '×' + h);
            if (info.ext) parts.push(info.ext);
            if (info.host) parts.push(info.host);
            if (inst.usingHiRes) parts.push('原图');
            // ★ 诊断：显示「源缩略图尺寸 → 实际加载尺寸」与渲染策略（截图排障用，尺寸不同才显示）
            try {
                const sw = inst.sourceImg ? Number(inst.sourceImg.naturalWidth) || 0 : 0;
                const sh = inst.sourceImg ? Number(inst.sourceImg.naturalHeight) || 0 : 0;
                if (sw > 0 && sh > 0 && (sw !== w || sh !== h)) parts.push('源' + sw + '×' + sh);
                if (HV_DEBUG && inst.hdDiag) parts.push(inst.hdDiag);
            } catch (e) { }
            // 图集位置（仅在确实有多张时显示，如「3/9」）
            if (inst.galleryList && inst.galleryList.length >= 2) {
                parts.push((inst.galleryIndex + 1) + '/' + inst.galleryList.length);
            }
            if (parts.length === 0 && !fileName) return;

            // ★ 信息栏（capbar）：位于外壳下方，与图片分离，不遮挡画面
            let bar = barExisting;
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'hv-capbar';
                bar.setAttribute('aria-hidden', 'true');
                box.appendChild(bar);
            }
            // 名称（主标题，最左）
            let nameEl = bar.querySelector('.hv-capname');
            if (fileName) {
                if (!nameEl) {
                    nameEl = document.createElement('span');
                    nameEl.className = 'hv-capname';
                    bar.insertBefore(nameEl, bar.firstChild);
                }
                if (nameEl.textContent !== fileName) nameEl.textContent = fileName;
            } else if (nameEl) { nameEl.remove(); }

            let el = existing;
            if (!el) {
                el = document.createElement('div');
                el.id = 'izImageInfo';
                bar.appendChild(el);
            } else if (el.parentNode !== bar) { bar.appendChild(el); }
            el.style.cssText = '';   // 样式全部交给 .hv-capbar / #izImageInfo 的 CSS 规则
            const text = parts.join(' · ');
            if (el.textContent !== text) el.textContent = text;
            // 与放大图淡入同步：容器完全显示后才亮出，避免加载阶段闪一下
            if (box.style.opacity === '1') {
                el.style.opacity = '1';
                if (bar) bar.style.opacity = box.classList.contains('hv-nocap') ? '0' : '1';
            }
            updateCaption(inst, box, bar);
        } catch (e) { }
    }

    // 图说：显示为信息栏的第二行（随「显示图片信息」开关一起开关）
    function updateCaption(inst, box, bar) {
        try {
            const target = bar || box;
            const cap = extractCaption(inst);
            let capEl = box.querySelector('#izImageCaption');
            if (!cap) { if (capEl) capEl.remove(); return; }
            if (!capEl) {
                capEl = document.createElement('div');
                capEl.id = 'izImageCaption';
                capEl.setAttribute('aria-hidden', 'true');
                capEl.className = 'hv-capcap';
                target.appendChild(capEl);
            } else if (capEl.parentNode !== target) { target.appendChild(capEl); }
            if (capEl.textContent !== cap) capEl.textContent = cap;
            if (box.style.opacity === '1') capEl.style.opacity = box.classList.contains('hv-nocap') ? '0' : '1';
        } catch (e) { }
    }

    // ================
    // 5. ★ 核心：单实例状态机 zoomFSM
    // ================

    // 6. ★ 全局事件流 + 停稳裁决器
    // =============================
    // 🔴 CORE PROTECTION ZONE
    // target resolve / zoom self filtering
    // =============================
    function pickVisibleImgUnderPoint(x, y) {
        let stack = [];
        try { stack = document.elementsFromPoint(x, y) || []; } catch (e) { }
        for (const el of stack) {
            // 🔴 防止自身放大层污染 elementsFromPoint 结果
            if (el && el.closest && el.closest('.image-zoom-container')) { continue; }
            if (el.tagName !== 'IMG') {
                // ★ 从顶往下扫，先碰到菜单/空白占位 → 判定无图，不再穿透
                if (el !== document.body && el !== document.documentElement && isHoverBlocker(el) && !canPierceBlocker(el)) return null;
                continue;
            }
            if (!isImgVisibleNow(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width >= config.minOriginalSize && r.height >= config.minOriginalSize &&
                r.width >= 10 && r.height >= 10 && inRect(x, y, r)) {
                return el;
            }
        }
        return null;
    }

    // ★ 统一裁决：光标位置 (x,y) 下是什么？派发 HOVER / HOVER_NONE / 保持
    // 被 mouseover 流（事件坐标）和停稳裁决器（lastMouse 坐标）共用
    function resolveCursorTarget(x, y, t) {
        // 点图选图模式：不触发悬停预览（预览会挡住要点的那张图）
        if (urlPickMode) { zoomFSM.dispatch('HOVER_NONE', { x, y, force: true }); return; }
        if (!isEnabled || isHomepageZoomDisabled()) { zoomFSM.dispatch('DISMISS'); return; }
        // 网页自身进入灯箱后：旧的 hover 放大立即收起，且灯箱内部图片不再触发新的放大。
        if (isImageInLightboxMode(t)) {
            zoomFSM.dispatch('HOVER_NONE', { x, y, force: true });
            return;
        }
        if (t && t.closest && t.closest('#zoomDockZone, #izModalOverlay, #izIntroOverlay, #izUpdateNotice, #izHelpModal')) {
            zoomFSM.dispatch('HOVER_NONE', { x, y });
            return;
        }
        if (t && t.closest && t.closest('.image-zoom-container')) return;
        // ★ 视频悬停预览优先：命中视频/视频卡片时，图片悬停逻辑让位（避免缩略图被顶出来）
        if (videoPreviewModule.handleHover(x, y, t)) {
            zoomFSM.dispatch('HOVER_NONE', { x, y });
            return;
        }
        // 跨 frame 仲裁：别的 frame 有 ACTIVE 预览时本 frame 让位（只拦新触发，不打断已有预览）。
        // 自己已 ACTIVE 时 arbiterCanAcquire 仍为 true（自己的心跳不算「别人」），切图不受影响。
        if (!zoomFSM.hasActiveZoom() && !arbiterCanAcquire()) {
            zoomFSM.dispatch('HOVER_NONE', { x, y });
            return;
        }
        let img = null;

        // 路径A：target 是 img（可见 + 在矩形内 + 未被裁出可视区）
        if (t && t.tagName === 'IMG' && isImgVisibleNow(t) &&
            inRect(x, y, t.getBoundingClientRect()) && !isImgClippedAway(t)) img = t;

        // 路径B：命中栈选图
        if (!img) img = pickVisibleImgUnderPoint(x, y);

        // 路径B+：stretched-link / card-link 整卡链接桥接
        if (!img && t && t.closest) {
            const link = t.closest('a.stretched-link, a.card-link');
            if (link) {
                let node = link.parentElement, hops = 0;
                while (node && node !== document.body && hops < 4) {
                    for (const cImg of node.querySelectorAll('img')) {
                        // ★ 自有 UI 隔离：放大层 img 不作为桥接目标
                        if (cImg.closest && cImg.closest('.image-zoom-container')) continue;
                        if (isImgVisibleNow(cImg) && !isImgClippedAway(cImg) && inRect(x, y, cImg.getBoundingClientRect())) {
                            img = cImg;
                            break;
                        }
                    }
                    if (img) break;
                    node = node.parentElement;
                    hops++;
                }
            }
        }

        // 路径B++：同一 <a> 内的标题/文本桥接
        // 仅在链接内恰好存在 1 张合格图片、且没有按钮/表单控件时启用，
        // 避免把普通导航、商品操作区等整卡误判成图片触发区。
        if (!img && t && t.closest) {
            const anchor = t.closest('a');
            if (anchor && anchor !== document.body && anchor !== document.documentElement) {
                const ar = anchor.getBoundingClientRect();
                if (inRect(x, y, ar)) {
                    const hasInteractive = !!anchor.querySelector('button,input,select,textarea,[role="button"],[role="menuitem"]');
                    if (!hasInteractive) {
                        const candidates = Array.from(anchor.querySelectorAll('img')).filter(cImg =>
                            !cImg.closest('.image-zoom-container') &&
                            isImgVisibleNow(cImg) &&
                            !isImgClippedAway(cImg) &&
                            cImg.naturalWidth > 0 &&
                            cImg.naturalHeight > 0
                        );
                        if (candidates.length === 1) {
                            const cImg = candidates[0];
                            const cr = cImg.getBoundingClientRect();
                            if (cr.width >= config.minOriginalSize && cr.height >= config.minOriginalSize) {
                                img = cImg;
                            }
                        }
                    }
                }
            }
        }

        // 路径C：遮罩盖图 —— 局部扫描
        if (!img) {
            if (t && t !== document.body && isHoverBlocker(t) && !canPierceBlocker(t)) {
                zoomFSM.dispatch('HOVER_NONE', { x, y });
                return;
            }
            const scope = (t && t.closest && t.closest('a, article, section, li, picture, div[class]')) || document;
            const imgs = scope.querySelectorAll('img');
            for (const im of imgs) {
                // ★ 自有 UI 隔离：scope=document 时会扫到放大层自身 img，
                // 否则将自举 HOVER → 对放大图再开实例（图上叠图）
                if (im.closest && im.closest('.image-zoom-container')) continue;
                const r = im.getBoundingClientRect();
                if (r.width >= 80 && r.height >= 80 &&
                    r.width >= config.minOriginalSize && r.height >= config.minOriginalSize &&
                    inRect(x, y, r) && isImgVisibleNow(im) && !isImgClippedAway(im)) {
                    img = im;
                    break;
                }
            }
        }

        if (img) {
            if (!img.classList.contains('image-zoom-processed')) processImage(img);
            if (img.classList.contains('image-zoom-processed')) {
                zoomFSM.dispatch('HOVER', { img, x, y });
                return;
            }
        }
        zoomFSM.dispatch('HOVER_NONE', { x, y });
    }


    // ================
    // 5. ★ 核心：单实例状态机 zoomFSM
    // ================
    // ============================================================
    // 保存图片：文件名模板 {标题}_{宽}x{高}.{扩展名}
    // ============================================================
    const SAFE_NAME_MAX = 100;

    // 去掉文件系统不接受的字符、压缩空白、限制长度
    function sanitizeFileName(s) {
        return String(s || '')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^[.\s]+|[.\s]+$/g, '')
            .slice(0, SAFE_NAME_MAX)
            .trim();
    }

    // 从 URL 推断扩展名；data: URL 走 MIME
    function guessExt(url) {
        const u = String(url || '');
        const dm = u.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)/i);
        if (dm) {
            const sub = (dm[1].split('/')[1] || '').split('+')[0] || 'jpg';
            return sub.replace('jpeg', 'jpg').toLowerCase();
        }
        try {
            const p = new URL(u, location.href).pathname;
            const m = p.match(/\.([a-z0-9]{2,5})$/i);
            if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
        } catch (e) { }
        return 'jpg';
    }

    // 取「被保存的那张图」的像素尺寸：优先预览图（高清升级后即高清尺寸），
    // 但黑边裁剪会把 imgEl.src 换成 blob:，那时尺寸不代表原始文件 → 回落到源图尺寸。
    function savedImageSize(inst) {
        const z = inst && inst.imgEl, s = inst && inst.sourceImg;
        const zSrc = (z && z.src) || '';
        if (z && z.naturalWidth > 0 && zSrc.indexOf('blob:') !== 0) {
            return { w: z.naturalWidth, h: z.naturalHeight };
        }
        if (s && s.naturalWidth > 0) return { w: s.naturalWidth, h: s.naturalHeight };
        return { w: 0, h: 0 };
    }

    // ---------------- 图集 ZIP 打包（手写最小实现：store 模式 + CRC32，不引第三方库） ----------------
    // 说明：图片已是压缩格式（jpg/png），ZIP store（不二次压缩）体积几乎无差，还能省 ~90KB 的 jszip。
    const ZIP_CRC_TABLE = (function () {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    function zipCrc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = ZIP_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    // files: [{ name:string, data:Uint8Array }] → Blob（标准 ZIP，资源管理器/解压软件均可打开）
    function makeZipBlob(files) {
        const enc = new TextEncoder();
        const chunks = [], central = [];
        let offset = 0;
        files.forEach(function (f) {
            const nameBytes = enc.encode(f.name);
            const crc = zipCrc32(f.data), sz = f.data.length;
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);   // local file header signature
            lh.setUint16(4, 20, true);           // version needed
            lh.setUint16(6, 0x0800, true);       // UTF-8 文件名标志
            lh.setUint16(8, 0, true);            // store
            lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); // time/date（留空即可）
            lh.setUint32(14, crc, true);
            lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
            lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
            chunks.push(new Uint8Array(lh.buffer), nameBytes, f.data);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);   // central directory signature
            ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
            ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
            ch.setUint16(28, nameBytes.length, true);
            ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), nameBytes);
            offset += 30 + nameBytes.length + sz;
        });
        let centralSize = 0;
        central.forEach(function (c) { centralSize += c.length; });
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
        eocd.setUint32(12, centralSize, true);
        eocd.setUint32(16, offset, true);
        return new Blob(chunks.concat(central, [new Uint8Array(eocd.buffer)]), { type: 'application/zip' });
    }
    // 抓单张图的字节：同源/CORS 放行的直接 fetch；防盗链/跨域回退 GM_xmlhttpRequest（复用 blob 缓存）
    async function fetchImageBytes(url) {
        try {
            const res = await fetch(url, { credentials: 'omit' });
            if (res.ok) {
                const buf = await res.arrayBuffer();
                if (buf.byteLength > 0) return new Uint8Array(buf);
            }
        } catch (e) { }
        const blobUrl = await gmFetchBlobUrl(url);   // 抛错则由调用方跳过该张
        const res2 = await fetch(blobUrl);
        return new Uint8Array(await res2.arrayBuffer());
    }
    // 把整组图集打包成 ZIP 并下载
    async function downloadGalleryZipFor(inst) {
        if (!inst || !inst.galleryList || inst.galleryList.length < 2) { showToast('当前不是图集', 1200); return true; }
        const list = inst.galleryList.filter(function (im) { return im && im.isConnected !== false; });
        if (!list.length) { showToast('图集内容不可用', 1500); return true; }
        showToast('图集打包中（' + list.length + ' 张）…', 2500);
        let host = '';
        try { host = location.hostname.replace(/^www\./, ''); } catch (e) { }
        const zipName = sanitizeFileName('图集_' + host + '_' + list.length + '张_' + (document.title || '').slice(0, 30)) + '.zip';
        const files = [];
        let okN = 0;
        for (let i = 0; i < list.length; i++) {
            const im = list[i];
            let u = '';
            try { u = new URL(im.currentSrc || im.src || '', location.href).href; } catch (e) { u = im.src || ''; }
            if (!u) continue;   // blob:/data: 也能被 fetch 直接读取，无需排除
            try {
                const bytes = await fetchImageBytes(u);
                if (!bytes || !bytes.length) continue;
                let base = '';
                try { base = decodeURIComponent((new URL(u)).pathname.split('/').pop() || ''); } catch (e) { base = ''; }
                base = sanitizeFileName(base) || ('img_' + (i + 1));
                // 防重名：同包内同名加序号
                if (files.some(function (x) { return x.name === base; })) {
                    base = base.replace(/(\.[^.]+)?$/, '_' + (i + 1) + '$1');
                }
                files.push({ name: base, data: bytes });
                okN++;
            } catch (e) { /* 单张失败跳过，不阻塞整包 */ }
        }
        if (!okN) { showToast('打包失败：一张都没抓到', 2000); return true; }
        try {
            const blob = makeZipBlob(files);
            const objUrl = URL.createObjectURL(blob);
            downloadViaAnchor(objUrl, zipName);
            setTimeout(function () { URL.revokeObjectURL(objUrl); }, 30000);
            showToast('已打包 ' + okN + '/' + list.length + ' 张：' + zipName, 2400);
        } catch (e) { showToast('打包失败：' + (e && e.message || e), 2000); }
        return true;
    }

    // ---------------- 反馈：预览激活时留一份小尺寸截图（仅本地，供「反馈问题」附带） ----------------
    let lastPreviewShotData = null;   // dataURL(PNG)；跨域直连图会污染 canvas → 抓不到就留空
    function capturePreviewShot(inst) {
        try {
            const im = inst && inst.imgEl;
            if (!im || !im.naturalWidth) return;
            const MAXS = 900;
            const f = Math.min(1, MAXS / Math.max(im.naturalWidth, im.naturalHeight));
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(im.naturalWidth * f));
            cv.height = Math.max(1, Math.round(im.naturalHeight * f));
            cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
            lastPreviewShotData = cv.toDataURL('image/png');
        } catch (e) { lastPreviewShotData = null; }   // canvas 被跨域污染等情况：静默放弃截图
    }

    function buildDownloadName(inst, url) {
        const s = inst && inst.sourceImg;
        let title = '';
        try { title = (document.title || '').trim(); } catch (e) { }
        if (!title && s) title = (s.alt || '').trim();
        title = sanitizeFileName(title) || 'image';
        const size = savedImageSize(inst);
        const dim = (size.w > 0 && size.h > 0) ? ('_' + size.w + 'x' + size.h) : '';
        return title + dim + '.' + guessExt(url);
    }

    // 降级下载：<a download>。同源可直接落盘；跨域时浏览器多半改为「另存为」，
    // 这是在不引入额外权限的前提下能做到的最好结果。
    function downloadViaAnchor(url, name) {
        try {
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.rel = 'noopener';
            a.style.display = 'none';
            (document.body || document.documentElement).appendChild(a);
            a.click();
            setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
            showToast('已开始下载：' + name, 1800);
        } catch (e) {
            showToast('保存失败', 1600);
        }
    }

    // ---------------- 复制 ----------------

    // 复制文本：GM_setClipboard 优先 → navigator.clipboard → 临时 textarea
    function copyTextLegacy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;left:-9999px;top:0';
            (document.body || document.documentElement).appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            if (ta.parentNode) ta.parentNode.removeChild(ta);
            return !!ok;
        } catch (e) { return false; }
    }

    function copyText(text) {
        return new Promise(function (resolve) {
            try {
                if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); resolve(true); return; }
            } catch (e) { }
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(
                        function () { resolve(true); },
                        function () { resolve(copyTextLegacy(text)); }
                    );
                    return;
                }
            } catch (e) { }
            resolve(copyTextLegacy(text));
        });
    }

    // 复制图片本体：canvas → blob → ClipboardItem。
    // ⚠️ 跨域且未开放 CORS 的图片会污染 canvas，此时浏览器必然拒绝（安全限制，脚本无法绕过）。
    function copyImageBody(inst) {
        return new Promise(function (resolve) {
            const img = inst && inst.imgEl;
            if (!img || !img.naturalWidth) { resolve('noimg'); return; }
            if (!(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write)) { resolve('unsupported'); return; }
            let canvas;
            try {
                canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
            } catch (e) { resolve('tainted'); return; }
            try {
                canvas.toBlob(function (blob) {
                    if (!blob) { resolve('noblob'); return; }
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
                        function () { resolve('ok'); },
                        function () { resolve('writefail'); }
                    );
                }, 'image/png');
            } catch (e) { resolve('tainted'); }   // 污染 canvas 调 toBlob 会抛 SecurityError
        });
    }

    // ============================================================
    // 图集识别
    //   从当前图往上找祖先，第一个包含 ≥2 张「可见且够大」图片的层就当图集容器。
    //   限制上溯 GALLERY_MAX_DEPTH 层，避免误把整页图片都算成一个图集。
    // ============================================================
    const GALLERY_MAX = 80;
    const GALLERY_MIN_PX = 60;
    // 上溯层数上限：表格化 / 深嵌套布局（如 Wikimedia Commons）的图集容器常在第 6~7 层祖先，
    // 原值 5 会漏识别（test.114 定位）；提到 8 覆盖常见深嵌套，同时仍能避免把整页图片算成一个图集。
    const GALLERY_MAX_DEPTH = 8;

    function isGalleryCandidate(el) {
        if (!el || !el.isConnected) return false;
        if (el.closest && el.closest('.image-zoom-container')) return false;
        const r = el.getBoundingClientRect();
        if (r.width < GALLERY_MIN_PX || r.height < GALLERY_MIN_PX) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }

    // 返回按文档顺序排列的图集列表；识别不到就返回只含自身的一项
    function collectGalleryImages(img) {
        if (!img || !img.isConnected) return [];
        let root = img.parentElement;
        for (let depth = 0; depth < GALLERY_MAX_DEPTH && root && root !== document.body; depth++) {
            const imgs = Array.prototype.slice.call(root.querySelectorAll('img')).filter(isGalleryCandidate);
            if (imgs.length >= 2) {
                if (imgs.indexOf(img) < 0) imgs.unshift(img);
                return imgs.slice(0, GALLERY_MAX);
            }
            root = root.parentElement;
        }
        return [img];
    }

    // 进出全屏时重算预览的缩放基准（zoomFSM 在后面才定义，所以包 try/catch 防 TDZ）
    document.addEventListener('fullscreenchange', () => {
        try {
            if (!zoomFSM || !zoomFSM.hasActiveZoom()) return;
            zoomFSM.dispatch('FULLSCREEN_LAYOUT', { on: !!document.fullscreenElement });
        } catch (e) { }
    });

    // ★ 单次出现位置覆盖（test.86）：若用户设的是「屏幕居中」，则**下一次**图片预览改用
    //   「原图周围」——居中的放大图会挡住宅自带的视频预览，贴到原图旁边就不会挡。
    //   两个装载点：
    //     ① 视频预览**被关掉**（Esc / 移开 / 滚动）时 —— videoPreviewModule.hide()；
    //     ② 「视频悬停预览」**开关本身是关闭**、且光标落在视频卡片上 —— 此时不会产生视频预览，
    //        图片放大直接接管，同样需要避让 —— videoPreviewModule.handleHover() 的关闭分支。
    //   规则：① 只在「刚触发」的短窗口内有效（PLACE_ONCE_WINDOW）；② 只作用于**一次**预览；
    //        ③ **不写回** config.previewPlacement，用户设置不变（面板里显示的还是原设置）。
    const PLACE_ONCE_WINDOW = 5000;   // 触发后多久内有效（够用户重新移到图上；过期自动作废）
    let placeOnce = null;          // 'around' | null
    let placeOnceAt = 0;

    const zoomFSM = (function() {
        const S = Object.freeze({ IDLE:'IDLE', PENDING:'PENDING', SHOWING:'SHOWING', ACTIVE:'ACTIVE', FADING:'FADING' });
        let state = S.IDLE;
        let instance = null;      // 唯一活实例
        let generation = 0;       // 代际计数：每次目标变化/离开/切换 +1，旧异步任务据此丢弃
        let currentAbort = null;  // 当前在途媒体加载的取消控制器（leave/switch 时 abort）
        let pendingImg = null;    // PENDING 中等待的图
        let pendingTimer = null;
        let pendingFails = 0;     // 心跳连续失败计数（容忍轮播动画的瞬时错位）
        let pendingGraceUsed = false; // TIMER_FIRE 宽限重试是否已用
        let wheelTicking = false, lastWheelEvent = null;

        function clearPending() {
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
            hideHoverWaitIndicator();
            pendingImg = null;
            pendingImageForIndicator = null;
            pendingFails = 0;
            pendingGraceUsed = false;
        }

        // ============================================================================
        // ★ 预览过渡动画（入场 / 收起）—— 引擎 + 四种方案，面板可切换
        //   约束：容器 transform 由 applyZoom 独占（旋转/滚轮/平移），动画只作用于图片元素与
        //   装饰层（外壳/信息栏）；动画结束一律「先写内联终态 → 再释放动画」，不依赖 commitStyles
        //   （动画时间轴被节流时 commitStyles 会提交起始值）。
        //   方案：dock 从原图弹出（FLIP 滑行）/ spotlight 从原图绽开（光圈扩散）/ fade 直接淡入
        // ============================================================================
        const PT_EASE = 'cubic-bezier(.16,1,.3,1)';
        const PT_SP_EASE = 'cubic-bezier(.3,1.25,.3,1)'; // spotlight 用爆感缓动：快速冲进 + 轻微回弹过冲（区别于 dock 的顺滑滑行）
        // ★ 两套方案的“性格参数”：dock = 整体位移（慢而长），spotlight = 光圈收敛（快而收）
        //   可调范围：dock 320~560（越小越干脆）；spotlight 220~360（越小越像“啪”一下聚焦）
        // 参考方案文档：dock 420（滑行，慢而长） / spotlight 380（光圈绽开，干脆收住）
        // 可调：dock 320~560；spotlight 280~420（光圈太快会看不清"收敛"的路径）
        const PT_DUR = { dock: 420, spotlight: 380 };
        // 聚焦专用缓动：先快后稳地收住（与 dock 的顺滑滑行明显区分）
        // 可调：cubic-bezier(.2,.7,.3,1)=干脆收敛；(.34,1.2,.64,1)=带一点过冲的“聚拢”
        const PT_AP_EASE = 'cubic-bezier(.2,.7,.3,1)';
        // 聚焦时图片的起始缩放（1 = 不做缩放；0.90~0.97 越小“从内向外长”越明显）
        const PT_AP_SCALE = 0.94;
        // 聚焦时图片的位移占比（0 = 完全不位移、纯靠光圈；0.15 = 带一点轻微靠拢；建议 ≤0.2）
        const PT_AP_SHIFT = 0.06;
        // 聚焦时图片的起始不透明度（0.2~0.5；越低越像“从光里浮出来”）
        const PT_AP_OPACITY = 0.35;
        const PT_LAG = 90;              // 辅助层（外壳/信息栏）与主体的时序差
        // 收起动画结束后的清理缓冲（建议 30~80；过大=残留可见，过小=可能截断最后一帧）
        const PT_CLEANUP = 40;
        let ptToken = 0;                // 每次进入/收起领新号；旧流程过期即退让

        function ptReducedMotion() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
        function ptMode() {
            const m = config.previewTransition;
            return (!m || !PT_DUR[m] || ptReducedMotion()) ? 'fade' : m;
        }
        // FLIP 几何：从「原图当前 rect」到「放大图当前 rect」
        function ptGeom(inst) {
            try {
                const im = inst && inst.imgEl, src = inst && inst.sourceImg;
                if (!im || !src || !src.isConnected) return null;
                if ((((Number(inst.rotation) || 0) % 360) + 360) % 360 !== 0 || inst.flipH || inst.flipV) return null;
                const ir = im.getBoundingClientRect(), sr = src.getBoundingClientRect();
                if (!(ir.width > 2 && ir.height > 2 && sr.width > 2 && sr.height > 2)) return null;
                return {
                    dx: (sr.left + sr.width / 2) - (ir.left + ir.width / 2),
                    dy: (sr.top + sr.height / 2) - (ir.top + ir.height / 2),
                    s: Math.max(0.02, sr.width / ir.width),
                    src: { l: sr.left, t: sr.top, w: sr.width, h: sr.height },
                    dst: { l: ir.left, t: ir.top, w: ir.width, h: ir.height }
                };
            } catch (e) { return null; }
        }
        function ptTf(dx, dy, s) { return 'translate(' + Math.round(dx) + 'px,' + Math.round(dy) + 'px) scale(' + s.toFixed(4) + ')'; }
        // ★ spotlight 光圈半径（px）。圆心 (lx,ly) 与 clip-path 同一参考系（图片元素自身坐标，
        //   容器与图片同原点 → 容器内坐标即元素内坐标）。取圆心到四角的「最远距离」作完整半径，
        //   与圆心是否落在元素内无关（源图中心常在预览框外），确保绽开后完全覆盖图片不露边；
        //   起始半径取一个很小的值 → 形成「从源点向外绽开」的收束感。
        //   ⚠ 此函数曾被漏定义：ptEnter/ptLeave 调用时抛 ReferenceError 被外层 try/catch 吞掉 →
        //   spotlight 静默退化成纯淡入（方案 C 的光圈效果完全不出现）。此处补回。
        function ptSpotRadius(im, lx, ly) {
            try {
                const elW = im.offsetWidth || im.clientWidth || 0;
                const elH = im.offsetHeight || im.clientHeight || 0;
                const dx = Math.max(lx, elW - lx);   // 圆心到左/右两侧较远者
                const dy = Math.max(ly, elH - ly);   // 圆心到上/下两侧较远者
                const full = Math.ceil(Math.sqrt(dx * dx + dy * dy)) + 4;   // 到最远角 + 余量
                const tiny = Math.max(2, Math.round(Math.min(elW, elH) * 0.04));
                return { tiny: tiny, full: full };
            } catch (e) { return { tiny: 2, full: 9999 }; }
        }
        // 清掉元素上全部 WAAPI 动画（含 fill:forwards 的旧动画）。快速连续悬停/切图时旧动画
        // 未 settle 就会叠加新动画，fill 帧 + 合成层堆积 → 残影；这里统一释放。
        function ptClearAnim(el) {
            if (!el) return;
            try { el.getAnimations().forEach(function (x) { x.cancel(); }); } catch (e) { }
        }
        // 落定（入场）：先写内联终态（此刻被动画 fill 压住，视觉无变化）再释放动画
        function ptSettleIn(inst, a, clearClip) {
            try {
                const im = inst.imgEl, c = inst.container;
                if (im) {
                    im.style.transform = 'none'; im.style.opacity = '1'; if (clearClip) im.style.clipPath = 'none';
                    ptClearAnim(im);   // ★ 释放 img 上全部动画（不止传入的 a），杜绝旧 fill 帧残留
                }
                if (c) c.querySelectorAll('.hv-hull, .hv-capbar').forEach(function (el) {
                    el.style.transform = 'none'; el.style.opacity = '1';
                    ptClearAnim(el);
                });
                if (a) a.cancel();
            } catch (e) { }
        }
        // ★ spotlight「炸开」：在源图中心生成一个径向白光，scale 0→爆散→淡出。
        //   独立浮层（不裁剪图片本身）→ 动画结束彻底移除节点，杜绝「光斑残留/全图一圈」。
        //   lx/ly 为源图中心在容器内的坐标（本函数在容器内绝对定位）。
        function ptFlare(c, lx, ly, size, D, entering) {
            try {
                const f = document.createElement('div');
                f.className = 'hv-flare';
                f.setAttribute('aria-hidden', 'true');
                Object.assign(f.style, {
                    position: 'absolute', left: (lx - size / 2) + 'px', top: (ly - size / 2) + 'px',
                    width: size + 'px', height: size + 'px',
                    borderRadius: '50%',
                    background: 'radial-gradient(circle, rgba(255,255,255,.96) 0%, rgba(196,220,255,.6) 38%, rgba(150,190,255,0) 68%)',
                    pointerEvents: 'none', zIndex: '2', willChange: 'transform,opacity', opacity: entering ? '0' : '1'
                });
                (c || document.body).appendChild(f);
                // 进场：白光瞬间爆开到最大（scale 冲过 1）再轻微回缩、同时整体淡出 —— 炸开感
                // 出场：白光在源点再闪一下随即收拢消散
                const frame = entering
                    ? [{ transform: 'scale(0)', opacity: 0 },
                       { transform: 'scale(1.25)', opacity: .95, offset: .42 },
                       { transform: 'scale(1)', opacity: 0 }]
                    : [{ transform: 'scale(1.1)', opacity: .9 },
                       { transform: 'scale(.85)', opacity: .5, offset: .45 },
                       { transform: 'scale(0)', opacity: 0 }];
                const tot = entering ? Math.max(360, D) : D;
                const a = f.animate(frame, { duration: tot, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
                setTimeout(function () {
                    try { a.cancel(); if (f.parentNode) f.parentNode.removeChild(f); } catch (e) { }
                }, tot + 90);
            } catch (e) { }
        }
        function ptAux(c, D, entering) {
            // ★ 只负责信息栏（capbar）。外壳（hull）由各分支内联处理（dock 跟图 FLIP、
            //   spotlight 独立淡入/淡出），这里不再重复动画 —— 避免两条 fill:forwards 叠加，
            //   离场时 ptAux 的首关键帧 opacity:1 会把已淡出的 hull 拉回 → 残影。
            const bar = c.querySelector('.hv-capbar');
            if (bar) {
                if (entering) bar.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 240, delay: Math.max(60, D - 110), easing: PT_EASE, fill: 'forwards' });
                else bar.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: PT_EASE, fill: 'forwards' });
            }
        }
        function ptEnter(inst) {
            const mode = ptMode();
            if (mode === 'fade') return false;
            const geom = ptGeom(inst);
            if (!geom) return false;
            const c = inst.container, im = inst.imgEl;
            if (!c || !im) return false;
            const D = PT_DUR[mode], tk = ++ptToken;
            try {
                // ★ 先释放上轮遗留动画再入场 —— 防止快速悬停/切图时旧 fill 帧叠加产生残影
                ptClearAnim(im);
                ptClearAnim(c.querySelector('.hv-hull'));
                ptClearAnim(c.querySelector('.hv-capbar'));
                im.style.clipPath = 'none';
                c.style.opacity = '1';
                im.style.opacity = '1';
                im.style.transformOrigin = 'center center';
                if (mode === 'dock') {
                    const a = im.animate([
                        { transform: ptTf(geom.dx, geom.dy, geom.s), opacity: .25 },
                        { transform: 'none', opacity: 1 }
                    ], { duration: D, easing: PT_EASE, fill: 'forwards' });
                    const hull = c.querySelector('.hv-hull');
                    if (hull) hull.animate([                                // 外壳与图片同一条路径
                        { transform: ptTf(geom.dx, geom.dy, (geom.src.w + 20) / (geom.dst.w + 20)), opacity: 0 },
                        { transform: 'none', opacity: 1 }
                    ], { duration: D, easing: PT_EASE, fill: 'forwards' });
                    const bar = c.querySelector('.hv-capbar');
                    if (bar) bar.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 240, delay: Math.max(60, D - 110), easing: PT_EASE, fill: 'forwards' });
                    setTimeout(function () { if (ptToken === tk) ptSettleIn(inst, a, false); }, D + 90);
                } else { // spotlight：从原图绽开 —— 图片几乎不动（原地），
                    //   用 clip-path 圆形光圈从源点向外绽开 + 轻微缩放；白光爆闪作为增强保留。
                    //   与 dock 的区别：dock 是「整块滑行」，spotlight 是「原地聚焦」，肉眼可辨。
                    const cr = c.getBoundingClientRect();
                    const lx = (geom.src.l + geom.src.w / 2) - cr.left, ly = (geom.src.t + geom.src.h / 2) - cr.top;
                    const flareSize = Math.hypot(c.clientWidth, c.clientHeight) + 90;
                    // 光圈半径按「圆心到矩形最远角」计算（像素），避免百分比半径在圆心偏离时覆盖不全；
                    // 动画结束由 ptSettleIn 写 clipPath:none 清除，不残留。
                    const r0 = ptSpotRadius(im, lx, ly);
                    const a = im.animate([
                        { clipPath: 'circle(' + r0.tiny + 'px at ' + Math.round(lx) + 'px ' + Math.round(ly) + 'px)', transform: ptTf(geom.dx * PT_AP_SHIFT, geom.dy * PT_AP_SHIFT, PT_AP_SCALE), opacity: PT_AP_OPACITY },
                        { clipPath: 'circle(' + r0.full + 'px at ' + Math.round(lx) + 'px ' + Math.round(ly) + 'px)', transform: 'none', opacity: 1 }
                    ], { duration: D, easing: PT_AP_EASE, fill: 'forwards' });
                    // ★ 外壳不随图滑行（光圈的重点在光，不在移动的框）—— 与 dock 明显区分
                    const hull = c.querySelector('.hv-hull');
                    if (hull) hull.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.min(220, D), easing: PT_EASE, fill: 'forwards' });
                    ptAux(c, D, true);
                    ptFlare(c, lx, ly, flareSize, D, true);               // ★ 源点白光爆闪 = 炸开感
                    setTimeout(function () { if (ptToken === tk) ptSettleIn(inst, a, true); }, D + 90);   // true = 落位后清除裁剪
                }
            } catch (e) { return false; }
            return true;
        }
        // 收起动画：返回实际时长（0 = 未接管，调用方退回纯淡出）
        function ptLeave(container) {
            const mode = ptMode();
            const inst = container && container.__zoomInstance;
            if (mode === 'fade' || !inst) return 0;
            const geom = ptGeom(inst);
            if (!geom) return 0;
            const im = inst.imgEl, D = PT_DUR[mode], tk = ++ptToken;
            try {
                // ★ 先清掉上轮入场动画，从 settle 后的内联状态反向收起，
                //   避免反向动画叠在旧的 forward 动画上 → 残影。
                ptClearAnim(im);
                ptClearAnim(container.querySelector('.hv-hull'));
                ptClearAnim(container.querySelector('.hv-capbar'));
                im.style.clipPath = 'none';
                // 起点取「当前实际状态」：动画中途被反向接管也不跳变
                const cs = getComputedStyle(im);
                const startTf = (cs.transform && cs.transform !== 'none') ? cs.transform : 'none';
                const startOp = isNaN(parseFloat(cs.opacity)) ? 1 : parseFloat(cs.opacity);
                let a;
                if (mode === 'dock') {
                    a = im.animate([
                        { transform: startTf, opacity: startOp },
                        { transform: ptTf(geom.dx, geom.dy, geom.s), opacity: 0 }
                    ], { duration: D, easing: PT_EASE, fill: 'forwards' });
                    const hull = container.querySelector('.hv-hull');
                    if (hull) hull.animate([
                        { transform: 'none', opacity: 1 },
                        { transform: ptTf(geom.dx, geom.dy, (geom.src.w + 20) / (geom.dst.w + 20)), opacity: 0 }
                    ], { duration: D, easing: PT_EASE, fill: 'forwards' });
                    ptAux(container, D, false);
                } else { // spotlight：光圈收拢（clip-path full→tiny）+ 轻微缩回收回 + 白光收拢
                    const cr = container.getBoundingClientRect();
                    const lx = (geom.src.l + geom.src.w / 2) - cr.left, ly = (geom.src.t + geom.src.h / 2) - cr.top;
                    const flareSize = Math.hypot(container.clientWidth, container.clientHeight) + 90;
                    const r0 = ptSpotRadius(im, lx, ly);
                    // ★ 收起终点用「完整 FLIP 几何」(dx/dy/s)：图片缩回原图所在位置。
                    //   光圈(clip-path) + 源点白光 + 缓动(PT_AP_EASE) 全部保留 —— 只把落点
                    //   从「原地微移 6%/0.94 缩放」改成「回到原图」，与 dock 的收起语义一致。
                    a = im.animate([
                        { clipPath: 'circle(' + r0.full + 'px at ' + Math.round(lx) + 'px ' + Math.round(ly) + 'px)', transform: startTf, opacity: startOp },
                        { clipPath: 'circle(' + r0.tiny + 'px at ' + Math.round(lx) + 'px ' + Math.round(ly) + 'px)', transform: ptTf(geom.dx, geom.dy, geom.s), opacity: 0 }
                    ], { duration: D, easing: PT_AP_EASE, fill: 'forwards' });
                    const hull = container.querySelector('.hv-hull');
                    if (hull) hull.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(220, D), easing: PT_EASE, fill: 'forwards' });
                    ptAux(container, D, false);
                    ptFlare(container, lx, ly, flareSize, D, false);       // ★ 源点白光闪一下再收拢
                }
                setTimeout(function () {
                    if (ptToken !== tk) return;
                    // ⚠ 不能只 cancel 动画（会回弹到内联值 → 闪一下）。
                    //   正确顺序：写内联终态（被动画 fill 压住、视觉无变化）→ 释放动画 → 立刻隐藏/清理。
                    //   这样缩放结束的瞬间就回到稳定终态，不会留下“缩小后还停留一小段”的残影。
                    try { im.style.transform = 'none'; im.style.opacity = '0'; } catch (e) { }
                    ptClearAnim(im);
                    container.querySelectorAll('.hv-hull, .hv-capbar').forEach(function (el) {
                        try { el.style.transform = 'none'; el.style.opacity = '0'; } catch (e) { }
                        ptClearAnim(el);
                    });
                    // 光效浮层与合成层痕迹一并清掉（will-change 残留会在移除后短暂留影）
                    container.querySelectorAll('.hv-flare').forEach(function (f) { try { f.parentNode.removeChild(f); } catch (e) { } });
                    container.style.willChange = 'auto';
                    container.style.opacity = '0';
                }, D + PT_CLEANUP);
            } catch (e) { return 0; }
            return D;
        }

        function fadeOutContainer(container) {
            if (!container || !container.parentNode) return;
            container.dataset.izFading = '1';
            const zImg = container.querySelector('img');
            const ptDur = ptLeave(container);          // ★ 收起动画（0 = 未接管 → 退回纯淡出）
            if (!ptDur) {
                container.style.opacity = '0';
                if (zImg) { zImg.style.transform = 'scale(.6)'; zImg.style.opacity = '0'; }
            }
            if (zImg && zImg.__zoomBlobUrl) {
                URL.revokeObjectURL(zImg.__zoomBlobUrl);
                zImg.__zoomBlobUrl = null;
            }
            setTimeout(() => {
                if (container.parentNode) container.parentNode.removeChild(container);
            // ptLeave 已在 D+PT_CLEANUP 复位并隐藏内容，这里再留一点余量即可移除节点
            }, ptDur ? (ptDur + PT_CLEANUP + 30) : FADE_MS);
        }

        // 按图片当前的天然比例，在容器内做一次 contain 适配（非滚轮模式专用）。
        // 算法与 cropBlackBars 的非滚轮分支保持一致，确保两条路径结果相同。
        function refitInstanceImage(inst) {
            if (!inst || !inst.container || !inst.imgEl) return;
            const box = inst.container, im = inst.imgEl;
            const nw0 = Number(im.naturalWidth) || 0, nh0 = Number(im.naturalHeight) || 0;
            const ratio = (nw0 > 0 && nh0 > 0) ? (nw0 / nh0)
                : (Number(inst.imageRatio) > 0 ? inst.imageRatio : 0);
            if (!(ratio > 0)) return;
            const bw = box.clientWidth, bh = box.clientHeight;
            if (!(bw > 0 && bh > 0)) return;
            let nw = bw, nh = Math.round(bw / ratio);
            if (nh > bh) { nh = bh; nw = Math.round(bh * ratio); }
            im.style.width = nw + 'px';
            im.style.height = nh + 'px';
            im.style.left = Math.round((bw - nw) / 2) + 'px';
            im.style.top = Math.round((bh - nh) / 2) + 'px';
        }

        // ★ 信息栏（capbar）是 position:absolute; top:calc(100% + 12px) —— 挂在容器**下方**、
        //   不占容器高度。自适应尺寸若只给容器留 60px 视口余量，加上信息栏（约 34~54px）
        //   与 12px 间距，整体就会超出视口底部（表现为「大图下半部分 / 信息栏跑到页面下面」）。
        //   这里把这部分从「图片可用高度」里预留出去，保证【图片 + 间距 + 信息栏】整体不超视口。
        function capbarReserve() {
            try {
                if (!config.showImageInfo) return 0;
                const bar = document.querySelector('.image-zoom-container .hv-capbar');
                // 量不到时（建实例/换图早期信息栏尚未构建）按「两行图说」的实测高度 56px 兜底，宁可多留不可少留
                const bh = (bar && bar.offsetHeight) ? bar.offsetHeight : 56;
                return bh + 12;                                                // 12 = 容器与信息栏的间距
            } catch (e) { return 0; }
        }
        // ★ 浏览器窗口底边可能延伸到屏幕「可用区」之下 —— macOS Dock 自动隐藏时窗口可贴到屏幕最底，
        //   Dock 弹出就会盖住浏览器底部（Windows 任务栏一般不自动隐藏，故不常见）。
        //   此状态下 window.innerHeight 仍**包含被遮挡的部分** → 贴底的图说会被挡掉一半。
        //   这里用「窗口在屏幕上的底边」与「屏幕可用区底边」之差估算遮挡高度，并从可用高度中扣除。
        function visualInnerH() {
            try {
                if (typeof screen === 'undefined' || typeof screen.availHeight !== 'number') return window.innerHeight;
                const vpBottom = window.screenY + window.outerHeight;                      // 窗口底边(屏幕坐标)
                const availTop = (typeof screen.availTop === 'number') ? screen.availTop : 0;
                const availBottom = availTop + screen.availHeight;                          // 可用区底边
                const occluded = Math.max(0, vpBottom - availBottom);
                return Math.max(160, window.innerHeight - occluded);
            } catch (e) { return window.innerHeight; }
        }
        // ★ 档位 → 预览可用空间上限（computeAdaptiveSize / fixed / smallImg 三处共用，避免不一致）。
        //   跟随视口（si=3）：以【页面高度】为最大高度等比放大，宽度基本不设限（哥哥口径），
        //     只保留信息栏（capbar）纵向空间；极端横图由 onload 的 kFit 兜底防止横向超出视口。
        //   小/中/大：用「宽 × 高」框 + 档位比例分档（小视口下四档才有区分，见 STEP_VIEWPORT_SCALE）。
        function stepCaps() {
            const capRes = capbarReserve();
            if (sizeStepIndex() === 3) {
                return { w: Infinity, h: Math.max(160, visualInnerH() - capRes) };
            }
            const svs = stepViewportScale();
            return {
                w: Math.min((window.innerWidth - 60) * svs, config.maxWidth),
                h: Math.min(Math.max(160, (visualInnerH() - 60 - capRes) * svs), config.maxHeight)
            };
        }
        function computeAdaptiveSize(img, rect) {
            const caps = stepCaps();
            const availW = caps.w, availH = caps.h;
            const size = Math.sqrt(rect.width * rect.height);
            const availSize = Math.sqrt(availW * availH);
            const TARGET_MIN = Math.min(1200, availSize);
            let target = Math.min(Math.max(size * 5, TARGET_MIN), availSize);
            let scale = Math.min(Math.max(target / size, 1), 10);
            let w = Math.round(rect.width * scale), h = Math.round(rect.height * scale);
            const rawW = w, rawH = h;
            if (w > availW || h > availH) {
                const fit = Math.min(availW / w, availH / h);
                w = Math.round(w * fit);
                h = Math.round(h * fit);
            }
            return { w, h, rawW, rawH };
        }

        // ===== 显示位置（placement） =====
        // center=屏幕居中（默认，原有行为）；around=原图周围（PhotoShow/易看图式：在缩略图剩余
        // 空间最大的一侧显示，不遮挡缩略图，放不下回退居中）。
        // 实现要点：容器始终保留 translate(-50%,-50%) 变换（旋转/滚轮缩放/图集路径都依赖它），
        // 只把 left/top 锚点从「50%」换成目标矩形的中心点像素——对既有几何体系零侵入。
        // ===== around（原图周围）专用：参考浮图秀——显示在原图周围，绝不覆盖原图 =====
        const PL_GAP = 24;   // 与缩略图/光标的间距
        const PL_EDGE = 8;   // 与视口边缘的最小间隙
        // 选「剩余空间最大」的一侧（不做能否放下的判断——放不下时是缩小尺寸，而不是回退覆盖）
        function pickAroundSide(rect) {
            const vw = window.innerWidth, vh = visualInnerH();
            const sp = {
                right: vw - rect.right,
                left: rect.left,
                bottom: vh - rect.bottom,
                top: rect.top
            };
            const side = Object.keys(sp).sort(function (a, b) { return sp[b] - sp[a]; })[0];
            return { side: side, space: sp[side] };
        }
        // 该侧可用于显示预览的尺寸上限：横向侧限宽、纵向侧限高，另一轴受视口限制
        function aroundLimits(side, space) {
            const vw = window.innerWidth, vh = window.innerHeight;
            const horizontal = (side === 'left' || side === 'right');
            const along = Math.max(0, space - PL_GAP - PL_EDGE);
            const capRes = capbarReserve();   // 信息栏挂在容器下方，要占掉这部分高度
            // ★ 纵向上限改用 stepCaps()（跟随档 = 页面高度 − 信息栏，即 738），
            //   否则跟随档会被这里的 PL_EDGE*2 再压小 16px → 哥哥反馈「跟随视口不够大」。
            //   caps.h 已含信息栏预留，保证【图 + 图说】整体不超页面。
            const caps = stepCaps();
            return horizontal
                ? { w: along, h: Math.max(0, Math.min(caps.h, vh)) }
                : { w: Math.max(0, vw - PL_EDGE * 2), h: Math.max(0, Math.min(caps.h, along - capRes)) };
        }
        // 锚点：贴在该侧（因为已按空间收缩，clamp 只是极端兜底，不会导致覆盖原图）
        function computeAroundAnchor(side, rect, boxW, boxH) {
            const vw = window.innerWidth, vh = visualInnerH();   // 用可视高度，避免窗口底被 Dock/任务栏遮挡时把盒子放到底部
            let cx, cy;
            if (side === 'right') { cx = rect.right + PL_GAP + boxW / 2; cy = rect.top + rect.height / 2; }
            else if (side === 'left') { cx = rect.left - PL_GAP - boxW / 2; cy = rect.top + rect.height / 2; }
            else if (side === 'bottom') { cx = rect.left + rect.width / 2; cy = rect.bottom + PL_GAP + boxH / 2; }
            else { cx = rect.left + rect.width / 2; cy = rect.top - PL_GAP - boxH / 2; }
            const capRes = capbarReserve();   // 信息栏在容器下方，下边界要为它留出空间
            let lo = boxH / 2 + PL_EDGE;
            let hi = vh - boxH / 2 - PL_EDGE - capRes;
            // ★ 盒子比视口还高时上下界会交叉（lo > hi）。旧式 clamp 此时会取 lo = boxH/2 + EDGE，
            //   于是「盒子越高 → 中心点越往下」，最终中心点跑到视口下方（页面之外）——
            //   竖图高倍放大时必现。交叉时改为把中心钉在视口纵向中部：
            //   保证【中心点永远在页面内】，上下两端各自溢出、可平移查看。
            if (lo > hi) { lo = hi = Math.max(PL_EDGE * 2, (vh - capRes) / 2); }
            return {
                cx: Math.max(boxW / 2 + PL_EDGE, Math.min(cx, vw - boxW / 2 - PL_EDGE)),
                cy: Math.max(lo, Math.min(cy, hi))
            };
        }

        function computePlacementAnchor(mode, rect, boxW, boxH) {
            const GAP = 24;   // 与光标/缩略图的间距
            const EDGE = 8;   // 与视口边缘的最小间隙
            const vw = window.innerWidth, vh = visualInnerH();
            const capResN = capbarReserve();   // near 模式下方也要给信息栏留位置，否则信息栏会出视口
            const clampC = (cx, cy) => ({
                cx: Math.max(boxW / 2 + EDGE, Math.min(cx, vw - boxW / 2 - EDGE)),
                cy: Math.max(boxH / 2 + EDGE, Math.min(cy, vh - boxH / 2 - EDGE - capResN))
            });
            if (mode === 'near') {
                const mx = lastMouse.x >= 0 ? lastMouse.x : vw / 2;
                const my = lastMouse.y >= 0 ? lastMouse.y : vh / 2;
                const onLeft = mx < vw / 2;   // 光标在左半屏 → 预览优先在光标右侧弹出
                // ★ 避让缩略图：光标就悬在缩略图上，直接从光标侧弹会盖住原图。
                //   候选顺序：光标侧（锚点取「光标与缩略图边缘的更外侧」）→ 对侧 → 都避不开才容忍重叠。
                const trySide = (side) => {
                    const cx0 = side === 'right'
                        ? Math.max(mx, rect.right) + GAP + boxW / 2
                        : Math.min(mx, rect.left) - GAP - boxW / 2;
                    const c = clampC(cx0, my);
                    const bL = c.cx - boxW / 2, bR = c.cx + boxW / 2;
                    const bT = c.cy - boxH / 2, bB = c.cy + boxH / 2;
                    const overlapsThumb = bL < rect.right && bR > rect.left && bT < rect.bottom && bB > rect.top;
                    return overlapsThumb ? null : c;
                };
                const primary = onLeft ? 'right' : 'left';
                return trySide(primary) || trySide(primary === 'right' ? 'left' : 'right')
                    || clampC(primary === 'right' ? mx + GAP + boxW / 2 : mx - GAP - boxW / 2, my);
            }
            // around 不在这里处理：它要「先按周围可用空间收缩尺寸、再定位」，见 pickAroundSide/computeAroundAnchor

            return null;
        }

        function createInstance(img) {
            try {
                const rect = img.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return null;
                const isSmallImg = rect.width < config.smallImgThreshold || rect.height < config.smallImgThreshold;
                let boxW, boxH, imgScale = 1;
                if (config.zoomMode === 'adaptive') {
                    const size = computeAdaptiveSize(img, rect);
                    boxW = size.w;
                    boxH = size.h;
                    imgScale = 1; // 容器已按图片原始比例校正，scale=1 → 完整显示不裁切
                } else if (isSmallImg) {
                    const effScale = Math.max(config.scale || 1, config.minScale || 1);
                    const targetW = Math.max(config.smallImgWidth, rect.width * effScale);
                    const targetH = Math.max(config.smallImgHeight, rect.height * effScale);
                    const fit = Math.min(targetW / rect.width, targetH / rect.height);
                    const caps = stepCaps();
                    boxW = Math.min(Math.round(rect.width * fit), caps.w);
                    boxH = Math.min(Math.round(rect.height * fit), caps.h);
                } else {
                    const effScale = Math.max(config.scale || 1, config.minScale || 1);
                    boxW = Math.round(rect.width * effScale);
                    boxH = Math.round(rect.height * effScale);
                    // ★ 按档位上限限制（跟随视口档宽度不设限；小视口下四档才有区分，见 stepCaps）
                    const caps = stepCaps();
                    if (boxW > caps.w || boxH > caps.h) {
                        const fit = Math.min(caps.w / boxW, caps.h / boxH);
                        boxW = Math.round(boxW * fit);
                        boxH = Math.round(boxH * fit);
                    }
                }
                // wheel 缩放模式建立独立缩放坐标系：
                // zoom=1 的宽度等于原缩略图渲染宽度，高度严格按实际图片比例推导。
                // 这样不会把缩略图比例误当成原图比例，也不会生成透明的横向容器。
                const naturalW = Number(img.naturalWidth) || 0;
                const naturalH = Number(img.naturalHeight) || 0;
                const naturalRatio = naturalW > 0 && naturalH > 0
                    ? naturalW / naturalH
                    : (rect.width / Math.max(1, rect.height));
                if (naturalRatio > 0) {
                    const boxRatio = boxW / Math.max(1, boxH);
                    if (naturalRatio > boxRatio) boxH = Math.max(1, Math.round(boxW / naturalRatio));
                    else boxW = Math.max(1, Math.round(boxH * naturalRatio));
                }

                let wheelBaseW = Math.max(1, rect.width);
                let wheelBaseH = Math.max(1, Math.round(wheelBaseW / naturalRatio));
                let wheelInitialZoom = 1;
                if (config.wheelZoom) {
                    // ★ 保留上面算好的首次放大尺寸（自适应/固定倍数结果），反推出倍率；
                    //   第一次滚轮在这个尺寸上继续放大。zoom 基准 = 源缩略图渲染尺寸。
                    //   ⚠ 曾误改为「min(原图像素, 视口) × 0.92」的适配模型——原图 1200px 时只显示
                    //   1104px，比原图还小 8%，比 5.8.0 的悬停放大观感小一大截（用户实测反馈）。
                    wheelInitialZoom = Math.max(1, boxW / wheelBaseW);
                    boxW = Math.max(1, Math.round(wheelBaseW * wheelInitialZoom));
                    boxH = Math.max(1, Math.round(wheelBaseH * wheelInitialZoom));
                }
                // ★ 显示位置锚点：center → 50%/50%（默认）；around → 先按周围可用空间
                //   收缩预览尺寸，再贴到该侧（浮图秀同款：绝不覆盖原图；周围空间不够就按空间缩放）
                let anchorX = '50%', anchorY = '50%';
                let placementMode = 'center';
                // ★ 单次覆盖（test.86）：刚关视频预览时的「避让」——见顶部 placeOnce 注释。
                //   读到即消耗（无论最终是否真的用上 around），保证只影响这一次预览。
                let effPlacement = config.previewPlacement;
                if (placeOnce && (Date.now() - placeOnceAt) <= PLACE_ONCE_WINDOW) effPlacement = placeOnce;
                placeOnce = null;
                // ★ around 的「选侧 + 原图矩形」要留给 onload 重锚用（见下方「非 center 显示位置重锚」）
                let aroundSide = null, aroundRect = null;
                if (effPlacement === 'around') {
                    const pick = pickAroundSide(rect);
                    if (pick) {
                        const lim = aroundLimits(pick.side, pick.space);
                        const fit = Math.min(1, (lim.w || 1) / boxW, (lim.h || 1) / boxH);
                        // 至少保留 25% 尺寸才有显示意义；再小说明四周实在没空间 → 回退居中
                        if (fit >= 0.25) {
                            if (fit < 1) {
                                boxW = Math.max(1, Math.round(boxW * fit));
                                boxH = Math.max(1, Math.round(boxH * fit));
                                wheelBaseW = boxW;      // 同步滚轮缩放基准（zoom=1 即这个「贴合尺寸」）
                                wheelBaseH = boxH;
                                // ★ 基准换了，倍率必须一起重算：否则 currentZoom 仍按旧基准（源缩略图宽）
                                //   计算，onload 里 zoomBaseW * currentZoom 会把盒子重新撑回未收缩前的大
                                //   尺寸 → around 又盖住原图。收缩后 zoom=1 必须 ⇔ 这个「贴合尺寸」。
                                wheelInitialZoom = 1;
                            }
                            const anchor = computeAroundAnchor(pick.side, rect, boxW, boxH);
                            if (anchor) {
                                anchorX = Math.round(anchor.cx) + 'px';
                                anchorY = Math.round(anchor.cy) + 'px';
                                placementMode = 'around';
                                aroundSide = pick.side;
                                aroundRect = {
                                    left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                                    width: rect.width, height: rect.height
                                };
                            }
                        }
                    }
                }
                // ★ center 模式：让「图片 + 信息栏」整体在视口内居中（test.113）。
                //   图片若严格居中（锚点 50%），下方还要挂信息栏 → 整体底部超出视口
                //   （实测 capbarOutVp = 33px = 视口高与图高之差的一半）。把锚点上移 capRes/2 即可。
                if (placementMode === 'center') {
                    const capResC = capbarReserve();
                    if (capResC > 0) anchorY = Math.round((visualInnerH() - capResC) / 2) + 'px';
                }
                const imgW = config.wheelZoom ? boxW : Math.round(boxW * imgScale);
                const imgH = config.wheelZoom ? boxH : Math.round(boxH * imgScale);
                const offX = Math.round((boxW - imgW) / 2);
                const offY = Math.round((boxH - imgH) / 2);
                const zi = img.__zoomHasClick ? config.zoomZIndex - 1 : config.zoomZIndex;
                const container = document.createElement('div');
                container.className = 'image-zoom-container';
                container.dataset.izOwner = 'fsm';
                container.style.cssText = `position:fixed;z-index:${zi};opacity:0;transition:opacity .3s ease;
                    pointer-events:none;left:${anchorX};top:${anchorY};transform:translate(-50%,-50%);
                    width:${boxW}px;height:${boxH}px;max-width:none;max-height:none;box-sizing:border-box;border-radius:10px;overflow:visible;`;
                // ★ 外壳（hull）：图片的背衬装饰层。绝对定位 inset 负值 → 不占容器尺寸、
                //   不参与任何几何计算（缩放/旋转/定位全部沿用既有逻辑），只负责视觉包裹。
                try {
                    const hull = document.createElement('div');
                    hull.className = 'hv-hull';
                    hull.setAttribute('aria-hidden', 'true');
                    container.appendChild(hull);
                } catch (e) { }
                const zoomedImg = document.createElement('img');
                zoomedImg.alt = '';
                zoomedImg.style.cssText = `position:absolute;left:${offX}px;top:${offY}px;width:${imgW}px;height:${imgH}px;
                    object-fit:fill;max-width:none;max-height:none;transition:opacity .2s ease;
                    image-rendering:auto;
                    box-shadow:0 6px 18px rgba(0,0,0,.22);
                    display:block;border-radius:10px;opacity:0;`;

                // ★ 必须优先 currentSrc。图片同时带 srcset 时，浏览器只加载 currentSrc，
                // 而 src 可能是个从未被请求、甚至不是图片的兜底地址（如页面路由）。
                // 实测：若取 src，放大图会加载失败 → 永远到不了 ACTIVE → 悬停预览不出现、
                // 滚轮缩放自然失效（表现为"滚轮没反应、页面跟着滚"）。
                const rawSrc = img.currentSrc || img.src;
                // ★ 源图自身加载失败时 currentSrc 为空，会退回相对路径的 src；
                // 相对地址直连易受 referer 策略影响，且 GM_xmlhttpRequest 无法抓取相对地址
                // —— 防盗链绕过等场景会因此直接失败。统一解析为绝对地址兜底。
                let fallbackSrc = rawSrc;
                if (rawSrc && !/^(?:[a-z]+:)?\/\//i.test(rawSrc) && !/^(?:data:|blob:)/i.test(rawSrc)) {
                    try { fallbackSrc = new URL(rawSrc, location.href).href; } catch (e) { fallbackSrc = rawSrc; }
                }
                // ★ 京东排除已移除（收编遗留 bug）：原内联两步已收编进 HD_UPGRADE_RULES（sized-dir / avif），
                //   但排除行没删，导致京东域名 hover 完全不做高清升级（内置+规则包规则全部失效）
                let hiResSrc = (fallbackSrc && upgradeImgUrl(fallbackSrc)) || null;
                if (hiResSrc === fallbackSrc) hiResSrc = null;

                const initialZoom = config.wheelZoom
                    ? wheelInitialZoom
                    : Math.max(1, Math.min(5, Math.min(boxW / rect.width, boxH / rect.height)));
                const inst = {
                    container, imgEl: zoomedImg, sourceImg: img,
                    generation,   // 创建时代际；异步回调据此判断是否过期
                    // 信息浮层专用的“展示用 URL”：黑边裁剪会把 imgEl.src 换成 blob:，
                    // 届时域名/格式都取不到，所以这里单独记一份真实来源地址。
                    fallbackSrc, infoSrc: fallbackSrc, usingHiRes: false, revealed: false,
                    sourceW: rect.width, sourceH: rect.height,
                    currentZoom: initialZoom,
                    // ★ 进入预览时的倍率（注意：它是相对「源缩略图尺寸」的倍数，通常远大于 1）。
                    // 「重置缩放」要还原到这里，而不是硬写成 1（那样会退化成缩略图大小）。
                    initialZoom: initialZoom,
                    // ★ 旋转/翻转状态（R / Shift+R 修改；applyZoom 据此换算显示比例）
                    rotation: 0, flipH: false, flipV: false,
                    // ★ 显示位置模式（center/near/around）：滚轮缩放/高清换图后据此重新收拢锚点
                    placementMode: placementMode,
                    // ★ around 重锚所需的选侧与原图矩形快照（near/center 为 null）
                    aroundSide: aroundSide,
                    aroundRect: aroundRect,
                    wheelZoom: !!config.wheelZoom,
                    zoomBaseW: config.wheelZoom ? wheelBaseW : rect.width,
                    zoomBaseH: config.wheelZoom ? wheelBaseH : rect.height,
                    imageRatio: naturalRatio
                };
                container.__zoomInstance = inst;
                // ★ 图集：记录同容器内的图片列表与当前位置（← / → 翻页 + 预览框内「3/9」指示）
                try {
                    inst.galleryList = collectGalleryImages(img);
                    inst.galleryIndex = Math.max(0, inst.galleryList.indexOf(img));
                } catch (e) { inst.galleryList = [img]; inst.galleryIndex = 0; }

                zoomedImg.onload = () => {
                    if (inst.generation !== generation || instance !== inst) return; // 过期代际/实例回调直接丢弃
                    // ★ 「软 404」防护：服务器对不存在路径返回 200 + 空/非图响应时，图片会「加载成功」
                    //   但无有效像素（naturalWidth=0）→ 会渲染成一个空白框 + 空信息栏
                    //   （2026-09-19 全功能实机测试问题 2）。按加载失败处理，不进预览。
                    // ★ 同一条兜底也覆盖「1×1 占位/跟踪像素」：真实像素 ≤1×1 的图无论来自
                    //   文件还是 data:，都不该渲染成被撑大的空白块（GAP-1，与 data: 分支同判据）。
                    if (!(zoomedImg.naturalWidth > 0 && zoomedImg.naturalHeight > 0) ||
                        (zoomedImg.naturalWidth <= 1 && zoomedImg.naturalHeight <= 1)) {
                        FSM.dispatch('ERROR', inst);
                        return;
                    }
                    if (inst.wheelZoom && zoomedImg.naturalWidth > 0 && zoomedImg.naturalHeight > 0) {
                        const nextRatio = zoomedImg.naturalWidth / zoomedImg.naturalHeight;
                        // ★ w/h 提升到外层作用域：下方「非 center 显示位置重锚」(placement near/around) 也要用。
                        //   原来只在内层 if（宽高比变化才进入）里 const 声明 → 宽高比未变时下方引用 w 会
                        //   ReferenceError: w is not defined（around/near + wheelZoom + 高清图与原图同比例必现）。
                        let w = Math.max(1, Math.round(inst.zoomBaseW * inst.currentZoom));
                        let h = Math.max(1, Math.round(inst.zoomBaseH * inst.currentZoom));
                        if (nextRatio > 0 && Math.abs(nextRatio - inst.imageRatio) > 0.0001) {
                            inst.imageRatio = nextRatio;
                            inst.zoomBaseH = Math.max(1, inst.zoomBaseW / nextRatio);
                            w = Math.max(1, Math.round(inst.zoomBaseW * inst.currentZoom));
                            h = Math.max(1, Math.round(inst.zoomBaseH * inst.currentZoom));
                            inst.container.style.setProperty('width', w + 'px', 'important');
                            inst.container.style.setProperty('height', h + 'px', 'important');
                            zoomedImg.style.setProperty('width', w + 'px', 'important');
                            zoomedImg.style.setProperty('height', h + 'px', 'important');
                        }
                        // ★ 兜底：滚轮模式下高清图/大比例图加载后，仍须遵守「自适应初始放大不超视口」语义。
                        //   无黑边竖图不会触发 cropBlackBars 的 kFit，这里统一把初始盒收进可用空间（含 capbar 预留）。
                        {
                            const capRes = capbarReserve();
                            const follow = (sizeStepIndex() === 3);
                            // ★ 跟随视口档：宽度基本不设限（仅在极端横图超过视口宽时兜底），纵向用「页面高度 − 信息栏」；
                            //   小/中/大档保留 60px 边距（与 computeAdaptiveSize 的档位框一致）。
                            const availW = Math.max(160, window.innerWidth - (follow ? 0 : 60));
                            const availH = Math.max(160, visualInnerH() - (follow ? capRes : (60 + capRes)));
                            const kFit = Math.min(1, availW / w, availH / h);
                            if (kFit < 1) {
                                w = Math.max(1, Math.round(w * kFit));
                                h = Math.max(1, Math.round(h * kFit));
                                inst.container.style.setProperty('width', w + 'px', 'important');
                                inst.container.style.setProperty('height', h + 'px', 'important');
                                zoomedImg.style.setProperty('width', w + 'px', 'important');
                                zoomedImg.style.setProperty('height', h + 'px', 'important');
                                // ★ 同步滚轮缩放基准：kFit 改变了显示尺寸，若不更新 zoomBaseW/H，
                                //   首次滚轮会按旧基准重算（zoomBaseW × newZoom）→ 尺寸跳变
                                //   （竖图"首次滚轮先变很大"bug，与 cropBlackBars 滚轮分支同款处理）。
                                const cz = Number(inst.currentZoom) > 0 ? inst.currentZoom : 1;
                                inst.zoomBaseW = Math.max(1, w / cz);
                                inst.zoomBaseH = Math.max(1, h / cz);
                            }
                        }
                        // ★ 重采样分级策略：缩小 / ≈1:1 → auto（平滑）；放大超原图且 ≤3 倍 →
                        //   crisp-edges（Nearest，锐利，浮图秀观感）；>3 倍 → auto（Nearest 高倍
                        //   放大是马赛克，dlsjs.com 230px→1300px 实例）。
                        try {
                            const dispW = parseFloat(zoomedImg.style.width) || 0;
                            const natW = zoomedImg.naturalWidth || 0;
                            if (dispW > 0 && natW > 0) {
                                zoomedImg.style.imageRendering = (dispW > natW + 1 && dispW / natW <= 3) ? 'crisp-edges' : 'auto';
                            }
                        } catch (e) { }
                        // ★ 非 center 显示位置：高清换图重算尺寸后收拢锚点（仍按当前倍率的盒子算，
                        //   不干预用户此后的滚轮放大/平移自由）
                        if (inst.placementMode === 'near') {
                            const c = inst.container;
                            const fitAxis = (cur, half, total) =>
                                (half * 2 + 16 > total) ? total / 2
                                    : Math.max(half + 8, Math.min(cur, total - half - 8));
                            c.style.left = fitAxis(parseFloat(c.style.left) || window.innerWidth / 2, w / 2, window.innerWidth) + 'px';
                            c.style.top = fitAxis(parseFloat(c.style.top) || window.innerHeight / 2, h / 2, window.innerHeight) + 'px';
                        } else if (inst.placementMode === 'around' && inst.aroundSide && inst.aroundRect) {
                            // ★ around 绝不能走上面的视口 clamp：那个 fitAxis 在「盒子宽于视口−16」时
                            //   直接返回 total/2（屏幕居中），会把 createInstance 算好的 around 锚点抹掉
                            //   → 预览退化为居中并盖住原图，与「原图周围·不遮挡」语义直接冲突
                            //   （wheelZoom 开＝默认值，稳定必现；管用闭合条件下 wheelZoom 关才正常）。
                            //   around 的定位语义是「贴在原图某一侧」，所以这里必须按当时的选侧与原图矩形
                            //   重算锚点；computeAroundAnchor 只在盒子实在放不下时才做边缘兜底。
                            const c = inst.container;
                            const curW = c.offsetWidth || w;
                            const curH = c.offsetHeight || h;
                            const a = computeAroundAnchor(inst.aroundSide, inst.aroundRect, curW, curH);
                            if (a) {
                                c.style.left = Math.round(a.cx) + 'px';
                                c.style.top = Math.round(a.cy) + 'px';
                            }
                        }
                    }
                    // ★ 非滚轮模式：容器尺寸在 createInstance 里定好后不再变化（尺寸语义固定）。
                    // 但这里加载成功的图未必就是建实例时那张——最典型的是后台探活通过后
                    // 替换成的高清图，宽高比可能与缩略图不同。此时若不按新比例重做一次
                    // contain 适配，内联的 object-fit:fill 会把图片拉伸变形
                    //（cropBlackBars 在“几乎无黑边”时会提前 return，兜不住这种情况）。
                    // 比例一致时计算结果与建实例时完全相同，不会产生任何视觉变化。
                    if (!inst.wheelZoom && zoomedImg.naturalWidth > 0 && zoomedImg.naturalHeight > 0) {
                        refitInstanceImage(inst);
                    }
                    // 滚轮缩放模式不参与异步黑边裁剪：裁剪会改变图片天然比例并在 toBlob 回调中重新布局，
                    // 从而造成首个滚轮“先缩小一下”以及竖图跳回最小尺寸/出现透明框。
                    // ★ 黑边裁剪对「滚轮缩放模式」同样启用（此前被 !inst.wheelZoom 挡掉，
                    //   导致换高清图后若带黑边就永远不裁：竖图上下长黑边把天然比例撑高，
                    //   预览随之变大 → 超出页面）。
                    //   cropBlackBars 内部的滚轮保护分支（反推 zoom=1 基准、保持当前视觉尺寸
                    //   不跳变）早已就位，放开调用点即为其预设用途。
                    cropBlackBars(zoomedImg);
                    updateImageInfo(inst);
                    // ★ 信息栏构建完成后再校正一次尺寸（test.110）：早期 capbarReserve() 只能拿到兜底值
                    //   （56px），若实际信息栏更矮，会白少留纵向空间 → 跟随档图偏小（哥哥反馈「跟随视口不够大」）。
                    //   这里用【实际】信息栏高度重算可用高度并等比校正；仅「初始未缩放」时生效，不干扰滚轮。
                    try {
                        if (inst.wheelZoom && Math.abs(Number(inst.currentZoom) - Number(inst.initialZoom)) < 0.001) {
                            // ★ 必须用 stepCaps() 按档位取框（此时 capbarReserve() 已能拿到实际信息栏高度）；
                            //   若对所有档统一用「视口−边距−信息栏」，小/中/大三档会被一起放大到同一上限 → 档位被抹平。
                            const caps2 = stepCaps();
                            const availW2 = caps2.w, availH2 = caps2.h;
                            const curW = inst.container.offsetWidth, curH = inst.container.offsetHeight;
                            if (curW > 0 && curH > 0) {
                                const k2 = Math.min(availW2 / curW, availH2 / curH);
                                if (Math.abs(k2 - 1) > 0.01) {
                                    const nw = Math.max(1, Math.round(curW * k2));
                                    const nh = Math.max(1, Math.round(curH * k2));
                                    inst.container.style.setProperty('width', nw + 'px', 'important');
                                    inst.container.style.setProperty('height', nh + 'px', 'important');
                                    inst.imgEl.style.setProperty('width', nw + 'px', 'important');
                                    inst.imgEl.style.setProperty('height', nh + 'px', 'important');
                                    const cz = Number(inst.currentZoom) > 0 ? inst.currentZoom : 1;
                                    inst.zoomBaseW = Math.max(1, nw / cz);
                                    inst.zoomBaseH = Math.max(1, nh / cz);
                                    if (inst.placementMode === 'around' && inst.aroundSide && inst.aroundRect) {
                                        const a = computeAroundAnchor(inst.aroundSide, inst.aroundRect, nw, nh);
                                        if (a) { inst.container.style.left = Math.round(a.cx) + 'px'; inst.container.style.top = Math.round(a.cy) + 'px'; }
                                    } else if (inst.placementMode === 'near') {
                                        const c = inst.container;
                                        const fitAxis = (cur, half, total) => (half * 2 + 16 > total) ? total / 2 : Math.max(half + 8, Math.min(cur, total - half - 8));
                                        c.style.left = fitAxis(parseFloat(c.style.left) || window.innerWidth / 2, nw / 2, window.innerWidth) + 'px';
                                        c.style.top = fitAxis(parseFloat(c.style.top) || window.innerHeight / 2, nh / 2, window.innerHeight) + 'px';
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                    if (!inst.revealed) {
                        inst.revealed = true;
                        FSM.dispatch('LOADED', inst);
                    }
                };
                zoomedImg.onerror = () => {
                    if (inst.generation !== generation || instance !== inst) return;
                    // ★ 防盗链绕过兜底：URL 无尺寸指令（无升级候选）且尚未用脚本身份抓取过时，
                    //   原图直连失败就直接用 GM 身份重新抓取（带 referer 被 403 的典型防盗链场景）。
                    if (hdCandidates.length === 0 && !zoomedImg.__zoomBlobUrl) {
                        gmFetchBlobUrl(fallbackSrc)
                            .then((blobUrl) => applyHiRes(fallbackSrc, blobUrl))
                            .catch(() => { FSM.dispatch('ERROR', inst); });
                        return;
                    }
                    FSM.dispatch('ERROR', inst);
                };

                zoomedImg.src = fallbackSrc;

                // ★ 智能高清升级器：两段式探测 —— 先探「规则链结果」（够用就停，不浪费流量），
                //   不够用/不可用再探「尺寸档位变体」；全失败再走防盗链抓取；都失败保持源图。
                const hd = (function () {
                    try { return buildHdCandidates(fallbackSrc); } catch (e) { return { primary: [], variants: [] }; }
                })();
                const hdPrimary = (function () {
                    const arr = [];
                    if (hiResSrc) arr.push(hiResSrc);            // 只先探「规则链的最终结果」
                    return arr;
                })();
                const hdExtra = hd.primary.concat(hd.variants)
                    .filter(function (u) { return hdPrimary.indexOf(u) < 0; })
                    .slice(0, HD_MAX_CANDIDATES);
                const hdCandidates = hdPrimary.concat(hdExtra);
                const ac = currentAbort;
                const applyHiRes = (finalUrl, blobUrl) => {
                    if (ac && ac.signal.aborted) return;
                    if (inst.generation !== generation) return;
                    if (!zoomedImg.isConnected) { if (blobUrl) releaseBlobUrl(blobUrl); return; }
                    if (!blobUrl && zoomedImg.src === finalUrl) return;
                    if (zoomedImg.__zoomBlobUrl) releaseBlobUrl(zoomedImg.__zoomBlobUrl);
                    zoomedImg.__zoomBlobUrl = blobUrl || null;
                    delete zoomedImg.dataset.zoomCropped;
                    inst.usingHiRes = true;
                    inst.infoSrc = finalUrl;
                    zoomedImg.src = blobUrl || finalUrl;
                    updateImageInfo(inst);
                };
                if (hdCandidates.length) {
                    if (HV_DEBUG) { inst.hdDiag = '最终结果' + hdPrimary.length + '·备选' + hdExtra.length; updateImageInfo(inst); }
                    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
                    const availNow = Math.min(
                        Math.min(window.innerWidth - 60, config.maxWidth),
                        Math.min(window.innerHeight - 60, config.maxHeight)
                    );
                    // 够用标准 = 预览可能的最大显示尺寸 × 设备像素比（不加余量：宁可取小一档，也别为了清晰抓巨图）
                    const needMax = Math.max(600, Math.min(2400, Math.round(availNow * dpr)));
                    const finishWith = (loaded, extra) => {
                        if (ac && ac.signal.aborted) return;
                        const best = pickBestCandidate(loaded, needMax);
                        if (HV_DEBUG) { inst.hdDiag = hdCandidates.length + '候选·探成' + loaded.length + '·选' + (best ? Math.max(best.w, best.h) + 'px' : '无') + '·需' + needMax + (extra || ''); }
                        if (best) { applyHiRes(best.url, null); return; }
                        // 全部直连失败 → 防盗链绕过（以脚本身份抓第一候选）
                        gmFetchBlobUrl(hdCandidates[0])
                            .then((blobUrl) => applyHiRes(hdCandidates[0], blobUrl))
                            .catch(() => { if (HV_DEBUG) updateImageInfo(inst); /* 静默回退：保持源图预览 */ });
                    };
                    if (hdPrimary.length) {
                        probeCandidates(hdPrimary, 2500).then((loaded1) => {
                            if (ac && ac.signal.aborted) return;
                            const enough = loaded1.filter((c) => Math.max(c.w, c.h) >= needMax);
                            if (enough.length || !hdExtra.length) { finishWith(loaded1, enough.length ? '·够用即停' : ''); return; }
                            // 规则结果不够用/不可用 → 再探备选（中间态 + 尺寸变体）
                            probeCandidates(hdExtra, 2500).then((loaded2) => finishWith(loaded1.concat(loaded2), '·含备选'));
                        });
                    } else {
                        probeCandidates(hdExtra, 2500).then((loaded) => finishWith(loaded, '·仅备选'));
                    }
                }

                if (zoomedImg.complete && zoomedImg.naturalWidth > 0 && !inst.revealed) {
                    inst.revealed = true;
                    setTimeout(() => {
                        if (inst.generation === generation && instance === inst) FSM.dispatch('LOADED', inst);
                    }, 10);
                }

                container.appendChild(zoomedImg);
                document.body.appendChild(container);
                return inst;
            } catch (error) {
                console.warn('[FSM] 创建放大实例失败:', error);
                return null;
            }
        }

        const actions = {
            startPending(img) {
                clearPending();
                pendingImg = img;
                pendingImageForIndicator = img;
                scheduleHoverWaitIndicator(img);
                pendingTimer = setTimeout(() => FSM.dispatch('TIMER_FIRE', img), config.delay);
                state = S.PENDING;
            },
            cancel() {
                clearPending();
                generation++;                       // ★ 作废在途异步任务
                if (currentAbort) { currentAbort.abort(); currentAbort = null; }
                state = S.IDLE;
            },
            show(img) {
                // ★ 等待动画保持显示，直到该实例真正 LOADED/ACTIVE。
                // 新目标：作废上一代在途任务并开启新代（ADR-002）
                if (currentAbort) currentAbort.abort();
                currentAbort = new AbortController();
                generation++;
                const inst = createInstance(img);
                if (!inst) {
                    hideHoverWaitIndicator();
                    state = S.IDLE;
                    wheelManager.sync();
                    return;
                }
                instance = inst;
                state = S.SHOWING;
                wheelManager.sync();
            },
            activate(inst) {
                if (inst.generation !== generation || inst !== instance) return;
                hideHoverWaitIndicator();
                // ★ 入场动画（动画模式由 ptEnter 接管显示观感；返回 false 时退回纯淡入）
                if (!ptEnter(inst)) {
                    inst.container.style.opacity = '1';
                    inst.imgEl.style.opacity = '1';
                }
                // 容器已完全显示，此刻刷新信息浮层并亮出（加载阶段先不显）
                updateImageInfo(inst);
                // ★ 历史记录：预览真正显示出来才记（图集翻页每张各记一条）
                recordHistory(inst);
                // ★ 反馈截图：留一份小尺寸快照（仅本地，供面板「反馈问题」附带）
                capturePreviewShot(inst);
                // 图片超出视口时提示当前滚轮操作（1200ms 后自动消失，避免遮挡）
                if (inst.container.offsetHeight > window.innerHeight && !inst.toastShown) {
                    inst.toastShown = true;
                    showToast(config.wheelZoom ? '滚动滚轮缩放图片' : '图片超出屏幕，滚动滚轮查看其余部分', 800);
                }
                state = S.ACTIVE;
                // ★ 通知其他 frame：本 frame 已有 ACTIVE 预览
                arbiterStartRenew();
                // ★ P1 竞态修复：准入检查与占位是两次独立读写，两帧可能同时通过。
                //   这里在复核窗口后再确认归属，输的一方主动让出，保证屏幕上只有一个预览。
                (function verifyArbiter() {
                    const gen = generation, instRef = inst;
                    setTimeout(() => {
                        // 期间已切图 / 已收起 → 不属于本次仲裁范围，不动
                        if (instance !== instRef || generation !== gen) return;
                        if (!arbiterElectionLost()) return;      // 赢得选举 → 正常保留
                        arbiterCooldownUntil = Date.now() + ARBITER_COOLDOWN;
                        arbiterStopRenew();
                        // 回退：HOVER_NONE(force) 会走 beginFade，一并释放仲裁
                        FSM.dispatch('HOVER_NONE', { x: lastMouse.x, y: lastMouse.y, force: true });
                    }, ARBITER_SETTLE);
                })();
            },
            onError(inst) {
                if (inst.generation !== generation || inst !== instance) return;
                if (inst.usingHiRes) {
                    inst.usingHiRes = false;
                    inst.imgEl.src = inst.fallbackSrc;
                    return;
                }
                if (currentAbort) { currentAbort.abort(); currentAbort = null; }
                fadeOutContainer(inst.container);
                instance = null;
                state = S.IDLE;
                wheelManager.sync();
                // ★ 源图直连、高清候选、GM 兜底抓取全部失败：给出明确提示，
                //   避免用户「悬停后空白框一闪 / 无任何反应」却不知为何（2026-09-19 全功能实机测试问题 2）。
                try { showToast('图片加载失败，已跳过'); } catch (e) { }
            },
            beginFade() {
                clearPending();
                generation++;                       // ★ 离开/切换：立即作废在途任务（ADR-003）
                if (currentAbort) { currentAbort.abort(); currentAbort = null; }
                if (instance) {
                    fadeOutContainer(instance.container);
                    instance = null;
                }
                state = S.FADING;
                arbiterStopRenew();                 // ★ 预览开始淡出即释放仲裁
                setTimeout(() => { if (state === S.FADING) state = S.IDLE; }, FADE_MS);
                wheelManager.sync();
            },
            // 最大倍率：按原图分辨率动态放宽，但不生成失控的超大 DOM（拿不到原图尺寸时用保守上限）
            maxZoomFor(inst) {
                const naturalW = Number(inst && inst.sourceImg && inst.sourceImg.naturalWidth) || 0;
                const naturalH = Number(inst && inst.sourceImg && inst.sourceImg.naturalHeight) || 0;
                const basePixels = naturalW > 0 && naturalH > 0 ? naturalW * naturalH : 0;
                const resolutionZoom = basePixels > 0
                    ? Math.sqrt((12000000) / basePixels) * Math.max(1, Math.min(4, Math.max(naturalW, naturalH) / 1200))
                    : 24;
                return Math.max(20, Math.min(50, resolutionZoom));
            },
            // 把某个倍率真正落到容器/图片上。★ 滚轮与键盘走同一条路径，避免两套缩放逻辑跑偏。
            // force=true 时即使倍率没变也重新应用（旋转/翻转只改朝向，倍率不变）。
            applyZoom(inst, wantZoom, force) {
                if (!inst) return false;
                const c = inst.container, im = inst.imgEl;
                if (!c || !im) return false;
                const sourceW = Number(inst.sourceW) || (inst.sourceImg ? inst.sourceImg.getBoundingClientRect().width : 0);
                const sourceH = Number(inst.sourceH) || (inst.sourceImg ? inst.sourceImg.getBoundingClientRect().height : 0);
                if (!(sourceW > 0 && sourceH > 0)) return false;

                // 始终以 1× 为下限；上限按原图分辨率动态计算。
                const current = Number.isFinite(inst.currentZoom) ? inst.currentZoom : 1;
                const nextZoom = Math.max(1, Math.min(actions.maxZoomFor(inst), Number(wantZoom) || 1));
                if (!force && Math.abs(nextZoom - current) < 0.0001) return false;
                inst.currentZoom = nextZoom;

                // 宽高始终由同一个缩放倍率计算，绝不分别缩放，保证横竖图比例恒定。
                // 缩放基准固定为实例当前的 zoom=1 尺寸。
                // 裁剪、高清图替换等异步过程不会再把这个基准重置成容器尺寸。
                const baseW = Number(inst.zoomBaseW) > 0 ? inst.zoomBaseW : sourceW;
                const ratio = Number(inst.imageRatio) > 0 ? inst.imageRatio : (sourceW / Math.max(1, sourceH));
                const baseH = Number(inst.zoomBaseH) > 0 ? inst.zoomBaseH : (baseW / ratio);

                // ★ 旋转/翻转：旋转 90/270 时「显示比例」要交换，旋转施加在容器上
                //   （图片只负责填满容器，容器整体旋转 → 比例天然正确，也不干扰图片自身的平移逻辑）。
                const rot = ((Number(inst.rotation) || 0) % 360 + 360) % 360;
                const swapped = (rot % 180) !== 0;
                // 容器盒子：旋转后要占的位（90/270 时与图片自身宽高互换）
                const visW = swapped ? baseH : baseW;
                const visH = swapped ? baseW : baseH;
                const w = Math.max(1, Math.round(visW * nextZoom));
                const h = Math.max(1, Math.round(visH * nextZoom));
                // 图片自身尺寸：★ 始终按自身比例，绝不跟着容器交换 ——
                // 否则图片会被拉伸变形（旋转是靠容器转，图片只要居中即可）。
                const iw = Math.max(1, Math.round(baseW * nextZoom));
                const ih = Math.max(1, Math.round(baseH * nextZoom));

                const tf = ['translate(-50%, -50%)'];
                if (rot) tf.push('rotate(' + rot + 'deg)');
                if (inst.flipH) tf.push('scaleX(-1)');
                if (inst.flipV) tf.push('scaleY(-1)');

                c.style.setProperty('width', w + 'px', 'important');
                c.style.setProperty('height', h + 'px', 'important');
                c.style.setProperty('max-width', 'none', 'important');
                c.style.setProperty('max-height', 'none', 'important');
                c.style.setProperty('overflow', 'visible', 'important');
                c.style.transform = tf.join(' ');
                // 旋转/翻转时隐藏信息栏（外壳保留）：文字跟着倒转或镜像会很难读。
                // 同时改 class 与内联 opacity —— 内联样式才能稳定压过后面的 setOpacity 同步。
                try {
                    const hideCap = !!(rot || inst.flipH || inst.flipV);
                    c.classList.toggle('hv-nocap', hideCap);
                    const bar = c.querySelector('.hv-capbar');
                    if (bar) bar.style.opacity = hideCap ? '0' : '1';
                } catch (e) { }
                // ⚠ 不在这里 clamp 锚点：滚轮放大后预览超出视口 + 平移查看是 5.8.0 以来的设计行为，
                //   收拢只发生在「初始显示」（createInstance）与「高清换图重算尺寸后」（zoomedImg.onload）。
                // ⚠ 维持既有设计（5.8.0 起）：缩放时不 clamp 锚点，手动滚轮放大允许超出视口 + 平移查看。
                inst.panY = 0;

                im.style.setProperty('width', iw + 'px', 'important');
                im.style.setProperty('height', ih + 'px', 'important');
                im.style.setProperty('max-width', 'none', 'important');
                im.style.setProperty('max-height', 'none', 'important');
                im.style.setProperty('min-width', '0', 'important');
                im.style.setProperty('min-height', '0', 'important');
                im.style.setProperty('object-fit', 'contain', 'important');
                // ★ 重采样分级策略：缩小 / ≈1:1 → auto（平滑）；放大超原图时分倍率——
                //   ≤3 倍用 crisp-edges（Nearest，锐利，浮图秀观感）；>3 倍用 auto（Nearest
                //   高倍放大会出马赛克，dlsjs.com 230px→1300px 实例）。
                try {
                    const nw2 = im.naturalWidth || 0, nh2 = im.naturalHeight || 0;
                    if (nw2 > 0 && nh2 > 0) {
                        const up = (iw > nw2 + 1) || (ih > nh2 + 1);
                        const k = Math.max(iw / nw2, ih / nh2);
                        im.style.imageRendering = (up && k <= 3) ? 'crisp-edges' : 'auto';
                    }
                } catch (e) { }

                if (swapped) {
                    // 旋转 90/270：容器盒子与图片宽高互换，图片必须居中才不会被转偏
                    im.style.setProperty('left', '50%', 'important');
                    im.style.setProperty('top', '50%', 'important');
                    im.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
                } else {
                    // 未旋转：保持既有定位（平移逻辑依赖 left/top 为 0）
                    im.style.setProperty('left', '0px', 'important');
                    im.style.setProperty('top', '0px', 'important');
                    im.style.setProperty('transform', 'none', 'important');
                }
                // ★ 外壳（hull）必须跟着「图片」定盒，而不是跟着容器盒（2026-09-20 实测）：
                //   hull 原本是 CSS `inset:-10px`（= 容器盒 + 10px），而旋转 90/270 时
                //   容器盒被互换（762×1016）但图片仍保持自身宽高（1016×762，靠父级旋转换向）
                //   → 旋转后 hull 仍是「旋转前的横向框」、图片却是竖向 → 图上下伸出框外，
                //   视觉上就是「框留在原地不跟着转」。
                //   这里按图片实际尺寸显式给 hull 定盒并居中；hull 是容器子元素，会随容器一起旋转，
                //   所以换向自然跟着走。未旋转时该式退化为原来的 inset:-10px（数值完全一致）。
                try {
                    const hull = c.querySelector('.hv-hull');
                    if (hull) {
                        const hw = iw + 20, hh = ih + 20;
                        hull.style.setProperty('width', hw + 'px', 'important');
                        hull.style.setProperty('height', hh + 'px', 'important');
                        hull.style.setProperty('left', Math.round((w - hw) / 2) + 'px', 'important');
                        hull.style.setProperty('top', Math.round((h - hh) / 2) + 'px', 'important');
                        hull.style.setProperty('right', 'auto', 'important');
                        hull.style.setProperty('bottom', 'auto', 'important');
                    }
                } catch (e) { }
                return true;
            },
            // 乘法步进缩放（键盘 +/- 与滚轮共用同一条路径）
            zoomBy(factor) {
                if (!instance) return false;
                const current = Number.isFinite(instance.currentZoom) ? instance.currentZoom : 1;
                return actions.applyZoom(instance, current * factor);
            },
            // 回到「进入预览时的尺寸」（即撤销所有缩放）。
            // 注意不能写成 applyZoom(instance, 1)：currentZoom 是相对源缩略图尺寸的倍数，
            // 初始倍率通常远大于 1（例如缩略图 220px、预览 1158px → 初始 5.26×），
            // 硬写成 1 会把预览缩回缩略图大小。
            resetZoom() {
                if (!instance) return false;
                const base = Number.isFinite(instance.initialZoom) && instance.initialZoom > 0
                    ? instance.initialZoom
                    : (Number.isFinite(instance.currentZoom) ? instance.currentZoom : 1);
                return actions.applyZoom(instance, base);
            },
            // ★ 保存图片：优先存「高清原图」地址。
            // inst.infoSrc 始终是真实来源地址（高清升级成功时已换成升级后的），
            // 而 imgEl.src 在黑边裁剪后可能是 blob:，不能拿来下载。
            saveImage() {
                if (!instance) return false;
                const inst = instance;
                const url = String(inst.infoSrc || inst.fallbackSrc || '').trim();
                if (!url) { showToast('没有可保存的图片地址', 1600); return true; }
                const name = buildDownloadName(inst, url);

                // 1) 首选 GM_download：能正确处理跨域 / 防盗链，也不会把页面导航走
                try {
                    if (typeof GM_download === 'function') {
                        GM_download({
                            url: url,
                            name: name,
                            saveAs: false,
                            onload: function () { showToast('已保存：' + name, 1800); },
                            onerror: function () { downloadViaAnchor(url, name); }
                        });
                        return true;
                    }
                } catch (e) { }

                // 2) 降级：<a download>
                downloadViaAnchor(url, name);
                return true;
            },
            // 图集打包下载（z）：把当前图集整组抓下来打成一个 ZIP
            async downloadGalleryZip() {
                return await downloadGalleryZipFor(instance);
            },
            // 复制图片地址（c）
            copyLink() {
                if (!instance) return false;
                const url = String(instance.infoSrc || instance.fallbackSrc || '').trim();
                if (!url) { showToast('没有可复制的地址', 1600); return true; }
                copyText(url).then(function (ok) {
                    showToast(ok ? '已复制图片地址' : '复制失败（浏览器限制）', 1600);
                });
                return true;
            },
            // 复制图片本体（Shift+C）
            copyImage() {
                if (!instance) return false;
                copyImageBody(instance).then(function (r) {
                    if (r === 'ok') showToast('已复制图片', 1500);
                    else if (r === 'unsupported') showToast('此浏览器不支持复制图片', 1800);
                    else if (r === 'tainted') showToast('该图片受跨域限制，无法复制', 2000);
                    else showToast('复制图片失败', 1600);
                });
                return true;
            },
            // 顺时针旋转 90°（r）
            rotateBy() {
                if (!instance) return false;
                instance.rotation = (((Number(instance.rotation) || 0) + 90) % 360);
                actions.applyZoom(instance, instance.currentZoom, true);
                showToast('已旋转 ' + instance.rotation + '°', 900);
                return true;
            },
            // 水平翻转（Shift+R）
            flipHorizontal() {
                if (!instance) return false;
                instance.flipH = !instance.flipH;
                actions.applyZoom(instance, instance.currentZoom, true);
                showToast(instance.flipH ? '已水平翻转' : '已还原水平方向', 900);
                return true;
            },
            // 图集翻页（← / →）。复用 beginFade + startPending，绕过"光标下必须是这张图"的检查。
            switchGallery(dir) {
                const inst = instance;
                if (!inst) return false;
                const list = inst.galleryList || [];
                if (list.length < 2) { showToast('当前不是图集', 1000); return true; }
                let i = list.indexOf(inst.sourceImg);
                if (i < 0) i = inst.galleryIndex || 0;
                const next = (i + dir + list.length) % list.length;
                const target = list[next];
                if (!target || !target.isConnected || target === inst.sourceImg) {
                    showToast('第 ' + (next + 1) + ' 张不可用', 1000);
                    return true;
                }
                actions.beginFade();
                // ★ 记住翻页时的光标位置：本次预览显示的是"不在光标下"的另一张图，
                // 需要让心跳的几何校验放行，否则新图一显示就被判为无效而取消。
                galleryHoldAt = { x: lastMouse.x, y: lastMouse.y };
                actions.startPending(target);
                showToast((next + 1) + '/' + list.length, 800);
                return true;
            },
            // 全屏（f）。对 documentElement 全屏：预览本来就是覆盖全页居中的，无需改动布局，
            // 只需在进出时按屏幕重算一次缩放基准。
            toggleFullscreen() {
                try {
                    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
                    if (isFs) {
                        const exit = document.exitFullscreen || document.webkitExitFullscreen;
                        if (exit) exit.call(document);
                    } else {
                        const el = document.documentElement;
                        const req = el.requestFullscreen || el.webkitRequestFullscreen;
                        if (!req) { showToast('此环境不支持全屏', 1500); return true; }
                        const p = req.call(el);
                        if (p && p.catch) p.catch(function () { showToast('全屏被拒绝', 1500); });
                    }
                } catch (e) { showToast('全屏失败', 1500); }
                return true;
            },
            // 进出全屏时重算缩放基准：全屏下让图片按整个屏幕适配，退出时还原原基准与倍率
            applyFullscreenLayout(on) {
                const inst = instance;
                if (!inst) return;
                if (on) {
                    if (inst.fsSaved) return;
                    inst.fsSaved = { baseW: inst.zoomBaseW, baseH: inst.zoomBaseH, zoom: inst.currentZoom, ratio: inst.imageRatio };
                    const zImg = inst.imgEl;
                    const natW = (zImg && zImg.naturalWidth) || inst.zoomBaseW || 1;
                    const natH = (zImg && zImg.naturalHeight) || inst.zoomBaseH || 1;
                    const ratio = (natW > 0 && natH > 0) ? (natW / natH) : (inst.imageRatio || 1.5);
                    const vw = Math.max(100, window.innerWidth - 40);
                    const vh = Math.max(100, window.innerHeight - 40);
                    let fw = vw, fh = vw / ratio;
                    if (fh > vh) { fh = vh; fw = fh * ratio; }
                    inst.zoomBaseW = Math.max(1, Math.round(fw));
                    inst.zoomBaseH = Math.max(1, Math.round(fh));
                    inst.imageRatio = ratio;
                    inst.currentZoom = 1;
                    inst.fullscreen = true;
                } else {
                    if (!inst.fsSaved) return;
                    inst.zoomBaseW = inst.fsSaved.baseW;
                    inst.zoomBaseH = inst.fsSaved.baseH;
                    inst.imageRatio = inst.fsSaved.ratio;
                    inst.currentZoom = inst.fsSaved.zoom;
                    inst.fsSaved = null;
                    inst.fullscreen = false;
                }
                actions.applyZoom(inst, inst.currentZoom, true);
            },
            zoomByWheel(e) {
                // 缩放使用乘法倍率，避免不同基础倍率下出现“滚轮一下反而缩小一点”的视觉抖动。
                // 向上放大约 8%，向下缩小约 7.4%。
                actions.zoomBy(e.deltaY < 0 ? 1.08 : (1 / 1.08));
            },
            pan(e) {
                if (!instance) return;
                const c = instance.container, im = instance.imgEl;
                const move = e.deltaY > 0 ? -config.scrollSpeed : config.scrollSpeed;
                // 情况1：img 超出容器 → 容器内平移 img
                const imgOverflow = im.offsetHeight - c.clientHeight;
                if (imgOverflow > 0) {
                    const minTop = Math.min(0, -imgOverflow);
                    const cur = parseFloat(im.style.top) || 0;
                    im.style.top = Math.max(minTop, Math.min(0, cur + move)) + 'px';
                    return;
                }
                // 情况2：容器超出视口 → 整体平移容器，查看溢出部分
                const overY = c.offsetHeight - window.innerHeight;
                if (overY > 0) {
                    const limit = overY / 2; // 居中定位下，上下各溢出 overY/2
                    let cur = (instance.panY || 0) + move;
                    cur = Math.max(-limit, Math.min(limit, cur));
                    instance.panY = cur;
                    c.style.transform = `translate(-50%, calc(-50% + ${cur}px))`;
                }
            }
        };

        const FSM = {
            get state() { return state; },
            hasActiveZoom() { return state === S.SHOWING || state === S.ACTIVE; },
            getSourceRect() { return instance && instance.sourceImg && instance.sourceImg.isConnected ? instance.sourceImg.getBoundingClientRect() : null; },

            heartbeat() {
                if (!isEnabled || isHomepageZoomDisabled()) { FSM.dispatch('RESET'); return; }

                // ★ 窗口切换后的恢复保护：必须等用户真实移动鼠标后才恢复 hover 裁决。
                // 防止 Alt+Tab / 原生窗口切换时浏览器仅收到 focus/mouseover 等事件，
                // 使用旧的 lastMouse 坐标再次触发放大，造成“先收起、再自动放大”。
                if (resumeBlockedUntilMouseMove) return;

                // ★ 窗口失焦且关闭了“失焦时收起”：保留当前预览，等待切回。
                // 文件管理器等原生窗口覆盖浏览器时，浏览器可能收到 mouseout + blur；
                // 此时不能把“窗口失焦”误判成“鼠标离开原图”。
                if (!pointerInWindow) {
                    if (!browserWindowFocused && !config.blurDismiss) return;
                    if (state === S.PENDING) actions.cancel();
                    else if ((state === S.SHOWING || state === S.ACTIVE) && instance) actions.beginFade();
                    return;
                }

                const x = lastMouse.x, y = lastMouse.y;
                if (x < 0) return;

                if (state === S.PENDING && pendingImg) {
                    if (galleryHoldAt || canTriggerNow(pendingImg, x, y)) {
                        pendingFails = 0;
                        return;
                    }
                    pendingFails++;
                    if (pendingFails >= 2) actions.cancel();
                    return;
                }

                if (state === S.SHOWING || state === S.ACTIVE) {
                    if (!instance) { state = S.IDLE; return; }
                    // 只要在原图区域内就保持；离开原图（即使在放大图上方）→ 淡出
                    const sRect = instance.sourceImg.isConnected ? instance.sourceImg.getBoundingClientRect() : null;
                    if (!galleryHoldAt && !inRect(x, y, sRect)) actions.beginFade();
                    return;
                }
            },

            orphanCheck() {
                if (instance && instance.sourceImg && !instance.sourceImg.isConnected) actions.beginFade();
            },

            dispatch(event, payload) {
                switch (event) {
                    case 'HOVER': {
                        const img = payload.img, x = payload.x, y = payload.y;
                        if (!isEnabled || isHomepageZoomDisabled()) break;
                        if (config.avoidClickConflict && isImageInLightboxMode()) break;
                        if (!img || !img.isConnected) break;
                        const anchor = canTriggerNow(img, x, y);
                        if (!anchor) {
                            if (state === S.PENDING && pendingImg === img) actions.cancel();
                            break;
                        }
                        if (state === S.SHOWING || state === S.ACTIVE) {
                            if (!instance) break;
                            if (img === instance.sourceImg) break; // 还是当前这张 → 保持不动
                            const zr = instance.container.getBoundingClientRect();
                            if (inRect(x, y, zr)) {
                                if (Date.now() - lastMouse.t < 300) {
                                    actions.beginFade();
                                    actions.startPending(img);
                                }
                                break;
                            }
                            actions.beginFade();
                            actions.startPending(img);
                            break;
                        }
                        if (state === S.PENDING) {
                            if (pendingImg !== img) actions.startPending(img);
                        } else {
                            actions.startPending(img); // IDLE / FADING
                        }
                        break;
                    }
                    case 'HOVER_NONE': {
                        const x = payload.x, y = payload.y;
                        // force=true 时跳过"lastMouse 在原图矩形内"的保活检查：
                        // 鼠标离开浏览器/窗口失焦时 lastMouse 是陈旧坐标，光标实际已不在图上
                        if (!(payload && payload.force) && (state === S.SHOWING || state === S.ACTIVE) && instance) {
                            const sr = instance.sourceImg.isConnected ? instance.sourceImg.getBoundingClientRect() : null;
                            if (inRect(x, y, sr)) break;
                        }
                        if (state === S.PENDING) actions.cancel();
                        else if (state === S.SHOWING || state === S.ACTIVE) actions.beginFade();
                        break;
                    }
                    case 'TIMER_FIRE': {
                        if (state === S.PENDING && pendingImg === payload) {
                            // ★ 图集翻页保持：翻页时目标图不在光标下，canTriggerNow 必为 false。
                            //   必须与心跳分支（3673 处 galleryHoldAt 放行）保持一致，此处也认可 galleryHoldAt，
                            //   否则定时器一到就落入 cancel()，导致「按 ←/→ 预览直接消失」。
                            if (galleryHoldAt || canTriggerNow(payload, lastMouse.x, lastMouse.y)) {
                                actions.show(payload);
                                break;
                            }
                            const img = payload;
                            const r = img.isConnected ? img.getBoundingClientRect() : null;
                            const stillOk = r && isImgVisibleNow(img) && !isImgClippedAway(img) &&
                                lastMouse.x >= r.left - 120 && lastMouse.x <= r.right + 120 &&
                                lastMouse.y >= r.top - 120 && lastMouse.y <= r.bottom + 120;
                            if (stillOk && !pendingGraceUsed) {
                                pendingGraceUsed = true;
                                pendingFails = 0;
                                if (pendingTimer) clearTimeout(pendingTimer);
                                pendingTimer = setTimeout(() => FSM.dispatch('TIMER_FIRE', img), Math.max(300, config.delay));
                            } else {
                                actions.cancel();
                            }
                        }
                        break;
                    }
                    case 'LOADED':
                        actions.activate(payload);
                        break;
                    case 'ERROR':
                        actions.onError(payload);
                        break;
                    case 'WHEEL': {
                        if (state === S.ACTIVE && instance && isEnabled) {
                            payload.preventDefault && payload.preventDefault();
                            payload.stopPropagation && payload.stopPropagation();
                            lastWheelEvent = payload;
                            if (!wheelTicking) {
                                wheelTicking = true;
                                requestAnimationFrame(() => {
                                    wheelTicking = false;
                                    if (!lastWheelEvent || state !== S.ACTIVE || !instance) return;
                                    if (config.wheelZoom) actions.zoomByWheel(lastWheelEvent);
                                    else actions.pan(lastWheelEvent);
                                });
                            }
                            return true;
                        }
                        return false;
                    }
                    // ★ 键盘动作入口（键位系统调用）。缩放与滚轮共用 applyZoom，行为完全一致。
                    case 'ZOOM_IN':
                    case 'ZOOM_OUT':
                    case 'ZOOM_RESET': {
                        if (state === S.ACTIVE && instance && isEnabled) {
                            if (event === 'ZOOM_IN') actions.zoomBy(1.08);
                            else if (event === 'ZOOM_OUT') actions.zoomBy(1 / 1.08);
                            else actions.resetZoom();
                            return true;
                        }
                        return false;
                    }
                    // 保存当前预览的图片（S 键）
                    case 'SAVE_IMAGE': {
                        if (state === S.ACTIVE && instance && isEnabled) { actions.saveImage(); return true; }
                        return false;
                    }
                    // 复制地址 / 复制图片 / 旋转 / 翻转
                    case 'COPY_LINK': {
                        if (state === S.ACTIVE && instance && isEnabled) { actions.copyLink(); return true; }
                        return false;
                    }
                    case 'COPY_IMAGE': {
                        if (state === S.ACTIVE && instance && isEnabled) { actions.copyImage(); return true; }
                        return false;
                    }
                    case 'ROTATE': {
                        if (state === S.ACTIVE && instance && isEnabled) { actions.rotateBy(); return true; }
                        return false;
                    }
                    case 'FLIP': {
                        if (state === S.ACTIVE && instance && isEnabled) { actions.flipHorizontal(); return true; }
                        return false;
                    }
                    // 图集翻页 / 全屏
                    case 'GALLERY_PREV': {
                        if ((state === S.ACTIVE || state === S.SHOWING) && instance && isEnabled) { actions.switchGallery(-1); return true; }
                        return false;
                    }
                    case 'GALLERY_NEXT': {
                        if ((state === S.ACTIVE || state === S.SHOWING) && instance && isEnabled) { actions.switchGallery(1); return true; }
                        return false;
                    }
                    case 'GALLERY_ZIP': {
                        if ((state === S.ACTIVE || state === S.SHOWING) && instance && isEnabled) { actions.downloadGalleryZip(); return true; }
                        return false;
                    }
                    case 'TOGGLE_FULLSCREEN': {
                        if ((state === S.ACTIVE || state === S.SHOWING) && instance && isEnabled) { actions.toggleFullscreen(); return true; }
                        return false;
                    }
                    case 'FULLSCREEN_LAYOUT': {
                        if (instance) { actions.applyFullscreenLayout(!!(payload && payload.on)); return true; }
                        return false;
                    }
                    // 主动关闭预览（Esc / 自定义键）
                    // 全屏状态下不拦截 Esc —— 交给浏览器先退出全屏，再按一次才关闭预览
                    case 'CLOSE': {
                        // 全屏下 Esc 只退出全屏、不关预览。
                        // 某些环境（无窗口装饰/自动化）不会自动响应 Esc 退全屏，需显式退出。
                        if (document.fullscreenElement || document.webkitFullscreenElement) {
                            try {
                                const exit = document.exitFullscreen || document.webkitExitFullscreen;
                                if (exit) exit.call(document);
                            } catch (e) { }
                            return true;
                        }
                        if (state === S.PENDING) { actions.cancel(); return true; }
                        if (state === S.SHOWING || state === S.ACTIVE) { actions.beginFade(); return true; }
                        return false;
                    }
                    case 'DISMISS': {
                        if (state === S.PENDING) actions.cancel();
                        else if (state === S.SHOWING || state === S.ACTIVE) actions.beginFade();
                        break;
                    }
                    case 'RESET': {
                        generation++;
                        if (currentAbort) { currentAbort.abort(); currentAbort = null; }
                        clearPending();
                        if (instance) {
                            const c = instance.container;
                            const zImg = c.querySelector('img');
                            if (zImg && zImg.__zoomBlobUrl) {
                                URL.revokeObjectURL(zImg.__zoomBlobUrl);
                                zImg.__zoomBlobUrl = null;
                            }
                            if (c.parentNode) c.parentNode.removeChild(c);
                            instance = null;
                        }
                        document.querySelectorAll('.image-zoom-container[data-iz-owner="fsm"]').forEach(c => {
                            const zImg = c.querySelector('img');
                            if (zImg && zImg.__zoomBlobUrl) {
                                URL.revokeObjectURL(zImg.__zoomBlobUrl);
                                zImg.__zoomBlobUrl = null;
                            }
                            c.remove();
                        });
                        state = S.IDLE;
                        wheelManager.sync();
                        break;
                    }
                }
                return false;
            }
        };

        return FSM;
    })();


    const wheelManager = (function() {
        let attached = false;
        function handler(e) {
            if (zoomFSM.dispatch('WHEEL', e)) return;
            bilibiliVolumeModule.onWheel(e);
        }
        function sync() {
            const need = zoomFSM.hasActiveZoom() || bilibiliVolumeModule.isFullscreenActive();
            if (need && !attached) {
                // ★ 必须挂 window（不能挂 document）：部分站点（如 Unsplash）在 window 级的
                // capture 阶段就调用了 stopPropagation()，事件根本传不到 document —— 挂在 document
                // 上会永远收不到滚轮，表现为「悬停能出预览，但滚轮不缩放、页面跟着滚」。
                // 同一 target 上的多个监听器不受 stopPropagation 影响（那是 stopImmediatePropagation），
                // 因此挂 window 可确保我们收到事件并能 preventDefault。
                window.addEventListener('wheel', handler, { capture: true, passive: false });
                attached = true;
            } else if (!need && attached) {
                window.removeEventListener('wheel', handler, { capture: true });
                attached = false;
            }
        }
        document.addEventListener('fullscreenchange', sync);
        document.addEventListener('webkitfullscreenchange', sync);
        return { sync };
    })();

    // ============================================================
    // 键位系统（骨架）
    //   默认键表见 KEYMAP_DEFAULTS，可在配置里覆盖（后续在面板中可视化编辑）。
    //   新增一个动作 = 在 ACTIONS 里注册实现 + 在 KEYMAP_DEFAULTS 里给默认键。
    //
    //   接管原则（避免与站点/浏览器抢键）：
    //     1. 只在预览处于显示状态时接管；
    //     2. 输入框/可编辑区域内不接管；
    //     3. 带 Ctrl/Cmd/Alt 的组合键不接管（把浏览器快捷键让给浏览器）；
    //     4. 只有动作**确实消费了这个键**才 preventDefault —— 否则站点快捷键照常工作。
    // ============================================================
    const keymapModule = (function () {
        // 动作注册表：返回 true 表示已消费该按键
        const ACTIONS = {
            close:     function () {
                // ★ 视频预览优先关闭：开着视频预览时 Esc 先收视频，再收图片预览
                if (videoPreviewModule.hide()) return true;
                return zoomFSM.dispatch('CLOSE');
            },
            zoomIn:    function () { return zoomFSM.dispatch('ZOOM_IN'); },
            zoomOut:   function () { return zoomFSM.dispatch('ZOOM_OUT'); },
            resetZoom: function () { return zoomFSM.dispatch('ZOOM_RESET'); },
            saveImage: function () { return zoomFSM.dispatch('SAVE_IMAGE'); },
            copyLink:  function () { return zoomFSM.dispatch('COPY_LINK'); },
            copyImage: function () { return zoomFSM.dispatch('COPY_IMAGE'); },
            rotate:    function () { return zoomFSM.dispatch('ROTATE'); },
            flip:      function () { return zoomFSM.dispatch('FLIP'); },
            prevImage: function () { return zoomFSM.dispatch('GALLERY_PREV'); },
            nextImage: function () { return zoomFSM.dispatch('GALLERY_NEXT'); },
            galleryZip: function () { return zoomFSM.dispatch('GALLERY_ZIP'); },
            fullscreen: function () { return zoomFSM.dispatch('TOGGLE_FULLSCREEN'); }
        };

        // 归一化：**字母保留大小写** —— 这样 Shift 组合（C 复制图片、R 翻转）
        // 才能与小写（c 复制地址、r 旋转）区分开；其余键名（+ - _ Escape ArrowLeft…）原样。
        function normalizeKey(k) {
            return (typeof k === 'string') ? k : '';
        }

        function isTypingTarget(el) {
            if (!el) return false;
            const tag = (el.tagName || '').toLowerCase();
            return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
        }

        // 按键 → 动作名
        function resolveAction(key) {
            if (!key) return null;
            const table = (config && config.keymap) || KEYMAP_DEFAULTS;
            const actions = Object.keys(ACTIONS);
            for (let i = 0; i < actions.length; i++) {
                const name = actions[i];
                const list = (Array.isArray(table[name]) && table[name].length) ? table[name] : (KEYMAP_DEFAULTS[name] || []);
                for (let j = 0; j < list.length; j++) {
                    if (normalizeKey(list[j]) === key) return name;
                }
            }
            return null;
        }

        function handler(e) {
            if (!isEnabled) return;
            if (e.defaultPrevented) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
            const imageActive = zoomFSM.hasActiveZoom();
            const videoActive = videoPreviewModule.isActive();
            if (!imageActive && !videoActive) return;      // 预览（图片/视频）没显示就不掺和
            const action = resolveAction(normalizeKey(e.key));
            if (!imageActive && videoActive) {
                // ★ 视频预览独占键盘：Esc 关闭；←/→ 控制播放进度（±5s）。
                //   方向键按原生语义直取（不参与图片图集的 prev/next 键位映射），
                //   iframe（YouTube/B站 embed）无法控制进度时放行、不拦按键。
                if (e.key === 'ArrowLeft') {
                    if (videoPreviewModule.seek(-5)) { e.preventDefault(); e.stopPropagation(); }
                    return;
                }
                if (e.key === 'ArrowRight') {
                    if (videoPreviewModule.seek(5)) { e.preventDefault(); e.stopPropagation(); }
                    return;
                }
                if (action === 'close') {
                    const closeFn = ACTIONS[action];
                    if (closeFn && closeFn() === true) { e.preventDefault(); e.stopPropagation(); }
                }
                return;
            }
            if (!action) return;
            const fn = ACTIONS[action];
            if (fn && fn() === true) {
                e.preventDefault();
                e.stopPropagation();
            }
        }

        let attached = false;
        function init() {
            if (attached) return;
            window.addEventListener('keydown', handler, { capture: true });
            attached = true;
        }

        return { init: init, resolveAction: resolveAction };
    })();

    // ============================================================
    // 视频悬停预览（浮图秀没有的能力）
    //   ① 悬停页面里的 <video>（小尺寸内嵌视频）→ 浮出放大播放器（克隆同一地址、静音播放，不动原视频）
    //   ② 悬停视频卡片（YouTube / B站 链接）→ 优先「借用」卡片内站点自备的真实 <video>,
    //      没有才退回站点官方 player 的 iframe 嵌入
    //   守卫：悬停意图延迟（450ms）→ 卡片矩形离开判定（220ms 宽限）→ Esc / 失焦 / 滚动立即关闭；
    //   交互（2026-09-19 新增）：预览期间拦截滚轮（防页面滚动把光标带离 → 误关）；←/→ 控播放进度
    //         （对 <video> 生效，跨域 iframe 无法控制则放行）。
    //   交互（test.86）：**滚轮音量已撤除** —— 站点播放器（B站）的 <video> 常是纯视频轨 MediaSource，
    //         解除静音也听不到声音；滚轮只保留「锁定页面滚动」。关闭视频预览时会**单次**把图片预览的
    //         出现位置从「屏幕居中」临时改为「原图周围」（见 placeOnce，避免挡住宅自带的视频预览）。
    //         ★ B站/YouTube 卡片若走 iframe 路径，其播放器在**跨域 iframe 内**,父页面无法 seek /
    //           调音量（站外播放器只有 URL 参数、无公开控制 API）。B站 卡片内其实有站点自备的
    //           MediaSource <video>（隐藏、未播放），但其 `blob:` 地址**无法克隆**（同一 MediaSource
    //           不能挂两个元素）→ 唯一可行路径是「借用真节点」：临时把该 <video> 移进预览容器，
    //           关预览时原位归还（含原 inline style）。借用期间用 500ms 看门狗兜底站点自己的暂停；
    //           一旦节点被站点抢回（parentElement 变化）即收工关闭预览。
    //         同一时刻只存在一个播放器；关闭时立即销毁（iframe/video 不再占资源）。
    // ============================================================
    const VIDEO_SITES = [
        { name: 'YouTube', test: /^https?:\/\/(?:www\.)?youtube\.com\/watch\?[^#]*v=([\w-]{6,})/i, embed: (m) => 'https://www.youtube.com/embed/' + m[1] + '?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1' },
        { name: 'YouTube', test: /^https?:\/\/youtu\.be\/([\w-]{6,})/i, embed: (m) => 'https://www.youtube.com/embed/' + m[1] + '?autoplay=1&mute=1&playsinline=1&rel=0' },
        { name: 'B站', test: /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[\w]{8,})/i, embed: (m) => 'https://player.bilibili.com/player.html?bvid=' + m[1] + '&autoplay=1&muted=1&danmaku=0&high_quality=1' }
    ];

    const videoPreviewModule = (function () {
        const HOVER_DELAY = 450;      // 悬停意图：停稳这么久才弹
        const LEAVE_GRACE = 220;      // 离开卡片后的宽限（避免边缘抖动反复开关）
        const SMALL_VIDEO_MAX_W = 640; // 只预览「小尺寸内嵌视频」，站点主播放器（大）不碰

        let hoverTimer = null, leaveTimer = null, cur = null;

        function cardKey(card) {
            return card.kind === 'video' ? ('v:' + card.src) : ('f:' + card.url);
        }

        function videoSrc(v) {
            return v.currentSrc || v.src || (v.querySelector('source') || {}).src || '';
        }

        // 卡片范围内找站点自备的真实 <video>（B站 悬停预览这类）。
        // 站点播放器多为 MediaSource（`blob:` 地址）——**克隆无效**（同一 MediaSource 不能挂两个元素），
        // 只有借用真节点才能拿到 seek / 音量能力。找不到则由调用方退回跨域 iframe 嵌入。
        //   ⚠️ 搜索范围必须严格「不越卡片」：曾用「向上 3 层 querySelectorAll」实现，
        //      结果把**隔壁卡片**的 video 当成自己的（列表里多张卡片时必现）。现在的规则：
        //      ① 只在 anchor 子树内找（B站 实测 video 就在 a.bili-video-card__image--link 内）；
        //      ② 才允许放宽到「anchor 的父节点里、同样包含 anchor 的那个包裹层」——不会跨到兄弟卡片。
        function pickUsableVideo(root) {
            const vs = root.querySelectorAll ? root.querySelectorAll('video') : [];
            for (let j = 0; j < vs.length; j++) {
                const v = vs[j];
                if (v.closest && v.closest('.hv-video-preview')) continue;          // 我们自己的容器
                if (v.getBoundingClientRect().width > SMALL_VIDEO_MAX_W) continue;  // 站点主播放器不碰
                if (!v.paused && !v.muted && v.volume > 0) continue;                // 用户正在有声观看：不打扰
                if (!videoSrc(v)) continue;
                const d = Number(v.duration);
                if (!(d > 0) && !(v.seekable && v.seekable.length)) continue;       // 还没就绪
                return v;
            }
            return null;
        }

        function findCardVideo(anchor) {
            let v = pickUsableVideo(anchor);
            if (v) return v;
            const wrap = anchor.parentElement;
            if (!wrap) return null;
            const kids = wrap.children;
            for (let i = 0; i < kids.length; i++) {
                if (kids[i] === anchor || !kids[i].contains(anchor)) continue;      // 只认「和 anchor 同一个卡片块」
                v = pickUsableVideo(kids[i]);
                if (v) return v;
            }
            return null;
        }

        // 找出光标下的可预览视频目标
        function pickCard(el) {
            if (!el) return null;
            // ★ 借用中短路：卡片的 <video> 已被我们借走，重跑查找只会退化成 iframe（键变了 → 预览被换掉）
            if (cur && cur.borrowedFrom && cur.originCard && cur.originCard.isConnected &&
                (cur.originCard === el || cur.originCard.contains(el))) return cur;
            const v = el.tagName === 'VIDEO' ? el : (el.closest ? el.closest('video') : null);
            if (v) {
                const r = v.getBoundingClientRect();
                if (r.width < 120 || r.height < 80) return null;
                if (r.width > SMALL_VIDEO_MAX_W) return null;                       // 站点主播放器：不接管
                if (!v.paused && !v.muted && v.volume > 0) return null;              // 用户正在有声观看：不打扰
                const src = videoSrc(v);
                if (!src) return null;
                const isBlob = /^blob:/i.test(src);                                  // MediaSource：克隆无效 → 借真节点
                // ★ 借用路径必须记住「原悬停位置」：节点被借走后该处不再有 <video>，
                //   再走一遍 pickCard 会返回 null → 预览被自己关掉（2026-09-19 test.85 实测）。
                return { kind: 'video', src: src, clone: !isBlob, el: isBlob ? v : undefined,
                         originCard: isBlob ? v.parentElement : undefined,
                         title: (v.getAttribute('title') || '').trim().slice(0, 80), rect: r };
            }
            const a = el.closest ? el.closest('a[href]') : null;
            if (!a) return null;
            const r = a.getBoundingClientRect();
            if (r.width < 140 || r.height < 90) return null;
            const href = a.href || '';
            for (let i = 0; i < VIDEO_SITES.length; i++) {
                const s = VIDEO_SITES[i];
                const m = href.match(s.test);
                if (!m) continue;
                const title = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
                const cardTitle = (title || (s.name + ' 视频')).slice(0, 80);
                const bv = findCardVideo(a);
                if (bv) {                                   // ★ 有真节点 → 借用（可 seek / 调音量）
                    return { kind: 'video', src: videoSrc(bv), clone: false, el: bv, originCard: a,
                             url: s.embed(m), site: s.name, title: cardTitle, rect: r };
                }
                return { kind: 'iframe', url: s.embed(m), site: s.name, title: cardTitle, rect: r };
            }
            return null;
        }

        // 借用节点：把站点自备的 <video> 临时移进预览容器（记住原位 + 原 inline style，关闭时归还）
        function borrowNode(container, v) {
            const from = { parent: v.parentElement, next: v.nextSibling, css: v.getAttribute('style') };
            try {
                v.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000';
                container.appendChild(v);
                try { v.muted = true; } catch (e) { }
                const p = v.play();
                if (p && p.catch) p.catch(function () { });
            } catch (e) { return null; }
            return from;
        }

        function restoreNode(v, from) {
            if (!v || !from) return;
            try {
                if (from.parent && from.parent.isConnected) {
                    const nx = from.next;
                    from.parent.insertBefore(v, (nx && nx.parentElement === from.parent) ? nx : null);
                }
                if (from.css) v.setAttribute('style', from.css); else v.removeAttribute('style');
            } catch (e) { }
        }

        // 看门狗：站点播放器的内部状态机可能自己把借走的视频暂停（实测健康情况下 0 次介入，
        //   属兜底）。一旦节点被站点抢回（parentElement 变了）→ 认输关闭预览，不硬抢。
        let watchdog = null;
        function stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }
        function startWatchdog() {
            stopWatchdog();
            watchdog = setInterval(function () {
                if (!cur || !cur.container || !cur.borrowedFrom) { stopWatchdog(); return; }
                const v = cur.container.querySelector('video');
                if (!v) { stopWatchdog(); return; }
                if (v.parentElement !== cur.container) { hide(); return; }
                if (v.paused && !v.ended) { try { const p = v.play(); if (p && p.catch) p.catch(function () { }); } catch (e) { } }
            }, 500);
        }

        function destroy() {
            stopWatchdog();
            if (cur && cur.container) {
                const c = cur.container;
                if (cur.borrowedFrom) {
                    restoreNode(c.querySelector('video'), cur.borrowedFrom);     // ★ 原件归还站点卡片
                } else {
                    const im = c.querySelector('iframe, video');
                    if (im) { try { im.src = 'about:blank'; } catch (e) { } try { im.removeAttribute('src'); } catch (e) { } }
                }
                c.style.opacity = '0';
                setTimeout(function () { try { c.remove(); } catch (e) { } }, 260);
            }
            cur = null;
        }

        function hide() {
            clearTimeout(hoverTimer); hoverTimer = null;
            clearTimeout(leaveTimer); leaveTimer = null;
            if (!cur) return false;
            destroy();
            // ★ 单次避让（test.86）：刚关掉视频预览 → 若用户设的是「屏幕居中」，把**下一次**图片预览
            //   临时改成「原图周围」。原因：关掉视频预览后继续悬停同一处会走图片放大，居中的大图会
            //   挡住站点自带的视频预览（B站 卡片会自己弹预览）。
            //   注意：只在这里（用户可见的「关闭」路径）装载，`show()` 内部的 destroy() 不装载。
            if (config.previewPlacement === 'center') { placeOnce = 'around'; placeOnceAt = Date.now(); }
            return true;
        }

        // ★ 播放进度控制（←/→ 快退/快进）。仅对 <video> 有效；
        //   iframe（YouTube/B站 embed）跨域无法控制进度 → 返回 false 让调用方不拦按键。
        function seek(delta) {
            if (!cur || !cur.container) return false;
            const v = cur.container.querySelector('video');
            if (!v) return false;
            try {
                const d = Number(v.duration);
                const t = Number(v.currentTime) || 0;
                v.currentTime = (isFinite(d) && d > 0)
                    ? Math.min(d - 0.05, Math.max(0, t + delta))
                    : Math.max(0, t + delta);
            } catch (e) { return false; }
            return true;
        }


        function show(card) {
            if (cur && cardKey(cur) === cardKey(card)) return;
            destroy();
            const availW = Math.min(window.innerWidth - 80, config.maxWidth);
            const availH = Math.min(window.innerHeight - 120, config.maxHeight);
            let w = Math.min(availW, 900, Math.max(360, Math.round(card.rect.width * 2.2)));
            let h = Math.round(w * 9 / 16);
            if (h > availH) { h = availH; w = Math.round(h * 16 / 9); }

            const c = document.createElement('div');
            c.className = 'image-zoom-container hv-video-preview';
            c.dataset.izOwner = 'video';
            c.style.cssText = 'position:fixed;z-index:' + (config.zoomZIndex - 2) + ';left:50%;top:50%;' +
                'transform:translate(-50%,-50%);opacity:0;transition:opacity .25s ease;pointer-events:none;' +
                'background:#000;border-radius:12px;overflow:hidden;' +
                'box-shadow:0 10px 34px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.12);' +
                'width:' + w + 'px;height:' + h + 'px;';

            // 内容装配：优先「可控」路径 —— 借用站点卡片播放器 > 克隆同源视频 > 跨域 iframe 嵌入
            let borrowedFrom = null, content = null;
            if (card.el && card.el.parentElement) {
                borrowedFrom = borrowNode(c, card.el);
                if (borrowedFrom) content = 'borrow';
            }
            if (!content && card.kind === 'video' && card.src && card.clone !== false) {
                const v = document.createElement('video');
                v.src = card.src;
                v.muted = true; v.autoplay = true; v.loop = true; v.playsInline = true;
                v.setAttribute('playsinline', '');
                v.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;';
                try { v.play().catch(function () { }); } catch (e) { }
                c.appendChild(v);
                content = 'clone';
            }
            if (!content && card.url) {
                const f = document.createElement('iframe');
                f.src = card.url;
                f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
                f.setAttribute('allowfullscreen', 'true');
                f.setAttribute('frameborder', '0');
                f.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000;';
                c.appendChild(f);
                content = 'iframe';
            }
            if (!content) { try { c.remove(); } catch (e) { } return; }   // 三条路都装配不上：放弃，不留空框

            const bar = document.createElement('div');
            bar.className = 'hv-vp-bar';
            bar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;padding:6px 10px;font:12px/1.5 Arial,sans-serif;' +
                'color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.72));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            bar.textContent = '🔇 静音预览 · ' + (card.site ? card.site + ' · ' : '')
                + (card.title || '视频')
                + (card.kind === 'video' ? ' · ←/→ 快退/快进' : '')
                + ' · Esc 关闭';
            c.appendChild(bar);

            document.body.appendChild(c);
            cur = card;
            cur.container = c;
            cur.borrowedFrom = borrowedFrom;
            cur.content = content;
            if (borrowedFrom) startWatchdog();
            requestAnimationFrame(function () { c.style.opacity = '1'; });
        }

        // 返回 true 表示「这次悬停由视频预览接管」→ 图片悬停逻辑让位
        function handleHover(x, y, t) {
            if (!config.videoHoverPreview) {
                if (cur) hide();
                // ★ 单次避让（test.86 补）：**功能开关本身被关掉**时，悬停视频卡片不会产生视频预览，
                //   而会落到「图片放大」上；用户设为居中时，居中的大图同样会挡住站点自带的视频预览。
                //   这里用同一套 placeOnce 机制装载避让（读一次即消耗，不写回用户设置）。
                if (config.previewPlacement === 'center' && pickCard(t)) {
                    placeOnce = 'around';
                    placeOnceAt = Date.now();
                }
                return false;
            }
            const card = pickCard(t);
            if (!card) {
                if (cur) {                       // 已显示：给一点宽限再关
                    clearTimeout(leaveTimer);
                    leaveTimer = setTimeout(function () { hide(); }, LEAVE_GRACE);
                } else { clearTimeout(hoverTimer); hoverTimer = null; }
                return false;
            }
            clearTimeout(leaveTimer); leaveTimer = null;
            const key = cardKey(card);
            if (cur && cur.container && cur.container.isConnected && cur.key === key) return true;   // 已经在播这张
            if (cur && cur.key === key) return true;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(function () {
                if (!config.videoHoverPreview) return;
                if (resumeBlockedUntilMouseMove || !pointerInWindow) return;
                card.key = key;
                show(card);
            }, HOVER_DELAY);
            return true;                          // 立刻接管，避免同一张缩略图被图片预览顶出来
        }

        function init() {
            // ★ 视频预览激活时拦截滚轮：容器是 pointer-events:none，滚轮会**穿透**作用于页面 →
            //   页面滚动 → 触发下面的 scroll 监听 → 误关预览（2026-09-19 反馈 bug）。
            //   必须 capture + passive:false 才能阻止默认滚动，使预览期间页面不动。
            //   注：test.85 曾把滚轮改成调音量，但站点播放器（B站）的 <video> 常是**纯视频轨**
            //   的 MediaSource，解除静音也听不到声音 → 该功能已撤除（test.86），滚轮只保留「锁定页面」。
            window.addEventListener('wheel', function (e) {
                if (!cur) return;
                try { e.preventDefault(); e.stopPropagation(); } catch (err) { }
            }, { capture: true, passive: false });
            window.addEventListener('scroll', function () { if (cur) hide(); }, { capture: true, passive: true });
            window.addEventListener('blur', function () { if (cur && config.blurDismiss) hide(); });
            window.addEventListener('resize', function () { if (cur) hide(); });
        }

        return { handleHover, hide, seek, isActive: function () { return !!cur; }, init };
    })();

    function setupGlobalHoverStream() {
        // 流1：mouseover（前沿节流 + 事件自带坐标）—— 快速、跟随移动
        document.addEventListener('mouseover', throttleLeading((e) => {
            if (lastMouse.x < 0) {
                lastMouse.x = e.clientX;
                lastMouse.y = e.clientY;
            }
            if (resumeBlockedUntilMouseMove) return;
            resolveCursorTarget(e.clientX, e.clientY, e.target);
        }, 60), true);

        // 流2：★ 停稳裁决器 —— 鼠标停止移动 ~120ms 后主动裁决一次。
        // 兜底 mouseover 被节流丢弃 / 未派发 / target 不含 img 的所有情况。
        const stopResolve = debounce(() => {
            if (document.hidden) return;
            if (resumeBlockedUntilMouseMove) return;
            if (!pointerInWindow) return;   // ★ 光标已被其他窗口覆盖，不裁决
            const x = lastMouse.x, y = lastMouse.y;
            if (x < 0) return;
            resolveCursorTarget(x, y, document.elementFromPoint(x, y));
        }, 120);
        document.addEventListener('mousemove', () => { stopResolve(); }, { passive: true });

        // ★ 鼠标真正离开浏览器窗口。
        // 原生窗口（文件管理器等）覆盖浏览器时，mouseout 可能和 blur 一起出现。
        // 关闭“窗口失焦时收起”后，先短暂等待 blur 事件完成；如果确认浏览器已失焦，
        // 则把这次 mouseout 视为“窗口切换”，保留当前预览。
        document.addEventListener('mouseout', (e) => {
            if (!e.relatedTarget) {
                pointerInWindow = false;
                resumeBlockedUntilMouseMove = true;

                // ★ 关闭“窗口失焦时收起”后，mouseout 绝不能单独收起当前预览。
                // 浏览器/原生窗口切换时，mouseout 与 blur 的先后顺序并不固定；
                // 如果这里立即或异步执行 HOVER_NONE，就会把“切换应用”误判成“离开原图”。
                // 此模式下只记录窗口外状态，等真正的物理 mousemove 回来后再恢复裁决。
                if (!config.blurDismiss) return;

                zoomFSM.dispatch('HOVER_NONE', { x: lastMouse.x, y: lastMouse.y, force: true });
            }
        }, true);

        // ★ 浏览器窗口失去焦点。
        // 开启：失焦时收起预览。
        // 关闭：仅记录失焦，不主动收起；这样 Alt+Tab、点击其他应用、文件管理器覆盖等
        // 场景都可以保留当前预览，切回浏览器后继续查看。
        window.addEventListener('blur', () => {
            browserWindowFocused = false;
            resumeBlockedUntilMouseMove = true;
            if (config.blurDismiss) {
                zoomFSM.dispatch('HOVER_NONE', { x: lastMouse.x, y: lastMouse.y, force: true });
            }
        });

        window.addEventListener('focus', () => {
            browserWindowFocused = true;
            // 不在 focus 时恢复 pointerInWindow；必须等真实 mousemove。
            // 否则 lastMouse 仍是切换应用前的旧坐标，会立即再次命中原图。
            pointerInWindow = false;
            resumeBlockedUntilMouseMove = true;

            // 失焦期间没有主动收起时，切回浏览器后重新核对光标位置。
            // 如果光标仍在原图区域，继续保留；如果已经离开，则立即收起。
            if (!config.blurDismiss && zoomFSM.hasActiveZoom()) {
                const x = lastMouse.x, y = lastMouse.y;
                if (x >= 0) {
                    const rect = zoomFSM.getSourceRect ? zoomFSM.getSourceRect() : null;
                    if (!rect || !inRect(x, y, rect)) {
                        zoomFSM.dispatch('HOVER_NONE', { x, y, force: true });
                    }
                }
            }
        });
    }

    function setupHeartbeat() {
        //后台标签页跳过心跳。
        // heartbeat/orphanCheck 每 150ms/1500ms 都做 getBoundingClientRect（强制 layout），
        // 之前在后台标签页持续空转，耗电并干扰主线程；
        // 后台布局变化（SPA 预渲染、轮播定时器）还可能触发错误的 beginFade 决策。
        setInterval(() => {
            if (!document.hidden) zoomFSM.heartbeat();
        }, HEARTBEAT_MS);
        setInterval(() => {
            if (!document.hidden) zoomFSM.orphanCheck();
        }, 1500);
    }


    // 6. ★ 全局事件流 + 停稳裁决器

    // ================
    // 7/8. ★ 背景图悬停模块
    // ================

    // ================
    // 9. 动态图片观察器
    // ================
// 5.6.25 - 动态图片观察器
// 不改观察/MutationObserver 行为。

    // ================
    // 9. 动态图片观察器
    // ================
    let lazyImageObserver = null;

    function observeImage(img) {
        if (!lazyImageObserver) {
            lazyImageObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        lazyImageObserver.unobserve(entry.target);
                        processImage(entry.target);
                    }
                });
            }, { rootMargin: '300px 0px' });
        }
        lazyImageObserver.observe(img);
    }

    function initImages() {
        if (isHomepageZoomDisabled()) return;
        document.querySelectorAll('img:not(.image-zoom-processed)').forEach(observeImage);
    }

    function startObserver() {
        let processingQueue = false;
        let pendingMutations = null;
        const observer = new MutationObserver(mutations => {
            if (!isEnabled || isHomepageZoomDisabled()) return;
            //处理期间到达的 mutation 不再丢弃。
            if (processingQueue) {
                if (!pendingMutations) pendingMutations = [];
                for (const m of mutations) pendingMutations.push(m); // ★ 避免大数组 spread 的 RangeError
                return;
            }
            processingQueue = true;
            const processBatch = (batch) => {
                const nodes = new Set();
                // ★ 自有 UI 隔离：放大层容器及其内部节点不作为页面图片登记对象
                const isOwnUI = (el) => !!(el.closest && el.closest('.image-zoom-container'));
                batch.forEach(mutation => {
                    if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG' &&
                        !mutation.target.classList.contains('image-zoom-processed') &&
                        !isOwnUI(mutation.target)) {
                        nodes.add(mutation.target);
                    } else if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType !== Node.ELEMENT_NODE) return;
                            if (isOwnUI(node)) return;
                            if (node.tagName === 'IMG' && !node.classList.contains('image-zoom-processed')) {
                                nodes.add(node);
                            } else if (node.querySelectorAll) {
                                node.querySelectorAll('img:not(.image-zoom-processed)').forEach(i => {
                                    if (!isOwnUI(i)) nodes.add(i);
                                });
                            }
                        });
                    }
                });
                nodes.forEach(img => observeImage(img));
            };
            const run = (batch) => {
                let flushed = false;
                const flush = () => {
                    if (flushed) return;
                    flushed = true;
                    processBatch(batch);
                    processingQueue = false;
                    if (pendingMutations && pendingMutations.length) {
                        const nextBatch = pendingMutations;
                        pendingMutations = null;
                        processingQueue = true;
                        run(nextBatch);
                    }
                };
                // 可见页仍走 rAF（保持原有帧对齐时序）。后台标签页不执行 rAF，
                // 若只依赖它，processingQueue 会一直停在 true，后续 MutationRecord
                // 只能不断堆进 pendingMutations（无上限，且会长期持有已删除节点的引用）。
                if (document.hidden) {
                    setTimeout(flush, 16);
                } else {
                    requestAnimationFrame(flush);
                    setTimeout(() => { if (document.hidden) flush(); }, 250);
                }
            };
            run(mutations);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'srcset'] });
        return observer;
    }



    // ============================================================================
    // Lightbox observer
    // 处理网页自己的点击放大 / Lightbox：
    // 1. 灯箱打开时收起已有 hover 放大实例；
    // 2. 灯箱内部图片不再触发 hover 放大；
    // 3. 兼容“仅插入灯箱 DOM、不修改 body class”的网站实现。
    // 4. 兼容没有固定 class 的通用全屏图片浮层。
    // ============================================================================

    const LIGHTBOX_CLASSES = ['lightbox-open', 'fancybox-open', 'modal-open', 'zoom-overlay-open'];
    // 某些站点的灯箱结构为 #imgzoom > #imgzoom_zoomlayer > #imgzoom_zoom。
    const LIGHTBOX_SELECTORS = [
        '.fancybox-container', '.fancybox-overlay', '.fancybox-bg', '.fancybox__container',
        '.pswp', '.pswp__bg', '.lg-backdrop', '.lg-outer',
        '.viewer-container', '.viewer-backdrop', '[data-fancybox-container]',
        '#imgzoom', '#imgzoom_zoomlayer', '#imgzoom_zoom'
    ];
    // 预拼一次即可：isElementInsideLightbox / isRelevantMutation 每次调用都会用到，
    // 而 isRelevantMutation 对每条 mutation 最多要用 4 次，现场 join 属于纯浪费。
    const LIGHTBOX_SELECTOR_STR = LIGHTBOX_SELECTORS.join(',');

    function isVisibleLightboxElement(el) {
        if (!el || !el.isConnected) return false;
        try {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            if (parseFloat(cs.opacity) < 0.05) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 120 && r.height >= 120;
        } catch (e) { return false; }
    }

    function hasLightboxKeyword(el) {
        if (!el || !el.getAttribute) return false;
        const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
        const id = el.id || '';
        const text = `${cls} ${id}`.toLowerCase();
        return /lightbox|fancybox|photoswipe|photo[-_ ]?viewer|image[-_ ]?(viewer|preview)|gallery[-_ ]?(modal|viewer)|preview[-_ ]?modal/.test(text);
    }

    function isElementInsideLightbox(target) {
        if (!target || !target.closest) return false;
        try {
            // 明确的 Lightbox / 图片查看器结构优先。
            if (target.closest(LIGHTBOX_SELECTOR_STR)) return true;

            // aria-modal / role=dialog 本身不能证明是图片灯箱。
            // 只有对话框具备明确的图片查看器语义，或内部存在可见的大尺寸媒体，
            // 才把它视为 Lightbox，避免误伤普通网站弹窗。
            const dialog = target.closest('[role="dialog"],[aria-modal="true"]');
            if (dialog) {
                if (hasLightboxKeyword(dialog)) return true;
                // ★ 仅"覆盖式"对话框 + 可见大图才算灯箱。
                // role="dialog"/aria-modal 常被 SPA 当作普通内容包裹层；若只看"里面有没有大图"，
                // 会把包住整页卡片的 dialog 误判为灯箱，从而在找图之前截断流程。
                // 另外遍历全部媒体，避免只看到第一个（可能是隐藏小图标）就下结论。
                let overlayLike = false;
                try {
                    const dcs = getComputedStyle(dialog);
                    overlayLike = dcs.position === 'fixed' || dcs.position === 'absolute';
                } catch (e) { }
                if (overlayLike && dialog.querySelectorAll) {
                    for (const m of dialog.querySelectorAll('img,video,canvas')) {
                        if (isVisibleLightboxElement(m)) return true;
                    }
                }
            }
        } catch (e) { }
        return false;
    }

    // ★ Lightbox 全局状态缓存：鼠标移动是高频路径，不再每次都全页面
    // querySelectorAll + getComputedStyle。缓存只保存“全局是否存在可见灯箱”，
    // target 是否位于灯箱内部仍由 isElementInsideLightbox() 实时判断。
    let lightboxGlobalOpen = null;

    function scanGlobalLightboxState() {
        if (LIGHTBOX_CLASSES.some(c =>
            document.body.classList.contains(c) ||
            document.documentElement.classList.contains(c)
        )) return true;

        for (const selector of LIGHTBOX_SELECTORS) {
            try {
                const nodes = document.querySelectorAll(selector);
                for (const el of nodes) {
                    if (isVisibleLightboxElement(el)) return true;
                }
            } catch (e) { }
        }

        try {
            const nodes = document.querySelectorAll(
                '[class*="lightbox"][class*="open" i],' +
                '[class*="lightbox"][class*="active" i],' +
                '[class*="fancybox"][class*="open" i],' +
                '[class*="viewer"][class*="open" i]'
            );
            for (const el of nodes) {
                if (isVisibleLightboxElement(el)) return true;
            }
        } catch (e) { }

        return false;
    }

    function invalidateLightboxState() {
        lightboxGlobalOpen = null;
    }

    function isImageInLightboxMode(target) {
        if (target && isElementInsideLightbox(target)) return true;
        if (lightboxGlobalOpen === null) lightboxGlobalOpen = scanGlobalLightboxState();
        return lightboxGlobalOpen;
    }

    function setupLightboxObserver() {
        let checkScheduled = false;
        let observer = null;

        const dismissIfOpen = () => {
            checkScheduled = false;
            if (isImageInLightboxMode()) zoomFSM.dispatch('DISMISS');
        };

        const scheduleCheck = () => {
            if (checkScheduled) return;
            checkScheduled = true;
            requestAnimationFrame(dismissIfOpen);
        };

        const isRelevantMutation = (mutation) => {
            if (mutation.type === 'attributes') {
                const target = mutation.target;
                if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
                // Lightbox 状态只可能通过这些属性发生可见变化。
                return target === document.body ||
                       target === document.documentElement ||
                       !!target.closest(LIGHTBOX_SELECTOR_STR) ||
                       !!target.closest('[role="dialog"],[aria-modal="true"]') ||
                       target.matches?.('[data-fancybox],[data-lightbox],.lightbox,.fancybox,.pswp,.viewer-container');
            }

            if (mutation.type === 'childList') {
                // 新增和移除都可能改变灯箱状态；旧版只检查 addedNodes，
                // 导致灯箱被移除后缓存/检测可能继续保留旧状态。
                const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
                for (const node of nodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.matches?.(LIGHTBOX_SELECTOR_STR)) return true;
                    if (node.matches?.('[role="dialog"],[aria-modal="true"],img,[data-fancybox],[data-lightbox],.lightbox,.fancybox,.pswp,.viewer-container')) return true;
                    if (node.querySelector?.(LIGHTBOX_SELECTOR_STR)) return true;
                    if (node.querySelector?.('[role="dialog"],[aria-modal="true"],[data-fancybox],[data-lightbox],.lightbox,.fancybox,.pswp,.viewer-container')) return true;
                }
                return false;
            }

            return false;
        };

        observer = new MutationObserver(mutations => {
            // Observer 仍监听页面结构，但真正的 Lightbox 检测只在
            // 可能影响 Lightbox 状态的 mutation 上触发，并且每帧最多检测一次。
            for (const mutation of mutations) {
                if (isRelevantMutation(mutation)) {
                    invalidateLightboxState();
                    scheduleCheck();
                    break;
                }
            }
        });

        observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'aria-hidden', 'aria-modal']
        });

        // ★ 测试修复：点击图片打开帖子前，先立即结束当前放大状态。
        // 某些站点在 click 之前就会执行导航/新标签页逻辑，单靠 click 可能来不及。
        // 这里只处理当前放大源图片或其链接，不改变普通页面点击行为。
        const dismissZoomBeforeOpen = (e) => {
            if (!zoomFSM.hasActiveZoom()) return;

            // 当前已有放大预览时，只要按下位置仍在“原始图片区域”内，
            // 就把这次操作视为用户正在点击原图/原图所在链接。
            // 不再依赖 event.target 必须是 img；部分网站的点击层、链接层、
            // 图片包装器或事件代理会让 target 变成 div/a/span，导致旧版漏掉。
            const t = e.target;
            if (t && t.closest && t.closest('.image-zoom-container')) return;

            const sourceRect = zoomFSM.getSourceRect ? zoomFSM.getSourceRect() : null;
            if (!sourceRect) return;

            const x = Number(e.clientX);
            const y = Number(e.clientY);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (!inRect(x, y, sourceRect)) return;

            // pointerdown / mousedown 在导航、新标签、站点 click 代理之前执行，
            // 因此无论 blurDismiss 开关状态如何，都先清掉旧放大实例。
            zoomFSM.dispatch('DISMISS');
        };

        // pointerdown 优先于 click：用户点击图片准备打开帖子时先销毁预览。
        // 现代浏览器使用 Pointer Events，因此不再同时监听 mousedown，避免一次点击
        // 连续进入两次 DISMISS；仅在极少数不支持 PointerEvent 的环境回退到 mousedown。
        if ('PointerEvent' in window) {
            document.addEventListener('pointerdown', dismissZoomBeforeOpen, true);
        } else {
            document.addEventListener('mousedown', dismissZoomBeforeOpen, true);
        }

        document.addEventListener('click', (e) => {
            const t = e.target;
            if (!t || !t.closest) return;
            const trigger = t.closest(
                'img,[data-fancybox],[data-lightbox],.zoomable,.lightbox,.gallery-item,.fancybox,' +
                '[onclick*="zoom"],[onclick*="lightbox"],[onclick*="gallery"],[onclick*="preview"]'
            );
            if (!trigger) return;
            zoomFSM.dispatch('DISMISS');
            setTimeout(dismissIfOpen, 0);
        }, true);

        dismissIfOpen();
    }

    // setupLightboxObserver（灯箱观察）

    // ================
    // 10. 滚轮管理器
    // ================
    // ================
// Bilibili player helper. Behavior kept identical to 5.6.26.
const bilibiliVolumeModule = (function() {
        let enabled = storageGet('bilibili_volume_enabled', true);
        let toast = null;

        function isInFullscreenMode() {
            if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) return true;
            if (document.body.classList.contains('player-mode-webfullscreen')) return true;
            const player = document.querySelector('.bpx-player-container');
            return !!(player && player.classList.contains('state-fullscreen'));
        }

        function findVideoElement() {
            const fe = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
            if (fe) {
                const v = fe.querySelector('video');
                if (v) return v;
            }
            return document.querySelector('.bpx-player-container video, video');
        }

        function applyVolume(video, v) {
            const c = Math.max(0, Math.min(1, v));
            try {
                const p = window.player;
                if (p && typeof p.setVolume === 'function') {
                    p.setVolume(Math.round(c * 100));
                    if (c > 0) { typeof p.setMute === 'function' ? p.setMute(false) : (video.muted = false); }
                    return;
                }
            } catch (e) { }
            video.volume = c;
            video.muted = false;
        }

        function getVolume(video) {
            try {
                const p = window.player;
                if (p && typeof p.getVolume === 'function') return p.getVolume() / 100;
            } catch (e) { }
            return video.volume;
        }

        function volIcon(volume) {
            if (volume === 0) return `<svg width="28" height="28" viewBox="0 0 1024 1024"><path d="M64 362.67v298.66h198.33L512 911V113L262.33 362.67H64zM736 512c0-43.56-11.28-83.22-33.83-119-22.56-35.78-52.5-63-89.83-81.67v399c37.33-17.11 67.28-43.55 89.83-79.33C724.72 595.22 736 555.56 736 512z" fill="currentColor"></path><path d="M704.5 320.5l-384 384M320.5 320.5l384 384" stroke="currentColor" stroke-width="56" stroke-linecap="round" fill="none"></path></svg>`;
            return `<svg width="28" height="28" viewBox="0 0 1024 1024"><path d="M64 362.67v298.66h198.33L512 911V113L262.33 362.67H64zM736 512c0-43.56-11.28-83.22-33.83-119-22.56-35.78-52.5-63-89.83-81.67v399c37.33-17.11 67.28-43.55 89.83-79.33C724.72 595.22 736 555.56 736 512zM612.33 75.67v102.67c71.56 21.78 130.67 63.39 177.33 124.83 46.67 61.44 70 131.06 70 208.83 0 77.78-23.33 147.39-70 208.83C743 782.28 683.89 823.89 612.33 845.66v102.67C677.67 932.78 736.78 904 789.67 862s94.5-93.33 124.83-154S960 582 960 512s-15.17-135.33-45.5-196c-30.34-60.67-71.94-112-124.83-154s-112-70.78-177.34-86.33z" fill="currentColor"></path></svg>`;
        }

        function showVolumeToast(volume) {
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'bilibili-volume-toast';
                toast.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                    background:rgba(255,255,255,.9);color:#333;padding:8px 16px;border-radius:8px;z-index:2147483647;
                    font-size:26px;font-weight:300;opacity:0;transition:opacity .3s;pointer-events:none;
                    box-shadow:0 4px 20px rgba(0,0,0,.2);min-width:90px;text-align:center;backdrop-filter:blur(10px);
                    display:flex;align-items:center;justify-content:center;gap:8px;`;
            }
            const parent = document.fullscreenElement || document.body;
            if (!toast.parentNode || toast.parentNode !== parent) {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
                parent.appendChild(toast);
            }
            toast.innerHTML = volIcon(volume) + `<span>${volume === 0 ? '静音' : Math.round(volume * 100) + '%'}</span>`;
            toast.style.opacity = '1';
            if (toast.timeoutId) clearTimeout(toast.timeoutId);
            toast.timeoutId = setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => { if (toast && toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
            }, 2000);
        }

        function isBilibiliHost() {
            return window.location.hostname.includes('bilibili.com');
        }

        function onWheel(e) {
            // ★ 必须带域名判断：onWheel 是滚轮事件链的末端（wheelManager → onWheel），
            // 少了这道门槛，任何站点只要进入全屏且页面里存在 <video>，
            // 滚轮都会被拿去做音量调节，而不是页面原本的滚动/缩放行为。
            if (!enabled || !isBilibiliHost() || !isInFullscreenMode()) return false;
            const video = findVideoElement();
            if (!video) return false;
            e.stopPropagation();
            e.preventDefault();
            const target = Math.max(0, Math.min(1, getVolume(video) + (e.deltaY > 0 ? -0.02 : 0.02)));
            applyVolume(video, target);
            showVolumeToast(target);
            return true;
        }

        function init() {
            if (!isBilibiliHost()) return;
            // ★ 不再接管方向键：方向键完全交给 B 站播放器原生处理。
            // 本模块仅负责全屏滚轮音量辅助与音量提示。
            // 方向键由 B 站原生播放器处理。不要监听 volumechange 显示自定义提示，
            // 否则 ↑/↓ 会同时出现 B 站原生音量提示和 HoverVista 提示。
            // HoverVista 自定义提示仅用于本模块实际接管的全屏滚轮调音量。
        }

        return {
            init, onWheel,
            // 供 wheelManager 判断是否需要挂滚轮监听：同样必须限定站点，
            // 否则非 B 站页面一进全屏就会被挂上滚轮拦截。
            isFullscreenActive: () => isBilibiliHost() && isInFullscreenMode(),
            get isEnabled() { return enabled; },
            setEnabled(v) { enabled = v; storageSet('bilibili_volume_enabled', v); }
        };
    })();


    // 10. Bilibili 播放器辅助
    // ================

    // wheelManager（滚轮调度）


    // ================
    // 11. 样式 / 悬浮按钮 / 配置面板 / 自定义规则
    // ================
    let styleElement = null, dockStyleElement = null;

    function injectStyles() {
        if (!dockStyleElement) {
            const s = document.createElement('style');
            s.textContent = `
                #zoomDockZone{position:fixed;right:0;top:50%;transform:translateY(-50%);width:110px;height:120px;z-index:100000;pointer-events:none}
                #zoomDockZone.open{pointer-events:auto}
                #zoomDock{position:absolute;right:-20px;top:10px;width:44px;height:44px;border-radius:22px 0 0 22px;background:rgba(52,211,153,.20)!important;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(52,211,153,.32)!important;border-right:none;box-shadow:0 2px 8px rgba(0,0,0,.18)!important;display:flex;align-items:center;justify-content:center;padding-left:2px;transition:right .35s cubic-bezier(.34,1.56,.64,1),opacity .3s ease,background .3s ease;opacity:.6;pointer-events:auto;cursor:pointer;z-index:100001}
                #zoomDockZone.open #zoomDock{right:0;opacity:1}
                #zoomDock.off{background:rgba(239,68,68,.20)!important;border-color:rgba(239,68,68,.32)!important}
                #zoomDock.off .icon-svg{opacity:.7}
                #zoomDock.hp{background:rgba(255,152,0,.22)!important;border-color:rgba(255,152,0,.35)!important}
                #zoomDockZone.open #zoomDock:hover{filter:brightness(1.25)}
                .icon-svg{width:20px;height:20px;fill:none;stroke:rgba(255,255,255,.92);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2));pointer-events:none;transition:transform .35s cubic-bezier(.34,1.56,.64,1);transform:translateX(-8px)}
                #zoomDockZone.open .icon-svg{transform:translateX(0)}
                #statusDot{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:6px;height:6px;border-radius:50%;background:#34d399;box-shadow:0 0 12px rgba(52,211,153,.5);transition:background .3s,box-shadow .3s;opacity:.7;pointer-events:none}
                #zoomDock.off #statusDot{background:#f87171;box-shadow:0 0 12px rgba(248,113,113,.5)}
                #zoomDock.hp #statusDot{background:#ffb74d;box-shadow:0 0 12px rgba(255,152,0,.5)}
                #zoomDockZone.open #statusDot{opacity:1}
                #zoomSettings{position:absolute;right:0;top:62px;width:32px;height:32px;border-radius:16px 0 0 16px;background:rgba(20,24,44,.75)!important;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.14)!important;border-right:none;box-shadow:0 4px 20px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transform:translateX(18px) scale(.9);pointer-events:none;transition:all .35s cubic-bezier(.34,1.56,.64,1) .06s;z-index:100002}
                #zoomDockZone.open #zoomSettings{opacity:1;transform:translateX(0) scale(1);pointer-events:auto}
                #zoomSettings:hover{background:rgba(30,36,64,.85)!important;border-color:rgba(251,191,36,.35)!important;box-shadow:0 4px 28px rgba(251,191,36,.18)}
                #zoomSettings .icon-svg--gear{width:16px;height:16px;stroke:rgba(255,255,255,.9);stroke-width:2;fill:none;transition:stroke .3s,transform .6s ease;pointer-events:none}
                #zoomSettings:hover .icon-svg--gear{stroke:#fbbf24;transform:rotate(60deg)}
                .zoom-bubble-tip{position:fixed;background:rgba(20,20,40,.80);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.90);padding:6px 16px;border-radius:10px;font-size:12px;font-weight:450;letter-spacing:.3px;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .25s ease .2s;z-index:100003;box-shadow:0 8px 30px rgba(0,0,0,.4)}
                .zoom-bubble-tip::after{content:'';position:absolute;right:-6px;top:50%;transform:translateY(-50%);border:6px solid transparent;border-left-color:rgba(20,20,40,.80);border-right:0}
                .zoom-bubble-tip.visible{opacity:1}
                body.zoom-dock-dragging,body.zoom-dock-dragging *{transition:none!important;cursor:grabbing!important;user-select:none!important}
                body.zoom-dock-dragging #zoomDock{cursor:grabbing!important}
                /* ===== 放大图外壳（hull）与信息栏（capbar）===== */
                .image-zoom-container .hv-hull{position:absolute;inset:-10px;border-radius:18px;z-index:0;pointer-events:none;
                  background:linear-gradient(160deg,rgba(255,255,255,.72),rgba(255,255,255,.50));
                  border:1px solid rgba(255,255,255,.85);
                  box-shadow:0 24px 60px -22px rgba(12,14,20,.55),0 2px 10px rgba(12,14,20,.14);
                  backdrop-filter:blur(10px) saturate(1.06);-webkit-backdrop-filter:blur(10px) saturate(1.06)}
                .image-zoom-container .hv-capbar{position:absolute;left:-10px;right:-10px;top:calc(100% + 12px);z-index:3;
                  display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 10px;padding:7px 12px 8px;border-radius:12px;
                  background:linear-gradient(160deg,rgba(255,255,255,.88),rgba(255,255,255,.74));
                  border:1px solid rgba(255,255,255,.92);
                  box-shadow:0 14px 34px -18px rgba(12,14,20,.5),0 1px 4px rgba(12,14,20,.10);
                  backdrop-filter:blur(12px) saturate(1.05);-webkit-backdrop-filter:blur(12px) saturate(1.05);
                  color:#1a1c24;font:500 11.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
                  pointer-events:none;opacity:0;transition:opacity .22s ease;white-space:nowrap;overflow:hidden}
                .image-zoom-container .hv-capbar .hv-capname{font-weight:650;font-size:12px;color:#14161d;max-width:52%;
                  overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
                .image-zoom-container .hv-capbar #izImageInfo{flex:1 1 auto;min-width:0;color:rgba(26,28,36,.62);
                  overflow:hidden;text-overflow:ellipsis;opacity:1!important}
                .image-zoom-container .hv-capbar #izImageCaption{flex:1 1 100%;color:rgba(26,28,36,.55);
                  overflow:hidden;text-overflow:ellipsis;line-height:1.45;opacity:1!important}
                .image-zoom-container.hv-nocap .hv-capbar{opacity:0!important}
                @media (prefers-color-scheme: dark){
                  .image-zoom-container .hv-hull{background:linear-gradient(160deg,rgba(28,30,40,.66),rgba(20,22,30,.50));
                    border-color:rgba(255,255,255,.12);
                    box-shadow:0 24px 60px -22px rgba(0,0,0,.8),0 2px 10px rgba(0,0,0,.4)}
                  .image-zoom-container .hv-capbar{background:linear-gradient(160deg,rgba(30,32,42,.82),rgba(22,24,32,.72));
                    border-color:rgba(255,255,255,.10);
                    box-shadow:0 14px 34px -18px rgba(0,0,0,.75),0 1px 4px rgba(0,0,0,.35);color:#eceef4}
                  .image-zoom-container .hv-capbar .hv-capname{color:#f6f7fb}
                  .image-zoom-container .hv-capbar #izImageInfo{color:rgba(236,238,244,.62)}
                  .image-zoom-container .hv-capbar #izImageCaption{color:rgba(236,238,244,.55)}
                }
                /* ===== 统一提示组件（hvToast）：白底/深底 + 品牌蓝图标 + 缩放淡入 ===== */
                .hv-toast{position:fixed;z-index:1000001;display:flex;align-items:center;gap:10px;
                  padding:11px 17px;border-radius:14px;font-size:13px;font-weight:600;line-height:1.5;
                  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
                  background:rgba(255,255,255,.96);color:#0b1220;border:1px solid rgba(203,213,225,.9);
                  box-shadow:0 12px 32px -10px rgba(15,23,42,.28),0 2px 6px rgba(15,23,42,.08);
                  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
                  opacity:0;pointer-events:none;max-width:min(440px,86vw);
                  transition:opacity .26s cubic-bezier(.16,1,.3,1),transform .3s cubic-bezier(.16,1,.3,1)}
                .hv-toast .hv-t-ic{width:20px;height:20px;border-radius:50%;flex:0 0 auto;display:grid;place-items:center;
                  font-size:11px;font-weight:800;color:#fff;background:linear-gradient(135deg,#2563eb,#3d7bf7);
                  box-shadow:0 2px 8px -2px rgba(37,99,235,.55)}
                .hv-toast .hv-t-tx{min-width:0}
                .hv-toast.err .hv-t-ic{background:linear-gradient(135deg,#dc2626,#f87171);box-shadow:0 2px 8px -2px rgba(220,38,38,.5)}
                .hv-toast.warn .hv-t-ic{background:linear-gradient(135deg,#b45309,#f59e0b);box-shadow:0 2px 8px -2px rgba(180,83,9,.5)}
                .hv-toast.mid{left:50%;top:50%;transform:translate(-50%,-50%) translateY(10px) scale(.95)}
                .hv-toast.mid.on{opacity:1;transform:translate(-50%,-50%) translateY(0) scale(1)}
                .hv-toast.center{left:50%;top:50%;transform:translate(-50%,-50%) translateY(10px) scale(.95)}
                .hv-toast.center.on{opacity:1;transform:translate(-50%,-50%) translateY(0) scale(1)}
                .hv-toast.bottom{left:50%;bottom:30px;transform:translateX(-50%) translateY(14px) scale(.96)}
                .hv-toast.bottom.on{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}
                @media (prefers-color-scheme: dark){
                  .hv-toast{background:rgba(26,32,48,.96);color:#f1f5f9;border-color:rgba(255,255,255,.14);
                    box-shadow:0 12px 32px -10px rgba(0,0,0,.7),0 2px 6px rgba(0,0,0,.4)}
                }
                @media (prefers-reduced-motion: reduce){.hv-toast{transition:opacity .12s linear}}
                                /* ===== 设计 token（浅色）===== */
                #izModalOverlay,#izIntroOverlay,#izConfigPanel,#izIntroPanel,#izUpdateNotice,#izHelpModal{
                  --iz-bg-1:rgba(255,255,255,.92);--iz-bg-2:rgba(255,255,255,.55);--iz-bg-3:#ffffff;--iz-bg-4:rgba(248,250,252,.8);--iz-bg-5:#f1f5f9;
                  --iz-bd-1:rgba(203,213,225,.75);--iz-bd-2:#dbe3ec;
                  /* ★ 次级/三级文字整体加深一档：原来 muted(#64748b)/faint(#94a3b8) 在浅底上对比度不足，
                        小字（分区提示、滑杆刻度、折叠说明）几乎看不清，用户容易整块忽略。 */
                  --iz-tx-1:#0b1220;--iz-tx-2:#1e293b;--iz-tx-muted:#44506b;--iz-tx-faint:#64748b;
                  --iz-accent:#2563eb;--iz-accent-solid:#2563eb;--iz-accent-soft:rgba(37,99,235,.13);
                  --iz-grad:linear-gradient(135deg,#2563eb,#3d7bf7);
                  /* ★ 蓝色主调扩展 token：面板整体走蓝，不再中性灰 */
                  --iz-accent-deep:#1d4ed8;
                  --iz-accent-line:rgba(37,99,235,.3);
                  --iz-blue-tint:rgba(37,99,235,.055);
                  --iz-blue-tint-2:rgba(37,99,235,.1);
                  --iz-hover-bg:rgba(255,255,255,.9);--iz-scroll:#bfcbd9;
                  --iz-shadow:0 25px 60px -12px rgba(15,23,42,.35);--iz-inset-ring:rgba(255,255,255,.6);--iz-overlay:rgba(15,23,42,.45);
                  --iz-danger:#dc2626;--iz-danger-soft:rgba(220,38,38,.09);
                  --iz-ok:#047857;--iz-ok-soft:rgba(4,120,87,.1);
                  --iz-warn:#b45309;--iz-warn-bg:#fdf6e9;--iz-warn-tx:#7c3a06;--iz-warn-bd:#e8bf7d;
                  --iz-lead-bg:linear-gradient(135deg,rgba(37,99,235,.08),rgba(61,123,247,.06));--iz-lead-bd:rgba(37,99,235,.16);
                  --iz-r-sm:10px;--iz-r-md:12px;--iz-r-lg:16px;--iz-r-xl:24px;
                }
                /* ===== 设计 token（暗色，跟随系统）===== */
                @media (prefers-color-scheme: dark){
                  #izModalOverlay,#izIntroOverlay,#izConfigPanel,#izIntroPanel,#izUpdateNotice,#izHelpModal{
                    --iz-bg-1:rgba(20,25,40,.94);--iz-bg-2:rgba(255,255,255,.05);--iz-bg-3:rgba(255,255,255,.075);--iz-bg-4:rgba(255,255,255,.055);--iz-bg-5:rgba(255,255,255,.1);
                    --iz-bd-1:rgba(255,255,255,.13);--iz-bd-2:rgba(255,255,255,.17);
                    --iz-tx-1:#f8fafc;--iz-tx-2:#e8edf5;--iz-tx-muted:#c3cbd8;--iz-tx-faint:#9aa5b6;
                    --iz-accent:#6ba3ff;--iz-accent-solid:#3d7bf7;--iz-accent-soft:rgba(107,163,255,.26);
                    --iz-grad:linear-gradient(135deg,#2563eb,#4d8bf9);
                    --iz-accent-deep:#8ab8ff;
                    --iz-accent-line:rgba(107,163,255,.34);
                    --iz-blue-tint:rgba(107,163,255,.09);
                    --iz-blue-tint-2:rgba(107,163,255,.15);
                    --iz-hover-bg:rgba(255,255,255,.10);--iz-scroll:rgba(255,255,255,.24);
                    --iz-shadow:0 25px 60px -12px rgba(0,0,0,.72);--iz-inset-ring:rgba(255,255,255,.08);--iz-overlay:rgba(0,0,0,.62);
                    --iz-danger:#f87171;--iz-danger-soft:rgba(248,113,113,.15);
                    --iz-ok:#34d399;--iz-ok-soft:rgba(52,211,153,.14);
                    --iz-warn:#fbbf24;--iz-warn-bg:rgba(245,158,11,.16);--iz-warn-tx:#fcd34d;--iz-warn-bd:rgba(245,158,11,.35);
                    --iz-lead-bg:linear-gradient(135deg,rgba(107,163,255,.14),rgba(61,123,247,.10));--iz-lead-bd:rgba(107,163,255,.24);
                  }
                }
                #izModalOverlay{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:24px;background:var(--iz-overlay);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
                #izModalOverlay.anim-in{animation:izOverlayFade .35s ease}
                #izModalOverlay.anim-out{animation:izOverlayFadeOut .3s ease forwards}
                @keyframes izOverlayFade{from{opacity:0}to{opacity:1}}
                @keyframes izOverlayFadeOut{from{opacity:1}to{opacity:0}}
                #izConfigPanel{width:100%;max-width:780px;max-height:92vh;background:var(--iz-bg-1);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:var(--iz-r-xl);box-shadow:var(--iz-shadow),0 0 0 1px var(--iz-inset-ring) inset;overflow:hidden;animation:izPanelSlide .40s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box;color:var(--iz-tx-1)}
                @keyframes izPanelSlide{from{opacity:0;transform:translateY(28px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
                .iz-panel-scroll{flex:1;overflow-y:auto;padding:0 28px 12px 28px;scroll-behavior:smooth}.iz-top-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:stretch}.iz-top-grid>.iz-section{margin-top:12px;min-width:0;display:flex;flex-direction:column}.iz-switch-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;flex:1;align-items:stretch}.iz-switch-card{display:grid;grid-template-columns:24px minmax(0,1fr);grid-template-rows:auto auto;align-items:start;column-gap:12px;row-gap:3px;min-height:72px;padding:9px 10px;background:var(--iz-bg-4);border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-md);cursor:pointer;user-select:none;transition:background .2s,border-color .2s,transform .2s}.iz-switch-card:hover{background:var(--iz-hover-bg);border-color:var(--iz-accent-soft);transform:translateY(-1px)}.iz-switch-card:focus-visible{outline:2px solid var(--iz-accent);outline-offset:2px}.iz-switch-card .iz-toggle{grid-column:1;grid-row:1;margin:1px 0 0 0;transform:scale(.64);transform-origin:top left;flex-shrink:0}.iz-switch-text{display:contents}.iz-switch-title{grid-column:2;grid-row:1;font-size:13px;font-weight:600;color:var(--iz-tx-2);line-height:1.35}.iz-switch-sub{grid-column:1 / -1;grid-row:2;font-size:12px;font-weight:400;color:var(--iz-tx-muted);line-height:1.5;margin-top:2px}.iz-bili-note{display:none}
                .iz-panel-scroll::-webkit-scrollbar{width:4px}
                .iz-panel-scroll::-webkit-scrollbar-track{background:transparent}
                .iz-panel-scroll::-webkit-scrollbar-thumb{background:var(--iz-scroll);border-radius:8px}
                /* ===== 新版面板布局（izn：左导航 + 分区视图）===== */
                #izConfigPanel{max-width:1000px}
                .izn-top{display:flex;align-items:center;gap:12px;padding:13px 20px;border-bottom:1px solid var(--iz-accent-line);flex-shrink:0;background:linear-gradient(180deg,var(--iz-blue-tint-2),var(--iz-blue-tint) 65%,transparent)}
                .izn-brand{display:flex;align-items:center;gap:9px;min-width:0}
                .izn-mark{width:28px;height:28px;border-radius:9px;background:var(--iz-grad);color:#fff;display:grid;place-items:center;font-size:13px;flex-shrink:0;box-shadow:0 4px 12px -4px var(--iz-accent-line)}
                .izn-name{font-size:15px;font-weight:750;color:var(--iz-accent-deep);white-space:nowrap}
                .izn-name em{font-style:normal;font-weight:500;color:var(--iz-tx-muted);font-size:11.5px;margin-left:5px}
                .izn-scope{display:inline-flex;align-items:center;gap:6px;background:var(--iz-blue-tint-2);color:var(--iz-accent-deep);border:1px solid var(--iz-accent-line);border-radius:999px;padding:3px 11px;font-size:11.5px;font-weight:650;min-width:0}
                .izn-scope .izn-sd{width:6px;height:6px;border-radius:50%;background:var(--iz-accent);flex-shrink:0}
                .izn-scope b{font-weight:750;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                .izn-saved{margin-left:auto;font-size:11.5px;font-weight:650;color:var(--iz-ok);display:flex;align-items:center;gap:5px;white-space:nowrap}
                .izn-saved::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--iz-ok)}
                .izn-body{flex:1;display:flex;min-height:0}
                .izn-nav{width:190px;flex-shrink:0;border-right:1px solid var(--iz-accent-line);padding:10px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto;overscroll-behavior:contain;background:var(--iz-blue-tint)}
                .izn-nav-group{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--iz-accent);opacity:.85;padding:10px 8px 4px}
                .izn-nav-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;border:1px solid transparent;background:none;color:var(--iz-tx-2);font-size:13px;cursor:pointer;text-align:left;width:100%;font-family:inherit;transition:.15s ease}
                .izn-nav-item:hover{background:var(--iz-blue-tint-2);color:var(--iz-accent-deep)}
                .izn-nav-item.on{background:var(--iz-accent)!important;border-color:var(--iz-accent)!important;color:#fff!important;font-weight:650;box-shadow:0 4px 12px -5px var(--iz-accent-line)}
                .izn-nav-item .izn-tag{margin-left:auto;font-size:10px;color:var(--iz-tx-muted);background:var(--iz-bg-5);border-radius:999px;padding:1px 6px;flex-shrink:0}
                .izn-nav-item.on .izn-tag{background:rgba(255,255,255,.26)!important;color:#fff!important}
                .izn-content{flex:1;min-width:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 22px 24px}
                .izn-content::-webkit-scrollbar{width:4px}
                .izn-content::-webkit-scrollbar-thumb{background:var(--iz-scroll);border-radius:8px}
                .izn-view{display:none}
                .izn-view.on{display:block;animation:izViewIn .3s cubic-bezier(.16,1,.3,1)}
                .izn-vhead{margin-bottom:14px}
                .izn-vtitle{font-size:19px;font-weight:750;color:var(--iz-accent-deep);margin:0 0 3px;letter-spacing:-.01em}
                .izn-vsub{font-size:12.5px;color:var(--iz-tx-muted);margin:0;line-height:1.65}
                .izn-sect{margin-bottom:16px}
                .izn-sect-h{display:flex;align-items:center;gap:8px;margin:0 0 9px;padding-bottom:7px;border-bottom:1px solid var(--iz-accent-line)}
                .izn-sect-h b{font-size:13px;font-weight:700;color:var(--iz-accent-deep);display:inline-flex;align-items:center;gap:7px}
                .izn-sect-h b::before{content:'';width:3px;height:13px;border-radius:2px;background:var(--iz-accent);flex:0 0 auto}
                .izn-sect-h .izn-hint{font-size:11.5px;font-weight:500;color:var(--iz-tx-faint)}
                .izn-sect-h .right{margin-left:auto;display:flex;gap:7px;align-items:center}
                .izn-row{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px dashed var(--iz-bd-1)}
                .izn-row:last-child{border-bottom:0}
                .izn-row .t{font-size:13px;font-weight:600;color:var(--iz-tx-2)}
                .izn-row .d{font-size:11.5px;color:var(--iz-tx-muted);line-height:1.55;margin-top:2px}
                .izn-row .rc{margin-left:auto;flex-shrink:0;display:flex;align-items:center;gap:8px}
                .izn-status{display:flex;align-items:center;gap:9px;background:var(--iz-bg-4);border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-md);padding:10px 12px;font-size:12.5px;color:var(--iz-tx-2)}
                .izn-status .izn-sd{width:7px;height:7px;border-radius:50%;background:var(--iz-ok);flex-shrink:0}
                .izn-status .flex{flex:1;min-width:0}
                .izn-status .note{font-size:11px;color:var(--iz-tx-muted);margin-top:3px;line-height:1.5}
                .izn-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
                @media (max-width:900px){.izn-grid2{grid-template-columns:1fr}}
                .izn-diag{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
                @media (max-width:900px){.izn-diag{grid-template-columns:1fr}}
                .izn-diag button{text-align:left;border:1px solid var(--iz-bd-1);background:var(--iz-bg-4);border-radius:var(--iz-r-md);padding:10px 11px;cursor:pointer;font-family:inherit;transition:.15s ease;display:block;width:100%}
                .izn-diag button:hover{border-color:color-mix(in srgb,var(--iz-accent) 42%,transparent)}
                .izn-diag .q{display:block;font-size:12.5px;font-weight:650;color:var(--iz-tx-2);margin-bottom:2px}
                .izn-diag .a{display:block;font-size:11px;color:var(--iz-tx-muted);line-height:1.5}
                .izn-diag .a b{color:var(--iz-accent);font-weight:600}
                .izn-lock{display:flex;align-items:center;gap:9px;background:var(--iz-warn-bg);border:1px solid var(--iz-warn-bd);color:var(--iz-warn-tx);border-radius:var(--iz-r-md);padding:9px 12px;font-size:12.5px;margin-bottom:12px}
                .izn-lock .flex{flex:1}
                .izn-locked{opacity:.55}
                .izn-place-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
                @media (max-width:900px){.izn-place-grid{grid-template-columns:1fr}}
                .izn-place{border:1.5px solid var(--iz-bd-2);border-radius:var(--iz-r-md);background:var(--iz-bg-3);padding:9px;cursor:pointer;font-family:inherit;text-align:left;
                  transition:.18s cubic-bezier(.16,1,.3,1);display:block;width:100%}
                .izn-place:hover{border-color:var(--iz-accent-line);transform:translateY(-1.5px);box-shadow:0 6px 16px -10px rgba(37,99,235,.42)}
                .izn-place.on{border-color:var(--iz-accent)!important;background:var(--iz-blue-tint)!important;box-shadow:0 5px 16px -9px var(--iz-accent-line)}
                .izn-place .pn{display:block;font-size:12.5px;font-weight:700;color:var(--iz-tx-2)}
                .izn-place.on .pn{color:var(--iz-accent-deep)!important}
                .izn-place .pd{display:block;font-size:11px;color:var(--iz-tx-muted);line-height:1.5;margin-top:1px}
                /* 帮助 / 更新说明 弹窗 */
                #izHelpModal{position:fixed;inset:0;z-index:100001;display:none;align-items:center;justify-content:center;padding:24px;background:var(--iz-overlay);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
                #izHelpModal.open{display:flex}
                .izn-hmodal{width:min(620px,100%);max-height:86vh;background:var(--iz-bg-1);backdrop-filter:blur(20px);border-radius:var(--iz-r-lg);box-shadow:var(--iz-shadow),0 0 0 1px var(--iz-inset-ring) inset;display:flex;flex-direction:column;overflow:hidden;color:var(--iz-tx-1)}
                .izn-hhead{padding:16px 20px 0;display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--iz-bd-1)}
                .izn-hmark{width:28px;height:28px;border-radius:9px;background:var(--iz-grad);color:#fff;display:grid;place-items:center;font-size:13px;flex-shrink:0}
                .izn-htabs{display:flex;gap:4px;margin-left:6px}
                .izn-htabs button{border:0;background:none;font-family:inherit;font-size:13px;font-weight:600;color:var(--iz-tx-muted);cursor:pointer;padding:7px 12px;border-radius:8px 8px 0 0;border-bottom:2px solid transparent;transition:.15s ease}
                .izn-htabs button:hover{color:var(--iz-tx-1)}
                .izn-htabs button.on{color:var(--iz-accent)!important;border-bottom-color:var(--iz-accent)!important;background:var(--iz-accent-soft)!important}
                .izn-hclose{margin-left:auto;border:0;background:none;color:var(--iz-tx-muted);font-size:15px;cursor:pointer;padding:4px 8px;border-radius:8px}
                .izn-hclose:hover{background:var(--iz-hover-bg);color:var(--iz-tx-1)}
                .izn-hbody{padding:15px 20px 18px;overflow-y:auto;overscroll-behavior:contain}
                .izn-htab{display:none}
                .izn-htab.on{display:block;animation:izOverlayFade .2s ease}
                .izn-hgroup{margin-bottom:14px}
                .izn-hgroup:last-child{margin-bottom:0}
                .izn-hgroup h4{margin:0 0 6px;font-size:12px;font-weight:700;color:var(--iz-accent);display:flex;align-items:center;gap:7px}
                .izn-hgroup h4::before{content:'';width:14px;height:2px;border-radius:2px;background:var(--iz-accent)}
                .izn-hgroup ul{margin:0;padding:0;list-style:none}
                .izn-hgroup li{font-size:12.5px;color:var(--iz-tx-2);line-height:1.7;padding:3px 0 3px 15px;position:relative}
                .izn-hgroup li::before{content:'';position:absolute;left:3px;top:11px;width:5px;height:5px;border-radius:50%;background:var(--iz-accent-soft);box-shadow:0 0 0 1.5px var(--iz-accent)}
                .izn-hgroup kbd{font-family:var(--mono,monospace);font-size:11px;background:var(--iz-accent-soft);color:var(--iz-accent);border:1px solid color-mix(in srgb,var(--iz-accent) 26%,transparent);border-bottom-width:2px;border-radius:5px;padding:1px 6px;margin:0 1px}
                .izn-hverline{display:flex;align-items:center;gap:8px;background:var(--iz-accent-soft);border:1px solid color-mix(in srgb,var(--iz-accent) 22%,transparent);border-radius:var(--iz-r-md);padding:9px 12px;margin-bottom:12px}
                .izn-hverline .v{font-family:var(--mono,monospace);font-weight:700;color:var(--iz-accent);font-size:13px}
                .izn-hverline .d{font-size:11.5px;color:var(--iz-tx-muted)}
                .izn-hnew{font-size:12px;color:var(--iz-tx-2);line-height:1.6;margin:0 0 13px;background:var(--iz-bg-4);border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-md);padding:9px 12px}
                .izn-hnew b{color:var(--iz-accent)}
                .izn-hfoot{padding:0 20px 16px;display:flex;align-items:center;gap:8px}
                .izn-hfoot .ver{font-size:10.5px;color:var(--iz-tx-faint);font-family:var(--mono,monospace);margin-right:auto}
                @media (max-width:760px){
                  .izn-body{flex-direction:column}
                  .izn-nav{width:auto;flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--iz-bd-1);padding:8px}
                  .izn-nav-group{display:none}
                  .izn-nav-item{width:auto;white-space:nowrap}
                  .izn-content{padding:14px}
                }
                .iz-panel-header{display:flex;align-items:center;justify-content:space-between;padding:20px 28px 0 28px;flex-shrink:0}
                .iz-panel-header-left{display:flex;align-items:center;gap:12px}
                .iz-panel-icon{width:38px;height:38px;background:var(--iz-grad);border-radius:var(--iz-r-md);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;flex-shrink:0;box-shadow:0 4px 12px rgba(79,70,229,.3)}
                .iz-panel-title{font-size:20px;font-weight:600;color:var(--iz-tx-1);letter-spacing:-.3px}
                .iz-panel-title span{font-weight:400;color:var(--iz-tx-muted);font-size:14px;margin-left:6px}
                .iz-close-btn{width:36px;height:36px;border:none;background:var(--iz-bg-5);border-radius:50%;cursor:pointer;font-size:18px;color:var(--iz-tx-muted);display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0;line-height:1}
                .iz-close-btn:hover{background:var(--iz-danger-soft);color:var(--iz-danger);transform:rotate(90deg)}
                .iz-close-btn:focus-visible{outline:2px solid var(--iz-accent);outline-offset:2px}
                .iz-section{margin-top:12px;background:var(--iz-bg-2);border-radius:var(--iz-r-lg);padding:14px 16px 16px 16px;border:1px solid var(--iz-bd-1)}
                .iz-section-title{font-size:13px;font-weight:600;color:var(--iz-tx-2);letter-spacing:.5px;margin-bottom:10px;display:flex;align-items:center;gap:8px}
                .iz-keymap-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
                .iz-key-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:46px;padding:8px 10px;background:var(--iz-bg-4);border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-md);min-width:0}
                .iz-key-name{display:flex;flex-direction:column;gap:2px;min-width:0}
                .iz-key-name b{font-size:13px;font-weight:600;color:var(--iz-tx-2);line-height:1.3}
                .iz-key-name span{font-size:11px;color:var(--iz-tx-muted);line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                .iz-key-cap{flex-shrink:0;min-width:68px;padding:5px 10px;font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--iz-tx-2);background:var(--iz-bg-2);border:1px solid var(--iz-bd-1);border-bottom-width:2px;border-radius:6px;cursor:pointer;transition:background .15s,border-color .15s}
                .iz-key-cap:hover{background:var(--iz-hover-bg);border-color:var(--iz-accent-soft)}
                .iz-key-cap.recording{background:var(--iz-accent);border-color:var(--iz-accent);color:#fff;animation:izKeyPulse 1s ease-in-out infinite}
                @keyframes izKeyPulse{0%,100%{opacity:1}50%{opacity:.55}}
                .iz-badge{background:var(--iz-accent-solid);color:#fff;font-size:11px;font-weight:600;padding:1px 8px;border-radius:20px;line-height:16px}
                .iz-row{display:flex;align-items:center;gap:14px;margin-bottom:14px}
                .iz-row:last-child{margin-bottom:0}
                .iz-row-label{font-size:14px;font-weight:500;color:var(--iz-tx-2);flex-shrink:0;min-width:100px}
                .iz-row-label .iz-hint{font-weight:400;font-size:12px;color:var(--iz-tx-muted);display:block;margin-top:1px}
                .iz-row-control{flex:1;min-width:0}
                .iz-checkbox-wrap{display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none}
                .iz-checkbox-wrap:focus-visible{outline:2px solid var(--iz-accent);outline-offset:2px;border-radius:var(--iz-r-sm)}
                .iz-checkbox-custom{width:20px;height:20px;flex-shrink:0;border:2px solid var(--iz-bd-2);border-radius:6px;background-color:var(--iz-bg-3);transition:all .2s;display:flex;align-items:center;justify-content:center}
                .iz-checkbox-custom.checked{background-color:var(--iz-accent-solid);border-color:var(--iz-accent-solid)}
                .iz-checkbox-custom.checked::after{content:"✓";color:#fff;font-size:14px;font-weight:700;line-height:1}
                .iz-checkbox-label{font-size:14px;font-weight:500;color:var(--iz-tx-2)}
                .iz-checkbox-label .iz-sub{font-weight:400;font-size:12px;color:var(--iz-tx-muted);display:block;margin-top:1px}
                .iz-toggle-wrap{display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none}
                .iz-toggle{position:relative;width:46px;height:28px;flex-shrink:0;background:var(--iz-bd-2);border-radius:20px;transition:all .3s cubic-bezier(.34,1.56,.64,1);box-shadow:inset 0 1px 3px rgba(0,0,0,.1)}
                .iz-toggle.active{background:var(--iz-grad)!important}
                .iz-toggle .iz-knob{position:absolute;top:3px;left:3px;width:22px;height:22px;background:#fff;border-radius:50%;transition:all .3s cubic-bezier(.34,1.56,.64,1);box-shadow:0 2px 6px rgba(0,0,0,.18)}
                .iz-toggle.active .iz-knob{left:21px}
                .iz-exclusion-box{background-color:var(--iz-bg-4);border-radius:var(--iz-r-md);padding:10px 12px;border:1px solid var(--iz-bd-1)}
                .iz-exclusion-box .iz-status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
                .iz-exclusion-box .iz-status-text{font-size:13px;font-weight:500;display:flex;align-items:center;gap:8px;color:var(--iz-tx-2)}
                .iz-exclusion-box .iz-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
                .iz-exclusion-box .iz-dot.on{background:var(--iz-ok)!important}
                .iz-exclusion-box .iz-dot.off{background:var(--iz-warn)}
                .iz-exclusion-note{margin-top:5px;font-size:12px;color:var(--iz-tx-muted)}
                .iz-btn-sm{padding:6px 16px;border:none;border-radius:var(--iz-r-sm);font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;flex-shrink:0;height:34px}
                .iz-btn-sm.primary{background:var(--iz-accent-solid);color:#fff}
                .iz-btn-sm.primary:hover{filter:brightness(1.1);transform:translateY(-1px);box-shadow:0 4px 12px rgba(79,70,229,.3)}
                .iz-btn-sm.warning{background:var(--iz-warn-bg);color:var(--iz-warn-tx);border:0.5px solid var(--iz-warn-bd)}
                .iz-btn-sm.warning:hover{filter:brightness(.97);transform:translateY(-1px);box-shadow:0 4px 12px rgba(245,158,11,.22)}
                .iz-btn-sm:focus-visible{outline:2px solid var(--iz-accent);outline-offset:2px}
                .iz-collapse-header{display:flex;align-items:flex-start;justify-content:space-between;padding:8px 6px 5px 6px;cursor:pointer;user-select:none;border-top:1px solid var(--iz-bd-1);margin-top:4px;transition:background .2s;gap:16px;border-radius:var(--iz-r-sm)}
                .iz-collapse-header:hover{background:var(--iz-bg-4)}
                .iz-collapse-header:focus-visible{outline:2px solid var(--iz-accent);outline-offset:2px}
                .iz-collapse-header .iz-left{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--iz-tx-1);min-width:0;white-space:nowrap;flex-wrap:nowrap}.iz-collapse-description{font-size:12px;color:var(--iz-tx-muted);line-height:1.45;margin:2px 0 0 20px;white-space:nowrap}
                .iz-collapse-header .iz-arrow{transition:transform .3s ease;font-size:12px;color:var(--iz-tx-faint);flex:0 0 auto}
                .iz-collapse-header .iz-arrow.open{transform:rotate(90deg)}
                .iz-count{font-size:11px;font-weight:500;color:var(--iz-tx-muted);background-color:var(--iz-bg-5);padding:1px 9px;border-radius:20px;white-space:nowrap;flex:0 0 auto}
                .iz-badge-params{font-size:11px;font-weight:500;color:var(--iz-tx-muted);background-color:var(--iz-bg-5);padding:2px 9px;border-radius:20px;white-space:nowrap}.iz-header-name{white-space:nowrap;flex:0 0 auto}
                .iz-collapse-body{overflow:hidden;max-height:0;opacity:0;transition:max-height .35s cubic-bezier(.16,1,.3,1),opacity .35s cubic-bezier(.16,1,.3,1),padding-top .35s cubic-bezier(.16,1,.3,1)}
                .iz-collapse-body.open{max-height:1200px;opacity:1;padding-top:9px}
                .iz-param-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px 12px}.iz-param-sections{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}.iz-param-sections>.iz-section{min-width:0}
                .iz-param-item{display:flex;flex-direction:column;gap:4px}
                .iz-param-item label{font-size:12px;font-weight:500;color:var(--iz-tx-muted);letter-spacing:.2px;display:flex;align-items:center;gap:5px;white-space:nowrap}
                .iz-tip-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0;border-radius:50%;background-color:var(--iz-bd-2);color:var(--iz-tx-muted);font-size:10px;font-weight:700;line-height:1;cursor:help;position:relative;transition:all .2s}
                .iz-tip-icon:hover,.iz-tip-icon:focus-visible{background-color:var(--iz-accent);color:#fff}
                /* 参数说明气泡：挂在 body 上（面板外），所以颜色自包含、不走 --iz-* 变量 */
                #izTipBubble{position:fixed;width:256px;background:rgba(255,255,255,.97);color:#1e293b;
                  font-size:12px;font-weight:500;line-height:1.68;padding:11px 14px;border-radius:12px;
                  border:1px solid rgba(37,99,235,.3);
                  box-shadow:0 14px 34px -12px rgba(15,23,42,.32),0 2px 6px rgba(15,23,42,.07);
                  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
                  opacity:0;pointer-events:none;transition:opacity .16s ease;z-index:100005;white-space:normal;text-align:left}
                @media (prefers-color-scheme: dark){
                  #izTipBubble{background:rgba(26,32,48,.97);color:#e8edf5;border-color:rgba(107,163,255,.36);
                    box-shadow:0 14px 34px -12px rgba(0,0,0,.78),0 2px 6px rgba(0,0,0,.42)}
                }
                .iz-param-item .iz-slider-scale{font-size:10px}
                /* ===== 数值参数：滑块 + 数字框（滑块探索区间，数字框精确输入）===== */
                .iz-slider-row{display:flex;align-items:center;gap:10px}
                .iz-slider{-webkit-appearance:none;appearance:none;flex:1;min-width:0;height:4px;border-radius:999px;outline:none;cursor:pointer;
                  background:linear-gradient(90deg,var(--iz-accent) 0%,var(--iz-accent) var(--fill,50%),var(--iz-bd-2) var(--fill,50%),var(--iz-bd-2) 100%)}
                .iz-slider::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:#fff;
                  border:2.5px solid var(--iz-accent);box-shadow:0 1px 4px rgba(15,23,42,.22);transition:transform .14s ease}
                .iz-slider:hover::-webkit-slider-thumb{transform:scale(1.14)}
                .iz-slider::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:#fff;border:2.5px solid var(--iz-accent);border:none}
                .iz-slider:disabled{opacity:.5;cursor:not-allowed}
                .iz-slider-row.disabled-group{opacity:.45}
                .iz-slider-row .iz-param-num{width:72px;flex-shrink:0;text-align:right;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;
                  padding:5px 8px;border:1.5px solid var(--iz-bd-2);border-radius:var(--iz-r-sm);background:var(--iz-bg-3);color:var(--iz-tx-1);outline:none;
                  -moz-appearance:textfield}
                .iz-slider-row .iz-param-num::-webkit-inner-spin-button,.iz-slider-row .iz-param-num::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
                .iz-slider-row .iz-param-num:focus{border-color:var(--iz-accent);box-shadow:0 0 0 3px var(--iz-accent-soft)}
                .iz-slider-row .iz-param-num.pop{animation:izNumPop .34s ease}
                @keyframes izNumPop{0%{transform:scale(1)}40%{transform:scale(1.14)}100%{transform:scale(1)}}
                .iz-slider-scale{display:flex;justify-content:space-between;font-size:10.5px;font-weight:500;color:var(--iz-tx-faint);margin-top:3px;min-height:14px}
                /* ===== 分段控件（替代下拉框：选项一眼看全、一次点中）===== */
                .iz-seg{display:inline-flex;background:var(--iz-bg-5);border-radius:9px;padding:3px;gap:2px}
                .iz-seg button{font:inherit;font-size:12px;font-weight:600;padding:6px 13px;border-radius:7px;border:none;background:none;
                  color:var(--iz-tx-muted);cursor:pointer;white-space:nowrap;
                  transition:color .18s,background .22s cubic-bezier(.16,1,.3,1),box-shadow .22s}
                .iz-seg button:hover{color:var(--iz-tx-2)}
                .iz-seg button.on{background:var(--iz-bg-3)!important;color:var(--iz-accent)!important;box-shadow:0 1px 3px rgba(15,23,42,.1)}
                /* ===== 高级折叠（精确宽高等次要设置）=====
                   原来用灰色小字，与背景几乎融为一体，用户根本注意不到这里还有内容。
                   改成品牌蓝 + 加粗 + hover 底色，明确「这里可以展开」。 */
                .iz-adv{margin:4px 14px 12px;padding-top:10px;border-top:1px solid var(--iz-accent-line)}
                .iz-adv>summary{font-size:12.5px;font-weight:650;color:var(--iz-accent-deep);cursor:pointer;user-select:none;list-style:none;
                  display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:7px;transition:.16s}
                .iz-adv>summary:hover{color:var(--iz-accent);background:var(--iz-blue-tint-2)!important}
                .iz-adv>summary::-webkit-details-marker{display:none}
                .iz-adv>summary::before{content:'▸';font-size:10px;transition:transform .2s cubic-bezier(.16,1,.3,1)}
                .iz-adv[open]>summary::before{transform:rotate(90deg)}
                /* ===== 「已改」标记：与默认值不同的参数左侧出现品牌色竖线 ===== */
                .iz-param-item{position:relative}
                .iz-param-item.mod::before{content:'';position:absolute;left:-9px;top:4px;bottom:4px;width:2.5px;border-radius:0 3px 3px 0;
                  background:var(--iz-accent);animation:izModIn .2s ease}
                @keyframes izModIn{from{transform:scaleY(0);opacity:0}to{transform:scaleY(1);opacity:1}}
                /* ===== 三列图示卡（出现方式）===== */
                .izn-place-grid--3{grid-template-columns:repeat(3,1fr)}
                @media (max-width:900px){.izn-place-grid--3{grid-template-columns:1fr}}
                /* ===== 动画演示卡 =====
                   把「两个模式到底差在哪」用循环动画直接演出来，而不是靠文字描述。
                   每张卡里有一个静态缩略图（d-thumb）和一个循环进出的预览框（d-preview），
                   不同模式用不同 keyframes 表现差异：位置不同 / 尺寸策略不同 / 进场方式不同。 */
                .izn-demo{position:relative;height:66px;border-radius:9px;overflow:hidden;margin-bottom:7px;
                  background:linear-gradient(160deg,var(--iz-bg-5),var(--iz-bg-4));border:1px solid var(--iz-bd-1)}
                .izn-demo .d-thumb{position:absolute;left:9px;top:11px;width:26px;height:20px;border-radius:4px;
                  background:linear-gradient(135deg,#c7d7ea,#e3ecf6);border:1px solid rgba(148,163,184,.55);z-index:1}
                .izn-demo .d-preview{position:absolute;border-radius:6px;opacity:0;
                  background:linear-gradient(135deg,#8fb3e0,#c6d8ee 50%,#9dbfe6);
                  box-shadow:0 6px 16px -6px rgba(15,23,42,.45),inset 0 0 0 1px rgba(255,255,255,.5)}
                .izn-demo .d-tag{position:absolute;right:6px;bottom:5px;z-index:2;font-size:9px;font-weight:800;letter-spacing:.04em;
                  color:var(--iz-accent-deep);background:var(--iz-bg-3);border:1px solid var(--iz-accent-line);border-radius:5px;padding:1px 5px}
                /* 屏幕居中：预览框从舞台正中浮出 */
                .izn-demo[data-demo="center"] .d-preview{left:50%;top:50%;width:58px;height:40px;margin:-20px 0 0 -29px;
                  animation:demoCenter 3.8s cubic-bezier(.16,1,.3,1) infinite}
                @keyframes demoCenter{
                  0%,10%{opacity:0;transform:scale(.84)}
                  24%,66%{opacity:1;transform:scale(1)}
                  80%,100%{opacity:0;transform:scale(.94)}
                }
                /* 原图周围：预览框贴着缩略图右侧出现（不遮挡它） */
                .izn-demo[data-demo="around"] .d-preview{left:44px;top:9px;width:46px;height:32px;
                  animation:demoAround 3.8s cubic-bezier(.16,1,.3,1) infinite}
                @keyframes demoAround{
                  0%,10%{opacity:0;transform:translateY(7px) scale(.92)}
                  24%,66%{opacity:1;transform:translateY(0) scale(1)}
                  80%,100%{opacity:0;transform:translateY(5px) scale(.95)}
                }
                /* 放大模式：刻意不做动画。
                   实测两种模式的入场动效看起来几乎一样（都是「预览框出现」），
                   用动画反而分不清差异。改成静态对比：三个方块宽度「渐变 vs 等宽」，
                   直接表达「尺寸会随图片变」vs「尺寸永远一样」。 */
                .izn-mode-vis{display:flex;align-items:center;gap:5px;height:60px;padding:0 5px;margin-bottom:8px;
                  border-radius:9px;background:linear-gradient(160deg,var(--iz-bg-5),var(--iz-bg-4));border:1px solid var(--iz-bd-1)}
                .izn-mode-vis .mv-frame{height:68%;flex:var(--g,1) 1 0;min-width:0;border-radius:4px;
                  background:linear-gradient(135deg,#9dbfe6,#c6d8ee);box-shadow:0 2px 6px -3px rgba(15,23,42,.35)}
                .izn-mode .izn-mode-tagline{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.02em;
                  color:var(--iz-accent-deep);background:var(--iz-blue-tint-2);border-radius:5px;padding:1px 7px;margin-top:5px}
                /* 从原图弹出：预览框从「缩略图所在位置」（缩小状态）滑行放大到预览位置。
                   —— 对应脚本 dock 动效（FLIP：实测起始帧 translate(-322px,-180px) scale(0.3226)，
                      即从原图 rect 滑到预览 rect，不是「从下方升起」） */
                .izn-demo[data-demo="fx-dock"] .d-preview{left:44px;top:8px;width:48px;height:34px;
                  animation:demoDock 3.8s cubic-bezier(.16,1,.3,1) infinite}
                @keyframes demoDock{
                  0%,8%{opacity:0;transform:translate(-46px,-4px) scale(.54)}
                  26%,66%{opacity:1;transform:none}
                  80%,100%{opacity:0;transform:translate(-40px,-3px) scale(.6)}
                }
                /* 从原图绽开：预览框就落在缩略图位置，用圆形从缩略图中心向外绽开。
                   —— 对应脚本 spotlight 动效（实测 clipPath circle(25px at 源图中心) → circle(932px)，
                      图片几乎不位移、原地聚焦，另有白光爆闪） */
                .izn-demo[data-demo="fx-spotlight"] .d-preview{left:16px;top:10px;width:52px;height:38px;
                  animation:demoSpot 3.8s cubic-bezier(.2,.7,.3,1) infinite}
                @keyframes demoSpot{
                  0%,8%{opacity:0;clip-path:circle(2px at 6px 11px);transform:scale(.94)}
                  28%,66%{opacity:1;clip-path:circle(62px at 6px 11px);transform:none}
                  82%,100%{opacity:0;clip-path:circle(50px at 6px 11px)}
                }
                /* 直接淡入 */
                .izn-demo[data-demo="fx-fade"] .d-preview{left:50%;top:50%;width:50px;height:34px;margin:-17px 0 0 -25px;
                  animation:demoFade 3.8s ease infinite}
                @keyframes demoFade{
                  0%,12%{opacity:0}
                  24%,68%{opacity:1}
                  82%,100%{opacity:0}
                }
                /* ===== 放大模式：两张醒目大卡（这个选项很重要，不能再用一行下拉糊过去）===== */
                .izn-mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
                .izn-mode{position:relative;border:2px solid var(--iz-bd-2);border-radius:var(--iz-r-md);background:var(--iz-bg-3);
                  padding:11px;cursor:pointer;font-family:inherit;text-align:left;transition:.2s cubic-bezier(.16,1,.3,1)}
                .izn-mode:hover{border-color:var(--iz-accent-line);transform:translateY(-1.5px);box-shadow:0 8px 20px -12px rgba(37,99,235,.4)}
                .izn-mode.on{border-color:var(--iz-accent)!important;background:var(--iz-blue-tint)!important;box-shadow:0 6px 18px -10px var(--iz-accent-line)}
                .izn-mode .izn-mode-badge{position:absolute;top:-8px;right:10px;z-index:3;font-size:9.5px;font-weight:800;letter-spacing:.04em;
                  color:#fff;background:var(--iz-accent);border-radius:999px;padding:2px 8px}
                .izn-mode .izn-mode-vis{margin-bottom:8px}
                .izn-mode .pn{display:block;font-size:13px;font-weight:700;color:var(--iz-tx-2)}
                .izn-mode.on .pn{color:var(--iz-accent-deep)!important}
                .izn-mode .pd{display:block;font-size:11px;color:var(--iz-tx-muted);line-height:1.5;margin-top:2px}
                /* ===== 预览尺寸：用方块大小直接表达「大图能有多大」===== */
                .izn-size-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
                .izn-size{border:1.5px solid var(--iz-bd-2);border-radius:var(--iz-r-sm);background:var(--iz-bg-3);padding:8px 6px 6px;
                  cursor:pointer;font-family:inherit;transition:.18s cubic-bezier(.16,1,.3,1)}
                .izn-size:hover{border-color:var(--iz-accent-line);transform:translateY(-1.5px)}
                .izn-size.on{border-color:var(--iz-accent)!important;background:var(--iz-blue-tint)!important;box-shadow:0 4px 12px -7px var(--iz-accent-line)}
                .izn-size .sz-view{position:relative;display:block;height:46px;border-radius:6px;background:var(--iz-bg-5);
                  border:1px dashed var(--iz-bd-2);margin-bottom:5px;overflow:hidden}
                .izn-size .sz-box{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:var(--s);height:var(--sh);
                  border-radius:4px;background:linear-gradient(135deg,#9dbfe6,#c6d8ee);box-shadow:0 2px 6px -3px rgba(15,23,42,.35);transition:.2s}
                .izn-size.on .sz-box{background:linear-gradient(135deg,#6f9fda,#a8c8ec)!important}
                .izn-size .sz-name{display:block;text-align:center;font-size:11.5px;font-weight:650;color:var(--iz-tx-2)}
                .izn-size.on .sz-name{color:var(--iz-accent-deep)!important}
                @media (max-width:900px){
                  .izn-mode-grid{grid-template-columns:1fr}
                  .izn-size-grid{grid-template-columns:repeat(2,1fr)}
                }
                /* 尊重系统「减少动态效果」：演示动画停止在中间帧，仍能看出静态差异 */
                @media (prefers-reduced-motion: reduce){
                  .izn-demo .d-preview{animation:none!important;opacity:1;transform:none}
                }
                /* ===== 视图切换：淡入 + 上移 8px，给出方向感与连续性 ===== */
                .izn-view.on{display:block;animation:izViewIn .3s cubic-bezier(.16,1,.3,1)}
                @keyframes izViewIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
                /* ===== 尊重系统「减少动态效果」偏好 ===== */
                @media (prefers-reduced-motion: reduce){
                  .izn-view.on,.iz-param-item.mod::before,.iz-param-num.pop,.iz-collapse-body{animation:none!important}
                  .iz-slider::-webkit-slider-thumb,.iz-seg button,.iz-toggle,.iz-toggle .iz-knob{transition:none!important}
                }
                .iz-panel-footer{padding:14px 28px 20px 28px;border-top:1px solid var(--iz-bd-1);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background-color:var(--iz-bg-2);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
                .iz-btn-ghost{background:none;border:none;padding:8px 14px;font-size:13px;font-weight:500;color:var(--iz-tx-muted);cursor:pointer;border-radius:var(--iz-r-sm);transition:all .2s}
                .iz-btn-ghost:hover{background:var(--iz-bg-5);color:var(--iz-tx-1)}
                .iz-btn-ghost:focus-visible{outline:2px solid var(--iz-accent);outline-offset:2px}
                .iz-btn-ghost:active{transform:scale(.96)}
                .iz-btn-danger-ghost{background:none;border:none;padding:8px 14px;font-size:13px;font-weight:500;color:var(--iz-tx-muted);cursor:pointer;border-radius:var(--iz-r-sm);transition:all .2s}
                .iz-btn-danger-ghost:hover{background:var(--iz-danger-soft);color:var(--iz-danger)}
                .iz-btn-danger-ghost:focus-visible{outline:2px solid var(--iz-danger);outline-offset:2px}
                .iz-btn-danger-ghost:active{transform:scale(.96)}
                .iz-btn-primary-solid{padding:10px 28px;background:var(--iz-grad);border:none;border-radius:var(--iz-r-md);font-size:14px;font-weight:600;color:#fff;cursor:pointer;transition:all .25s;box-shadow:0 4px 16px rgba(79,70,229,.3)}
                .iz-btn-primary-solid:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(79,70,229,.4)}
                .iz-btn-primary-solid:active{transform:scale(.96)}
                .iz-btn-primary-solid:focus-visible{outline:2px solid var(--iz-accent);outline-offset:3px}
                .iz-rule-input{width:100%;box-sizing:border-box;height:36px;padding:0 10px;border:1.5px solid var(--iz-bd-2);border-radius:var(--iz-r-sm);outline:none;font-size:13px;background-color:var(--iz-bg-3);color:var(--iz-tx-1);transition:all .2s;font-family:inherit}
                .iz-rule-input:focus{border-color:var(--iz-accent);box-shadow:0 0 0 3px var(--iz-accent-soft)}
                #izIntroOverlay{position:fixed;inset:0;z-index:100010;display:none;align-items:center;justify-content:center;padding:24px;background:var(--iz-overlay);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);pointer-events:auto}
                #izIntroPanel{pointer-events:auto}
                #izUpdateNotice{position:fixed;top:22px;right:22px;width:min(360px,calc(100vw - 44px));z-index:100011;display:none;background:var(--iz-bg-1);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-lg);box-shadow:var(--iz-shadow),0 0 0 1px var(--iz-inset-ring) inset;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box;pointer-events:auto;color:var(--iz-tx-1)}
                #izUpdateNotice.anim-in{animation:izUpdateSlide .35s cubic-bezier(.16,1,.3,1)}
                #izUpdateNotice.anim-out{animation:izUpdateFadeOut .25s ease forwards}
                #izUpdateNotice .iz-update-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px 18px}
                #izUpdateNotice .iz-update-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;color:var(--iz-tx-1)}
                #izUpdateNotice .iz-update-icon{width:30px;height:30px;border-radius:var(--iz-r-sm);background:var(--iz-grad);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;box-shadow:0 4px 12px rgba(79,70,229,.22)}
                #izUpdateNotice .iz-update-version{font-size:11px;font-weight:600;color:var(--iz-accent);background:var(--iz-accent-soft);padding:4px 8px;border-radius:999px}
                #izUpdateNotice .iz-update-close{width:28px;height:28px;border:none;background:var(--iz-bg-5);border-radius:50%;cursor:pointer;font-size:15px;color:var(--iz-tx-muted);display:flex;align-items:center;justify-content:center;line-height:1}
                #izUpdateNotice .iz-update-close:hover{background:var(--iz-danger-soft);color:var(--iz-danger)}
                #izUpdateNotice .iz-update-body{padding:0 18px 14px 18px;font-size:12.5px;line-height:1.75;color:var(--iz-tx-muted)}
                #izUpdateNotice .iz-update-item{padding:8px 10px;background:var(--iz-bg-4);border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-sm);margin-top:7px}
                #izUpdateNotice .iz-update-item:first-child{margin-top:0}
                #izUpdateNotice .iz-update-footer{display:flex;justify-content:flex-end;padding:12px 18px 14px;border-top:1px solid var(--iz-bd-1);background:var(--iz-bg-2)}
                #izUpdateNotice .iz-update-ok{padding:8px 16px;font-size:12px;border-radius:var(--iz-r-sm)}
                @keyframes izUpdateSlide{from{opacity:0;transform:translateY(-12px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
                @keyframes izUpdateFadeOut{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-8px)}}
                #izIntroOverlay.anim-in{animation:izOverlayFade .35s ease}
                #izIntroOverlay.anim-out{animation:izOverlayFadeOut .3s ease forwards}
                #izIntroPanel{width:100%;max-width:560px;max-height:90vh;background:var(--iz-bg-1);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:var(--iz-r-xl);box-shadow:var(--iz-shadow),0 0 0 1px var(--iz-inset-ring) inset;overflow:hidden;animation:izPanelSlide .40s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box;color:var(--iz-tx-1)}
                .iz-intro-scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 28px 20px 28px}
                .iz-intro-lead{margin-top:18px;padding:14px 16px;background:var(--iz-lead-bg);border:1px solid var(--iz-lead-bd);border-radius:var(--iz-r-lg);font-size:13px;line-height:1.75;color:var(--iz-tx-muted)}
                .iz-intro-item{margin-top:12px;padding:14px 16px;background:var(--iz-bg-4);border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-md)}
                .iz-intro-item-title{font-size:14px;font-weight:600;color:var(--iz-tx-2);margin-bottom:5px;display:flex;align-items:center;gap:7px}
                .iz-intro-item-text{font-size:12.5px;line-height:1.75;color:var(--iz-tx-muted)}
                .iz-intro-footer{padding:14px 28px 20px 28px;border-top:1px solid var(--iz-bd-1);display:flex;justify-content:flex-end;align-items:center;flex-shrink:0;background-color:var(--iz-bg-2);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
                .iz-intro-ok{min-width:118px}
                @media (max-width:600px){#izIntroPanel{border-radius:var(--iz-r-lg);max-height:95vh}.iz-intro-scroll{padding:0 18px 16px}.iz-intro-footer{padding:12px 18px 16px}.iz-intro-ok{width:100%}}
                @media (max-width:600px){#izUpdateNotice{top:12px;right:12px;width:calc(100vw - 24px);border-radius:var(--iz-r-lg)}}
                @media (max-width:600px){#izConfigPanel{border-radius:var(--iz-r-lg);max-height:95vh}.iz-panel-scroll{padding:0 18px 8px 18px}.iz-panel-header{padding:16px 18px 0 18px}.iz-panel-footer{padding:12px 18px 16px 18px;flex-wrap:wrap;gap:10px}.iz-row{flex-direction:column;align-items:stretch;gap:6px}.iz-param-grid{grid-template-columns:1fr}.iz-param-sections{grid-template-columns:1fr}.iz-top-grid{grid-template-columns:1fr}.iz-switch-grid{grid-template-columns:1fr}.iz-panel-title{font-size:17px}.iz-panel-icon{width:34px;height:34px;font-size:17px}}
                @media (prefers-reduced-motion:reduce){
                  #izConfigPanel,#izIntroPanel,#izUpdateNotice,#izModalOverlay,#izIntroOverlay,.iz-toggle,.iz-toggle .iz-knob,.iz-collapse-body,.iz-collapse-header .iz-arrow,.iz-switch-card,.iz-btn-sm,.iz-btn-primary-solid{animation:none!important;transition:none!important}
                  .iz-panel-scroll{scroll-behavior:auto}
                }
                /* ==========================================================================
                   ★ 兼容性修复：定制浏览器给 <button> 注入高特异性默认背景
                   实测 ego lite 0.5.0.33 把裸 <button> 的 background-color 设成 #1a73e8，
                   且该规则特异性高于单类选择器（如 .izn-place），会盖掉面板里所有按钮
                   底色 —— 表现为导航项、图示卡、尺寸块、底部按钮全被刷成蓝色
                   （只有 .xxx.on 这类双类选择器侥幸存活，所以现象是「全蓝」）。
                   对策：① 先用 #izConfigPanel button 清空默认底色（特异性 1,0,1）；
                        ② 需要底色的规则再加一层类前缀重新声明（1,x,0 稳赢）。
                   ========================================================================== */
                #izConfigPanel button{background-color:transparent;background-image:none}
                #izConfigPanel .izn-nav-item{background:none}
                #izConfigPanel .izn-nav-item:hover{background:var(--iz-blue-tint-2)}
                #izConfigPanel .izn-nav-item.on{background:var(--iz-accent)!important;border-color:var(--iz-accent)!important;color:#fff!important}
                #izConfigPanel .izn-nav-item.on .izn-tag{background:rgba(255,255,255,.26)!important;color:#fff!important}
                #izConfigPanel .izn-place{background:var(--iz-bg-3)}
                #izConfigPanel .izn-place.on{background:var(--iz-blue-tint)!important;border-color:var(--iz-accent)!important}
                #izConfigPanel .izn-mode{background:var(--iz-bg-3)}
                #izConfigPanel .izn-mode.on{background:var(--iz-blue-tint)!important;border-color:var(--iz-accent)!important}
                #izConfigPanel .izn-size{background:var(--iz-bg-3)}
                #izConfigPanel .izn-size.on{background:var(--iz-blue-tint)!important;border-color:var(--iz-accent)!important}
                #izConfigPanel .iz-seg button{background:none}
                #izConfigPanel .iz-seg button.on{background:var(--iz-bg-3)!important;color:var(--iz-accent)!important}
                #izConfigPanel .iz-close-btn{background:var(--iz-bg-5)}
                #izConfigPanel .iz-close-btn:hover{background:var(--iz-danger-soft)}
                #izConfigPanel .iz-key-cap{background:var(--iz-bg-2)}
                #izConfigPanel .iz-key-cap:hover{background:var(--iz-hover-bg)}
                #izConfigPanel .iz-key-cap.recording{background:var(--iz-accent)}
                #izConfigPanel .iz-btn-sm.primary{background:var(--iz-accent-solid);color:#fff}
                #izConfigPanel .iz-btn-sm.warning{background:var(--iz-warn-bg);color:var(--iz-warn-tx)}
                #izConfigPanel .iz-btn-ghost{background:none}
                #izConfigPanel .iz-btn-ghost:hover{background:var(--iz-bg-5)}
                #izConfigPanel .iz-btn-danger-ghost{background:none}
                #izConfigPanel .iz-btn-danger-ghost:hover{background:var(--iz-danger-soft)}
                #izConfigPanel .iz-btn-primary-solid{background:var(--iz-grad);color:#fff}
                /* ==========================================================================
                   ★ 防「站点样式泄漏」：面板是挂在宿主页面 body 里的，站点给裸语义元素写的
                   背景/边框/阴影会直接命中面板里的 <b>/<summary> 等 —— 面板自己没声明这些属性，
                   所以站点一条特异性仅 0,0,1 的规则（如 b{background:#f59e0b}）就能赢，
                   表现为「面板里的标题/小节名被刷上一层底色」（2026-09-19 反馈：橙色底）。
                   对策：用 :is(#id…) 前缀把特异性提到 1,0,1，稳定压过站点规则。
                   注意：只覆盖面板「从不设底色」的元素；<kbd>（要品牌色底）、<p class="izn-hnew">、
                   <summary>（有自己的 hover 底色）都不放进这个通配重置里。
                   ========================================================================== */
                :is(#izModalOverlay,#izHelpModal,#izIntroPanel,#izUpdateNotice) :is(
                  b,strong,em,i,u,s,small,mark,code,time,cite,q,abbr,sub,sup,hr,
                  h1,h2,h3,h4,h5,h6,ul,ol,li,dl,dt,dd,blockquote,pre,figure,figcaption){
                  background-color:transparent!important;background-image:none!important;
                  box-shadow:none!important;text-shadow:none!important;
                  border-top:0!important;border-right:0!important;border-bottom:0!important;border-left:0!important
                }
                /* ② 自身有底色（或需要 hover 底色）的元素：只补一句 transparent。
                      必须同时加 !important —— 站点若写 summary{background:…!important}，
                      不加 important 的话普通规则会被直接压掉（实测踩到）。
                      特异性仍保持较低（0,1,x）：站点裸元素规则（0,0,1）压得住，
                      而 .iz-adv>summary:hover（0,2,1，同样 !important）比特异性赢 → hover 反馈存活。 */
                .izn-vsub,.izn-content summary,.iz-adv>summary{background-color:transparent!important;background-image:none!important}
                /* ③ 短类名撞车防御（2026-09-20 dlsjs.net 实机定位，这才是哥哥报的「橙色底」真凶）
                      面板用了 .pn/.pd/.q/.a/.v/.d/.t/.flex/.note/.ver 这类「无命名空间短类名」，
                      站点只要有一条同名 class 规则就会给面板元素刷底色：
                      实例 dlsjs.net 有 .pn{background:rgb(243,154,7)}（橙 #f39a07），
                      命中 7 个 <span class="pn"> —— 正是「放大模式 / 大图出现在哪 / 出现方式」
                      三组图示卡的标题块。这些元素我们从不声明 background → 无竞争 → 站点直接生效。
                      对策：复用「原规则同款选择器」+ !important —— 特异性 (0,2,0)!important 压过
                      站点的 .pn 与 .pn{…!important}（0,1,0）；**刻意不扩大选择器**，
                      否则会误伤同族里有背景的规则（例：给 .iz-btn-sm 加透明会连 .iz-btn-sm.primary
                      的背景一起压掉）。
                      维护：面板新增元素若用「无前缀短类名」且不给背景，须追加到下面这行。 */
                .izn-place .pn,.izn-place .pd,.izn-mode .pn,.izn-mode .pd,
                .izn-diag .q,.izn-diag .a,.izn-row .t,.izn-row .d,
                .izn-hverline .v,.izn-hverline .d,
                .izn-status .flex,.izn-lock .flex,.izn-status .note,.izn-hfoot .ver,
                .izn-size .sz-name,.izn-sect-h .izn-hint,.izn-view.on,.iz-arrow.open
                {background-color:transparent!important;background-image:none!important}
            `;
            document.head.appendChild(s);
            dockStyleElement = s;
        }

        if (styleElement) return;
        const style = document.createElement('style');
        style.textContent = `
            .image-zoom-container img{object-fit:contain}
            #hoverWaitIndicator{position:fixed;left:0;top:0;width:20px;height:14px;transform:translate(-50%,-50%);z-index:2147483646;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .14s ease,visibility .14s ease;filter:drop-shadow(0 1px 5px rgba(0,0,0,.28))}
            #hoverWaitIndicator.show{opacity:1;visibility:visible}
            #hoverWaitIndicator i{position:absolute;top:50%;width:4px;height:4px;margin-top:-2px;border-radius:50%;background:rgba(255,255,255,.98);box-shadow:0 0 6px rgba(125,211,252,.95),0 0 10px rgba(125,211,252,.38);animation:hoverWaitFocus 1s cubic-bezier(.45,0,.55,1) infinite}
            #hoverWaitIndicator i:nth-child(1){left:1px;animation-delay:0s}
            #hoverWaitIndicator i:nth-child(2){left:8px;width:5px;height:5px;margin-top:-2.5px;animation-delay:.14s}
            #hoverWaitIndicator i:nth-child(3){left:15px;animation-delay:.28s}
            @keyframes hoverWaitFocus{0%,100%{transform:translateY(1px) scale(.72);opacity:.42}38%{transform:translateY(-1px) scale(1.12);opacity:1}58%{transform:translateY(0) scale(.9);opacity:.82}}
            /* 保留网页原本的鼠标光标，不由脚本覆盖 */
        `;
        document.head.appendChild(style);
        styleElement = style;
    }

    // 全局样式注入



    let toggleButton = null, gearButton = null, dockZone = null, dockTip = null, settingsTip = null;

    function createDockButton() {
        // 防御性去重：万一仍走到这里两次，先清掉旧的，避免出现两个控制球
        const stale = document.getElementById('zoomDockZone');
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
        dockZone = document.createElement('div');
        dockZone.id = 'zoomDockZone';

        toggleButton = document.createElement('div');
        toggleButton.id = 'zoomDock';
        toggleButton.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16" y1="16" x2="21" y2="21"/></svg><span id="statusDot"></span>`;
        toggleButton.title = '点击：切换图片放大';

        gearButton = document.createElement('div');
        gearButton.id = 'zoomSettings';
        gearButton.innerHTML = `<svg class="icon-svg--gear" viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
        gearButton.title = '打开配置面板';

        dockZone.appendChild(toggleButton);
        dockZone.appendChild(gearButton);

        dockTip = document.createElement('div');
        dockTip.className = 'zoom-bubble-tip';
        settingsTip = document.createElement('div');
        settingsTip.className = 'zoom-bubble-tip';
        settingsTip.textContent = '配置面板';

        document.body.appendChild(dockZone);
        document.body.appendChild(dockTip);
        document.body.appendChild(settingsTip);

        const savedTop = storageGet(`image_zoom_dock_top_${currentDomain}`);
        if (savedTop !== undefined && savedTop !== null) {
            dockZone.style.transform = 'none';
            dockZone.style.top = savedTop + 'px';
        }

        let leaveTimer = null;

        function positionTips() {
            const dr = toggleButton.getBoundingClientRect(), gr = gearButton.getBoundingClientRect();
            dockTip.style.top = (dr.top + dr.height / 2) + 'px';
            dockTip.style.right = (window.innerWidth - dr.left + 8) + 'px';
            dockTip.style.transform = 'translateY(-50%)';
            dockTip.classList.add('visible');
            settingsTip.style.top = (gr.top + gr.height / 2) + 'px';
            settingsTip.style.right = (window.innerWidth - gr.left + 8) + 'px';
            settingsTip.style.transform = 'translateY(-50%)';
            settingsTip.classList.add('visible');
        }

        function hideTips() {
            dockTip.classList.remove('visible');
            settingsTip.classList.remove('visible');
        }

        function updateTipText() {
            if (isHomepageZoomDisabled()) dockTip.innerHTML = '主页已禁用图片放大 <span style="opacity:.5">设置中可开启</span>';
            else if (!isEnabled) dockTip.innerHTML = '图片放大已关闭 <span style="opacity:.4">点击开启</span>';
            else dockTip.innerHTML = '图片放大已开启 <span style="opacity:.4">点击关闭</span>';
        }

        toggleButton.addEventListener('mouseenter', () => {
            clearTimeout(leaveTimer);
            dockZone.classList.add('open');
            updateTipText();
            positionTips();
            setTimeout(positionTips, 320);
        });
        dockZone.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
        dockZone.addEventListener('mouseleave', () => {
            leaveTimer = setTimeout(() => {
                if (dockZone.matches(':hover')) return;
                dockZone.classList.remove('open');
                hideTips();
            }, 200);
        });

        toggleButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isHomepageZoomDisabled()) {
                showToast('当前网站主页已禁用图片放大，可在设置面板中开启');
                return;
            }
            toggleEnabled();
            updateTipText();
        });

        gearButton.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleConfigPanel();
        });

        // 拖拽（区分点击与拖动）
        (function() {
            let isDragging = false, hasMoved = false, startY = 0, startTop = 0, dragJustEnded = false;
            const THRESHOLD = 3;
            const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

            function syncY(topPx) {
                dockZone.style.top = clamp(topPx, 0, window.innerHeight - toggleButton.offsetHeight) + 'px';
            }

            toggleButton.addEventListener('click', function(e) {
                if (dragJustEnded) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    dragJustEnded = false;
                }
            }, true);

            toggleButton.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                isDragging = true;
                hasMoved = false;
                startY = e.clientY;
                startTop = dockZone.getBoundingClientRect().top;
                e.preventDefault();
            });

            document.addEventListener('mousemove', function(e) {
                if (!isDragging) return;
                const delta = e.clientY - startY;
                if (!hasMoved && Math.abs(delta) > THRESHOLD) {
                    hasMoved = true;
                    document.body.classList.add('zoom-dock-dragging');
                }
                if (hasMoved) syncY(startTop + delta);
            });

            document.addEventListener('mouseup', function() {
                if (!isDragging) return;
                isDragging = false;
                document.body.classList.remove('zoom-dock-dragging');
                if (hasMoved) {
                    dockZone.style.transform = 'none';
                    storageSet(`image_zoom_dock_top_${currentDomain}`, parseFloat(dockZone.style.top) || 0);
                    dragJustEnded = true;
                    setTimeout(() => { dragJustEnded = false; }, 50);
                }
            });
        })();

        updateButtonState();
    }


    // ★ Dock 悬浮控制区

    // ----- 配置面板 -----
    // ================
    function updateButtonState() {
        if (!toggleButton) return;
        if (isHomepageZoomDisabled()) {
            toggleButton.classList.remove('off');
            toggleButton.classList.add('hp');
        } else if (!isEnabled) {
            toggleButton.classList.remove('hp');
            toggleButton.classList.add('off');
        } else {
            toggleButton.classList.remove('off', 'hp');
        }
    }

    function toggleEnabled() {
        isEnabled = !isEnabled;
        storageSet(`image_zoom_enabled_${currentDomain}`, isEnabled);
        updateButtonState();
        // 面板若开着，总开关显示要跟着变（否则两处状态会不一致）
        try {
            const ov = document.getElementById('izModalOverlay');
            if (ov && ov.__iznSync) ov.__iznSync();
        } catch (err) { }
        if (isEnabled) {
            injectStyles();
            initImages();
        } else {
            zoomFSM.dispatch('RESET');
            bgZoomLayer.hide();
        }
    }

    function toggleHomepageDisabled() {
        const disabled = !isHomepageDisabled();
        storageSet(`image_zoom_homepage_disabled_${currentDomain}`, disabled);
        if (disabled && isHomepage() && isEnabled) {
            zoomFSM.dispatch('RESET');
            bgZoomLayer.hide();
        }
        showToast(disabled ? '已禁用当前网站主页的图片放大功能' : '已启用当前网站主页的图片放大功能');
        updateButtonState();
        refreshPanelHomepageSection();
    }

    function refreshPanelHomepageSection() {
        const overlay = document.getElementById('izModalOverlay');
        if (!overlay) return;
        const disabled = isHomepageDisabled();
        const dot = overlay.querySelector('#izHpDot'), txt = overlay.querySelector('#izHpText'), btn = overlay.querySelector('#izHpToggleBtn');
        if (dot) dot.className = disabled ? 'iz-dot off' : 'iz-dot on';
        if (txt) txt.textContent = disabled ? '当前主页已禁用图片放大' : '当前主页已启用图片放大';
        if (btn) {
            btn.textContent = disabled ? '启用主页图片放大功能' : '禁用主页图片放大功能';
            btn.className = disabled ? 'iz-btn-sm primary' : 'iz-btn-sm warning';
        }
    }


    // ================
    // ★ 弹层滚轮陷阱：面板 / 弹窗打开时，滚轮只在弹层内部的可滚动区域生效。
    //   —— 落在非滚动区域、或内部已滚到上/下边界时一律丢弃，
    //   避免「滚轮穿透」把背后的网页一起滚走（2026-09-19 反馈 bug）。
    //   —— 预览激活（图片缩放 / 视频预览）时直接放行，交给预览自己的滚轮逻辑。
    // ================
    function bindWheelTrap(el) {
        if (!el || el.__izWheelTrap) return;
        el.__izWheelTrap = true;
        el.addEventListener('wheel', function (e) {
            try {
                if (zoomFSM && zoomFSM.hasActiveZoom && zoomFSM.hasActiveZoom()) return;
                if (videoPreviewModule && videoPreviewModule.isActive && videoPreviewModule.isActive()) return;
            } catch (err) { }
            let node = e.target;
            while (node && node !== el && node.nodeType === 1) {
                const oy = getComputedStyle(node).overflowY;
                if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                    node.scrollHeight > node.clientHeight + 1) {
                    const atTop = node.scrollTop <= 0;
                    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
                    // 内部还有可滚空间 → 正常滚，不拦
                    if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;
                    break; // 已到边界 → 拦掉，防止连锁滚到底层页面
                }
                node = node.parentElement;
            }
            try { e.preventDefault(); e.stopPropagation(); } catch (err) { }
        }, { passive: false });
    }

    // ================
    // ★ 首次使用说明（全局仅显示一次，不按域名保存）
    // ================
    const INTRO_SEEN_KEY = 'image_zoom_intro_seen';

    function showIntroPanel(force = false) {
        let overlay = document.getElementById('izIntroOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'izIntroOverlay';
            overlay.innerHTML = `
                <div id="izIntroPanel">
                    <div class="iz-panel-header">
                        <div class="iz-panel-header-left">
                            <div class="iz-panel-icon">🔍</div>
                            <div class="iz-panel-title">欢迎使用<span>· 图片悬停放大</span></div>
                        </div>
                        <button class="iz-close-btn" id="izIntroClose" title="关闭">✕</button>
                    </div>
                    <div class="iz-intro-scroll">
                        <div class="iz-intro-lead">装好就能用：把鼠标停在网页图片上，稍停一下，大图自动弹出。不用点击，也不用离开当前页面。</div>

                        <div class="iz-intro-item">
                            <div class="iz-intro-item-title">🖱️ 基本用法</div>
                            <div class="iz-intro-item-text">悬停图片 → 自动放大；移开鼠标即收起。预览时滚轮可缩放，图集页面用 ← → 翻页，按 z 可把整组图打包下载。右下角悬浮球随时开关本站功能。</div>
                        </div>

                        <div class="iz-intro-item">
                            <div class="iz-intro-item-title">⌨️ 常用快捷键（预览显示时按）</div>
                            <div class="iz-intro-item-text">s 保存高清图 · c 复制图片地址 · r 旋转 · R 水平翻转 · f 全屏 · 0 重置大小 · Esc 关闭。都能在设置的「键位」里改成顺手的键。</div>
                        </div>

                        <div class="iz-intro-item">
                            <div class="iz-intro-item-title">❓ 图没反应？三步排查</div>
                            <div class="iz-intro-item-text">① 看右下角悬浮球是否已开启；② 太小的图（图标、按钮）会被自动跳过，属正常；③ 只有个别网站不行？打开设置用「帮我找大图」点一下那张图，按提示加条规则，再刷新页面即可。</div>
                        </div>

                    </div>
                    <div class="iz-intro-footer">
                        <button class="iz-btn-primary-solid iz-intro-ok" id="izIntroOk">知道了，开始使用</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            bindWheelTrap(overlay);

            const close = () => {
                storageSet(INTRO_SEEN_KEY, true);
                overlay.classList.add('anim-out');
                setTimeout(() => {
                    overlay.style.display = 'none';
                    overlay.classList.remove('anim-out');
                }, 300);
            };
            overlay.querySelector('#izIntroClose').addEventListener('click', close);
            overlay.querySelector('#izIntroOk').addEventListener('click', close);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close();
            });
            overlay._izClose = close;
        }

        if (!force && storageGet(INTRO_SEEN_KEY, false)) return;
        // 自动首次显示时立即记为已展示；手动从设置打开时不改变全局已读状态。
        if (!force) storageSet(INTRO_SEEN_KEY, true);
        overlay.classList.remove('anim-out');
        overlay.classList.add('anim-in');
        overlay.style.display = 'flex';
        setTimeout(() => overlay.classList.remove('anim-in'), 400);
    }

    // ================
    // ★ 更新说明（全局按版本仅显示一次，不按域名保存）
    // ================
    const UPDATE_VERSION = (typeof SCRIPT_VERSION !== 'undefined' && SCRIPT_VERSION) ? SCRIPT_VERSION : '5.6.26';
    const UPDATE_SEEN_KEY = `image_zoom_update_seen_${UPDATE_VERSION}`;

    // ★ 使用说明 / 更新说明 弹窗（蓝色主题；内容与脚本实际行为一致）
    function showHelpModal(tab) {
        let mask = document.getElementById('izHelpModal');
        if (!mask) {
            mask = document.createElement('div');
            mask.id = 'izHelpModal';
            mask.innerHTML = `
                <div class="izn-hmodal" role="dialog" aria-label="使用说明与更新说明">
                    <div class="izn-hhead">
                        <div class="izn-hmark">?</div>
                        <div class="izn-htabs" role="tablist">
                            <button role="tab" class="on" data-tab="usage">📘 使用说明</button>
                            <button role="tab" data-tab="changelog">📋 更新说明</button>
                        </div>
                        <button class="izn-hclose" title="关闭（Esc）">✕</button>
                    </div>
                    <div class="izn-hbody">
                        <div class="izn-htab on" data-tab="usage">
                            <div class="izn-hgroup"><h4>基本玩法</h4><ul>
                                <li>鼠标<b>悬停任意图片</b>，停留片刻即放大预览；<b>滚轮</b>缩放（或上下平移），<b>拖拽</b>查看细节。</li>
                                <li>页面右下角的<b>控制球</b>随时开/关本站放大，也能打开设置面板。</li>
                                <li>面板里的设置<b>只对当前网站生效</b>——每个网站一套，互不干扰。</li>
                            </ul></div>
                            <div class="izn-hgroup"><h4>动作快捷键（预览显示时）</h4><ul>
                                <li><kbd>s</kbd> 保存高清图 · <kbd>c</kbd> 复制图片地址 · <kbd>Shift</kbd>+<kbd>C</kbd> 复制图片本体</li>
                                <li><kbd>r</kbd> 旋转 90° · <kbd>Shift</kbd>+<kbd>R</kbd> 水平翻转 · <kbd>f</kbd> 全屏 · <kbd>0</kbd> 重置缩放</li>
                                <li>图集里：<kbd>←</kbd> <kbd>→</kbd> 翻页 · <kbd>z</kbd> 整组打包成 ZIP 下载 · <kbd>Esc</kbd> 关闭预览</li>
                            </ul></div>
                            <div class="izn-hgroup"><h4>看得更清楚</h4><ul>
                                <li>很多站的缩略图自带更大的原图，脚本会<b>自动升级</b>；升不了的站，用「图片规则 → 帮我找大图」点一下那张图试试。</li>
                                <li>想换放大后的观感与位置：去「显示与样式」调放大模式与显示位置。</li>
                            </ul></div>
                            <div class="izn-hgroup"><h4>图悬停没反应？</h4><ul>
                                <li>常见原因是页面<b>遮罩挡住了鼠标</b>，或图片是<b>背景图</b>——去「站点适配」点一下那张图，加条规则即可。</li>
                                <li>站首页不想启用：在「总览」开「主页不启用」，内容页不受影响。</li>
                            </ul></div>
                        </div>
                        <div class="izn-htab" data-tab="changelog">
                            <div class="izn-hverline"><span class="v">${UPDATE_VERSION}</span><span class="d">${/test/i.test(UPDATE_VERSION) ? '测试版' : '正式版'}</span><span class="iz-badge ok" style="margin-left:auto">🔒 规则包已验签</span></div>
                            <p class="izn-hnew">本次更新：<b>全新配置面板</b> · <b>视频悬停预览</b> · <b>图集翻页与打包</b> · <b>历史记录 / 键位自定义</b> · <b>三层换图规则</b>；另含显示位置两模式与重采样分级。</p>
                            <div class="izn-hgroup"><h4>新功能</h4><ul>
                                <li><b>全新配置面板</b>：左侧 8 分区导航，图示化选择（放大模式 / 尺寸 / 位置 / 动画一眼对比），改动自动保存。</li>
                                <li><b>视频悬停预览</b>：悬停页面视频或 B站 / YouTube 卡片即静音浮出播放，<b>←/→</b> 快退快进。</li>
                                <li><b>图集翻页与打包</b>：同一组图片 <b>←/→</b> 翻页，按 <b>z</b> 打包 ZIP；放大图下方显示尺寸、格式、来源与图说。</li>
                                <li><b>显示位置两模式</b>：屏幕居中 / 原图周围不遮挡（「显示与样式」里切换）。</li>
                                <li><b>历史记录</b>：最近看过的图可回看、打开原图、复制地址（只存本机）。</li>
                                <li><b>键位自定义</b>：点键帽改绑，冲突自动让出；一键恢复默认。</li>
                                <li><b>配置备份与恢复</b>：导出 / 导入 JSON，换设备或重装后一键还原。</li>
                            </ul></div>
                            <div class="izn-hgroup"><h4>规则与安全</h4><ul>
                                <li><b>三层换图规则</b>：我的规则 → 云端规则包 → 内置兜底，命中即停；「点图选图」自动生成规则，遮罩层 / 背景图也能放大。</li>
                                <li><b>规则包签名校验</b>：云端规则带签名与逐站哈希校验，被篡改即拒用。</li>
                                <li><b>网页版规则中心</b>：ydgg123.github.io/hover-image-zoom/rules.html 可在线浏览全部站点规则。</li>
                                <li><b>一键提交规则到官方</b>：规则导出后自动填好 Issue 内容。</li>
                            </ul></div>
                            <div class="izn-hgroup"><h4>修复与优化</h4><ul>
                                <li>低分辨率图高倍放大不再出现<b>马赛克</b>（重采样按倍率分级）。</li>
                                <li>「原图周围」模式下大图<b>不遮挡原图</b>；宽屏自适应放大<b>不再偏小</b>（默认上限跟随视口）。</li>
                                <li>旋转 / 翻转后外壳框<b>跟随旋转</b>；深层嵌套（如表格化）<b>图集不再漏识别</b>。</li>
                                <li>面板文字与选中态<b>不再被站点样式染色</b>；404 / 死链不再出现空白框。</li>
                                <li>防盗链图片自动绕过；智能高清升级按需选档，省流量。</li>
                            </ul></div>
                        </div>
                    </div>
                    <div class="izn-hfoot">
                        <span class="ver">HoverVista · 设置只保存在本机</span>
                        <button class="iz-btn-sm" id="izHelpGoRules">去管理规则</button>
                        <button class="iz-btn-sm primary" id="izHelpOk">知道了</button>
                    </div>
                </div>`;
            document.body.appendChild(mask);
            bindWheelTrap(mask);
            mask.addEventListener('click', (e) => { if (e.target === mask) mask.classList.remove('open'); });
            mask.querySelector('.izn-hclose').addEventListener('click', () => mask.classList.remove('open'));
            mask.querySelector('#izHelpOk').addEventListener('click', () => mask.classList.remove('open'));
            mask.querySelector('#izHelpGoRules').addEventListener('click', () => { mask.classList.remove('open'); toggleConfigPanel(); });
            mask.querySelectorAll('.izn-htabs button').forEach(b => b.addEventListener('click', () => {
                mask.querySelectorAll('.izn-htabs button').forEach(x => x.classList.toggle('on', x === b));
                mask.querySelectorAll('.izn-htab').forEach(p => p.classList.toggle('on', p.dataset.tab === b.dataset.tab));
            }));
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mask.classList.contains('open')) mask.classList.remove('open'); });
        }
        mask.querySelectorAll('.izn-htabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
        mask.querySelectorAll('.izn-htab').forEach(p => p.classList.toggle('on', p.dataset.tab === tab));
        mask.classList.add('open');
    }

    function showUpdateNotice() {
        if (storageGet(UPDATE_SEEN_KEY, false)) return;

        let notice = document.getElementById('izUpdateNotice');
        if (!notice) {
            notice = document.createElement('div');
            notice.id = 'izUpdateNotice';
            notice.innerHTML = `
                <div class="iz-update-head">
                    <div class="iz-update-title">
                        <div class="iz-update-icon">✨</div>
                        <div>版本更新说明</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="iz-update-version">v${UPDATE_VERSION}</span>
                        <button class="iz-update-close" id="izUpdateClose" title="关闭">✕</button>
                    </div>
                </div>
                <div class="iz-update-body">
                    <div class="iz-update-item">🎛️ 新增：<b>全新配置面板</b> —— 8 个分区、图示化选择（放大模式 / 尺寸 / 位置 / 动画一眼对比），改动自动保存。</div>
                    <div class="iz-update-item">▶️ 新增：<b>视频悬停预览</b> —— 悬停 B站 / YouTube 卡片或页面视频即静音浮出播放，<b>←/→</b> 快退快进。</div>
                    <div class="iz-update-item">🖼️ 新增：<b>图集翻页与打包</b> —— <b>←/→</b> 翻页、按 <b>z</b> 打包 ZIP；放大图下方还会显示尺寸、格式、来源与图说。</div>
                    <div class="iz-update-item">🕘 新增：<b>历史记录</b> + ⌨️ <b>键位自定义</b> —— 最近预览随时回看；13 个快捷键可视化改绑，可一键恢复默认。</div>
                    <div class="iz-update-item">💾 新增：<b>配置备份与恢复</b> —— 导出 / 导入 JSON，换设备一键还原全部站点设置。</div>
                    <div class="iz-update-item">🐛 修复：404 空框、占位图误触发、旋转后外框不跟转、面板被站点样式染色、滚轮误关预览等一批问题。另：本次新增 <b>GM_listValues</b> 权限。</div>
                </div>
                <div class="iz-update-footer">
                    <button class="iz-btn-primary-solid iz-update-ok" id="izUpdateOk">知道了</button>
                </div>`;
            document.body.appendChild(notice);

            const close = () => {
                storageSet(UPDATE_SEEN_KEY, true);
                notice.classList.add('anim-out');
                setTimeout(() => {
                    if (!notice) return;
                    notice.style.display = 'none';
                    notice.classList.remove('anim-out');
                }, 250);
            };
            notice.querySelector('#izUpdateClose').addEventListener('click', close);
            notice.querySelector('#izUpdateOk').addEventListener('click', close);
            notice._izClose = close;
        }

        storageSet(UPDATE_SEEN_KEY, true);
        notice.classList.remove('anim-out');
        notice.classList.add('anim-in');
        notice.style.display = 'block';
        setTimeout(() => notice.classList.remove('anim-in'), 400);
    }


    // 配置面板 UI
    // ================

    // ============================================================================
    // Config Panel UI module
    // 保留原有配置面板代码；不改运行行为。
    // ============================================================================

    const COMMON_PARAM_DEFS = [
        { key: 'delay', label: '停留多久才弹出', unit: 'ms', min: 0, max: 2000, step: 100, tip: '越小越灵敏，越大越不容易误触发。', zeroText: '立刻弹出' },
        { key: 'minOriginalSize', label: '太小的图不放大', unit: 'px', min: 0, max: 500, step: 5, tip: '图标、表情、按钮一般小于 100px。', zeroText: '不过滤' },
        { key: 'maxWidth', label: '大图最大宽度', unit: 'px', min: 300, max: 3000, step: 100, tip: '图片始终保持原始比例。', markText: '跟随视口' },
        { key: 'maxHeight', label: '大图最大高度', unit: 'px', min: 300, max: 3000, step: 100, tip: '与最大宽度一起限制大图的尺寸。', markText: '跟随视口' },
        { key: 'scrollSpeed', label: '滚轮平移距离', unit: 'px', min: 5, max: 50, step: 1, tip: '内容超出屏幕时，滚轮每次移动的距离。' }
    ];

    const FIXED_PARAM_DEFS = [
        { key: 'scale', label: '放大倍数', unit: '×', min: 1, max: 5, step: 0.1, tip: '相对原图的放大倍数。' },
        { key: 'minScale', label: '最小不小于', unit: '×', min: 1, max: 3, step: 0.1, tip: '再小也不会小于这个倍数。' },
        { key: 'smallImgThreshold', label: '多大的图算小图', unit: 'px', min: 100, max: 500, step: 10, tip: '显示尺寸小于这个值的，按小图处理。' },
        { key: 'smallImgWidth', label: '小图预览宽度', unit: 'px', min: 300, max: 1000, step: 10, tip: '小图放大后的宽度基准。' },
        { key: 'smallImgHeight', label: '小图预览高度', unit: 'px', min: 300, max: 1000, step: 10, tip: '小图放大后的高度基准。' }
    ];

    // ★ 「预览尺寸」四档：把原本要分别调的 maxWidth / maxHeight 合并成一个直观选择。
    //   仍写回原字段（不新增 config 键），所以导出格式与已有配置完全兼容。
    //   精确宽高仍在下方「高级」里以滑块保留，供需要单独控制的用户使用。
    //   ★ 2026-09-19：档位数值下调，拉开梯度。旧值「小=1000×800」在小视口下，
    //     高度上限（800）与「跟随视口」档（受视口高度限制）算出相近结果 —— 1280 视口
    //     实测「小」1000px vs「跟随视口」1037px 只差 37px，四档无可感知梯度（实机测试问题 4）。
    //     下调后「小」档高度上限 600 明显低于视口，梯度清晰。
    const SIZE_STEPS = [
        { w: 800, h: 600, name: '小' },
        { w: 1400, h: 1050, name: '中' },
        { w: 2200, h: 1650, name: '大' },
        { w: 3000, h: 3000, name: '跟随视口' }
    ];
    function sizeStepIndex() {
        for (let i = 0; i < SIZE_STEPS.length; i++) {
            if (config.maxWidth === SIZE_STEPS[i].w && config.maxHeight === SIZE_STEPS[i].h) return i;
        }
        return -1;   // 已用精确滑块自定义
    }
    // ★ 档位 → 占「视口可用空间」的比例。视口小于档位绝对尺寸时（小窗 / 竖屏 / 视口矮），
    //   若仍按 min(视口, 档位绝对尺寸) 取上限，中/大/跟随三档的目标高度（1050/1650/3000）
    //   会一起撞上同一个视口上限（如 694）→ 显示一样大、档位失去区分（横图尤其明显）。
    //   改为按档位比例分配视口空间：四档在任何视口下都有区分，且都受视口约束不超页。
    const STEP_VIEWPORT_SCALE = [0.55, 0.72, 0.88, 1.0];   // 小 / 中 / 大 / 跟随视口
    function stepViewportScale() {
        const i = sizeStepIndex();
        return i >= 0 ? STEP_VIEWPORT_SCALE[i] : 1.0;   // 自定义滑块 → 不缩档（用绝对尺寸）
    }

    // 参数保存提示已由 showToast / showSaveToast 统一路由到面板中央
    const notifyConfigSaved = debounce((key, value, label) => {
        showSaveToast(`已保存：${label || key} = ${value}`);
    }, 600);

    function injectCustomRulesSection(overlay) {
        const scroll = overlay.querySelector('#izSiteFitMount');
        if (!scroll || scroll.querySelector('#izCustomRulesSection')) return;
        const section = document.createElement('div');
        section.className = 'iz-section';
        section.id = 'izCustomRulesSection';

        const renderList = () => {
            const rules = getCustomRules();
            if (!rules.length) return '<div style="font-size:12px;color:var(--iz-tx-muted);padding:6px 0;line-height:1.6;">暂无自定义规则。</div>';
            return rules.map(r => `
                <div class="iz-rule-item" data-id="${r.id}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--iz-bd-1);">
                    <input type="checkbox" class="iz-rule-enabled" ${r.enabled ? 'checked' : ''} style="flex-shrink:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:600;color:var(--iz-tx-2);">${escapeHtml(r.name)} <span style="font-size:11px;color:var(--iz-tx-muted);font-weight:400;">· ${escapeHtml(r.domains)}</span></div>
                        <div style="font-size:11px;color:var(--iz-tx-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.imgMode === 'img' ? 'IMG' : '背景图'} | ${escapeHtml(r.itemSelector)} | ${escapeHtml(r.cardSelector || '无卡片选择器')}</div>
                    </div>
                    <button class="iz-rule-del" style="border:none;background:none;color:var(--iz-danger);cursor:pointer;font-size:16px;flex-shrink:0;" title="删除">✕</button>
                </div>`).join('');
        };

        section.innerHTML = `
            <div class="iz-section-title">🎯 高级：站点规则自定义 <span class="iz-badge">仅本地保存</span></div>
            <div class="iz-exclusion-note" style="margin-bottom:10px;">为当前网站添加悬停放大规则，解决遮罩层挡住鼠标、背景图无法放大等问题。保存后刷新页面生效。</div>
            <div id="izRuleList">${renderList()}</div>
            <button id="izRuleAddBtn" class="iz-btn-sm primary" style="margin-top:10px;">＋ 为当前网站添加规则</button>
            <div id="izRuleForm" style="display:none;margin-top:12px;padding:14px;background-color:var(--iz-bg-3);border-radius:var(--iz-r-md);border:1.5px solid var(--iz-bd-2);">
                <div class="iz-param-item" style="margin-bottom:10px;"><label>规则名称</label><input id="izRuleName" type="text" placeholder="选填" class="iz-rule-input"></div>
                <div class="iz-param-item" style="margin-bottom:10px;"><label>域名（逗号分隔，留空为当前网站）</label><input id="izRuleDomains" type="text" placeholder="${currentDomain}" class="iz-rule-input"></div>
                <div class="iz-param-item" style="margin-bottom:10px;"><label>图片容器选择器（背景图元素的 CSS 选择器）</label><input id="izRuleItem" type="text" placeholder="如：.image-container-top 或 .img-wrapper" class="iz-rule-input"></div>
                <div class="iz-param-item" style="margin-bottom:10px;"><label>卡片选择器</label><input id="izRuleCard" type="text" placeholder="如：.qtd-theme-card" class="iz-rule-input"></div>
                <div style="font-size:12px;color:var(--iz-tx-muted);margin-bottom:10px;">💡 不会写选择器？点「🖱️ 拾取选择器」后直接在页面上点一下图片即可自动填写。</div>
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button id="izRulePickBtn" class="iz-btn-sm" style="background-color:var(--iz-accent-soft);color:var(--iz-accent);border:none;">🖱️ 拾取选择器</button>
                    <button id="izRuleCancel" class="iz-btn-sm" style="background-color:var(--iz-bg-5);color:var(--iz-tx-muted);border:none;">取消</button>
                    <button id="izRuleSave" class="iz-btn-sm primary">保存规则</button>
                </div>
            </div>`;
        scroll.appendChild(section);

        const listEl = section.querySelector('#izRuleList');
        const form = section.querySelector('#izRuleForm');
        let lastSavedRule = null;

        section.querySelector('#izRuleAddBtn').addEventListener('click', () => {
            form.style.display = 'block';
            section.querySelector('#izRuleDomains').value = currentDomain;
        });

        // ===== 拾取模式（加固版：全屏遮罩拦截事件，站点收不到任何鼠标事件）=====
        section.querySelector('#izRulePickBtn').addEventListener('click', () => {
            form.style.display = 'block';
            const ov0 = document.getElementById('izModalOverlay');
            if (ov0) ov0.style.display = 'none';

            const tips = document.createElement('div');
            tips.style.cssText = 'position:fixed;z-index:2147483647;background:rgba(15,23,42,.92);color:#fff;padding:8px 12px;border-radius:8px;font:12px monospace;pointer-events:none;max-width:420px;display:none;white-space:nowrap;';
            document.body.appendChild(tips);

            const bar = document.createElement('div');
            bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#4F46E5;color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;font-weight:600;';
            bar.textContent = '🎯 点击图片附近任意位置（遮罩/标题也行），自动定位图片容器，按 ESC 取消';
            document.body.appendChild(bar);

            // ★ 全屏遮罩：所有鼠标事件落在遮罩上，站点自身的点击处理器（灯箱/加载层）不会被触发
            const blocker = document.createElement('div');
            blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:transparent;';
            document.body.appendChild(blocker);

            const shortSel = (el) => {
                if (!el || el === document.body || el === document.documentElement) return null;
                if (el.tagName === 'IMG') return 'img';
                if (el.id) {
                    const s0 = '#' + CSS.escape(el.id);
                    if (document.querySelectorAll(s0).length <= 60) return s0;
                }
                for (const c of (el.classList || [])) {
                    const s0 = '.' + CSS.escape(c);
                    if (document.querySelectorAll(s0).length > 0) return s0;
                }
                return el.tagName.toLowerCase();
            };

            const deriveSelectors = (hitEl) => {
                // 拾取器只负责"背景图"场景。★ IMG 元素不算背景图容器
                let bgEl = null, node = hitEl;
                while (node && node !== document.body) {
                    if (node.tagName === 'IMG') { node = node.parentElement; continue; }
                    try {
                        const bg = getComputedStyle(node).backgroundImage;
                        if (bg && bg !== 'none' && bg.includes('url(')) { bgEl = node; break; }
                    } catch (e) { }
                    if (node.querySelectorAll) {
                        const kids = node.querySelectorAll('*');
                        if (kids.length <= 800) {
                            for (const kid of kids) {
                                if (kid.tagName === 'IMG') continue;
                                try {
                                    const bg2 = getComputedStyle(kid).backgroundImage;
                                    if (bg2 && bg2 !== 'none' && bg2.includes('url(')) {
                                        const kr = kid.getBoundingClientRect();
                                        if (kr.width >= 80 && kr.height >= 80) { bgEl = kid; break; }
                                    }
                                } catch (e) { }
                            }
                            if (bgEl) break;
                        }
                    }
                    node = node.parentElement;
                }
                if (!bgEl) return { imgMode: 'img' };
                if (bgEl.tagName === 'IMG') return { imgMode: 'img' }; // 双保险
                const br = bgEl.getBoundingClientRect();
                if (br.width < 80 || br.height < 80) return { imgMode: 'img' };

                const itemSel = shortSel(bgEl);
                let card = null;
                node = bgEl.parentElement;
                while (node && node !== document.body) {
                    const r = node.getBoundingClientRect();
                    if (r.width < window.innerWidth * 0.9 && r.height < window.innerHeight * 0.9 &&
                        (node.querySelector('a') || node.querySelector('p'))) { card = node; break; }
                    node = node.parentElement;
                }
                let ok = false, count = 0;
                try { count = document.querySelectorAll(itemSel).length; ok = count > 0; } catch (e) { }
                return ok ? { itemSel, cardSel: card ? shortSel(card) : '', count, mode: 'background' } : { imgMode: 'img' };
            };

            const cleanupPicker = () => {
                blocker.removeEventListener('mousemove', move, true);
                blocker.removeEventListener('click', pick, true);
                document.removeEventListener('keydown', esc, true);
                blocker.remove();
                tips.remove();
                bar.remove();
            };

            const move = (e) => {
                // 暂时藏起遮罩，让 elementFromPoint 穿透到页面真实元素
                blocker.style.display = 'none';
                const el = document.elementFromPoint(e.clientX, e.clientY);
                blocker.style.display = 'block';
                if (!el) return;
                const d = deriveSelectors(el);
                if (!d || d.imgMode === 'img') {
                    tips.style.display = 'block';
                    tips.style.left = Math.min(e.clientX + 16, window.innerWidth - 440) + 'px';
                    tips.style.top = (e.clientY + 16) + 'px';
                    tips.textContent = '✓ 普通图片无需自定义规则（脚本已自动支持遮罩盖图场景），请点击背景图类卡片';
                    tips.dataset.item = '';
                    tips.dataset.card = '';
                    return;
                }
                tips.style.display = 'block';
                tips.style.left = Math.min(e.clientX + 16, window.innerWidth - 440) + 'px';
                tips.style.top = (e.clientY + 16) + 'px';
                tips.textContent = '图片容器: ' + d.itemSel + '（含图 ' + d.count + ' 张）' + (d.cardSel ? ' | 卡片: ' + d.cardSel : '');
                tips.dataset.item = d.itemSel;
                tips.dataset.card = d.cardSel || '';
            };

            const esc = (e) => { if (e.key === 'Escape') cleanupPicker(); };

            const pick = (e) => {
                const itemSel = tips.dataset.item, cardSel = tips.dataset.card;
                cleanupPicker();
                if (!itemSel) {
                    showToast('普通图片无需自定义规则，脚本已自动支持（仅背景图卡片需要规则）');
                    const ov = document.getElementById('izModalOverlay');
                    if (ov) {
                        ov.classList.add('anim-in');
                        ov.style.display = 'flex';
                        setTimeout(() => ov.classList.remove('anim-in'), 400);
                    }
                    return;
                }
                section.querySelector('#izRuleItem').value = itemSel;
                section.querySelector('#izRuleCard').value = cardSel;
                showSaveToast('已拾取：' + itemSel + '，确认后保存');
                const ov = document.getElementById('izModalOverlay');
                if (ov) {
                    ov.classList.add('anim-in');
                    ov.style.display = 'flex';
                    setTimeout(() => ov.classList.remove('anim-in'), 400);
                }
            };

            document.addEventListener('keydown', esc, true);
            blocker.addEventListener('mousemove', move, true);
            blocker.addEventListener('click', pick, true);
        });

        section.querySelector('#izRuleCancel').addEventListener('click', () => {
            form.style.display = 'none';
        });

        section.querySelector('#izRuleSave').addEventListener('click', () => {
            const itemSelector = section.querySelector('#izRuleItem').value.trim();
            if (!itemSelector) { showToast('请填写图片容器选择器'); return; }
            try { document.querySelector(itemSelector); } catch (e) { showToast('选择器语法有误，请检查'); return; }
            // 只允许背景图规则：校验目标元素（或其子元素）有 background-image
            let isBgSel = false;
            try {
                const els = document.querySelectorAll(itemSelector);
                for (const el of els) {
                    if ((getComputedStyle(el).backgroundImage || '').includes('url(')) { isBgSel = true; break; }
                    if (el.querySelector && [...el.querySelectorAll('*')].slice(0, 50).some(k => (getComputedStyle(k).backgroundImage || '').includes('url('))) {
                        isBgSel = true;
                        break;
                    }
                }
            } catch (e) { }
            if (!isBgSel) {
                showToast('该选择器未匹配到背景图元素。普通图片无需规则（脚本已自动支持）');
                return;
            }
            const rules = getCustomRules();
            const newRule = {
                id: 'r' + Date.now(),
                name: section.querySelector('#izRuleName').value.trim() || currentDomain,
                domains: section.querySelector('#izRuleDomains').value.trim() || currentDomain,
                imgMode: 'background',
                itemSelector,
                cardSelector: section.querySelector('#izRuleCard').value.trim(),
                pollInterval: 300,
                enabled: true
            };
            rules.push(newRule);
            saveCustomRules(rules);
            lastSavedRule = newRule;
            listEl.innerHTML = renderList();
            form.style.display = 'none';
            showSaveToast('规则已保存，刷新页面后生效');
        });

        listEl.addEventListener('click', (e) => {
            const item = e.target.closest('.iz-rule-item');
            if (!item) return;
            const rules = getCustomRules();
            const idx = rules.findIndex(r => r.id === item.dataset.id);
            if (idx < 0) return;
            if (e.target.classList.contains('iz-rule-del')) {
                rules.splice(idx, 1);
                saveCustomRules(rules);
                listEl.innerHTML = renderList();
                showSaveToast('规则已删除');
            } else if (e.target.classList.contains('iz-rule-enabled')) {
                rules[idx].enabled = e.target.checked;
                saveCustomRules(rules);
            }
        });
    }

    function createConfigPanel() {
        const overlay = document.createElement('div');
        overlay.id = 'izModalOverlay';

        // ★ 数值参数一律「滑块 + 数字框」：
        //   滑块负责探索（区间可见、可拖着看效果），数字框负责精确输入（保持既有能力不丢）。
        //   zeroText / markText 用于在滑杆两端标出语义（如 0 = 不过滤、3000 = 跟随视口）。
        const sliderFill = (v, min, max) => {
            const p = max > min ? Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)) : 0;
            return p.toFixed(2) + '%';
        };
        const renderParams = (defs) => defs.map(p => {
            const v = config[p.key];
            return `
            <div class="iz-param-item" data-mod-key="${p.key}">
                <label>${p.label}<span class="iz-tip-icon" data-tip="${p.tip}">?</span></label>
                <div class="iz-slider-row" data-param="${p.key}">
                    <input type="range" class="iz-slider" data-param="${p.key}"
                           min="${p.min}" max="${p.max}" step="${Math.min(Number(p.step) || 1, 1)}" value="${v}"
                           style="--fill:${sliderFill(v, p.min, p.max)}"/>
                    <input type="number" class="iz-param-input iz-param-num" data-param="${p.key}"
                           value="${v}" min="${p.min}" max="${p.max}" step="${p.step}"/>
                    <span class="iz-unit">${p.unit}</span>
                </div>
                ${(p.zeroText || p.markText) ? `<div class="iz-slider-scale"><span>${p.zeroText || ''}</span><span>${p.markText || ''}</span></div>` : ''}
            </div>`;
        }).join('');

        // ★ 分段控件：2–4 个选项时替代下拉框（选项一眼看全、一次点中）
        //   cur 可显式指定选中值（用于「预览尺寸」这种不直接对应 config 字段的派生状态）
        const renderSeg = (key, opts, cur) => {
            const active = (cur === undefined) ? config[key] : cur;
            return `
            <div class="iz-seg" data-seg="${key}">
                ${opts.map(o => `<button type="button" data-val="${o.v}" class="${String(active) === String(o.v) ? 'on' : ''}">${o.t}</button>`).join('')}
            </div>`;
        };

        // ★ 预览尺寸档位：每档画一个「视口框 + 按比例缩放的方块」，
        //   方块大小直接表达「大图能有多大」，比四个文字按钮直观得多。
        //   （用字符串拼接而非模板字符串，避免与外层 innerHTML 的反引号冲突）
        const sizeStepHtml = SIZE_STEPS.map((s, i) => {
            // 用「宽度比例」而非 min(宽比,高比)：预览区高度总是宽度的 0.6–0.8 倍，
            // 取 min 会让方块尺寸实际由高度决定，四档被压成 27/40/60/100，差异不明显。
            // 改用宽度比例后是 33/53/80/100，档位差距一眼可辨。
            const pct = Math.round((s.w / 3000) * 100);
            const bw = Math.max(28, pct);
            const bh = Math.max(26, Math.round(pct * 0.85));
            const on = sizeStepIndex() === i ? ' on' : '';
            return '<button type="button" class="izn-size' + on + '" data-val="' + i + '">'
                + '<span class="sz-view"><span class="sz-box" style="--s:' + bw + '%;--sh:' + bh + '%"></span></span>'
                + '<span class="sz-name">' + s.name + '</span></button>';
        }).join('');

        // 通用参数按语义拆分到不同分区（每项仍是同一个 config 字段）
        const DISPLAY_SIZE_DEFS = COMMON_PARAM_DEFS.filter(p => p.key === 'maxWidth' || p.key === 'maxHeight');
        const TRIGGER_BASIC_DEFS = COMMON_PARAM_DEFS.filter(p => p.key === 'delay' || p.key === 'minOriginalSize');
        const SCROLL_DEFS = COMMON_PARAM_DEFS.filter(p => p.key === 'scrollSpeed');
        overlay.innerHTML = `
            <div id="izConfigPanel">
                <div class="izn-top">
                    <div class="izn-brand">
                        <div class="izn-mark">🔍</div>
                        <div class="izn-name">悬景<em>HoverVista</em></div>
                    </div>
                    <div class="izn-scope" title="面板中除标注「所有网站」的项外，全部只作用于当前网站"><span class="izn-sd"></span>当前网站&nbsp;<b>${currentDomain}</b></div>
                    <div class="izn-saved">改动已自动保存</div>
                    <button class="iz-close-btn" id="izCloseBtn" title="关闭 (ESC)" style="margin-left:0">✕</button>
                </div>
                <div class="izn-body">
                    <nav class="izn-nav" id="iznNav">
                        <div class="izn-nav-group">概览</div>
                        <button class="izn-nav-item on" data-view="overview"><span>◉</span>总览与诊断</button>
                        <div class="izn-nav-group">外观</div>
                        <button class="izn-nav-item" data-view="display"><span>▣</span>显示与样式</button>
                        <div class="izn-nav-group">行为</div>
                        <button class="izn-nav-item" data-view="trigger"><span>⌁</span>触发与交互</button>
                        <button class="izn-nav-item" data-view="fixed"><span>⤢</span>固定模式参数<span class="izn-tag">5</span></button>
                        <button class="izn-nav-item" data-view="keys"><span>⌨</span>键位<span class="izn-tag">13</span></button>
                        <div class="izn-nav-group">规则与数据</div>
                        <button class="izn-nav-item" data-view="rules"><span>⇄</span>图片规则</button>
                        <button class="izn-nav-item" data-view="sitefit"><span>◎</span>站点适配</button>
                        <button class="izn-nav-item" data-view="history"><span>◷</span>历史记录<span class="izn-tag" id="iznHistTag"></span></button>
                    </nav>
                    <main class="izn-content" id="iznContent">

                        <!-- ① 总览与诊断 -->
                        <section class="izn-view on" data-view="overview">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">总览与诊断</div>
                                <p class="izn-vsub">先看这里：本站是否生效、规则命中情况，以及最常见的几个问题该去哪里调。</p>
                            </div>
                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>当前网站状态</b><span class="izn-hint">只作用于 ${currentDomain}</span></div>
                                <div class="iz-switch-grid" style="grid-template-columns:1fr">
                                    <div class="iz-switch-card" id="iznMasterWrap" role="switch" tabindex="0" aria-checked="true">
                                        <div class="iz-toggle" id="iznMasterToggle"><div class="iz-knob"></div></div>
                                        <div class="iz-switch-text"><div class="iz-switch-title">启用图片放大</div><div class="iz-switch-sub">关闭后本网站的悬停放大与视频预览全部停用（其它网站不受影响）。等效于点击页面上的控制球。</div></div>
                                    </div>
                                    <div class="iz-exclusion-box" style="padding:9px 10px;">
                                        <div class="iz-status-row">
                                            <div class="iz-status-text"><span class="iz-dot on" id="izHpDot"></span><span id="izHpText">当前主页已启用图片放大</span><span class="iz-badge">仅主页</span></div>
                                            <button class="iz-btn-sm warning" id="izHpToggleBtn">禁用主页图片放大</button>
                                        </div>
                                        <div class="iz-exclusion-note">站首页通常图片密集、容易误触发；开启后只关首页，内容子页面照常生效。</div>
                                    </div>
                                </div>
                            </div>
                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>规则与数据概况</b></div>
                                <div class="izn-grid2">
                                    <div class="izn-status"><span class="izn-sd"></span><div class="flex">我的规则 <b id="iznRuleSummary">0 条</b><div class="note">云端规则包与本站命中情况见「图片规则」</div></div><button class="iz-btn-sm" data-izn-go="rules">管理</button></div>
                                    <div class="izn-status"><span class="izn-sd"></span><div class="flex">云端规则包 <b id="iznPackSummary">读取中</b><div class="note">🔒 签名校验状态与更新入口在「图片规则」</div></div><button class="iz-btn-sm" data-izn-go="rules">更新</button></div>
                                </div>
                            </div>
                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>遇到问题？</b><span class="izn-hint">点一下直达对应设置</span></div>
                                <div class="izn-diag">
                                    <button data-izn-go="sitefit"><span class="q">图悬停没反应</span><span class="a">页面遮罩挡住了鼠标 → <b>站点适配</b>加一条容器规则</span></button>
                                    <button data-izn-go="display"><span class="q">大图太小 / 太大</span><span class="a">换放大模式或调最大宽高 → <b>显示与样式</b></span></button>
                                    <button data-izn-go="rules"><span class="q">图片不够清晰</span><span class="a">本站有没有更大的图？→ 在 <b>图片规则</b> 里「点图选图」试试</span></button>
                                </div>
                            </div>
                        </section>

                        <!-- ② 显示与样式 -->
                        <section class="izn-view" data-view="display">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">显示与样式</div>
                                <p class="izn-vsub">决定大图「多大、出现在哪、长什么样」。</p>
                            </div>

                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>放大模式</b><span class="izn-hint">方块宽度 = 大图宽度</span></div>
                                <div class="izn-mode-grid" id="iznZoomModes">
                                    <button type="button" class="izn-mode on" data-mode="adaptive">
                                        <span class="izn-mode-badge">推荐</span>
                                        <div class="izn-mode-vis">
                                            <span class="mv-frame" style="--g:40"></span>
                                            <span class="mv-frame" style="--g:62"></span>
                                            <span class="mv-frame" style="--g:84"></span>
                                        </div>
                                        <span class="pn">智能自适应</span>
                                        <span class="pd">尺寸按每张图自动算，尽量用满屏幕</span>
                                        <span class="izn-mode-tagline">每张图不一样</span>
                                    </button>
                                    <button type="button" class="izn-mode" data-mode="fixed">
                                        <div class="izn-mode-vis">
                                            <span class="mv-frame" style="--g:62"></span>
                                            <span class="mv-frame" style="--g:62"></span>
                                            <span class="mv-frame" style="--g:62"></span>
                                        </div>
                                        <span class="pn">固定倍数</span>
                                        <span class="pd">始终按你设的倍率，每次大小都一样</span>
                                        <span class="izn-mode-tagline">每张图都一样</span>
                                    </button>
                                </div>
                            </div>

                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>大图能有多大</b><span class="izn-hint">方块大小就是大图大小</span></div>
                                <div class="izn-size-grid" id="iznSizeSteps">${sizeStepHtml}</div>
                                <details class="iz-adv">
                                    <summary>高级：分别设置宽高</summary>
                                    <div class="izn-grid2" style="margin-top:10px">${renderParams(DISPLAY_SIZE_DEFS)}</div>
                                </details>
                            </div>

                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>大图出现在哪</b><span class="izn-hint">看动画对比</span></div>
                                <div class="izn-place-grid" id="iznPlaces">
                                    <button type="button" class="izn-place on" data-place="center">
                                        <div class="izn-demo" data-demo="center"><div class="d-thumb"></div><div class="d-preview"></div></div>
                                        <span class="pn">屏幕居中</span><span class="pd">位置稳定，每次都一样</span>
                                    </button>
                                    <button type="button" class="izn-place" data-place="around">
                                        <div class="izn-demo" data-demo="around"><div class="d-thumb"></div><div class="d-preview"></div></div>
                                        <span class="pn">原图周围</span><span class="pd">不挡住你正在看的那张图</span>
                                    </button>
                                </div>
                            </div>

                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>出现方式</b><span class="izn-hint">看动画对比</span></div>
                                <div class="izn-place-grid izn-place-grid--3" id="iznTransitions">
                                    <button type="button" class="izn-place on" data-fx="dock">
                                        <div class="izn-demo" data-demo="fx-dock"><div class="d-thumb"></div><div class="d-preview"></div></div>
                                        <span class="pn">从原图弹出</span><span class="pd">整块从原图位置长出来，滑到预览位置</span>
                                    </button>
                                    <button type="button" class="izn-place" data-fx="spotlight">
                                        <div class="izn-demo" data-demo="fx-spotlight"><div class="d-thumb"></div><div class="d-preview"></div></div>
                                        <span class="pn">从原图绽开</span><span class="pd">在原图位置用光圈向外扩散</span>
                                    </button>
                                    <button type="button" class="izn-place" data-fx="fade">
                                        <div class="izn-demo" data-demo="fx-fade"><div class="d-thumb"></div><div class="d-preview"></div></div>
                                        <span class="pn">直接淡入</span><span class="pd">最快，没有任何位移</span>
                                    </button>
                                </div>
                                <div style="padding:2px 2px 0;font-size:11.5px;color:var(--iz-tx-faint)">系统开启「减少动态效果」时会自动降级为直接淡入。</div>
                            </div>

                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>外观</b></div>
                                <div class="iz-switch-grid" style="grid-template-columns:1fr">
                                    <div class="iz-switch-card" id="izImageInfoWrap" role="switch" tabindex="0" aria-checked="${config.showImageInfo ? 'true' : 'false'}">
                                        <div class="iz-toggle ${config.showImageInfo ? 'active' : ''}" id="izImageInfoToggle"><div class="iz-knob"></div></div>
                                        <div class="iz-switch-text"><div class="iz-switch-title">显示图片信息栏</div><div class="iz-switch-sub">在大图下方显示尺寸、格式、来源和图说。</div></div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        <!-- ③ 触发与交互 -->
                        <section class="izn-view" data-view="trigger">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">触发与交互</div>
                                <p class="izn-vsub">什么时候弹出、怎么操作它，以及和页面点击放大的相处方式。</p>
                            </div>
                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>触发时机</b></div>
                                <div class="iz-param-grid" style="margin-bottom:10px;grid-template-columns:1fr">${renderParams(TRIGGER_BASIC_DEFS)}</div>
                                <div class="iz-switch-grid">
                                    <div class="iz-switch-card" id="izConflictWrap" role="switch" tabindex="0" aria-checked="${config.avoidClickConflict ? 'true' : 'false'}">
                                        <div class="iz-toggle ${config.avoidClickConflict ? 'active' : ''}" id="izConflictToggle"><div class="iz-knob"></div></div>
                                        <div class="iz-switch-text"><div class="iz-switch-title">避开「点一下才放大」的网站</div><div class="iz-switch-sub">自动识别这类站点，避免重复触发。</div></div>
                                    </div>
                                    <div class="iz-switch-card" id="izBlurDismissWrap" role="switch" tabindex="0" aria-checked="${config.blurDismiss ? 'true' : 'false'}">
                                        <div class="iz-toggle ${config.blurDismiss ? 'active' : ''}" id="izBlurDismissToggle"><div class="iz-knob"></div></div>
                                        <div class="iz-switch-text"><div class="iz-switch-title">切到别的应用时自动收起</div><div class="iz-switch-sub">关掉后，切换应用时预览会保留。</div></div>
                                    </div>
                                </div>
                            </div>
                            <div class="izn-sect">
                                <div class="izn-sect-h"><b>滚轮与视频</b></div>
                                <div class="iz-param-grid" style="margin-bottom:10px;grid-template-columns:1fr">${renderParams(SCROLL_DEFS)}</div>
                                <div class="iz-switch-grid">
                                    <div class="iz-switch-card" id="izWheelZoomWrap" role="switch" tabindex="0" aria-checked="${config.wheelZoom ? 'true' : 'false'}">
                                        <div class="iz-toggle ${config.wheelZoom ? 'active' : ''}" id="izWheelZoomToggle"><div class="iz-knob"></div></div>
                                        <div class="iz-switch-text"><div class="iz-switch-title">滚轮放大缩小</div><div class="iz-switch-sub">关掉后，滚轮恢复为上下平移。</div></div>
                                    </div>
                                    <div class="iz-switch-card" id="izVideoHoverWrap" role="switch" tabindex="0" aria-checked="${config.videoHoverPreview ? 'true' : 'false'}">
                                        <div class="iz-toggle ${config.videoHoverPreview ? 'active' : ''}" id="izVideoHoverToggle"><div class="iz-knob"></div></div>
                                        <div class="iz-switch-text"><div class="iz-switch-title">悬停视频时预览播放</div><div class="iz-switch-sub">悬停视频卡片时静音浮出播放，按 Esc 关闭。</div></div>
                                    </div>
                                    <div class="iz-switch-card" id="izBiliWrap" role="switch" tabindex="0" aria-checked="${bilibiliVolumeModule.isEnabled ? 'true' : 'false'}">
                                        <div class="iz-toggle ${bilibiliVolumeModule.isEnabled ? 'active' : ''}" id="izBiliToggle"><div class="iz-knob"></div></div>
                                        <div class="iz-switch-text"><div class="iz-switch-title">B站全屏音量修正</div><div class="iz-switch-sub">B站全屏时如果滚轮调不了音量，开启这项即可。</div></div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        <!-- ④ 固定模式参数 -->
                        <section class="izn-view" data-view="fixed">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">固定模式参数</div>
                                <p class="izn-vsub" id="izModeBadge">这些设置只在「固定倍数」模式下生效</p>
                            </div>
                            <div class="izn-lock" id="iznFixedLock" hidden>
                                <span>⚠︎</span>
                                <div class="flex">当前是<b>智能自适应</b>模式，下面 5 项不生效。</div>
                                <button class="iz-btn-sm primary" id="iznToFixedBtn">切到固定倍数</button>
                            </div>
                            <div class="izn-locked" id="iznFixedCard">
                                <div class="iz-param-grid" style="grid-template-columns:1fr">${renderParams(FIXED_PARAM_DEFS)}</div>
                            </div>
                        </section>

                        <!-- ⑤ 键位 -->
                        <section class="izn-view" data-view="keys">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">键位</div>
                                <p class="izn-vsub">只在预览显示时生效。<b>键位对所有网站通用</b>，改一次到处都是这套键。</p>
                            </div>
                            <div class="izn-sect">
                                <div class="iz-collapse-header" id="izKeymapHeader" role="button" tabindex="0" aria-expanded="false" style="border-bottom:0">
                                    <div>
                                        <div class="iz-left"><span class="iz-arrow open" id="izKeymapArrow">▶</span><span class="iz-header-name">动作快捷键</span><span class="iz-count">13 项</span></div>
                                        <div class="iz-collapse-description">点右侧键帽再按新键即可改绑；按到已占用的键时，原动作自动让出</div>
                                    </div>
                                    <span style="font-size:12px;color:var(--iz-tx-muted);text-align:right;max-width:150px;" id="izKeymapHint">点击收起</span>
                                </div>
                                <div class="iz-collapse-body open" id="izKeymapBody">
                                    <div class="iz-keymap-grid" id="izKeymapGrid"></div>
                                    <div style="margin-top:10px;display:flex;gap:8px;align-items:center;">
                                        <button class="iz-btn-sm" id="izKeymapResetBtn">↩ 恢复默认键位</button>
                                        <span style="font-size:11px;color:var(--iz-tx-muted);">键位对所有网站通用</span>
                                    </div>
                                </div>
                            </div>
                        </section>

                        <!-- ⑥ 图片规则 -->
                        <section class="izn-view" data-view="rules">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">换图规则</div>
                                <p class="izn-vsub">从上到下依次生效：① 我的规则 → ② 云端规则包 → ③ 内置兜底。</p>
                            </div>
                            <div class="izn-sect">
                                <div class="iz-collapse-header" id="izUrlRuleHeader" role="button" tabindex="0" aria-expanded="true" style="border-bottom:0">
                                    <div>
                                        <div class="iz-left"><span class="iz-arrow open" id="izUrlRuleArrow">▶</span><span class="iz-header-name">规则明细</span><span class="iz-count" id="izRuleCount">读取中</span></div>
                                        <div class="iz-collapse-description">① 我的规则（优先）→ ② 云端规则包 → ③ 内置兜底</div>
                                    </div>
                                    <span style="font-size:12px;color:var(--iz-tx-muted);text-align:right;max-width:150px;" id="izUrlRuleHint">点击收起</span>
                                </div>
                                <div class="iz-collapse-body open" id="izUrlRuleBody">
                                    <div class="iz-exclusion-box" style="padding:9px 10px;margin-bottom:12px;">
                                        <div class="iz-status-row">
                                            <div class="iz-status-text"><span class="iz-dot on" id="izUrlRuleDot"></span><span id="izUrlRuleStatus">读取中…</span></div>
                                        </div>
                                        <div class="iz-exclusion-note" id="izUrlRuleNote"></div>
                                    </div>
                                    <div class="iz-exclusion-box" style="padding:10px 12px;margin-bottom:12px;">
                                        <div style="font-size:13px;font-weight:600;color:var(--iz-tx-2);margin-bottom:4px;">🔍 帮我找大图</div>
                                        <div style="font-size:12px;color:var(--iz-tx-muted);line-height:1.6;margin-bottom:8px;">图片看不清？点「点图选图」后，直接在网页上点那张图就行。</div>
                                        <div style="display:flex;gap:8px;margin-bottom:8px;">
                                            <button id="izUrlPickBtn" class="iz-btn-sm primary" style="flex:1;">🖱 点图选图</button>
                                            <button id="izUrlAutoBtn" class="iz-btn-sm" style="flex:1;background-color:var(--iz-bg-5);color:var(--iz-tx-2);">🔍 分析这个地址</button>
                                        </div>
                                        <input id="izUrlAutoIn" type="text" class="iz-rule-input" placeholder="（可选）粘贴图片地址…">
                                        <div id="izUrlAutoOut" style="margin-top:10px;"></div>
                                    </div>
                                    <div style="font-size:13px;font-weight:600;color:var(--iz-tx-2);margin-bottom:2px;"><span class="iz-badge accent" style="margin-right:6px;">1</span>我的规则 <span class="iz-badge accent">优先</span> <span id="izUrlRuleCount" style="font-size:11px;font-weight:400;color:var(--iz-tx-muted);"></span></div>
                                    <div style="font-size:12px;color:var(--iz-tx-muted);line-height:1.6;margin-bottom:8px;">这里加的规则会盖过云端和内置规则。</div>
                                    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                                        <span style="font-size:12px;color:var(--iz-tx-2);flex-shrink:0;">生效范围</span>
                                        <div class="iz-seg" id="izUrlScope" data-seg="urlScope">
                                            <button type="button" data-val="site" class="on">只在当前网站</button>
                                            <button type="button" data-val="global">所有网站</button>
                                        </div>
                                    </div>
                                    <div id="izUrlRuleList"></div>
                                    <details style="margin-top:12px;">
                                        <summary style="font-size:12px;color:var(--iz-tx-muted);cursor:pointer;user-select:none;">高级：手写匹配规则 / 导出</summary>
                                        <div style="margin-top:10px;padding:12px;background:var(--iz-bg-3);border-radius:var(--iz-r-md);">
                                            <div class="iz-param-item" style="margin-bottom:10px;"><label>处理时机</label>
                                                <div class="iz-seg" id="izUrlPhase" data-seg="urlPhase">
                                                    <button type="button" data-val="hd" class="on">找更大的图</button>
                                                    <button type="button" data-val="clean">清理图片地址</button>
                                                </div>
                                            </div>
                                            <div class="iz-param-item" style="margin-bottom:10px;"><label>匹配规则</label><input id="izUrlPattern" type="text" class="iz-rule-input" placeholder="如：_\d+x\d+\.(jpg|png)"></div>
                                            <div class="iz-param-item" style="margin-bottom:10px;"><label>替换成</label><input id="izUrlReplace" type="text" class="iz-rule-input" placeholder="如：.$1　（$1 $2 代表匹配到的内容）"></div>
                                            <div class="iz-param-item" style="margin-bottom:10px;"><label>备注</label><input id="izUrlLabel" type="text" class="iz-rule-input" placeholder="例：本站缩略图后缀"></div>
                                            <details style="margin-bottom:10px;">
                                                <summary style="font-size:11.5px;color:var(--iz-tx-muted);cursor:pointer;user-select:none;">匹配选项（一般不用改）</summary>
                                                <div class="iz-param-item" style="margin-top:8px;"><label>flags</label><input id="izUrlFlags" type="text" class="iz-rule-input" placeholder="i 或 g，留空即可"></div>
                                            </details>
                                            <div style="display:flex;gap:10px;justify-content:flex-end;">
                                                <button id="izUrlRuleSave" class="iz-btn-sm primary">保存规则</button>
                                            </div>
                                            <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
                                                <button id="izUrlRuleShare" class="iz-btn-sm">📤 导出为可提交的规则包片段</button>
                                                <button id="izUrlRuleFeedback" class="iz-btn-sm" style="background-color:var(--iz-bg-5);color:var(--iz-tx-2);">🐛 提交给官方（自动填好内容）</button>
                                            </div>
                                        </div>
                                    </details>
                                    <div style="margin-top:14px;padding:12px;background:var(--iz-bg-3);border-radius:var(--iz-r-md);border:1.5px solid var(--iz-bd-2);">
                                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                                            <span class="iz-badge accent" style="margin-right:2px;">2</span>
                                            <span style="font-size:13px;font-weight:600;color:var(--iz-tx-2);">云端规则包</span>
                                            <span class="iz-badge" id="izPackBadge">读取中</span>
                                        </div>
                                        <div style="font-size:12px;color:var(--iz-tx-muted);line-height:1.6;margin-bottom:8px;">按站点下发，不能直接改；某个站不合适，就用上面的「我的规则」盖住它。</div>
                                        <div class="iz-switch-grid" style="margin-bottom:8px">
                                            <div class="iz-switch-card" id="izPackAutoWrap" role="switch" tabindex="0" aria-checked="${config.rulePackAuto ? 'true' : 'false'}">
                                                <div class="iz-toggle ${config.rulePackAuto ? 'active' : ''}" id="izPackAutoToggle"><div class="iz-knob"></div></div>
                                                <div class="iz-switch-text"><div class="iz-switch-title">自动更新</div><div class="iz-switch-sub">启动时后台拉取，失败自动用本地缓存。</div></div>
                                            </div>
                                        </div>
                                        <div class="iz-exclusion-box" style="padding:9px 10px;">
                                            <div class="iz-status-row">
                                                <div class="iz-status-text"><span class="iz-dot on" id="izPackDot"></span><span id="izPackStatus">读取中…</span></div>
                                            </div>
                                            <div class="iz-exclusion-note" id="izPackNote">规则包只提供「正则 → 替换」的数据，不执行任何代码。</div>
                                        </div>
                                        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                                            <button class="iz-btn-sm" id="izPackUpdateBtn">↻ 立即更新</button>
                                            <button class="iz-btn-sm" id="izPackRollbackBtn">↩ 回滚上一版</button>
                                        </div>
                                    </div>
                                    <div style="margin-top:10px;padding:10px 12px;background:var(--iz-bg-3);border-radius:var(--iz-r-md);border:1.5px solid var(--iz-bd-2);">
                                        <div style="display:flex;align-items:center;gap:8px;">
                                            <span class="iz-badge accent" style="margin-right:2px;">3</span>
                                            <span style="font-size:13px;font-weight:600;color:var(--iz-tx-2);">内置兜底规则</span>
                                            <span class="iz-count" id="izBuiltinCount"></span>
                                        </div>
                                        <div style="font-size:12px;color:var(--iz-tx-muted);line-height:1.6;margin-top:4px;">脚本自带的通用规则，始终生效。</div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        <!-- ⑦ 站点适配 -->
                        <section class="izn-view" data-view="sitefit">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">站点适配</div>
                                <p class="izn-vsub">页面用遮罩挡住鼠标、或图片是背景图时，在这里把真正的图片容器告诉脚本。</p>
                            </div>
                            <div class="izn-sect">
                                <div id="izSiteFitMount"></div>
                            </div>
                        </section>

                        <!-- ⑧ 历史记录 -->
                        <section class="izn-view" data-view="history">
                            <div class="izn-vhead">
                                <div class="izn-vtitle">历史记录</div>
                                <p class="izn-vsub">最近悬停看过的图片，最多 60 条，只保存在本机。</p>
                            </div>
                            <div class="izn-sect">
                                <div class="iz-collapse-header" id="izHistoryHeader" role="button" tabindex="0" aria-expanded="true" style="border-bottom:0">
                                    <div>
                                        <div class="iz-left"><span class="iz-arrow open" id="izHistoryArrow">▶</span><span class="iz-header-name">最近看过</span><span class="iz-count" id="izHistoryCount"></span></div>
                                        <div class="iz-collapse-description">可回看 / 打开原图 / 复制地址；只保存在本机</div>
                                    </div>
                                    <span style="font-size:12px;color:var(--iz-tx-muted);text-align:right;max-width:150px;" id="izHistoryHint">点击收起</span>
                                </div>
                                <div class="iz-collapse-body open" id="izHistoryBody">
                                    <div id="izHistoryList"></div>
                                    <div style="margin-top:8px;"><button class="iz-btn-sm" id="izHistoryClearBtn">🗑 清空历史</button></div>
                                </div>
                            </div>
                        </section>

                    </main>
                </div>
                <div class="iz-panel-footer">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <button class="iz-btn-ghost" id="izHelpBtn">📘 使用说明</button>
                        <button class="iz-btn-ghost" id="izChangelogBtn">📋 更新说明</button>
                        <button class="iz-btn-ghost" id="izFeedbackBtn">🐞 反馈问题</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <button class="iz-btn-ghost" id="izExportBtn" title="把全部站点配置与自定义规则导出为 JSON 文件">💾 导出</button>
                        <button class="iz-btn-ghost" id="izImportBtn" title="从之前导出的 JSON 文件恢复配置">📥 导入</button>
                        <button class="iz-btn-ghost iz-btn-danger-ghost" id="izResetBtn" title="只重置当前网站的设置，其它网站不受影响">↺ 恢复本站默认</button>
                        <button class="iz-btn-primary-solid" id="izSaveBtn">完成</button>
                    </div>
                </div>
                <input type="file" id="izImportInput" accept="application/json,.json" style="display:none">
            </div>
`;

        document.body.appendChild(overlay);
        bindWheelTrap(overlay);
        injectCustomRulesSection(overlay);

        const $ = (id) => overlay.querySelector('#' + id);
        const conflictToggle = $('izConflictToggle');
        const modeBadge = $('izModeBadge');
        const biliToggle = $('izBiliToggle');

        // 快捷开关 / 折叠区：键盘可操作 + 无障碍状态同步
        overlay.querySelectorAll('.iz-switch-card').forEach(wrap => {
            const tg = wrap.querySelector('.iz-toggle');
            if (!tg) return;
            const syncSw = () => wrap.setAttribute('aria-checked', tg.classList.contains('active') ? 'true' : 'false');
            new MutationObserver(syncSw).observe(tg, { attributes: true, attributeFilter: ['class'] });
            syncSw();
            wrap.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); wrap.click(); }
            });
        });
        const wireCollapseA11y = (header, body) => {
            const syncExp = () => header.setAttribute('aria-expanded', body.classList.contains('open') ? 'true' : 'false');
            new MutationObserver(syncExp).observe(body, { attributes: true, attributeFilter: ['class'] });
            syncExp();
            header.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); header.click(); }
            });
        };

        // ===== 规则包 =====
        // 注：原「规则包」独立折叠区块已合并进「图片规则（换大图）」区的 ② 云端规则包，
        // 元素 id（izPackBadge/izPackStatus/izPackAutoToggle/izPackUpdateBtn/izPackRollbackBtn）保持不变，
        // 因此下面的状态渲染与按钮绑定无需改动，只是不再有独立的折叠头。
        function renderPackStatus() {
            const badge = $('izPackBadge'), st = $('izPackStatus'), note = $('izPackNote');
            if (!badge || !st || !note) return;
            const meta = rulePackState.meta || {};
            const cur = rulePackState.current;
            if (cur && cur.version) {
                badge.textContent = 'v' + cur.version;
                st.textContent = '已加载规则包 v' + cur.version + (meta.at ? '（' + String(meta.at).slice(0, 10) + '）' : '');
            } else {
                badge.textContent = '内置';
                st.textContent = '当前使用内置规则';
            }
            const hits = ((cur && cur.domains) || []).filter(function (d) { return packDomainMatches(currentDomain, d.domain); });
            const extra = hits.length
                ? '　本站命中：' + hits.map(function (d) { return d.label || d.domain; }).join('、')
                : '　本站无专属规则';
            // 签名校验状态（供应链加固）：verified 只在「验签+哈希全过」时写入 meta
            let sig = '';
            if (meta.verified) sig = '　🔒 签名校验通过';
            else if (meta.lastError && /^sig-|^hash-/.test(meta.lastError)) sig = '　⚠ 签名校验未通过（' + meta.lastError + '）';
            const err = meta.lastError ? '　上次更新失败：' + meta.lastError : '';
            note.textContent = '规则包只提供「正则 → 替换」的数据，不执行任何代码。' + sig + extra + err;
        }
        renderPackStatus();
        const packAutoWrap = $('izPackAutoWrap');
        if (packAutoWrap) {
            packAutoWrap.addEventListener('click', () => {
                config.rulePackAuto = !config.rulePackAuto;
                $('izPackAutoToggle').classList.toggle('active', config.rulePackAuto);
                packAutoWrap.setAttribute('aria-checked', config.rulePackAuto ? 'true' : 'false');
                saveConfig();
            });
        }
        const packUpdateBtn = $('izPackUpdateBtn');
        if (packUpdateBtn) {
            packUpdateBtn.addEventListener('click', () => {
                packUpdateBtn.disabled = true;
                packUpdateBtn.textContent = '更新中…';
                updateRulePack(true).then(function (r) {
                    packUpdateBtn.disabled = false;
                    packUpdateBtn.textContent = '↻ 立即更新';
                    renderPackStatus();
                    if (r && r.ok) showToast(r.unchanged ? '已是最新规则包 v' + r.version : '规则包已更新到 v' + r.version + ' 🎉');
                    else if (r && r.reason === 'busy') showToast('规则包正在更新中，请稍候再试');
                    else showToast('更新失败：' + ((r && r.reason) || '未知') + '（继续使用现有规则）');
                });
            });
        }
        const packRollbackBtn = $('izPackRollbackBtn');
        if (packRollbackBtn) {
            packRollbackBtn.addEventListener('click', () => {
                const r = rollbackRulePack();
                renderPackStatus();
                showToast(r.ok ? '已回滚到 v' + r.version : '没有可回滚的版本');
            });
        }

        // ===== 图片地址规则（极简版：一键找大图；正则收进「高级」）=====
        const urHeader = $('izUrlRuleHeader'), urBody = $('izUrlRuleBody');
        if (urHeader && urBody) {
            wireCollapseA11y(urHeader, urBody);
            urHeader.addEventListener('click', () => {
                const isOpen = urBody.classList.contains('open');
                urBody.classList.toggle('open');
                $('izUrlRuleArrow').classList.toggle('open');
                $('izUrlRuleHint').innerHTML = isOpen ? '点开编辑' : '点击收起';
                if (!isOpen) renderUrlRuleStatus();   // 展开时刷新「最近命中」等状态
            });
        }

        function renderUrlRules() {
            const list = $('izUrlRuleList');
            if (!list) return;
            const rules = (config.userUrlRules || []);
            $('izUrlRuleCount').textContent = rules.length ? ('· ' + rules.length + ' 条') : '';
            if (!rules.length) {
                list.innerHTML = '<div style="font-size:12px;color:var(--iz-tx-muted);padding:6px 0;line-height:1.6;">还没有。用上面的「帮我找大图」就能加一条，不用懂任何技术。</div>';
                return;
            }
            list.innerHTML = rules.map(function (r, i) {
                return '<div class="iz-urlrule-item" data-id="' + escapeHtml(r.id) + '" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--iz-bd-1);">'
                    + '<input type="checkbox" class="iz-urlrule-enabled" ' + (r.enabled !== false ? 'checked' : '') + ' style="flex-shrink:0;">'
                    + '<div style="flex:1;min-width:0;"><div style="font-size:13px;color:var(--iz-tx-2);">' + escapeHtml(r.label || ('规则 ' + (i + 1))) + '</div>'
                    + '<div style="font-size:11px;color:var(--iz-tx-muted);">' + (r.enabled !== false ? '生效中' : '已停用') + ' · ' + (r.phase === 'clean' ? '清理' : '找大图') + ' · ' + (r.scope === 'global' ? '所有网站' : ('仅 ' + escapeHtml(r.domain || '本站'))) + '</div></div>'
                    + '<button class="iz-urlrule-del" style="border:none;background:none;color:var(--iz-danger);cursor:pointer;font-size:16px;flex-shrink:0;" title="删除">✕</button>'
                    + '</div>';
            }).join('');
        }
        function commitUrlRules() { saveConfig(); rebuildEffectiveRules(); renderUrlRules(); renderUrlRuleStatus(); }
        // 新规则的生效范围：默认「只在当前网站」（记下 domain），可选「所有网站」
        function segValue(segId, fallback) {
            const box = $(segId);
            if (!box) return fallback;
            const on = box.querySelector('button.on');
            return on ? on.dataset.val : fallback;
        }
        function readRuleScope() {
            if (segValue('izUrlScope', 'site') === 'global') return { scope: 'global', domain: '' };
            return { scope: 'site', domain: currentDomain };
        }
        renderUrlRules();
        renderUrlRuleStatus();   // 新布局默认展开规则区，打开面板即显示命中状态

        // 「规则在当前网站生效了吗」——生效规则数、来源构成、最近一次真实命中
        function renderUrlRuleStatus() {
            const st = $('izUrlRuleStatus'), note = $('izUrlRuleNote');
            if (!st || !note) return;
            const userN = (config.userUrlRules || []).filter(function (r) { return r.enabled !== false; }).length;
            const pack = rulePackState.current;
            const hits = ((pack && pack.domains) || []).filter(function (d) { return packDomainMatches(currentDomain, d.domain); });
            const packN = hits.reduce(function (a, d) { return a + ((d.hd || []).length + (d.clean || []).length); }, 0);
            const builtinN = URL_RULES.length + HD_UPGRADE_RULES.length;
            // 顶部折叠头计数 + ③ 内置兜底条数（合并成单一「图片规则」区后新增）
            const cntEl = $('izRuleCount');
            if (cntEl) cntEl.textContent = (userN + packN + builtinN) + ' 条生效';
            const biEl = $('izBuiltinCount');
            if (biEl) biEl.textContent = builtinN + ' 条';
            st.textContent = currentDomain + '：生效 ' + (userN + packN + builtinN) + ' 条规则'
                + '（① 我的 ' + userN + ' / ② 云端 ' + packN + ' / ③ 内置 ' + builtinN + '）';
            const parts = [];
            if (lastRuleHit) {
                const f = String(lastRuleHit.from), t = String(lastRuleHit.to);
                const tail = function (s) { return s.length > 68 ? '…' + s.slice(-68) : s; };
                parts.push('✅ 最近一次实际命中【' + (lastRuleHit.name || lastRuleHit.id) + '】　'
                    + tail(f) + '　→　' + tail(t));
            } else {
                parts.push('⏳ 本次页面还没命中过规则：悬停一张图片后回到这里看结果。');
            }
            if (hits.length) parts.push('规则包为本站提供：' + hits.map(function (d) { return d.label || d.domain; }).join('、'));
            else parts.push('规则包暂无本站专属规则（使用内置规则）。');
            note.textContent = parts.join('　|　');
        }
        renderUrlRuleStatus();

        // ===== 历史记录 =====
        function fmtHistTime(ts) {
            if (!ts) return '';
            const d = new Date(ts), now = new Date();
            const pad = n => (n < 10 ? '0' + n : '' + n);
            const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
            if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
            return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm;
        }
        function renderHistory() {
            const list = $('izHistoryList');
            if (!list) return;
            const items = getHistory();
            const cnt = $('izHistoryCount');
            if (cnt) cnt.textContent = items.length ? ('· ' + items.length + ' 条') : '';
            if (!items.length) {
                list.innerHTML = '<div style="font-size:12px;color:var(--iz-tx-muted);padding:6px 0;line-height:1.6;">还没有。悬停放大过的图片会自动记在这里（只保存在本机，最多 60 条）。</div>';
                return;
            }
            list.innerHTML = items.map(function (r) {
                const dim = (r.w > 0 && r.h > 0) ? (r.w + '×' + r.h) : '';
                const meta = [r.host, dim, fmtHistTime(r.ts)].filter(Boolean).join(' · ');
                const thumb = r.thumb || r.u;
                return '<div data-hid="' + escapeHtml(r.id) + '" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--iz-bd-1);">'
                    + '<img src="' + escapeHtml(thumb) + '" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px;background:var(--iz-bg-3);flex-shrink:0;" onerror="this.style.visibility=\'hidden\';">'
                    + '<div style="flex:1;min-width:0;"><div style="font-size:12px;color:var(--iz-tx-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtml(r.u) + '">' + escapeHtml(r.u) + '</div>'
                    + '<div style="font-size:11px;color:var(--iz-tx-muted);margin-top:2px;">' + escapeHtml(meta) + '</div></div>'
                    + '<div style="display:flex;gap:6px;flex-shrink:0;">'
                    + '<button class="iz-btn-sm" data-act="open">打开</button>'
                    + '<button class="iz-btn-sm" data-act="copy">复制</button>'
                    + '<button class="iz-btn-sm" data-act="del" style="color:var(--iz-danger);" title="删除这条">✕</button>'
                    + '</div></div>';
            }).join('');
        }
        const histHeader = $('izHistoryHeader'), histBody = $('izHistoryBody');
        if (histHeader && histBody) {
            wireCollapseA11y(histHeader, histBody);
            histHeader.addEventListener('click', () => {
                const isOpen = histBody.classList.contains('open');
                histBody.classList.toggle('open');
                $('izHistoryArrow').classList.toggle('open');
                $('izHistoryHint').innerHTML = isOpen ? '点开查看' : '点击收起';
                if (!isOpen) renderHistory();   // 展开时刷新（悬停可能新增了记录）
            });
            const histClear = $('izHistoryClearBtn');
            if (histClear) histClear.addEventListener('click', () => {
                clearHistory();
                renderHistory();
                iznSync();   // ★ 角标（导航栏历史条数）也要跟着归零，否则列表空了角标还挂着旧数
                showSaveToast('历史记录已清空');
            });
            const histList = $('izHistoryList');
            if (histList) histList.addEventListener('click', (e) => {
                const item = e.target.closest('[data-hid]');
                if (!item) return;
                const hid = item.getAttribute('data-hid');
                const actEl = e.target.closest('[data-act]');
                const act = actEl ? actEl.getAttribute('data-act') : '';
                const entry = getHistory().find(x => x && x.id === hid);
                if (act === 'del') { removeHistoryItem(hid); renderHistory(); iznSync(); }
                else if (act === 'open' && entry && typeof GM_openInTab === 'function') {
                    try { GM_openInTab(entry.u, { active: true }); } catch (err) { showSaveToast('打开失败'); }
                }
                else if (act === 'copy' && entry && typeof GM_setClipboard === 'function') {
                    GM_setClipboard(entry.u, 'text');
                    showSaveToast('已复制图片地址');
                }
            });
        }
        renderHistory();

        // ★ 一键找大图：把所有已知变换在这个地址上各试一遍，真实加载后按大小给用户挑。
        //   用户完全不需要懂正则——看到的缩略图就是最终效果。
        let autoCands = [];
        function loadImgForTest(url) {
            return new Promise(function (res) {
                const t = setTimeout(function () { res(null); }, 8000);
                const im = new Image();
                im.onload = function () { clearTimeout(t); res({ w: im.naturalWidth, h: im.naturalHeight }); };
                im.onerror = function () { clearTimeout(t); res(null); };
                im.src = url;
            });
        }
        async function autoFindBig(url) {
            const out = $('izUrlAutoOut');
            try {
            out.innerHTML = '<div style="font-size:12px;color:var(--iz-tx-muted);">正在尝试各种方式…</div>';
            const orig = await loadImgForTest(url);
            if (!orig) {
                out.innerHTML = '<div style="font-size:12px;color:var(--iz-danger);">这个地址打不开。请确认复制的是「图片地址」（右键图片 → 复制图片地址）。</div>';
                return;
            }
            const cands = []; const seen = new Set();
            activeHdRules.forEach(function (r) {
                (r.steps || []).forEach(function (s) {
                    // ★ 兼容两种步长格式：内置 [regex, replace]（2 元素）/ 规则包 [pattern, flags, replace]（3 元素）
                    const is3 = s.length > 2;
                    const pat = s[0], fl = is3 ? (s[1] || '') : '', rep = is3 ? s[2] : s[1];
                    let re = (pat instanceof RegExp) ? pat : new RegExp(pat, fl);
                    let c; try { c = url.replace(re, rep); } catch (e) { return; }
                    if (c && c !== url && !seen.has(c)) { seen.add(c); cands.push({ rule: { label: r.name || '自动优化', phase: 'hd', pattern: pat, flags: fl, replace: rep }, url: c }); }
                });
            });
            if (!cands.length) {
                const dbg = [];
                activeHdRules.forEach(function (r) {
                    let chg = false;
                    (r.steps || []).forEach(function (s) {
                        const is3 = s.length > 2;
                        const pat = s[0], fl = is3 ? (s[1] || '') : '', rep = is3 ? s[2] : s[1];
                        try { const re = (pat instanceof RegExp) ? pat : new RegExp(pat, fl); const t = url.replace(re, rep); if (t !== url) chg = true; } catch (e) { chg = 'ERR'; }
                    });
                    dbg.push((r.id || '?') + (chg === true ? '✓' : (chg === 'ERR' ? '✗err' : '·')));
                });
                out.innerHTML = '<div style="font-size:12px;color:var(--iz-tx-muted);line-height:1.6;">暂时没有已知的优化方式适用于这个地址。'
                    + '<br><span style="font-size:11px;">（诊断：' + dbg.join('，') + '）</span></div>';
                return;
            }
            const results = await Promise.all(cands.map(function (c) {
                return loadImgForTest(c.url).then(function (r) { return r ? { c: c, w: r.w, h: r.h } : null; });
            }));
            // 按位置对应：加载成功的带尺寸，失败的标「未验证」（不能靠 slice 尾部——失败项散布在 results 里）
            const loaded = results.map(function (r, i) { return r ? { c: cands[i], w: r.w, h: r.h } : null; }).filter(Boolean);
            const unverified = results.map(function (r, i) { return r ? null : { c: cands[i], w: 0, h: 0 }; }).filter(Boolean);
            autoCands = loaded.concat(unverified);
            if (!autoCands.length) {
                out.innerHTML = '<div style="font-size:12px;color:var(--iz-tx-muted);">这个地址没有可尝试的变换。</div>';
                return;
            }
            autoCands.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });   // 未验证(w=0)排最后
            const rowHtml = function (r, i) {
                return '<div style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--iz-bd-1);border-radius:var(--iz-r-sm);margin-bottom:6px;background:var(--iz-bg-4);">'
                    + '<img src="' + escapeHtml(r.c.url) + '" style="width:64px;height:64px;object-fit:cover;border-radius:4px;flex-shrink:0;">'
                    + '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--iz-tx-2);">' + (r.w ? (r.w + ' × ' + r.h) : '未验证') + '</div>'
                    + '<div style="font-size:11px;color:var(--iz-tx-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(r.c.url.slice(-72)) + '</div></div>'
                    + '<button class="iz-btn-sm primary" data-autoidx="' + i + '" style="flex-shrink:0;">就用这个</button></div>';
            };
            const biggerIdx = [], smallerIdx = [], unverIdx = [];
            autoCands.forEach(function (r, i) {
                if (!r.w) unverIdx.push(i);
                else if (r.w * r.h > orig.w * orig.h) biggerIdx.push(i);
                else smallerIdx.push(i);
            });
            let html = '';
            if (biggerIdx.length) {
                html += '<div style="font-size:12px;color:var(--iz-tx-2);margin-bottom:6px;">找到 ' + biggerIdx.length + ' 个更大的版本（原来 ' + orig.w + '×' + orig.h + '），点一个就用：</div>'
                    + biggerIdx.map(function (i) { return rowHtml(autoCands[i], i); }).join('');
            } else {
                html += '<div style="font-size:12px;color:var(--iz-tx-muted);margin-bottom:6px;">没有比原图（' + orig.w + '×' + orig.h + '）更大的版本。</div>';
            }
            if (smallerIdx.length) {
                html += '<details style="margin-top:6px;"><summary style="font-size:12px;color:var(--iz-tx-muted);cursor:pointer;user-select:none;">另有 ' + smallerIdx.length + ' 种方式，但没比原图大</summary>'
                    + '<div style="margin-top:6px;">' + smallerIdx.map(function (i) { return rowHtml(autoCands[i], i); }).join('') + '</div></details>';
            }
            if (unverIdx.length) {
                html += '<details style="margin-top:6px;"><summary style="font-size:12px;color:var(--iz-tx-muted);cursor:pointer;user-select:none;">未验证（加载失败，可手动试）' + unverIdx.length + ' 个</summary>'
                    + '<div style="margin-top:6px;">' + unverIdx.map(function (i) { return rowHtml(autoCands[i], i); }).join('') + '</div></details>';
            }
            out.innerHTML = html;
            } catch (e) {
                out.innerHTML = '<div style="font-size:12px;color:var(--iz-danger);">出错了：' + escapeHtml(String(e && e.message || e)) + '</div>';
            }
        }
        $('izUrlAutoBtn').addEventListener('click', function () {
            const v = $('izUrlAutoIn').value.trim();
            if (!v) { showSaveToast('请先粘贴图片地址'); return; }
            autoFindBig(v);
        });

        // ★ 点图选图：关面板 → 用户直接点网页图片 → 自动找大图（不用复制粘贴）
        function extractPickUrl(t) {
            let el = t, hops = 0;
            while (el && el !== document.body && hops < 4) {
                if (el.tagName === 'IMG') { const u = el.currentSrc || el.src || ''; if (u) return u; }
                try {
                    const bg = getComputedStyle(el).backgroundImage;
                    if (bg && bg !== 'none') { const m = bg.match(/url\((['"]?)(.+?)\1\)/); if (m && m[2] && m[2].indexOf('data:') !== 0) return m[2]; }
                } catch (e) { }
                el = el.parentElement; hops++;
            }
            return '';
        }
        let pickBar = null, pickClick = null, pickKeydown = null, pickStyle = null;
        function closePickUi() {
            urlPickMode = false;
            document.documentElement.classList.remove('hv-picking');
            if (pickClick) { window.removeEventListener('click', pickClick, true); pickClick = null; }
            if (pickKeydown) { window.removeEventListener('keydown', pickKeydown, true); pickKeydown = null; }
            if (pickBar) { pickBar.remove(); pickBar = null; }
            if (pickStyle) { pickStyle.remove(); pickStyle = null; }
        }
        function reopenPanelAfterPick() {
            const ov = document.getElementById('izModalOverlay');
            if (!ov || ov.style.display !== 'flex') toggleConfigPanel();
            const body = document.getElementById('izUrlRuleBody');
            if (body && !body.classList.contains('open')) { const h = document.getElementById('izUrlRuleHeader'); if (h) h.click(); }
            setTimeout(function () { const b = document.getElementById('izUrlAutoIn'); if (b) b.scrollIntoView({ block: 'center' }); }, 80);
        }
        $('izUrlPickBtn').addEventListener('click', function () {
            if (urlPickMode) return;
            urlPickMode = true;
            try { zoomFSM.dispatch('DISMISS'); } catch (e) { }   // 收起可能开着的预览
            const ov = document.getElementById('izModalOverlay');
            if (ov && ov.style.display === 'flex') ov.style.display = 'none';   // 面板让位，别挡图
            pickStyle = document.createElement('style');
            pickStyle.textContent = 'html.hv-picking, html.hv-picking *{cursor:crosshair!important}';
            document.documentElement.appendChild(pickStyle);
            document.documentElement.classList.add('hv-picking');
            pickBar = document.createElement('div');
            pickBar.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483000;background:rgba(15,23,42,.92);color:#fff;padding:10px 20px;border-radius:12px;font-size:13px;font-family:Arial,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap;';
            pickBar.textContent = '🖱 点击网页上想看大图的图片（Esc 取消）';
            document.body.appendChild(pickBar);
            pickKeydown = function (e) {
                if (e.key !== 'Escape') return;
                e.stopImmediatePropagation();
                closePickUi();
                reopenPanelAfterPick();
                showSaveToast('已取消选图');
            };
            window.addEventListener('keydown', pickKeydown, true);
            pickClick = function (e) {
                // 自有 UI 不算选图（面板此时已关，防误触 dock/预览层）
                if (e.target && e.target.closest && e.target.closest('#zoomDockZone, #izModalOverlay, #izIntroOverlay, #izUpdateNotice, #izHelpModal, .image-zoom-container')) return;
                const url = extractPickUrl(e.target);
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();   // 别点进链接 / 别触发页面行为
                closePickUi();
                if (url) {
                    $('izUrlAutoIn').value = url;
                    reopenPanelAfterPick();
                    autoFindBig(url);
                } else {
                    reopenPanelAfterPick();
                    showSaveToast('刚才点的不是图片，再点「点图选图」选一张网页图片');
                }
            };
            window.addEventListener('click', pickClick, true);
        });
        $('izUrlAutoOut').addEventListener('click', (e) => {
            const b = (e.target && e.target.closest) ? e.target.closest('[data-autoidx]') : null;
            if (!b) return;
            const cand = autoCands[Number(b.dataset.autoidx)];
            if (!cand || !cand.c) return;
            const ruleSrc = cand.c.rule;
            const patStr = (ruleSrc.pattern instanceof RegExp) ? ruleSrc.pattern.source : String(ruleSrc.pattern || '');
            config.userUrlRules = normalizeUserUrlRules((config.userUrlRules || []).concat([
                Object.assign({ phase: 'hd', enabled: true }, ruleSrc, { id: 'u' + Date.now(), label: (cand.w ? ('大图 ' + cand.w + '×' + cand.h) : '自动找的大图规则'), enabled: true, pattern: patStr }, readRuleScope())
            ]));
            commitUrlRules();
            showSaveToast('已保存！本站这类图片以后自动换大图 🎉');
            $('izUrlAutoOut').innerHTML = '';
            $('izUrlAutoIn').value = '';
        });

        // 高级：手写正则（保留给会写的人）
        $('izUrlRuleSave').addEventListener('click', () => {
            const pattern = $('izUrlPattern').value.trim();
            if (!pattern) { showSaveToast('正则 pattern 不能为空'); return; }
            const flags = $('izUrlFlags').value.trim().replace(/[^gimsuy]/g, '');
            try { new RegExp(pattern, flags); } catch (e) { showSaveToast('正则不合法：' + e.message); return; }
            config.userUrlRules = normalizeUserUrlRules((config.userUrlRules || []).concat([
                Object.assign({
                    id: 'u' + Date.now(),
                    label: $('izUrlLabel').value.trim(),
                    phase: segValue('izUrlPhase', 'hd') === 'clean' ? 'clean' : 'hd',
                    pattern: pattern, flags: flags, replace: $('izUrlReplace').value, enabled: true
                }, readRuleScope())
            ]));
            ['izUrlPattern', 'izUrlFlags', 'izUrlReplace', 'izUrlLabel'].forEach(function (id) { $(id).value = ''; });
            commitUrlRules();
            showSaveToast('规则已保存并立即生效');
        });
        $('izUrlRuleList').addEventListener('click', (e) => {
            const item = (e.target && e.target.closest) ? e.target.closest('.iz-urlrule-item') : null;
            if (!item) return;
            const id = item.dataset.id;
            if (e.target.classList.contains('iz-urlrule-enabled')) {
                config.userUrlRules = (config.userUrlRules || []).map(function (r) {
                    return r.id === id ? Object.assign({}, r, { enabled: e.target.checked }) : r;
                });
                commitUrlRules();
            } else if (e.target.classList.contains('iz-urlrule-del')) {
                config.userUrlRules = (config.userUrlRules || []).filter(function (r) { return r.id !== id; });
                commitUrlRules();
                showSaveToast('已删除该规则');
            }
        });
        // 贡献闭环：把当前站点的自定义规则导出为「可直接放进 rules/ 目录」的片段
        function buildRuleSnippet() {
            // 只导出「在当前站确实生效」的规则，避免把别的站的规则当成本站提交
            const rules = (config.userUrlRules || []).filter(function (r) {
                if (r.enabled === false) return false;
                if (r.scope === 'site' && r.domain && !packDomainMatches(currentDomain, r.domain)) return false;
                return true;
            });
            if (!rules.length) return null;
            return JSON.stringify({
                domain: currentDomain,
                label: currentDomain,
                note: '由用户在面板中导出；建议先在本站确认有效再提交',
                hd: rules.filter(function (r) { return r.phase !== 'clean'; }).map(function (r, i) {
                    return { id: 'u' + (i + 1), name: r.label || '原图还原', loop: false, steps: [[r.pattern, r.flags, r.replace]] };
                }),
                clean: rules.filter(function (r) { return r.phase === 'clean'; }).map(function (r, i) {
                    return { id: 'c' + (i + 1), name: r.label || '地址清理', loop: false, steps: [[r.pattern, r.flags, r.replace]] };
                })
            }, null, 1);
        }

        $('izUrlRuleShare').addEventListener('click', () => {
            const snippet = buildRuleSnippet();
            if (!snippet) { showSaveToast('还没有可导出的自定义规则'); return; }
            copyText(snippet).then(function (ok) {
                showSaveToast(ok ? '规则片段已复制，可粘贴到 rules/ 目录或提交 Issue' : '复制失败，请手动复制');
            });
        });

        // 一键提交：打开 GitHub 新建 Issue 页面，标题与正文已自动填好（同时把片段复制到剪贴板兜底）
        $('izUrlRuleFeedback').addEventListener('click', () => {
            const snippet = buildRuleSnippet();
            if (!snippet) { showSaveToast('先在本站加一条规则（用「帮我找大图」）再提交'); return; }
            try { copyText(snippet); } catch (e) { }
            const title = '[规则] ' + currentDomain + ' 大图还原';
            const body = [
                '### 站点', currentDomain, '',
                '### 规则片段（面板导出，已在本站验证）', '```json', snippet, '```', '',
                '### 环境',
                '- 悬景版本：' + SCRIPT_VERSION,
                '- 浏览器：' + navigator.userAgent, '',
                '> 由面板「一键提交到官方」生成；提交前请确认规则在本站确实有效。'
            ].join('\n');
            const url = 'https://github.com/YDGG123/hover-image-zoom/issues/new'
                + '?title=' + encodeURIComponent(title)
                + '&body=' + encodeURIComponent(body);
            // 优先用 GM_openInTab（脚本沙箱里 window.open 常被拦截）
            let opened = false;
            try {
                if (typeof GM_openInTab === 'function') { GM_openInTab(url, { active: true, insert: true }); opened = true; }
            } catch (e) { opened = false; }
            if (!opened) { try { opened = !!window.open(url, '_blank'); } catch (e) { opened = false; } }
            showSaveToast(opened ? '已打开 GitHub 提交页（内容已填好，规则片段也已复制）' : '未能自动打开：规则片段已复制，请手动打开 GitHub Issue');
        });
        // 参数说明气泡
        const oldTip = document.getElementById('izTipBubble');
        if (oldTip) oldTip.remove();
        const tipBubble = document.createElement('div');
        tipBubble.id = 'izTipBubble';
        document.body.appendChild(tipBubble);

        const showTip = (icon) => {
            tipBubble.textContent = icon.dataset.tip;
            const r = icon.getBoundingClientRect();
            tipBubble.style.opacity = '0';
            tipBubble.style.display = 'block';
            const bw = tipBubble.offsetWidth, bh = tipBubble.offsetHeight;
            let top = r.top - bh - 10;
            if (top < 8) top = r.bottom + 10;
            let left = r.left + r.width / 2 - bw / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
            tipBubble.style.top = top + 'px';
            tipBubble.style.left = left + 'px';
            tipBubble.style.opacity = '1';
        };
        const hideTip = () => { tipBubble.style.opacity = '0'; };

        overlay.addEventListener('mouseover', (e) => {
            const icon = e.target.closest('.iz-tip-icon');
            if (icon) showTip(icon);
        });
        overlay.addEventListener('mouseout', (e) => {
            if (e.target.closest('.iz-tip-icon')) hideTip();
        });

        function updateDetailState() {
            const isFixed = config.zoomMode === 'fixed';
            modeBadge.textContent = isFixed ? '以下 5 项参数参与计算' : '这些设置只在「固定倍数」模式下生效';
            const lock = $('iznFixedLock'), card = $('iznFixedCard');
            if (lock) lock.hidden = isFixed;
            if (card) card.classList.toggle('izn-locked', !isFixed);
            overlay.querySelectorAll('.iz-slider-row').forEach(row => {
                const off = FIXED_PARAM_DEFS.some(p => p.key === row.dataset.param) && !isFixed;
                row.querySelectorAll('input').forEach(i => { i.disabled = off; });
                row.classList.toggle('disabled-group', off);
            });
        }

        // ===== 数值参数：滑块 + 数字框 =====
        //   滑块拖动时只改内存 + 界面（避免高频写存储），松手（change）才落盘并提示；
        //   数字框保留精确输入能力，回车或失焦生效。两者始终双向同步。
        function paintSlider(sl) {
            const mn = parseFloat(sl.min), mx = parseFloat(sl.max), v = parseFloat(sl.value);
            const p = mx > mn ? Math.max(0, Math.min(100, ((v - mn) / (mx - mn)) * 100)) : 0;
            sl.style.setProperty('--fill', p.toFixed(2) + '%');
        }
        function markModified(key, val) {
            const item = overlay.querySelector('.iz-param-item[data-mod-key="' + key + '"]');
            if (item) item.classList.toggle('mod', Number(val) !== Number(defaultConfig[key]));
        }
        function syncParamControls(key, val, except) {
            overlay.querySelectorAll('[data-param="' + key + '"]').forEach(el => {
                if (el.tagName !== 'INPUT' || el === except) return;   // 只同步输入控件（slider-row 容器也带 data-param）
                if (String(el.value) !== String(val)) el.value = val;
            });
            overlay.querySelectorAll('.iz-slider[data-param="' + key + '"]').forEach(paintSlider);
            markModified(key, val);
        }
        function commitParam(key, val) {
            const def = COMMON_PARAM_DEFS.concat(FIXED_PARAM_DEFS).find(p => p.key === key);
            if (isNaN(val)) val = defaultConfig[key];
            // ★ BUG-2 修复：把值对齐到「滑块步进」网格，保证数字框与滑块取值完全一致。
            //   滑块步进取 min(定义步进, 1)：整数参数可用任意整数、小数参数保持 0.1 精度。
            //   此前数字框可留 830，而 step=100 的滑块只能吸附 800，二者错位误导用户。
            if (def && def.step) {
                const step = Math.min(Number(def.step) || 1, 1);
                const base = (typeof def.min === 'number') ? def.min : 0;
                val = Math.round((val - base) / step) * step + base;
                val = Math.round(val * 1000) / 1000;
            }
            if (CONFIG_LIMITS[key]) {
                const lim = CONFIG_LIMITS[key];
                val = Math.max(lim[0], Math.min(lim[1], val));
            }
            config[key] = val;
            saveConfig();
            syncParamControls(key, val);
            notifyConfigSaved(key, val, def ? def.label : key);
        }
        overlay.querySelectorAll('.iz-slider').forEach(sl => {
            const key = sl.dataset.param;
            paintSlider(sl);
            sl.addEventListener('input', () => {
                paintSlider(sl);
                config[key] = parseFloat(sl.value);
                syncParamControls(key, sl.value, sl);
            });
            sl.addEventListener('change', () => {
                commitParam(key, parseFloat(sl.value));
                const num = overlay.querySelector('.iz-param-num[data-param="' + key + '"]');
                if (num) { num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop'); }
                if (key === 'maxWidth' || key === 'maxHeight') syncSizeStep();
            });
        });
        overlay.querySelectorAll('.iz-param-num').forEach(num => {
            const key = num.dataset.param;
            const apply = () => {
                commitParam(key, parseFloat(num.value));
                if (key === 'maxWidth' || key === 'maxHeight') syncSizeStep();
            };
            num.addEventListener('change', apply);
            num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); num.blur(); } });
        });

        // ===== 分段控件（替代下拉框）=====
        function syncSeg(key, val) {
            const seg = overlay.querySelector('.iz-seg[data-seg="' + key + '"]');
            if (!seg) return;
            seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(b.dataset.val) === String(val)));
        }
        // ★ 放大模式：两张动画大卡（不再是下拉/分段，因为这是决定全局行为的关键选项）
        function syncZoomModes() {
            const box = $('iznZoomModes');
            if (!box) return;
            const cur = config.zoomMode === 'fixed' ? 'fixed' : 'adaptive';
            box.querySelectorAll('.izn-mode').forEach(b => b.classList.toggle('on', b.dataset.mode === cur));
        }
        const zoomModesBox = $('iznZoomModes');
        if (zoomModesBox) {
            zoomModesBox.addEventListener('click', (e) => {
                const btn = (e.target && e.target.closest) ? e.target.closest('.izn-mode') : null;
                if (!btn) return;
                config.zoomMode = btn.dataset.mode === 'fixed' ? 'fixed' : 'adaptive';
                saveConfig();
                syncZoomModes();
                updateDetailState();
                showSaveToast('已切到 ' + (config.zoomMode === 'fixed' ? '固定倍数' : '智能自适应') + ' 模式');
            });
        }
        // ★ 预览尺寸：4 档方块（方块大小 = 大图大小）
        function syncSizeStep() {
            const box = $('iznSizeSteps');
            if (!box) return;
            const idx = sizeStepIndex();
            box.querySelectorAll('.izn-size').forEach(b => b.classList.toggle('on', String(b.dataset.val) === String(idx)));
        }
        const sizeStepsBox = $('iznSizeSteps');
        if (sizeStepsBox) {
            sizeStepsBox.addEventListener('click', (e) => {
                const btn = (e.target && e.target.closest) ? e.target.closest('.izn-size') : null;
                if (!btn) return;
                const s = SIZE_STEPS[parseInt(btn.dataset.val, 10)];
                if (!s) return;
                config.maxWidth = s.w;
                config.maxHeight = s.h;
                saveConfig();
                syncParamControls('maxWidth', s.w);
                syncParamControls('maxHeight', s.h);
                syncSizeStep();
                showSaveToast('预览尺寸：' + s.name);
            });
        }
        // 规则区两个分段控件（urlScope / urlPhase）只作为「下一条规则」的默认值，
        // 由 readRuleScope 与保存时读取，无需落盘 —— 这里只负责切换选中态。
        overlay.querySelectorAll('.iz-seg[data-seg]').forEach(seg => {
            seg.addEventListener('click', (e) => {
                const btn = (e.target && e.target.closest) ? e.target.closest('button[data-val]') : null;
                if (!btn || !seg.contains(btn)) return;
                seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
            });
        });

        $('izHpToggleBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleHomepageDisabled();
        });

        // 显示位置（center/around）两卡片
        function syncPlaces() {
            const cur = config.previewPlacement || 'center';
            overlay.querySelectorAll('#iznPlaces .izn-place').forEach(p => p.classList.toggle('on', p.dataset.place === cur));
        }
        syncPlaces();
        overlay.__iznSyncPlaces = syncPlaces;
        overlay.querySelectorAll('#iznPlaces .izn-place').forEach(p => p.addEventListener('click', () => {
            config.previewPlacement = p.dataset.place;
            saveConfig();
            syncPlaces();
            const names = { center: '屏幕居中', around: '原图周围（不遮挡）' };
            showSaveToast(`显示位置：${names[config.previewPlacement]}（下次预览生效）`);
        }));

        // 出现方式（dock/spotlight/fade）三卡片
        function syncTransitions() {
            const cur = config.previewTransition || 'dock';
            overlay.querySelectorAll('#iznTransitions .izn-place').forEach(p => p.classList.toggle('on', p.dataset.fx === cur));
        }
        syncTransitions();
        overlay.__iznSyncTransitions = syncTransitions;
        overlay.querySelectorAll('#iznTransitions .izn-place').forEach(p => p.addEventListener('click', () => {
            config.previewTransition = p.dataset.fx;
            saveConfig();
            syncTransitions();
            const names = { dock: '从原图弹出', spotlight: '从原图绽开', fade: '直接淡入' };
            showSaveToast('出现方式：' + (names[config.previewTransition] || config.previewTransition) + '（下次预览生效）');
        }));

        // ===== izn 导航 / 总览同步 / 总开关 =====
        const iznContent = $('iznContent');
        function iznGo(view) {
            overlay.querySelectorAll('.izn-nav-item').forEach(x => x.classList.toggle('on', x.dataset.view === view));
            overlay.querySelectorAll('.izn-view').forEach(v => v.classList.toggle('on', v.dataset.view === view));
            if (iznContent) iznContent.scrollTop = 0;
        }
        overlay.querySelectorAll('.izn-nav-item').forEach(x => x.addEventListener('click', () => iznGo(x.dataset.view)));
        overlay.querySelectorAll('[data-izn-go]').forEach(b => b.addEventListener('click', () => iznGo(b.dataset.iznGo)));
        function iznSync() {
            try {
                const master = $('iznMasterWrap');
                if (master) {
                    master.setAttribute('aria-checked', String(isEnabled));
                    const tg = master.querySelector('.iz-toggle');
                    if (tg) tg.classList.toggle('active', isEnabled);
                }
                const rs = $('iznRuleSummary');
                if (rs) rs.textContent = (config.userUrlRules || []).filter(r => r.enabled !== false).length + ' 条';
                const ps = $('iznPackSummary');
                if (ps) { const m = (typeof rulePackState !== 'undefined' && rulePackState.meta) || {}; ps.textContent = m.version ? ('v' + m.version) : '未加载'; }
                const ht = $('iznHistTag');
                if (ht) { try { const h = storageGet('hvHistoryV1', []); ht.textContent = Array.isArray(h) ? h.length : 0; } catch (e) { } }
            } catch (e) { }
        }
        overlay.__iznGo = iznGo; overlay.__iznSync = iznSync;

        // ★ 面板控件「单一同步入口」：把每个控件校正为「当前 config + isEnabled + 哔哩开关」的真实状态。
        //   「打开面板」与「恢复默认设置」都走这里 —— 此前两处各写一份，reset 那份漏了
        //   入场动效 / 视频悬停 / 总开关 / 显示位置，导致恢复默认后 UI 残留旧值；
        //   最严重的是总开关关掉后 reset 不恢复为开（config 里没有 isEnabled，它独立持久化）。
        function syncPanelFromState() {
            try { syncZoomModes(); } catch (e) { }
            try { conflictToggle.classList.toggle('active', config.avoidClickConflict); } catch (e) { }
            const bt = $('izBlurDismissToggle'); if (bt) bt.classList.toggle('active', config.blurDismiss);
            const wt = $('izWheelZoomToggle'); if (wt) wt.classList.toggle('active', config.wheelZoom);
            const it = $('izImageInfoToggle'); if (it) it.classList.toggle('active', config.showImageInfo);
            const vt = $('izVideoHoverToggle'); if (vt) vt.classList.toggle('active', config.videoHoverPreview);
            const bl = $('izBiliToggle'); if (bl) bl.classList.toggle('active', bilibiliVolumeModule.isEnabled);
            // 数值参数：滑块与数字框一起校正，并重绘填充色与「已改」标记
            COMMON_PARAM_DEFS.concat(FIXED_PARAM_DEFS).forEach(p => syncParamControls(p.key, config[p.key]));
            syncPlaces();        // 显示位置卡片选中态
            syncTransitions();   // 出现方式卡片选中态
            syncSizeStep();      // 预览尺寸档位选中态
            // ★ 历史列表条目也要一起刷新：悬停预览会持续写入历史，而 renderHistory 原先只在
            //   面板「构建时 / 折叠展开时 / 删除时」调用 → 重开面板看到的是陈旧列表
            //   （角标 iznHistTag 却由 iznSync 更新过，于是出现「角标 4 条、列表 0 条」的错位）。
            renderHistory();
            iznSync();          // 总开关 aria-checked + 规则/规则包/历史条数角标
        }
        overlay.__izSyncAll = syncPanelFromState;

        // 总开关：isEnabled（image_zoom_enabled_<域名>），等效控制球。
        // 用 overlay 捕获阶段委托（点击目标无论被内部结构如何包裹都能命中）。
        overlay.addEventListener('click', (e) => {
            const wrap = (e.target && e.target.closest) ? e.target.closest('#iznMasterWrap') : null;
            if (!wrap) return;
            e.stopPropagation();
            isEnabled = !isEnabled;
            storageSet('image_zoom_enabled_' + currentDomain, isEnabled);
            wrap.setAttribute('aria-checked', String(isEnabled));
            const tg = $('iznMasterToggle');
            if (tg) tg.classList.toggle('active', isEnabled);
            try { updateButtonState(); } catch (err) { }   // 同步 dock 球的颜色/状态点
            showSaveToast(isEnabled ? '已启用本网站图片放大' : '已停用本网站图片放大');
            if (!isEnabled) { try { zoomFSM.dispatch('RESET'); } catch (err) { } }
        }, true);

        $('izConflictWrap').addEventListener('click', (e) => {
            e.stopPropagation();
            config.avoidClickConflict = !config.avoidClickConflict;
            conflictToggle.classList.toggle('active', config.avoidClickConflict);
            saveConfig();
            showSaveToast(`避免与点击放大功能冲突 ${config.avoidClickConflict ? '已开启' : '已关闭'}`);
        });

        $('izBlurDismissWrap').addEventListener('click', (e) => {
            e.stopPropagation();
            config.blurDismiss = !config.blurDismiss;
            $('izBlurDismissToggle').classList.toggle('active', config.blurDismiss);
            saveConfig();
            showSaveToast(`窗口失焦时收起放大图 ${config.blurDismiss ? '已开启' : '已关闭（切换应用时保留预览）'}`);
        });

        $('izWheelZoomWrap').addEventListener('click', (e) => {
            e.stopPropagation();
            config.wheelZoom = !config.wheelZoom;
            $('izWheelZoomToggle').classList.toggle('active', config.wheelZoom);
            saveConfig();
            showSaveToast(`滚轮控制放大图缩放 ${config.wheelZoom ? '已开启' : '已关闭（恢复上下移动）'}`);
        });

        $('izVideoHoverWrap').addEventListener('click', (e) => {
            e.stopPropagation();
            config.videoHoverPreview = !config.videoHoverPreview;
            $('izVideoHoverToggle').classList.toggle('active', config.videoHoverPreview);
            saveConfig();
            if (!config.videoHoverPreview) videoPreviewModule.hide();
            showSaveToast(`视频悬停预览 ${config.videoHoverPreview ? '已开启' : '已关闭'}`);
        });

        $('izImageInfoWrap').addEventListener('click', (e) => {
            e.stopPropagation();
            config.showImageInfo = !config.showImageInfo;
            $('izImageInfoToggle').classList.toggle('active', config.showImageInfo);
            saveConfig();
            // 关闭时若正有放大图在显示，顺手把已渲染的浮层摘掉
            if (!config.showImageInfo) {
                const live = document.querySelector('#izImageInfo');
                if (live) live.remove();
                const liveBar = document.querySelector('.hv-capbar');
                if (liveBar) liveBar.remove();
            }
            showSaveToast(`图片信息栏 ${config.showImageInfo ? '已开启' : '已关闭'}`);
        });

        // 键位区：与其它折叠区完全一致的交互
        const keymapHeader = $('izKeymapHeader');
        const keymapBody = $('izKeymapBody');
        const keymapArrow = $('izKeymapArrow');
        const keymapHint = $('izKeymapHint');
        if (keymapHeader && keymapBody) {
            wireCollapseA11y(keymapHeader, keymapBody);
            keymapHeader.addEventListener('click', () => {
                const isOpen = keymapBody.classList.contains('open');
                keymapBody.classList.toggle('open');
                keymapArrow.classList.toggle('open');
                keymapHint.innerHTML = isOpen ? '点右侧按键即可改绑' : '点击收起';
            });
        }

        $('iznToFixedBtn').addEventListener('click', () => {
            config.zoomMode = 'fixed';
            saveConfig();
            syncZoomModes();
            updateDetailState();
            showSaveToast('已切到固定倍数模式');
        });

        $('izBiliWrap').addEventListener('click', (e) => {
            e.stopPropagation();
            const newState = !bilibiliVolumeModule.isEnabled;
            bilibiliVolumeModule.setEnabled(newState);
            biliToggle.classList.toggle('active', newState);
            showSaveToast(`B站播放器辅助 ${newState ? '已启用' : '已禁用'}`);
        });

        // ===== 键位：可视化改绑 =====
        const keymapGrid = $('izKeymapGrid');
        let keyRecording = null;
        config.keymap = normalizeKeymap(config.keymap);   // 兜底，避免旧配置缺字段

        function keyCapText(action) {
            const list = (config.keymap && config.keymap[action]) || [];
            return list.length ? list.map(displayKeyName).join(' / ') : '未设置';
        }
        function renderKeymap() {
            if (!keymapGrid) return;
            keymapGrid.innerHTML = KEYMAP_ACTION_DEFS.map(function (d) {
                return '<div class="iz-key-row"><div class="iz-key-name"><b>' + escapeHtml(d.name) + '</b><span>'
                    + escapeHtml(d.hint) + '</span></div><button type="button" class="iz-key-cap" data-km="' + d.key + '">'
                    + escapeHtml(keyCapText(d.key)) + '</button></div>';
            }).join('');
        }
        function stopKeyRecord() {
            if (!keyRecording) return;
            window.removeEventListener('keydown', onKeyRecord, true);
            keyRecording = null;
        }
        // 录制：捕获阶段拦截，避免被面板自身的 Esc/其它快捷键吃掉
        function onKeyRecord(e) {
            if (!keyRecording) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { stopKeyRecord(); renderKeymap(); return; }
            if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified'].indexOf(e.key) >= 0) return;
            const k = e.key;
            // 一个键只归一个动作：先从其它动作里摘掉，避免同一个键绑两处
            // （若该键原本绑在别的动作上，提示去向，用户不会疑惑「原来的键怎么失效了」）
            const stolen = [];
            Object.keys(config.keymap).forEach(function (a) {
                if (a !== keyRecording) {
                    const before = (config.keymap[a] || []).length;
                    config.keymap[a] = (config.keymap[a] || []).filter(function (x) { return x !== k; });
                    if (config.keymap[a].length < before) stolen.push(a);
                }
            });
            config.keymap[keyRecording] = [k];
            // ★ 让出后若原动作变空（「未设置」），回退到它的默认键（前提：该默认键当前未被任何动作占用）。
            //   旧版让出后原动作永久「未设置」、功能失去快捷键（2026-09-19 全功能实机测试问题 3）。
            const usedKeys = new Set();
            Object.keys(config.keymap).forEach(function (a) {
                (config.keymap[a] || []).forEach(function (x) { usedKeys.add(x); });
            });
            const restored = [];
            stolen.forEach(function (a) {
                if ((config.keymap[a] || []).length) return;
                const free = (KEYMAP_DEFAULTS[a] || []).filter(function (x) { return !usedKeys.has(x); });
                if (!free.length) return;
                config.keymap[a] = free.slice();
                free.forEach(function (x) { usedKeys.add(x); });
                restored.push(a);
            });
            saveConfig();
            saveGlobalKeymap(config.keymap);   // ★ 键位全局：同步写入全局键
            stopKeyRecord();
            renderKeymap();
            if (stolen.length) {
                const nameOf = function (a) {
                    const d = KEYMAP_ACTION_DEFS.find(function (x) { return x.key === a; });
                    return d ? d.name : a;
                };
                let msg = '「' + k + '」已从「' + nameOf(stolen[0]) + '」移到当前动作';
                if (restored.length) {
                    msg += '；「' + nameOf(restored[0]) + '」已恢复默认键 '
                        + (KEYMAP_DEFAULTS[restored[0]] || []).map(displayKeyName).join(' / ');
                } else {
                    // 默认键也已被占用 → 无法自动回退；明确告知「去哪恢复」，避免用户不知原动作为何失效
                    const lost = stolen.filter(function (a) { return (config.keymap[a] || []).length === 0; });
                    if (lost.length) {
                        msg += '；「' + nameOf(lost[0]) + '」已失去快捷键，点它的键帽可重新设置';
                    }
                }
                showSaveToast(msg);
            }
        }
        if (keymapGrid) {
            renderKeymap();
            keymapGrid.addEventListener('click', function (e) {
                const btn = (e.target && e.target.closest) ? e.target.closest('.iz-key-cap') : null;
                if (!btn) return;
                stopKeyRecord();
                keyRecording = btn.dataset.km;
                btn.classList.add('recording');
                btn.textContent = '按下按键…';
                window.addEventListener('keydown', onKeyRecord, true);
            });
            // 恢复默认键位（只动键表，不动其它设置）
            const kmReset = $('izKeymapResetBtn');
            if (kmReset) kmReset.addEventListener('click', function () {
                if (!confirm('把所有按键恢复为默认键位？')) return;
                config.keymap = normalizeKeymap(null);
                saveConfig();
                saveGlobalKeymap(config.keymap);   // ★ 键位全局：默认键位也要落全局键
                stopKeyRecord();
                renderKeymap();
                showSaveToast('已恢复默认键位');
            });
        }

        $('izResetBtn').addEventListener('click', () => {
            if (!confirm('确定恢复当前网站的默认设置吗？\n其它网站不受影响；全局键位也会保留。')) return;
            // ★ 键位表是全局配置（跨网站共享），不随「恢复本站默认」一起重置 ——
            //   否则用户在某站误点一次重置，所有网站的自定义键位都会丢。
            const keepKeymap = normalizeKeymap(config.keymap);
            config = { ...defaultConfig };
            config.keymap = keepKeymap;
            saveConfig();
            // ★ 总开关（isEnabled / image_zoom_enabled_<域名>）是独立持久化的，不在 defaultConfig 里。
            //   只重置 config 不重置它，就会出现「点了恢复默认，脚本仍被静默禁用、hover 无反应」，
            //   而且用户从面板 UI 上看不出已被禁用 —— 必须四处一起同步（存储 / 内存变量 /
            //   面板开关 / dock 球），漏任何一处都表现为「状态不一致」。
            isEnabled = true;
            storageSet('image_zoom_enabled_' + currentDomain, true);
            try { updateButtonState(); } catch (e) { }   // 同步 dock 球的颜色/状态点
            syncPanelFromState();                        // 面板全部控件（含总开关/出现方式/视频悬停/显示位置）
            updateDetailState();
            renderKeymap();       // 键位区跟随（全局键位未被改动，这里只是重绘）
            showToast('已恢复本站默认设置');
        });

        $('izExportBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            exportConfigToFile();
        });

        const izImportInput = $('izImportInput');
        $('izImportBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            izImportInput.click();
        });
        izImportInput.addEventListener('click', (e) => e.stopPropagation());
        izImportInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            importConfigFromFile(file, (res) => {
                // 面板是照打开时的 config 渲染的，逐项同步容易漏；整块重建最稳，
                // 「站点规则自定义」区也会按导入后的规则重新渲染。
                const msg = '已导入 ' + res.ok + ' 项配置' + (res.skipped ? '，跳过 ' + res.skipped + ' 项' : '') + ' ✅';
                closePanel();
                // ★ 提示必须等面板重建完成后再显示。showToast 在「面板开着」时会走
                //   showPanelCenterToast，把提示节点挂进 #izConfigPanel 内部；而这里紧接着就把
                //   整个 overlay remove() 掉了 → 提示随父节点一起消失（实测只活了 ~11ms→306ms），
                //   用户根本读不到。放到重建之后再调，提示就会挂到新面板上。
                setTimeout(() => { overlay.remove(); toggleConfigPanel(); showToast(msg); }, 320);
            });
            e.target.value = '';  // 清空以便连续导入同一个文件
        });

        function closePanel() {
            overlay.classList.add('anim-out');
            setTimeout(() => {
                overlay.style.display = 'none';
                overlay.classList.remove('anim-out');
            }, 300);
        }

        $('izCloseBtn').addEventListener('click', closePanel);
        $('izHelpBtn').addEventListener('click', (e) => { e.stopPropagation(); showHelpModal('usage'); });
        $('izChangelogBtn').addEventListener('click', (e) => { e.stopPropagation(); showHelpModal('changelog'); });

        // 反馈问题：自动附小尺寸截图（若有预览过图片）+ 预填环境信息的 GitHub Issue
        $('izFeedbackBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            // 1) 截图落盘（本地，不上传任何服务器；GitHub 提交时用户自行拖入）
            let shotName = '';
            if (lastPreviewShotData) {
                shotName = 'hv-feedback-screenshot.png';
                try {
                    if (typeof GM_download === 'function') {
                        GM_download({ url: lastPreviewShotData, name: shotName, saveAs: false, onerror: function () { } });
                    } else {
                        downloadViaAnchor(lastPreviewShotData, shotName);
                    }
                } catch (err) { shotName = ''; }
            }
            // 2) 预填 Issue：环境信息 + 截图指引
            let ver = '', handler = '';
            try {
                if (typeof GM_info !== 'undefined') {
                    ver = GM_info.script && GM_info.script.version;
                    handler = (GM_info.scriptHandler || '') + (GM_info.version ? ' ' + GM_info.version : '');
                }
            } catch (err) { }
            const body = [
                '### 问题描述', '', '（请在这里描述遇到的问题）', '',
                '### 复现步骤', '', '1. ', '2. ', '',
                '### 环境信息',
                '- 脚本版本: ' + (ver || '未知'),
                '- 脚本管理器: ' + (handler || '未知'),
                '- 出问题的页面: ' + location.href,
                '- User-Agent: ' + navigator.userAgent, '',
                '### 附件',
                shotName
                    ? '已自动保存截图 `' + shotName + '`（在浏览器下载目录），请把该图片拖进上面的编辑框一并提交。'
                    : '未能自动截图（最近没有预览过图片或图片受跨域保护），可自行截图后拖进编辑框。'
            ].join('\n');
            const url = 'https://github.com/YDGG123/hover-image-zoom/issues/new'
                + '?title=' + encodeURIComponent('[反馈] ')
                + '&body=' + encodeURIComponent(body);
            try { GM_openInTab(url, { active: true }); } catch (err) { window.open(url, '_blank'); }
            showSaveToast(shotName ? '已保存截图并打开反馈页' : '已打开反馈页');
        });
        $('izSaveBtn').addEventListener('click', () => {
            showSaveToast('设置已保存');
            setTimeout(closePanel, 350);
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closePanel();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display === 'flex') closePanel();
        });

        refreshPanelHomepageSection();
        updateDetailState();
        return overlay;
    }

    function toggleConfigPanel() {
        let overlay = document.getElementById('izModalOverlay');
        if (!overlay) overlay = createConfigPanel();
        if (overlay.style.display === 'flex') {
            overlay.style.display = 'none';
            return;
        }
        // ★ 每次打开面板都把「总览」与「全部控件」校正为真实状态（统一入口见 syncPanelFromState）
        //   （此前这几行被误插进了欢迎弹窗，导致面板一直显示陈旧的「已关闭」）
        if (overlay.__iznGo) overlay.__iznGo('overview');
        const syncAll = () => { if (overlay.__izSyncAll) overlay.__izSyncAll(); else if (overlay.__iznSync) overlay.__iznSync(); };
        syncAll();
        setTimeout(syncAll, 80);
        refreshPanelHomepageSection();
        overlay.classList.add('anim-in');
        overlay.style.display = 'flex';
        setTimeout(() => overlay.classList.remove('anim-in'), 400);
    }


    // ================
    // 12. 主初始化
    // ================
    // ===== 颜色标记说明 =====
    // 🟢 绿区：性能/结构优化区域，可优先修改
    // 🟡 黄区：兼容性相关区域，修改后需重点测试网站
    // 🔴 红区：hover放大核心链路，避免直接重构
    function mainInit() {
        loadConfig();
        loadState();
        injectStyles();
        // ★ 调试钩子：仅在 URL 带 ?hvdebug=1 时暴露，用于端到端验证（如防盗链抓取），不影响正常使用
        try {
            if (/[?&]hvdebug=1/.test(location.search)) {
                window.__hvDebug = { gmFetchBlobUrl, upgradeImgUrl, buildHdCandidates, sizeHintOf, probeCandidates, pickBestCandidate, VERSION: SCRIPT_VERSION };
            }
        } catch (e) { }
        // ★ UI 入口（dock 控制球/介绍面板/更新弹窗）只在顶层 frame 创建：
        // iframe 里再浮一个控制球既无必要，还会与顶层 UI 重叠、拦截鼠标事件。
        if (IS_TOP) {
            createDockButton();
            if (isEnabled) {
                setTimeout(showIntroPanel, 180);
                setTimeout(showUpdateNotice, 260);
            }
        }
        // ★ frame 被卸载（SPA 路由/iframe 移除）时释放仲裁心跳，别让别的 frame 等 TTL
        window.addEventListener('pagehide', () => arbiterStopRenew());

        // ★ 全局 mousemove：坐标权威源（停稳裁决器/心跳/TIMER_FIRE 使用）。
        // 直接写入不节流——handler 本身只有三次赋值，开销可忽略；
        // 停稳裁决器通过 debounce 自身控制频率，无需在此节流。
        document.addEventListener('mousemove', (e) => {
            const x = e.clientX, y = e.clientY;
            const wasResumeBlocked = resumeBlockedUntilMouseMove;
            // ★ 关键修复：切回窗口时浏览器可能补发 mousemove，甚至坐标会发生微小变化。
            // 在恢复保护期间，只接受真正带有物理指针位移的 mousemove。
            // movementX/movementY 是浏览器提供的本次指针位移量；切回窗口产生的补发事件通常为 0。
            const physicalMouseMove = Number(e.movementX || 0) !== 0 || Number(e.movementY || 0) !== 0;
            const movedAfterResume = !wasResumeBlocked || physicalMouseMove;

            // ★ 恢复保护期间，浏览器可能补发“假 mousemove”。
            // 这类事件不仅不能解除保护，也不应污染 lastMouse 的权威坐标；
            // 否则切回窗口时旧坐标可能被补发事件覆盖，后续停稳裁决/心跳会误判。
            if (!wasResumeBlocked || physicalMouseMove) {
                lastMouse.x = x;
                lastMouse.y = y;
                lastMouse.t = Date.now();
                if (hoverWaitIndicator && hoverWaitIndicator.classList.contains('show')) {
                    positionHoverWaitIndicator(x, y + 22);
                }
                pointerInWindow = true;
                browserWindowFocused = true;
            }

            // ★ 切换应用后的恢复保护：没有真实鼠标位移就一直保持阻塞。
            // 防止 Alt+Tab / Finder / 文件管理器切回时自动补发事件再次触发放大。
            if (movedAfterResume) {
                resumeBlockedUntilMouseMove = false;
            }
        }, { passive: true });

        window.addEventListener('resize', debounce(() => {
            invalidateLightboxState();
            if (isEnabled) zoomFSM.dispatch('DISMISS');
        }, 250));

        setupLightboxObserver();
        if (isEnabled) initImages();
        bilibiliVolumeModule.init();         setupGlobalHoverStream(); // ★ mouseover 流 + 停稳裁决器 双保险
        videoPreviewModule.init();           // ★ 视频悬停预览：滚动/失焦/变形即关闭
        setupHeartbeat();         // ★ 持续复核（PENDING/ACTIVE，带失败容忍，后台页暂停）
        setupBgRuleProxy();
        setupAutoBackgroundHover();
        // ★ 规则包：先用本地缓存立刻生效，再按需后台更新（失败静默降级，不影响基本功能）
        loadRulePackFromStorage();
        if (config.rulePackAuto) setTimeout(function () { updateRulePack(false); }, 1500);
        keymapModule.init();   // ★ 键位系统：Esc 关闭 / +/- 缩放 / 0 原始尺寸
        startObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mainInit);
    } else {
        mainInit();
    }
})();
