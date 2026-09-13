/**
 * FaceHub 私聊
 *
 * 方案：**一个会话 = 一个私有仓库**，消息存在 issue #1 的评论里。
 *
 * 为什么这样设计（几个关键决策）：
 *
 * ① 仓库名确定性
 *    fbdm-{用户名排序后拼接}
 *    两个人各自算，得到的**是同一个名字**。
 *    所以不需要任何"发现服务"或中心化目录就能找到同一个会话 ——
 *    这是纯前端方案能成立的核心。
 *
 * ② 消息用 issue 评论，不用文件
 *    往文件追加消息要先 GET 拿 sha 再 PUT，两人同时发必然 409 冲突。
 *    issue 评论天然并发安全，还白送作者、头像、时间戳、Markdown。
 *
 * ③ 邀请在应用内完成
 *    多数人以为加协作者必须去邮箱点链接。实际上有：
 *      GET  /user/repository_invitations        列出待接受的邀请
 *      PATCH /user/repository_invitations/{id}  接受
 *    所以整个流程不用离开 FaceHub。
 *
 * ④ 会话列表靠列仓库，不靠搜索
 *    搜索有 5~30 分钟索引延迟，私聊不能等。
 *    /user/repos 是实时的，过滤 fbdm- 前缀即可，还带 ETag 缓存。
 */
(function (global) {
    'use strict';

    var API = global.API;
    var Store = global.Store;

    var PREFIX = 'fbdm-';

    var Chat = {
        /**
         * 会话仓库名：用户名排序后拼接
         *
         * 排序保证 A 找 B 和 B 找 A 算出的是同一个名字。
         * 小写化是因为 GitHub 仓库名不区分大小写。
         */
        roomName: function (a, b) {
            var pair = [String(a).toLowerCase(), String(b).toLowerCase()].sort();
            return PREFIX + pair[0] + '-' + pair[1];
        },

        /** 从仓库名反解出对方用户名 */
        peerOf: function (repoName, myLogin) {
            var s = String(repoName).replace(new RegExp('^' + PREFIX, 'i'), '');
            var parts = s.split('-');
            // 用户名可能含连字符，所以不能简单 split 取两段。
            // 用"去掉自己那一段"的方式更安全：
            var me = String(myLogin).toLowerCase();
            var idx = s.indexOf(me + '-');
            if (idx === 0) return s.slice(me.length + 1);
            idx = s.indexOf('-' + me);
            if (idx >= 0) return s.slice(0, idx);
            return parts.length > 1 ? parts[parts.length - 1] : s;
        },

        /** 是否是私聊仓库 */
        isRoom: function (name) {
            return new RegExp('^' + PREFIX, 'i').test(String(name || ''));
        },

        // ── 会话列表 ───────────────────────────────────────────

        /**
         * 列出我的所有会话
         *
         * 走 /user/repos（实时，不走搜索），过滤 fbdm- 前缀。
         * 带 ETag：没有新会话就 304，不计费。
         */
        async listRooms() {
            var ck = 'fh:rooms';
            var ek = 'fh:rooms:etag';

            var headers = {};
            var etag = API._ls(ek);
            if (etag) headers['If-None-Match'] = etag;

            var r = await API.req('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator',
                { headers: headers });

            if (r.__status === 304) {
                var cached = API._ls(ck);
                return cached ? JSON.parse(cached) : [];
            }

            var rooms = (r.data || [])
                .filter(function (repo) { return Chat.isRoom(repo.name); })
                .map(function (repo) {
                    return {
                        name: repo.name,
                        owner: repo.owner.login,
                        peer: Chat.peerOf(repo.name, Store.me.login),
                        private: repo.private,
                        updatedAt: repo.updated_at
                    };
                })
                .sort(function (a, b) {
                    return new Date(b.updatedAt) - new Date(a.updatedAt);
                });

            var newEtag = r.__headers.get('etag');
            if (newEtag) API._ls(ek, newEtag);
            API._ls(ck, JSON.stringify(rooms));
            return rooms;
        },

        // ── 发起会话 ───────────────────────────────────────────

        /**
         * 和某人开始私聊
         *
         * 三种情况：
         *   ① 会话仓库已存在 → 直接用（说明之前聊过，或对方先发起）
         *   ② 不存在，我建 → 建私有仓 + 建 issue + 邀请对方
         *   ③ 我建时 422（对方同一时刻也建了）→ 回退到直接用
         */
        async start(peer) {
            peer = String(peer).trim();
            if (!peer) throw new Error('请输入用户名');
            if (peer.toLowerCase() === Store.me.login.toLowerCase()) {
                throw new Error('不能和自己私聊');
            }

            // 校验账号存在（否则邀请会 404，且会话列表里躺着个死仓库）
            var user = await API.getUser(peer);
            if (!user) throw new Error('用户 ' + peer + ' 不存在');

            var name = this.roomName(Store.me.login, peer);
            var existing = await API.getRepo(Store.me.login, name);
            if (existing) {
                API._ls('fh:rooms:etag', null);
                return { name: name, owner: Store.me.login, peer: peer, existed: true };
            }

            var repo;
            try {
                repo = await API.createPrivateRepo(name, 'FaceHub 私聊');
            } catch (e) {
                // 422 = 名字已存在。通常是对方先建了（此时我在他的仓库里是 collaborator）
                var now = await API.getRepo(Store.me.login, name);
                if (!now) throw e;
                repo = now;
            }

            // 空仓库也能直接建 issue（实测通过），所以不用先塞 README
            try {
                await API.createIssue(
                    repo.owner.login, repo.name,
                    '私聊',
                    'FaceHub 私聊会话。消息存在这个 issue 的评论里。'
                );
            } catch (e) {
                // issue 建失败不致命（可能是已存在），继续
            }

            // 邀请对方 —— 只有我建的仓库才需要（我拥有它）
            if (repo.owner.login.toLowerCase() === Store.me.login.toLowerCase()) {
                try {
                    await API.inviteCollaborator(repo.owner.login, repo.name, peer);
                } catch (e) {
                    // 邀请失败不影响会话本身，对方可以稍后重试
                }
            }

            API._ls('fh:rooms:etag', null);
            return {
                name: repo.name,
                owner: repo.owner.login,
                peer: peer,
                existed: false
            };
        },

        // ── 邀请（对方视角）─────────────────────────────────────

        /** 我收到的、还没接受的私聊邀请 */
        async invitations() {
            var all = await API.invitations();
            return all.filter(function (inv) {
                return Chat.isRoom(inv.repository ? inv.repository.name : '');
            }).map(function (inv) {
                var r = inv.repository;
                return {
                    id: inv.id,
                    name: r.name,
                    owner: r.owner.login,
                    peer: r.owner.login,          // 邀请方就是仓库所有者
                    private: r.private,
                    createdAt: inv.created_at
                };
            });
        },

        async accept(id) {
            var ok = await API.acceptInvitation(id);
            API._ls('fh:rooms:etag', null);
            return ok;
        },

        async decline(id) {
            var ok = await API.declineInvitation(id);
            return ok;
        },

        // ── 消息 ───────────────────────────────────────────────

        /**
         * 读消息
         * @param {boolean} fresh - 刚发完消息时用 true，绕过本地缓存
         */
        async messages(owner, repo, fresh) {
            var ck = 'fh:msg:' + owner + '/' + repo;
            if (!fresh) {
                var cached = API._ls(ck);
                if (cached) {
                    try { return JSON.parse(cached); } catch (e) { /* 坏了重新拉 */ }
                }
            }
            var list = await API.messages(owner, repo, 1);
            var msgs = list.map(function (c) {
                return {
                    id: c.id,
                    from: c.user.login,
                    avatar: c.user.avatar_url,
                    text: c.body,
                    ts: new Date(c.created_at).getTime()
                };
            });
            API._ls(ck, JSON.stringify(msgs));
            return msgs;
        },

        async send(owner, repo, text) {
            text = String(text || '').trim();
            if (!text) throw new Error('消息不能为空');
            var r = await API.sendMessage(owner, repo, text, 1);
            API._ls('fh:msg:' + owner + '/' + repo, null);
            API._ls('fh:rooms:etag', null);
            return r;
        }
    };

    global.Chat = Chat;
})(window);
