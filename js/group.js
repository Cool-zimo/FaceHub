/**
 * FaceHub 群聊
 *
 * 数据模型：一个群 = 一个私有仓库
 *
 *   fhgrp-{创建者小写}-{6位随机}
 *   ├── group.json      { name, owner, members[], createdAt, creatorPub }
 *   ├── pk/{成员}.json  各成员自己的 ECDH 公钥（私聊那套已发布过，直接复用）
 *   ├── gk/{成员}.json  用「创建者私钥 + 成员公钥」加密过的群密钥
 *   └── issue #1        所有群消息（评论，天然并发安全）
 *
 * 为什么用仓库而不是文件：
 *   · 成员权限靠 GitHub collaborator，不用自己实现
 *   · 消息用 issue 评论，多人同时发不会 409 冲突
 *
 * 为什么每个成员一份 gk 文件而不是共用：
 *   · 成员各自写同名文件会冲突
 *   · 只有创建者（或已有成员）能给新人分发，天然形成邀请链
 */
(function (global) {
    'use strict';

    var API = global.API;
    var PREFIX = 'fhgrp-';

    var Group = {
        PREFIX: PREFIX,

        isGroup: function (name) {
            return String(name).indexOf(PREFIX) === 0;
        },

        /** 生成群仓库名 */
        _newName: function (creatorLogin) {
            var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            var s = '';
            var a = new Uint8Array(6);
            global.crypto.getRandomValues(a);
            for (var i = 0; i < 6; i++) s += chars[a[i] % chars.length];
            return PREFIX + String(creatorLogin).toLowerCase() + '-' + s;
        },

        // ── 建群 ─────────────────────────────────────────────

        /**
         * 创建群
         * @param {string} title 群名
         * @param {string[]} members 初始成员 login（不含自己）
         */
        async create(title, members) {
            var me = global.Store.me;
            var owner = me.login;              // 必须先用真实 owner，不能硬编码
            var name = this._newName(me.login);

            await API.createPrivateRepo(name, title || 'FaceHub 群聊');

            // 空仓库建 issue：实测可行，省掉先塞 README 的一次写入
            await API.createIssue(owner, name, '群聊', 'FaceHub 群聊消息');

            var E2E = global.E2E;
            var gk = null;
            var creatorPub = null;
            if (E2E) {
                // creatorPub 必须是**身份**公钥：unwrapGroupKey 用它
                // 作为 fallback，而 wrap 用的是身份私钥，两者要配套
                creatorPub = (await E2E.ensureIdentity(me.login)).pub;
                // 同时往群仓库写一份旧式公钥，兼容老客户端
                try {
                    await E2E.ensureKeyPair(me.login, name);
                    await E2E.publishPubKey(owner, name, me.login, 'main');
                } catch (e) { /* 不影响 */ }
                gk = await E2E.generateGroupKey();
                // 自己也存一份，否则刷新后解不开自己发的
                var selfWrapped = await E2E.wrapGroupKey(gk, me.login, name, creatorPub);
                if (selfWrapped) {
                    await API.writeFile(owner, name, E2E._gkPath(me.login),
                        JSON.stringify({ for: me.login, gk: selfWrapped, by: me.login }),
                        '群密钥（自己）', null, 'main');
                }
            }

            var meta = {
                name: title || '群聊',
                owner: owner,
                creator: me.login,
                creatorPub: creatorPub,
                members: [me.login],
                createdAt: Date.now()
            };
            await API.writeFile(owner, name, 'group.json',
                JSON.stringify(meta, null, 2), '创建群', null, 'main');

            // 邀请成员
            for (var i = 0; i < (members || []).length; i++) {
                try {
                    await this.addMember(owner, name, members[i].trim(), gk);
                } catch (e) {
                    // 单个成员邀请失败不能让建群失败
                    if (global.console) console.warn('[群] 邀请 ' + members[i] + ' 失败', e.message);
                }
            }
            // 建群后立刻把群密钥存本地，省掉首次读取的一次请求
            if (gk) this._cacheGk(owner, name, gk);

            return {
                name: name, owner: owner, title: title,
                members: members || [], gk: gk
            };
        },

        // ── 成员 ─────────────────────────────────────────────

        /**
         * 加成员：邀请 collaborator + 分发群密钥
         *
         * 分发需要先读到对方公钥；对方还没发布过（没用过 FaceHub）
         * 就只邀请，等他上线后再补发。
         */
        async addMember(owner, name, login, gk) {
            login = String(login).trim();
            if (!login) return { invited: false, keySent: false };

            await API.inviteCollaborator(owner, name, login);

            var meta = await this.meta(owner, name);

            // 先把人写进成员列表 —— 必须放在分发之前。
            // 否则分发失败（对方还没公钥）时会提前 return，
            // 名单里没有他，之后 ensureKeysDistributed 也扫不到，
            // 这个人就永远拿不到群密钥。
            try {
                if ((meta.members || []).indexOf(login) < 0) {
                    meta.members = meta.members || [];
                    meta.members.push(login);
                    var msha = null;
                    try { msha = await API.sha(owner, name, 'group.json', 'main'); }
                    catch (e) { msha = null; }
                    await API.writeFile(owner, name, 'group.json',
                        JSON.stringify(meta, null, 2), '加入 ' + login, msha, 'main');
                }
            } catch (e) { /* 名单更新失败不阻断，后续可重试 */ }

            var E2E = global.E2E;
            if (!E2E || !gk) return { invited: true, keySent: false };

            // 优先读对方的**身份公钥**（facehub-{他}/pk.json）。
            // 那是他登录时就发布的 → 建群瞬间就能分发群密钥，不用等他上线。
            var peerPub = await E2E.readIdentity(login);
            if (!peerPub && meta.creatorPub) {
                peerPub = await E2E.readPeerPubKey(owner, name, login, 'main');
            }
            if (!peerPub) return { invited: true, keySent: false, noPub: true };

            var myLogin = global.Store.me.login;
            var wrapped = await E2E.wrapGroupKey(gk, myLogin, name, peerPub);
            if (!wrapped) return { invited: true, keySent: false };

            // 带上分发者的**身份**公钥 —— 必须与 wrapGroupKey 用的
            // 私钥配套，否则对方解不开（私钥是身份密钥，公钥也必须是）
            var myPub = (await E2E.ensureIdentity(myLogin)).pub;
            var path = E2E._gkPath(login);
            var sha = null;
            try { sha = await API.sha(owner, name, path, 'main'); } catch (e) { sha = null; }
            await API.writeFile(owner, name, path,
                JSON.stringify({
                    for: login, gk: wrapped,
                    by: myLogin, byPub: myPub || null
                }),
                '分发群密钥给 ' + login, sha, 'main');

            return { invited: true, keySent: true };
        },

        /** 读群元数据 */
        async meta(owner, name) {
            try {
                var txt = await API.readFile(owner, name, 'group.json', 'main', true);
                return JSON.parse(txt);
            } catch (e) {
                return { name: name, owner: owner, members: [], creator: owner };
            }
        },

        // ── 群密钥 ───────────────────────────────────────────

        /**
         * 取群密钥（本地缓存优先）
         * @returns {CryptoKey|null} 拿不到就是还没被分发
         */
        async groupKey(owner, name) {
            var E2E = global.E2E;
            if (!E2E) return null;
            var me = global.Store.me.login;

            var ck = 'fh:gk:' + owner + '/' + name;
            var cached = API._ls(ck);
            if (cached) {
                try { return await E2E.importGroupKey(cached); } catch (e) { /* 坏了重新取 */ }
            }

            var meta = await this.meta(owner, name);
            var path = E2E._gkPath(me);

            var raw;
            try { raw = await API.readFile(owner, name, path, 'main', true); }
            catch (e) { return null; }

            var d;
            try { d = JSON.parse(raw); } catch (e) { return null; }
            if (!d || !d.gk) return null;

            // 用「我的私钥 + 分发者公钥」解出群密钥。
            // 优先用文件里记录的 byPub；老文件没有就退回 creatorPub。
            var wrapperPub = d.byPub || meta.creatorPub;
            if (!wrapperPub) return null;

            var gkB64 = await E2E.unwrapGroupKey(d.gk, me, name, wrapperPub);
            if (!gkB64) return null;

            API._ls(ck, gkB64);
            return await E2E.importGroupKey(gkB64);
        },

        /** 本地已缓存的群密钥原文（建群后立刻用，省一次读） */
        _cacheGk: function (owner, name, gkB64) {
            API._ls('fh:gk:' + owner + '/' + name, gkB64);
        },

        /**
         * 补发群密钥
         *
         * 为什么需要：新人要先接受邀请才能往群里写文件，
         * 所以建群那一刻他既没有公钥、也拿不到群密钥。
         * 每次打开群时扫一遍：谁有公钥但缺群密钥，就补给谁。
         *
         * 只有自己已持有群密钥的成员才能执行 —— 没有密钥的人
         * 无从加密给别人（他连群密钥明文都没有）。
         */
        async ensureKeysDistributed(owner, name) {
            var E2E = global.E2E;
            if (!E2E) return { sent: 0, noKey: true };
            var me = global.Store.me.login;

            // 先确保我自己有群密钥（否则无从分发）
            var gkB64 = API._ls('fh:gk:' + owner + '/' + name);
            if (!gkB64) {
                var k = await this.groupKey(owner, name);
                if (!k) return { sent: 0, noKey: true };
                gkB64 = API._ls('fh:gk:' + owner + '/' + name);
            }
            if (!gkB64) return { sent: 0, noKey: true };

            var meta = await this.meta(owner, name);
            var members = meta.members || [];
            var sent = 0;

            for (var i = 0; i < members.length; i++) {
                var m = members[i];
                if (!m) continue;
                var gkPath = E2E._gkPath(m);

                // 已经发过了
                var has = false;
                try {
                    await API.readFile(owner, name, gkPath, 'main', true);
                    has = true;
                } catch (e) { has = false; }
                if (has) continue;

                // 需要对方有公钥。身份公钥优先（无需他上线），
                // 会话仓库里的旧式公钥兜底。
                var pub = await E2E.readIdentity(m);
                if (!pub) pub = await E2E.readPeerPubKey(owner, name, m, 'main');
                if (!pub) continue;

                var wrapped = await E2E.wrapGroupKey(gkB64, me, name, pub);
                if (!wrapped) continue;

                var myPub = (await E2E.ensureIdentity(me)).pub;
                try {
                    var sha = null;
                    try { sha = await API.sha(owner, name, gkPath, 'main'); } catch (e) { sha = null; }
                    await API.writeFile(owner, name, gkPath,
                        JSON.stringify({
                            for: m, gk: wrapped,
                            by: me, byPub: myPub || null
                        }),
                        '补发群密钥给 ' + m, sha, 'main');
                    sent++;
                } catch (e) { /* 单个失败不影响其他人 */ }
            }
            return { sent: sent };
        },

        // ── 消息 ─────────────────────────────────────────────

        async messages(owner, name, fresh) {
            var ck = 'fh:msg:' + owner + '/' + name;
            if (!fresh) {
                var cached = API._ls(ck);
                if (cached) {
                    try { return JSON.parse(cached); } catch (e) { /* 重新拉 */ }
                }
            }
            var list = await API.messages(owner, name, 1);
            var aes = await this.groupKey(owner, name);
            var E2E = global.E2E;

            var out = [];
            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                var m = {
                    id: c.id,
                    from: c.user.login,
                    avatar: c.user.avatar_url,
                    raw: c.body,
                    ts: new Date(c.created_at).getTime()
                };
                if (!E2E) {
                    m.text = c.body;
                    m.encrypted = false;
                } else if (typeof c.body === 'string' && c.body.indexOf('E2E1.') === 0) {
                    var r = await E2E.decrypt(aes, c.body);
                    m.text = r.text;
                    m.locked = !!r.locked;
                    m.encrypted = !r.plain && !r.locked;
                } else {
                    m.text = c.body;
                    m.encrypted = false;
                }
                out.push(m);
            }
            API._ls(ck, JSON.stringify(out));
            return out;
        },

        async send(owner, name, text) {
            text = String(text || '').trim();
            if (!text) throw new Error('消息不能为空');

            var body = text;
            var enc = false;
            var aes = await this.groupKey(owner, name);
            if (aes && global.E2E) {
                try { body = await global.E2E.encrypt(aes, text); enc = true; }
                catch (e) { body = text; }
            }
            var r = await API.sendMessage(owner, name, body, 1);
            API._ls('fh:msg:' + owner + '/' + name, null);
            r.__encrypted = enc;
            return r;
        }
    };

    global.Group = Group;
})(window);
