/**
 * 小程序（MiniApp）
 *
 * 把同域的 Pages 应用当成"小程序"嵌进 FaceHub —— 类似微信底部那个位置。
 *
 * ★ 为什么能直接 iframe：
 *   github_drive / cangshu / FaceHub 都在 cool-zimo.github.io，
 *   localStorage 同源共享，令牌互认。所以嵌进来的应用**已经是登录状态**，
 *   不用再输一次 token。这是这套东西能成立的前提。
 *
 * 识别规则（满足其一即小程序）：
 *   1. 仓库名以 fhapp- 开头
 *   2. 仓库带 topic: facehub-app
 *   3. 根目录有 fhapp.json 描述文件
 *
 * fhapp.json：
 *   { "name": "显示名", "icon": "https://…/icon.png", "desc": "一句话" }
 *   没有就用仓库名兜底 —— 第三方作者不一定愿意多写个文件。
 */
(function (global) {

    var MiniApp = {

        PREFIX: 'fhapp-',
        TOPIC: 'facehub-app',

        /** 内置应用：这三个同源，天然可嵌 */
        BUILTIN: [
            {
                id: 'builtin-drive',
                owner: 'Cool-zimo',
                repo: 'github_drive',
                name: 'GitHub Drive',
                desc: '基于 GitHub 的虚拟文件系统',
                builtin: true
            },
            {
                id: 'builtin-cangshu',
                owner: 'Cool-zimo',
                repo: 'cangshu',
                name: '仓鼠',
                desc: '书签与配置同步',
                builtin: true
            }
        ],

        /** 入口地址 */
        url(app) {
            return 'https://' + app.owner + '.github.io/' + app.repo + '/';
        },

        // ── 历史记录 ─────────────────────────────────────
        _hk() {
            var me = (global.Store && Store.me && Store.me.login) || 'anon';
            return 'fh:minihist:' + me;
        },

        history() {
            try {
                var raw = global.localStorage.getItem(this._hk());
                var d = raw ? JSON.parse(raw) : [];
                return Array.isArray(d) ? d : [];
            } catch (e) { return []; }
        },

        /** 记一次使用。同一应用只保留最近一次，列表按时间倒序 */
        record(app) {
            try {
                var list = this.history().filter(function (x) {
                    return x.id !== app.id;
                });
                list.unshift({
                    id: app.id, owner: app.owner, repo: app.repo,
                    name: app.name, desc: app.desc || '',
                    icon: app.icon || '', builtin: !!app.builtin,
                    ts: Date.now()
                });
                // 只留 20 条，别把 localStorage 撑爆
                global.localStorage.setItem(this._hk(),
                    JSON.stringify(list.slice(0, 20)));
            } catch (e) { /* 配额满 */ }
        },

        removeHistory(id) {
            try {
                var list = this.history().filter(function (x) { return x.id !== id; });
                global.localStorage.setItem(this._hk(), JSON.stringify(list));
            } catch (e) { /* 忽略 */ }
        },

        // ── 发现 ─────────────────────────────────────────
        /**
         * 列出"我的小程序"
         *
         * 内置 + 自己仓库里 fhapp- 开头的。
         * 只查自己账号 —— 别人的仓库要能列出来得靠搜索（限流 30/分钟）。
         */
        async mine(login) {
            var self = this;
            var out = this.BUILTIN.slice();

            try {
                var repos = await global.API.req(
                    '/users/' + encodeURIComponent(login) + '/repos?per_page=100&sort=updated');
                var list = (repos.data || []).filter(function (r) {
                    return r.name.indexOf(self.PREFIX) === 0;
                });
                var apps = await Promise.all(list.map(function (r) {
                    return self._fromRepo(r.owner.login, r.name, r.description || '');
                }));
                apps.forEach(function (a) { if (a) out.push(a); });
            } catch (e) { /* 失败就只有内置 */ }

            return out;
        },

        /** 读仓库里的 fhapp.json（没有也能用，用仓库名兜底） */
        async _fromRepo(owner, repo, desc) {
            var app = {
                id: owner + '/' + repo,
                owner: owner, repo: repo,
                name: repo.replace(/^fhapp-/, ''),
                desc: desc || ''
            };
            try {
                var raw = await global.API.readFile(owner, repo, 'fhapp.json', 'main', false);
                if (raw) {
                    var d = JSON.parse(raw);
                    if (d.name) app.name = d.name;
                    if (d.icon) app.icon = d.icon;
                    if (d.desc) app.desc = d.desc;
                }
            } catch (e) { /* 没有描述文件很正常 */ }
            return app;
        },

        /**
         * 搜索小程序
         *
         * 用 GitHub 的仓库搜索（30/分钟），按 fhapp- 前缀匹配。
         * 这是唯一能发现别人小程序的途径。
         */
        async search(q) {
            var query = (q ? q + ' ' : '') + this.PREFIX + ' in:name';
            try {
                var r = await global.API.req('/search/repositories?q=' +
                    encodeURIComponent(query) + '&per_page=20&sort=updated');
                var items = r.data && r.data.items ? r.data.items : [];
                return items.map(function (it) {
                    return {
                        id: it.owner.login + '/' + it.name,
                        owner: it.owner.login,
                        repo: it.name,
                        name: it.name.replace(/^fhapp-/, ''),
                        desc: it.description || '',
                        stars: it.stargazers_count || 0
                    };
                });
            } catch (e) {
                throw new Error('搜索失败（限流 30/分钟）：' + (e.message || e));
            }
        },

        /** 按 owner/repo 直接添加（也用于"识别"任意仓库） */
        async resolve(owner, repo) {
            try {
                var r = await global.API.req('/repos/' +
                    encodeURIComponent(owner) + '/' + encodeURIComponent(repo));
                return await this._fromRepo(owner, repo,
                    (r.data && r.data.description) || '');
            } catch (e) {
                if (e.status === 404) throw new Error('仓库不存在或是私有的');
                throw e;
            }
        },

        /**
         * 判断一个仓库"像不像"小程序
         * 用于自动识别 —— 不一定是 fhapp- 开头，有 fhapp.json 也算
         */
        async looksLikeApp(owner, repo) {
            if (repo.indexOf(this.PREFIX) === 0) return true;
            try {
                await global.API.readFile(owner, repo, 'fhapp.json', 'main', false);
                return true;
            } catch (e) { return false; }
        }
    };

    global.MiniApp = MiniApp;
})(typeof window !== 'undefined' ? window : this);
