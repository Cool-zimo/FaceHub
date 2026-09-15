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

        // ── 本地昵称 ───────────────────────────────────────────
        //
        // 昵称是**我怎么看对方**，跟群名不一样：
        //   · 昵称 → 只有我自己看到，存 localStorage
        //   · 群名 → 所有人共享，写进 group.json
        //
        // 这点必须分清，否则会把私人备注同步给别人（微信的"备注"和
        // "群名称"也是两回事）。
        nickKey: function (owner, repo) {
            return 'fh:nick:' + owner + '/' + repo;
        },
        getNick: function (owner, repo) {
            return this.ls(this.nickKey(owner, repo)) || '';
        },
        setNick: function (owner, repo, nick) {
            var v = String(nick || '').trim();
            this.ls(this.nickKey(owner, repo), v || null);
        },

        /** 会话显示名：昵称优先，否则群名 / 对方用户名 */
        displayName: function (c) {
            if (!c) return '';
            var nick = this.getNick(c.owner, c.name);
            if (nick) return nick;
            if (c.type === 'group') return c.meta && c.meta.name ? c.meta.name : c.title;
            return c.title;
        },

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

            // ★ 轮询必须在 loadConvs 之前启动，且包在 finally 里。
            // 之前放在最后：loadConvs 一旦抛异常，startPolling 就永远
            // 执行不到 —— 表现为"对方发了消息，我这边刷新才看得到"。
            this.startPolling();

            try {
                await this.loadConvs();
            } catch (e) {
                if (global.console) console.error('[启动] 载入会话失败', e);
                this.toast('载入会话列表失败：' + (e.message || e), true);
            }
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

            // 附件
            document.getElementById('attach-btn').onclick = function () {
                self.sendAttachment();
            };

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

        /**
         * 切换底部/侧边 Tab
         *
         * 通讯录不是"新建会话"按钮的别名 —— 微信里它是人列表。
         * 这里渲染所有单聊对象（即通讯录里的人），
         * 待接受的邀请放在「新的朋友」那一块。
         */
        switchTab(tab) {
            if (tab === 'me') {
                this.openKeyModal();
                return;
            }
            this.view = (tab === 'contacts') ? 'contacts' : 'chats';
            this.renderConvs();
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
                    // 已解除绑定的不再出现
                    if (this.ls('fh:hidden:' + r.owner + '/' + r.name)) return;
                    convs.push({
                        type: 'dm',
                        name: r.name,
                        owner: r.owner,
                        title: r.peer,
                        peer: r.peer,
                        avatar: 'https://github.com/' + r.peer + '.png?size=80',
                        updatedAt: r.updatedAt
                    });
                }, this);
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
            var out = [];
            (r.data || []).forEach(function (repo) {
                if (!Group.isGroup(repo.name)) return;
                // 已解除绑定的不再出现
                if (this.ls('fh:hidden:' + repo.owner.login + '/' + repo.name)) return;
                out.push({
                    type: 'group',
                    name: repo.name,
                    owner: repo.owner.login,
                    title: repo.name.replace(/^fhgrp-[^-]+-/, '') || '群聊',
                    avatar: null,
                    updatedAt: repo.updated_at,
                    private: repo.private
                });
            }, this);
            return out;
        },

        renderConvs() {
            var list = document.getElementById('conv-list');
            var self = this;
            var kw = this.searchKw;
            var isContacts = this.view === 'contacts';

            var items = this.convs.filter(function (c) {
                // 通讯录只列人（单聊），群聊在"聊天"里
                if (isContacts && c.type !== 'dm') return false;
                if (!kw) return true;
                // 搜索时昵称也要能命中
                var hay = String(self.displayName(c) + ' ' + c.title + ' ' + (c.peer || '')).toLowerCase();
                return hay.indexOf(kw) >= 0;
            });

            list.innerHTML = '';

            // 通讯录：待接受的邀请就是「新的朋友」
            if (isContacts && this.invites && this.invites.length) {
                var h = document.createElement('div');
                h.className = 'list-sep';
                h.textContent = '新的朋友';
                list.appendChild(h);
                this.invites.forEach(function (inv) {
                    var el = document.createElement('div');
                    el.className = 'conv-item';
                    var img = document.createElement('img');
                    img.className = 'conv-avatar';
                    img.src = 'https://github.com/' + inv.peer + '.png?size=80';
                    img.alt = '';
                    el.appendChild(img);
                    var main = document.createElement('div');
                    main.className = 'conv-main';
                    var nm = document.createElement('div');
                    nm.className = 'conv-name';
                    nm.textContent = inv.peer + (inv.isGroup ? '（拉你进群）' : '');
                    var pv = document.createElement('div');
                    pv.className = 'conv-preview';
                    pv.textContent = '请求添加你为好友';
                    main.appendChild(nm);
                    main.appendChild(pv);
                    el.appendChild(main);
                    var acc = document.createElement('button');
                    acc.className = 'invite-accept';
                    acc.textContent = '接受';
                    acc.onclick = function (e) {
                        e.stopPropagation();
                        self.acceptInvite(inv, acc);
                    };
                    el.appendChild(acc);
                    list.appendChild(el);
                });
                var h2 = document.createElement('div');
                h2.className = 'list-sep';
                h2.textContent = '联系人';
                list.appendChild(h2);
            }

            if (!items.length) {
                var empty = document.createElement('div');
                empty.className = 'loading';
                empty.textContent = kw ? '没有匹配的会话'
                    : (isContacts ? '还没有联系人' : '还没有会话，点右上角 ＋ 发起');
                list.appendChild(empty);
                return;
            }

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
                // 昵称优先（我自己的备注），群聊显示群名
                nm.textContent = (c.type === 'group' ? '👥 ' : '') + self.displayName(c);
                var tm = document.createElement('span');
                tm.className = 'conv-time';
                if (!isContacts) {
                    tm.textContent = c.updatedAt
                        ? self.timeAgo(new Date(c.updatedAt).getTime()) : '';
                }
                top.appendChild(nm);
                top.appendChild(tm);
                main.appendChild(top);

                if (!isContacts) {
                    var pv = document.createElement('div');
                    pv.className = 'conv-preview';
                    pv.textContent = c.type === 'group' ? '群聊' : '🔒 加密会话';
                    main.appendChild(pv);
                }

                el.appendChild(main);

                // 未读红点（只在"聊天"tab 显示）
                if (!isContacts && self.isUnread(c)) {
                    var dot = document.createElement('i');
                    dot.className = 'conv-badge';
                    dot.textContent = '';
                    el.appendChild(dot);
                }

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
            this._lastSig = null;        // 换会话，指纹必须重置
            this.markSeen(c, Date.now());
            document.getElementById('app').classList.add('show-chat');

            document.getElementById('chat-head').style.display = '';
            document.getElementById('composer').style.display = '';
            document.getElementById('chat-title').textContent = this.displayName(c);
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
            // 昵称是本地备注，优先级最高；否则用群名（所有人共享）
            document.getElementById('chat-title').textContent =
                this.getNick(c.owner, c.name) || meta.name || c.title;
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

            // 记住滚动位置：正在翻历史的人不该被轮询拽回底部
            var wasAtBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
            var keepTop = box.scrollTop;

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

                // 附件：本地刚上传的用 m.att（含 dataUrl，秒开），
                // 服务器来的用信封解析。pending 也要解析，
                // 否则会露出 FHATT1:{...} 这种原始串。
                var att = null;
                if (global.Attach && !m.locked) {
                    att = m.att || Attach.parse(m.text);
                }

                var b = document.createElement('div');
                b.className = 'bubble' +
                    (m.encrypted ? ' encrypted' : '') +
                    (m.locked ? ' locked' : '') +
                    (m.pending ? ' pending' : '') +
                    (m.failed ? ' failed' : '') +
                    (att ? ' bubble-att' : '');
                if (m.encrypted) b.title = '端到端加密 · GitHub 只存了密文';
                if (m.pending) b.title = '发送中…';
                if (m.failed) b.title = '发送失败：' + (m.error || '');

                if (att) {
                    // 附件消息：渲染媒体预览而不是文本
                    Attach.render(b, att, { owner: self.current.owner, repo: self.current.name });
                } else {
                    b.textContent = m.text;
                }
                body.appendChild(b);

                if (m.failed) {
                    var retry = document.createElement('button');
                    retry.className = 'bubble-del';
                    retry.textContent = '重试';
                    retry.onclick = function () {
                        self._removePending(m.id);
                        var inp = document.getElementById('msg-input');
                        inp.value = m.text;
                        self._rerenderWithPending();
                        inp.focus();
                    };
                    body.appendChild(retry);
                    var drop = document.createElement('button');
                    drop.className = 'bubble-del';
                    drop.textContent = '删除';
                    drop.onclick = function () {
                        self._removePending(m.id);
                        self._rerenderWithPending();
                    };
                    body.appendChild(drop);
                }

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

            // 只在原本就贴着底部时才跟到底部；否则维持原位置
            if (wasAtBottom) box.scrollTop = box.scrollHeight;
            else box.scrollTop = keepTop;
        },

        // ── 发送 ───────────────────────────────────────────────
        /**
         * 发消息（乐观更新）
         *
         * ★ 为什么必须乐观更新：
         * 原来的流程是"发送 → 等 GitHub 返回 → 重新拉取 → 渲染"，
         * 消息要等整个网络往返（几百毫秒到几秒）才出现，
         * 而且一旦写入后读取有延迟（GitHub 各 CDN 节点不一致），
         * 自己刚发的消息就是看不到 —— 只能刷新页面。
         *
         * 改成：本地**先上屏**（微信也是这么做的），网络结果后到再校正。
         * 这样"发完立刻看到自己的消息"不再依赖网络，是必然的。
         */
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

            // ① 立即上屏（本地气泡，标记 pending）
            var temp = {
                id: 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
                from: Store.me.login,
                avatar: Store.me.avatar_url,
                text: text,
                raw: text,
                ts: Date.now(),
                pending: true
            };
            this._pending.push(temp);
            this._rerenderWithPending();

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
                } else {
                    r = await Group.send(c.owner, c.name, text);
                    if (r && r.__encrypted === false) {
                        this.toast('⚠️ 还没有群密钥，本条明文发送');
                    }
                }

                // ② 发送成功：撤掉本地气泡，换成服务器上的真实数据
                this._removePending(temp.id);

                // 发过的消息 ETag 一定变了，强制重拉一次避免拿到旧缓存
                API.clearMessageCache(c.owner, c.name);

                var msgs;
                if (c.type === 'dm') {
                    var e2e2 = this.e2eState || {};
                    msgs = await Chat.messages(c.owner, c.name, true, {
                        myLogin: Store.me.login,
                        peerPub: e2e2.peerPub
                    });
                } else {
                    msgs = await Group.messages(c.owner, c.name, true);
                }

                // 极端情况：服务器还没返回这条（写入传播延迟），
                // 那就继续显示本地气泡，别让它凭空消失
                if (!this._containsText(msgs, text)) {
                    temp.pending = false;
                    this._pending.push(temp);
                }
                this._rerenderWithPending(msgs);

                // 列表顺序变了（最后更新时间）
                this.loadConvs();
            } catch (e) {
                // ③ 失败：气泡留在界面上，标红 + 可重试，不吞掉用户输入
                temp.pending = false;
                temp.failed = true;
                temp.error = e && e.message ? e.message : String(e);
                this._rerenderWithPending();
                this.toast('发送失败：' + temp.error, true);
                if (global.console) console.error('[发送]', e);
            } finally {
                btn.disabled = false;
            }
        },

        /** 待确认的本地消息（乐观更新用） */
        _pending: [],

        // ── 附件 ───────────────────────────────────────────────
        async sendAttachment() {
            var c = this.current;
            if (!c) return;

            var files = await Attach.pick(false);
            if (!files || !files.length) return;

            var parts = Attach.partition(files);
            if (parts.tooBig.length) {
                this.toast('「' + parts.tooBig[0].name + '」超过 ' +
                    Attach.size(Attach.MAX_SIZE) + '，已跳过', true);
            }
            if (!parts.ok.length) return;

            var file = parts.ok[0];
            var self = this;

            // 乐观上屏：先占位，显示"上传中"
            var temp = {
                id: 'tmp-att-' + Date.now(),
                from: Store.me.login,
                avatar: Store.me.avatar_url,
                text: '正在上传 ' + file.name + '…',
                raw: '',
                ts: Date.now(),
                pending: true
            };
            this._pending.push(temp);
            this._rerenderWithPending();

            try {
                var att = await Attach.upload(c.owner, c.name, file, function (stage) {
                    if (stage === 'uploading') {
                        temp.text = '正在上传 ' + file.name + '…';
                        self._rerenderWithPending();
                    }
                });

                // 上传完：把占位换成真实附件气泡（本地 dataUrl，秒开）
                temp.text = Attach.encode(att);
                temp.raw = temp.text;
                // 字段统一成信封格式（n/t/s/p），渲染时不用再判断来源
                temp.att = {
                    n: att.name, t: att.type, s: att.size,
                    p: att.path, dataUrl: att.dataUrl
                };

                // 发消息（走正常加密流程）
                if (c.type === 'dm') {
                    var e2e = this.e2eState || {};
                    await Chat.send(c.owner, c.name, temp.text, {
                        myLogin: Store.me.login,
                        peerPub: e2e.peerPub
                    });
                } else {
                    await Group.send(c.owner, c.name, temp.text);
                }

                this._removePending(temp.id);
                API.clearMessageCache(c.owner, c.name);

                var msgs = await this._reloadCurrent();
                // 服务器可能还没同步到这条，继续显示本地气泡
                if (!this._containsText(msgs, temp.text)) {
                    temp.pending = false;
                    this._pending.push(temp);
                }
                this._rerenderWithPending(msgs);
                this.loadConvs();
            } catch (e) {
                temp.pending = false;
                temp.failed = true;
                temp.error = e.message;
                temp.text = file.name + '（发送失败）';
                this._rerenderWithPending();
                this.toast('附件发送失败：' + (e.message || e), true);
                if (global.console) console.error('[附件]', e);
            }
        },

        /** 重新拉当前会话消息（单聊/群聊分流） */
        async _reloadCurrent() {
            var c = this.current;
            if (!c) return [];
            if (c.type === 'dm') {
                var e2e = this.e2eState || {};
                return await Chat.messages(c.owner, c.name, true, {
                    myLogin: Store.me.login,
                    peerPub: e2e.peerPub
                });
            }
            return await Group.messages(c.owner, c.name, true);
        },

        _removePending: function (id) {
            this._pending = this._pending.filter(function (p) {
                return p.id !== id;
            });
        },

        /** 服务器列表里是否已有这条（按内容+发送者比对） */
        _containsText: function (msgs, text) {
            if (!msgs) return false;
            var me = Store.me.login.toLowerCase();
            for (var i = msgs.length - 1; i >= 0 && i >= msgs.length - 8; i--) {
                var m = msgs[i];
                if (String(m.from).toLowerCase() !== me) continue;
                // 服务端返回的是密文，比 raw；明文则比 text
                if (m.raw === text || m.text === text) return true;
            }
            return false;
        },

        /** 用「服务器列表 + 未确认气泡」重绘 */
        _rerenderWithPending: function (msgs) {
            if (msgs) this._currentMsgs = msgs;
            var all = (this._currentMsgs || []).concat(this._pending);
            this.renderMessages(all, true);
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
                    // 之前解除绑定过 → 清掉隐藏标记，让它重新出现在列表
                    this.ls('fh:hidden:' + room.owner + '/' + room.name, null);
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

        // ── 会话详情 / 管理面板 ────────────────────────────────
        /**
         * 管理面板
         *
         * 分四块，风险从低到高排列，危险操作一律红色 + 二次确认：
         *   ① 名称（昵称本地 / 群名共享）
         *   ② 成员（仅群聊）
         *   ③ 信息（仓库、安全码）
         *   ④ 危险操作（清空记录、解除绑定）
         */
        async openInfo() {
            var c = this.current;
            if (!c) return;
            var body = document.getElementById('info-body');
            body.innerHTML = '<div class="loading">载入中…</div>';
            document.getElementById('info-modal').style.display = '';

            var meta = null;
            if (c.type === 'group') {
                try { meta = await Group.meta(c.owner, c.name); }
                catch (e) { meta = { name: c.title, members: [], creator: c.owner }; }
                this.current.meta = meta;
            }

            var html = '';

            // ═══ ① 名称 ═══
            html += '<h4 class="sec-h">名称</h4>';

            var nick = this.getNick(c.owner, c.name);
            html += '<div class="info-row">' +
                '<span class="info-label">备注名<br><i class="lbl-tip">只有你自己看到</i></span>' +
                '<span class="edit-cell">' +
                '<input id="nick-input" class="inline-input" value="' + this.esc(nick) +
                '" placeholder="' + this.esc(c.type === 'group' ? '群备注' : '备注名') + '">' +
                '<button id="nick-save" class="btn-soft btn-sm">保存</button>' +
                '</span></div>';

            if (c.type === 'group') {
                html += '<div class="info-row">' +
                    '<span class="info-label">群名称<br><i class="lbl-tip">所有成员可见</i></span>' +
                    '<span class="edit-cell">' +
                    '<input id="gname-input" class="inline-input" value="' +
                    this.esc(meta.name || c.title) + '" placeholder="群名称">' +
                    '<button id="gname-save" class="btn-soft btn-sm">保存</button>' +
                    '</span></div>';
            }

            // ═══ ② 成员（仅群聊）═══
            if (c.type === 'group') {
                var members = meta.members || [];
                html += '<h4 class="sec-h">成员（' + members.length + '）</h4>';
                html += '<div id="member-list">';
                if (!members.length) {
                    html += '<div class="info-row"><span class="info-label">暂无成员</span></div>';
                } else {
                    var myLogin = Store.me.login;
                    members.forEach(function (m) {
                        var isMe = String(m).toLowerCase() === myLogin.toLowerCase();
                        var isCreator = String(m) === String(meta.creator);
                        html += '<div class="info-row">' +
                            '<span>' + this.esc(m) +
                            (isCreator ? ' <i class="tag">创建者</i>' : '') +
                            (isMe ? ' <i class="tag">我</i>' : '') + '</span>';
                        if (!isMe) {
                            html += '<button class="btn-danger btn-sm" data-remove="' +
                                this.esc(m) + '">移除</button>';
                        }
                        html += '</div>';
                    }, this);
                }
                html += '</div>';
                html += '<div class="info-row">' +
                    '<input id="new-member" class="inline-input grow" placeholder="添加成员（GitHub 用户名）">' +
                    '<button id="add-member-btn" class="btn-primary btn-sm">添加</button>' +
                    '</div>';
                html += '<p class="hint">群名任何成员都能改（共享仓库的必然结果）。' +
                    '移除成员会同时轮换群密钥。</p>';
            }

            // ═══ ③ 信息 ═══
            html += '<h4 class="sec-h">信息</h4>';
            html += '<div class="info-row"><span class="info-label">类型</span><span>' +
                (c.type === 'group' ? '群聊' : '单聊') + '</span></div>';
            html += '<div class="info-row"><span class="info-label">仓库</span>' +
                '<span class="mono">' + this.esc(c.name) + '</span></div>';
            if (c.type !== 'group') {
                html += '<div class="info-row"><span class="info-label">对方</span><span>' +
                    this.esc(c.peer || '-') + '</span></div>';
            }
            if (this.e2eState && this.e2eState.ready && this.e2eState.safetyNumber) {
                html += '<div class="info-row"><span class="info-label">安全码</span>' +
                    '<span class="mono">' + this.e2eState.safetyNumber + '</span></div>';
            }
            html += '<div class="info-row"><span class="info-label">密钥备份</span>' +
                '<button id="info-key-btn" class="btn-soft btn-sm">打开</button></div>';

            // ═══ ④ 危险操作 ═══
            html += '<h4 class="sec-h danger">危险操作</h4>';
            html += '<div class="info-row">' +
                '<span class="info-label">清空聊天记录<br>' +
                '<i class="lbl-tip">删除本会话所有消息</i></span>' +
                '<button id="clear-msgs-btn" class="btn-danger btn-sm">清空</button></div>';
            html += '<div class="info-row">' +
                '<span class="info-label">' +
                (c.type === 'group' ? '退出并解除绑定' : '解除绑定') + '<br>' +
                '<i class="lbl-tip">' +
                (c.type === 'group' ? '从群里退出，不再收到消息' : '从我的列表移除') +
                '</i></span>' +
                '<button id="unbind-btn" class="btn-danger btn-sm">解除</button></div>';
            if (c.type === 'group' &&
                String(c.owner).toLowerCase() === Store.me.login.toLowerCase()) {
                html += '<div class="info-row">' +
                    '<span class="info-label">删除整个群<br>' +
                    '<i class="lbl-tip">你是创建者，可彻底删除仓库</i></span>' +
                    '<button id="del-group-btn" class="btn-danger btn-sm">删除</button></div>';
            }

            body.innerHTML = html;
            this.bindInfoActions(c, meta);
        },

        bindInfoActions(c, meta) {
            var self = this;

            var kb = document.getElementById('info-key-btn');
            if (kb) kb.onclick = function () { self.openKeyModal(); };

            // ── 备注名（本地）──
            var ns = document.getElementById('nick-save');
            if (ns) ns.onclick = function () {
                var v = document.getElementById('nick-input').value;
                self.setNick(c.owner, c.name, v);
                c.title = v || (c.type === 'group'
                    ? (meta && meta.name) || c.title
                    : c.peer);
                self.toast(v ? '备注已保存' : '已清除备注');
                self.renderConvs();
                document.getElementById('chat-title').textContent = self.displayName(c);
            };

            // ── 群名（共享）──
            var gs = document.getElementById('gname-save');
            if (gs) gs.onclick = function () {
                var v = (document.getElementById('gname-input').value || '').trim();
                if (!v) return self.toast('群名不能为空', true);
                gs.disabled = true;
                Group.rename(c.owner, c.name, v).then(function (m) {
                    self.current.meta = m;
                    self.toast('群名已更新（所有成员可见）');
                    self.renderConvs();
                    if (!self.getNick(c.owner, c.name)) {
                        document.getElementById('chat-title').textContent = v;
                    }
                    self.openInfo();
                }).catch(function (e) {
                    self.toast('改名失败：' + e.message, true);
                    gs.disabled = false;
                });
            };

            // ── 添加成员 ──
            var am = document.getElementById('add-member-btn');
            if (am) am.onclick = function () {
                var inp = document.getElementById('new-member');
                var who = (inp.value || '').trim();
                if (!who) return self.toast('请输入用户名', true);
                am.disabled = true;
                am.textContent = '…';
                var gk = API._ls('fh:gk:' + c.owner + '/' + c.name);
                Group.addMember(c.owner, c.name, who, gk).then(function (r) {
                    self.toast(r.keySent
                        ? '已邀请 ' + who + '，群密钥同时发出'
                        : '已邀请 ' + who + '（他登录后会收到群密钥）');
                    inp.value = '';
                    return self.openInfo();
                }).then(function () {
                    return self.loadConvs();
                }).catch(function (e) {
                    self.toast('添加失败：' + e.message, true);
                    am.disabled = false;
                    am.textContent = '添加';
                });
            };

            // ── 移除成员 ──
            Array.prototype.forEach.call(
                document.querySelectorAll('[data-remove]'),
                function (btn) {
                    btn.onclick = function () {
                        var who = btn.getAttribute('data-remove');
                        if (!global.confirm(
                            '移除 ' + who + '？\n\n' +
                            '他将无法再访问本群，且群密钥会立即轮换\n' +
                            '（他之前缓存的历史消息仍在他自己设备上）。'
                        )) return;
                        btn.disabled = true; btn.textContent = '…';
                        Group.removeMember(c.owner, c.name, who).then(function (r) {
                            self.toast('已移除 ' + who + (r.rotated ? '，群密钥已轮换' : ''));
                            return self.openInfo();
                        }).then(function () { return self.loadConvs(); })
                          .catch(function (e) {
                              self.toast('移除失败：' + e.message, true);
                              btn.disabled = false; btn.textContent = '移除';
                          });
                    };
                }
            );

            // ── 清空聊天记录 ──
            var cm = document.getElementById('clear-msgs-btn');
            if (cm) cm.onclick = function () {
                if (!global.confirm(
                    '清空本会话的全部聊天记录？\n\n' +
                    '· 逐条删除，消息多时可能需要几秒\n' +
                    '· 对方发的消息你删不掉（GitHub 只允许删自己的）\n' +
                    '· 此操作不可恢复'
                )) return;
                cm.disabled = true;
                API.clearMessages(c.owner, c.name, 1, function (done, total, failed) {
                    cm.textContent = done + '/' + total;
                }).then(function (r) {
                    var msg = '已删除 ' + r.deleted + ' 条';
                    if (r.failed) msg += '，' + r.failed + ' 条对方发的删不掉';
                    self.toast(msg, r.failed > 0);
                    API.clearMessageCache(c.owner, c.name);
                    return self.openConv(c);
                }).then(function () { return self.loadConvs(); })
                  .catch(function (e) {
                      self.toast('清空失败：' + e.message, true);
                  }).then(function () {
                      cm.disabled = false; cm.textContent = '清空';
                  });
            };

            // ── 解除绑定 ──
            var ub = document.getElementById('unbind-btn');
            if (ub) ub.onclick = function () {
                self.unbind(c, ub);
            };

            // ── 删除整个群（仅创建者）──
            var dg = document.getElementById('del-group-btn');
            if (dg) dg.onclick = function () {
                if (!global.confirm(
                    '彻底删除这个群？\n\n' +
                    '仓库会被删除，所有成员的聊天记录都会消失。\n' +
                    '此操作不可恢复。'
                )) return;
                dg.disabled = true; dg.textContent = '…';
                API.req('/repos/' + c.owner + '/' + c.name, { method: 'DELETE' })
                    .then(function () {
                        self.toast('群已删除');
                        self.current = null;
                        document.getElementById('info-modal').style.display = 'none';
                        document.getElementById('chat-head').style.display = 'none';
                        document.getElementById('composer').style.display = 'none';
                        document.getElementById('messages').innerHTML =
                            '<div class="welcome"><p>选择一个会话开始聊天</p></div>';
                        document.getElementById('app').classList.remove('show-chat');
                        return self.loadConvs();
                    })
                    .catch(function (e) {
                        self.toast('删除失败：' + e.message, true);
                        dg.disabled = false; dg.textContent = '删除';
                    });
            };
        },

        /**
         * 解除绑定
         *
         * 单聊和群聊语义不同：
         *   · 单聊 → 从我的列表移除（仓库是两人共享的，不擅自删）
         *   · 群聊 → 退出群（去掉自己的协作者身份）
         * 自己建的群不能"退出"（GitHub 不让 owner 移除自己），
         * 那种情况要走"删除整个群"。
         */
        async unbind(c, btn) {
            var self = this;
            var isGroup = c.type === 'group';

            if (!global.confirm(isGroup
                ? '退出这个群？\n\n你将不再收到消息。'
                : '解除与 ' + (this.displayName(c)) + ' 的绑定？\n\n' +
                  '会话会从你的列表移除。聊天记录仍留在仓库里。'
            )) return;

            if (btn) { btn.disabled = true; btn.textContent = '…'; }

            try {
                if (isGroup) {
                    var r = await Group.leave(c.owner, c.name);
                    if (!r.ok) {
                        if (r.reason === 'is-owner') {
                            self.toast('你是群创建者，不能退出 —— 请用下面的「删除整个群」', true);
                            if (btn) { btn.disabled = false; btn.textContent = '解除'; }
                            return;
                        }
                        throw new Error('退出失败');
                    }
                }

                // 清本地缓存（无论如何都要清）
                API.clearMessageCache(c.owner, c.name);
                API._ls('fh:gk:' + c.owner + '/' + c.name, null);

                // 从列表移除：用"隐藏"标记，否则下次拉仓库列表它又回来了
                this.ls('fh:hidden:' + c.owner + '/' + c.name, '1');

                this.current = null;
                document.getElementById('info-modal').style.display = 'none';
                document.getElementById('chat-head').style.display = 'none';
                document.getElementById('composer').style.display = 'none';
                document.getElementById('e2e-bar').style.display = 'none';
                document.getElementById('messages').innerHTML =
                    '<div class="welcome"><p>选择一个会话开始聊天</p></div>';
                document.getElementById('app').classList.remove('show-chat');

                this.toast(isGroup ? '已退出群聊' : '已解除绑定');
                await this.loadConvs();
            } catch (e) {
                this.toast('操作失败：' + (e.message || e), true);
                if (btn) { btn.disabled = false; btn.textContent = '解除'; }
            }
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

        // ── 轮询 ───────────────────────────────────────────────
        /**
         * 双层轮询
         *
         *   快（5s）：当前会话的消息 —— ETag 命中 304 不扣配额，
         *             所以 5 秒和 15 秒成本一样，但体验快 3 倍
         *   慢（60s）：会话列表 + 未读红点 —— 拉仓库列表本身要花钱，
         *             所以放慢；未读靠 updated_at 判断，不用拉消息
         *
         * 另外三个必须处理的场景：
         *   · 切回标签页立刻拉一次（不能等下一个 tick）
         *   · 后台时不轮询（省配额），回前台补一次
         *   · 轮询出错不能让整个定时器死掉
         */
        startPolling() {
            var self = this;

            // 快轮询：当前会话
            setInterval(function () {
                if (!self.current) return;
                if (self._polling) return;          // 上一次还没结束，跳过
                if (document.hidden) return;
                self.refreshCurrent();
            }, this.FAST_POLL);

            // 慢轮询：会话列表 + 未读
            setInterval(function () {
                if (document.hidden) return;
                self.loadConvs();
            }, this.SLOW_POLL);

            // 切回前台立刻补一次 —— 否则要等满一个周期
            document.addEventListener('visibilitychange', function () {
                if (document.hidden) return;
                if (self.current) self.refreshCurrent();
                self.loadConvs();
            });

            // 窗口获得焦点也补一次（并排两个窗口时很有用）
            global.addEventListener('focus', function () {
                if (self.current) self.refreshCurrent();
            });
        },

        FAST_POLL: 5000,
        SLOW_POLL: 60000,

        async refreshCurrent() {
            var c = this.current;
            if (!c) return;
            if (this._polling) return;              // 防重入
            this._polling = true;

            try {
                var msgs;
                if (c.type === 'dm') {
                    var e2e = this.e2eState || {};
                    msgs = await Chat.messages(c.owner, c.name, true, {
                        myLogin: Store.me.login,
                        peerPub: e2e.peerPub
                    });
                } else {
                    msgs = await Group.messages(c.owner, c.name, true);
                }

                // 内容没变就别重绘 —— 否则每次轮询都会把滚动条拽到底，
                // 正在翻历史记录的人会被强行拉回最新
                var sig = this._signature(msgs);
                if (sig !== this._lastSig) {
                    this._lastSig = sig;
                    this.renderMessages(msgs);
                }

                if (msgs.length) {
                    this.markSeen(c, msgs[msgs.length - 1].ts);
                }
            } catch (e) {
                // 静默但不完全无声：控制台留痕，方便排查
                if (global.console) console.warn('[轮询] 刷新失败', e.message);
            } finally {
                this._polling = false;              // 出错也必须解锁
            }
        },

        /** 消息指纹：只有条数和最后一条变了才重绘 */
        _signature: function (msgs) {
            if (!msgs || !msgs.length) return '0';
            var last = msgs[msgs.length - 1];
            return msgs.length + ':' + (last.id || '') + ':' + (last.ts || '');
        },

        /** 标记已读（用于未读红点） */
        markSeen: function (c, ts) {
            this.ls('fh:seen:' + c.owner + '/' + c.name, String(ts || Date.now()));
            if (this._unread && this._unread[c.name]) {
                delete this._unread[c.name];
                this.renderConvs();
            }
        },

        /** 是否已读 */
        isUnread: function (c) {
            if (this.current && this.current.name === c.name) return false;
            var seen = parseInt(this.ls('fh:seen:' + c.owner + '/' + c.name) || '0', 10);
            if (!seen) return false;                // 从没打开过不算未读
            var t = c.updatedAt ? new Date(c.updatedAt).getTime() : 0;
            return t > seen;
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
