/**
 * FaceHub 数据层
 *
 * 存储布局 —— 每个用户一个"主页仓库"，而不是每帖一个仓库：
 *
 *   facehub-{login}/
 *     profile.json          昵称、简介、头像
 *     following.json        关注列表
 *     posts/
 *       1800000000-a3f9.json   ← 文件名自带时间戳，列目录天然有序
 *
 * 为什么不用"每帖一个仓库"：
 *   · 发一帖要 建仓 + 写文件 ≈ 3 次内容创建请求
 *     （内容创建限流是 80/分钟、500/小时，很快撞墙）
 *   · 新仓库要 5~30 分钟才进搜索索引，发完自己都搜不到
 *   改成写自己仓库的一个文件后：1 次请求，且立即可见。
 *
 * 为什么不维护索引文件（如 index.json）：
 *   每次发帖还要额外更新一次索引 = 双倍写请求。
 *   用 tree?recursive=1 递归列目录即可，省掉这次写入。
 */
(function (global) {
    'use strict';

    var API = global.API;

    var Store = {
        me: null,          // 当前用户 {login, avatar_url, name}
        homeRepo: null,    // 主页仓库名
        branch: 'main',    // 实际默认分支（账号设置可能是 master）
        profile: null,
        following: [],

        /** 主页仓库名（GitHub 仓库名不区分大小写，统一小写） */
        repoOf: function (login) {
            return 'facehub-' + String(login).toLowerCase();
        },

        /**
         * 初始化：确认主页仓库存在，没有就创建
         *
         * 顺序很关键：先建仓（auto_init 让它有默认分支），
         * 再读一次拿真实的 default_branch —— 不能硬编码 main，
         * 有些账号默认分支是 master。
         */
        async init(me) {
            this.me = me;
            this.homeRepo = this.repoOf(me.login);

            var repo = await API.getRepo(me.login, this.homeRepo);
            if (!repo) {
                repo = await API.createRepo(
                    this.homeRepo,
                    me.login + ' 的 FaceHub 主页'
                );
                // 新仓库可能还没就绪，短暂等待
                await new Promise(function (r) { setTimeout(r, 1200); });
                repo = await API.getRepo(me.login, this.homeRepo) || repo;
            }
            this.branch = repo.default_branch || 'main';

            // profile 和 following 可以并发读（各 1 次请求）
            var self = this;
            var p = this.loadProfile(me.login).catch(function () { return null; });
            var f = this.loadFollowing(me.login).catch(function () { return []; });
            this.profile = await p;
            this.following = await f;

            // 首次使用：写一份默认 profile
            if (!this.profile) {
                this.profile = {
                    login: me.login,
                    name: me.name || me.login,
                    bio: '',
                    avatar: me.avatar_url || '',
                    createdAt: Date.now()
                };
                await this.saveProfile(this.profile);
            }
            return this;
        },

        // ── profile ────────────────────────────────────────────────

        async loadProfile(login) {
            var repo = this.repoOf(login);
            var owner = login;
            try {
                var txt = await API.readFile(owner, repo, 'profile.json', this.branch);
                return JSON.parse(txt);
            } catch (e) {
                return null;
            }
        },

        async saveProfile(profile) {
            this.profile = profile;
            var path = 'profile.json';
            var sha = null;
            try { sha = await API.sha(this.me.login, this.homeRepo, path, this.branch); }
            catch (e) { sha = null; }
            await API.writeFile(
                this.me.login, this.homeRepo, path,
                JSON.stringify(profile, null, 2),
                '更新资料', sha, this.branch
            );
            return profile;
        },

        // ── following ──────────────────────────────────────────────

        async loadFollowing(login) {
            var owner = login || this.me.login;
            var repo = this.repoOf(owner);
            try {
                var txt = await API.readFile(owner, repo, 'following.json', this.branch);
                var d = JSON.parse(txt);
                return Array.isArray(d) ? d : (d.following || []);
            } catch (e) {
                return [];
            }
        },

        async saveFollowing(list) {
            this.following = list;
            var path = 'following.json';
            var sha = null;
            try { sha = await API.sha(this.me.login, this.homeRepo, path, this.branch); }
            catch (e) { sha = null; }
            await API.writeFile(
                this.me.login, this.homeRepo, path,
                JSON.stringify(list, null, 2),
                '更新关注', sha, this.branch
            );
            return list;
        },

        async follow(login) {
            if (this.following.indexOf(login) >= 0) return this.following;
            // 校验账号存在，避免关注了空账号导致时间线一直 404
            var u = await API.getUser(login);
            if (!u) throw new Error('用户 ' + login + ' 不存在');
            this.following.push(login);
            return await this.saveFollowing(this.following);
        },

        async unfollow(login) {
            this.following = this.following.filter(function (x) { return x !== login; });
            return await this.saveFollowing(this.following);
        },

        // ── 帖子 ───────────────────────────────────────────────────

        /**
         * 发帖：只写 1 个文件 = 1 次内容创建请求
         * 文件名 posts/{ts}-{rand}.json，时间戳保证排序、rand 防止同秒冲突
         */
        async publish(text) {
            var ts = Date.now();
            var rand = Math.random().toString(36).slice(2, 6);
            var id = ts + '-' + rand;
            var post = {
                id: id,
                text: text,
                ts: ts,
                author: this.me.login,
                name: (this.profile && this.profile.name) || this.me.login,
                avatar: (this.profile && this.profile.avatar) || this.me.avatar_url
            };
            await API.writeFile(
                this.me.login, this.homeRepo,
                'posts/' + id + '.json',
                JSON.stringify(post),
                '发布：' + text.slice(0, 30)
            );
            return post;
        },

        /**
         * 列某人的帖子文件名（不读内容！）
         *
         * 这是省请求的关键一步：先用 tree（可命中 304，免费）
         * 拿到文件名列表，文件名里有时间戳，排序后再决定读哪些。
         * 绝不"先把所有内容都拉下来再排序"。
         *
         * @returns {{names: string[], cached: boolean}}
         */
        async listPostNames(login) {
            var r = await API.tree(login, this.repoOf(login), this.branch);
            var names = r.files
                .filter(function (p) { return /^posts\/.*\.json$/.test(p); })
                .map(function (p) { return p.replace(/^posts\//, '').replace(/\.json$/, ''); })
                .sort()
                .reverse();   // 时间戳大的在前 → 最新在前
            return { names: names, cached: r.cached };
        },

        /** 自己刚发的帖用 fresh=true 读（raw CDN 还没缓存） */
        async readPost(login, name, fresh) {
            var txt = await API.readFile(
                login, this.repoOf(login),
                'posts/' + name + '.json',
                this.branch, fresh
            );
            try { return JSON.parse(txt); } catch (e) { return null; }
        },

        /** 从文件名解析时间戳（不用读内容就知道谁新） */
        tsOf: function (name) {
            var m = /^(\d+)-/.exec(name);
            return m ? parseInt(m[1], 10) : 0;
        }
    };

    global.Store = Store;
})(window);
