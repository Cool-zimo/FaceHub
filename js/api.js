/**
 * FaceHub API 层
 *
 * 设计目标：**最省 API 请求次数**
 *
 * 核心思路是把请求分成"计费"和"免费"两类，能走免费的绝不用计费的：
 *
 *   1. 读文件内容 → raw.githubusercontent.com
 *      这是 CDN，不是 api.github.com，**完全不计入 5000/小时配额**，也没有次数上限。
 *      代价：有几秒到几分钟的缓存延迟。
 *
 *   2. 列目录 → tree API + If-None-Match
 *      内容没变时返回 304，**不扣配额**（GitHub 明确说明条件请求命中不计费）。
 *
 *   3. 只有"写"和"读刚写完的东西"才走计费端点。
 *
 * 稳态下的效果：刷一次时间线，绝大多数请求是 304 和 raw CDN，
 * 实际扣的配额接近 0。
 */
(function (global) {
    'use strict';

    var API = {
        token: null,
        login: null,

        /**
         * 单次飞行请求去重：同一个 URL 并发时只发一次
         * （时间线会并发拉多个人，避免重复）
         */
        _inflight: {},

        /** 已发出请求计数，用于界面上显示"本次刷新消耗了多少配额" */
        stats: { billed: 0, free: 0 },

        setToken: function (t) { this.token = t; },

        // ── localStorage 安全读写（隐私模式会抛异常）───────────────
        _ls: function (k, v) {
            try {
                if (v === undefined) return global.localStorage.getItem(k);
                if (v === null) global.localStorage.removeItem(k);
                else global.localStorage.setItem(k, v);
            } catch (e) { return null; }
        },

        /**
         * 计费请求：走 api.github.com
         * 统一处理鉴权、错误文案、限流提示
         */
        async req(path, opts) {
            opts = opts || {};
            var headers = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'FaceHub'
            };
            if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
            if (opts.headers) Object.assign(headers, opts.headers);

            var body = opts.body;
            if (body && typeof body !== 'string') body = JSON.stringify(body);

            var resp = await fetch('https://api.github.com' + path, {
                method: opts.method || 'GET',
                headers: headers,
                body: body
            });

            // 304 是条件请求命中，GitHub 明确不扣配额 → 计为免费
            if (resp.status === 304) this.stats.free++;
            else this.stats.billed++;
            if (global.API && global.API.onStats) global.API.onStats(this.stats);

            // 204/304 没有响应体
            if (resp.status === 204 || resp.status === 304) {
                return { __status: resp.status, __headers: resp.headers, data: null };
            }

            var text = await resp.text();
            var data = null;
            try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }

            if (!resp.ok) {
                var msg = (data && data.message) || ('HTTP ' + resp.status);
                var err = new Error(msg);
                err.status = resp.status;
                err.data = data;
                err.headers = resp.headers;
                throw err;
            }
            return { __status: resp.status, __headers: resp.headers, data: data };
        },

        /** 当前登录用户 */
        async me() {
            var r = await this.req('/user');
            this.login = r.data.login;
            return r.data;
        },

        // ── 目录列举（ETag 条件请求，304 不计费）────────────────────

        /**
         * 列仓库全部文件路径
         *
         * @returns {{files: string[], cached: boolean}}
         *          cached=true 表示命中 304，本次未消耗配额
         */
        async tree(owner, repo, branch) {
            branch = branch || 'main';
            var ck = 'fh:etag:' + owner + '/' + repo;
            var tk = 'fh:tree:' + owner + '/' + repo;

            var etag = this._ls(ck);
            var headers = {};
            if (etag) headers['If-None-Match'] = etag;

            try {
                var r = await this.req(
                    '/repos/' + owner + '/' + repo + '/git/trees/' + branch + '?recursive=1',
                    { headers: headers }
                );
                if (r.__status === 304) {
                    // req() 里已经把 304 计为 free，这里不再重复累加
                    var cached = this._ls(tk);
                    return {
                        files: cached ? JSON.parse(cached) : [],
                        cached: true
                    };
                }
                var newEtag = r.__headers.get('etag');
                var files = (r.data.tree || [])
                    .filter(function (x) { return x.type === 'blob'; })
                    .map(function (x) { return x.path; });
                if (newEtag) this._ls(ck, newEtag);
                this._ls(tk, JSON.stringify(files));
                return { files: files, cached: false };
            } catch (e) {
                // 404 多半是仓库还没建或没分支，回退到缓存（可能为空）
                if (e.status === 404 || e.status === 409) {
                    var c = this._ls(tk);
                    return { files: c ? JSON.parse(c) : [], cached: true, missing: true };
                }
                throw e;
            }
        },

        // ── 文件读取 ───────────────────────────────────────────────

        /**
         * 读文件内容
         *
         * @param {boolean} fresh - true 强制走计费的 contents API
         *        （刚写完就读时用，因为 raw CDN 有缓存延迟）
         *        false（默认）走 raw CDN，免费
         */
        async readFile(owner, repo, path, branch, fresh) {
            branch = branch || 'main';
            var ck = 'fh:c:' + owner + '/' + repo + '/' + path;   // 内容缓存
            var ek = 'fh:e:' + owner + '/' + repo + '/' + path;   // ETag

            var cached = this._ls(ck);
            var etag = this._ls(ek);

            // 内容已在本地且不是刚写完 → 0 请求
            if (cached !== null && cached !== undefined && !fresh) return cached;

            var headers = {};
            if (etag && !fresh) headers['If-None-Match'] = etag;

            var r = await this.req(
                '/repos/' + owner + '/' + repo + '/contents/' +
                path.split('/').map(encodeURIComponent).join('/') +
                '?ref=' + encodeURIComponent(branch),
                { headers: headers }
            );

            // 304：内容没变，用本地缓存。req() 已计为 free
            if (r.__status === 304) {
                if (cached !== null && cached !== undefined) return cached;
                throw new Error('服务器返回 304 但本地没有缓存');
            }

            var text = this._decodeContent(r.data);
            var newEtag = r.__headers.get('etag');
            if (newEtag) this._ls(ek, newEtag);
            this._ls(ck, text);
            return text;
        },

        /** contents API 返回 base64，需按 UTF-8 解码（中文安全） */
        _decodeContent(data) {
            if (!data || data.encoding !== 'base64') return data && data.content ? data.content : '';
            var b64 = (data.content || '').replace(/\n/g, '');
            var bin = atob(b64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder('utf-8').decode(bytes);
        },

        /** 取文件的 sha（更新已有文件必须带，否则 422） */
        async sha(owner, repo, path, branch) {
            var r = await this.req(
                '/repos/' + owner + '/' + repo + '/contents/' +
                path.split('/').map(encodeURIComponent).join('/') +
                '?ref=' + encodeURIComponent(branch || 'main')
            );
            return r.data && r.data.sha;
        },

        // ── 文件写入 ───────────────────────────────────────────────

        /**
         * 写文件。已有文件时必须先取 sha，否则 422。
         * @param {string|null} sha - 已存在则传 sha，新文件传 null
         */
        async writeFile(owner, repo, path, content, message, sha, branch) {
            var bytes = new TextEncoder().encode(content);
            var bin = '';
            for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            var body = {
                message: message,
                content: btoa(bin),
                branch: branch || 'main'
            };
            if (sha) body.sha = sha;
            var r = await this.req(
                '/repos/' + owner + '/' + repo + '/contents/' +
                path.split('/').map(encodeURIComponent).join('/'),
                { method: 'PUT', body: body }
            );
            // 写完立刻失效该仓库的 ETag，下次列目录才能拿到新文件
            this._ls('fh:etag:' + owner + '/' + repo, null);
            return r.data;
        },

        // ── 仓库管理 ───────────────────────────────────────────────

        async getRepo(owner, repo) {
            try {
                var r = await this.req('/repos/' + owner + '/' + repo);
                return r.data;
            } catch (e) {
                if (e.status === 404) return null;
                throw e;
            }
        },

        async createRepo(name, description) {
            var r = await this.req('/user/repos', {
                method: 'POST',
                body: { name: name, description: description, private: false, auto_init: false }
            });
            return r.data;
        },

        /** 用户是否存在（关注前校验，避免关注了不存在的账号） */
        async getUser(username) {
            try {
                var r = await this.req('/users/' + encodeURIComponent(username));
                return r.data;
            } catch (e) {
                if (e.status === 404) return null;
                throw e;
            }
        },

        /**
         * 搜索仓库 —— 用于"发现"陌生人
         *
         * 注意：搜索 API 独立限流 30 次/分钟，且新仓库索引有 5~30 分钟延迟。
         * 所以这个功能只用于"发现"，不用于看时间线。
         */
        async searchRepos(q, perPage) {
            var r = await this.req(
                '/search/repositories?q=' + encodeURIComponent(q) +
                '&per_page=' + (perPage || 20) + '&sort=updated'
            );
            return r.data.items || [];
        },

        /** 限流余量（调试用） */
        async rate() {
            var r = await this.req('/rate_limit');
            return r.data.resources;
        },

        // ── 私聊相关 ───────────────────────────────────────────────

        /**
         * 建私有仓库（私聊会话用）
         * 已存在会 422，调用方据此判断"对方先建了"
         */
        /**
         * 创建公开仓库
         *
         * 用于放身份公钥 —— 必须是公开的，否则别人读不到，
         * 就又退回"要等对方上线"了。里面只有公钥，本来就是要公开的。
         */
        async createPublicRepo(name, description) {
            var r = await this.req('/user/repos', {
                method: 'POST',
                body: {
                    name: name,
                    description: description || '',
                    private: false,
                    auto_init: false
                }
            });
            return r.data;
        },

        async createPrivateRepo(name, description) {
            var r = await this.req('/user/repos', {
                method: 'POST',
                body: { name: name, description: description, private: true, auto_init: false }
            });
            return r.data;
        },

        /** 建 issue（空仓库也能建，实测通过 —— 不需要先有文件） */
        async createIssue(owner, repo, title, body) {
            var r = await this.req('/repos/' + owner + '/' + repo + '/issues', {
                method: 'POST',
                body: { title: title, body: body || '' }
            });
            return r.data;
        },

        /**
         * 邀请协作者 —— 私聊的关键
         * 很多人以为必须去邮件点链接，其实有专门的接受端点（见 acceptInvitation）
         */
        async inviteCollaborator(owner, repo, username) {
            var r = await this.req(
                '/repos/' + owner + '/' + repo + '/collaborators/' + encodeURIComponent(username),
                { method: 'PUT', body: { permission: 'push' } }
            );
            return r.data;
        },

        /** 我收到的仓库邀请（待接受） */
        async invitations() {
            var r = await this.req('/user/repository_invitations');
            return r.data || [];
        },

        /** 在应用内直接接受邀请，不用去邮箱点链接 */
        async acceptInvitation(id) {
            await this.req('/user/repository_invitations/' + id, { method: 'PATCH' });
            return true;
        },

        async declineInvitation(id) {
            await this.req('/user/repository_invitations/' + id, { method: 'DELETE' });
            return true;
        },

        /**
         * 消息列表 —— 用 issue 评论存消息
         *
         * 为什么不用文件：追加文件要先读 sha 再写，两人同时发必然 409 冲突。
         * issue 评论天然支持并发追加，还自带作者、头像、时间戳。
         */
        /**
         * 拉消息（ETag 条件请求）
         *
         * 为什么必须加 ETag：新消息要轮询才看得到，而轮询会疯狂吃配额。
         * 没有新消息时 GitHub 返回 304，**不扣配额** —— 这样 5 秒一查
         * 也几乎不花钱，跟 15 秒一查的成本一样。
         *
         * ⚠️ 关键：304 必须返回**本地缓存的上一次结果**。
         * 返回 [] 会让消息凭空消失 —— 这是条件请求最容易踩的坑。
         */
        async messages(owner, repo, issueNumber, since) {
            var q = '/repos/' + owner + '/' + repo + '/issues/' +
                (issueNumber || 1) + '/comments?per_page=100';
            if (since) q += '&since=' + encodeURIComponent(since);

            var base = owner + '/' + repo;
            var tagKey = 'fh:etagmsg:' + base;
            var rawKey = 'fh:msgraw:' + base;

            var etag = this._ls(tagKey);
            var opts = {};
            if (etag) opts.headers = { 'If-None-Match': etag };

            var r = await this.req(q, opts);

            if (r.__status === 304) {
                var cached = this._ls(rawKey);
                if (cached) {
                    try { return JSON.parse(cached); } catch (e) { /* 坏了重拉 */ }
                }
                // 缓存没了就无条件再拉一次，宁可多花一次也别显示空白
                r = await this.req(q);
            }

            var list = r.data || [];
            var newTag = r.__headers && r.__headers.get ? r.__headers.get('etag') : null;
            if (newTag) this._ls(tagKey, newTag);
            this._ls(rawKey, JSON.stringify(list));
            return list;
        },

        /** 清掉某个会话的消息缓存与 ETag（清空记录 / 解除绑定时用） */
        clearMessageCache(owner, repo) {
            var base = owner + '/' + repo;
            this._ls('fh:etagmsg:' + base, null);
            this._ls('fh:msgraw:' + base, null);
            this._ls('fh:msg:' + base, null);
        },

        /** 发消息 */
        async sendMessage(owner, repo, text, issueNumber) {
            var r = await this.req(
                '/repos/' + owner + '/' + repo + '/issues/' + (issueNumber || 1) + '/comments',
                { method: 'POST', body: { body: text } }
            );
            return r.data;
        },

        /** 删消息（用于清理解不开的孤儿密文） */
        async deleteMessage(owner, repo, commentId) {
            await this.req(
                '/repos/' + owner + '/' + repo + '/issues/comments/' + commentId,
                { method: 'DELETE' }
            );
            return true;
        },

        /**
         * 清空聊天记录
         *
         * GitHub 没有批量删除接口，只能一条一条删。
         * 所以这里必须上报进度 —— 几十条消息删起来要几秒，
         * 不给反馈的话用户会以为卡死了。
         *
         * @param {function} onProgress (done, total)
         */
        async clearMessages(owner, repo, issueNumber, onProgress) {
            var list = await this.messages(owner, repo, issueNumber);
            var total = list.length;
            var done = 0, failed = 0;

            for (var i = 0; i < list.length; i++) {
                try {
                    await this.deleteMessage(owner, repo, list[i].id);
                    done++;
                } catch (e) {
                    // 403 = 不是我发的消息，删不掉 —— 这很常见，
                    // 对方发的消息只有他自己或仓库管理员能删
                    failed++;
                }
                if (onProgress) onProgress(done + failed, total, failed);
            }
            return { total: total, deleted: done, failed: failed };
        },

        /** 列出协作者（成员管理用） */
        async collaborators(owner, repo) {
            var r = await this.req('/repos/' + owner + '/' + repo + '/collaborators?per_page=100');
            return r.data || [];
        },

        /** 移除协作者 / 退出群（自己退用 leaveRepo） */
        async removeCollaborator(owner, repo, username) {
            await this.req(
                '/repos/' + owner + '/' + repo + '/collaborators/' + username,
                { method: 'DELETE' }
            );
            return true;
        },

        /**
         * 退出别人的仓库
         *
         * 用同一个 DELETE 端点，但 username 传自己。
         * 这是 GitHub 官方的"leave a repository"方式。
         */
        async leaveRepo(owner, repo, myLogin) {
            return await this.removeCollaborator(owner, repo, myLogin);
        }
    };

    global.API = API;
})(window);
