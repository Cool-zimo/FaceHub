/**
 * 图标（内联 SVG）
 *
 * 为什么不用 emoji：
 *   · 各平台渲染不一样（同一字符在 Mac/Windows/Android 上长得不同）
 *   · 颜色不可控（微信的图标是单色描边，emoji 是彩色的，一眼假）
 *   · 无法跟随激活态变色
 *
 * 全部用 currentColor，颜色由 CSS 控制，激活态自动变色。
 * stroke 用 currentColor + 统一 1.8 宽度，视觉重量一致。
 */
(function (global) {

    function svg(inner, size, opts) {
        opts = opts || {};
        var vb = opts.vb || '0 0 24 24';
        var fill = opts.filled;
        var attrs = fill
            ? 'fill="currentColor" stroke="none"'
            : 'fill="none" stroke="currentColor" stroke-width="' +
              (opts.sw || 1.8) + '" stroke-linecap="round" stroke-linejoin="round"';
        return '<svg class="ico' + (opts.cls ? ' ' + opts.cls : '') + '" ' +
            'width="' + size + '" height="' + size + '" viewBox="' + vb + '" ' +
            attrs + ' aria-hidden="true">' + inner + '</svg>';
    }

    var Icons = {

        // ── 底部导航 ─────────────────────────────────────
        chat: function (s) {
            return svg('<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.9 8.9 0 0 1-3.8-.8L3 21l1.9-5.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.5-8.5h.5a8.4 8.4 0 0 1 8 8v.5z"/>', s || 22);
        },
        contacts: function (s) {
            return svg('<path d="M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/>' +
                '<circle cx="9" cy="7" r="3.2"/>' +
                '<path d="M22 20v-1a4 4 0 0 0-3-3.9"/>' +
                '<path d="M16 3.2a3.2 3.2 0 0 1 0 6"/>', s || 22);
        },
        // 朋友圈：同心圆（微信那个图标的抽象）
        moments: function (s) {
            return svg('<circle cx="12" cy="12" r="3"/>' +
                '<path d="M7.8 7.8a6 6 0 0 0 0 8.4"/>' +
                '<path d="M16.2 16.2a6 6 0 0 0 0-8.4"/>' +
                '<path d="M4.9 4.9a10 10 0 0 0 0 14.2"/>' +
                '<path d="M19.1 19.1a10 10 0 0 0 0-14.2"/>', s || 22, { sw: 1.7 });
        },
        // 点赞：心形
        heart: function (s) {
            return svg('<path d="M12 20s-7-4.5-7-9.5A3.8 3.8 0 0 1 12 7.6 3.8 3.8 0 0 1 19 10.5c0 5-7 9.5-7 9.5z"/>', s || 14, { sw: 1.7 });
        },
        // 评论：气泡
        comment: function (s) {
            return svg('<path d="M20 12a7.5 7.5 0 0 1-7.5 7.5c-.9 0-1.8-.15-2.6-.43L5 20.5l1.4-3.6A7.5 7.5 0 1 1 20 12z"/>', s || 14, { sw: 1.7 });
        },
        me: function (s) {
            return svg('<circle cx="12" cy="8" r="3.5"/>' +
                '<path d="M5 20v-1a7 7 0 0 1 14 0v1"/>', s || 22);
        },

        // ── 操作 ─────────────────────────────────────────
        plus: function (s) {
            return svg('<path d="M12 5v14M5 12h14"/>', s || 20, { sw: 2 });
        },
        search: function (s) {
            return svg('<circle cx="10.5" cy="10.5" r="6.5"/>' +
                '<path d="M20 20l-4.5-4.5"/>', s || 14, { sw: 2 });
        },
        more: function (s) {
            return svg('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
                '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
                '<circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>', s || 20);
        },
        back: function (s) {
            return svg('<path d="M15 5l-7 7 7 7"/>', s || 22, { sw: 2 });
        },
        close: function (s) {
            return svg('<path d="M6 6l12 12M18 6L6 18"/>', s || 18, { sw: 2 });
        },
        send: function (s) {
            return svg('<path d="M4.5 12l15-7.5-4 15-4.2-5.2L4.5 12z"/>', s || 18, { sw: 1.6 });
        },
        // 回形针：微信用的就是这个造型
        clip: function (s) {
            return svg('<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7.3-7.3"/>', s || 20, { sw: 1.9 });
        },

        // ── 状态 ─────────────────────────────────────────
        lock: function (s) {
            return svg('<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/>' +
                '<path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>', s || 13, { sw: 1.9 });
        },
        shield: function (s) {
            return svg('<path d="M12 3l7.5 3v6c0 4.4-3 8.2-7.5 9.5C7.5 20.2 4.5 16.4 4.5 12V6L12 3z"/>' +
                '<path d="M9 12l2 2 4-4"/>', s || 20, { sw: 1.7 });
        },
        check: function (s) {
            return svg('<path d="M5 12.5l4.5 4.5L19 7"/>', s || 14, { sw: 2.2 });
        },
        refresh: function (s) {
            return svg('<path d="M20 12a8 8 0 1 1-2.4-5.7"/>' +
                '<path d="M20 4v4.5h-4.5"/>', s || 14, { sw: 1.9 });
        },
        download: function (s) {
            return svg('<path d="M12 4v11"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/>' +
                '<path d="M5 19h14"/>', s || 15, { sw: 1.9 });
        },
        save: function (s) {
            return svg('<path d="M5 4h10l4 4v12H5z"/>' +
                '<path d="M9 4v5h6"/><rect x="9" y="13" width="6" height="5"/>', s || 15, { sw: 1.7 });
        },
        play: function (s) {
            return svg('<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none"/>', s || 16);
        },
        music: function (s) {
            return svg('<path d="M9 18V6l10-2v12"/>' +
                '<circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>', s || 16, { sw: 1.8 });
        },
        zoom: function (s) {
            return svg('<circle cx="10.5" cy="10.5" r="6.5"/>' +
                '<path d="M20 20l-4.5-4.5M8 10.5h5M10.5 8v5"/>', s || 16, { sw: 1.8 });
        },

        // ── 文件类型 ─────────────────────────────────────
        file: function (s) {
            return svg('<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/>' +
                '<path d="M13.5 3v5.5H19"/>', s || 18, { sw: 1.7 });
        },
        image: function (s) {
            return svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/>' +
                '<circle cx="9" cy="10" r="1.6"/>' +
                '<path d="M4 17l4.5-4.5 3.5 3.5 3-3 5 5"/>', s || 18, { sw: 1.7 });
        },
        video: function (s) {
            return svg('<rect x="3" y="5.5" width="12.5" height="13" rx="2"/>' +
                '<path d="M15.5 11l5.5-3v8l-5.5-3z"/>', s || 18, { sw: 1.7 });
        },
        audio: function (s) {
            return svg('<path d="M4 14v-4h3l4.5-4v12L7 14z"/>' +
                '<path d="M15.5 9a4 4 0 0 1 0 6"/>' +
                '<path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>', s || 18, { sw: 1.7 });
        },
        archive: function (s) {
            return svg('<rect x="3.5" y="4" width="17" height="4.5" rx="1"/>' +
                '<path d="M5.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5"/>' +
                '<path d="M10.5 12.5h3"/>', s || 18, { sw: 1.7 });
        },
        doc: function (s) {
            return svg('<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/>' +
                '<path d="M13.5 3v5.5H19"/>' +
                '<path d="M8.5 13h7M8.5 16.5h7"/>', s || 18, { sw: 1.6 });
        },

        // ── 空状态 ───────────────────────────────────────
        chatBig: function (s) {
            return svg('<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.9 8.9 0 0 1-3.8-.8L3 21l1.9-5.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.5-8.5h.5a8.4 8.4 0 0 1 8 8v.5z"/>', s || 56, { sw: 1.3 });
        },

        /** 按类型取文件图标 */
        forType: function (kind, name, size) {
            var n = String(name || '').toLowerCase();
            if (kind === 'image') return Icons.image(size);
            if (kind === 'video') return Icons.video(size);
            if (kind === 'audio') return Icons.audio(size);
            if (/\.(zip|rar|7z|tar|gz|bz2)$/.test(n)) return Icons.archive(size);
            if (/\.(doc|docx|rtf|pages)$/.test(n)) return Icons.doc(size);
            if (/\.(xls|xlsx|csv|numbers)$/.test(n)) return Icons.doc(size);
            if (/\.(pdf|epub|mobi)$/.test(n)) return Icons.doc(size);
            if (/\.(txt|md|json|log|yml|yaml|xml|ini)$/.test(n)) return Icons.doc(size);
            return Icons.file(size);
        }
    };

    global.Icons = Icons;
})(typeof window !== 'undefined' ? window : this);
