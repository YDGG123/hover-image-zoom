// ==UserScript==
// @name         鼠标悬停图片自动放大预览
// @namespace    https://github.com/YDGG123
// @version      4.3.0
// @description  一款好用的网页图片放大工具，鼠标悬停即可自动放大图片，适配所有网页～
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

/*
 * v4.3.0 更新日志：
 * - 新增：放大图黑边自动裁剪（图片上下/左右的黑边自动去除，只显示有效内容）
 * - 新增：论坛缩略图高清化（Discuz 站点 /remote/thumb/宽x高/ 形式的缩略图自动替换为原图地址）
 * - 优化：放大图加载更稳（跨域受限的图片自动降级重试，避免个别站点放大图加载失败）
 * - 优化：背景图卡片站点的悬停放大支持（覆盖层遮挡也能正常触发放大，防闪烁）
 */


(function() {
    'use strict';

    // ================================
    // 图片放大功能模块
    // ================================
    const imageZoomModule = (function() {

        const defaultConfig = {
            delay: 500,
            scale: 3,
            maxWidth: 1200,
            maxHeight: 980,
            minScale: 1.4,
            portraitRatio: 1.3,
            zoomZIndex: 9999,
            transition: 'all 0.3s ease',
            scrollSpeed: 50,
            smallImgThreshold: 280,
            smallImgWidth: 500,
            smallImgHeight: 430,
            avoidClickConflict: true,
            zoomMode: 'adaptive',
            minOriginalSize: 30
        };

        const states = new WeakMap();
        let isEnabled = true;
        let config = { ...defaultConfig };
        const currentDomain = getDomain();

        let currentZoomContainer = null;
        let toggleButton = null;
        let gearButton = null;
        let dockZone = null;
        let dockTip = null;
        let settingsTip = null;
        let zoomObserver = null;
        let lightboxObserver = null;
        let styleElement = null;
        let dockStyleElement = null; // 悬浮按钮 + 配置面板样式（永不随 cleanup 移除）

        const DEBUG_IMAGE_CHECK = false;

        const COMMON_SELECTORS = [
            '[onclick*="zoom"]', '[onclick*="lightbox"]', '[onclick*="gallery"]',
            '[onclick*="preview"]', '[data-action*="zoom"]', '[data-lightbox]',
            '[data-gallery]', '[data-fancybox]', '.zoomable', '.lightbox',
            '.gallery-item', '.fancybox', '.stretched-link'
        ];


        const SITE_HOVER_PROXY_RULES = [
            {
                domains: ['jd.com'],
                imgMode: 'img',
                itemSelector: '.more2_img, .img-wrapper',
                cardSelector: 'li, .jd-pick-content-item',
                pollInterval: 300
            },
            {
                domains: ['taobao.com', 'tmall.com'],
                imgMode: 'background',
                itemSelector: '.img-wrapper',
                cardSelector: '.tb-pick-content-item, li',
                pollInterval: 300
            }
        ];



        function getDomain() {
            try {
                return new URL(window.location.href).hostname;
            } catch (e) {
                return window.location.hostname || 'unknown';
            }
        }

        // 主页禁用：域名级开关，仅影响当前网站的主页
        function isHomepageDisabled() {
            return GM_getValue(`image_zoom_homepage_disabled_${currentDomain}`, false);
        }

        function refreshPanelHomepageSection() {
            const overlay = document.getElementById('izModalOverlay');
            if (!overlay) return;
            const disabled = isHomepageDisabled();
            const hpDot = overlay.querySelector('#izHpDot');
            const hpText = overlay.querySelector('#izHpText');
            const hpBtn = overlay.querySelector('#izHpToggleBtn');
            if (hpDot) hpDot.className = disabled ? 'iz-dot off' : 'iz-dot on';
            if (hpText) hpText.textContent = disabled ? '当前主页已禁用图片放大' : '当前主页已启用图片放大';
            if (hpBtn) {
                hpBtn.textContent = disabled ? '启用主页图片放大功能' : '禁用主页图片放大功能';
                hpBtn.className = disabled ? 'iz-btn-sm primary' : 'iz-btn-sm warning';
            }
        }

        function toggleHomepageDisabled() {
            const disabled = !isHomepageDisabled();
            GM_setValue(`image_zoom_homepage_disabled_${currentDomain}`, disabled);
            if (disabled && isHomepage() && isEnabled) {
                cleanup();
            }
            showToast(disabled ? '已禁用当前网站主页的图片放大功能' : '已启用当前网站主页的图片放大功能');
            updateButtonState();
            refreshPanelHomepageSection();
        }

        function isHomepage() {
            const path = window.location.pathname;
            return path === '/' || path === '/index.html' || path === '/index.php' || path === '';
        }

        function isHomepageZoomDisabled() {
            return isHomepage() && isHomepageDisabled();
        }

        function showToast(message) {
            let toast = document.getElementById('image-zoom-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'image-zoom-toast';
                toast.style.cssText = `
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(0, 0, 0, 0.8); color: white; padding: 12px 20px;
                    border-radius: 6px; z-index: 1000000; font-size: 14px;
                    font-family: Arial, sans-serif; opacity: 0; transition: opacity 0.3s ease;
                    pointer-events: none;
                `;
                document.body.appendChild(toast);
            }
            toast.textContent = message;
            toast.style.opacity = '1';
            if (toast.timeoutId) clearTimeout(toast.timeoutId);
            toast.timeoutId = setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => {
                    if (toast && toast.parentNode) {
                        toast.parentNode.removeChild(toast);
                        toast = null;
                    }
                }, 300);
            }, 2000);
        }

        let saveToastTimeout = null;
        let saveToastEl = null;

        const debouncedSaveToast = debounce(function(message) {
            showSaveToast(message);
        }, 600);

        function showSaveToast(message) {
            if (!saveToastEl || !saveToastEl.parentNode) {
                saveToastEl = document.createElement('div');
                saveToastEl.id = 'image-zoom-save-toast';
                saveToastEl.style.cssText = `
                    position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
                    background: rgba(15, 23, 42, 0.88); color: #fff; padding: 12px 24px;
                    border-radius: 16px; font-size: 14px; font-weight: 500; font-family: Arial, sans-serif;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08);
                    opacity: 0; transform: translateX(-50%) translateY(16px);
                    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                    pointer-events: none; z-index: 1000001; max-width: 300px; text-align: center;
                `;
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

        function notifyConfigSaved(key, value, label) {
            debouncedSaveToast(`已保存：${label || key} = ${value}`);
        }

        function debounce(func, wait) {
            let timeout;
            return function(...args) {
                const context = this;
                const later = () => {
                    clearTimeout(timeout);
                    func.apply(context, args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        function validateConfig(cfg) {
            const validated = { ...cfg };
            validated.delay = Math.max(0, Math.min(2000, validated.delay));
            validated.scale = Math.max(1, Math.min(5, validated.scale));
            validated.maxWidth = Math.max(100, Math.min(5000, validated.maxWidth));
            validated.maxHeight = Math.max(100, Math.min(5000, validated.maxHeight));
            validated.minScale = Math.max(1, Math.min(3, validated.minScale));
            validated.portraitRatio = Math.max(1, Math.min(5, validated.portraitRatio));
            validated.scrollSpeed = Math.max(1, Math.min(50, validated.scrollSpeed));
            validated.smallImgThreshold = Math.max(50, Math.min(1000, validated.smallImgThreshold));
            validated.smallImgWidth = Math.max(100, Math.min(2000, validated.smallImgWidth));
            validated.smallImgHeight = Math.max(100, Math.min(2000, validated.smallImgHeight));
            validated.minOriginalSize = Math.max(0, Math.min(500, validated.minOriginalSize || 0));
            validated.zoomMode = validated.zoomMode === 'fixed' ? 'fixed' : 'adaptive';
            return validated;
        }

        function loadConfig() {
            const savedConfig = GM_getValue(`image_zoom_config_${currentDomain}`);
            if (savedConfig) {
                const validatedConfig = validateConfig(savedConfig);
                config = { ...defaultConfig, ...validatedConfig };
            }
        }

        function saveConfig() {
            GM_setValue(`image_zoom_config_${currentDomain}`, config);
        }

        function loadState() {
            const savedState = GM_getValue(`image_zoom_enabled_${currentDomain}`);
            isEnabled = savedState !== false;
            if (isHomepageZoomDisabled()) {
                isEnabled = false;
            }
        }

        function injectStyles() {
            // 悬浮按钮 + 配置面板样式放在独立样式表中，不随 cleanup 移除
            if (!dockStyleElement) {
                const dockStyle = document.createElement('style');
                dockStyle.textContent = `
                    #zoomDockZone { position: fixed; right: 0; top: 50%; transform: translateY(-50%); width: 110px; height: 120px; z-index: 100000; pointer-events: none; }
                    #zoomDockZone.open { pointer-events: auto; }
                    #zoomDock { position: absolute; right: -20px; top: 10px; width: 44px; height: 44px; border-radius: 22px 0 0 22px; background: rgba(52, 211, 153, 0.20) !important; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(52, 211, 153, 0.32) !important; border-right: none; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18) !important; display: flex; align-items: center; justify-content: center; padding-left: 2px; transition: right 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease, background 0.3s ease; opacity: 0.6; pointer-events: auto; cursor: pointer; z-index: 100001; }
                    #zoomDockZone.open #zoomDock { right: 0; opacity: 1; }
                    #zoomDock.off { background: rgba(239, 68, 68, 0.20) !important; border-color: rgba(239, 68, 68, 0.32) !important; }
                    #zoomDock.off .icon-svg { opacity: 0.7; }
                    #zoomDock.hp { background: rgba(255, 152, 0, 0.22) !important; border-color: rgba(255, 152, 0, 0.35) !important; }
                    #zoomDockZone.open #zoomDock:hover { filter: brightness(1.25); }
                    .icon-svg { width: 20px; height: 20px; fill: none; stroke: rgba(255, 255, 255, 0.92); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2)); pointer-events: none; transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); transform: translateX(-8px); }
                    #zoomDockZone.open .icon-svg { transform: translateX(0); }
                    #statusDot { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 6px; height: 6px; border-radius: 50%; background: #34d399; box-shadow: 0 0 12px rgba(52, 211, 153, 0.5); transition: background 0.3s, box-shadow 0.3s; opacity: 0.7; pointer-events: none; }
                    #zoomDock.off #statusDot { background: #f87171; box-shadow: 0 0 12px rgba(248, 113, 113, 0.5); }
                    #zoomDock.hp #statusDot { background: #ffb74d; box-shadow: 0 0 12px rgba(255, 152, 0, 0.5); }
                    #zoomDockZone.open #statusDot { opacity: 1; }
                    #zoomSettings { position: absolute; right: 0; top: 62px; width: 32px; height: 32px; border-radius: 16px 0 0 16px; background: rgba(20, 24, 44, 0.75) !important; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.14) !important; border-right: none; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transform: translateX(18px) scale(0.9); pointer-events: none; transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) 0.06s; z-index: 100002; }
                    #zoomDockZone.open #zoomSettings { opacity: 1; transform: translateX(0) scale(1); pointer-events: auto; }
                    #zoomSettings:hover { background: rgba(30, 36, 64, 0.85) !important; border-color: rgba(251, 191, 36, 0.35) !important; box-shadow: 0 4px 28px rgba(251, 191, 36, 0.18); }
                    #zoomSettings .icon-svg--gear { width: 16px; height: 16px; stroke: rgba(255, 255, 255, 0.9); stroke-width: 2; fill: none; transition: stroke 0.3s, transform 0.6s ease; pointer-events: none; }
                    #zoomSettings:hover .icon-svg--gear { stroke: #fbbf24; transform: rotate(60deg); }
                    .zoom-bubble-tip { position: fixed; background: rgba(20, 20, 40, 0.80); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.90); padding: 6px 16px; border-radius: 10px; font-size: 12px; font-weight: 450; letter-spacing: 0.3px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.25s ease 0.2s; z-index: 100003; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4); }
                    .zoom-bubble-tip::after { content: ''; position: absolute; right: -6px; top: 50%; transform: translateY(-50%); border: 6px solid transparent; border-left-color: rgba(20, 20, 40, 0.80); border-right: 0; }
                    .zoom-bubble-tip.visible { opacity: 1; }
                    body.zoom-dock-dragging, body.zoom-dock-dragging * { transition: none !important; cursor: grabbing !important; user-select: none !important; }
                    body.zoom-dock-dragging #zoomDock { cursor: grabbing !important; }
                    #izModalOverlay { position: fixed; inset: 0; z-index: 99999; display: none; align-items: center; justify-content: center; padding: 24px; background: rgba(15, 23, 42, 0.45); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
                    #izModalOverlay.anim-in { animation: izOverlayFade 0.35s ease; }
                    #izModalOverlay.anim-out { animation: izOverlayFadeOut 0.3s ease forwards; }
                    @keyframes izOverlayFade { from { opacity: 0; } to { opacity: 1; } }
                    @keyframes izOverlayFadeOut { from { opacity: 1; } to { opacity: 0; } }
                    #izConfigPanel { width: 100%; max-width: 560px; max-height: 90vh; background: rgba(255, 255, 255, 0.88); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 28px; box-shadow: 0 25px 60px -12px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.6) inset; overflow: hidden; animation: izPanelSlide 0.40s cubic-bezier(0.16, 1, 0.3, 1); display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; box-sizing: border-box; }
                    @keyframes izPanelSlide { from { opacity: 0; transform: translateY(28px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
                    .iz-panel-scroll { flex: 1; overflow-y: auto; padding: 0 28px 12px 28px; scroll-behavior: smooth; }
                    .iz-panel-scroll::-webkit-scrollbar { width: 4px; }
                    .iz-panel-scroll::-webkit-scrollbar-track { background: transparent; }
                    .iz-panel-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 8px; }
                    .iz-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 28px 0 28px; flex-shrink: 0; }
                    .iz-panel-header-left { display: flex; align-items: center; gap: 12px; }
                    .iz-panel-icon { width: 38px; height: 38px; background: linear-gradient(135deg, #4F46E5, #7C3AED); border-radius: 12px; display: flex; align-items: center; justify-content: center; color: white; font-size: 20px; flex-shrink: 0; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3); }
                    .iz-panel-title { font-size: 20px; font-weight: 600; color: #0F172A; letter-spacing: -0.3px; }
                    .iz-panel-title span { font-weight: 400; color: #64748B; font-size: 14px; margin-left: 6px; }
                    .iz-close-btn { width: 36px; height: 36px; border: none; background: rgba(203, 213, 225, 0.4); border-radius: 50%; cursor: pointer; font-size: 18px; color: #64748B; display: flex; align-items: center; justify-content: center; transition: all 0.2s; flex-shrink: 0; line-height: 1; }
                    .iz-close-btn:hover { background: rgba(239, 68, 68, 0.12); color: #EF4444; transform: rotate(90deg); }
                    .iz-section { margin-top: 20px; background: rgba(255, 255, 255, 0.5); border-radius: 18px; padding: 18px 20px 20px 20px; border: 1px solid rgba(226, 232, 240, 0.7); }
                    .iz-section-title { font-size: 13px; font-weight: 600; color: #64748B; letter-spacing: 0.6px; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
                    .iz-badge { background: #4F46E5; color: white; font-size: 10px; font-weight: 600; padding: 0 8px; border-radius: 20px; line-height: 18px; }
                    .iz-row { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
                    .iz-row:last-child { margin-bottom: 0; }
                    .iz-row-label { font-size: 14px; font-weight: 500; color: #1E293B; flex-shrink: 0; min-width: 100px; }
                    .iz-row-label .iz-hint { font-weight: 400; font-size: 12px; color: #94A3B8; display: block; margin-top: 1px; }
                    .iz-row-control { flex: 1; min-width: 0; }
                    .iz-select { width: 100%; padding: 8px 36px 8px 14px; font-size: 14px; font-weight: 500; color: #0F172A; background: white url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2364748b' d='M6 8L1 3h10z'/%3E%3C/svg%3E") no-repeat right 14px center; background-size: 12px; border: 1.5px solid #E2E8F0; border-radius: 12px; appearance: none; -webkit-appearance: none; transition: all 0.2s; cursor: pointer; outline: none; height: 42px; }
                    .iz-select:hover { border-color: #A5B4FC; }
                    .iz-select:focus { border-color: #4F46E5; box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15); }
                    .iz-input-group { display: flex; align-items: center; background: white; border: 1.5px solid #E2E8F0; border-radius: 12px; overflow: hidden; transition: all 0.2s; height: 42px; }
                    .iz-input-group:focus-within { border-color: #4F46E5; box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15); }
                    .iz-input-group input[type="number"] { flex: 1; border: none; padding: 0 12px; font-size: 14px; font-weight: 500; color: #0F172A; background: transparent; outline: none; min-width: 0; height: 100%; width: 100%; -moz-appearance: textfield; }
                    .iz-input-group input[type="number"]::-webkit-inner-spin-button, .iz-input-group input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
                    .iz-input-group .iz-unit { padding: 0 14px 0 4px; font-size: 13px; color: #94A3B8; font-weight: 500; flex-shrink: 0; }
                    .iz-input-group.disabled-group { opacity: 0.6; background-color: #f8fafc; border-color: #e2e8f0; cursor: not-allowed; }
                    .iz-input-group.disabled-group input { cursor: not-allowed; background-color: #f8fafc; }
                    .iz-checkbox-wrap { display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
                    .iz-checkbox-custom { width: 20px; height: 20px; flex-shrink: 0; border: 2px solid #CBD5E1; border-radius: 6px; background: white; transition: all 0.2s; display: flex; align-items: center; justify-content: center; }
                    .iz-checkbox-custom.checked { background: #4F46E5; border-color: #4F46E5; }
                    .iz-checkbox-custom.checked::after { content: "✓"; color: white; font-size: 14px; font-weight: 700; line-height: 1; }
                    .iz-checkbox-label { font-size: 14px; font-weight: 500; color: #1E293B; }
                    .iz-checkbox-label .iz-sub { font-weight: 400; font-size: 12px; color: #94A3B8; display: block; margin-top: 1px; }
                    .iz-toggle-wrap { display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
                    .iz-toggle { position: relative; width: 46px; height: 28px; flex-shrink: 0; background: #CBD5E1; border-radius: 20px; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1); }
                    .iz-toggle.active { background: linear-gradient(135deg, #4F46E5, #7C3AED); }
                    .iz-toggle .iz-knob { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; background: white; border-radius: 50%; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18); }
                    .iz-toggle.active .iz-knob { left: 21px; }
                    .iz-exclusion-box { background: rgba(241, 245, 249, 0.7); border-radius: 14px; padding: 14px 16px; border: 1px solid rgba(226, 232, 240, 0.5); }
                    .iz-exclusion-box .iz-status-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
                    .iz-exclusion-box .iz-status-text { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; color: #1E293B; }
                    .iz-exclusion-box .iz-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
                    .iz-exclusion-box .iz-dot.on { background: #10B981; }
                    .iz-exclusion-box .iz-dot.off { background: #F59E0B; }
                    .iz-exclusion-note { margin-top: 8px; font-size: 12px; color: #64748B; }
                    .iz-btn-sm { padding: 6px 16px; border: none; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; flex-shrink: 0; height: 34px; }
                    .iz-btn-sm.primary { background: #4F46E5; color: white; }
                    .iz-btn-sm.primary:hover { background: #4338CA; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3); }
                    .iz-btn-sm.warning { background: #F59E0B; color: white; }
                    .iz-btn-sm.warning:hover { background: #D97706; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3); }
                    .iz-collapse-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 0 6px 0; cursor: pointer; user-select: none; border-top: 1px solid rgba(226, 232, 240, 0.5); margin-top: 4px; transition: opacity 0.2s; }
                    .iz-collapse-header .iz-left { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; color: #1E293B; }
                    .iz-collapse-header .iz-arrow { transition: transform 0.3s ease; font-size: 12px; color: #94A3B8; }
                    .iz-collapse-header .iz-arrow.open { transform: rotate(90deg); }
                    .iz-badge-params { font-size: 11px; font-weight: 500; color: #64748B; background: #F1F5F9; padding: 2px 10px; border-radius: 20px; }
                    .iz-collapse-body { overflow: hidden; max-height: 0; opacity: 0; transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1); }
                    .iz-collapse-body.open { max-height: 800px; opacity: 1; padding-top: 12px; }
                    .iz-param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
                    .iz-param-item { display: flex; flex-direction: column; gap: 4px; }
                    .iz-param-item label { font-size: 12px; font-weight: 500; color: #64748B; letter-spacing: 0.2px; display: flex; align-items: center; gap: 5px; }
                    .iz-tip-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex-shrink: 0; border-radius: 50%; background: #E2E8F0; color: #64748B; font-size: 10px; font-weight: 700; line-height: 1; cursor: help; position: relative; transition: all 0.2s; }
                    .iz-tip-icon:hover { background: #4F46E5; color: white; }
                    #izTipBubble { position: fixed; width: 240px; background: rgba(15, 23, 42, 0.95); color: #F1F5F9; font-size: 12px; font-weight: 400; line-height: 1.6; padding: 10px 13px; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); opacity: 0; pointer-events: none; transition: opacity 0.15s ease; z-index: 100005; white-space: normal; text-align: left; }
                    .iz-param-item .iz-input-group { height: 36px; }
                    .iz-param-item .iz-input-group input[type="number"] { font-size: 13px; padding: 0 10px; }
                    .iz-param-item .iz-input-group .iz-unit { font-size: 12px; padding: 0 10px 0 2px; }
                    .iz-panel-footer { padding: 14px 28px 20px 28px; border-top: 1px solid rgba(226, 232, 240, 0.5); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; background: rgba(255, 255, 255, 0.4); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
                    .iz-btn-ghost { background: none; border: none; padding: 8px 14px; font-size: 13px; font-weight: 500; color: #64748B; cursor: pointer; border-radius: 10px; transition: all 0.2s; }
                    .iz-btn-ghost:hover { background: rgba(239, 68, 68, 0.08); color: #EF4444; }
                    .iz-btn-ghost:active { transform: scale(0.96); }
                    .iz-btn-primary-solid { padding: 10px 28px; background: linear-gradient(135deg, #4F46E5, #7C3AED); border: none; border-radius: 14px; font-size: 14px; font-weight: 600; color: white; cursor: pointer; transition: all 0.25s; box-shadow: 0 4px 16px rgba(79, 70, 229, 0.3); }
                    .iz-btn-primary-solid:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(79, 70, 229, 0.4); }
                    .iz-btn-primary-solid:active { transform: scale(0.96); }
                    @media (max-width: 600px) {
                        #izConfigPanel { border-radius: 20px; max-height: 95vh; }
                        .iz-panel-scroll { padding: 0 18px 8px 18px; }
                        .iz-panel-header { padding: 16px 18px 0 18px; }
                        .iz-panel-footer { padding: 12px 18px 16px 18px; flex-wrap: wrap; gap: 10px; }
                        .iz-row { flex-direction: column; align-items: stretch; gap: 6px; }
                        .iz-param-grid { grid-template-columns: 1fr; }
                        .iz-panel-title { font-size: 17px; }
                        .iz-panel-icon { width: 34px; height: 34px; font-size: 17px; }
                    }
                `;
                document.head.appendChild(dockStyle);
                dockStyleElement = dockStyle;
            }

            // 图片放大相关样式：随 cleanup 一起移除
            if (styleElement) return;
            const style = document.createElement('style');
            style.textContent = `
                .image-zoom-wrapper * { box-sizing: border-box; }
                .image-zoom-container img { object-fit: contain; }
                .image-zoom-hover { cursor: zoom-in !important; }
                a.image-zoom-hover, .cover-container.image-zoom-hover, .card.image-zoom-hover { cursor: zoom-in !important; }
                a.stretched-link.image-zoom-hover { cursor: zoom-in !important; }
            `;
            document.head.appendChild(style);
            styleElement = style;
        }

        function createDockButton() {
            dockZone = document.createElement('div');
            dockZone.id = 'zoomDockZone';

            toggleButton = document.createElement('div');
            toggleButton.id = 'zoomDock';
            toggleButton.innerHTML = `
                <svg class="icon-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="16" y1="16" x2="21" y2="21" />
                </svg>
                <span id="statusDot"></span>
            `;
            toggleButton.title = '点击：切换图片放大';

            gearButton = document.createElement('div');
            gearButton.id = 'zoomSettings';
            gearButton.innerHTML = `
                <svg class="icon-svg--gear" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
            `;
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

            const savedTop = GM_getValue(`image_zoom_dock_top_${currentDomain}`);
            if (savedTop !== undefined && savedTop !== null) {
                dockZone.style.transform = 'none';
                dockZone.style.top = savedTop + 'px';
            }

            let leaveTimer = null;

            function positionTips() {
                if (!dockTip || !settingsTip) return;
                const dockRect = toggleButton.getBoundingClientRect();
                const gearRect = gearButton.getBoundingClientRect();
                dockTip.style.top = (dockRect.top + dockRect.height / 2) + 'px';
                dockTip.style.right = (window.innerWidth - dockRect.left + 8) + 'px';
                dockTip.style.transform = 'translateY(-50%)';
                dockTip.classList.add('visible');
                settingsTip.style.top = (gearRect.top + gearRect.height / 2) + 'px';
                settingsTip.style.right = (window.innerWidth - gearRect.left + 8) + 'px';
                settingsTip.style.transform = 'translateY(-50%)';
                settingsTip.classList.add('visible');
            }

            function hideTips() {
                dockTip.classList.remove('visible');
                settingsTip.classList.remove('visible');
            }

            function updateDockTipText() {
                if (isHomepageZoomDisabled()) {
                    dockTip.innerHTML = '主页已禁用图片放大 <span style="opacity:0.5;margin-left:4px;">设置中可开启</span>';
                } else if (!isEnabled) {
                    dockTip.innerHTML = '图片放大已关闭 <span style="opacity:0.4;margin-left:4px;">点击开启</span>';
                } else {
                    dockTip.innerHTML = '图片放大已开启 <span style="opacity:0.4;margin-left:4px;">点击关闭</span>';
                }
            }

            toggleButton.addEventListener('mouseenter', () => {
                clearTimeout(leaveTimer);
                dockZone.classList.add('open');
                updateDockTipText();
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
                updateDockTipText();
                if (dockZone.classList.contains('open')) positionTips();
            });

            gearButton.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleConfigPanel();
            });

            // 拖拽：区分点击与拖动（THRESHOLD），dragJustEnded 用于吞掉拖拽结束后紧随的 click
            (function() {
                let isDragging = false;
                let hasMoved = false;
                let startY = 0;
                let startTop = 0;
                let dragJustEnded = false;
                const THRESHOLD = 3;

                function getCurTop(el) {
                    return el.getBoundingClientRect().top;
                }

                function clamp(val, min, max) {
                    return Math.max(min, Math.min(max, val));
                }

                function syncY(topPx) {
                    const h = toggleButton.offsetHeight;
                    const safeTop = clamp(topPx, 0, window.innerHeight - h);
                    dockZone.style.top = safeTop + 'px';
                    if (dockZone.classList.contains('open')) positionTips();
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
                    startTop = getCurTop(dockZone);
                    e.preventDefault();
                });

                document.addEventListener('mousemove', function(e) {
                    // v4.2.1：全局记录鼠标坐标（供站点悬停代理轮询使用）
                    window.__lastMouseX = e.clientX;
                    window.__lastMouseY = e.clientY;

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
                        GM_setValue(`image_zoom_dock_top_${currentDomain}`, parseFloat(dockZone.style.top) || 0);
                        dragJustEnded = true;
                        requestAnimationFrame(() => {
                            setTimeout(() => { dragJustEnded = false; }, 50);
                        });
                    }
                });

                let touchStartY = 0, touchStartTop = 0, isTouching = false;

                toggleButton.addEventListener('touchstart', function(e) {
                    const touch = e.touches[0];
                    if (!touch) return;
                    isTouching = true;
                    hasMoved = false;
                    touchStartY = touch.clientY;
                    touchStartTop = getCurTop(dockZone);
                }, { passive: true });

                document.addEventListener('touchmove', function(e) {
                    if (!isTouching) return;
                    const touch = e.touches[0];
                    if (!touch) return;
                    const delta = touch.clientY - touchStartY;
                    if (!hasMoved && Math.abs(delta) > THRESHOLD) {
                        hasMoved = true;
                        document.body.classList.add('zoom-dock-dragging');
                    }
                    if (hasMoved) {
                        syncY(touchStartTop + delta);
                        e.preventDefault();
                    }
                }, { passive: false });

                document.addEventListener('touchend', function() {
                    if (!isTouching) return;
                    isTouching = false;
                    document.body.classList.remove('zoom-dock-dragging');
                    if (hasMoved) {
                        dockZone.style.transform = 'none';
                        GM_setValue(`image_zoom_dock_top_${currentDomain}`, parseFloat(dockZone.style.top) || 0);
                        dragJustEnded = true;
                        setTimeout(() => { dragJustEnded = false; }, 50);
                    }
                }, { passive: true });

                window.addEventListener('resize', function() {
                    const curTop = getCurTop(dockZone);
                    if (curTop + dockZone.offsetHeight > window.innerHeight) {
                        syncY(Math.min(curTop, window.innerHeight - dockZone.offsetHeight));
                    }
                    if (dockZone.classList.contains('open')) positionTips();
                });
            })();

            updateButtonState();
        }

        function updateButtonState() {
            if (!toggleButton) return;
            if (isHomepageZoomDisabled()) {
                toggleButton.classList.remove('off');
                toggleButton.classList.add('hp');
            } else if (!isEnabled) {
                toggleButton.classList.remove('hp');
                toggleButton.classList.add('off');
            } else {
                toggleButton.classList.remove('off');
                toggleButton.classList.remove('hp');
            }
        }

        function toggleEnabled() {
            isEnabled = !isEnabled;
            GM_setValue(`image_zoom_enabled_${currentDomain}`, isEnabled);
            updateButtonState();
            if (isEnabled) {
                injectStyles();
                initImages();
            } else {
                cleanup();
            }
        }

        function cleanup() {
            if (zoomObserver) { zoomObserver.disconnect(); zoomObserver = null; }
            if (lightboxObserver) { lightboxObserver.disconnect(); lightboxObserver = null; }
            if (currentZoomContainer) { currentZoomContainer.remove(); currentZoomContainer = null; }
            document.querySelectorAll('.image-zoom-container').forEach(el => el.remove());
            document.querySelectorAll('.image-zoom-wrapper').forEach(wrapper => {
                const parent = wrapper.parentNode;
                while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
                parent.removeChild(wrapper);
            });
            document.querySelectorAll('img.image-zoom-processed').forEach(img => {
                const state = states.get(img);
                if (state) {
                    if (state.timer) clearTimeout(state.timer);
                    if (state.handlers) {
                        img.removeEventListener('mouseenter', state.handlers.mouseenter);
                        img.removeEventListener('mouseleave', state.handlers.mouseleave);
                        img.removeEventListener('click', state.handlers.click, true);
                        if (state.handlers.parent && state.handlers.parentMouseenter) {
                            state.handlers.parent.removeEventListener('mouseenter', state.handlers.parentMouseenter);
                            state.handlers.parent.removeEventListener('mouseleave', state.handlers.parentMouseleave);
                        }
                    }
                    if (state.containers) {
                        state.containers.forEach(ctn => {
                            ctn.classList.remove('image-zoom-hover');
                            ctn.removeAttribute('data-zoom-proxy');
                            ctn.removeAttribute('data-stretch-fixed');
                        });
                    }
                }
                img.classList.remove('image-zoom-processed');
                img.classList.remove('image-zoom-hover');
                states.delete(img);
            });
            if (styleElement && styleElement.parentNode) {
                styleElement.parentNode.removeChild(styleElement);
                styleElement = null;
            }
        }

        function checkImageClickBehavior(img) {
            for (const selector of COMMON_SELECTORS) {
                if (img.matches(selector)) return true;
            }
            let parent = img.parentElement;
            while (parent && parent !== document.body) {
                const parentClass = parent.className || '';
                const parentId = parent.id || '';
                if (parentClass.includes('zoom') || parentClass.includes('lightbox') ||
                    parentClass.includes('gallery') || parentClass.includes('fancybox') ||
                    parentClass.includes('stretched-link') || parentId.includes('zoom') ||
                    parentId.includes('lightbox') || parentId.includes('gallery') ||
                    parentId.includes('fancybox')) {
                    return true;
                }
                parent = parent.parentElement;
            }
            return false;
        }

        function isImageInLightboxMode() {
            const commonLightboxSelectors = ['.lightbox-open', '.fancybox-open', '.modal-open', '.zoom-overlay-open'];
            for (const selector of commonLightboxSelectors) {
                if (document.body.classList.contains(selector.replace('.', '')) ||
                    document.documentElement.classList.contains(selector.replace('.', ''))) {
                    return true;
                }
            }
            return false;
        }

        function isValidImage(img) {
            if (!img || !img.parentNode) return false;
            if (img.tagName !== 'IMG') return false;
            if (img.getClientRects().length === 0) {
                if (DEBUG_IMAGE_CHECK) console.log('[图片放大] 跳过(不可见):', img.src);
                return false;
            }
            const style = window.getComputedStyle(img);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
                if (DEBUG_IMAGE_CHECK) console.log('[图片放大] 暂时跳过(隐藏/淡出中):', img.src);
                return false;
            }
            const src = img.src || img.currentSrc;
            if (!src || src.trim() === '' || src.startsWith('data:') || src.includes('placeholder')) {
                if (DEBUG_IMAGE_CHECK) console.log('[图片放大] 跳过(无效src):', src);
                return false;
            }
            if (style.backgroundImage && style.backgroundImage !== 'none') return false;
            if (!img.complete || img.naturalWidth === 0) {
                if (!img.dataset.zoomLoadBound) {
                    img.dataset.zoomLoadBound = 'true';
                    img.addEventListener('load', () => processImage(img), { once: true });
                }
                return false;
            }
            const rect = img.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return false;
            return true;
        }

        // ================================
        // 📮 问题反馈模块
        // ================================
        const FEEDBACK_API = 'https://damp-woodpecker-4867.ydgg123.deno.net';

        function submitFeedback(text) {
            const payload = JSON.stringify({
                text: text,
                page: location.hostname + location.pathname + ' | 脚本 v4.2.1'
            });
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: FEEDBACK_API,
                    headers: { 'Content-Type': 'application/json' },
                    data: payload,
                    timeout: 15000,
                    onload: (r) => {
                        if (r.status >= 200 && r.status < 400) {
                            resolve();
                        } else {
                            reject(new Error('提交失败（' + r.status + '）'));
                        }
                    },
                    onerror: () => reject(new Error('网络错误，请稍后重试')),
                    ontimeout: () => reject(new Error('提交超时，请检查网络'))
                });
            });
        }

        function injectFeedbackSection(overlay) {
            const scroll = overlay.querySelector('.iz-panel-scroll');
            if (!scroll || scroll.querySelector('#izFeedbackSection')) return;

            const section = document.createElement('div');
            section.className = 'iz-section';
            section.id = 'izFeedbackSection';
            section.innerHTML = `
                <div class="iz-section-title">📮 问题反馈</div>
                <textarea id="izFeedbackText" placeholder="遇到问题或有建议？写在这里直接反馈～&#10;" style="width: 100%; box-sizing: border-box; resize: vertical; min-height: 72px; background: white; color: #1E293B; border: 1.5px solid #E2E8F0; border-radius: 12px; padding: 10px 12px; font-size: 13px; font-family: inherit; line-height: 1.6; outline: none; transition: border-color 0.2s, box-shadow 0.2s;"></textarea>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 10px;">
                    <span id="izFeedbackStatus" style="font-size: 12px; color: #64748B;"></span>
                    <button id="izFeedbackBtn" style="padding: 8px 20px; background: linear-gradient(135deg, #4F46E5, #7C3AED); color: white; border: none; border-radius: 12px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.25s; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);">📮 提交反馈</button>
                </div>
            `;
            scroll.appendChild(section);

            const textarea = section.querySelector('#izFeedbackText');
            const status = section.querySelector('#izFeedbackStatus');
            const btn = section.querySelector('#izFeedbackBtn');

            textarea.addEventListener('focus', () => {
                textarea.style.borderColor = '#4F46E5';
                textarea.style.boxShadow = '0 0 0 3px rgba(79, 70, 229, 0.15)';
            });
            textarea.addEventListener('blur', () => {
                textarea.style.borderColor = '#E2E8F0';
                textarea.style.boxShadow = 'none';
            });
            btn.addEventListener('mouseenter', () => {
                btn.style.transform = 'translateY(-2px)';
                btn.style.boxShadow = '0 8px 24px rgba(79, 70, 229, 0.4)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.transform = '';
                btn.style.boxShadow = '0 4px 12px rgba(79, 70, 229, 0.3)';
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
                submitFeedback(text).then(() => {
                    status.textContent = '✅ 反馈已提交，感谢你的支持！';
                    status.style.color = '#10B981';
                    textarea.value = '';
                }).catch((err) => {
                    status.textContent = '❌ ' + (err.message || '提交失败');
                    status.style.color = '#EF4444';
                }).finally(() => {
                    btn.disabled = false;
                    btn.textContent = '📮 提交反馈';
                    btn.style.opacity = '';
                    setTimeout(() => { status.textContent = ''; }, 4000);
                });
            });
        }

        const COMMON_PARAM_DEFS = [
            { key: 'delay', label: '悬停延迟', unit: 'ms', min: 0, max: 2000, step: 100, tip: '鼠标停在图片上多久后才放大。数值越小响应越快，越大越不容易误触发。建议 300~800ms' },
            { key: 'minOriginalSize', label: '最小放大尺寸', unit: 'px', min: 0, max: 500, step: 5, tip: '原图宽或高小于此值时不放大，用来过滤网站里的小图标、表情、按钮图标等。设为 0 表示全部放大' },
            { key: 'maxWidth', label: '大图最大宽度', unit: 'px', min: 300, max: 3000, step: 100, tip: '放大后的大图宽度上限。自适应模式下它决定了放大画布的宽度上限，调小后大图整体变小；固定模式下大图最多放大到这个宽度' },
            { key: 'maxHeight', label: '大图最大高度', unit: 'px', min: 300, max: 3000, step: 100, tip: '放大后的大图高度上限。自适应模式下它决定了放大画布的高度上限，调小后大图整体变小；固定模式下大图最多放大到这个高度' },
            { key: 'scrollSpeed', label: '滚轮移动速度', unit: 'px', min: 5, max: 50, step: 1, tip: '大图超出屏幕时，滚动鼠标滚轮查看图片其余部分，每次滚动的距离。数值越大滚得越快' }
        ];

        const FIXED_PARAM_DEFS = [
            { key: 'scale', label: '大图放大倍数', unit: '×', min: 1, max: 5, step: 0.1, tip: '固定倍数模式下，大图相对原图的放大倍数' },
            { key: 'minScale', label: '大图最小倍数', unit: '×', min: 1, max: 3, step: 0.1, tip: '固定倍数模式下，大图至少要放大到的倍数下限，避免小图放大后依然看不清' },
            { key: 'portraitRatio', label: '竖屏判定比例', unit: '×', min: 1, max: 3, step: 0.1, tip: '图片高÷宽超过这个值就判定为竖长图（如手机截图、漫画长图），固定模式下会按高度优先铺满放大' },
            { key: 'smallImgThreshold', label: '小图判定阈值', unit: 'px', min: 100, max: 500, step: 10, tip: '固定模式下，原图宽或高小于此值会被当作「小图」，改用下方两个小图专用尺寸放大，而不是套用大图规则' },
            { key: 'smallImgWidth', label: '小图强制宽度', unit: 'px', min: 300, max: 1000, step: 10, tip: '固定模式下，判定为小图的图片放大后的宽度基准（高度按原图比例自动计算）' },
            { key: 'smallImgHeight', label: '小图强制高度', unit: 'px', min: 300, max: 1000, step: 10, tip: '固定模式下，判定为小图的图片放大后的高度基准（宽度按原图比例自动计算）' }
        ];

        function createConfigPanel() {
            const overlay = document.createElement('div');
            overlay.id = 'izModalOverlay';

            const renderParams = (defs) => defs.map(p => `
                <div class="iz-param-item">
                    <label>${p.label}<span class="iz-tip-icon" data-tip="${p.tip}">?</span></label>
                    <div class="iz-input-group" data-param="${p.key}">
                        <input type="number" class="iz-param-input" data-param="${p.key}" value="${config[p.key]}" min="${p.min}" max="${p.max}" step="${p.step}" />
                        <span class="iz-unit">${p.unit}</span>
                    </div>
                </div>
            `).join('');

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
                                    <div class="iz-status-text">
                                        <span class="iz-dot on" id="izHpDot"></span>
                                        <span id="izHpText">当前主页已启用图片放大</span>
                                    </div>
                                    <button class="iz-btn-sm warning" id="izHpToggleBtn">禁用主页图片放大功能</button>
                                </div>
                                <div class="iz-exclusion-note">仅对当前网站（${currentDomain}）的主页生效，内容字页面不受影响，依然会放大图片</div>
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
                            <div class="iz-row" style="margin-bottom: 0;">
                                <div class="iz-row-label" style="min-width:0; flex:1;">
                                    <div class="iz-checkbox-wrap" id="izConflictWrap">
                                        <div class="iz-checkbox-custom ${config.avoidClickConflict ? 'checked' : ''}" id="izConflictCheck"></div>
                                        <span class="iz-checkbox-label">避免与点击放大功能冲突<span class="iz-sub">自动检测网站点击放大，避免冲突</span></span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="iz-section">
                            <div class="iz-collapse-header" id="izCommonHeader">
                                <div class="iz-left">
                                    <span class="iz-arrow" id="izCommonArrow">▶</span>
                                    <span>通用参数</span>
                                    <span class="iz-badge-params">自适应 / 固定 都生效</span>
                                </div>
                                <span style="font-size:12px; color:#94A3B8;" id="izCommonHint">点击展开 · 悬停问号查看参数说明</span>
                            </div>
                            <div class="iz-collapse-body" id="izCommonBody">
                                <div class="iz-param-grid">${renderParams(COMMON_PARAM_DEFS)}</div>
                            </div>
                        </div>
                        <div class="iz-section">
                            <div class="iz-collapse-header" id="izFixedHeader">
                                <div class="iz-left">
                                    <span class="iz-arrow" id="izFixedArrow">▶</span>
                                    <span>固定倍数专用参数</span>
                                    <span class="iz-badge-params" id="izModeBadge">智能自适应模式</span>
                                </div>
                                <span style="font-size:12px; color:#94A3B8;" id="izFixedHint">自适应模式下不可用</span>
                            </div>
                            <div class="iz-collapse-body" id="izFixedBody">
                                <div class="iz-param-grid">${renderParams(FIXED_PARAM_DEFS)}</div>
                            </div>
                        </div>
                        <div class="iz-section">
                            <div class="iz-section-title">🎬 B站播放器辅助</div>
                            <div class="iz-row" style="margin-bottom:0;">
                                <div class="iz-row-label" style="min-width:0; flex:1;">
                                    <div class="iz-toggle-wrap" id="izBiliWrap">
                                        <div class="iz-toggle ${bilibiliVolumeModule.isEnabled ? 'active' : ''}" id="izBiliToggle">
                                            <div class="iz-knob"></div>
                                        </div>
                                        <span class="iz-toggle-label">启用B站播放器辅助<span class="iz-sub">全屏时滚轮调节音量 · 方向键防穿透</span></span>
                                    </div>
                                </div>
                            </div>
                            <div style="margin-top:10px; padding-left:2px; font-size:12px; line-height:1.7; color:#94A3B8;">
                                <div>· 放大模块会导致B站原生滚轮调整音量失效</div>
                                <div>· 需开启此辅助解决滚轮调整音量的问题</div>
                            </div>
                        </div>
                    </div>
                    <div class="iz-panel-footer">
                        <button class="iz-btn-ghost" id="izResetBtn">↺ 恢复默认设置</button>
                        <button class="iz-btn-primary-solid" id="izSaveBtn">✓ 保存并关闭</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            injectFeedbackSection(overlay);

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

            // ===== 参数说明气泡：全局唯一，挂在 body 上，fixed 定位不受折叠区裁剪 =====
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
                const bw = tipBubble.offsetWidth;
                const bh = tipBubble.offsetHeight;
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
                    if (isEnabled) {
                        cleanup();
                        initImages();
                    }
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
            $('izSaveBtn').addEventListener('click', () => {
                showSaveToast('设置已保存');
                setTimeout(closePanel, 350);
            });
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closePanel();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && overlay.style.display !== 'none' && overlay.style.display !== '') {
                    closePanel();
                }
            });

            updateDetailState();
            return overlay;
        }

        function toggleConfigPanel() {
            let overlay = document.getElementById('izModalOverlay');
            if (!overlay) {
                overlay = createConfigPanel();
            }
            if (overlay.style.display === 'flex') {
                overlay.style.display = 'none';
            } else {
                overlay.querySelector('#izModeSelect').value = config.zoomMode;
                overlay.querySelector('#izConflictCheck').classList.toggle('checked', config.avoidClickConflict);
                overlay.querySelectorAll('.iz-param-input').forEach(input => {
                    input.value = config[input.dataset.param];
                });
                overlay.querySelector('#izBiliToggle').classList.toggle('active', bilibiliVolumeModule.isEnabled);
                refreshPanelHomepageSection();
                overlay.classList.add('anim-in');
                overlay.style.display = 'flex';
                setTimeout(() => overlay.classList.remove('anim-in'), 400);
            }
        }

        function onWheel(e) {
            if (currentZoomContainer && isEnabled) {
                e.preventDefault();
                e.stopPropagation();
                debounceMove(e);
                return true;
            }
            return false;
        }

        const debounceMove = debounce(function(e) {
            if (!currentZoomContainer || !isEnabled) return;
            const zoomedImg = currentZoomContainer.querySelector('img');
            if (!zoomedImg) return;
            const moveDistance = e.deltaY > 0 ? -config.scrollSpeed : config.scrollSpeed;
            const currentMarginTop = parseFloat(zoomedImg.style.marginTop) || 0;
            zoomedImg.style.marginTop = (currentMarginTop + moveDistance) + 'px';
        }, 16);

        function handleResize() {
            if (currentZoomContainer && isEnabled) {
                currentZoomContainer.style.opacity = '0';
            }
        }

        function addKeyboardSupport() {
            document.addEventListener('keydown', (e) => {
                if (e.altKey && e.key === 'z') {
                    e.preventDefault();
                    if (!isHomepageZoomDisabled()) {
                        toggleEnabled();
                    }
                }
            });
        }

        // 智能自适应：按小图面积放大到视口可用尺寸，超出可用宽高时等比收缩
        function computeAdaptiveSize(img, rect) {
            const availW = Math.min(window.innerWidth - 60, config.maxWidth);
            const availH = Math.min(window.innerHeight - 60, config.maxHeight);
            const size = Math.sqrt(rect.width * rect.height);
            const availSize = Math.sqrt(availW * availH);
            const TARGET_MIN = Math.min(1200, availSize);
            let target = Math.min(Math.max(size * 5, TARGET_MIN), availSize);
            let scale = target / size;
            scale = Math.min(scale, 10);
            scale = Math.max(scale, 1);
            let w = Math.round(rect.width * scale);
            let h = Math.round(rect.height * scale);
            if (w > availW || h > availH) {
                const fit = Math.min(availW / w, availH / h);
                w = Math.round(w * fit);
                h = Math.round(h * fit);
            }
            return { w, h };
        }

        function createZoomedImage(img, hasClickFunctionality = false) {
            if (!isEnabled) return null;
            try {
                if (currentZoomContainer) {
                    try { currentZoomContainer.remove(); } catch (e) { }
                    currentZoomContainer = null;
                }
                const rect = img.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return null;

                const isSmallImg = rect.width < config.smallImgThreshold || rect.height < config.smallImgThreshold;
                const isPortrait = rect.height / rect.width > config.portraitRatio;

                let targetWidth, targetHeight;
                if (config.zoomMode === 'adaptive') {
                    const size = computeAdaptiveSize(img, rect);
                    targetWidth = size.w;
                    targetHeight = size.h;
                } else if (isSmallImg) {
                    targetWidth = config.smallImgWidth;
                    targetHeight = config.smallImgHeight;
                    const imgRatio = rect.width / rect.height;
                    if (isPortrait) {
                        targetWidth = Math.round(targetHeight * imgRatio);
                    } else {
                        targetHeight = Math.round(targetWidth / imgRatio);
                    }
                    targetWidth = Math.min(targetWidth, config.maxWidth);
                    targetHeight = Math.min(targetHeight, config.maxHeight);
                } else {
                    if (isPortrait) {
                        const heightScale = config.maxHeight / rect.height;
                        targetWidth = Math.round(rect.width * heightScale);
                        targetHeight = Math.round(rect.height * heightScale);
                    } else {
                        const widthScale = config.maxWidth / rect.width;
                        targetWidth = Math.round(rect.width * widthScale);
                        targetHeight = Math.round(rect.height * widthScale);
                    }
                    targetWidth = Math.min(targetWidth, config.maxWidth);
                    targetHeight = Math.min(targetHeight, config.maxHeight);
                }

                const zoomedImgStyle = `width: ${targetWidth}px; height:${targetHeight}px; max-width: ${config.maxWidth}px; max-height:${config.maxHeight}px; object-fit: contain; transition: ${config.transition}, transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); box-shadow: 0 4px 20px rgba(0,0,0,0.2); margin-top: 0; transform: scale(0.6); opacity: 0;`;

                const zoomContainer = document.createElement('div');
                zoomContainer.className = 'image-zoom-container';
                const zoomZIndex = hasClickFunctionality ? config.zoomZIndex - 1 : config.zoomZIndex;
                zoomContainer.style.cssText = `
                    position: fixed; z-index: ${zoomZIndex}; opacity: 0;
                    transition: ${config.transition}; pointer-events: none;
                    left: 0; top: 0; width: 100%; height: 100%;
                    display: flex; justify-content: center; align-items: center;
                    padding: 20px; box-sizing: border-box;
                    background-color: rgba(0,0,0,0.1);
                `;

                const zoomedImg = document.createElement('img');
                const fallbackSrc = img.src || img.currentSrc;
                const hiResSrc = upgradeImgUrl((img.src || img.currentSrc || '')
                    .replace(/\/s\d+x\d+_/g, '/')
                    .replace(/\.avif$/i, '')) || fallbackSrc;
                zoomedImg.crossOrigin = 'anonymous'; 
                zoomedImg.src = hiResSrc;
                let noCorsTried = false;
                zoomedImg.onerror = () => {
                    if (zoomedImg.crossOrigin && !noCorsTried) {
                        noCorsTried = true;
                        zoomedImg.removeAttribute('crossOrigin');
                        zoomedImg.src = hiResSrc;
                        return;
                    }
                    // 原图彻底失败 → 回退缩略图
                    if (zoomedImg.src !== fallbackSrc) zoomedImg.src = fallbackSrc;
                };
                zoomedImg.onload = () => cropBlackBars(zoomedImg);
                zoomedImg.alt = img.alt;
                zoomedImg.style.cssText = zoomedImgStyle;
                zoomContainer.appendChild(zoomedImg);
                document.body.appendChild(zoomContainer);
                currentZoomContainer = zoomContainer;


                setTimeout(() => {
                    zoomContainer.style.opacity = '1';
                    zoomedImg.style.transform = 'scale(1)';
                    zoomedImg.style.opacity = '1';
                }, 10);

                return zoomContainer;
            } catch (error) {
                console.warn('创建放大图失败:', error);
                return null;
            }
        }

        function showZoom(img) {
            if (!isEnabled) return;
            if (config.avoidClickConflict && isImageInLightboxMode()) {
                return;
            }
            const state = states.get(img);
            if (!state || state.isZoomed) return;
            const zoomContainer = createZoomedImage(img, state.hasClickFunctionality);
            if (!zoomContainer) return;
            states.set(img, { ...state, isZoomed: true, zoomContainer });
        }

        function hideZoom(img) {
            const state = states.get(img);
            if (!state || !state.isZoomed || !state.zoomContainer) return;
            state.zoomContainer.style.opacity = '0';
            const hideImg = state.zoomContainer.querySelector('img');
            if (hideImg) {
                hideImg.style.transform = 'scale(0.6)';
                hideImg.style.opacity = '0';
            }
            setTimeout(() => {
                if (state.zoomContainer && state.zoomContainer.parentNode) {
                    state.zoomContainer.parentNode.removeChild(state.zoomContainer);
                }
                if (currentZoomContainer === state.zoomContainer) currentZoomContainer = null;
                states.set(img, { ...state, isZoomed: false, zoomContainer: null, timer: null });
            }, 300);
        }

        function handleStretchedLink(img) {
            const card = img.closest('.card');
            if (!card) return;
            const link = card.querySelector('a.stretched-link');
            if (!link || link.dataset.stretchFixed) return;
            link.dataset.stretchFixed = '1';
            link.addEventListener('mouseenter', () => {
                if (img.classList.contains('image-zoom-processed')) {
                    img.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                }
            });
            link.addEventListener('mouseleave', () => {
                if (img.classList.contains('image-zoom-processed')) {
                    img.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
                }
            });
        }
        
        // ===== 自动裁剪放大图的黑边（只保留有内容的区域）=====
function cropBlackBars(imgEl) {
    try {
        const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
        if (!w || !h) return;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0);
        let data;
        try {
            data = ctx.getImageData(0, 0, w, h).data;
        } catch (e) { return; } // 图片跨域受保护，读不了像素 → 放弃裁剪，按原图显示
        const threshold = 24; // 亮度低于此值视为黑边
        let top = h, bottom = 0, left = w, right = 0, found = false;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                if (data[i + 3] > 10 && (data[i] > threshold || data[i + 1] > threshold || data[i + 2] > threshold)) {
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                    if (x < left) left = x;
                    if (x > right) right = x;
                    found = true;
                }
            }
        }
        if (!found) return; // 整张全黑，不裁
        const cw = right - left + 1, ch = bottom - top + 1;
        if (cw >= w * 0.9 && ch >= h * 0.9) return; // 几乎没有黑边，不裁
        if (cw < 20 || ch < 20) return;             // 裁出来太小，疑似误判，不裁
        // 把有内容的区域画到新画布，替换显示
        const out = document.createElement('canvas');
        out.width = cw; out.height = ch;
        out.getContext('2d').drawImage(imgEl, left, top, cw, ch, 0, 0, cw, ch);
        imgEl.src = out.toDataURL('image/png');
    } catch (e) { }
}

// ===== 图片 URL 升级：缩略图 → 原图 =====
function upgradeImgUrl(url) {
    if (!url) return url;
    // Discuz 论坛远程缩略图：/remote/thumb/宽x高/原路径 → 原图
    url = url.replace(/\/remote\/thumb\/\d+x\d+\//, '/');
    return url;
}

// ===== 背景图 URL 提取与清洗=====
function extractBgUrl(el) {
    if (!el || el.nodeType !== 1) return null;
    let url = null;
    let m = null;
    // 先看内联 style
    const inline = el.getAttribute('style') || '';
    m = inline.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    if (m) url = m[1];
    // 再看计算样式（有些站点背景图是 class 控制的）
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
            u = u.replace(/(_!![\w\-.,]+?\.(?:jpg|jpeg|png|webp))_[\w.\-]+$/i, '$1') // xxx_!!123.jpg_400x400q90.jpg → xxx_!!123.jpg
                 .replace(/\.(jpg|jpeg|png|webp)_[\w.]+$/i, '.$1')                   // xxx.jpg_.webp → xxx.jpg
                 .replace(/_\.(webp|jpg|jpeg|png)$/i, '');                           // xxx_.webp → xxx
        } while (u !== prev);
        return u;
    }
    // 其他站点：保留原有通用清洗规则
    let prev;
    do {
        prev = u;
        u = u.replace(/![\w\-]+\.(jpg|jpeg|png|webp)$/i, function (s) {
            return s;
        }).replace(/![\w\-]+$/i, '')
          .replace(/_\d+x\d+(q\d+)?\.(jpg|jpeg|png|webp)(\.\w+)?$/i, '')
          .replace(/\.(jpg|jpeg|png|webp)_[\w.]+$/i, '.$1')
          .replace(/_\.(webp|jpg|jpeg|png)$/i, '')
          .replace(/\.webp$/i, '.jpg');
    } while (u !== prev);
    return u;
}

// ===== 站点悬停代理=====
function setupHoverProxy() {
    const rule = SITE_HOVER_PROXY_RULES.find(r =>
        r.domains.some(d => currentDomain === d || currentDomain.endsWith('.' + d))
    );
    if (!rule) return;

    const itemSelector = rule.itemSelector;
    const cardSelector = rule.cardSelector;

    // —— 背景图模式专用：创建/移除放大层 ——
    let bgZoomContainer = null;
    let bgZoomUrl = null; // 记录当前显示的图，避免每个轮询周期都重建

    const removeBgZoom = () => {
        bgZoomUrl = null;
        if (!bgZoomContainer) return;
        const c = bgZoomContainer;
        bgZoomContainer = null;
        // 退出动画：图片缩小 + 整体渐隐，和进入动画对称
        const img = c.querySelector('img');
        if (img) img.style.transform = 'scale(0.6)';
        c.style.opacity = '0';
        setTimeout(() => c.remove(), 300);
    };


    const showBgZoom = (wrapperEl) => {
        const rawUrl = extractBgUrl(wrapperEl);
        if (!rawUrl) return;
        // 同一张图已经在显示中 → 直接返回，不重建（防闪烁）
        if (bgZoomContainer && bgZoomUrl === rawUrl) return;
        removeBgZoom();
        
        // 清掉可能还在退出动画中的旧容器，避免重叠
        document.querySelectorAll('.image-zoom-container').forEach(el => el.remove());

        // 提取"未经清洗"的原始 URL，作为加载失败的兜底
        let originalUrl = null;
        const inline = wrapperEl.getAttribute('style') || '';
        const m = inline.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
        if (m) originalUrl = m[1].trim().replace(/^['"]|['"]$/g, '');
        if (!originalUrl) {
            try {
                const bg = getComputedStyle(wrapperEl).backgroundImage;
                if (bg && bg !== 'none') {
                    const m2 = bg.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
                    if (m2) originalUrl = m2[1].trim().replace(/^['"]|['"]$/g, '');
                }
            } catch (e) { }
        }

        // 调试：按 F12 打开控制台查看实际请求的地址
        console.log('[图片放大] 清洗后URL:', rawUrl, '| 原始URL:', originalUrl);

        const container = document.createElement('div');
        container.className = 'image-zoom-container';
        container.style.cssText = `
            position: fixed; inset: 0;
            z-index: ${config.zoomZIndex - 1};
            opacity: 0; transition: all 0.3s ease;
            pointer-events: none;
            display: flex; justify-content: center; align-items: center;
            padding: 20px; box-sizing: border-box;
            background-color: rgba(0,0,0,0.1);
        `;
        const bigImg = document.createElement('img');
        bigImg.style.cssText = `
            max-width: ${Math.min(window.innerWidth - 60, config.maxWidth)}px;
            max-height: ${Math.min(window.innerHeight - 60, config.maxHeight)}px;
            object-fit: contain; border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
            transform: scale(0.6);
            transition: transform 0.35s cubic-bezier(0.34,1.56,0.64,1);
        `;

        // 三重保险：清洗URL → 失败回退原始URL → 再失败销毁放大层
        let triedFallback = false;
        bigImg.onerror = () => {
            if (!triedFallback && originalUrl && originalUrl !== bigImg.src) {
                triedFallback = true;
                console.warn('[图片放大] 清洗URL加载失败，回退原始URL:', originalUrl);
                bigImg.src = originalUrl;
                return;
            }
            console.error('[图片放大] 图片加载彻底失败:', bigImg.src);
            bgZoomUrl = null;
            removeBgZoom();
        };
        bigImg.onload = () => {
            requestAnimationFrame(() => {
                container.style.opacity = '1';
                bigImg.style.transform = 'scale(1)';
            });
        };

        bigImg.src = rawUrl;
        container.appendChild(bigImg);
        document.body.appendChild(container);
        bgZoomContainer = container;
        bgZoomUrl = rawUrl;
    };


    setInterval(() => {
        if (!isEnabled || isHomepageZoomDisabled()) return;
        const x = (window.__lastMouseX ?? -1);
        const y = (window.__lastMouseY ?? -1);
        if (x < 0) return;
        const el = document.elementFromPoint(x, y);
        if (!el) { if (rule.imgMode === 'background') removeBgZoom(); return; }

        // ===== 背景图模式=====
        if (rule.imgMode === 'background') {
            let wrapper = el.closest ? el.closest(itemSelector) : null;
            // 2) 兜底：命中了 .hover-border / .item-appear 等覆盖在图片上的遮罩层，
            //    closest 找不到容器 → 改用“坐标是否落在图片矩形内”判断
            if (!wrapper) {
                const card = el.closest ? el.closest(cardSelector) : null;
                if (card) {
                    const w = card.querySelector(itemSelector);
                    if (w) {
                        const r = w.getBoundingClientRect();
                        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                            wrapper = w;
                        }
                    }
                }
            }
            if (wrapper) {
                showBgZoom(wrapper);
            } else {
                // 鼠标在卡片内但不在图上（如文字区）时保留放大层，完全离开卡片才收起（防闪烁）
                const card = el.closest ? el.closest(cardSelector) : null;
                if (!card || !card.querySelector(itemSelector)) removeBgZoom();
            }
            return;
        }

        // ===== img 模式=====
        const img = (
            (el.tagName === 'IMG' ? el : null)
            || el.querySelector?.('img')
            || el.parentElement?.querySelector?.('img')
            || el.closest(itemSelector)?.querySelector('img')
            || el.closest(cardSelector)?.querySelector(`${itemSelector} img`)
        );
        const hoveredImg = (img && img.closest(itemSelector)) ? img : null;
        const prevImg = document.querySelector(`img[data-__zoom-hovering="1"]`);
        if (hoveredImg && hoveredImg !== prevImg) {
            if (prevImg) {
                prevImg.removeAttribute('data-__zoom-hovering');
                prevImg.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
            }
            if (!hoveredImg.classList.contains('image-zoom-processed')) {
                processImage(hoveredImg);
            }
            if (hoveredImg.classList.contains('image-zoom-processed')) {
                hoveredImg.dataset.__zoomHovering = '1';
                hoveredImg.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: x, clientY: y }));
            }
        } else if (!hoveredImg && prevImg) {
            prevImg.removeAttribute('data-__zoom-hovering');
            prevImg.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        }
    }, rule.pollInterval);
}


        function processImage(img) {
            if (!isEnabled) return;
            try {
                if (!img || !img.parentNode) return;
                if (!isValidImage(img)) return;

                let containers = [];
                let current = img.parentNode;
                while (current && current !== document.body) {
                    containers.push(current);
                    if (current.tagName === 'A' || current.classList.contains('card') ||
                        current.classList.contains('col') || current.classList.contains('card-img-container')) {
                        break;
                    }
                    current = current.parentNode;
                }
                const container = containers.length > 0 ? containers[containers.length - 1] : img.parentNode;

                const hasClickFunctionality = config.avoidClickConflict ?
                    (checkImageClickBehavior(img) || container.tagName === 'A' || container.classList.contains('stretched-link')) : false;

                if (img.classList.contains('image-zoom-processed')) return;
                img.classList.add('image-zoom-processed');

                if (!hasClickFunctionality) {
                    img.classList.add('image-zoom-hover');
                    if (img.parentNode && img.parentNode !== document.body) {
                        img.parentNode.classList.add('image-zoom-hover');
                    }
                }

                handleStretchedLink(img);

                const directParent = img.parentNode;

                const handleParentMouseEnter = (e) => {
                    const rect = img.getBoundingClientRect();
                    if (e.clientX >= rect.left && e.clientX <= rect.right &&
                        e.clientY >= rect.top && e.clientY <= rect.bottom) {
                        img.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
                    }
                };

                let isDispatchingLeave = false;
                const handleParentMouseLeave = (e) => {
                    if (isDispatchingLeave) return;
                    if (!directParent.contains(e.relatedTarget)) {
                        isDispatchingLeave = true;
                        try {
                            img.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true }));
                        } finally {
                            isDispatchingLeave = false;
                        }
                    }
                };

                if (directParent && directParent !== document.body) {
                    if (!directParent.dataset.zoomProxy) {
                        directParent.dataset.zoomProxy = "true";
                        directParent.addEventListener('mouseenter', handleParentMouseEnter);
                        directParent.addEventListener('mouseleave', handleParentMouseLeave);
                    }
                }

                let timer = null;
                let isZoomed = false;
                let zoomContainer = null;

                const handleMouseEnter = (e) => {
                    if (!isEnabled || isZoomed) return;
                    if (config.avoidClickConflict && isImageInLightboxMode()) {
                        return;
                    }
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => {
                        const rect = img.getBoundingClientRect();
                        if (rect.width < config.minOriginalSize || rect.height < config.minOriginalSize) return;
                        if (!isZoomed) {
                            zoomContainer = createZoomedImage(img, hasClickFunctionality);
                            if (zoomContainer) isZoomed = true;
                        }
                    }, config.delay);
                };

                const handleMouseLeave = (e) => {
                    const owner = img.closest('a, li, .more2_img') || img.parentNode;
                    if (e.relatedTarget && owner && owner.contains(e.relatedTarget)) {
                        return;
                    }
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    if (isZoomed && zoomContainer) {
                        zoomContainer.style.opacity = '0';
                        const zImg = zoomContainer.querySelector('img');
                        if (zImg) {
                            zImg.style.transform = 'scale(0.6)';
                            zImg.style.opacity = '0';
                        }
                        setTimeout(() => {
                            if (zoomContainer && zoomContainer.parentNode) {
                                zoomContainer.parentNode.removeChild(zoomContainer);
                            }
                            if (currentZoomContainer === zoomContainer) currentZoomContainer = null;
                            isZoomed = false;
                            zoomContainer = null;
                        }, 300);
                    }
                };

                const handleClick = (e) => {
                    if (isZoomed && zoomContainer) hideZoom(img);
                };

                img.addEventListener('mouseenter', handleMouseEnter);
                img.addEventListener('mouseleave', handleMouseLeave);
                img.addEventListener('click', handleClick, true);

                states.set(img, {
                    isZoomed, timer, zoomContainer, hasClickFunctionality,
                    containers: [directParent],
                    handlers: {
                        mouseenter: handleMouseEnter,
                        mouseleave: handleMouseLeave,
                        click: handleClick,
                        parent: directParent,
                        parentMouseenter: handleParentMouseEnter,
                        parentMouseleave: handleParentMouseLeave
                    }
                });
            } catch (error) {
                console.warn('图片处理失败:', error);
            }
        }

        function setupLazyHoverProcessor() {
            document.addEventListener('mouseover', debounce((e) => {
                window.__lastMouseX = e.clientX;
                window.__lastMouseY = e.clientY;
                if (!isEnabled || isHomepageZoomDisabled()) return;
                let img = null;
                if (e.target.tagName === 'IMG') img = e.target;
                else if (e.target.closest) img = e.target.closest('img');
                if (img && !img.classList.contains('image-zoom-processed')) {
                    processImage(img);
                    if (img.classList.contains('image-zoom-processed')) {
                        const rect = img.getBoundingClientRect();
                        if (rect.width >= config.minOriginalSize && rect.height >= config.minOriginalSize) {
                            img.dispatchEvent(new MouseEvent('mouseenter'));
                        }
                    }
                }
            }, 80), true);
        }

        function setupLightboxObserver() {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes' &&
                        (mutation.target === document.body || mutation.target === document.documentElement)) {
                        if (isImageInLightboxMode()) {
                            document.querySelectorAll('.image-zoom-container').forEach(container => {
                                container.style.opacity = '0';
                                setTimeout(() => {
                                    if (container.parentNode) container.parentNode.removeChild(container);
                                }, 300);
                            });
                            currentZoomContainer = null;
                            document.querySelectorAll('img.image-zoom-processed').forEach(img => {
                                const state = states.get(img);
                                if (state) {
                                    states.set(img, { ...state, isZoomed: false, zoomContainer: null });
                                }
                            });
                        }
                    }
                });
            });
            observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
            lightboxObserver = observer;
            return observer;
        }

        function initImages() {
            if (isHomepageZoomDisabled()) return;
            const imgs = Array.from(document.querySelectorAll('img:not(.image-zoom-processed)'));
            const processBatch = (deadline) => {
                while (imgs.length > 0 && (deadline.timeRemaining ? deadline.timeRemaining() > 0 : true)) {
                    const img = imgs.shift();
                    processImage(img);
                }
                if (imgs.length > 0) {
                    if ('requestIdleCallback' in window) {
                        requestIdleCallback(processBatch, { timeout: 1000 });
                    } else {
                        setTimeout(() => processBatch({ timeRemaining: () => 5 }), 10);
                    }
                }
            };
            if ('requestIdleCallback' in window) {
                requestIdleCallback(processBatch, { timeout: 1000 });
            } else {
                processBatch({ timeRemaining: () => 5 });
            }
        }

        function startObserver() {
            let processingQueue = false;
            const observer = new MutationObserver(mutations => {
                if (!isEnabled || isHomepageZoomDisabled()) return;
                if (processingQueue) return;
                processingQueue = true;
                requestAnimationFrame(() => {
                    const nodesToProcess = new Set();
                    mutations.forEach(mutation => {
                        if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG' &&
                            !mutation.target.classList.contains('image-zoom-processed')) {
                            nodesToProcess.add(mutation.target);
                        } else if (mutation.type === 'childList') {
                            mutation.addedNodes.forEach(node => {
                                if (node.nodeType !== Node.ELEMENT_NODE) return;
                                if (node.tagName === 'IMG' && !node.classList.contains('image-zoom-processed')) {
                                    nodesToProcess.add(node);
                                } else if (node.tagName === 'A' && node.classList.contains('stretched-link')) {
                                    const img = node.closest('.card')?.querySelector('img.image-zoom-processed');
                                    if (img) handleStretchedLink(img);
                                } else if (node.tagName === 'A' && node.querySelector('img')) {
                                    const img = node.querySelector('img');
                                    if (img && !img.classList.contains('image-zoom-processed')) nodesToProcess.add(img);
                                } else if (node.querySelectorAll) {
                                    node.querySelectorAll('img:not(.image-zoom-processed)').forEach(img => nodesToProcess.add(img));
                                    node.querySelectorAll('a.stretched-link').forEach(link => {
                                        const img = link.closest('.card')?.querySelector('img.image-zoom-processed');
                                        if (img) handleStretchedLink(img);
                                    });
                                }
                            });
                        }
                    });
                    nodesToProcess.forEach(img => processImage(img));
                    processingQueue = false;
                });
            });
            observer.observe(document.body, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['src', 'data-src', 'srcset']
            });
            zoomObserver = observer;
            return observer;
        }

        function init() {
            loadConfig();
            loadState();
            injectStyles();
            createDockButton();
            addKeyboardSupport();
            window.addEventListener('resize', debounce(handleResize, 250));
            setupLightboxObserver();
            if (isEnabled) initImages();
            setupLazyHoverProcessor();
            setupHoverProxy();
            startObserver();
        }

        return { init, cleanup, onWheel };
    })();

    // ================================
    // B站播放器辅助模块
    // ================================
    const bilibiliVolumeModule = (function() {
        let isEnabled = GM_getValue('bilibili_volume_enabled', true);
        let toast = null;

        function isInFullscreenMode() {
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
            if (fullscreenElement) {
                return true;
            }
            if (document.body.classList.contains('player-mode-webfullscreen')) {
                return true;
            }
            const player = document.querySelector('.bpx-player-container');
            if (player && player.classList.contains('state-fullscreen')) {
                return true;
            }
            return false;
        }

        function findVideoElement() {
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
            if (fullscreenElement) {
                const video = fullscreenElement.querySelector('video');
                if (video) return video;
            }
            return document.querySelector('.bpx-player-container video, video');
        }

        function applyVolume(video, newVolume) {
            const clamped = Math.max(0, Math.min(1, newVolume));
            try {
                const player = window.player;
                if (player && typeof player.setVolume === 'function') {
                    player.setVolume(Math.round(clamped * 100));
                    if (clamped > 0) {
                        if (typeof player.setMute === 'function') player.setMute(false);
                        else video.muted = false;
                    }
                    return;
                }
            } catch (err) { }
            video.volume = clamped;
            video.muted = false;
        }

        function getVolume(video) {
            try {
                const player = window.player;
                if (player && typeof player.getVolume === 'function') {
                    return player.getVolume() / 100;
                }
            } catch (err) {}
            return video.volume;
        }

        function getVolumeIcon(volume) {
            if (volume === 0) {
                return `<svg width="28" height="28" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M64 362.67v298.66h198.33L512 911V113L262.33 362.67H64zM736 512c0-43.56-11.28-83.22-33.83-119-22.56-35.78-52.5-63-89.83-81.67v399c37.33-17.11 67.28-43.55 89.83-79.33C724.72 595.22 736 555.56 736 512z" fill="currentColor"></path><path d="M704.5 320.5l-384 384M320.5 320.5l384 384" stroke="currentColor" stroke-width="56" stroke-linecap="round" fill="none"></path></svg>`;
            }
            return `<svg width="28" height="28" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M64 362.67v298.66h198.33L512 911V113L262.33 362.67H64zM736 512c0-43.56-11.28-83.22-33.83-119-22.56-35.78-52.5-63-89.83-81.67v399c37.33-17.11 67.28-43.55 89.83-79.33C724.72 595.22 736 555.56 736 512zM612.33 75.67v102.67c71.56 21.78 130.67 63.39 177.33 124.83 46.67 61.44 70 131.06 70 208.83 0 77.78-23.33 147.39-70 208.83C743 782.28 683.89 823.89 612.33 845.66v102.67C677.67 932.78 736.78 904 789.67 862s94.5-93.33 124.83-154S960 582 960 512s-15.17-135.33-45.5-196c-30.34-60.67-71.94-112-124.83-154s-112-70.78-177.34-86.33z" fill="currentColor"></path></svg>`;
        }

        function showVolumeToast(volume) {
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'bilibili-volume-toast';
                toast.style.cssText = `
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(255, 255, 255, 0.9); color: #333; padding: 8px 16px;
                    border-radius: 8px; z-index: 2147483647; font-size: 26px; font-weight: 300;
                    font-family: 'Segoe UI', Arial, sans-serif; opacity: 0; transition: opacity 0.3s ease;
                    pointer-events: none; box-shadow: 0 4px 20px rgba(0,0,0,0.2);
                    border: 1px solid rgba(0,0,0,0.1); min-width: 90px; text-align: center;
                    backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; gap: 8px;
                `;
            }
            const parentElement = document.fullscreenElement || document.webkitFullscreenElement || document.body;
            if (!toast.parentNode || toast.parentNode !== parentElement) {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
                parentElement.appendChild(toast);
            }
            toast.innerHTML = getVolumeIcon(volume) + `<span>${volume === 0 ? '静音' : Math.round(volume * 100) + '%'}</span>`;
            toast.style.opacity = '1';
            if (toast.timeoutId) clearTimeout(toast.timeoutId);
            toast.timeoutId = setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => {
                    if (toast && toast.parentNode) {
                        toast.parentNode.removeChild(toast);
                    }
                }, 300);
            }, 2000);
        }

        function onWheel(e) {
            if (!isEnabled || !isInFullscreenMode()) return false;
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
            if (!isEnabled) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            if ((e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') && isInFullscreenMode()) {
                e.preventDefault();
            }
        }

        function handleVolumeChange(e) {
            if (!isEnabled) return;
            if (e.target.tagName !== 'VIDEO') return;
            if (!isInFullscreenMode()) return;
            const video = e.target;
            showVolumeToast(video.muted ? 0 : video.volume);
        }

        function init() {
            if (!window.location.hostname.includes('bilibili.com')) return;
            isInFullscreenMode();
            setEnabled(isEnabled);
        }

        function setEnabled(enabled) {
            isEnabled = enabled;
            GM_setValue('bilibili_volume_enabled', enabled);
            if (enabled) {
                window.addEventListener('keydown', handleKeydown);
                document.addEventListener('volumechange', handleVolumeChange, { capture: true });
            } else {
                window.removeEventListener('keydown', handleKeydown);
                document.removeEventListener('volumechange', handleVolumeChange, { capture: true });
            }
        }

        return { init, setEnabled, onWheel, get isEnabled() { return isEnabled; } };
    })();

    // ================================
    // 主初始化函数
    // ================================
    function mainInit() {
        imageZoomModule.init();
        bilibiliVolumeModule.init();
        document.addEventListener('wheel', (e) => {
            if (imageZoomModule.onWheel(e)) return;
            bilibiliVolumeModule.onWheel(e);
        }, { capture: true, passive: false });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mainInit);
    } else {
        mainInit();
    }
})();
