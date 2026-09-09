// ==UserScript==
// @name         鼠标悬停图片自动放大预览
// @namespace    https://github.com/YDGG123
// @version      5.6.41
// @description  网页图片鼠标悬停自动放大工具：智能自适应、高清图后台升级、滚轮边界控制
// @author       益达哥哥
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      damp-woodpecker-4867.ydgg123.deno.net
// @run-at       document-end
// @noframes
// @license      MIT
// @homepageURL  https://github.com/YDGG123/hover-image-zoom
// @supportURL   https://github.com/YDGG123/hover-image-zoom/issues
// @downloadURL  https://raw.githubusercontent.com/YDGG123/hover-image-zoom/main/hover-image-zoom.user.js
// ==/UserScript==

(function() {
    'use strict';

const SCRIPT_VERSION = "5.6.41";

    // ================
    // ★ 存储适配层（当前仍使用 Tampermonkey GM_*，仅抽象接口，不改变行为）
    // 后续迁移浏览器扩展时，只需要替换这里的实现。
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

    const FADE_MS = 300;
    const HEARTBEAT_MS = 150;

    // 坐标权威源：只由 mousemove 写入。
    // 停稳裁决器与后续校验（心跳/TIMER_FIRE）使用
    const lastMouse = { x: -1, y: -1, t: 0 };

    // ★ 光标是否在浏览器窗口内：mouseout(relatedTarget=null) 置 false，mousemove 置 true。
    // 原生窗口（文件管理器等）覆盖浏览器时，DOM 对遮挡毫无感知，
    // elementFromPoint 和 lastMouse 都会给出"光标仍在图上"的假象，必须靠此标记纠偏
    let pointerInWindow = true;

    const currentDomain = getDomain();


    // ★ 面板中央提示：配置面板打开时，所有提示统一显示在面板正中央
    let panelToastEl = null, panelToastTimer = null;

    function showPanelCenterToast(message) {
        const overlay = document.getElementById('izModalOverlay');
        const panel = overlay && overlay.querySelector('#izConfigPanel');
        if (!panel || !overlay || overlay.style.display !== 'flex') return false;
        panel.style.position = 'relative';
        if (!panelToastEl || panelToastEl.parentNode !== panel) {
            if (panelToastEl) panelToastEl.remove();
            panelToastEl = document.createElement('div');
            panelToastEl.id = 'izPanelToast';
            panelToastEl.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) translateY(10px);
                background:rgba(15,23,42,.88);color:#fff;padding:10px 22px;border-radius:14px;font-size:13px;font-weight:500;
                font-family:Arial,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.35);opacity:0;pointer-events:none;z-index:100006;
                max-width:360px;text-align:center;white-space:nowrap;transition:opacity .25s ease,transform .25s ease;`;
            panel.appendChild(panelToastEl);
        }
        panelToastEl.textContent = '✅ ' + message;
        void panelToastEl.offsetWidth;
        panelToastEl.style.opacity = '1';
        panelToastEl.style.transform = 'translate(-50%,-50%) translateY(0)';
        clearTimeout(panelToastTimer);
        panelToastTimer = setTimeout(() => {
            if (panelToastEl) {
                panelToastEl.style.opacity = '0';
                panelToastEl.style.transform = 'translate(-50%,-50%) translateY(10px)';
            }
        }, 1500);
        return true;
    }

    function showToast(message, duration = 2000) {
        if (showPanelCenterToast(message)) return; // 面板开着 → 显示在面板中央
        let toast = document.getElementById('image-zoom-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'image-zoom-toast';
            toast.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                background:rgba(0,0,0,.8);color:#fff;padding:12px 20px;border-radius:6px;z-index:1000000;
                font-size:14px;font-family:Arial,sans-serif;opacity:0;transition:opacity .3s ease;pointer-events:none;`;
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.opacity = '1';
        if (toast.timeoutId) clearTimeout(toast.timeoutId);
        toast.timeoutId = setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
                if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, duration);
    }

    let saveToastTimeout = null, saveToastEl = null;

    function showSaveToast(message) {
        if (showPanelCenterToast(message)) return;
        if (!saveToastEl || !saveToastEl.parentNode) {
            saveToastEl = document.createElement('div');
            saveToastEl.id = 'image-zoom-save-toast';
            saveToastEl.style.cssText = `position:fixed;bottom:30px;left:50%;transform:translateX(-50%);
                background:rgba(15,23,42,.88);color:#fff;padding:12px 24px;border-radius:16px;font-size:14px;
                font-weight:500;font-family:Arial,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.25);
                opacity:0;transition:all .3s cubic-bezier(.16,1,.3,1);pointer-events:none;z-index:1000001;
                max-width:300px;text-align:center;`;
            document.body.appendChild(saveToastEl);
        }
        saveToastEl.textContent = '✅ ' + message;
        void saveToastEl.offsetWidth;
        saveToastEl.style.opacity = '1';
        saveToastEl.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(saveToastTimeout);
        saveToastTimeout = setTimeout(() => {
            if (saveToastEl) {
                saveToastEl.style.opacity = '0';
                saveToastEl.style.transform = 'translateX(-50%) translateY(16px)';
            }
        }, 1500);
    }


    // ================
    // 1. 配置模块
    // ================

    // ================
    // 1. 配置
    // ================
    const defaultConfig = {
        delay: 500,
        scale: 2,
        maxWidth: 1200,
        maxHeight: 980,
        minScale: 1.4,
        zoomZIndex: 9999,
        scrollSpeed: 50,
        smallImgThreshold: 280,
        smallImgWidth: 500,
        smallImgHeight: 430,
        avoidClickConflict: true,
        blurDismiss: true,
        zoomMode: 'adaptive',
        minOriginalSize: 51
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
        return v;
    }

    function loadConfig() {
        const saved = storageGet(`image_zoom_config_${currentDomain}`);
        if (saved) config = { ...defaultConfig, ...validateConfig(saved) };
    }

    function saveConfig() {
        storageSet(`image_zoom_config_${currentDomain}`, config);
    }

    function loadState() {
        isEnabled = storageGet(`image_zoom_enabled_${currentDomain}`) !== false;
        if (isHomepageZoomDisabled()) isEnabled = false;
    }

    // 主页禁用状态（保留原有实现，仅从 main.js 移入配置模块）
    function isHomepageDisabled() {
        return storageGet(`image_zoom_homepage_disabled_${currentDomain}`, false);
    }

    function isHomepageZoomDisabled() {
        return isHomepage() && isHomepageDisabled();
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
            if (el.closest('[role="menu"],[role="listbox"],[role="combobox"],[role="dialog"]')) return true;

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
        const src = img.src || img.currentSrc;
        if (!src || src.trim() === '' || src.startsWith('data:') || src.includes('placeholder')) return false;
        if (style.backgroundImage && style.backgroundImage !== 'none') return false;
        if (!img.complete || img.naturalWidth === 0) return false;
        const rect = img.getBoundingClientRect();
        return !(rect.width < 10 || rect.height < 10);
    }


    // 2. ★★★ 触发资格判定（已拆分至 image/eligibility.js）
    // ================
    // 3. 图片处理工具（已拆分至 image/url.js + image/crop.js）
    // ================
// 5.6.23 image URL/background URL helpers: moved verbatim from 5.6.22.
    function upgradeImgUrl(url) {
        if (!url) return url;
        return url.replace(/\/remote\/thumb\/\d+x\d+\//, '/');
    }

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
            try { data = ctx.getImageData(0, 0, w, h).data; } catch (e) { return; }
            let transparentCount = 0;
            const total = w * h, step = Math.max(1, Math.floor(total / 20000));
            let sampled = 0;
            for (let i = 0; i < total; i += step) {
                if (data[i * 4 + 3] < 10) transparentCount++;
                sampled++;
            }
            if (transparentCount / sampled > 0.05) return;
            const threshold = 24;
            const isContent = (i) => data[i + 3] > 10 &&
                (data[i] > threshold || data[i + 1] > threshold || data[i + 2] > threshold);
            const rowHas = (y0) => {
                for (let x0 = 0; x0 < w; x0++) if (isContent((y0 * w + x0) * 4)) return true;
                return false;
            };
            const colHas = (x0) => {
                for (let y0 = 0; y0 < h; y0++) if (isContent((y0 * w + x0) * 4)) return true;
                return false;
            };
            let top = 0;
            while (top < h && !rowHas(top)) top++;
            if (top === h) return;
            let bottom = h - 1;
            while (bottom > top && !rowHas(bottom)) bottom--;
            let left = 0;
            while (left < w && !colHas(left)) left++;
            let right = w - 1;
            while (right > left && !colHas(right)) right--;
            top = Math.min(top, Math.floor(h * 0.25));
            bottom = Math.max(bottom, h - 1 - Math.floor(h * 0.25));
            left = Math.min(left, Math.floor(w * 0.25));
            right = Math.max(right, w - 1 - Math.floor(w * 0.25));
            const cw = right - left + 1, ch = bottom - top + 1;
            if (cw >= w * 0.9 && ch >= h * 0.9) return;
            if (cw < 20 || ch < 20) return;
            const out = document.createElement('canvas');
            out.width = cw;
            out.height = ch;
            out.getContext('2d').drawImage(imgEl, left, top, cw, ch, 0, 0, cw, ch);
            imgEl.dataset.zoomCropped = '1';
            out.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                if (imgEl.__zoomBlobUrl) URL.revokeObjectURL(imgEl.__zoomBlobUrl);
                imgEl.__zoomBlobUrl = url;
                imgEl.src = url;
                // 容器尺寸保持不变（尊重当前模式的尺寸语义），
                // 只按新宽高比在容器内做 contain 重排
                const box = imgEl.parentNode;
                if (box && box.classList.contains('image-zoom-container')) {
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
        let u = url.trim().replace(/^['"]|['"]$/g, '');
        if (/alicdn\.com/i.test(u)) {
            let prev;
            do {
                prev = u;
                u = u.replace(/(_!![\w\-.,]+?\.(?:jpg|jpeg|png|webp))_[\w.\-]+$/i, '$1')
                    .replace(/\.(jpg|jpeg|png|webp)_[\w.]+$/i, '.$1')
                    .replace(/_\.(webp|jpg|jpeg|png)$/i, '');
            } while (u !== prev);
            return u;
        }
        let prev;
        do {
            prev = u;
            u = u.replace(/![\w\-]+$/i, '')
                .replace(/_\d+x\d+(q\d+)?\.(jpg|jpeg|png|webp)(\.\w+)?$/i, '')
                .replace(/\.(jpg|jpeg|png|webp)_[\w.]+$/i, '.$1')
                .replace(/_\.(webp|jpg|jpeg|png)$/i, '')
                .replace(/\.webp$/i, '.jpg');
        } while (u !== prev);
        return u;
    }


// 5.6.23 image crop helper: moved verbatim from 5.6.22.
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
            try { data = ctx.getImageData(0, 0, w, h).data; } catch (e) { return; }
            let transparentCount = 0;
            const total = w * h, step = Math.max(1, Math.floor(total / 20000));
            let sampled = 0;
            for (let i = 0; i < total; i += step) {
                if (data[i * 4 + 3] < 10) transparentCount++;
                sampled++;
            }
            if (transparentCount / sampled > 0.05) return;
            const threshold = 24;
            const isContent = (i) => data[i + 3] > 10 &&
                (data[i] > threshold || data[i + 1] > threshold || data[i + 2] > threshold);
            const rowHas = (y0) => {
                for (let x0 = 0; x0 < w; x0++) if (isContent((y0 * w + x0) * 4)) return true;
                return false;
            };
            const colHas = (x0) => {
                for (let y0 = 0; y0 < h; y0++) if (isContent((y0 * w + x0) * 4)) return true;
                return false;
            };
            let top = 0;
            while (top < h && !rowHas(top)) top++;
            if (top === h) return;
            let bottom = h - 1;
            while (bottom > top && !rowHas(bottom)) bottom--;
            let left = 0;
            while (left < w && !colHas(left)) left++;
            let right = w - 1;
            while (right > left && !colHas(right)) right--;
            top = Math.min(top, Math.floor(h * 0.25));
            bottom = Math.max(bottom, h - 1 - Math.floor(h * 0.25));
            left = Math.min(left, Math.floor(w * 0.25));
            right = Math.max(right, w - 1 - Math.floor(w * 0.25));
            const cw = right - left + 1, ch = bottom - top + 1;
            if (cw >= w * 0.9 && ch >= h * 0.9) return;
            if (cw < 20 || ch < 20) return;
            const out = document.createElement('canvas');
            out.width = cw;
            out.height = ch;
            out.getContext('2d').drawImage(imgEl, left, top, cw, ch, 0, 0, cw, ch);
            imgEl.dataset.zoomCropped = '1';
            out.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                if (imgEl.__zoomBlobUrl) URL.revokeObjectURL(imgEl.__zoomBlobUrl);
                imgEl.__zoomBlobUrl = url;
                imgEl.src = url;
                // 容器尺寸保持不变（尊重当前模式的尺寸语义），
                // 只按新宽高比在容器内做 contain 重排
                const box = imgEl.parentNode;
                if (box && box.classList.contains('image-zoom-container')) {
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


    // ================
    // 背景图悬停模块
    // ================

    function setupBgRuleProxy() {
        const customRules = getCustomRules()
            .filter(r => r.enabled && r.imgMode === 'background')
            .map(r => ({
                domains: String(r.domains).split(',').map(s => s.trim()).filter(Boolean),
                itemSelector: r.itemSelector,
                cardSelector: r.cardSelector,
                pollInterval: Math.max(100, parseInt(r.pollInterval) || 300)
            }));

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
                const card0 = el.closest(rule.cardSelector);
                if (card0) {
                    const w = card0.querySelector(rule.itemSelector);
                    if (w) {
                        const r = w.getBoundingClientRect();
                        if (inRect(x, y, r)) wrapper = w;
                    }
                }
            }

            if (wrapper) {
                const card = (rule.cardSelector && el.closest(rule.cardSelector)) || wrapper;
                if (card !== lastBgCard) {
                    lastBgCard = card;
                    bgZoomLayer.hide();
                    if (bgDelayTimer) clearTimeout(bgDelayTimer);
                    const mx = x, my = y;
                    bgDelayTimer = setTimeout(() => {
                        if (Math.abs(lastMouse.x - mx) < 20 && Math.abs(lastMouse.y - my) < 20) {
                            const url = extractBgUrl(wrapper);
                            if (url) bgZoomLayer.show({ cleaned: url, raw: url }, 1);
                        }
                    }, config.delay);
                }
            } else {
                const card = el.closest(rule.cardSelector);
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
                max-height:${Math.min(window.innerHeight - 60, config.maxHeight)}px;object-fit:contain;border-radius:8px;
                box-shadow:0 4px 20px rgba(0,0,0,.2);transform:scale(.6);transition:transform .35s cubic-bezier(.34,1.56,.64,1);`;
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
                big.style.transform = 'scale(1)';
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
            if (e.target.closest && e.target.closest('#zoomDockZone, #izModalOverlay, #izIntroOverlay, #izUpdateNotice, .image-zoom-container')) return;
            if (isHoverBlocker(e.target)) { cancelBg(); bgZoomLayer.hide(); return; }
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
// 仅从 main.js 原位置整体迁移，不改 processImage 行为。

    // ================
    // 4. 图片登记
    // ================
    function processImage(img) {
        if (!isEnabled || !img || !img.parentNode) return;
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
    // 4. 图片登记（已拆分至 image/processor.js）
    // ================
    // ================
    // 5. ★ 核心：单实例状态机 zoomFSM（已拆分至 core/zoom-fsm.js）
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
                if (el !== document.body && el !== document.documentElement && isHoverBlocker(el)) return null;
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
        if (!isEnabled || isHomepageZoomDisabled()) { zoomFSM.dispatch('DISMISS'); return; }
        // 网页自身进入灯箱后：旧的 hover 放大立即收起，且灯箱内部图片不再触发新的放大。
        if (isImageInLightboxMode(t)) {
            zoomFSM.dispatch('HOVER_NONE', { x, y, force: true });
            return;
        }
        if (t && t.closest && t.closest('#zoomDockZone, #izModalOverlay, #izIntroOverlay, #izUpdateNotice')) {
            zoomFSM.dispatch('HOVER_NONE', { x, y });
            return;
        }
        if (t && t.closest && t.closest('.image-zoom-container')) return;
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
            if (t && t !== document.body && isHoverBlocker(t)) {
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
    const zoomFSM = (function() {
        const S = Object.freeze({ IDLE:'IDLE', PENDING:'PENDING', SHOWING:'SHOWING', ACTIVE:'ACTIVE', FADING:'FADING' });
        let state = S.IDLE;
        let instance = null;      // 唯一活实例
        let pendingImg = null;    // PENDING 中等待的图
        let pendingTimer = null;
        let pendingFails = 0;     // 心跳连续失败计数（容忍轮播动画的瞬时错位）
        let pendingGraceUsed = false; // TIMER_FIRE 宽限重试是否已用
        let wheelTicking = false, lastWheelEvent = null;

        function clearPending() {
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
            pendingImg = null;
            pendingFails = 0;
            pendingGraceUsed = false;
        }

        function fadeOutContainer(container) {
            if (!container || !container.parentNode) return;
            container.dataset.izFading = '1';
            container.style.opacity = '0';
            const zImg = container.querySelector('img');
            if (zImg) {
                zImg.style.transform = 'scale(.6)';
                zImg.style.opacity = '0';
                if (zImg.__zoomBlobUrl) {
                    URL.revokeObjectURL(zImg.__zoomBlobUrl);
                    zImg.__zoomBlobUrl = null;
                }
            }
            setTimeout(() => {
                if (container.parentNode) container.parentNode.removeChild(container);
            }, FADE_MS);
        }

        function computeAdaptiveSize(img, rect) {
            const availW = Math.min(window.innerWidth - 60, config.maxWidth);
            const availH = Math.min(window.innerHeight - 60, config.maxHeight);
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
                    boxW = Math.min(Math.round(rect.width * fit), config.maxWidth);
                    boxH = Math.min(Math.round(rect.height * fit), config.maxHeight);
                } else {
                    const effScale = Math.max(config.scale || 1, config.minScale || 1);
                    boxW = Math.round(rect.width * effScale);
                    boxH = Math.round(rect.height * effScale);
                    if (boxW > config.maxWidth || boxH > config.maxHeight) {
                        const fit = Math.min(config.maxWidth / boxW, config.maxHeight / boxH);
                        boxW = Math.round(boxW * fit);
                        boxH = Math.round(boxH * fit);
                    }
                }
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    const natRatio = img.naturalWidth / img.naturalHeight;
                    const boxRatio = boxW / boxH;
                    if (natRatio > boxRatio) boxH = Math.round(boxW / natRatio);
                    else boxW = Math.round(boxH * natRatio);
                }
                const imgW = Math.round(boxW * imgScale), imgH = Math.round(boxH * imgScale);
                const offX = Math.round((boxW - imgW) / 2), offY = Math.round((boxH - imgH) / 2);
                const zi = img.__zoomHasClick ? config.zoomZIndex - 1 : config.zoomZIndex;
                const container = document.createElement('div');
                container.className = 'image-zoom-container';
                container.dataset.izOwner = 'fsm';
                container.style.cssText = `position:fixed;z-index:${zi};opacity:0;transition:opacity .3s ease;
                    pointer-events:none;left:50%;top:50%;transform:translate(-50%,-50%);
                    width:${boxW}px;height:${boxH}px;box-sizing:border-box;border-radius:10px;overflow:hidden;`;
                const zoomedImg = document.createElement('img');
                zoomedImg.alt = '';
                zoomedImg.style.cssText = `position:absolute;left:${offX}px;top:${offY}px;width:${imgW}px;height:${imgH}px;
                    object-fit:contain;transition:opacity .3s ease,transform .35s cubic-bezier(.34,1.56,.64,1);
                    box-shadow:0 4px 20px rgba(0,0,0,.2);display:block;border-radius:10px;transform:scale(.6);opacity:0;`;

                const fallbackSrc = img.src || img.currentSrc;
                let hiResSrc = null;
                if (!(currentDomain === 'jd.com' || currentDomain.endsWith('.jd.com'))) {
                    hiResSrc = upgradeImgUrl((fallbackSrc || '')
                        .replace(/\/s\d+x\d+_/g, '/')
                        .replace(/\.avif$/i, '')) || null;
                }
                if (hiResSrc === fallbackSrc) hiResSrc = null;

                const inst = {
                    container, imgEl: zoomedImg, sourceImg: img,
                    fallbackSrc, usingHiRes: false, revealed: false
                };

                zoomedImg.onload = () => {
                    if (instance !== inst) return; // 过期实例回调直接丢弃
                    cropBlackBars(zoomedImg);
                    if (!inst.revealed) {
                        inst.revealed = true;
                        FSM.dispatch('LOADED', inst);
                    }
                };
                zoomedImg.onerror = () => {
                    if (instance === inst) FSM.dispatch('ERROR', inst);
                };

                zoomedImg.src = fallbackSrc;

                if (hiResSrc) {
                    const probe = new Image();
                    probe.onload = () => {
                        if (!zoomedImg.isConnected || zoomedImg.src === hiResSrc) return;
                        if (zoomedImg.__zoomBlobUrl) {
                            URL.revokeObjectURL(zoomedImg.__zoomBlobUrl);
                            zoomedImg.__zoomBlobUrl = null;
                        }
                        delete zoomedImg.dataset.zoomCropped;
                        inst.usingHiRes = true;
                        zoomedImg.src = hiResSrc;
                    };
                    probe.src = hiResSrc;
                }

                if (zoomedImg.complete && zoomedImg.naturalWidth > 0 && !inst.revealed) {
                    inst.revealed = true;
                    setTimeout(() => {
                        if (instance === inst) FSM.dispatch('LOADED', inst);
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
                pendingTimer = setTimeout(() => FSM.dispatch('TIMER_FIRE', img), config.delay);
                state = S.PENDING;
            },
            cancel() {
                clearPending();
                state = S.IDLE;
            },
            show(img) {
                const inst = createInstance(img);
                if (!inst) {
                    state = S.IDLE;
                    wheelManager.sync();
                    return;
                }
                instance = inst;
                state = S.SHOWING;
                wheelManager.sync();
            },
            activate(inst) {
                if (inst !== instance) return;
                inst.container.style.opacity = '1';
                inst.imgEl.style.transform = 'scale(1)';
                inst.imgEl.style.opacity = '1';
                // 容器超出视口时提示可滚动查看（1200ms 后自动消失，避免遮挡）
                if (inst.container.offsetHeight > window.innerHeight && !inst.toastShown) {
                    inst.toastShown = true;
                    showToast('图片超出屏幕，滚动滚轮查看其余部分', 800);
                }
                state = S.ACTIVE;
            },
            onError(inst) {
                if (inst !== instance) return;
                if (inst.usingHiRes) {
                    inst.usingHiRes = false;
                    inst.imgEl.src = inst.fallbackSrc;
                    return;
                }
                fadeOutContainer(inst.container);
                instance = null;
                state = S.IDLE;
                wheelManager.sync();
            },
            beginFade() {
                clearPending();
                if (instance) {
                    fadeOutContainer(instance.container);
                    instance = null;
                }
                state = S.FADING;
                setTimeout(() => { if (state === S.FADING) state = S.IDLE; }, FADE_MS);
                wheelManager.sync();
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
            getActiveRect() { return instance ? instance.container.getBoundingClientRect() : null; },

            heartbeat() {
                if (!isEnabled || isHomepageZoomDisabled()) { FSM.dispatch('RESET'); return; }

                // ★ 光标不在浏览器内：不维持任何状态（mouseout 可能未送达，这里兜底）
                if (!pointerInWindow) {
                    if (state === S.PENDING) actions.cancel();
                    else if ((state === S.SHOWING || state === S.ACTIVE) && instance) actions.beginFade();
                    return;
                }

                const x = lastMouse.x, y = lastMouse.y;
                if (x < 0) return;

                if (state === S.PENDING && pendingImg) {
                    if (canTriggerNow(pendingImg, x, y)) {
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
                    if (!inRect(x, y, sRect)) actions.beginFade();
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
                            if (canTriggerNow(payload, lastMouse.x, lastMouse.y)) {
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
                                    if (lastWheelEvent && state === S.ACTIVE && instance) actions.pan(lastWheelEvent);
                                });
                            }
                            return true;
                        }
                        return false;
                    }
                    case 'DISMISS': {
                        if (state === S.PENDING) actions.cancel();
                        else if (state === S.SHOWING || state === S.ACTIVE) actions.beginFade();
                        break;
                    }
                    case 'RESET': {
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
                document.addEventListener('wheel', handler, { capture: true, passive: false });
                attached = true;
            } else if (!need && attached) {
                document.removeEventListener('wheel', handler, { capture: true });
                attached = false;
            }
        }
        document.addEventListener('fullscreenchange', sync);
        document.addEventListener('webkitfullscreenchange', sync);
        return { sync };
    })();

    function setupGlobalHoverStream() {
        // 流1：mouseover（前沿节流 + 事件自带坐标）—— 快速、跟随移动
        document.addEventListener('mouseover', throttleLeading((e) => {
            if (lastMouse.x < 0) {
                lastMouse.x = e.clientX;
                lastMouse.y = e.clientY;
            }
            resolveCursorTarget(e.clientX, e.clientY, e.target);
        }, 60), true);

        // 流2：★ 停稳裁决器 —— 鼠标停止移动 ~120ms 后主动裁决一次。
        // 兜底 mouseover 被节流丢弃 / 未派发 / target 不含 img 的所有情况。
        const stopResolve = debounce(() => {
            if (document.hidden) return;
            if (!pointerInWindow) return;   // ★ 光标已被其他窗口覆盖，不裁决
            const x = lastMouse.x, y = lastMouse.y;
            if (x < 0) return;
            resolveCursorTarget(x, y, document.elementFromPoint(x, y));
        }, 120);
        document.addEventListener('mousemove', () => { stopResolve(); }, { passive: true });

        // 鼠标真正离开窗口（移到文件管理器等原生窗口上）
        document.addEventListener('mouseout', (e) => {
            if (!e.relatedTarget) {
                pointerInWindow = false;
                zoomFSM.dispatch('HOVER_NONE', { x: lastMouse.x, y: lastMouse.y, force: true });
            }
        }, true);

        // ★ 窗口失焦（Alt+Tab 切到其他应用 / 点击其他窗口）→ 可配置地强制淡出。
        // 与 mouseout 同理：光标未移动时 DOM 无感知，但视线已离开浏览器。
        // 不改 pointerInWindow——光标物理上可能仍在页面内（如点击独立 devtools 窗口），
        // mousemove 会照常到达并自愈。开关关闭时不做任何处理（对照查看模式）
        window.addEventListener('blur', () => {
            if (!config.blurDismiss) return;
            zoomFSM.dispatch('HOVER_NONE', { x: lastMouse.x, y: lastMouse.y, force: true });
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


    // 6. ★ 全局事件流 + 停稳裁决器（已拆分至 core/hover-stream.js）

    // ================
    // 7/8. ★ 背景图悬停模块（已拆分至 image/background-hover.js）
    // ================

    // ================
    // 9. 动态图片观察器（已拆分至 core/observer.js）
    // ================
// 5.6.25 - 动态图片观察器
// 仅从 main.js 原位置整体迁移，不改观察/MutationObserver 行为。

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
                batch.forEach(mutation => {
                    if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG' &&
                        !mutation.target.classList.contains('image-zoom-processed')) {
                        nodes.add(mutation.target);
                    } else if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType !== Node.ELEMENT_NODE) return;
                            if (node.tagName === 'IMG' && !node.classList.contains('image-zoom-processed')) {
                                nodes.add(node);
                            } else if (node.querySelectorAll) {
                                node.querySelectorAll('img:not(.image-zoom-processed)').forEach(i => nodes.add(i));
                            }
                        });
                    }
                });
                nodes.forEach(img => observeImage(img));
            };
            const run = (batch) => {
                requestAnimationFrame(() => {
                    processBatch(batch);
                    processingQueue = false;
                    if (pendingMutations && pendingMutations.length) {
                        const nextBatch = pendingMutations;
                        pendingMutations = null;
                        processingQueue = true;
                        run(nextBatch);
                    }
                });
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
        '[aria-modal="true"]',
        '#imgzoom', '#imgzoom_zoomlayer', '#imgzoom_zoom'
    ];

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
            if (target.closest(LIGHTBOX_SELECTORS.join(','))) return true;
            if (target.closest('[role="dialog"],[aria-modal="true"]')) return true;
        } catch (e) { }

        let node = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
        let depth = 0;
        while (node && node !== document.body && node !== document.documentElement && depth++ < 14) {
            try {
                const cs = getComputedStyle(node);
                const positioned = cs.position === 'fixed' || cs.position === 'absolute';
                const z = cs.zIndex === 'auto' ? 0 : parseFloat(cs.zIndex);
                const r = node.getBoundingClientRect();
                const large = r.width >= Math.max(320, window.innerWidth * 0.45) ||
                              r.height >= Math.max(240, window.innerHeight * 0.45);
                const fullscreenish = r.width >= window.innerWidth * 0.75 && r.height >= window.innerHeight * 0.65;
                const containsImage = !!(node.querySelector && node.querySelector('img'));
                const keyword = hasLightboxKeyword(node);
                if (positioned && z >= 100 && isVisibleLightboxElement(node) && containsImage && (keyword || large || fullscreenish)) {
                    return true;
                }
                // 常见“全屏遮罩 + 内容层”结构：容器本身可能没有关键词，
                // 但内部已有一张大图，因此再做一层更严格的兜底。
                if (positioned && z >= 100 && fullscreenish && containsImage) return true;
            } catch (e) { }
            node = node.parentElement;
        }
        return false;
    }

    function isImageInLightboxMode(target) {
        if (LIGHTBOX_CLASSES.some(c =>
            document.body.classList.contains(c) ||
            document.documentElement.classList.contains(c)
        )) return true;

        if (target && isElementInsideLightbox(target)) return true;

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

    function setupLightboxObserver() {
        const dismissIfOpen = () => {
            if (isImageInLightboxMode()) zoomFSM.dispatch('DISMISS');
        };

        new MutationObserver(dismissIfOpen).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'aria-hidden', 'aria-modal']
        });

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

    // setupLightboxObserver 已拆分至 core/lightbox-observer.js

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

        function onWheel(e) {
            if (!enabled || !isInFullscreenMode()) return false;
            const video = findVideoElement();
            if (!video) return false;
            e.stopPropagation();
            e.preventDefault();
            const target = Math.max(0, Math.min(1, getVolume(video) + (e.deltaY > 0 ? -0.02 : 0.02)));
            applyVolume(video, target);
            showVolumeToast(target);
            return true;
        }

        function handleKeydown(e) {
            if (!enabled) return;
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code) && isInFullscreenMode()) e.preventDefault();
        }

        function init() {
            if (!window.location.hostname.includes('bilibili.com')) return;
            if (enabled) {
                window.addEventListener('keydown', handleKeydown);
                document.addEventListener('volumechange', (e) => {
                    if (!enabled || e.target.tagName !== 'VIDEO' || !isInFullscreenMode()) return;
                    showVolumeToast(e.target.muted ? 0 : e.target.volume);
                }, { capture: true });
            }
        }

        return {
            init, onWheel,
            isFullscreenActive: isInFullscreenMode,
            get isEnabled() { return enabled; },
            setEnabled(v) { enabled = v; storageSet('bilibili_volume_enabled', v); }
        };
    })();


    // 10. Bilibili 播放器辅助（已拆分至 sites/bilibili.js）
    // ================

    // wheelManager 已拆分至 core/wheel-manager.js


    // ================
    // 11. 样式 / 悬浮按钮 / 配置面板 / 反馈 / 自定义规则
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
                #izModalOverlay{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
                #izModalOverlay.anim-in{animation:izOverlayFade .35s ease}
                #izModalOverlay.anim-out{animation:izOverlayFadeOut .3s ease forwards}
                @keyframes izOverlayFade{from{opacity:0}to{opacity:1}}
                @keyframes izOverlayFadeOut{from{opacity:1}to{opacity:0}}
                #izConfigPanel{width:100%;max-width:560px;max-height:90vh;background:rgba(255,255,255,.88);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:28px;box-shadow:0 25px 60px -12px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.6) inset;overflow:hidden;animation:izPanelSlide .40s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box}
                @keyframes izPanelSlide{from{opacity:0;transform:translateY(28px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
                .iz-panel-scroll{flex:1;overflow-y:auto;padding:0 28px 12px 28px;scroll-behavior:smooth}
                .iz-panel-scroll::-webkit-scrollbar{width:4px}
                .iz-panel-scroll::-webkit-scrollbar-track{background:transparent}
                .iz-panel-scroll::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:8px}
                .iz-panel-header{display:flex;align-items:center;justify-content:space-between;padding:20px 28px 0 28px;flex-shrink:0}
                .iz-panel-header-left{display:flex;align-items:center;gap:12px}
                .iz-panel-icon{width:38px;height:38px;background:linear-gradient(135deg,#4F46E5,#7C3AED);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;flex-shrink:0;box-shadow:0 4px 12px rgba(79,70,229,.3)}
                .iz-panel-title{font-size:20px;font-weight:600;color:#0F172A;letter-spacing:-.3px}
                .iz-panel-title span{font-weight:400;color:#64748B;font-size:14px;margin-left:6px}
                .iz-close-btn{width:36px;height:36px;border:none;background:rgba(203,213,225,.4);border-radius:50%;cursor:pointer;font-size:18px;color:#64748B;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0;line-height:1}
                .iz-close-btn:hover{background:rgba(239,68,68,.12);color:#EF4444;transform:rotate(90deg)}
                .iz-section{margin-top:20px;background:rgba(255,255,255,.5);border-radius:18px;padding:18px 20px 20px 20px;border:1px solid rgba(226,232,240,.7)}
                .iz-section-title{font-size:13px;font-weight:600;color:#64748B;letter-spacing:.6px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
                .iz-badge{background:#4F46E5;color:#fff;font-size:10px;font-weight:600;padding:0 8px;border-radius:20px;line-height:18px}
                .iz-row{display:flex;align-items:center;gap:14px;margin-bottom:14px}
                .iz-row:last-child{margin-bottom:0}
                .iz-row-label{font-size:14px;font-weight:500;color:#1E293B;flex-shrink:0;min-width:100px}
                .iz-row-label .iz-hint{font-weight:400;font-size:12px;color:#94A3B8;display:block;margin-top:1px}
                .iz-row-control{flex:1;min-width:0}
                .iz-select{width:100%;padding:8px 36px 8px 14px;font-size:14px;font-weight:500;color:#0F172A;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M6 8L1 3h10z'/%3E%3C/svg%3E") no-repeat right 14px center;background-size:12px;border:1.5px solid #E2E8F0;border-radius:12px;appearance:none;-webkit-appearance:none;transition:all .2s;cursor:pointer;outline:none;height:42px}
                .iz-select:hover{border-color:#A5B4FC}
                .iz-select:focus{border-color:#4F46E5;box-shadow:0 0 0 3px rgba(79,70,229,.15)}
                .iz-input-group{display:flex;align-items:center;background:#fff;border:1.5px solid #E2E8F0;border-radius:12px;overflow:hidden;transition:all .2s;height:42px}
                .iz-input-group:focus-within{border-color:#4F46E5;box-shadow:0 0 0 3px rgba(79,70,229,.15)}
                .iz-input-group input[type="number"]{flex:1;border:none;padding:0 12px;font-size:14px;font-weight:500;color:#0F172A;background:transparent;outline:none;min-width:0;height:100%;width:100%;-moz-appearance:textfield}
                .iz-input-group input[type="number"]::-webkit-inner-spin-button,.iz-input-group input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
                .iz-input-group .iz-unit{padding:0 14px 0 4px;font-size:13px;color:#94A3B8;font-weight:500;flex-shrink:0}
                .iz-input-group.disabled-group{opacity:.6;background-color:#f8fafc;border-color:#e2e8f0;cursor:not-allowed}
                .iz-input-group.disabled-group input{cursor:not-allowed;background-color:#f8fafc}
                .iz-checkbox-wrap{display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none}
                .iz-checkbox-custom{width:20px;height:20px;flex-shrink:0;border:2px solid #CBD5E1;border-radius:6px;background:#fff;transition:all .2s;display:flex;align-items:center;justify-content:center}
                .iz-checkbox-custom.checked{background:#4F46E5;border-color:#4F46E5}
                .iz-checkbox-custom.checked::after{content:"✓";color:#fff;font-size:14px;font-weight:700;line-height:1}
                .iz-checkbox-label{font-size:14px;font-weight:500;color:#1E293B}
                .iz-checkbox-label .iz-sub{font-weight:400;font-size:12px;color:#94A3B8;display:block;margin-top:1px}
                .iz-toggle-wrap{display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none}
                .iz-toggle{position:relative;width:46px;height:28px;flex-shrink:0;background:#CBD5E1;border-radius:20px;transition:all .3s cubic-bezier(.34,1.56,.64,1);box-shadow:inset 0 1px 3px rgba(0,0,0,.1)}
                .iz-toggle.active{background:linear-gradient(135deg,#4F46E5,#7C3AED)}
                .iz-toggle .iz-knob{position:absolute;top:3px;left:3px;width:22px;height:22px;background:#fff;border-radius:50%;transition:all .3s cubic-bezier(.34,1.56,.64,1);box-shadow:0 2px 6px rgba(0,0,0,.18)}
                .iz-toggle.active .iz-knob{left:21px}
                .iz-exclusion-box{background:rgba(241,245,249,.7);border-radius:14px;padding:14px 16px;border:1px solid rgba(226,232,240,.5)}
                .iz-exclusion-box .iz-status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
                .iz-exclusion-box .iz-status-text{font-size:14px;font-weight:500;display:flex;align-items:center;gap:8px;color:#1E293B}
                .iz-exclusion-box .iz-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
                .iz-exclusion-box .iz-dot.on{background:#10B981}
                .iz-exclusion-box .iz-dot.off{background:#F59E0B}
                .iz-exclusion-note{margin-top:8px;font-size:12px;color:#64748B}
                .iz-btn-sm{padding:6px 16px;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;flex-shrink:0;height:34px}
                .iz-btn-sm.primary{background:#4F46E5;color:#fff}
                .iz-btn-sm.primary:hover{background:#4338CA;transform:translateY(-1px);box-shadow:0 4px 12px rgba(79,70,229,.3)}
                .iz-btn-sm.warning{background:#F59E0B;color:#fff}
                .iz-btn-sm.warning:hover{background:#D97706;transform:translateY(-1px);box-shadow:0 4px 12px rgba(245,158,11,.3)}
                .iz-collapse-header{display:flex;align-items:center;justify-content:space-between;padding:10px 0 6px 0;cursor:pointer;user-select:none;border-top:1px solid rgba(226,232,240,.5);margin-top:4px;transition:opacity .2s}
                .iz-collapse-header .iz-left{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:#1E293B}
                .iz-collapse-header .iz-arrow{transition:transform .3s ease;font-size:12px;color:#94A3B8}
                .iz-collapse-header .iz-arrow.open{transform:rotate(90deg)}
                .iz-badge-params{font-size:11px;font-weight:500;color:#64748B;background:#F1F5F9;padding:2px 10px;border-radius:20px}
                .iz-collapse-body{overflow:hidden;max-height:0;opacity:0;transition:all .35s cubic-bezier(.16,1,.3,1)}
                .iz-collapse-body.open{max-height:800px;opacity:1;padding-top:12px}
                .iz-param-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px}
                .iz-param-item{display:flex;flex-direction:column;gap:4px}
                .iz-param-item label{font-size:12px;font-weight:500;color:#64748B;letter-spacing:.2px;display:flex;align-items:center;gap:5px}
                .iz-tip-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0;border-radius:50%;background:#E2E8F0;color:#64748B;font-size:10px;font-weight:700;line-height:1;cursor:help;position:relative;transition:all .2s}
                .iz-tip-icon:hover{background:#4F46E5;color:#fff}
                #izTipBubble{position:fixed;width:240px;background:rgba(15,23,42,.95);color:#F1F5F9;font-size:12px;font-weight:400;line-height:1.6;padding:10px 13px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .15s ease;z-index:100005;white-space:normal;text-align:left}
                .iz-param-item .iz-input-group{height:36px}
                .iz-param-item .iz-input-group input[type="number"]{font-size:13px;padding:0 10px}
                .iz-param-item .iz-input-group .iz-unit{font-size:12px;padding:0 10px 0 2px}
                .iz-panel-footer{padding:14px 28px 20px 28px;border-top:1px solid rgba(226,232,240,.5);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:rgba(255,255,255,.4);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
                .iz-btn-ghost{background:none;border:none;padding:8px 14px;font-size:13px;font-weight:500;color:#64748B;cursor:pointer;border-radius:10px;transition:all .2s}
                .iz-btn-ghost:hover{background:rgba(239,68,68,.08);color:#EF4444}
                .iz-btn-ghost:active{transform:scale(.96)}
                .iz-btn-primary-solid{padding:10px 28px;background:linear-gradient(135deg,#4F46E5,#7C3AED);border:none;border-radius:14px;font-size:14px;font-weight:600;color:#fff;cursor:pointer;transition:all .25s;box-shadow:0 4px 16px rgba(79,70,229,.3)}
                .iz-btn-primary-solid:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(79,70,229,.4)}
                .iz-btn-primary-solid:active{transform:scale(.96)}
                #izIntroOverlay{position:fixed;inset:0;z-index:100010;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);pointer-events:auto}
                #izIntroPanel{pointer-events:auto}
                #izUpdateNotice{position:fixed;top:22px;right:22px;width:min(360px,calc(100vw - 44px));z-index:100011;display:none;background:rgba(255,255,255,.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(226,232,240,.82);border-radius:20px;box-shadow:0 18px 50px -12px rgba(15,23,42,.28),0 0 0 1px rgba(255,255,255,.55) inset;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box;pointer-events:auto}
                #izUpdateNotice.anim-in{animation:izUpdateSlide .35s cubic-bezier(.16,1,.3,1)}
                #izUpdateNotice.anim-out{animation:izUpdateFadeOut .25s ease forwards}
                #izUpdateNotice .iz-update-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px 18px}
                #izUpdateNotice .iz-update-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;color:#0F172A}
                #izUpdateNotice .iz-update-icon{width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,#4F46E5,#7C3AED);display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;box-shadow:0 4px 12px rgba(79,70,229,.22)}
                #izUpdateNotice .iz-update-version{font-size:11px;font-weight:600;color:#6366F1;background:#EEF2FF;padding:4px 8px;border-radius:999px}
                #izUpdateNotice .iz-update-close{width:28px;height:28px;border:none;background:rgba(203,213,225,.45);border-radius:50%;cursor:pointer;font-size:15px;color:#64748B;display:flex;align-items:center;justify-content:center;line-height:1}
                #izUpdateNotice .iz-update-close:hover{background:rgba(239,68,68,.12);color:#EF4444}
                #izUpdateNotice .iz-update-body{padding:0 18px 14px 18px;font-size:12.5px;line-height:1.75;color:#64748B}
                #izUpdateNotice .iz-update-item{padding:8px 10px;background:rgba(248,250,252,.72);border:1px solid rgba(226,232,240,.68);border-radius:10px;margin-top:7px}
                #izUpdateNotice .iz-update-item:first-child{margin-top:0}
                #izUpdateNotice .iz-update-footer{display:flex;justify-content:flex-end;padding:12px 18px 14px;border-top:1px solid rgba(226,232,240,.5);background:rgba(255,255,255,.45)}
                #izUpdateNotice .iz-update-ok{padding:8px 16px;font-size:12px;border-radius:11px}
                @keyframes izUpdateSlide{from{opacity:0;transform:translateY(-12px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
                @keyframes izUpdateFadeOut{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-8px)}}
                #izIntroOverlay.anim-in{animation:izOverlayFade .35s ease}
                #izIntroOverlay.anim-out{animation:izOverlayFadeOut .3s ease forwards}
                #izIntroPanel{width:100%;max-width:560px;max-height:90vh;background:rgba(255,255,255,.90);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:28px;box-shadow:0 25px 60px -12px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.6) inset;overflow:hidden;animation:izPanelSlide .40s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box}
                .iz-intro-scroll{flex:1;overflow-y:auto;padding:0 28px 20px 28px}
                .iz-intro-lead{margin-top:18px;padding:14px 16px;background:linear-gradient(135deg,rgba(79,70,229,.08),rgba(124,58,237,.06));border:1px solid rgba(99,102,241,.14);border-radius:16px;font-size:13px;line-height:1.75;color:#475569}
                .iz-intro-item{margin-top:12px;padding:14px 16px;background:rgba(248,250,252,.72);border:1px solid rgba(226,232,240,.7);border-radius:14px}
                .iz-intro-item-title{font-size:14px;font-weight:600;color:#1E293B;margin-bottom:5px;display:flex;align-items:center;gap:7px}
                .iz-intro-item-text{font-size:12.5px;line-height:1.75;color:#64748B}
                .iz-intro-footer{padding:14px 28px 20px 28px;border-top:1px solid rgba(226,232,240,.5);display:flex;justify-content:flex-end;align-items:center;flex-shrink:0;background:rgba(255,255,255,.4);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
                .iz-intro-ok{min-width:118px}
                @media (max-width:600px){#izIntroPanel{border-radius:20px;max-height:95vh}.iz-intro-scroll{padding:0 18px 16px}.iz-intro-footer{padding:12px 18px 16px}.iz-intro-ok{width:100%}}
                @media (max-width:600px){#izUpdateNotice{top:12px;right:12px;width:calc(100vw - 24px);border-radius:16px}}
                @media (max-width:600px){#izConfigPanel{border-radius:20px;max-height:95vh}.iz-panel-scroll{padding:0 18px 8px 18px}.iz-panel-header{padding:16px 18px 0 18px}.iz-panel-footer{padding:12px 18px 16px 18px;flex-wrap:wrap;gap:10px}.iz-row{flex-direction:column;align-items:stretch;gap:6px}.iz-param-grid{grid-template-columns:1fr}.iz-panel-title{font-size:17px}.iz-panel-icon{width:34px;height:34px;font-size:17px}}
            `;
            document.head.appendChild(s);
            dockStyleElement = s;
        }

        if (styleElement) return;
        const style = document.createElement('style');
        style.textContent = `
            .image-zoom-container img{object-fit:contain}
            .image-zoom-hover{cursor:zoom-in!important}
            a.image-zoom-hover,.cover-container.image-zoom-hover,.card.image-zoom-hover{cursor:zoom-in!important}
            a.stretched-link.image-zoom-hover{cursor:zoom-in!important}
        `;
        document.head.appendChild(style);
        styleElement = style;
    }

    // 全局样式注入已拆分至 ui/styles.js



    let toggleButton = null, gearButton = null, dockZone = null, dockTip = null, settingsTip = null;

    function createDockButton() {
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


    // ★ Dock 悬浮控制区已拆分至 ui/dock.js

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
                        <div class="iz-intro-lead">把鼠标停在图片上，脚本会在短暂停留后自动显示放大预览。多数情况下无需额外操作，图片会优先使用页面已有的高清资源。</div>

                        <div class="iz-intro-item">
                            <div class="iz-intro-item-title">🖱️ 怎么使用</div>
                            <div class="iz-intro-item-text">将鼠标停在想看的图片上即可。智能自适应会根据屏幕空间自动调整大小，也可以在设置中切换为固定倍数模式。</div>
                        </div>

                        <div class="iz-intro-item">
                            <div class="iz-intro-item-title">⚠️ 使用时注意</div>
                            <div class="iz-intro-item-text">不是鼠标经过的每张图都会放大：太小的图片、网站自己的点击/弹窗区域、部分特殊页面结构可能会被跳过。主页也可以单独禁用放大。</div>
                        </div>

                        <div class="iz-intro-item">
                            <div class="iz-intro-item-title">🛠️ 遇到问题怎么办</div>
                            <div class="iz-intro-item-text">先检查右侧悬浮按钮是否开启，再打开设置调整“触发延迟”和“避免与点击放大功能冲突”。特殊网站无法识别时，可使用设置中的自定义规则；修改后建议刷新页面。</div>
                        </div>

                        <div class="iz-intro-item">
                            <div class="iz-intro-item-title">🎬 B站提示</div>
                            <div class="iz-intro-item-text">如果在 B 站全屏播放时发现滚轮不能正常调音量，可在设置中开启“B站播放器辅助”。</div>
                        </div>
                    </div>
                    <div class="iz-intro-footer">
                        <button class="iz-btn-primary-solid iz-intro-ok" id="izIntroOk">知道了，开始使用</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

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
                    <div class="iz-update-item">🚀 自 5.6.11 以来，持续增强图片悬停放大、动态图片、背景图与网页灯箱兼容性。</div>
                    <div class="iz-update-item">🧩 完成核心功能的渐进式模块化：配置、状态机、悬停解析、图片处理、观察器、站点适配及 UI 已拆分。</div>
                    <div class="iz-update-item">🛡️ 优化窗口失焦、Lightbox、同链接标题桥接等兼容场景，同时保持原有放大体验。</div>
                    <div class="iz-update-item">🧰 为后续浏览器扩展迁移做好结构准备。</div>
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


    // 配置面板 UI（已拆分至 ui/config-panel.js）
    // ================

    // ============================================================================
    // Config Panel UI module
    // 仅搬运 5.6.28 原有配置面板代码；不改运行行为。
    // ============================================================================

    const COMMON_PARAM_DEFS = [
        { key: 'delay', label: '悬停延迟', unit: 'ms', min: 0, max: 2000, step: 100, tip: '鼠标停在图片上多久后才放大。数值越小响应越快，越大越不容易误触发。建议 300~800ms' },
        { key: 'minOriginalSize', label: '最小放大尺寸', unit: 'px', min: 0, max: 500, step: 5, tip: '原图宽或高小于此值时不放大，用来过滤网站里的小图标、表情、按钮图标等。设为 0 表示全部放大' },
        { key: 'maxWidth', label: '大图最大宽度', unit: 'px', min: 300, max: 3000, step: 100, tip: '放大后的大图宽度上限。自适应模式下它决定了放大画布的宽度上限，调小后大图整体变小；固定模式下大图最多放大到这个宽度' },
        { key: 'maxHeight', label: '大图最大高度', unit: 'px', min: 300, max: 3000, step: 100, tip: '放大后的大图高度上限。自适应模式下它决定了放大画布的高度上限，调小后大图整体变小；固定模式下大图最多放大到这个高度' },
        { key: 'scrollSpeed', label: '滚轮移动速度', unit: 'px', min: 5, max: 50, step: 1, tip: '大图超出屏幕时，滚动鼠标滚轮查看图片其余部分，每次滚动的距离。数值越大滚得越快' }
    ];

    const FIXED_PARAM_DEFS = [
        { key: 'scale', label: '大图放大倍数', unit: '×', min: 1, max: 5, step: 0.1, tip: '固定倍数模式下，大图相对原图的放大倍数（最终不超过最大宽高限制）' },
        { key: 'minScale', label: '大图最小倍数', unit: '×', min: 1, max: 3, step: 0.1, tip: '固定倍数模式下，大图至少要放大到的倍数下限，避免小图放大后依然看不清' },
        { key: 'smallImgThreshold', label: '小图判定阈值', unit: 'px', min: 100, max: 500, step: 10, tip: '固定模式下，原图宽或高小于此值会被当作「小图」，以小图专用尺寸为保底基准放大（倍数更大时仍会按倍数继续放大）' },
        { key: 'smallImgWidth', label: '小图目标宽度', unit: 'px', min: 300, max: 1000, step: 10, tip: '固定模式下，小图放大时使用的目标框宽度基准；最终保持原图比例，并与目标高度共同决定实际显示尺寸' },
        { key: 'smallImgHeight', label: '小图目标高度', unit: 'px', min: 300, max: 1000, step: 10, tip: '固定模式下，小图放大时使用的目标框高度基准；最终保持原图比例，并与目标宽度共同决定实际显示尺寸' }
    ];

    const FEEDBACK_API = 'https://damp-woodpecker-4867.ydgg123.deno.net';

    function postToAPI(payload) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: FEEDBACK_API,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                timeout: 15000,
                onload: (r) => (r.status >= 200 && r.status < 400) ? resolve() : reject(new Error('提交失败（' + r.status + '）')),
                onerror: () => reject(new Error('网络错误，请稍后重试')),
                ontimeout: () => reject(new Error('提交超时，请检查网络'))
            });
        });
    }

    function submitFeedback(text) {
        return postToAPI({
            text: text,
            page: location.hostname + location.pathname + ' | 脚本 v' + (typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : 'unknown')
        });
    }

    function submitSiteRule(rule, note) {
        return postToAPI({
            type: 'site_rule',
            rule: {
                name: rule.name, domains: rule.domains, imgMode: rule.imgMode,
                itemSelector: rule.itemSelector, cardSelector: rule.cardSelector, pollInterval: rule.pollInterval
            },
            note: note || '',
            context: {
                page: location.hostname + location.pathname,
                scriptVersion: (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : 'unknown',
                userAgent: navigator.userAgent,
                timestamp: Date.now()
            }
        });
    }

    // 参数保存提示已由 showToast / showSaveToast 统一路由到面板中央
    const notifyConfigSaved = debounce((key, value, label) => {
        showSaveToast(`已保存：${label || key} = ${value}`);
    }, 600);

    function injectFeedbackSection(overlay) {
        const scroll = overlay.querySelector('.iz-panel-scroll');
        if (!scroll || scroll.querySelector('#izFeedbackSection')) return;
        const section = document.createElement('div');
        section.className = 'iz-section';
        section.id = 'izFeedbackSection';
        section.innerHTML = `
            <div class="iz-section-title">📮 问题反馈</div>
            <textarea id="izFeedbackText" placeholder="遇到问题或有建议？写在这里直接反馈～&#10;" style="width:100%;box-sizing:border-box;resize:vertical;min-height:72px;background:#fff;color:#1E293B;border:1.5px solid #E2E8F0;border-radius:12px;padding:10px 12px;font-size:13px;font-family:inherit;line-height:1.6;outline:none;transition:border-color .2s,box-shadow .2s;"></textarea>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;">
                <span id="izFeedbackStatus" style="font-size:12px;color:#64748B;"></span>
                <button id="izFeedbackBtn" style="padding:8px 20px;background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;border:none;border-radius:12px;font-size:13px;font-weight:600;cursor:pointer;transition:all .25s;box-shadow:0 4px 12px rgba(79,70,229,.3);">📮 提交反馈</button>
            </div>`;
        scroll.appendChild(section);

        const textarea = section.querySelector('#izFeedbackText');
        const status = section.querySelector('#izFeedbackStatus');
        const btn = section.querySelector('#izFeedbackBtn');

        textarea.addEventListener('focus', () => {
            textarea.style.borderColor = '#4F46E5';
            textarea.style.boxShadow = '0 0 0 3px rgba(79,70,229,.15)';
        });
        textarea.addEventListener('blur', () => {
            textarea.style.borderColor = '#E2E8F0';
            textarea.style.boxShadow = 'none';
        });
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 8px 24px rgba(79,70,229,.4)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = '';
            btn.style.boxShadow = '0 4px 12px rgba(79,70,229,.3)';
        });
        btn.addEventListener('click', () => {
            const text = textarea.value.trim();
            if (!text) {
                status.textContent = '⚠️ 请先填写反馈内容';
                status.style.color = '#F59E0B';
                return;
            }
            btn.disabled = true;
            btn.textContent = '提交中…';
            btn.style.opacity = '0.7';
            status.textContent = '';
            submitFeedback(text)
                .then(() => {
                    status.textContent = '✅ 反馈已提交，感谢你的支持！';
                    status.style.color = '#10B981';
                    textarea.value = '';
                })
                .catch((err) => {
                    status.textContent = '❌ ' + (err.message || '提交失败');
                    status.style.color = '#EF4444';
                })
                .finally(() => {
                    btn.disabled = false;
                    btn.textContent = '📮 提交反馈';
                    btn.style.opacity = '';
                    setTimeout(() => { status.textContent = ''; }, 4000);
                });
        });
    }

    function injectCustomRulesSection(overlay) {
        const scroll = overlay.querySelector('.iz-panel-scroll');
        if (!scroll || scroll.querySelector('#izCustomRulesSection')) return;
        const section = document.createElement('div');
        section.className = 'iz-section';
        section.id = 'izCustomRulesSection';

        const renderList = () => {
            const rules = getCustomRules();
            if (!rules.length) return '<div style="font-size:12px;color:#94A3B8;padding:6px 0;line-height:1.6;">暂无自定义规则。</div>';
            return rules.map(r => `
                <div class="iz-rule-item" data-id="${r.id}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(226,232,240,.5);">
                    <input type="checkbox" class="iz-rule-enabled" ${r.enabled ? 'checked' : ''} style="flex-shrink:0;">
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:600;color:#1E293B;">${escapeHtml(r.name)} <span style="font-size:11px;color:#94A3B8;font-weight:400;">· ${escapeHtml(r.domains)}</span></div>
                        <div style="font-size:11px;color:#64748B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.imgMode === 'img' ? 'IMG' : '背景图'} | ${escapeHtml(r.itemSelector)} | ${escapeHtml(r.cardSelector || '无卡片选择器')}</div>
                    </div>
                    <button class="iz-rule-del" style="border:none;background:none;color:#EF4444;cursor:pointer;font-size:16px;flex-shrink:0;" title="删除">✕</button>
                </div>`).join('');
        };

        section.innerHTML = `
            <div class="iz-section-title">🎯 高级：站点规则自定义 <span class="iz-badge">进阶-不会添加用⬆️反馈</span></div>
            <div class="iz-exclusion-note" style="margin-bottom:10px;">为当前网站添加悬停放大规则，解决遮罩层挡住鼠标、背景图无法放大等问题。保存后刷新页面生效。</div>
            <div id="izRuleList">${renderList()}</div>
            <button id="izRuleAddBtn" class="iz-btn-sm primary" style="margin-top:10px;">＋ 为当前网站添加规则</button>
            <div id="izRuleForm" style="display:none;margin-top:12px;padding:14px;background:#fff;border-radius:12px;border:1.5px solid #E2E8F0;">
                <div class="iz-param-item" style="margin-bottom:10px;"><label>规则名称</label><input id="izRuleName" type="text" placeholder="选填" style="width:100%;box-sizing:border-box;height:36px;padding:0 10px;border:1.5px solid #E2E8F0;border-radius:10px;outline:none;font-size:13px;"></div>
                <div class="iz-param-item" style="margin-bottom:10px;"><label>域名（逗号分隔，留空为当前网站）</label><input id="izRuleDomains" type="text" placeholder="${currentDomain}" style="width:100%;box-sizing:border-box;height:36px;padding:0 10px;border:1.5px solid #E2E8F0;border-radius:10px;outline:none;font-size:13px;"></div>
                <div class="iz-param-item" style="margin-bottom:10px;"><label>图片容器选择器（背景图元素的 CSS 选择器）</label><input id="izRuleItem" type="text" placeholder="如：.image-container-top 或 .img-wrapper" style="width:100%;box-sizing:border-box;height:36px;padding:0 10px;border:1.5px solid #E2E8F0;border-radius:10px;outline:none;font-size:13px;"></div>
                <div class="iz-param-item" style="margin-bottom:10px;"><label>卡片选择器</label><input id="izRuleCard" type="text" placeholder="如：.qtd-theme-card" style="width:100%;box-sizing:border-box;height:36px;padding:0 10px;border:1.5px solid #E2E8F0;border-radius:10px;outline:none;font-size:13px;"></div>
                <div style="font-size:12px;color:#94A3B8;margin-bottom:10px;">💡 不会写选择器？点「🖱️ 拾取选择器」后直接在页面上点一下图片即可自动填写。</div>
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button id="izRulePickBtn" class="iz-btn-sm" style="background:#EEF2FF;color:#4F46E5;border:none;">🖱️ 拾取选择器</button>
                    <button id="izRuleCancel" class="iz-btn-sm" style="background:#F1F5F9;color:#64748B;border:none;">取消</button>
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
            const shareBar = section.querySelector('.iz-rule-share-bar');
            if (shareBar) shareBar.remove();
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
            const oldShareBar = section.querySelector('.iz-rule-share-bar');
            if (oldShareBar) oldShareBar.remove();
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
            const shareBar = document.createElement('div');
            shareBar.className = 'iz-rule-share-bar';
            shareBar.style.cssText = 'margin-top:10px;padding:10px 14px;background:#F0FDF4;border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:#166534;';
            shareBar.innerHTML = `<span>是否把这条规则分享给作者，帮助更多用户？（仅发送域名和选择器）</span><button class="iz-rule-share-btn" style="flex-shrink:0;border:none;background:#10B981;color:#fff;padding:5px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;">分享</button>`;
            form.parentNode.insertBefore(shareBar, form.nextSibling);
            shareBar.querySelector('.iz-rule-share-btn').addEventListener('click', function() {
                const btn = this;
                btn.disabled = true;
                btn.textContent = '发送中…';
                submitSiteRule(lastSavedRule).then(() => {
                    btn.textContent = '✓ 已分享，感谢！';
                    btn.style.background = '#64748B';
                    storageSet(`rule_shared_${lastSavedRule.id}`, true);
                    setTimeout(() => shareBar.remove(), 3000);
                }).catch((err) => {
                    btn.disabled = false;
                    btn.textContent = '重试';
                    showToast('分享失败：' + err.message);
                });
            });
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

        const renderParams = (defs) => defs.map(p => `
            <div class="iz-param-item">
                <label>${p.label}<span class="iz-tip-icon" data-tip="${p.tip}">?</span></label>
                <div class="iz-input-group" data-param="${p.key}"><input type="number" class="iz-param-input" data-param="${p.key}" value="${config[p.key]}" min="${p.min}" max="${p.max}" step="${p.step}"/><span class="iz-unit">${p.unit}</span></div>
            </div>`).join('');

        overlay.innerHTML = `
            <div id="izConfigPanel">
                <div class="iz-panel-header">
                    <div class="iz-panel-header-left">
                        <div class="iz-panel-icon">🔍</div>
                        <div class="iz-panel-title">图片放大设置<span>· 悬停预览</span></div>
                    </div>
                    <button class="iz-close-btn" id="izCloseBtn" title="关闭 (ESC)">✕</button>
                </div>
                <div class="iz-panel-scroll">
                    <div class="iz-section">
                        <div class="iz-section-title">📌 主页排除 <span class="iz-badge">当前网站</span></div>
                        <div class="iz-exclusion-box">
                            <div class="iz-status-row">
                                <div class="iz-status-text"><span class="iz-dot on" id="izHpDot"></span><span id="izHpText">当前主页已启用图片放大</span></div>
                                <button class="iz-btn-sm warning" id="izHpToggleBtn">禁用主页图片放大功能</button>
                            </div>
                            <div class="iz-exclusion-note">仅对当前网站（${currentDomain}）的主页生效，内容子页面不受影响，依然会放大图片</div>
                        </div>
                    </div>
                    <div class="iz-section">
                        <div class="iz-section-title">⚙️ 基本设置</div>
                        <div class="iz-row">
                            <div class="iz-row-label">放大模式<span class="iz-hint">智能 / 固定</span></div>
                            <div class="iz-row-control">
                                <select class="iz-select" id="izModeSelect">
                                    <option value="adaptive">✨ 智能自适应</option>
                                    <option value="fixed">📐 固定倍数</option>
                                </select>
                            </div>
                        </div>
                        <div class="iz-row">
                            <div class="iz-row-label" style="min-width:0;flex:1;">
                                <div class="iz-checkbox-wrap" id="izConflictWrap">
                                    <div class="iz-checkbox-custom ${config.avoidClickConflict ? 'checked' : ''}" id="izConflictCheck"></div>
                                    <span class="iz-checkbox-label">避免与点击放大功能冲突<span class="iz-sub">自动检测网站点击放大，避免冲突</span></span>
                                </div>
                            </div>
                        </div>
                        <div class="iz-row" style="margin-bottom:0">
                            <div class="iz-row-label" style="min-width:0;flex:1;">
                                <div class="iz-checkbox-wrap" id="izBlurDismissWrap">
                                    <div class="iz-checkbox-custom ${config.blurDismiss ? 'checked' : ''}" id="izBlurDismissCheck"></div>
                                    <span class="iz-checkbox-label">切换应用时自动收起放大图<span class="iz-sub">Alt+Tab 或点击其他窗口时关闭；关闭后切回可继续查看，适合对照场景</span></span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="iz-section">
                        <div class="iz-collapse-header" id="izCommonHeader">
                            <div class="iz-left"><span class="iz-arrow" id="izCommonArrow">▶</span><span>通用参数</span><span class="iz-badge-params">自适应 / 固定 都生效</span></div>
                            <span style="font-size:12px;color:#94A3B8;" id="izCommonHint">点击展开 · 悬停问号查看参数说明</span>
                        </div>
                        <div class="iz-collapse-body" id="izCommonBody"><div class="iz-param-grid">${renderParams(COMMON_PARAM_DEFS)}</div></div>
                    </div>
                    <div class="iz-section">
                        <div class="iz-collapse-header" id="izFixedHeader">
                            <div class="iz-left"><span class="iz-arrow" id="izFixedArrow">▶</span><span>固定倍数专用参数</span><span class="iz-badge-params" id="izModeBadge">智能自适应模式</span></div>
                            <span style="font-size:12px;color:#94A3B8;" id="izFixedHint">自适应模式下不可用</span>
                        </div>
                        <div class="iz-collapse-body" id="izFixedBody"><div class="iz-param-grid">${renderParams(FIXED_PARAM_DEFS)}</div></div>
                    </div>
                    <div class="iz-section">
                        <div class="iz-section-title">🎬 B站播放器辅助</div>
                        <div class="iz-row" style="margin-bottom:0">
                            <div class="iz-row-label" style="min-width:0;flex:1;">
                                <div class="iz-toggle-wrap" id="izBiliWrap">
                                    <div class="iz-toggle ${bilibiliVolumeModule.isEnabled ? 'active' : ''}" id="izBiliToggle"><div class="iz-knob"></div></div>
                                    <span class="iz-toggle-label">启用B站播放器辅助<span class="iz-sub">全屏时滚轮调节音量 · 方向键防穿透</span></span>
                                </div>
                            </div>
                        </div>
                        <div style="margin-top:10px;padding-left:2px;font-size:12px;line-height:1.7;color:#94A3B8;">
                            <div>· 放大模块会导致B站原生滚轮调整音量失效</div>
                            <div>· 需开启此辅助解决滚轮调整音量的问题</div>
                        </div>
                    </div>
                </div>
                <div class="iz-panel-footer">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <button class="iz-btn-ghost" id="izHelpBtn">? 使用说明</button>
                        <button class="iz-btn-ghost" id="izResetBtn">↺ 恢复默认设置</button>
                    </div>
                    <button class="iz-btn-primary-solid" id="izSaveBtn">✓ 保存并关闭</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        injectFeedbackSection(overlay);
        injectCustomRulesSection(overlay);

        const $ = (id) => overlay.querySelector('#' + id);
        const modeSelect = $('izModeSelect');
        const conflictCheck = $('izConflictCheck');
        const commonHeader = $('izCommonHeader');
        const commonBody = $('izCommonBody');
        const commonArrow = $('izCommonArrow');
        const commonHint = $('izCommonHint');
        const fixedHeader = $('izFixedHeader');
        const fixedBody = $('izFixedBody');
        const fixedArrow = $('izFixedArrow');
        const fixedHint = $('izFixedHint');
        const modeBadge = $('izModeBadge');
        const biliToggle = $('izBiliToggle');

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
            modeBadge.textContent = isFixed ? '固定倍数模式' : '智能自适应模式';
            if (isFixed) {
                fixedHeader.style.cursor = 'pointer';
                fixedHeader.style.opacity = '1';
                fixedHint.textContent = '点击展开 · 悬停问号查看参数说明';
            } else {
                fixedBody.classList.remove('open');
                fixedArrow.classList.remove('open');
                fixedHeader.style.cursor = 'not-allowed';
                fixedHeader.style.opacity = '0.55';
                fixedHint.textContent = '自适应模式下不可用';
            }
            overlay.querySelectorAll('.iz-param-input').forEach(input => {
                const isFixedParam = FIXED_PARAM_DEFS.some(p => p.key === input.dataset.param);
                input.disabled = isFixedParam && !isFixed;
                const group = input.closest('.iz-input-group');
                if (group) group.classList.toggle('disabled-group', isFixedParam && !isFixed);
            });
        }

        $('izHpToggleBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleHomepageDisabled();
        });

        modeSelect.addEventListener('change', () => {
            config.zoomMode = modeSelect.value;
            saveConfig();
            updateDetailState();
            showSaveToast(`已切换至 ${config.zoomMode === 'fixed' ? '固定倍数' : '智能自适应'} 模式`);
        });

        $('izConflictWrap').addEventListener('click', (e) => {
            if (e.target.closest('.iz-checkbox-custom') || e.target.closest('.iz-checkbox-label')) {
                config.avoidClickConflict = !config.avoidClickConflict;
                conflictCheck.classList.toggle('checked', config.avoidClickConflict);
                saveConfig();
                showSaveToast(`避免与点击放大功能冲突 ${config.avoidClickConflict ? '已开启' : '已关闭'}`);
            }
        });

        $('izBlurDismissWrap').addEventListener('click', (e) => {
            if (e.target.closest('.iz-checkbox-custom') || e.target.closest('.iz-checkbox-label')) {
                config.blurDismiss = !config.blurDismiss;
                $('izBlurDismissCheck').classList.toggle('checked', config.blurDismiss);
                saveConfig();
                showSaveToast(`切换应用时收起放大图 ${config.blurDismiss ? '已开启' : '已关闭（切回可继续查看）'}`);
            }
        });

        commonHeader.addEventListener('click', () => {
            const isOpen = commonBody.classList.contains('open');
            commonBody.classList.toggle('open');
            commonArrow.classList.toggle('open');
            commonHint.textContent = isOpen ? '点击展开 · 悬停问号查看参数说明' : '点击收起';
        });

        fixedHeader.addEventListener('click', () => {
            if (config.zoomMode !== 'fixed') {
                showSaveToast('切换到固定倍数模式后才能调整这些参数');
                return;
            }
            const isOpen = fixedBody.classList.contains('open');
            fixedBody.classList.toggle('open');
            fixedArrow.classList.toggle('open');
            fixedHint.textContent = isOpen ? '点击展开 · 悬停问号查看参数说明' : '点击收起';
        });

        overlay.querySelectorAll('.iz-param-input').forEach(input => {
            const key = input.dataset.param;
            const def = COMMON_PARAM_DEFS.concat(FIXED_PARAM_DEFS).find(p => p.key === key);
            input.addEventListener('input', () => {
                let val = parseFloat(input.value);
                if (isNaN(val)) val = defaultConfig[key];
                // 运行时输入按 CONFIG_LIMITS 钳制（之前只在加载时校验，
                // 面板里手输 99999 会被原样保存进本次会话的 config）
                if (CONFIG_LIMITS[key]) {
                    const [mn, mx] = CONFIG_LIMITS[key];
                    val = Math.max(mn, Math.min(mx, val));
                }
                config[key] = val;
                saveConfig();
                notifyConfigSaved(key, val, def ? def.label : key);
            });
        });

        $('izBiliWrap').addEventListener('click', (e) => {
            if (e.target.closest('.iz-toggle')) {
                e.stopPropagation();
                const newState = !bilibiliVolumeModule.isEnabled;
                bilibiliVolumeModule.setEnabled(newState);
                biliToggle.classList.toggle('active', newState);
                showSaveToast(`B站播放器辅助 ${newState ? '已启用' : '已禁用'}`);
            }
        });

        $('izResetBtn').addEventListener('click', () => {
            if (!confirm('确定要恢复所有设置为默认值吗？')) return;
            config = { ...defaultConfig };
            saveConfig();
            modeSelect.value = config.zoomMode;
            conflictCheck.classList.toggle('checked', config.avoidClickConflict);
            $('izBlurDismissCheck').classList.toggle('checked', config.blurDismiss);
            overlay.querySelectorAll('.iz-param-input').forEach(input => {
                input.value = config[input.dataset.param];
            });
            updateDetailState();
            showToast('已恢复默认设置 🎉');
        });

        function closePanel() {
            overlay.classList.add('anim-out');
            setTimeout(() => {
                overlay.style.display = 'none';
                overlay.classList.remove('anim-out');
            }, 300);
        }

        $('izCloseBtn').addEventListener('click', closePanel);
        $('izHelpBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            closePanel();
            setTimeout(() => showIntroPanel(true), 220);
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
        overlay.querySelector('#izModeSelect').value = config.zoomMode;
        overlay.querySelector('#izConflictCheck').classList.toggle('checked', config.avoidClickConflict);
        overlay.querySelector('#izBlurDismissCheck').classList.toggle('checked', config.blurDismiss);
        overlay.querySelectorAll('.iz-param-input').forEach(i => {
            i.value = config[i.dataset.param];
        });
        overlay.querySelector('#izBiliToggle').classList.toggle('active', bilibiliVolumeModule.isEnabled);
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
        createDockButton();
        if (isEnabled) {
            setTimeout(showIntroPanel, 180);
            setTimeout(showUpdateNotice, 260);
        }

        // ★ 全局 mousemove：坐标权威源（停稳裁决器/心跳/TIMER_FIRE 使用）。
        // 直接写入不节流——handler 本身只有三次赋值，开销可忽略；
        // 停稳裁决器通过 debounce 自身控制频率，无需在此节流。
        document.addEventListener('mousemove', (e) => {
            lastMouse.x = e.clientX;
            lastMouse.y = e.clientY;
            lastMouse.t = Date.now();
            pointerInWindow = true;   // ★ 光标回到浏览器内
        }, { passive: true });

        window.addEventListener('resize', debounce(() => {
            if (isEnabled) zoomFSM.dispatch('DISMISS');
        }, 250));

        setupLightboxObserver();
        if (isEnabled) initImages();
        setupGlobalHoverStream(); // ★ mouseover 流 + 停稳裁决器 双保险
        setupHeartbeat();         // ★ 持续复核（PENDING/ACTIVE，带失败容忍，后台页暂停）
        setupBgRuleProxy();
        setupAutoBackgroundHover();
        startObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mainInit);
    } else {
        mainInit();
    }
})();
