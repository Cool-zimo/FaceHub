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

        /**
         * 接受邀请
         *
         * ⚠️ 实测发现的坑：仓库被删除重建后，**旧邀请会残留**。
         * 接受旧邀请返回 204（看起来成功），但权限并不生效 ——
         * 用户点了"接受"，会话却依然打不开。
         *
         * 所以接受后必须**验证真的能访问**，不行就继续尝试下一条邀请。
         */
        async accept(id, roomName) {
            await API.acceptInvitation(id);
            API._ls('fh:rooms:etag', null);

            if (!roomName) return { ok: true, verified: false };

            // 同一仓库可能有多条邀请（重建导致），逐条尝试直到真的能访问
            try {
                var invs = await this.invitations();
                var same = invs.filter(function (i) { return i.name === roomName; });

                // 先试本次传进来的，再试其余的
                var order = [id].concat(
                    same.map(function (i) { return i.id; }).filter(function (x) { return x !== id; })
                );

                for (var k = 0; k < order.length; k++) {
                    if (k > 0) await API.acceptInvitation(order[k]);
                    var repo = await API.getRepo(
                        same.length ? same[0].owner : Store.me.login, roomName
                    );
                    if (repo) {
                        API._ls('fh:rooms:etag', null);
                        return { ok: true, verified: true, tried: k + 1 };
                    }
                }
                return { ok: true, verified: false, tried: order.length };
            } catch (e) {
                return { ok: true, verified: false, error: e.message };
            }
        },

        async decline(id) {
            var ok = await API.declineInvitation(id);
            return ok;
        },

        // ── 消息 ───────────────────────────────────────────────

        /**
         * 读消息（自动解密）
         *
         * 解密需要"我的私钥 + 对方公钥"。任一缺失就原样显示，
         * 并标记 locked —— 界面上要让用户知道这条没能解密。
         *
         * @param {boolean} fresh - 刚发完消息时用 true，绕过本地缓存
         */
        async messages(owner, repo, fresh, opts) {
            opts = opts || {};
            var ck = 'fh:msg:' + owner + '/' + repo;
            if (!fresh) {
                var cached = API._ls(ck);
                if (cached) {
                    try {
                        var cm = JSON.parse(cached);
                        // 缓存也要解密状态正确；有密钥就重新解一遍
                        if (opts.peerPub) {
                            return await this._decryptAll(cm, owner, repo, opts);
                        }
                        return cm;
                    } catch (e) { /* 坏了重新拉 */ }
                }
            }
            var list = await API.messages(owner, repo, 1);
            var msgs = list.map(function (c) {
                return {
                    id: c.id,
                    from: c.user.login,
                    avatar: c.user.avatar_url,
                    text: c.body,       // 可能是密文，稍后解
                    raw: c.body,
                    ts: new Date(c.created_at).getTime()
                };
            });

            var dec = await this._decryptAll(msgs, owner, repo, opts);
            API._ls(ck, JSON.stringify(dec));
            return dec;
        },

        /** 批量解密（内部用） */
        async _decryptAll(msgs, owner, repo, opts) {
            var E2E = global.E2E;
            // 没有对方公钥 → 保持原样，不尝试解密
            if (!E2E || !opts || !opts.peerPub) {
                return msgs.map(function (m) {
                    var isCipher = typeof m.raw === 'string' && m.raw.indexOf('E2E1.') === 0;
                    return Object.assign({}, m, {
                        text: isCipher ? '🔒 加密消息（等待密钥交换）' : (m.raw || m.text),
                        locked: isCipher
                    });
                });
            }
            var aes = null;
            try {
                aes = await E2E.deriveAesKey(opts.myLogin, repo, opts.peerPub);
            } catch (e) {
                aes = null;
            }
            var out = [];
            for (var i = 0; i < msgs.length; i++) {
                var m = msgs[i];
                var r = await E2E.decrypt(aes, m.raw != null ? m.raw : m.text);
                out.push(Object.assign({}, m, {
                    text: r.text,
                    locked: !!r.locked,
                    encrypted: !r.plain && !r.locked
                }));
            }
            return out;
        },

        /**
         * 发消息（自动加密）
         *
         * 对方已发布公钥 → 加密后发送，GitHub 只看到密文
         * 对方还没发布 → 明文发送（首次会话必然如此，等对方上线交换密钥）
         */
        async send(owner, repo, text, opts) {
            text = String(text || '').trim();
            if (!text) throw new Error('消息不能为空');
            opts = opts || {};

            var body = text;
            var wasEncrypted = false;

            var E2E = global.E2E;
            if (E2E && opts.peerPub) {
                try {
                    var aes = await E2E.deriveAesKey(opts.myLogin, repo, opts.peerPub);
                    body = await E2E.encrypt(aes, text);
                    wasEncrypted = true;
                } catch (e) {
                    // 加密失败就退回明文，不能让消息发不出去
                    body = text;
                }
            }

            var r = await API.sendMessage(owner, repo, body, 1);
            API._ls('fh:msg:' + owner + '/' + repo, null);
            API._ls('fh:rooms:etag', null);
            r.__encrypted = wasEncrypted;
            return r;
        },

        // ── 密钥交换 ─────────────────────────────────────────

        /**
         * 建立/恢复加密会话
         *
         * 返回状态，界面据此显示"🔒 端到端加密"或"等待对方上线"
         */
        async setupE2E(owner, repo, myLogin, peerLogin, branch) {
            var E2E = global.E2E;
            if (!E2E) return { ready: false, reason: 'no-crypto' };
            if (!global.crypto || !global.crypto.subtle) {
                // 非 HTTPS 或老浏览器没有 Web Crypto
                return { ready: false, reason: 'no-webcrypto' };
            }

            var state = {
                ready: false,
                myPub: null,
                peerPub: null,
                peerReady: false
            };

            // ① 确保我有密钥对，并把公钥发布到仓库
            try {
                await E2E.ensureKeyPair(myLogin, repo);
                state.myPub = await E2E.publishPubKey(owner, repo, myLogin, branch);
            } catch (e) {
                // 写公钥失败（比如权限刚生效）不致命，下次重试
                state.publishError = e.message;
            }

            // ② 读对方公钥
            state.peerPub = await E2E.readPeerPubKey(owner, repo, peerLogin, branch);
            state.peerReady = !!state.peerPub;

            // ③ 双方公钥都在 → 可以派生共享密钥
            if (state.myPub && state.peerPub) {
                try {
                    await E2E.deriveAesKey(myLogin, repo, state.peerPub);
                    state.ready = true;
                } catch (e) {
                    state.error = e.message;
                }
            }
            return state;
        }
    };

    global.Chat = Chat;
})(window);
