// ==UserScript==
// @name         鼠标悬停图片自动放大预览
// @namespace    http://tampermonkey.net/
// @version      3.3.1
// @description  一款好用的网页图片放大工具，鼠标悬停即可自动放大图片，支持自定义配置，适配所有网页～ 
// @author       益达哥哥
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// @license      MIT
// ==/UserScript==

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
            wrapperZIndex: 1,
            zoomZIndex: 9999,
            transition: 'all 0.3s ease',
            scrollSpeed: 50,
            smallImgThreshold: 280,
            smallImgWidth: 500,
            smallImgHeight: 430,
            avoidClickConflict: true
        };
    
        const states = new WeakMap();
        let isEnabled = true;
        let isMinimized = false;
        let originalPos = null;
        let config = { ...defaultConfig };
        const currentDomain = getDomain();
        let currentZoomContainer = null;
        let toggleButton = null;
        let excludedHomepages = [];
    
        const fullBtnWidth = 80;
        const fullBtnHeight = 32;
        const miniBtnDiameter = 32;
        const miniBtnRadius = miniBtnDiameter / 2;
        const exposeRatio = 0.15;
    
        // 【调试开关】改为 true 后，被跳过的图片会在控制台 (F12) 打印原因
        const DEBUG_IMAGE_CHECK = false;
    
        function getDomain() {
            try {
                return new URL(window.location.href).hostname;
            } catch (e) {
                return window.location.hostname;
            }
        }
    
        function getCurrentHomepage() {
            const url = new URL(window.location.href);
            return `${url.protocol}//${url.hostname}/`;
        }
    
        function isHomepageExcluded() {
            const currentHomepage = getCurrentHomepage();
            return excludedHomepages.includes(currentHomepage);
        }
    
        function loadExcludedHomepages() {
            const saved = GM_getValue(`image_zoom_excluded_homepages_${currentDomain}`, []);
            excludedHomepages = Array.isArray(saved) ? saved : [];
        }
    
        function saveExcludedHomepages() {
            GM_setValue(`image_zoom_excluded_homepages_${currentDomain}`, excludedHomepages);
        }
    
        function toggleCurrentHomepageExclusion() {
            const currentHomepage = getCurrentHomepage();
            const index = excludedHomepages.indexOf(currentHomepage);
            if (index > -1) {
                excludedHomepages.splice(index, 1);
                showToast('已启用当前主页的图片放大功能');
            } else {
                excludedHomepages.push(currentHomepage);
                showToast('已禁用当前主页的图片放大功能');
                if (isHomepage() && isEnabled) {
                    cleanup();
                }
            }
            saveExcludedHomepages();
            updateExclusionButtonState();
            updateButtonState();
        }
    
        function isHomepage() {
            const path = window.location.pathname;
            return path === '/' || path === '/index.html' || path === '/index.php' || path === '';
        }
    
        function showToast(message) {
            let toast = document.getElementById('image-zoom-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'image-zoom-toast';
                toast.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 12px 20px;
                    border-radius: 6px;
                    z-index: 100000;
                    font-size: 14px;
                    font-family: Arial, sans-serif;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                    pointer-events: none;
                `;
                document.body.appendChild(toast);
            }
            toast.textContent = message;
            toast.style.opacity = '1';
            setTimeout(() => {
                toast.style.opacity = '0';
            }, 2000);
        }
    
        function debounce(func, wait) {
            let timeout;
            return function(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }
    
        function validateConfig(cfg) {
            const validated = { ...cfg };
            validated.delay = Math.max(0, Math.min(2000, validated.delay));
            validated.scale = Math.max(1, Math.min(10, validated.scale));
            validated.maxWidth = Math.max(100, Math.min(5000, validated.maxWidth));
            validated.maxHeight = Math.max(100, Math.min(5000, validated.maxHeight));
            validated.minScale = Math.max(1, Math.min(5, validated.minScale));
            validated.portraitRatio = Math.max(1, Math.min(5, validated.portraitRatio));
            validated.scrollSpeed = Math.max(1, Math.min(100, validated.scrollSpeed));
            validated.smallImgThreshold = Math.max(50, Math.min(1000, validated.smallImgThreshold));
            validated.smallImgWidth = Math.max(100, Math.min(2000, validated.smallImgWidth));
            validated.smallImgHeight = Math.max(100, Math.min(2000, validated.smallImgHeight));
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
            if (isHomepage() && isHomepageExcluded()) {
                isEnabled = false;
            }
        }
    
        function injectStyles() {
            const style = document.createElement('style');
            style.textContent = `
                .image-zoom-wrapper * {
                    box-sizing: border-box;
                }
                .image-zoom-container img {
                    object-fit: contain;
                }
                #image-zoom-toggle {
                    all: initial;
                    font-family: Arial, sans-serif;
                }
                .image-zoom-hover {
                    cursor: zoom-in !important;
                }
                a.image-zoom-hover, .cover-container.image-zoom-hover, .card.image-zoom-hover {
                    cursor: zoom-in !important;
                }
                a.stretched-link.image-zoom-hover {
                    cursor: zoom-in !important;
                }
            `;
            document.head.appendChild(style);
        }
    
        function createToggleButton() {
            const button = document.createElement('div');
            button.id = 'image-zoom-toggle';
            button.className = 'zoom-btn';
            button.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: ${fullBtnWidth}px;
                height: ${fullBtnHeight}px;
                border-radius: ${fullBtnHeight/2}px;
                background-color: #4CAF50;
                color: white;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 12px;
                cursor: pointer;
                z-index: 99999;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                transition: all 0.5s ease;
                font-weight: bold;
                font-size: 12px;
                opacity: 0.2;
                overflow: visible;
                user-select: none;
            `;
    
            const textSpan = document.createElement('span');
            textSpan.className = 'btn-text';
            textSpan.textContent = '图片放大：开';
            textSpan.style.transition = 'opacity 0.3s ease';
    
            const arrowSpan = document.createElement('span');
            arrowSpan.className = 'btn-arrow';
            arrowSpan.textContent = '▶';
            arrowSpan.style.cssText = `margin-left: 5px; font-size: 14px; transition: transform 0.3s ease;`;
    
            button.appendChild(textSpan);
            button.appendChild(arrowSpan);
            button.title = '左键：切换功能 / 右键：打开设置 / 点击箭头：吸附边缘';
    
            const savedPos = GM_getValue(`image_zoom_button_pos_${currentDomain}`);
            if (savedPos) {
                button.style.top = savedPos.top;
                button.style.left = savedPos.left;
                button.style.bottom = "auto";
                button.style.right = "auto";
            }
    
            button.addEventListener('mouseenter', () => button.style.opacity = '1');
            button.addEventListener('mouseleave', () => button.style.opacity = isMinimized ? '0.5' : '0.2');
    
            button.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn-arrow') || e.target.parentNode.classList.contains('btn-arrow')) {
                    e.stopPropagation();
                    if (isMinimized) restoreButton();
                    else minimizeButton();
                    return;
                }
                if (e.button !== 0) return;
                toggleEnabled();
            });
    
            button.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                toggleConfigPanel();
            });
    
            makeDraggable(button);
            document.body.appendChild(button);
            updateButtonState();
            return button;
        }
    
        function minimizeButton() {
            if (isMinimized) return;
            originalPos = {
                top: toggleButton.style.top,
                left: toggleButton.style.left,
                bottom: toggleButton.style.bottom,
                right: toggleButton.style.right,
                width: toggleButton.style.width,
                height: toggleButton.style.height
            };
    
            const rect = toggleButton.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const distances = {
                right: viewportWidth - rect.right,
                left: rect.left
            };
            const nearestEdge = Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
    
            toggleButton.style.top = 'auto';
            toggleButton.style.left = 'auto';
            toggleButton.style.bottom = 'auto';
            toggleButton.style.right = 'auto';
            toggleButton.style.width = `${miniBtnDiameter}px`;
            toggleButton.style.height = `${miniBtnDiameter}px`;
            toggleButton.style.borderRadius = '50%';
            toggleButton.querySelector('.btn-text').style.opacity = '0';
    
            const arrowSpan = toggleButton.querySelector('.btn-arrow');
            const exposeWidth = miniBtnDiameter * exposeRatio;
            arrowSpan.style.cssText = `margin: 0; font-size: 12px; position: absolute; top: 50%; transform: translateY(-50%);`;
    
            if (nearestEdge === 'left') {
                arrowSpan.textContent = '▶';
                arrowSpan.style.left = `${miniBtnDiameter * (1 - exposeRatio) + exposeWidth * 0.5}px`;
            } else {
                arrowSpan.textContent = '◀';
                arrowSpan.style.left = `${exposeWidth * 0.5}px`;
            }
    
            const centerY = rect.top + rect.height/2;
            const hiddenOffset = miniBtnDiameter * (1 - exposeRatio);
            if (nearestEdge === 'left') {
                toggleButton.style.left = `-${hiddenOffset}px`;
                toggleButton.style.top = `${centerY - miniBtnRadius}px`;
            } else {
                toggleButton.style.right = `-${hiddenOffset}px`;
                toggleButton.style.top = `${centerY - miniBtnRadius}px`;
            }
            toggleButton.style.opacity = '0.5';
            isMinimized = true;
        }
    
        function restoreButton() {
            if (!isMinimized || !originalPos) return;
            toggleButton.style.width = originalPos.width;
            toggleButton.style.height = originalPos.height;
            toggleButton.style.borderRadius = `${fullBtnHeight/2}px`;
            toggleButton.querySelector('.btn-text').style.opacity = '1';
            const arrowSpan = toggleButton.querySelector('.btn-arrow');
            arrowSpan.style.cssText = `margin-left: 5px; font-size: 14px; transition: transform 0.3s ease; position: static; transform: none;`;
            const originalLeft = parseFloat(originalPos.left) || 0;
            const viewportHalf = window.innerWidth / 2;
            arrowSpan.textContent = originalLeft < viewportHalf ? '◀' : '▶';
            toggleButton.style.top = originalPos.top;
            toggleButton.style.left = originalPos.left;
            toggleButton.style.bottom = originalPos.bottom;
            toggleButton.style.right = originalPos.right;
            toggleButton.style.opacity = '0.2';
            isMinimized = false;
        }
    
        function toggleEnabled() {
            isEnabled = !isEnabled;
            GM_setValue(`image_zoom_enabled_${currentDomain}`, isEnabled);
            updateButtonState();
            if (isEnabled) {
                initImages();
            } else {
                cleanup();
            }
        }
    
        function cleanup() {
            if (currentZoomContainer) {
                currentZoomContainer.remove();
                currentZoomContainer = null;
            }
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
        }
    
        function updateButtonState() {
            if (!toggleButton) return;
            const textSpan = toggleButton.querySelector('.btn-text');
            if (isHomepage() && isHomepageExcluded()) {
                textSpan.textContent = '主页已排除';
                toggleButton.style.backgroundColor = '#ff9800';
            } else {
                textSpan.textContent = isEnabled ? '图片放大：开' : '图片放大：关';
                toggleButton.style.backgroundColor = isEnabled ? '#4CAF50' : '#f44336';
            }
        }
    
        function makeDraggable(element) {
            let isDragging = false;
            element.onmousedown = (e) => {
                if (isMinimized) {
                    restoreButton();
                    return;
                }
                if (e.button !== 0) return;
                e.preventDefault();
                isDragging = true;
                document.addEventListener('mousemove', dragMove);
                document.addEventListener('mouseup', dragEnd);
            };
    
            function dragMove(e) {
                if (!isDragging) return;
                e.preventDefault();
                const buttonHalfWidth = element.offsetWidth / 2;
                const buttonHalfHeight = element.offsetHeight / 2;
                const left = e.clientX - buttonHalfWidth;
                const top = e.clientY - buttonHalfHeight;
                element.style.top = `${top}px`;
                element.style.left = `${left}px`;
                element.style.bottom = "auto";
                element.style.right = "auto";
                const arrowSpan = element.querySelector('.btn-arrow');
                const viewportHalf = window.innerWidth / 2;
                arrowSpan.textContent = left < viewportHalf ? '◀' : '▶';
            }
    
            function dragEnd() {
                if (!isDragging) return;
                isDragging = false;
                GM_setValue(`image_zoom_button_pos_${currentDomain}`, {
                    top: element.style.top,
                    left: element.style.left
                });
                document.removeEventListener('mousemove', dragMove);
                document.removeEventListener('mouseup', dragEnd);
            }
        }
    
        function updateExclusionButtonState() {
            const exclusionBtn = document.getElementById('homepage-exclusion-btn');
            const exclusionStatus = document.getElementById('exclusion-status');
            if (exclusionBtn && exclusionStatus) {
                const isExcluded = isHomepageExcluded();
                exclusionBtn.textContent = isExcluded ? '启用主页功能' : '禁用主页功能';
                exclusionBtn.style.backgroundColor = isExcluded ? '#4CAF50' : '#ff9800';
                exclusionStatus.textContent = isExcluded ? '当前主页已禁用图片放大' : '当前主页已启用图片放大';
                exclusionStatus.style.color = isExcluded ? '#ff9800' : '#4CAF50';
            }
        }
    
        function checkImageClickBehavior(img) {
            const commonSelectors = ['[onclick*="zoom"]', '[onclick*="lightbox"]', '[onclick*="gallery"]', '[onclick*="preview"]', '[data-action*="zoom"]', '[data-lightbox]', '[data-gallery]', '[data-fancybox]', '.zoomable', '.lightbox', '.gallery-item', '.fancybox', '.stretched-link'];
            for (const selector of commonSelectors) {
                if (img.matches(selector)) return true;
            }
            let parent = img.parentElement;
            while (parent && parent !== document.body) {
                const parentClass = parent.className || '';
                const parentId = parent.id || '';
                if (parentClass.includes('zoom') || parentClass.includes('lightbox') || parentClass.includes('gallery') || parentClass.includes('fancybox') || parentClass.includes('stretched-link') || parentId.includes('zoom') || parentId.includes('lightbox') || parentId.includes('gallery') || parentId.includes('fancybox')) {
                    return true;
                }
                parent = parent.parentElement;
            }
            return false;
        }
    
        function isImageInLightboxMode(img) {
            const commonLightboxSelectors = ['.lightbox-open', '.fancybox-open', '.modal-open', '.zoom-overlay-open'];
            for (const selector of commonLightboxSelectors) {
                if (document.body.classList.contains(selector.replace('.', '')) || document.documentElement.classList.contains(selector.replace('.', ''))) {
                    return true;
                }
            }
            return false;
        }
    
        // 增强的图片验证：兼容 Discuz 轮播图/选项卡/懒加载
        function isValidImage(img) {
            if (!img || !img.parentNode) return false;
            if (img.tagName !== 'IMG') return false;
            // 用 getClientRects 替代 offsetParent，兼容 position:fixed 及特殊布局
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
            // 未加载完的图片，等 load 后自动重新检测（懒加载兼容）
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
    
        function createConfigPanel() {
            const panel = document.createElement('div');
            panel.id = 'image-zoom-config';
            panel.style.cssText = `position: fixed; bottom: 70px; right: 20px; width: 320px; background: white; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); padding: 15px; z-index: 99998; display: none; font-family: Arial, sans-serif; max-height: 80vh; overflow-y: auto;`;
    
            const title = document.createElement('h3');
            title.textContent = '图片放大设置';
            title.style.cssText = 'margin: 0 0 15px; padding-bottom: 8px; border-bottom: 1px solid #eee;';
            panel.appendChild(title);
    
            const exclusionSection = document.createElement('div');
            exclusionSection.style.cssText = `margin: 15px 0; padding: 12px; background: #f8f9fa; border-radius: 6px; border-left: 4px solid #ff9800;`;
    
            const exclusionTitle = document.createElement('h4');
            exclusionTitle.textContent = '如果此主页面图片不显示可以尝试禁用';
            exclusionTitle.style.cssText = 'margin: 0 0 8px; color: #333;';
            exclusionSection.appendChild(exclusionTitle);
    
            const exclusionDesc = document.createElement('p');
            exclusionDesc.textContent = '在当前网站主页禁用图片放大功能，不影响其他的子页面';
            exclusionDesc.style.cssText = 'margin: 0 0 10px; font-size: 12px; color: #666;';
            exclusionSection.appendChild(exclusionDesc);
    
            const exclusionStatus = document.createElement('div');
            exclusionStatus.id = 'exclusion-status';
            exclusionStatus.style.cssText = 'margin: 8px 0; font-size: 13px; font-weight: bold;';
            exclusionSection.appendChild(exclusionStatus);
    
            const exclusionBtn = document.createElement('button');
            exclusionBtn.id = 'homepage-exclusion-btn';
            exclusionBtn.style.cssText = `width: 100%; padding: 8px; background: #ff9800; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;`;
            exclusionBtn.addEventListener('click', toggleCurrentHomepageExclusion);
            exclusionSection.appendChild(exclusionBtn);
    
            const exclusionListTitle = document.createElement('h5');
            exclusionListTitle.textContent = '已排除的主页:';
            exclusionListTitle.style.cssText = 'margin: 15px 0 8px; color: #333;';
            exclusionSection.appendChild(exclusionListTitle);
    
            const exclusionList = document.createElement('div');
            exclusionList.id = 'exclusion-list';
            exclusionList.style.cssText = 'max-height: 120px; overflow-y: auto; font-size: 12px;';
            exclusionSection.appendChild(exclusionList);
    
            panel.appendChild(exclusionSection);
    
            function updateExclusionList() {
                exclusionList.innerHTML = '';
                if (excludedHomepages.length === 0) {
                    const emptyMsg = document.createElement('div');
                    emptyMsg.textContent = '暂无排除的主页';
                    emptyMsg.style.cssText = 'color: #999; font-style: italic; padding: 5px;';
                    exclusionList.appendChild(emptyMsg);
                } else {
                    excludedHomepages.forEach(homepage => {
                        const item = document.createElement('div');
                        item.style.cssText = `display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; margin: 2px 0; background: white; border-radius: 3px; border: 1px solid #eee;`;
                        const urlSpan = document.createElement('span');
                        urlSpan.textContent = homepage;
                        urlSpan.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                        const removeBtn = document.createElement('button');
                        removeBtn.textContent = '移除';
                        removeBtn.style.cssText = `background: #f44336; color: white; border: none; border-radius: 3px; padding: 2px 6px; font-size: 11px; cursor: pointer; margin-left: 8px;`;
                        removeBtn.addEventListener('click', () => {
                            const index = excludedHomepages.indexOf(homepage);
                            if (index > -1) {
                                excludedHomepages.splice(index, 1);
                                saveExcludedHomepages();
                                updateExclusionList();
                                updateExclusionButtonState();
                                updateButtonState();
                                showToast('已移除主页排除');
                            }
                        });
                        item.appendChild(urlSpan);
                        item.appendChild(removeBtn);
                        exclusionList.appendChild(item);
                    });
                }
            }
    
            const avoidConflictItem = document.createElement('div');
            avoidConflictItem.style.marginBottom = '12px';
            const avoidConflictLabel = document.createElement('label');
            avoidConflictLabel.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px; font-size: 14px; cursor: pointer;';
            const avoidConflictCheckbox = document.createElement('input');
            avoidConflictCheckbox.type = 'checkbox';
            avoidConflictCheckbox.checked = config.avoidClickConflict;
            avoidConflictCheckbox.style.cssText = 'margin-right: 8px;';
            avoidConflictCheckbox.addEventListener('change', () => {
                config.avoidClickConflict = avoidConflictCheckbox.checked;
                saveConfig();
                if (isEnabled) {
                    cleanup();
                    initImages();
                }
            });
            const avoidConflictText = document.createElement('span');
            avoidConflictText.textContent = '避免与点击放大功能冲突';
            avoidConflictLabel.appendChild(avoidConflictCheckbox);
            avoidConflictLabel.appendChild(avoidConflictText);
            avoidConflictItem.appendChild(avoidConflictLabel);
            const avoidConflictDesc = document.createElement('div');
            avoidConflictDesc.textContent = '开启后会自动检测网站的点击放大功能，避免冲突';
            avoidConflictDesc.style.cssText = 'font-size: 12px; color: #666; margin-top: 4px;';
            avoidConflictItem.appendChild(avoidConflictDesc);
            panel.appendChild(avoidConflictItem);
    
            function addConfigInput(label, key, type = 'number', min, max, step) {
                const item = document.createElement('div');
                item.style.marginBottom = '12px';
                const itemLabel = document.createElement('label');
                itemLabel.style.cssText = 'display: block; margin-bottom: 5px; font-size: 14px;';
                itemLabel.textContent = label;
                item.appendChild(itemLabel);
                const input = document.createElement('input');
                input.type = type;
                input.value = config[key];
                input.min = min;
                input.max = max;
                input.step = step;
                input.style.cssText = 'width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 4px;';
                input.addEventListener('input', () => {
                    let value = type === 'number' ? parseFloat(input.value) : input.value;
                    if (isNaN(value)) value = defaultConfig[key];
                    config[key] = value;
                    saveConfig();
                });
                item.appendChild(input);
                panel.appendChild(item);
            }
    
            addConfigInput('悬停延迟(毫秒)', 'delay', 'number', 0, 2000, 100);
            addConfigInput('大图放大倍数', 'scale', 'number', 1, 5, 0.1);
            addConfigInput('大图最小倍数', 'minScale', 'number', 1, 3, 0.1);
            addConfigInput('大图最大宽度(像素)', 'maxWidth', 'number', 300, 3000, 100);
            addConfigInput('大图最大高度(像素)', 'maxHeight', 'number', 300, 3000, 100);
            addConfigInput('竖屏判定比例', 'portraitRatio', 'number', 1, 3, 0.1);
            addConfigInput('滚轮移动速度(像素)', 'scrollSpeed', 'number', 5, 50, 1);
            addConfigInput('小图判定阈值(像素)', 'smallImgThreshold', 'number', 100, 500, 10);
            addConfigInput('小图强制宽度(像素)', 'smallImgWidth', 'number', 300, 1000, 10);
            addConfigInput('小图强制高度(像素)', 'smallImgHeight', 'number', 300, 1000, 10);
            addConfigInput('包装层层级', 'wrapperZIndex', 'number', 0, 100, 1);
    
            const bilibiliVolumeSection = document.createElement('div');
            bilibiliVolumeSection.style.cssText = `margin: 20px 0 15px 0; padding: 12px; background: #f0f8ff; border-radius: 6px; border-left: 4px solid #2196F3;`;
    
            const bilibiliTitle = document.createElement('h4');
            bilibiliTitle.textContent = 'B站播放器辅助';
            bilibiliTitle.style.cssText = 'margin: 0 0 8px; color: #333;';
            bilibiliVolumeSection.appendChild(bilibiliTitle);
    
            const bilibiliDesc = document.createElement('p');
            bilibiliDesc.textContent = 'B站全屏时滚轮调节音量（脚本接管）；方向键只防页面穿透滚动，音量/快进调节由B站原生逻辑处理';
            bilibiliDesc.style.cssText = 'margin: 0 0 10px; font-size: 12px; color: #666;';
            bilibiliVolumeSection.appendChild(bilibiliDesc);
    
            const bilibiliLabel = document.createElement('label');
            bilibiliLabel.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px; font-size: 14px; cursor: pointer;';
            const bilibiliCheckbox = document.createElement('input');
            bilibiliCheckbox.type = 'checkbox';
            bilibiliCheckbox.checked = bilibiliVolumeModule.isEnabled;
            bilibiliCheckbox.style.cssText = 'margin-right: 8px;';
            bilibiliCheckbox.addEventListener('change', () => {
                bilibiliVolumeModule.setEnabled(bilibiliCheckbox.checked);
            });
            const bilibiliText = document.createElement('span');
            bilibiliText.textContent = '启用B站播放器辅助';
            bilibiliLabel.appendChild(bilibiliCheckbox);
            bilibiliLabel.appendChild(bilibiliText);
            bilibiliVolumeSection.appendChild(bilibiliLabel);
            panel.appendChild(bilibiliVolumeSection);
    
            const resetBtn = document.createElement('button');
            resetBtn.textContent = '恢复默认设置';
            resetBtn.style.cssText = `width: 100%; padding: 8px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; margin-top: 10px;`;
            resetBtn.addEventListener('click', () => {
                if (confirm('确定要恢复默认设置吗？')) {
                    config = { ...defaultConfig };
                    saveConfig();
                    const newPanel = createConfigPanel();
                    if (panel.parentNode) {
                        panel.parentNode.replaceChild(newPanel, panel);
                    }
                }
            });
            panel.appendChild(resetBtn);
    
            document.body.appendChild(panel);
            updateExclusionList();
            updateExclusionButtonState();
            return panel;
        }
    
        function toggleConfigPanel() {
            const panel = document.getElementById('image-zoom-config');
            if (panel) {
                panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
                if (panel.style.display === 'block') {
                    updateExclusionList();
                    updateExclusionButtonState();
                }
            }
        }
    
        // 【改造】放大态滚轮处理，返回 true 表示事件已被放大功能接管
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
            if (isMinimized) {
                minimizeButton();
            }
        }
    
        function addKeyboardSupport() {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    const panel = document.getElementById('image-zoom-config');
                    if (panel && panel.style.display !== 'none') {
                        panel.style.display = 'none';
                    }
                }
                if (e.altKey && e.key === 'z') {
                    e.preventDefault();
                    toggleEnabled();
                }
            });
        }
    
        function createZoomedImage(img, hasClickFunctionality = false) {
            if (!isEnabled) return null;
            try {
                const rect = img.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return null;
    
                const isSmallImg = rect.width < config.smallImgThreshold || rect.height < config.smallImgThreshold;
                const isPortrait = rect.height / rect.width > config.portraitRatio;
    
                let scale, zoomedImgStyle;
    
                if (isSmallImg) {
                    scale = isPortrait ? config.smallImgHeight / rect.height : config.smallImgWidth / rect.width;
                    zoomedImgStyle = `width: ${rect.width * scale}px; height: ${rect.height * scale}px; transform: scale(0.95); transition: ${config.transition}; box-shadow: 0 4px 20px rgba(0,0,0,0.2); margin-top: 0;`;
                } else {
                    if (isPortrait) {
                        const heightScale = config.maxHeight / rect.height;
                        scale = Math.min(config.scale, heightScale, Math.max(config.minScale, 1.2));
                    } else {
                        const widthScale = config.maxWidth / rect.width;
                        const heightScale = config.maxHeight / rect.height;
                        scale = Math.min(config.scale, widthScale, heightScale, Math.max(config.minScale, 1));
                    }
                    const maxHeight = isPortrait ? config.maxHeight + 200 : config.maxHeight;
                    zoomedImgStyle = `max-width: ${config.maxWidth}px; max-height: ${maxHeight}px; width: auto; height: auto; transform: scale(0.95); transition: ${config.transition}; box-shadow: 0 4px 20px rgba(0,0,0,0.2); margin-top: 0;`;
                }
    
                const zoomContainer = document.createElement('div');
                zoomContainer.className = 'image-zoom-container';
                const zoomZIndex = hasClickFunctionality ? config.zoomZIndex - 1 : config.zoomZIndex;
                zoomContainer.style.cssText = `position: fixed; z-index: ${zoomZIndex}; opacity: 0; transition: ${config.transition}; pointer-events: none; left: 0; top: 0; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box; background-color: rgba(0,0,0,0.1);`;
    
                const zoomedImg = document.createElement('img');
                zoomedImg.src = img.src || img.currentSrc;
                zoomedImg.alt = img.alt;
                zoomedImg.style.cssText = zoomedImgStyle;
                zoomContainer.appendChild(zoomedImg);
                document.body.appendChild(zoomContainer);
    
                if (currentZoomContainer) currentZoomContainer.remove();
                currentZoomContainer = zoomContainer;
    
                setTimeout(() => {
                    zoomContainer.style.opacity = '1';
                    zoomedImg.style.transform = `scale(${scale})`;
                }, 10);
    
                return zoomContainer;
            } catch (error) {
                console.warn('创建放大图失败:', error);
                return null;
            }
        }
    
        function showZoom(img) {
            if (!isEnabled) return;
            if (config.avoidClickConflict && isImageInLightboxMode(img)) return;
            const state = states.get(img);
            if (!state || state.isZoomed) return;
            const zoomContainer = createZoomedImage(img, state.hasClickFunctionality);
            if (!zoomContainer) return;
            states.set(img, { ...state, isZoomed: true, zoomContainer });
        }
    
        function hideZoom(img) {
            const state = states.get(img);
            if (!state || !state.isZoomed || !state.zoomContainer) return;
            const zoomedImg = state.zoomContainer.querySelector('img');
            if (zoomedImg) zoomedImg.style.transform = 'scale(0.95)';
            state.zoomContainer.style.opacity = '0';
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
    
        function processImage(img) {
            if (!isEnabled) return;
            try {
                if (!img || !img.parentNode) return;
                if (!isValidImage(img)) return;
    
                let containers = [];
                let current = img.parentNode;
                while (current && current !== document.body) {
                    containers.push(current);
                    if (current.tagName === 'A' || current.classList.contains('card') || current.classList.contains('col') || current.classList.contains('card-img-container')) break;
                    current = current.parentNode;
                }
                const container = containers.length > 0 ? containers[containers.length - 1] : img.parentNode;
    
                const hasClickFunctionality = config.avoidClickConflict ? (checkImageClickBehavior(img) || container.tagName === 'A' || container.classList.contains('stretched-link')) : false;
    
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
                    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
                        img.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
                    }
                };
                const handleParentMouseLeave = (e) => {
                    if (!directParent.contains(e.relatedTarget)) {
                        img.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true }));
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
                    if (config.avoidClickConflict && isImageInLightboxMode(img)) return;
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => {
                        if (!isZoomed) {
                            zoomContainer = createZoomedImage(img, hasClickFunctionality);
                            if (zoomContainer) isZoomed = true;
                        }
                    }, config.delay);
                };
    
                const handleMouseLeave = (e) => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    if (isZoomed && zoomContainer) {
                        const zoomedImg = zoomContainer.querySelector('img');
                        if (zoomedImg) zoomedImg.style.transform = 'scale(0.95)';
                        zoomContainer.style.opacity = '0';
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
    
                // 保存事件处理函数引用，便于清理
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
    
        // 悬停自愈机制：第一次悬停未处理的图片时，重新检测并直接触发放大
        function setupLazyHoverProcessor() {
            document.addEventListener('mouseover', debounce((e) => {
                if (!isEnabled || (isHomepage() && isHomepageExcluded())) return;
                let img = null;
                if (e.target.tagName === 'IMG') img = e.target;
                else if (e.target.closest) img = e.target.closest('img');
                if (img && !img.classList.contains('image-zoom-processed')) {
                    processImage(img);
                    if (img.classList.contains('image-zoom-processed')) {
                        img.dispatchEvent(new MouseEvent('mouseenter'));
                    }
                }
            }, 80), true);
        }
    
        function setupLightboxObserver() {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes' && (mutation.target === document.body || mutation.target === document.documentElement)) {
                        if (isImageInLightboxMode(null)) {
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
        }
    
        function initImages() {
            if (isHomepage() && isHomepageExcluded()) return;
            const imgs = Array.from(document.querySelectorAll('img:not(.image-zoom-processed)'));
            // 分批处理防卡顿，使用 requestIdleCallback
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
                if (!isEnabled || (isHomepage() && isHomepageExcluded())) return;
                if (processingQueue) return;
                processingQueue = true;
                // requestAnimationFrame 节流，合并多次 Mutation 回调
                requestAnimationFrame(() => {
                    const nodesToProcess = new Set();
                    mutations.forEach(mutation => {
                        // 处理属性变化（懒加载图片 src 更新）
                        if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG' && !mutation.target.classList.contains('image-zoom-processed')) {
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
            // 监听 attributes 变化，适配懒加载
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'data-src', 'srcset']
            });
        }
    
        function init() {
            loadConfig();
            loadExcludedHomepages();
            loadState();
            injectStyles();
            toggleButton = createToggleButton();
            createConfigPanel();
            addKeyboardSupport();
            window.addEventListener('resize', debounce(handleResize, 250));
            setupLightboxObserver();
            if (isEnabled) initImages();
            setupLazyHoverProcessor(); // 悬停自愈机制
            startObserver();           // 注意：wheel 监听已移至 mainInit 的统一调度器
        }
    
        return { init, cleanup, onWheel };
    })();
    
    // ================================
    // B站播放器辅助模块（v3.3.1 修正版）
    // 滚轮调音量：脚本接管（B站原生滚轮在网页全屏下不可靠，已实测）
    // 方向键：守卫模式，交还 B站原生（已实测可用）
    // 音量提示：滚轮直接显示 + volumechange 监听兜底（覆盖拖音量条等场景）
    // ================================
    const bilibiliVolumeModule = (function() {
        let isEnabled = GM_getValue('bilibili_volume_enabled', true);
        let toast = null;
        let currentFullscreenElement = null;
    
        function isInFullscreenMode() {
            const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
            if (fullscreenElement) {
                currentFullscreenElement = fullscreenElement;
                return true;
            }
            if (document.body.classList.contains('player-mode-webfullscreen')) {
                currentFullscreenElement = document.body;
                return true;
            }
            const player = document.querySelector('.bpx-player-container');
            if (player && player.classList.contains('state-fullscreen')) {
                currentFullscreenElement = player;
                return true;
            }
            currentFullscreenElement = null;
            return false;
        }
    
        function findVideoElement() {
            if (currentFullscreenElement) {
                const video = currentFullscreenElement.querySelector('video');
                if (video) return video;
            }
            return document.querySelector('.bpx-player-container video, video');
        }
    
        // 优先走 B站官方 player API（0~100），播放器自己的音量条状态会同步更新
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
            } catch (err) { /* API 不可用时降级 */ }
            video.volume = clamped;
            video.muted = false;
        }
    
        function getVolume(video) {
            try {
                const player = window.player;
                if (player && typeof player.getVolume === 'function') return player.getVolume() / 100;
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
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: rgba(255, 255, 255, 0.9);
                    color: #333;
                    padding: 8px 16px;
                    border-radius: 8px;
                    z-index: 2147483647;
                    font-size: 26px;
                    font-weight: 300;
                    font-family: 'Segoe UI', Arial, sans-serif;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                    pointer-events: none;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.2);
                    border: 1px solid rgba(0,0,0,0.1);
                    min-width: 90px;
                    text-align: center;
                    backdrop-filter: blur(10px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                `;
            }
            const parentElement = currentFullscreenElement || document.body;
            if (!toast.parentNode || toast.parentNode !== parentElement) {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
                parentElement.appendChild(toast);
            }
            toast.innerHTML = getVolumeIcon(volume) + `<span>${volume === 0 ? '静音' : Math.round(volume * 100) + '%'}</span>`;
            toast.style.opacity = '1';
            if (toast.timeoutId) clearTimeout(toast.timeoutId);
            toast.timeoutId = setTimeout(() => {
                if (toast) toast.style.opacity = '0';
            }, 2000);
        }
    
        // 【滚轮】脚本接管：调音量 + 防穿透（B站原生滚轮调音量在网页全屏下不可靠）
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
    
        // 【方向键守卫】保留：只挡页面穿透滚动，调节交给 B站原生（已实测可用）
        function handleKeydown(e) {
            if (!isEnabled) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            if ((e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') && isInFullscreenMode()) {
                e.preventDefault();
            }
        }
    
        // 【音量提示】监听 volumechange（capture 阶段，不依赖冒泡）
        // 覆盖非脚本来源的音量变化（如拖动B站音量条），统一弹出提示
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
            window.addEventListener('keydown', handleKeydown);
            document.addEventListener('volumechange', handleVolumeChange, { capture: true });
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
    
        return {
            init,
            setEnabled,
            onWheel,
            get isEnabled() { return isEnabled; }
        };
    })();
    
    // ================================
    // 主初始化函数
    // ================================
    function mainInit() {
        imageZoomModule.init();
        bilibiliVolumeModule.init();
    
        // 【统一滚轮调度】全脚本唯一 wheel 监听器
        // 优先级：图片放大态 > B站全屏滚轮音量 > 浏览器默认行为
        document.addEventListener('wheel', (e) => {
            if (imageZoomModule.onWheel(e)) return;      // 放大图滚动大图（stopPropagation）
            bilibiliVolumeModule.onWheel(e);             // B站全屏：脚本接管调音量
            // 都不接管时，不 preventDefault，页面正常滚动
        }, { capture: true, passive: false });
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mainInit);
    } else {
        mainInit();
    }
})();
