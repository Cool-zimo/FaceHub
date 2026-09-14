/**
 * FaceHub 主控制器（微信风格）
 *
 * 三边同源：FaceHub 与 github_drive / 仓鼠 同在 cool-zimo.github.io，
 * localStorage 共享，所以登录一次三个应用通用。
 *
 * 会话分两类，但界面上统一处理：
 *   dm    → 私聊，fbdm-{a}-{b}，密钥用双方 ECDH
 *   group → 群聊，fhgrp-{创建者}-{随机}，密钥用分发的群密钥
 */
(function (global) {
    'use strict';

    var API = global.API;
    var Store = global.Store;
    var Chat = global.Chat;
    var Group = global.Group;

    // 与 drive / 仓鼠 共用的令牌存储位置（三边令牌互认）
    var TOKEN_KEYS = ['facehub.token', 'github_drive_token', 'cangshu.token'];
    var USER_KEYS = ['facehub.user', 'github_drive_user', 'cangshu.user'];

    var App = {
        view: 'chats',
        convs: [],          // 会话列表
        current: null,      // 当前会话
        e2eState: null,
        searchKw: '',

        // ── 存储 ───────────────────────────────────────────────
        ls: function (k, v) {
            try {
                if (v === undefined) return global.localStorage.getItem(k);
                if (v === null) global.localStorage.removeItem(k);
                else global.localStorage.setItem(k, v);
            } catch (e) { return null; }
        },
        getToken: function () {
            for (var i = 0; i < TOKEN_KEYS.length; i++) {
                var v = this.ls(TOKEN_KEYS[i]);
                if (v && /^(ghp_|github_pat_)/.test(v)) return v;
            }
            return null;
        },
        getSavedUser: function () {
            for (var i = 0; i < USER_KEYS.length; i++) {
                try {
                    var u = JSON.parse(this.ls(USER_KEYS[i]));
                    if (u && u.login) return u;
                } catch (e) { /* 换下一个 */ }
            }
            return null;
        },
        saveSession: function (token, user) {
            var self = this;
            TOKEN_KEYS.forEach(function (k) { self.ls(k, token); });
            if (user) {
                var s = JSON.stringify(user);
                USER_KEYS.forEach(function (k) { self.ls(k, s); });
            }
        },
        logout: function () {
            var self = this;
            TOKEN_KEYS.forEach(function (k) { self.ls(k, null); });
            USER_KEYS.forEach(function (k) { self.ls(k, null); });
            global.location.reload();
        },

        // ── 启动 ───────────────────────────────────────────────
        async boot() {
            var token = this.getToken();
            if (token) await this.enter(token);
            else this.showBridgeHint();
            this.bindLogin();
            this.bindUI();
        },

        /** 其他应用已登录 → 显示"沿用账号" */
        showBridgeHint() {
            var user = this.getSavedUser();
            var box = document.getElementById('bridge-box');
            if (!box || !user) return;
            document.getElementById('bridge-name').textContent = user.login;
            var av = document.getElementById('bridge-avatar');
            if (av && user.avatar_url) {
                av.innerHTML = '<img src="' + this.esc(user.avatar_url) + '" style="width:22px;height:22px;border-radius:4px;vertical-align:-6px;margin-right:5px">';
            }
            box.style.display = '';
            var self = this;
            document.getElementById('bridge-use').onclick = function () {
                var t = self.getToken();
                if (t) self.enter(t);
            };
        },

        bindLogin() {
            var self = this;
            var btn = document.getElementById('login-btn');
            var input = document.getElementById('token-input');
            btn.onclick = function () {
                var t = (input.value || '').trim();
                if (!t) return self.toast('请输入令牌', true);
                if (!/^(ghp_|github_pat_)/.test(t)) {
                    return self.toast('令牌应以 ghp_ 或 github_pat_ 开头', true);
                }
                self.enter(t);
            };
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') btn.click();
            });
        },

        async enter(token) {
            var self = this;
            var btn = document.getElementById('login-btn');
            if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }

            API.setToken(token);
            try {
                Store.me = await API.me();
                this.saveSession(token, Store.me);
            } catch (e) {
                if (btn) { btn.disabled = false; btn.textContent = '登录'; }
                var box = document.getElementById('bridge-box');
                if (box) box.style.display = 'none';
                this.toast('登录失败：' + (e.message || e), true);
                return;
            }

            document.getElementById('login-page').style.display = 'none';
            document.getElementById('app').style.display = '';

            var av = document.getElementById('me-avatar');
            if (av && Store.me.avatar_url) {
                av.src = Store.me.avatar_url;
                av.onerror = function () { av.src = ''; };
            }

            Store.branch = 'main';

            // 发布身份公钥（后台进行，不阻塞界面）
            //
            // 这是"不用等对方上线"的前提：我的公钥挂在我的公开仓库上，
            // 任何人随时能读到，随时能给我发加密消息。
            this.publishIdentity();

            await this.loadConvs();
            this.startPolling();
        },

        /**
         * 确保 identity 仓库存在并发布公钥
         *
         * 首次登录会创建一个公开仓库 facehub-{login}，里面只有 pk.json。
         * 公开是必须的 —— 私钥仍在本地，放出去的只是公钥。
         */
        async publishIdentity() {
            var self = this;
            var login = Store.me.login;
            var repo = 'facehub-' + String(login).toLowerCase();

            try {
                await API.getRepo(login, repo);
            } catch (e) {
                // 不存在 → 创建（公开）
                try {
                    await API.createPublicRepo(repo, 'FaceHub 身份公钥（只含公钥，可安全公开）');
                    // 新建的仓库要等 GitHub 就绪，稍等再写
                    await new Promise(function (r) { setTimeout(r, 1500); });
                } catch (e2) {
                    if (global.console) console.warn('[身份] 创建仓库失败', e2.message);
                    return;
                }
            }

            try {
                var res = await global.E2E.publishIdentity(login);
                if (global.console) {
                    console.log('[身份] 公钥已' + (res.skipped ? '存在（未重复写入）' : '发布') +
                        ' → ' + repo + '/pk.json');
                }
                if (res.rotated) {
                    // 覆盖了一个不同的旧公钥。可能是新设备登录，
                    // 也可能被人改过 —— 必须让用户知道，不能悄悄发生。
                    this.toast('已更新身份公钥：旧设备上发的消息需要导入密钥备份才能解开', false);
                    if (global.console) {
                        console.warn('[身份] 公钥发生轮换，旧公钥：',
                            String(res.previousPub).slice(0, 16) + '…');
                    }
                }
            } catch (e) {
                if (global.console) console.warn('[身份] 发布公钥失败', e.message);
            }
        },

        // ── UI 绑定 ────────────────────────────────────────────
        bindUI() {
            var self = this;

            // 底部/侧边导航
            document.querySelectorAll('.nav-btn').forEach(function (b) {
                b.onclick = function () {
                    var tab = b.getAttribute('data-tab');
                    document.querySelectorAll('.nav-btn').forEach(function (x) {
                        x.classList.remove('active');
                    });
                    b.classList.add('active');
                    self.switchTab(tab);
                };
            });

            // 搜索
            document.getElementById('search-input').oninput = function (e) {
                self.searchKw = (e.target.value || '').trim().toLowerCase();
                self.renderConvs();
            };

            // 新建
            document.getElementById('add-btn').onclick = function () { self.openNew(); };
            document.getElementById('new-modal-x').onclick = function () { self.closeNew(); };
            document.getElementById('new-cancel').onclick = function () { self.closeNew(); };
            document.getElementById('new-modal').onclick = function (e) {
                if (e.target.id === 'new-modal') self.closeNew();
            };
            document.querySelectorAll('.seg-btn').forEach(function (b) {
                b.onclick = function () {
                    var mode = b.getAttribute('data-mode');
                    document.querySelectorAll('.seg-btn').forEach(function (x) {
                        x.classList.remove('active');
                    });
                    b.classList.add('active');
                    document.getElementById('dm-pane').style.display = mode === 'dm' ? '' : 'none';
                    document.getElementById('group-pane').style.display = mode === 'group' ? '' : 'none';
                    document.getElementById('new-modal-title').textContent =
                        mode === 'dm' ? '发起单聊' : '发起群聊';
                };
            });
            document.getElementById('new-ok').onclick = function () { self.createConv(); };

            // 发送
            document.getElementById('send-btn').onclick = function () { self.sendMessage(); };
            document.getElementById('msg-input').addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.sendMessage(); }
            });

            // 返回（移动端）
            document.getElementById('back-btn').onclick = function () {
                document.getElementById('app').classList.remove('show-chat');
            };

            // 详情
            document.getElementById('info-btn').onclick = function () { self.openInfo(); };
            document.getElementById('info-modal-x').onclick = function () {
                document.getElementById('info-modal').style.display = 'none';
            };
            document.getElementById('info-modal').onclick = function (e) {
                if (e.target.id === 'info-modal') {
                    document.getElementById('info-modal').style.display = 'none';
                }
            };

            // 密钥备份
            document.getElementById('key-modal-x').onclick = function () {
                document.getElementById('key-modal').style.display = 'none';
            };
            document.getElementById('key-modal').onclick = function (e) {
                if (e.target.id === 'key-modal') {
                    document.getElementById('key-modal').style.display = 'none';
                }
            };
            document.getElementById('key-gen-btn').onclick = function () { self.genBackup(); };
            document.getElementById('key-copy-btn').onclick = function () { self.copyBackup(); };
            document.getElementById('key-download-btn').onclick = function () { self.downloadBackup(); };
            document.getElementById('key-import-btn').onclick = function () { self.doImportBackup(); };
            document.querySelectorAll('.key-tab').forEach(function (t) {
                t.onclick = function () {
                    document.querySelectorAll('.key-tab').forEach(function (x) {
                        x.classList.remove('active');
                    });
                    t.classList.add('active');
                    var isExp = t.getAttribute('data-tab') === 'export';
                    document.getElementById('key-export-pane').style.display = isExp ? '' : 'none';
                    document.getElementById('key-import-pane').style.display = isExp ? 'none' : '';
                };
            });
            document.getElementById('key-file').onchange = function (e) {
                var f = e.target.files && e.target.files[0];
                if (!f) return;
                var fr = new FileReader();
                fr.onload = function () {
                    document.getElementById('key-import-text').value = String(fr.result || '');
                };
                fr.readAsText(f);
            };

            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape') return;
                ['new-modal', 'info-modal', 'key-modal'].forEach(function (id) {
                    var m = document.getElementById(id);
                    if (m && m.style.display !== 'none') m.style.display = 'none';
                });
            });
        },

        switchTab(tab) {
            if (tab === 'me') {
                this.openKeyModal();
                return;
            }
            if (tab === 'contacts') {
                this.openNew();
                return;
            }
            this.view = 'chats';
            this.loadConvs();
        },

        // ── 会话列表 ───────────────────────────────────────────
        async loadConvs() {
            var list = document.getElementById('conv-list');
            list.innerHTML = '<div class="loading">载入中…</div>';

            var convs = [];

            // 私聊
            try {
                var rooms = await Chat.listRooms();
                rooms.forEach(function (r) {
                    convs.push({
                        type: 'dm',
                        name: r.name,
                        owner: r.owner,
                        title: r.peer,
                        peer: r.peer,
                        avatar: 'https://github.com/' + r.peer + '.png?size=80',
                        updatedAt: r.updatedAt
                    });
                });
            } catch (e) {
                if (global.console) console.warn('[私聊] 载入失败', e.message);
            }

            // 群聊
            try {
                var groups = await this.listGroups();
                groups.forEach(function (g) { convs.push(g); });
            } catch (e) {
                if (global.console) console.warn('[群聊] 载入失败', e.message);
            }

            convs.sort(function (a, b) {
                return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
            });

            this.convs = convs;
            this.renderConvs();

            // 待接受邀请
            try {
                var invs = await Chat.invitations();
                this.invites = invs || [];
                var badge = document.getElementById('badge-invite');
                if (badge) {
                    badge.style.display = this.invites.length ? '' : 'none';
                    badge.textContent = this.invites.length;
                }
                this.renderInvites();
            } catch (e) {
                this.invites = [];
                this.renderInvites();
            }
        },

        /**
         * 待接受邀请
         *
         * ⚠️ GitHub 的邀请列表有延迟，实测可达**数分钟**。
         * 所以这里必须：
         *   · 明确写出"可能需要几分钟"，否则用户以为邀请没发出去
         *   · 给一个刷新按钮，而不是让他干等
         */
        renderInvites() {
            var box = document.getElementById('invite-banner');
            if (!box) return;
            var self = this;

            if (!this.invites || !this.invites.length) {
                box.style.display = 'none';
                return;
            }
            box.style.display = '';
            box.innerHTML = '';

            var title = document.createElement('div');
            title.className = 'invite-title';
            var t1 = document.createElement('span');
            t1.textContent = '🔔 ' + this.invites.length + ' 个会话邀请';
            var rf = document.createElement('button');
            rf.className = 'invite-refresh';
            rf.textContent = '刷新';
            rf.onclick = function () { self.loadConvs(); };
            title.appendChild(t1);
            title.appendChild(rf);
            box.appendChild(title);

            this.invites.forEach(function (inv) {
                var row = document.createElement('div');
                row.className = 'invite-item';

                var who = document.createElement('span');
                who.className = 'invite-who';
                who.textContent = inv.peer + (inv.isGroup ? ' 邀请你加入群聊' : ' 想和你私聊');
                row.appendChild(who);

                var btn = document.createElement('button');
                btn.className = 'invite-accept';
                btn.textContent = '接受';
                btn.onclick = function () { self.acceptInvite(inv, btn); };
                row.appendChild(btn);

                box.appendChild(row);
            });

            var tip = document.createElement('div');
            tip.className = 'invite-delay';
            tip.textContent = 'GitHub 的邀请有几分钟延迟，没看到就点刷新';
            box.appendChild(tip);
        },

        /**
         * 接受邀请
         *
         * 沿用私聊那套"接受后必须验证真的能访问"的逻辑 ——
         * 仓库删除重建会留下幽灵邀请，接受它返回成功但权限不生效。
         */
        async acceptInvite(inv, btn) {
            var self = this;
            btn.disabled = true;
            btn.textContent = '…';
            try {
                var res = await Chat.accept(inv.id, inv.name);
                if (res.verified) {
                    this.toast('已接受 ' + inv.peer + ' 的邀请');
                    await this.loadConvs();
                    var hit = this.convs.filter(function (c) { return c.name === inv.name; })[0];
                    if (hit) this.openConv(hit);
                } else {
                    this.toast('邀请已失效（仓库可能被重建过），让对方重新发起', true);
                    await this.loadConvs();
                }
            } catch (e) {
                this.toast('接受失败：' + (e.message || e), true);
                btn.disabled = false;
                btn.textContent = '接受';
            }
        },

        /** 列出我参与的群（通过仓库名前缀识别） */
        async listGroups() {
            var r = await API.req('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator');
            var mine = Store.me.login.toLowerCase();
            var out = [];
            (r.data || []).forEach(function (repo) {
                if (!Group.isGroup(repo.name)) return;
                out.push({
                    type: 'group',
                    name: repo.name,
                    owner: repo.owner.login,
                    title: repo.name.replace(/^fhgrp-[^-]+-/, '') || '群聊',
                    avatar: null,
                    updatedAt: repo.updated_at,
                    private: repo.private
                });
            });
            return out;
        },

        renderConvs() {
            var list = document.getElementById('conv-list');
            var self = this;
            var kw = this.searchKw;

            var items = this.convs.filter(function (c) {
                if (!kw) return true;
                return String(c.title).toLowerCase().indexOf(kw) >= 0;
            });

            if (!items.length) {
                list.innerHTML = '<div class="loading">' +
                    (kw ? '没有匹配的会话' : '还没有会话，点右上角 ＋ 发起') + '</div>';
                return;
            }

            list.innerHTML = '';
            items.forEach(function (c) {
                var el = document.createElement('div');
                el.className = 'conv-item' +
                    (self.current && self.current.name === c.name ? ' active' : '');

                var img = document.createElement('img');
                img.className = 'conv-avatar' + (c.type === 'group' ? ' group' : '');
                img.src = c.avatar || self.defaultGroupAvatar(c);
                img.alt = '';
                img.onerror = function () { img.src = self.defaultGroupAvatar(c); };
                el.appendChild(img);

                var main = document.createElement('div');
                main.className = 'conv-main';

                var top = document.createElement('div');
                top.className = 'conv-top';
                var nm = document.createElement('span');
                nm.className = 'conv-name';
                nm.textContent = c.type === 'group' ? '👥 ' + c.title : c.title;
                var tm = document.createElement('span');
                tm.className = 'conv-time';
                tm.textContent = c.updatedAt ? self.timeAgo(new Date(c.updatedAt).getTime()) : '';
                top.appendChild(nm);
                top.appendChild(tm);
                main.appendChild(top);

                var pv = document.createElement('div');
                pv.className = 'conv-preview';
                pv.textContent = c.type === 'group' ? '群聊' : '🔒 加密会话';
                main.appendChild(pv);

                el.appendChild(main);

                el.onclick = function () { self.openConv(c); };
                list.appendChild(el);
            });
        },

        /** 群头像：用名字生成纯色块，避免依赖外部图片 */
        defaultGroupAvatar(c) {
            if (c.type === 'dm') {
                return 'https://github.com/' + (c.peer || c.title) + '.png?size=80';
            }
            var colors = ['#07C160', '#1989FA', '#FF976A', '#7232DD', '#FF6034'];
            var s = String(c.name);
            var h = 0;
            for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
            var bg = colors[h % colors.length];
            var ch = String(c.title || '群').slice(0, 1);
            return 'data:image/svg+xml,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">' +
                '<rect width="80" height="80" fill="' + bg + '"/>' +
                '<text x="50%" y="55%" text-anchor="middle" dy=".35em" ' +
                'font-size="38" fill="white" font-family="sans-serif">' +
                ch.replace(/[<>&]/g, '') + '</text></svg>'
            );
        },

        // ── 打开会话 ───────────────────────────────────────────
        async openConv(c) {
            this.current = c;
            this.e2eState = null;
            document.getElementById('app').classList.add('show-chat');

            document.getElementById('chat-head').style.display = '';
            document.getElementById('composer').style.display = '';
            document.getElementById('chat-title').textContent = c.title;
            document.getElementById('chat-sub').textContent =
                c.type === 'group' ? '群聊 · ' + c.name : '🔒 端到端加密';

            // 移动端把会话列表标记为非选中，方便返回时看到状态
            this.renderConvs();

            var box = document.getElementById('messages');
            box.innerHTML = '<div class="loading">载入中…</div>';
            var bar = document.getElementById('e2e-bar');
            bar.style.display = 'none';

            try {
                if (c.type === 'dm') {
                    await this.openDm(c);
                } else {
                    await this.openGroup(c);
                }
            } catch (e) {
                box.innerHTML = '<div class="loading" style="color:#c00">载入失败：' +
                    this.esc(e.message) + '</div>';
                if (global.console) console.error('[打开会话]', e);
            }
        },

        async openDm(c) {
            var e2e = null;
            try {
                e2e = await Chat.setupE2E(c.owner, c.name, Store.me.login, c.peer, Store.branch);
                this.e2eState = e2e;
            } catch (e) {
                e2e = { ready: false, error: e.message };
                this.e2eState = e2e;
            }

            var msgs = await Chat.messages(c.owner, c.name, true, {
                myLogin: Store.me.login,
                peerPub: e2e && e2e.peerPub
            });
            this.renderMessages(msgs);
            this.renderE2EBar(e2e, c);
        },

        async openGroup(c) {
            var meta = await Group.meta(c.owner, c.name);
            this.current.meta = meta;
            document.getElementById('chat-title').textContent = meta.name || c.title;
            document.getElementById('chat-sub').textContent =
                (meta.members ? meta.members.length : 1) + ' 人';

            // 自己先发布公钥，让其他成员能给我分发群密钥
            try {
                await global.E2E.publishPubKey(c.owner, c.name, Store.me.login, Store.branch);
            } catch (e) { /* 没写权限就跳过（还没接受邀请） */ }

            // 如果我有群密钥，顺手给还缺的成员补发
            try {
                var dist = await Group.ensureKeysDistributed(c.owner, c.name);
                if (dist && dist.sent && global.console) {
                    console.log('[群] 补发群密钥给 ' + dist.sent + ' 位成员');
                }
            } catch (e) { /* 补发失败不影响看消息 */ }

            var msgs = await Group.messages(c.owner, c.name, true);
            this.renderMessages(msgs);

            // 群密钥状态
            var bar = document.getElementById('e2e-bar');
            var gk = await Group.groupKey(c.owner, c.name);
            bar.style.display = '';
            if (gk) {
                bar.className = 'e2e-bar ok';
                bar.innerHTML = '🔒 群消息已端到端加密（群密钥）';
            } else {
                bar.className = 'e2e-bar warn';
                bar.innerHTML = '⏳ 等待群密钥分发 — 创建者上线后会自动发给你' +
                    '<button id="gk-retry">重试</button>';
                var self = this;
                var rb = document.getElementById('gk-retry');
                if (rb) rb.onclick = function () {
                    API._ls('fh:gk:' + c.owner + '/' + c.name, null);
                    self.openConv(c);
                };
            }
        },

        renderE2EBar(e2e, c) {
            var bar = document.getElementById('e2e-bar');
            bar.style.display = '';

            if (e2e && e2e.pubKeyChanged) {
                bar.className = 'e2e-bar warn';
                bar.innerHTML = '🔑 对方的密钥变了（通常是换了设备）' +
                    '<button id="reverify-btn">知道了</button>';
                this.bindReverify(c, e2e);
            } else if (e2e && e2e.ready) {
                bar.className = 'e2e-bar ok';
                var sn = e2e.safetyNumber
                    ? '<button id="sn-toggle">安全码</button>' +
                      '<span id="sn-value" class="safety-num" style="display:none">' +
                      e2e.safetyNumber + '</span>' +
                      '<button id="resync-btn" title="密钥不同步时用它">重新同步</button>'
                    : '';
                bar.innerHTML = '🔒 端到端加密已启用 · GitHub 只存密文 ' + sn;
                this.bindSafetyToggle();
            } else if (e2e && e2e.peerPubVanished) {
                bar.className = 'e2e-bar warn';
                bar.innerHTML = '🔑 对方的密钥暂时读不到，本会话将明文发送';
            } else if (e2e && e2e.peerRegistered === false) {
                // 对方从没用过 FaceHub → 没有身份公钥。
                // 这跟"等他上线"是两回事，得说清楚，否则用户会一直等。
                bar.className = 'e2e-bar warn';
                bar.innerHTML = '⏳ ' + this.esc(c.peer) +
                    ' 还没用过 FaceHub，暂时只能明文发送（等他登录一次即可加密）';
            } else {
                bar.className = 'e2e-bar warn';
                bar.innerHTML = '⏳ 等待密钥交换 · 当前消息明文发送';
            }
        },

        bindSafetyToggle() {
            var self = this;
            var btn = document.getElementById('sn-toggle');
            var val = document.getElementById('sn-value');
            if (btn && val) {
                btn.onclick = function () {
                    var show = val.style.display === 'none';
                    val.style.display = show ? '' : 'none';
                    btn.textContent = show ? '隐藏' : '安全码';
                };
            }
            var rb = document.getElementById('resync-btn');
            if (rb) rb.onclick = function () { self.resyncKey(); };
        },

        bindReverify(c, e2e) {
            var self = this;
            var btn = document.getElementById('reverify-btn');
            if (!btn) return;
            btn.onclick = function () {
                global.E2E.markVerified(Store.me.login, c.name, e2e.peerPub);
                e2e.verified = true;
                e2e.pubKeyChanged = false;
                self.renderE2EBar(e2e, c);
                self.toast('已记录新密钥');
            };
        },

        // ── 消息渲染 ───────────────────────────────────────────
        renderMessages(msgs) {
            var box = document.getElementById('messages');
            var myLogin = Store.me.login;
            var self = this;

            box.innerHTML = '';
            if (!msgs.length) {
                box.innerHTML = '<div class="welcome"><p>还没有消息，说第一句吧</p></div>';
                return;
            }

            msgs.forEach(function (m) {
                var mine = String(m.from).toLowerCase() === myLogin.toLowerCase();
                var row = document.createElement('div');
                row.className = 'msg-row' + (mine ? ' mine' : '');

                var img = document.createElement('img');
                img.className = 'msg-avatar';
                img.src = m.avatar || ('https://github.com/' + m.from + '.png?size=56');
                img.alt = '';
                img.onerror = function () { img.style.visibility = 'hidden'; };
                row.appendChild(img);

                var body = document.createElement('div');
                body.className = 'msg-body';

                // 群里显示发送者名字（自己的不显示）
                if (self.current && self.current.type === 'group' && !mine) {
                    var s = document.createElement('div');
                    s.className = 'msg-sender';
                    s.textContent = m.from;
                    body.appendChild(s);
                }

                var b = document.createElement('div');
                b.className = 'bubble' +
                    (m.encrypted ? ' encrypted' : '') +
                    (m.locked ? ' locked' : '');
                b.textContent = m.text;
                if (m.encrypted) b.title = '端到端加密 · GitHub 只存了密文';
                body.appendChild(b);

                if (m.locked && m.id) {
                    var del = document.createElement('button');
                    del.className = 'bubble-del';
                    del.textContent = '删除';
                    del.onclick = function () { self.deleteMessage(m.id); };
                    body.appendChild(del);
                }

                var meta = document.createElement('div');
                meta.className = 'msg-meta';
                meta.textContent = self.timeAgo(m.ts);
                body.appendChild(meta);

                row.appendChild(body);
                box.appendChild(row);
            });

            box.scrollTop = box.scrollHeight;
        },

        // ── 发送 ───────────────────────────────────────────────
        async sendMessage() {
            var input = document.getElementById('msg-input');
            var c = this.current;
            if (!c) return;
            var text = (input.value || '').trim();
            if (!text) return;

            var btn = document.getElementById('send-btn');
            btn.disabled = true;
            input.value = '';

            var self = this;
            try {
                var r;
                if (c.type === 'dm') {
                    var e2e = this.e2eState || {};
                    r = await Chat.send(c.owner, c.name, text, {
                        myLogin: Store.me.login,
                        peerPub: e2e.peerPub
                    });
                    if (r && r.__encError) {
                        this.toast('⚠️ 加密失败，明文发送：' + r.__encError, true);
                    } else if (r && r.__encrypted === false && e2e.peerReady === false) {
                        this.toast('⚠️ 对方还没上线，本条明文发送');
                    }
                    var msgs = await Chat.messages(c.owner, c.name, true, {
                        myLogin: Store.me.login,
                        peerPub: e2e.peerPub
                    });
                    this.renderMessages(msgs);
                } else {
                    r = await Group.send(c.owner, c.name, text);
                    if (r && r.__encrypted === false) {
                        this.toast('⚠️ 还没有群密钥，本条明文发送');
                    }
                    var gmsgs = await Group.messages(c.owner, c.name, true);
                    this.renderMessages(gmsgs);
                }
                await this.loadConvs();
            } catch (e) {
                this.toast('发送失败：' + (e && e.message ? e.message : e), true);
                input.value = text;
                if (global.console) console.error('[发送]', e);
            } finally {
                // 放 finally：哪怕上面任何一步抛错，按钮也必须恢复
                btn.disabled = false;
            }
        },

        async deleteMessage(id) {
            var c = this.current;
            if (!c) return;
            if (!global.confirm('删除这条无法解密的消息？')) return;
            try {
                await API.deleteMessage(c.owner, c.name, id);
                API._ls('fh:msg:' + c.owner + '/' + c.name, null);
                this.toast('已删除');
                await this.openConv(c);
            } catch (e) {
                this.toast('删除失败：' + e.message +
                    (e.status === 403 ? '（只能删自己发的）' : ''), true);
            }
        },

        async resyncKey() {
            var c = this.current;
            if (!c) return;
            if (!global.confirm('重新同步密钥？\n\n之前解不开的密文将永久无法恢复。')) return;
            try {
                await Chat.resyncKey(c.owner, c.name, Store.me.login, Store.branch);
                this.toast('已重新生成密钥');
                await this.openConv(c);
            } catch (e) {
                this.toast('同步失败：' + e.message, true);
            }
        },

        // ── 新建会话 ───────────────────────────────────────────
        openNew() {
            document.getElementById('new-modal').style.display = '';
            setTimeout(function () {
                var f = document.getElementById('dm-peer');
                if (f) f.focus();
            }, 60);
        },
        closeNew() {
            document.getElementById('new-modal').style.display = 'none';
        },

        async createConv() {
            var mode = document.querySelector('.seg-btn.active');
            mode = mode ? mode.getAttribute('data-mode') : 'dm';
            var self = this;
            var ok = document.getElementById('new-ok');
            ok.disabled = true;
            ok.textContent = '处理中…';

            try {
                if (mode === 'dm') {
                    var peer = (document.getElementById('dm-peer').value || '').trim();
                    if (!peer) throw new Error('请输入用户名');
                    var room = await Chat.start(peer);
                    this.closeNew();
                    this.toast(room.existed ? '已有会话' : '会话已创建，已邀请 ' + peer);
                    await this.loadConvs();
                    var hit = this.convs.filter(function (c) {
                        return c.type === 'dm' && c.peer.toLowerCase() === peer.toLowerCase();
                    })[0];
                    if (hit) this.openConv(hit);
                } else {
                    var name = (document.getElementById('group-name').value || '').trim();
                    var raw = (document.getElementById('group-members').value || '').trim();
                    var members = raw ? raw.split(/[,，\s]+/).filter(Boolean) : [];
                    if (!name) throw new Error('请输入群名称');

                    this.toast('正在创建群…');
                    // Group.create 内部已把群密钥写入本地缓存
                    var g = await Group.create(name, members);
                    this.closeNew();
                    // 必须说明延迟：GitHub 邀请要几分钟才出现在对方列表里，
                    // 不说的话用户会以为邀请没发出去
                    this.toast(members.length
                        ? '群已创建。邀请已发出，成员可能要几分钟后才能看到（GitHub 延迟）'
                        : '群已创建', false);
                    await this.loadConvs();
                    var gh = this.convs.filter(function (c) {
                        return c.type === 'group' && c.name === g.name;
                    })[0];
                    if (gh) this.openConv(gh);
                }
            } catch (e) {
                this.toast('创建失败：' + (e.message || e), true);
            } finally {
                ok.disabled = false;
                ok.textContent = '创建';
            }
        },

        // ── 会话详情 ───────────────────────────────────────────
        async openInfo() {
            var c = this.current;
            if (!c) return;
            var body = document.getElementById('info-body');
            body.innerHTML = '<div class="loading">载入中…</div>';
            document.getElementById('info-modal').style.display = '';

            var rows = [];
            rows.push(['类型', c.type === 'group' ? '群聊' : '单聊']);
            rows.push(['仓库', c.name]);

            if (c.type === 'group') {
                try {
                    var meta = await Group.meta(c.owner, c.name);
                    rows.push(['群名', this.esc(meta.name || '-')]);
                    rows.push(['创建者', this.esc(meta.creator || '-')]);
                    rows.push(['成员', (meta.members || []).join('、') || '-']);
                } catch (e) {
                    rows.push(['成员', '读取失败']);
                }
            } else {
                rows.push(['对方', this.esc(c.peer || '-')]);
                if (this.e2eState && this.e2eState.ready) {
                    rows.push(['安全码', this.e2eState.safetyNumber || '-']);
                }
            }

            var html = '';
            rows.forEach(function (r) {
                html += '<div class="info-row"><span class="info-label">' +
                    r[0] + '</span><span>' + r[1] + '</span></div>';
            });
            html += '<div class="info-row"><span class="info-label">密钥备份</span>' +
                '<button id="info-key-btn" class="btn-soft btn-sm">打开</button></div>';
            body.innerHTML = html;

            var self = this;
            var kb = document.getElementById('info-key-btn');
            if (kb) kb.onclick = function () { self.openKeyModal(); };
        },

        // ── 密钥备份 ───────────────────────────────────────────
        openKeyModal() {
            document.getElementById('key-modal').style.display = '';
            var rooms = global.E2E.listBackedUpRooms();
            document.getElementById('key-count').textContent = rooms.length
                ? '本机已有 ' + rooms.length + ' 个会话的密钥'
                : '本机还没有密钥。打开一次会话就会生成。';
        },

        genBackup() {
            if (!global.E2E) return this.toast('加密模块未加载', true);
            try {
                var txt = global.E2E.exportBackup();
                document.getElementById('key-backup-text').value = txt;
                var n = global.E2E.listBackedUpRooms().length;
                this.toast(n ? '已生成 ' + n + ' 个会话的备份' : '还没有密钥可备份');
            } catch (e) {
                this.toast('生成失败：' + e.message, true);
            }
        },

        async copyBackup() {
            var ta = document.getElementById('key-backup-text');
            if (!ta.value) return this.toast('请先点「生成备份」', true);
            var self = this;
            var done = function () { self.toast('已复制'); };
            try {
                await navigator.clipboard.writeText(ta.value);
                done();
            } catch (e) {
                ta.removeAttribute('readonly');
                ta.select();
                try { document.execCommand('copy'); done(); }
                catch (e2) { self.toast('复制失败，请手动全选', true); }
                ta.setAttribute('readonly', '');
            }
        },

        downloadBackup() {
            var ta = document.getElementById('key-backup-text');
            if (!ta.value) return this.toast('请先点「生成备份」', true);
            var blob = new Blob([ta.value], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'facehub-keys-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.toast('已下载');
        },

        doImportBackup() {
            var txt = document.getElementById('key-import-text').value.trim();
            if (!txt) return this.toast('请先粘贴备份内容', true);
            var overwrite = document.getElementById('key-overwrite').checked;
            var r = global.E2E.importBackup(txt, overwrite);
            if (r.error) return this.toast(r.error, true);
            var msg = '已导入 ' + r.imported + ' 个密钥';
            if (r.skipped) msg += '，跳过 ' + r.skipped + ' 个';
            this.toast(msg);
            document.getElementById('key-import-text').value = '';
            if (r.imported && this.current) this.openConv(this.current);
        },

        // ── 轮询（轻量）─────────────────────────────────────────
        startPolling() {
            var self = this;
            // 只在有打开会话时刷新消息，避免空转耗配额
            setInterval(function () {
                if (!self.current) return;
                if (document.hidden) return;
                self.refreshCurrent();
            }, 15000);
        },

        async refreshCurrent() {
            var c = this.current;
            if (!c) return;
            try {
                if (c.type === 'dm') {
                    var e2e = this.e2eState || {};
                    var msgs = await Chat.messages(c.owner, c.name, true, {
                        myLogin: Store.me.login,
                        peerPub: e2e.peerPub
                    });
                    this.renderMessages(msgs);
                } else {
                    var g = await Group.messages(c.owner, c.name, true);
                    this.renderMessages(g);
                }
            } catch (e) { /* 轮询失败静默，不打扰用户 */ }
        },

        // ── 工具 ───────────────────────────────────────────────
        timeAgo(ts) {
            var d = Date.now() - ts;
            if (d < 60000) return '刚刚';
            if (d < 3600000) return Math.floor(d / 60000) + '分钟前';
            if (d < 86400000) return Math.floor(d / 3600000) + '小时前';
            var dt = new Date(ts);
            if (d < 604800000) return Math.floor(d / 86400000) + '天前';
            return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
        },

        esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },

        toast(msg, isErr) {
            var t = document.getElementById('toast');
            if (!t) return;
            t.textContent = msg;
            t.className = 'toast' + (isErr ? ' error' : '');
            t.style.display = '';
            clearTimeout(this._tt);
            this._tt = setTimeout(function () { t.style.display = 'none'; }, isErr ? 4500 : 2400);
        }
    };

    API.onStats = function () { /* 配额显示暂时移除 */ };

    global.App = App;
    document.addEventListener('DOMContentLoaded', function () { App.boot(); });
})(window);
