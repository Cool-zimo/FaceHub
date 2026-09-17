/**
 * 朋友圈（Moments）
 *
 * 存储：复用身份仓库 facehub-{login}（公开的那个，跟公钥在一起）。
 * 朋友圈本来就是公开的，正好不用另建仓库。
 *
 *   posts/{ts}-{rand}.json               帖子正文 + 图片引用
 *   m/{ts}-{rand}.{ext}                  图片本体
 *   likes/{postId}/{login}.json          点赞
 *   comments/{postId}/{ts}-{login}.json  评论
 *   following.json                       关注列表
 *
 * ★ 为什么点赞/评论是"每人一个文件"而不是一个共享文件：
 * 共享文件要先读 sha 再写，两个人同时点赞必然 409。
 * 一人一文件则各自写各自的，永不冲突，也不需要 sha。
 * 读取时列目录即可拿到全部 —— 和私聊用 issue 评论是同一个思路。
 *
 * 不加密：朋友圈是公开发布的内容，加密没有意义（公钥谁都能拿到），
 * 只会白白增加体积和复杂度。
 */
(function (global) {

    var Moments = {

        /** 每页条数 */
        PAGE: 15,

        // ── 仓库 ─────────────────────────────────────────
        /** 朋友圈仓库名 */
        repoName: function (login) {
            return 'facehub-' + login.toLowerCase();
        },

        /** 确保自己的朋友圈仓库存在 */
        async ensureRepo(login) {
            var name = this.repoName(login);
            try {
                await global.API.getRepo(login, name);
                return name;
            } catch (e) {
                if (e && e.status !== 404) throw e;
                await global.API.createRepo(name, login + ' 的朋友圈');
                return name;
            }
        },

        // ── 发帖 ─────────────────────────────────────────
        /**
         * 发一条朋友圈
         * @param {string} text 正文
         * @param {Array} images 已上传的附件列表（可选）
         */
        async publish(login, text, images) {
            var repo = await this.ensureRepo(login);
            var ts = Date.now();
            var id = ts + '-' + Math.random().toString(36).slice(2, 7);

            var post = {
                id: id,
                text: String(text || ''),
                ts: ts,
                images: (images || []).map(function (a) {
                    return { p: a.p || a.path, n: a.n || a.name, t: a.t || a.type, s: a.s || a.size };
                })
            };

            await global.API.writeFile(login, repo,
                'posts/' + id + '.json',
                JSON.stringify(post),
                '朋友圈：' + (post.text || '图片').slice(0, 30),
                null, 'main');
            return post;
        },

        /** 上传朋友圈图片到 m/ 目录 */
        async uploadImage(login, file) {
            var repo = await this.ensureRepo(login);
            var ready = await global.Attach.compressImage(file);
            var dataUrl = await global.Attach._readAsDataURL(ready);
            var b64 = dataUrl.split(',')[1] || '';

            var d = new Date();
            var p = function (n) { return String(n).padStart(2, '0'); };
            var path = 'm/' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
                '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
                '-' + Math.random().toString(36).slice(2, 7) + '.' +
                ((ready.name || '').split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);

            await global.API.writeFile(login, repo, path, b64,
                '朋友圈图片', null, 'main', true);
            return {
                p: path,
                n: ready.name || '图片',
                t: ready.type || 'image/jpeg',
                s: ready.size,
                dataUrl: dataUrl
            };
        },

        // ── 读取 ─────────────────────────────────────────
        /**
         * 列某人帖子列表（只要文件名，不读内容）
         *
         * 用 git tree 一次拿全部文件名 —— 比 contents API 便宜，
         * 且带 ETag 缓存，二次访问免费。
         */
        async postList(login) {
            var repo = this.repoName(login);
            var files;
            try {
                var t = await global.API.tree(login, repo, 'main');
                files = t.files || t;            // tree 返回 {files:[…]}
            } catch (e) {
                return [];                       // 还没建仓库 = 没有帖子
            }
            return files
                .filter(function (path) { return /^posts\/[^/]+\.json$/.test(path); })
                .map(function (path) {
                    return {
                        login: login, path: path,
                        id: path.replace(/^posts\//, '').replace(/\.json$/, '')
                    };
                })
                .sort(function (a, b) { return a.id < b.id ? 1 : -1; });   // 新的在前
        },

        /**
         * 读帖子内容
         * 内容缓存 + ETag，二次访问 0 配额
         */
        async post(login, path) {
            var repo = this.repoName(login);
            var raw = await global.API.readFile(login, repo, path, 'main', false);
            if (!raw) return null;
            try {
                return JSON.parse(raw);
            } catch (e) {
                return null;
            }
        },

        // ── 关注 ─────────────────────────────────────────
        async following(login) {
            var repo = this.repoName(login);
            try {
                var raw = await global.API.readFile(login, repo, 'following.json', 'main', false);
                if (!raw) return [];
                var d = JSON.parse(raw);
                return Array.isArray(d.list) ? d.list : [];
            } catch (e) {
                return [];
            }
        },

        async follow(login, target) {
            var repo = await this.ensureRepo(login);
            var list = await this.following(login);
            var t = String(target).toLowerCase();
            var exists = list.some(function (x) {
                return String(x).toLowerCase() === t;
            });
            if (exists) return list;

            list.push(target);
            var sha = null;
            try { sha = await global.API.sha(login, repo, 'following.json', 'main'); }
            catch (e) { /* 首次创建没有 sha */ }

            await global.API.writeFile(login, repo, 'following.json',
                JSON.stringify({ list: list }),
                '关注 ' + target, sha, 'main');
            return list;
        },

        async unfollow(login, target) {
            var repo = this.repoName(login);
            var list = await this.following(login);
            var t = String(target).toLowerCase();
            var next = list.filter(function (x) {
                return String(x).toLowerCase() !== t;
            });
            if (next.length === list.length) return list;

            var sha = null;
            try { sha = await global.API.sha(login, repo, 'following.json', 'main'); }
            catch (e) { /* 忽略 */ }

            await global.API.writeFile(login, repo, 'following.json',
                JSON.stringify({ list: next }),
                '取关 ' + target, sha, 'main');
            return next;
        },

        // ── 关系网（自动派生关注） ───────────────────────
        /**
         * 从聊天关系里派生"该看到谁的动态"
         *
         * ★ 为什么要有这个：
         *   手动关注在熟人场景里是多余的 —— 都已经在聊天了，
         *   凭什么还要再点一次"关注"才能看到朋友圈？
         *   微信也没有"关注好友"这个动作。
         *
         * 关系来源：
         *   ① 私聊对象（fbdm- 仓库的 peer）
         *   ② 群成员（fhgrp- 仓库 group.json 的 members[]）
         *
         * 性能：group.json 要逐个读，所以结果缓存 10 分钟。
         * 会话列表本身有 ETag，不会每次都花钱。
         */
        REL_CACHE_MS: 10 * 60 * 1000,
        REL_MAX: 30,          // 关系再多也只取前 30 人，控制请求数

        async relations(login) {
            var self = this;
            var ck = 'fh:rel:' + login;
            var cached = null;
            try {
                var raw = global.localStorage.getItem(ck);
                if (raw) {
                    var d = JSON.parse(raw);
                    if (d && (Date.now() - d.ts) < this.REL_CACHE_MS) {
                        return d.list;
                    }
                    cached = d;      // 过期了但先留着，失败时兜底
                }
            } catch (e) { /* 忽略 */ }

            var out = [];
            var seen = {};
            seen[String(login).toLowerCase()] = 1;

            try {
                var rooms = await global.Chat.listRooms();
                if (!rooms.length) throw new Error('no rooms');

                var peers = [];
                var groups = [];
                rooms.forEach(function (r) {
                    // 用 Group.isGroup 判断，别自己猜前缀
                    var isGrp = global.Group && global.Group.isGroup &&
                        global.Group.isGroup(r.name);
                    if (isGrp) {
                        groups.push(r);
                    } else if (r.peer) {
                        peers.push(r.peer);
                    }
                });

                peers.forEach(function (p) {
                    var k = String(p).toLowerCase();
                    if (!seen[k]) { seen[k] = 1; out.push(p); }
                });

                // 群成员：并发读 group.json（读操作没有 HEAD 冲突）
                var metas = await Promise.all(groups.map(function (g) {
                    return global.Group.meta(g.owner, g.name).catch(function () { return null; });
                }));
                metas.forEach(function (m) {
                    (m && m.members || []).forEach(function (u) {
                        var k = String(u).toLowerCase();
                        if (!seen[k]) { seen[k] = 1; out.push(u); }
                    });
                });

            } catch (e) {
                // 拿不到就退回缓存，再不行就是空 —— 不能因此让朋友圈打不开
                if (cached && cached.list) return cached.list;
                return [];
            }

            out = out.slice(0, this.REL_MAX);

            try {
                global.localStorage.setItem(ck,
                    JSON.stringify({ ts: Date.now(), list: out }));
            } catch (e) { /* 配额满就算了 */ }

            return out;
        },

        /** 手动关注 + 自动关系的并集 */
        async audience(login) {
            var manual = await this.following(login);
            var rel = await this.relations(login);
            var seen = {}, out = [];
            manual.concat(rel).forEach(function (u) {
                var k = String(u).toLowerCase();
                if (seen[k]) return;
                seen[k] = 1;
                out.push(u);
            });
            return out;
        },

        /** 关系变了（加了群/新会话）就调一次 */
        invalidateRelations(login) {
            try { global.localStorage.removeItem('fh:rel:' + login); }
            catch (e) { /* 忽略 */ }
        },

        // ── 时间线 ───────────────────────────────────────
        /**
         * 聚合时间线（自己 + 关注的人 + 有聊天关系的）
         *
         * 请求数只与"关注人数"线性相关，与总帖数无关：
         * 每人一次 tree（带 ETag，二次免费）。
         * 先按文件名（含时间戳）排序，再只取最新的 PAGE 条去读内容 ——
         * 不会为了渲染 15 条去读 500 条。
         */
        async timeline(login, limit) {
            var self = this;
            // 自己 + 手动关注 + 聊天关系（默认全都要）
            var people = [login].concat(await this.audience(login));
            var max = limit || this.PAGE;

            var lists = await Promise.all(people.map(function (p) {
                return self.postList(p).catch(function () { return []; });
            }));

            var all = [];
            lists.forEach(function (l) { all = all.concat(l); });
            all.sort(function (a, b) { return a.id < b.id ? 1 : -1; });

            var picked = all.slice(0, max);
            var posts = await Promise.all(picked.map(function (it) {
                return self.post(it.login, it.path).catch(function () { return null; });
            }));

            return posts.filter(function (p) { return !!p; })
                .map(function (p, i) {
                    // post 里没存作者（省体积），从路径归属补上
                    p.author = picked[i].login;
                    p.key = picked[i].login + '/' + p.id;
                    return p;
                });
        },

        // ── 点赞 ─────────────────────────────────────────
        /** 赞 / 取消赞。一人一文件，永不冲突 */
        async like(owner, postId, login, avatar) {
            var repo = this.repoName(owner);
            var path = 'likes/' + postId + '/' + login.toLowerCase() + '.json';
            var sha = null;
            try {
                sha = await global.API.sha(owner, repo, path, 'main');
            } catch (e) { /* 没点过 */ }

            if (sha) {
                // 已赞 → 取消
                await global.API.req(
                    '/repos/' + owner + '/' + repo + '/contents/' + path,
                    { method: 'DELETE', body: { message: '取消赞', sha: sha, branch: 'main' } });
                global.API._ls('fh:tree:' + owner + '/' + repo, null);
                global.API._ls('fh:etag:' + owner + '/' + repo, null);
                return false;
            }

            await global.API.writeFile(owner, repo, path,
                JSON.stringify({ login: login, avatar: avatar, ts: Date.now() }),
                '赞', null, 'main');
            return true;
        },

        /** 某帖的赞列表 */
        async likes(owner, postId) {
            var repo = this.repoName(owner);
            var prefix = 'likes/' + postId + '/';
            var files;
            try {
                var t = await global.API.tree(owner, repo, 'main');
                files = t.files || t;
            } catch (e) { return []; }

            var names = files
                .filter(function (path) {
                    return path.indexOf(prefix) === 0 && /\.json$/.test(path);
                });

            var out = [];
            for (var i = 0; i < names.length; i++) {
                try {
                    var raw = await global.API.readFile(owner, repo, names[i], 'main', false);
                    if (raw) out.push(JSON.parse(raw));
                } catch (e) { /* 单个坏了跳过 */ }
            }
            return out;
        },

        // ── 评论 ─────────────────────────────────────────
        /**
         * 评论。文件名带时间戳，同一人可评论多条
         *
         * @param {File[]} files 可选，评论配图（微信支持在评论里发图）
         *
         * 图存在评论者**自己的**主页仓库 cm/ 下：
         *   · 不往帖子作者的仓库写 —— 否则你得有对方仓库的写权限，
         *     而评论别人的帖子本来就不该需要
         *   · 存的是路径引用（{p,n,t,s}），不是 base64，
         *     否则一条评论就把 issues/文件 撑爆
         */
        async comment(owner, postId, login, avatar, text, replyTo, files) {
            var repo = this.repoName(owner);
            var ts = Date.now();

            var imgs = [];
            if (files && files.length) {
                for (var i = 0; i < files.length && i < 3; i++) {
                    // 评论图最多 3 张（微信也是这个量级，评论区不宜太长）
                    var up = await this.uploadImage(login, files[i]);
                    // 不存 dataUrl：那是几 MB 的 base64，写进 JSON 太浪费
                    imgs.push({ p: up.p, n: up.n, t: up.t, s: up.s });
                }
            }

            var path = 'comments/' + postId + '/' + ts + '-' +
                login.toLowerCase() + '-' + Math.random().toString(36).slice(2, 6) + '.json';

            await global.API.writeFile(owner, repo, path,
                JSON.stringify({
                    login: login, avatar: avatar, text: text,
                    imgs: imgs.length ? imgs : undefined,
                    replyTo: replyTo || null, ts: ts
                }),
                '评论', null, 'main');
            return true;
        },

        /** 让某帖的赞/评论缓存失效 */
        _invalidate(owner, repo) {
            global.API._ls('fh:tree:' + owner + '/' + repo, null);
            global.API._ls('fh:etag:' + owner + '/' + repo, null);
        },

        async comments(owner, postId) {
            var repo = this.repoName(owner);
            var prefix = 'comments/' + postId + '/';
            var files;
            try {
                var t = await global.API.tree(owner, repo, 'main');
                files = t.files || t;
            } catch (e) { return []; }

            var names = files
                .filter(function (path) {
                    return path.indexOf(prefix) === 0 && /\.json$/.test(path);
                })
                .sort();                       // 文件名以时间戳开头 → 时间序

            var out = [];
            for (var i = 0; i < names.length; i++) {
                try {
                    var raw = await global.API.readFile(owner, repo, names[i], 'main', false);
                    if (raw) out.push(JSON.parse(raw));
                } catch (e) { /* 跳过 */ }
            }
            return out;
        },

        /**
         * 取图片可显示地址
         *
         * 朋友圈图片存在公开的 facehub-{login} 仓库，所以直接走
         * raw.githubusercontent 就行 —— 不用 contents API，
         * 省配额也更快（限流额度是分开计的）。
         */
        /**
         * 评论配图的地址
         *
         * ★ 注意 login 是**评论者**：图存在他自己的主页仓库。
         *   直接复用帖子作者的 login 会 404。
         */
        async _commentImgUrl(login, img) {
            return this._imgUrl(login, img);
        },

        async _imgUrl(login, img) {
            var ck = 'fh:mimg:' + login + '/' + img.p;
            var hit = global.API._ls(ck);
            if (hit) return hit;

            var url = 'https://raw.githubusercontent.com/' + login + '/' +
                this.repoName(login) + '/main/' + img.p;
            global.API._ls(ck, url);
            return url;
        },

        // ── 删除 ─────────────────────────────────────────
        /** 删自己的帖子（连带删赞和评论，避免留垃圾） */
        async remove(login, postId) {
            var repo = this.repoName(login);
            var files;
            try {
                var t = await global.API.tree(login, repo, 'main');
                files = t.files || t;
            } catch (e) { return false; }

            var prefix = 'posts/' + postId + '.json';
            var related = files.filter(function (path) {
                return path === prefix ||
                    path.indexOf('likes/' + postId + '/') === 0 ||
                    path.indexOf('comments/' + postId + '/') === 0;
            });

            for (var i = 0; i < related.length; i++) {
                try {
                    var sha = await global.API.sha(login, repo, related[i], 'main');
                    await global.API.req(
                        '/repos/' + login + '/' + repo + '/contents/' + related[i],
                        { method: 'DELETE', body: { message: '删除朋友圈', sha: sha, branch: 'main' } });
                } catch (e) { /* 单个失败不中断 */ }
            }
            // 清掉 tree 缓存和 ETag，否则删完立刻刷新会看到旧列表
            global.API._ls('fh:tree:' + login + '/' + repo, null);
            global.API._ls('fh:etag:' + login + '/' + repo, null);
            return true;
        }
    };

    global.Moments = Moments;
})(typeof window !== 'undefined' ? window : this);
