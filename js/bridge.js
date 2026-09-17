/**
 * 应用间联动桥（Bridge）
 *
 * 前提：三个应用同在 cool-zimo.github.io 下
 *   https://cool-zimo.github.io/github_drive/
 *   https://cool-zimo.github.io/cangshu/
 *   https://cool-zimo.github.io/FaceHub/
 * 同源 → localStorage 共享 → 令牌互认。登录一个，另外两个免登录。
 *
 * 本文件与 github_drive / 仓鼠 里的同名文件配合工作，
 * 令牌键名必须保持一致，否则互认失效。
 */
(function (global) {
    'use strict';

    var APPS = {
        drive: {
            id: 'drive', seg: 'github_drive', name: 'GitHub Drive', icon: '📁',
            tokenKey: 'github_drive_token', userKey: 'github_drive_user'
        },
        cangshu: {
            id: 'cangshu', seg: 'cangshu', name: '仓鼠', icon: '🐹',
            tokenKey: 'cangshu.token', userKey: 'cangshu.user'
        },
        facehub: {
            id: 'facehub', seg: 'FaceHub', name: 'FaceHub', icon: '💬',
            tokenKey: 'facehub.token', userKey: 'facehub.user'
        }
    };

    function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (e) {} }

    var Bridge = {
        APPS: APPS,

        /** 当前应用（按 URL 第一段判断） */
        current: function () {
            var seg = (global.location.pathname || '/').split('/').filter(Boolean)[0] || '';
            for (var k in APPS) {
                if (APPS[k].seg.toLowerCase() === seg.toLowerCase()) return APPS[k];
            }
            return null;
        },

        /**
         * 找任意一个已登录的"别的应用"
         *
         * ★ 与两应用版的区别：现在有三个应用，
         *   要按"已登录"过滤，而不是简单取 other()。
         *   否则 Drive 和仓鼠都没登录时，提示会指向一个空的应用。
         *
         * @returns {null|{app, token, user}}
         */
        findLoggedInOther: function () {
            var cur = this.current();
            for (var k in APPS) {
                var a = APPS[k];
                if (cur && a.id === cur.id) continue;
                var t = lsGet(a.tokenKey);
                if (t && /^(ghp_|github_pat_)/.test(t)) {
                    var u = null;
                    try { u = JSON.parse(lsGet(a.userKey) || 'null'); } catch (e) { u = null; }
                    return { app: a, token: t, user: u };
                }
            }
            return null;
        },

        /** 找任意可用令牌（优先自己，其次别人） */
        findToken: function (preferSelf) {
            var cur = this.current();
            var order = [];
            if (preferSelf !== false && cur) order.push(cur.tokenKey);
            for (var k in APPS) if (order.indexOf(APPS[k].tokenKey) < 0) order.push(APPS[k].tokenKey);
            for (var i = 0; i < order.length; i++) {
                var v = lsGet(order[i]);
                if (v && /^(ghp_|github_pat_)/.test(v)) return v;
            }
            return null;
        },

        /** 把令牌写到所有应用，让三边都变成已登录 */
        saveToken: function (token, user) {
            for (var k in APPS) {
                lsSet(APPS[k].tokenKey, token);
                if (user) lsSet(APPS[k].userKey, JSON.stringify(user));
            }
        },

        /** 跳转到另一个应用 */
        go: function (seg, params) {
            var p = params || {};
            var qs = Object.keys(p)
                .filter(function (k) { return p[k] !== undefined && p[k] !== null && p[k] !== ''; })
                .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); })
                .join('&');
            var u = global.location.origin + '/' + seg + '/';
            global.location.href = u + (qs ? '?' + qs : '');
            return true;
        }
    };

    global.Bridge = Bridge;
})(typeof window !== 'undefined' ? window : globalThis);
