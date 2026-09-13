/**
 * FaceHub 时间线聚合
 *
 * 这是整个应用最讲究"省"的地方。朴素做法会把请求打爆：
 *   关注 50 人 × 每人 100 帖 × 读内容 = 5000 次请求，一小时配额直接见底。
 *
 * 本实现的算法：
 *
 *   ① 列目录（tree + ETag）
 *      → 没新帖就 304，**不扣配额**
 *   ② 每人只取最新 perUser 个文件名
 *      → 老帖根本不读，请求数与总帖数无关，只与"关注人数"有关
 *   ③ 用文件名里的时间戳全局排序
 *      → 不读内容就知道谁新谁旧
 *   ④ 只给最终要显示的 limit 条读内容
 *      → 且走 raw CDN，**免费**
 *   ⑤ 读过的帖子内容永久缓存
 *      → 二次打开 0 请求
 *
 * 稳态成本：刷一次时间线 ≈ 关注人数 × (1 次 tree，多数是 304 免费)
 *            + 少量新帖走 raw CDN（免费）
 *            → 实际扣的配额接近 0
 */
(function (global) {
    'use strict';

    var API = global.API;
    var Store = global.Store;

    var Timeline = {
        /** 每个人最多取几帖（防止某个人刷屏霸占整条时间线） */
        perUser: 5,

        /**
         * 加载时间线
         * @param {number} limit - 最终显示多少条
         * @param {Function} onProgress - 进度回调
         */
        async load(limit, onProgress) {
            limit = limit || 30;
            var users = [Store.me.login].concat(Store.following);
            var total = users.length;
            var done = 0;

            var self = this;

            // ① 并发列目录（带 ETag，304 免费）
            //    失败的用户不能让整条时间线挂掉，所以单独 catch
            var lists = await Promise.all(users.map(function (u) {
                return Store.listPostNames(u)
                    .then(function (r) {
                        done++;
                        if (onProgress) onProgress(done, total, u, r.cached);
                        return { login: u, names: r.names, cached: r.cached };
                    })
                    .catch(function (e) {
                        done++;
                        if (onProgress) onProgress(done, total, u, true);
                        return { login: u, names: [], error: e.message };
                    });
            }));

            // ② 每人取最新 perUser 个 → ③ 用文件名时间戳排序
            var picked = [];
            lists.forEach(function (l) {
                l.names.slice(0, self.perUser).forEach(function (n) {
                    picked.push({ login: l.login, name: n, ts: Store.tsOf(n) });
                });
            });
            picked.sort(function (a, b) { return b.ts - a.ts; });
            picked = picked.slice(0, limit);

            // ④ 只读最终要显示的那些内容
            var posts = await Promise.all(picked.map(function (p) {
                return self._readCached(p.login, p.name).then(function (post) {
                    return post;
                }).catch(function () { return null; });
            }));

            return posts.filter(Boolean);
        },

        /**
         * 读帖子内容，优先本地缓存
         *
         * 缓存命中 → 0 请求
         * 未命中   → raw CDN（免费），失败才回落到计费的 contents API
         */
        async _readCached(login, name) {
            var key = 'fh:post:' + login + '/' + name;
            var cached = API._ls(key);
            if (cached) {
                try {
                    var p = JSON.parse(cached);
                    // 补全字段（旧缓存可能缺 avatar）
                    if (!p.login) p.login = login;
                    return p;
                } catch (e) { /* 缓存坏了，重新拉 */ }
            }
            var post = await Store.readPost(login, name);
            if (post) {
                post.login = login;
                try { API._ls(key, JSON.stringify(post)); } catch (e) { /* 超配额就跳过缓存 */ }
            }
            return post;
        },

        /** 载入某一个人的帖子（个人主页用） */
        async loadUser(login, limit) {
            limit = limit || 30;
            var r = await Store.listPostNames(login);
            var picked = r.names.slice(0, limit);
            var self = this;
            var posts = await Promise.all(picked.map(function (n) {
                return self._readCached(login, n).catch(function () { return null; });
            }));
            return posts.filter(Boolean);
        },

        /** 清掉某人的目录缓存（关注/取关后需要） */
        invalidate(login) {
            API._ls('fh:etag:' + login + '/' + Store.repoOf(login), null);
        }
    };

    global.Timeline = Timeline;
})(window);
