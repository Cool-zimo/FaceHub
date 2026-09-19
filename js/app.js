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
        /**
         * 本地缓存：上次会话列表 / 消息
         *
         * 用户抱怨"退一下标签页回来就要重新刷新"——
         * 因为每次 visibilitychange 都重拉，界面先空一下再填。
         * 现在先渲染本地快照（0 请求、0 延迟），后台静默更新，
         * 有变化才重绘。切标签页时只要没变化就完全不动。
         */
        _snapKey() {
            var me = (Store.me && Store.me.login) || '';
            return 'fh:snap:' + me;
        },

        _saveSnapshot(convs) {
            try {
                global.localStorage.setItem(this._snapKey(),
                    JSON.stringify({ ts: Date.now(), convs: convs }));
            } catch (e) { /* 配额满 */ }
        },

        _loadSnapshot() {
            try {
                var raw = global.localStorage.getItem(this._snapKey());
                if (!raw) return null;
                var d = JSON.parse(raw);
                return (d && Array.isArray(d.convs)) ? d.convs : null;
            } catch (e) { return null; }
        },

        /**
         * 静默刷新：拉到新数据才重绘，否则什么都不做
         * 避免"切回标签页 → 列表闪一下"这种无意义重绘
         */
        async _refreshConvsQuiet() {
            try {
                var convs = await Chat.listConvs();
                var sig = convs.map(function (c) {
                    return c.name + ':' + (c.updated_at || '');
                }).join('|');
                if (sig === this._convSig) return;    // 没变，不动
                this._convSig = sig;
                this.convs = convs;
                this._saveSnapshot(convs);
                this.renderConvs();
            } catch (e) { /* 失败就保持现状 */ }
        },

        async boot() {
            var token = this.getToken();
            if (token) await this.enter(token);
            else this.showBridgeHint();
            this.bindLogin();
            this.bindUI();
        },

        /**
         * 其他应用已登录 → 显示"检测到 XXX 已登录"
         *
         * ★ 之前只写死了"检测到已登录"，看不出是从哪个应用带过来的，
         *   而且依赖 getSavedUser() —— 那个只在同应用登录过才有值。
         *   现在走 Bridge.findLoggedInOther()：三个应用里任意一个
         *   登录过都能识别，并把应用名显示出来（如"GitHub Drive"）。
         *
         * ★ 时序：bridge.js 用普通 <script> 同步加载，但本函数
         *   可能在 DOM 还没就绪时被调用 —— 所以调用点必须放在
         *   DOMContentLoaded 之后（见底部启动逻辑）。
         */
        showBridgeHint() {
            var box = document.getElementById('bridge-box');
            if (!box) return;

            var B = global.Bridge;
            if (!B) { box.style.display = 'none'; return; }

            var found = B.findLoggedInOther();
            if (!found) { box.style.display = 'none'; return; }

            var app = found.app;
            var user = found.user || this.getSavedUser() || {};

            // 标题：明确指出来源应用
            var label = document.getElementById('bridge-label');
            if (label) label.textContent = '检测到 ' + app.name + ' 已登录';

            var nm = document.getElementById('bridge-name');
            if (nm) nm.textContent = (user && user.login) || '（已保存的账号）';

            var av = document.getElementById('bridge-avatar');
            if (av) {
                if (user && user.avatar_url) {
                    av.innerHTML = '<img src="' + this.esc(user.avatar_url) +
                        '" style="width:22px;height:22px;border-radius:4px;vertical-align:-6px;margin-right:5px">';
                } else {
                    av.textContent = app.icon || '';
                }
            }

            var note = document.getElementById('bridge-note');
            if (note) {
                note.textContent = app.icon + ' ' + app.name +
                    ' · 令牌只在你本机浏览器里，不会上传';
            }

            box.style.display = '';

            var self = this;
            var use = document.getElementById('bridge-use');
            if (use) {
                use.onclick = function () {
                    var t = self.getToken() || (B && B.findToken());
                    if (!t) return self.toast('没找到可用令牌', true);
                    self.enter(t);
                };
            }
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

            // 朋友圈
            document.getElementById('moments-post').onclick = function () {
                self.postMoment();
            };
            Array.prototype.forEach.call(
                document.querySelectorAll('.nav-btn[data-tab="moments"]'),
                function (b) { b.onclick = function () { self.showMoments(); }; }
            );
            var mm = document.getElementById('moments-more');
            if (mm) mm.onclick = function () {
                self._momentsPage++;
                self.loadMoments(true);
            };
            // 小程序
            Array.prototype.forEach.call(
                document.querySelectorAll('.nav-btn[data-tab="apps"]'),
                function (b) { b.onclick = function () { self.showApps(); }; }
            );
            // 发现（找人/关注）
            Array.prototype.forEach.call(
                document.querySelectorAll('.nav-btn[data-tab="discover"]'),
                function (b) { b.onclick = function () { self.showDiscover(); }; }
            );
            var dg = document.getElementById('discover-go');
            if (dg) dg.onclick = function () { self.searchPeople(); };
            var di = document.getElementById('discover-input');
            if (di) di.onkeydown = function (e) {
                if (e.key === 'Enter') self.searchPeople();
            };
            // 面板关闭按钮走事件委托（_bindPaneCloses），不用逐个绑
            var as = document.getElementById('apps-search');
            if (as) as.onclick = function () { self.searchApps(); };
            var ac = document.getElementById('apps-close');
            if (ac) ac.onclick = function () { self.closeApp(); };
            var ao = document.getElementById('apps-open');
            if (ao) ao.onclick = function () {
                if (self._curApp) global.open(MiniApp.url(self._curApp), '_blank');
            };

            // 图标：把 data-ico 占位渲染成内联 SVG
            self.mountIcons();

            // 返回（移动端）
            document.getElementById('back-btn').onclick = function () {
                document.getElementById('app').classList.remove('show-chat');
            };

            // 详情
            document.getElementById('info-btn').onclick = function () { self.openInfo(); };
            // 点标题栏也能进详情 —— 右上角「⋯」太容易被忽略，
            // 群成员管理藏在里面，很多人根本找不到。
            var cht = document.querySelector('#chat-head .chat-head-txt');
            if (cht) {
                cht.style.cursor = 'pointer';
                cht.title = '查看会话详情';
                cht.onclick = function () { self.openInfo(); };
            }
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
                // 之前是弹窗，那么大空间只用来弹一个框，太浪费。
                // 改成页面：头像 + 昵称 + 账号 + 常用入口。
                this.showMe();
                return;
            }
            this.view = (tab === 'contacts') ? 'contacts' : 'chats';
            this.renderConvs();
        },

        // ── 会话列表 ───────────────────────────────────────────
        async loadConvs() {
            var list = document.getElementById('conv-list');

            // 先渲染本地快照：切回标签页时立刻有内容，不用等网络
            var snap = this._loadSnapshot();
            if (snap && snap.length && !this.convs.length) {
                this.convs = snap;
                this.renderConvs();
            } else {
                list.innerHTML = '<div class="loading">载入中…</div>';
            }

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
            this._saveSnapshot(convs);
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

            var tools = document.createElement('span');
            tools.className = 'invite-tools';

            var rf = document.createElement('button');
            rf.className = 'invite-refresh';
            rf.textContent = '刷新';
            rf.onclick = function () { self.loadConvs(); };
            tools.appendChild(rf);

            // 邀请多的时候（测试会刷出一堆）逐个点太痛苦
            if (this.invites.length > 1) {
                var da = document.createElement('button');
                da.className = 'invite-decline-all';
                da.textContent = '全部忽略';
                da.onclick = function () { self.declineAllInvites(da); };
                tools.appendChild(da);
            }

            title.appendChild(t1);
            title.appendChild(tools);
            box.appendChild(title);

            this.invites.forEach(function (inv) {
                var row = document.createElement('div');
                row.className = 'invite-item';

                var who = document.createElement('span');
                who.className = 'invite-who';
                who.textContent = inv.peer + (inv.isGroup ? ' 邀请你加入群聊' : ' 想和你私聊');
                row.appendChild(who);

                var acts = document.createElement('span');
                acts.className = 'invite-acts';

                var btn = document.createElement('button');
                btn.className = 'invite-accept';
                btn.textContent = '接受';
                btn.onclick = function () { self.acceptInvite(inv, btn); };
                acts.appendChild(btn);

                // 忽略：GitHub 有 DELETE 端点，之前只做了接受没做忽略，
                // 结果不想要的邀请永远清不掉
                var ig = document.createElement('button');
                ig.className = 'invite-ignore';
                ig.textContent = '忽略';
                ig.onclick = function () { self.declineInvite(inv, ig); };
                acts.appendChild(ig);

                row.appendChild(acts);
                box.appendChild(row);
            });

            var tip = document.createElement('div');
            tip.className = 'invite-delay';
            tip.textContent = 'GitHub 的邀请有几分钟延迟，没看到就点刷新';
            box.appendChild(tip);
        },

        /** 忽略单条邀请 */
        async declineInvite(inv, btn) {
            if (btn) { btn.disabled = true; btn.textContent = '…'; }
            try {
                await API.declineInvitation(inv.id);
                this.invites = (this.invites || []).filter(function (i) {
                    return i.id !== inv.id;
                });
                this.renderInvites();
                this.renderConvs();
            } catch (e) {
                this.toast('忽略失败：' + (e.message || e), true);
                if (btn) { btn.disabled = false; btn.textContent = '忽略'; }
            }
        },

        /**
         * 全部忽略
         *
         * 逐个发 DELETE（GitHub 没有批量端点）。并发跑会撞限流，
         * 所以串行；失败的不中断，最后汇报成功/失败数。
         */
        async declineAllInvites(btn) {
            var list = (this.invites || []).slice();
            if (!list.length) return;
            if (!global.confirm('忽略全部 ' + list.length + ' 个邀请？\n\n' +
                '这些都是别人发给你的会话邀请，忽略后就看不到了。')) return;

            if (btn) { btn.disabled = true; btn.textContent = '忽略中…'; }
            var done = 0, failed = 0;

            for (var i = 0; i < list.length; i++) {
                try {
                    await API.declineInvitation(list[i].id);
                    done++;
                } catch (e) {
                    failed++;
                }
                if (btn) btn.textContent = '忽略中 ' + (done + failed) + '/' + list.length;
            }

            this.toast('已忽略 ' + done + ' 个' + (failed ? '，' + failed + ' 个失败' : ''),
                failed > 0);
            await this.loadConvs();
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
                    title: this._fallbackGroupTitle(repo.name, repo.owner.login),
                    avatar: null,
                    updatedAt: repo.updated_at,
                    private: repo.private
                });
            }, this);
            return out;
        },

        /**
         * 群聊在列表里的显示名
         *
         * ★ 之前用 repo.name.replace(/^fhgrp-[^-]+-/, '') 取名字，
         *   但创建者的登录名本身可能带连字符（cool-zimo），
         *   [^-]+ 只吃掉 "cool" → 剩下 "zimo-a6qmly"。
         *   所以列表里会出现这种莫名其妙的仓库名碎片。
         *
         * 正确做法：先剥前缀，再剥末尾 6 位随机串，得到创建者登录名；
         * 真名（group.json 的 name）打开过一次就缓存下来，之后直接用。
         */
        _fallbackGroupTitle(name, owner) {
            var cached = this.ls('fh:gname:' + name);
            if (cached) return cached;
            var body = String(name)
                .replace(/^fhgrp-/, '')
                .replace(/-[a-z0-9]{6}$/i, '');
            return (body || owner || '群聊') + ' 的群';
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
            this._seenIds = {};          // 已见 id 也重置，重开会话重新播一遍
            this._pendingScroll = 0;
            this._bindScrollSave();      // 滚动位置存起来
            this.markSeen(c, Date.now());
            document.getElementById('app').classList.add('show-chat');

            document.getElementById('chat-head').style.display = '';
            document.getElementById('composer').style.display = '';
            var ttl = this.displayName(c);
            // 群聊带人数（微信风格）。数字来自 openGroup 时缓存的 meta
            if (c.type === 'group') {
                var _gm = this._grpMeta && this._grpMeta[c.name];
                var _n = _gm ? ((_gm.members || []).length) : 0;
                if (_n) ttl += '(' + _n + ')';
            }
            document.getElementById('chat-title').textContent = ttl;
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

            /**
             * ★ 对方还没接受邀请 → 明确告诉他为什么"对方没反应"
             *
             * 这是唯一的真实阻塞点：私聊仓库是私有的，
             * 对方必须登录一次接受邀请才有读写权限。
             * 接受之后就是异步的，不需要双方同时在线。
             * 不说清楚的话，用户会以为消息没发出去，一直干等。
             */
            if (!msgs.some(function (m) {
                    return m.from && String(m.from).toLowerCase() !==
                        String(Store.me.login).toLowerCase();
                })) {
                var pend = await Chat.pendingInvite(c.owner, c.name, c.peer);
                if (pend) {
                    var tip = document.createElement('div');
                    tip.className = 'invite-tip';
                    tip.innerHTML =
                        '<b>邀请已发出，等待 ' +
                        '<span class="mono"></span></b> 接受' +
                        '<div class="invite-tip-sub">会话仓库是私有的，' +
                        '对方需要登录 FaceHub 并接受一次邀请才能收到消息。' +
                        '接受之后就是异步的，不要求双方同时在线。</div>';
                    tip.querySelector('.mono').textContent = c.peer || '对方';
                    var mb = document.getElementById('e2e-bar');
                    if (mb && mb.parentNode) {
                        mb.parentNode.insertBefore(tip, mb.nextSibling);
                    }
                }
            }
        },

        async openGroup(c) {
            var meta = await Group.meta(c.owner, c.name);
            this.current.meta = meta;
            // 缓存真名：下次进列表直接显示群名，不用再读 group.json
            if (meta && meta.name) {
                this.ls('fh:gname:' + c.name, meta.name);
                c.title = meta.name;
            }
            // 昵称是本地备注，优先级最高；否则用群名（所有人共享）
            document.getElementById('chat-title').textContent =
                this.getNick(c.owner, c.name) || meta.name || c.title;
            document.getElementById('chat-sub').textContent =
                (meta.members ? meta.members.length : 1) + ' 人';

            // 缓存群 meta，标题栏要用成员数
            try {
                var _meta = await Group.meta(c.owner, c.name);
                if (!this._grpMeta) this._grpMeta = {};
                this._grpMeta[c.name] = _meta;
            } catch (e) { /* 忽略 */ }

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
        /**
         * 渲染消息
         *
         * @param {boolean} animateNew 只给"没见过的消息"播进场动画。
         *   整体重绘时若全部重放，每次轮询都会抖一下 —— 很吵。
         *   所以记录已显示过的 id，只让新来的那几条动。
         */
        renderMessages(msgs, animateNew) {
            var box = document.getElementById('messages');
            var myLogin = Store.me.login;
            var self = this;

            // 记住滚动位置：正在翻历史的人不该被轮询拽回底部
            var wasAtBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
            var keepTop = box.scrollTop;

            /**
             * 恢复上次滚动位置
             *
             * 之前只在"同一次会话内重绘"时保留位置，
             * 一刷新页面（或切走再回来）就跳回第一条 —— 翻历史的人很崩溃。
             * 所以按会话 key 存 localStorage，下次进来原样滚回去。
             */
            var scrollKey = this._scrollKey();
            if (keepTop === 0 && scrollKey) {
                var saved = parseInt(global.localStorage.getItem(scrollKey), 10);
                if (saved > 0) {
                    this._pendingScroll = saved;
                    wasAtBottom = false;
                }
            }

            if (!this._seenIds) this._seenIds = {};
            var seen = this._seenIds;

            box.innerHTML = '';
            if (!msgs.length) {
                box.innerHTML = '<div class="welcome"><p>还没有消息，说第一句吧</p></div>';
                return;
            }

            msgs.forEach(function (m) {
                var mine = String(m.from).toLowerCase() === myLogin.toLowerCase();
                var row = document.createElement('div');
                var isNew = animateNew && m.id && !seen[m.id];
                if (m.id) seen[m.id] = 1;
                row.className = 'msg-row' + (mine ? ' mine' : '') +
                    (isNew ? ' is-new' : '');

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
                // 服务器来的用信封解析。
                //
                // ★ 不能拿 locked 当条件：明文发送的附件消息也可能
                // 被标成 locked，结果不解析 → 界面直接露出
                // FHATT1:{...} 内部协议串（"漏源码"）。
                var att = null;
                if (global.Attach) {
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
                } else if (global.Attach && Attach.looksLikeAttachment(m.text)) {
                    // 是附件串但解析不出来 —— 也绝不把原始串甩给用户
                    b.textContent = '⚠️ 附件（格式无法识别）';
                    b.title = '这条是附件消息，但内容解析失败';
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
            if (wasAtBottom) {
                box.scrollTop = box.scrollHeight;
            } else {
                box.scrollTop = keepTop || this._pendingScroll || 0;
            }

            /**
             * ★ 恢复"上次浏览位置"必须重试
             *
             * 之前只设一次 scrollTop，结果经常无效：
             *   ① 消息是异步解密/加载的，设定时 box.scrollHeight 还很矮，
             *      scrollTop 被浏览器夹到 0（超出范围自动修正）
             *   ② 图片/附件异步加载后高度再变，位置又偏了
             *
             * 所以：多次尝试，直到 scrollHeight 足够高、位置真的设上去，
             * 或用户自己滚了（那时就不要再抢）。
             */
            var want = this._pendingScroll;
            if (want > 0 && !wasAtBottom) {
                this._pendingScroll = 0;
                this._restoreScroll(box, want);
            }
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
                self._flashSent();

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
                var att = await Attach.upload(c.owner, c.name, file,
                    function (stage, ratio, totalChunks) {
                        if (stage === 'uploading') {
                            // 分片上传有真实进度可显示，比干等着强
                            var pct = Math.round((ratio || 0) * 100);
                            temp.text = totalChunks && totalChunks > 1
                                ? '正在上传 ' + file.name + '… ' + pct +
                                  '%（' + Math.max(1, Math.ceil((ratio||0) * totalChunks)) +
                                  '/' + totalChunks + ' 片）'
                                : '正在上传 ' + file.name + '…';
                            self._rerenderWithPending();
                        }
                    });

                // 上传完：把占位换成真实附件气泡（本地 dataUrl，秒开）
                temp.text = Attach.encode(att);
                temp.raw = temp.text;
                // 字段统一成信封格式（n/t/s/p），渲染时不用再判断来源
                // c = 分片数，多片时 p 是目录
                temp.att = {
                    n: att.name, t: att.type, s: att.size,
                    p: att.path, c: att.chunks || 1,
                    dataUrl: att.dataUrl
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
                self._flashSent();
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

        /**
         * 成员变更后：
         * ① 刷新群 meta 缓存（标题栏人数）
         * ② 清关系缓存（朋友圈要跟着变）
         * ③ 重绘标题
         */
        async _afterMemberChange(c) {
            try {
                var m = await Group.meta(c.owner, c.name);
                if (!this._grpMeta) this._grpMeta = {};
                this._grpMeta[c.name] = m;
            } catch (e) { /* 忽略 */ }
            if (global.Moments) Moments.invalidateRelations(Store.me.login);
            // 标题人数
            var t = document.getElementById('chat-title');
            if (t && c.type === 'group') {
                var n = (this._grpMeta[c.name] &&
                    (this._grpMeta[c.name].members || []).length) || 0;
                t.textContent = this.displayName(c) + (n ? '(' + n + ')' : '');
            }
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
                    return self._afterMemberChange(c);
                }).then(function () {
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
                            return self._afterMemberChange(c);
                        }).then(function () { return self.openInfo(); })
                          .then(function () { return self.loadConvs(); })
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

                // AI 自动回复（只对私聊生效 —— 群里自动接话太吵）
                this._autoReply(c, msgs);
            } catch (e) {
                // 静默但不完全无声：控制台留痕，方便排查
                if (global.console) console.warn('[轮询] 刷新失败', e.message);
            } finally {
                this._polling = false;              // 出错也必须解锁
            }
        },

        /**
         * AI 自动回复
         *
         * 只在私聊生效：群里自动接话太吵，而且容易两个人开着打起来。
         * 不 await —— 它要等 AI 好几秒，卡在这儿会把轮询堵死
         * （refreshCurrent 有防重入，但 finally 要等它结束才解锁）。
         */
        _autoReply(c, msgs) {
            var AR = global.AIReply;
            if (!AR || !AR.ready()) return;
            if (c.type !== 'dm') return;
            if (!Store.me || !Store.me.login) return;

            var self = this;
            var e2e = this.e2eState || {};

            // ★ 一定要设基线：开启的那一刻把最新一条记下来，
            //   之后只回比它新的。否则一开启就会把全部历史回一遍。
            var convKey = c.owner + '/' + c.name;
            if (!AR.baseline(convKey)) {
                var last = msgs[msgs.length - 1];
                AR.setBaseline(convKey, (last && last.ts) || Date.now());
                return;
            }

            AR.maybeReply(c, msgs, {
                myLogin: Store.me.login,
                peerPub: e2e.peerPub,
                currentConv: this.current,
                send: async function (text) {
                    await Chat.send(c.owner, c.name, text, {
                        myLogin: Store.me.login,
                        peerPub: e2e.peerPub
                    });
                    // 发完立刻重拉一次，别等下一个轮询周期
                    API.clearMessageCache(c.owner, c.name);
                    self._lastSig = null;
                }
            }).catch(function (e) {
                if (global.console) console.warn('[AI自动回复]', e && e.message);
            });
        },

        /**
         * 发送成功的按钮反馈
         *
         * 移除 class 后必须强制 reflow 才能重新触发动画 ——
         * 否则连续发两条，第二次不会播。
         */
        _flashSent: function () {
            var btn = document.getElementById('send-btn');
            if (!btn) return;
            btn.classList.remove('just-sent');
            void btn.offsetWidth;      // 强制 reflow
            btn.classList.add('just-sent');
            setTimeout(function () { btn.classList.remove('just-sent'); }, 400);
        },

        // ══════════════════════════════════════════════════════
        //  发现 / 关注
        // ══════════════════════════════════════════════════════

        showDiscover() {
            this._openPane('discover-pane');
            this.loadDiscover();
        },

        /**
         * 隐藏所有面板，只留一个
         *
         * ★ 面板现在在 #content-col 里（右侧内容区），
         *   左侧导航 + 会话列表始终可见 —— 之前是整个 #app 被盖住，
         *   看着像"换了页"，而且没有明显的退出按钮。
         *
         * except=null 表示全部关掉，回到聊天区。
         */
        PANES: ['moments-pane', 'apps-pane', 'me-pane', 'profile-pane', 'discover-pane'],

        _hideAllPanes(except) {
            var self = this;
            this.PANES.forEach(function (id) {
                var el = document.getElementById(id);
                if (!el) return;
                if (el !== except) {
                    el.style.display = 'none';
                    // 关闭即卸载：小程序 iframe 别留后台跑
                    if (id === 'apps-pane') self.closeApp();
                }
            });
        },

        /** 打开某个面板（统一入口，保证标题栏图标被挂载） */
        _openPane(id) {
            this._hideAllPanes(document.getElementById(id));
            var el = document.getElementById(id);
            if (el) el.style.display = 'flex';
            this.mountIcons();
            this._bindPaneCloses();
            return el;
        },

        /** 默认展示：已关注的人 + 可能认识（会话里的对象） */
        async loadDiscover() {
            var box = document.getElementById('discover-list');
            if (!box) return;
            var self = this;
            box.innerHTML = '<div class="moments-loading">加载中…</div>';

            try {
                var following = await Moments.following(Store.me.login);
                var rel = await Moments.relations(Store.me.login);
                box.innerHTML = '';

                /**
                 * ★ 聊天关系自动可见，不用关注
                 * 都已经在聊天了，没道理还要再点一次"关注"。
                 * 所以这一块只展示、不提供关注按钮。
                 */
                if (rel.length) {
                    var relWrap = document.createElement('div');
                    relWrap.className = 'disc-sec';
                    var rh = document.createElement('div');
                    rh.className = 'disc-sec-t';
                    rh.textContent = '聊天关系 · 动态自动可见（' + rel.length + '）';
                    relWrap.appendChild(rh);
                    var rtip = document.createElement('div');
                    rtip.className = 'disc-tip';
                    rtip.textContent = '有私聊或同群的人，朋友圈会自动显示 TA 的动态，无需关注';
                    relWrap.appendChild(rtip);
                    rel.forEach(function (lg) {
                        relWrap.appendChild(self._personRow(lg, false, true));
                    });
                    box.appendChild(relWrap);
                }

                if (following.length) {
                    box.appendChild(this._peopleSection('已关注的陌生人', following, true));
                }

                // 可能认识：会话对象里还没在关系里的
                var convs = (this.convs || []).filter(function (c) {
                    return c.type === 'dm' && c.peer;
                });
                var seen = {};
                following.concat(rel).forEach(function (f) {
                    seen[String(f).toLowerCase()] = 1;
                });
                var cand = [];
                convs.forEach(function (c) {
                    var k = String(c.peer).toLowerCase();
                    if (seen[k] || c.peer === Store.me.login) return;
                    seen[k] = 1;
                    cand.push(c.peer);
                });

                if (cand.length) {
                    box.appendChild(this._peopleSection('可能认识', cand, false));
                } else if (!following.length && !rel.length) {
                    box.innerHTML = '<div class="moments-empty">' +
                        '<p>还没有关系和关注</p>' +
                        '<p class="sub">有私聊或群聊后，动态会自动出现；也可以搜用户名关注</p></div>';
                }
            } catch (e) {
                box.innerHTML = '<div class="moments-empty">加载失败：' + (e.message || e) + '</div>';
            }
        },

        _peopleSection(title, logins, canUnfollow) {
            var self = this;
            var wrap = document.createElement('div');
            wrap.className = 'disc-sec';
            var h = document.createElement('div');
            h.className = 'disc-sec-t';
            h.textContent = title;
            wrap.appendChild(h);
            logins.forEach(function (lg) {
                wrap.appendChild(self._personRow(lg, canUnfollow));
            });
            return wrap;
        },

        /**
         * @param {boolean} canUnfollow 已关注 → 显示"已关注"
         * @param {boolean} fromRel 来自聊天关系 → 不显示关注按钮（本来就自动可见）
         */
        _personRow(login, canUnfollow, fromRel) {
            var self = this;
            var row = document.createElement('div');
            row.className = 'disc-row';

            var av = document.createElement('img');
            av.className = 'disc-av';
            av.src = 'https://github.com/' + login + '.png?size=80';
            av.alt = '';
            av.onclick = function () { self.showProfile(login); };
            row.appendChild(av);

            var info = document.createElement('div');
            info.className = 'disc-info';
            info.onclick = function () { self.showProfile(login); };
            var nm = document.createElement('div');
            nm.className = 'disc-nm';
            nm.textContent = login;
            info.appendChild(nm);
            row.appendChild(info);

            if (fromRel) {
                // 关系来的：自动可见，不再提供关注按钮（关注了也是重复）
                var tag = document.createElement('span');
                tag.className = 'disc-tag';
                tag.textContent = '自动可见';
                row.appendChild(tag);
                return row;
            }

            var btn = document.createElement('button');
            btn.className = 'btn-primary btn-sm' + (canUnfollow ? ' btn-ghost' : '');
            btn.textContent = canUnfollow ? '已关注' : '关注';
            btn.onclick = async function () {
                btn.disabled = true;
                try {
                    if (canUnfollow) await Moments.unfollow(Store.me.login, login);
                    else await Moments.follow(Store.me.login, login);
                    self.toast(canUnfollow ? '已取消关注' : '已关注 ' + login);
                    // 朋友圈缓存要清，否则时间线不会变
                    Moments._invalidate(Store.me.login, Moments.repoName(Store.me.login));
                    await self.loadDiscover();
                } catch (e) {
                    self.toast('操作失败：' + (e.message || e), true);
                    btn.disabled = false;
                }
            };
            row.appendChild(btn);
            return row;
        },

        /** 跟某人开私聊（没有就建） */
        async startDM(peer) {
            var self = this;
            try {
                this.toast('正在创建会话…');
                var room = await Chat.start(peer);
                this._hideAllPanes(null);
                this.switchTab('chats');
                await this.loadConvs();
                var want = Chat.roomName(Store.me.login, peer);
                var c = (this.convs || []).filter(function (x) {
                    return x.name === want;
                })[0];
                if (c) await this.openConv(c);
                else this.toast('会话已创建，点聊天列表刷新一下');
            } catch (e) {
                this.toast('创建会话失败：' + (e.message || e), true);
            }
        },

        /** 搜索用户 */
        async searchPeople() {
            var inp = document.getElementById('discover-input');
            var q = inp ? inp.value.trim() : '';
            if (!q) { this.toast('输入用户名', true); return; }
            var box = document.getElementById('discover-list');
            var self = this;
            box.innerHTML = '<div class="moments-loading">搜索中…</div>';

            try {
                var r = await global.API.req('/search/users?q=' +
                    encodeURIComponent(q) + '&per_page=15');
                var items = (r.data && r.data.items) || [];
                box.innerHTML = '';
                if (!items.length) {
                    box.innerHTML = '<div class="moments-empty">没找到「' + q + '」</div>';
                    return;
                }
                box.appendChild(this._peopleSection('搜索结果',
                    items.map(function (u) { return u.login; }), false));
            } catch (e) {
                box.innerHTML = '<div class="moments-empty">搜索失败：' +
                    (e.message || e) + '</div>';
            }
        },

        // ── 某人主页 ─────────────────────────────────────
        async showProfile(login) {
            this._openPane('profile-pane');
            var title = document.getElementById('profile-title');
            if (title) title.textContent = login;

            var body = document.getElementById('profile-body');
            var self = this;
            if (!body) return;
            body.innerHTML = '<div class="moments-loading">加载中…</div>';
            this.mountIcons();

            try {
                var isMe = (login === Store.me.login);
                var following = await Moments.following(Store.me.login);
                var isFollowing = following.indexOf(login) >= 0;
                var posts = await Moments.postList(login);

                body.innerHTML = '';

                // 头部
                var head = document.createElement('div');
                head.className = 'prof-head';
                var av = document.createElement('img');
                av.className = 'prof-av';
                av.src = 'https://github.com/' + login + '.png?size=160';
                head.appendChild(av);
                var nm = document.createElement('div');
                nm.className = 'prof-nm';
                nm.textContent = login;
                head.appendChild(nm);
                var cnt = document.createElement('div');
                cnt.className = 'prof-cnt';
                cnt.textContent = posts.length + ' 条动态';
                head.appendChild(cnt);

                if (!isMe) {
                    var btn = document.createElement('button');
                    btn.className = 'btn-primary btn-sm' + (isFollowing ? ' btn-ghost' : '');
                    btn.textContent = isFollowing ? '已关注' : '关注';
                    btn.onclick = async function () {
                        btn.disabled = true;
                        try {
                            if (isFollowing) await Moments.unfollow(Store.me.login, login);
                            else await Moments.follow(Store.me.login, login);
                            self.toast(isFollowing ? '已取消关注' : '已关注');
                            Moments._invalidate(Store.me.login, Moments.repoName(Store.me.login));
                            await self.showProfile(login);
                        } catch (e) {
                            self.toast('失败：' + (e.message || e), true);
                            btn.disabled = false;
                        }
                    };
                    head.appendChild(btn);

                    // 私聊入口
                    var dm = document.createElement('button');
                    dm.className = 'btn-primary btn-sm';
                    dm.textContent = '发消息';
                    dm.onclick = function () { self.startDM(login); };
                    head.appendChild(dm);
                }
                body.appendChild(head);

                if (!posts.length) {
                    var em = document.createElement('div');
                    em.className = 'moments-empty';
                    em.innerHTML = '<p>还没有动态</p>';
                    body.appendChild(em);
                    return;
                }

                // 只取最新 12 条，别一上来就读一堆
                var show = posts.slice(0, 12);
                for (var i = 0; i < show.length; i++) {
                    var p = await Moments.post(login, show[i]);
                    if (!p) continue;
                    p.author = login;
                    body.appendChild(await this.renderMoment(p));
                }
            } catch (e) {
                body.innerHTML = '<div class="moments-empty">加载失败：' + (e.message || e) + '</div>';
            }
        },

        // ══════════════════════════════════════════════════════
        //  小程序
        // ══════════════════════════════════════════════════════

        async showApps() {
            this._openPane('apps-pane');
            await this.loadApps();
        },

        hideApps() {
            this.closePane();
        },

        async loadApps() {
            var box = document.getElementById('apps-list');
            if (!box) return;
            var self = this;
            box.innerHTML = '<div class="moments-loading">载入中…</div>';

            try {
                var mine = await MiniApp.mine(Store.me.login);
                var hist = MiniApp.history();

                box.innerHTML = '';

                // 最近使用
                if (hist.length) {
                    box.appendChild(this._appsSection('最近使用', hist, true));
                }
                box.appendChild(this._appsSection('我的小程序', mine, false));
            } catch (e) {
                box.innerHTML = '<div class="moments-empty">载入失败：' +
                    (e.message || e) + '</div>';
            }
        },

        _appsSection(title, list, isHistory) {
            var self = this;
            var wrap = document.createElement('div');
            wrap.className = 'apps-sec';

            var h = document.createElement('div');
            h.className = 'apps-sec-t';
            h.textContent = title;
            wrap.appendChild(h);

            var grid = document.createElement('div');
            grid.className = 'apps-grid';

            list.forEach(function (a) {
                var cell = document.createElement('button');
                cell.className = 'apps-cell';

                var ic = document.createElement('span');
                ic.className = 'apps-ic';
                if (a.icon) {
                    var im = document.createElement('img');
                    im.src = a.icon;
                    im.alt = '';
                    im.onerror = function () { im.style.display = 'none'; };
                    ic.appendChild(im);
                } else {
                    // 没图标就用首字，跟微信默认小程序图标一个思路
                    ic.textContent = (a.name || '?').charAt(0).toUpperCase();
                    ic.style.background = self._appColor(a.name || '');
                }

                var nm = document.createElement('span');
                nm.className = 'apps-nm';
                nm.textContent = a.name;

                cell.appendChild(ic);
                cell.appendChild(nm);

                cell.onclick = function () { self.openApp(a); };

                // 历史记录的长按/右键可移除（内置不可删）
                if (isHistory && !a.builtin) {
                    var del = document.createElement('span');
                    del.className = 'apps-del';
                    del.textContent = '✕';
                    del.onclick = function (e) {
                        e.stopPropagation();
                        MiniApp.removeHistory(a.id);
                        self.loadApps();
                    };
                    cell.appendChild(del);
                }

                grid.appendChild(cell);
            });

            wrap.appendChild(grid);
            return wrap;
        },

        /** 给没图标的小程序一个稳定配色（同一名字永远是同一颜色） */
        _appColor(name) {
            var hues = ['#07C160', '#1989fa', '#ff976a', '#7232dd',
                '#f44', '#5ac8fa', '#ffb400', '#07c2c2'];
            var sum = 0;
            for (var i = 0; i < name.length; i++) sum += name.charCodeAt(i);
            return hues[sum % hues.length];
        },

        /** 打开小程序：iframe 加载，并记录历史 */
        openApp(a) {
            var player = document.getElementById('apps-player');
            var frame = document.getElementById('apps-frame');
            var nm = document.getElementById('apps-player-name');
            var list = document.getElementById('apps-list');
            if (!player || !frame) return;

            nm.textContent = a.name;
            frame.src = MiniApp.url(a);
            player.style.display = 'flex';
            if (list) list.style.display = 'none';

            this._curApp = a;
            MiniApp.record(a);
        },

        closeApp() {
            var player = document.getElementById('apps-player');
            var frame = document.getElementById('apps-frame');
            var list = document.getElementById('apps-list');
            if (player) player.style.display = 'none';
            if (frame) frame.src = 'about:blank';   // 真正卸载，别留后台跑
            if (list) list.style.display = '';
            this._curApp = null;
        },

        /** 搜索并添加小程序 */
        async searchApps() {
            var q = global.prompt('搜索小程序（输入关键词，或留空看全部）：');
            if (q === null) return;
            var self = this;

            try {
                this.toast('搜索中…');
                var found = await MiniApp.search(q);
                if (!found.length) {
                    this.toast('没找到。也可以直接输入 owner/repo 添加。');
                    var spec = global.prompt('手动添加（格式 owner/repo）：');
                    if (!spec) return;
                    var parts = spec.split('/');
                    if (parts.length !== 2) { this.toast('格式不对', true); return; }
                    var a = await MiniApp.resolve(parts[0].trim(), parts[1].trim());
                    MiniApp.record(a);
                    this.toast('已添加：' + a.name);
                    await this.loadApps();
                    return;
                }
                var names = found.map(function (x, i) {
                    return (i + 1) + '. ' + x.name + '（' + x.owner + '）';
                }).join('\n');
                var pick = global.prompt('找到：\n' + names + '\n\n输入序号打开：');
                var idx = parseInt(pick, 10) - 1;
                if (isNaN(idx) || idx < 0 || idx >= found.length) return;
                this.openApp(found[idx]);
            } catch (e) {
                this.toast('搜索失败：' + (e.message || e), true);
            }
        },

        /** 「我」页面 */
        showMe() {
            var me = Store.me || {};
            this._openPane('me-pane');

            var av = document.getElementById('me-avatar');
            if (av) {
                av.src = me.avatar_url || ('https://github.com/' + me.login + '.png?size=160');
                av.onerror = function () { av.style.visibility = 'hidden'; };
            }
            var nm = document.getElementById('me-name');
            if (nm) nm.textContent = me.name || me.login || '';
            var lg = document.getElementById('me-login');
            if (lg) lg.textContent = me.login ? ('@' + me.login) : '';

            this.renderMeEntries();
            this.mountIcons();
        },

        hideMe() {
            this.closePane();
        },

        // ══════════════════════════════════════════════════════
        //  AI 自动回复设置
        // ══════════════════════════════════════════════════════
        openAutoReply() {
            var AR = global.AIReply;
            if (!AR) { this.toast('模块没加载', true); return; }
            var c = AR.cfg();
            var self = this;

            var opts = AR.MODELS.map(function (m) {
                return '<option value="' + m.id + '"' +
                    (m.id === c.model ? ' selected' : '') + '>' +
                    m.name + '</option>';
            }).join('');

            var html = '' +
                '<div class="info-row">' +
                  '<span class="info-label">启用<br><i class="lbl-tip">只对私聊生效</i></span>' +
                  '<span><input type="checkbox" id="ar-on"' +
                    (c.on ? ' checked' : '') + '></span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span class="info-label">API Key</span>' +
                  '<span class="edit-cell">' +
                    '<input id="ar-key" class="inline-input grow" type="password"' +
                    ' value="' + this.esc(c.key) + '" placeholder="智谱的 key">' +
                  '</span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span class="info-label">模型</span>' +
                  '<span class="edit-cell">' +
                    '<select id="ar-model" class="inline-input grow">' + opts + '</select>' +
                  '</span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span class="info-label">范围</span>' +
                  '<span class="edit-cell">' +
                    '<select id="ar-scope" class="inline-input grow">' +
                      '<option value="all"' + (c.scope === 'all' ? ' selected' : '') +
                        '>所有私聊</option>' +
                      '<option value="current"' + (c.scope === 'current' ? ' selected' : '') +
                        '>仅当前打开的会话</option>' +
                    '</select>' +
                  '</span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span class="info-label">人设<br><i class="lbl-tip">怎么回，随你写</i></span>' +
                  '<span class="edit-cell">' +
                    '<textarea id="ar-sys" class="inline-input grow" rows="3">' +
                      this.esc(c.sys) + '</textarea>' +
                  '</span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span class="info-label">延迟<br><i class="lbl-tip">装作在打字</i></span>' +
                  '<span class="edit-cell">' +
                    '<input id="ar-delay" class="inline-input" type="number" min="0"' +
                    ' max="10000" step="500" value="' + (c.delay || 0) + '">' +
                    '<i class="lbl-tip">毫秒</i>' +
                  '</span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span class="info-label">连续上限<br><i class="lbl-tip">防 AI 互聊</i></span>' +
                  '<span class="edit-cell">' +
                    '<input id="ar-chain" class="inline-input" type="number" min="1"' +
                    ' max="20" value="' + (c.maxChain || 3) + '">' +
                    '<i class="lbl-tip">条</i>' +
                  '</span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span class="info-label">冷却<br><i class="lbl-tip">两次回复间隔</i></span>' +
                  '<span class="edit-cell">' +
                    '<input id="ar-cool" class="inline-input" type="number" min="0"' +
                    ' max="600000" step="5000" value="' + (c.cooldown || 20000) + '">' +
                    '<i class="lbl-tip">毫秒</i>' +
                  '</span>' +
                '</div>' +
                '<div class="info-row">' +
                  '<span></span>' +
                  '<span>' +
                    '<button id="ar-test" class="btn-soft btn-sm">测试连接</button>' +
                    '<button id="ar-save" class="btn-primary btn-sm">保存</button>' +
                  '</span>' +
                '</div>' +
                '<p class="hint">' +
                  '只在<b>这个页面开着</b>的时候生效 —— 没有服务端，纯靠轮询。<br>' +
                  '首次开启会把当前最后一条记为基线，<b>不会</b>回复历史消息。<br>' +
                  '群聊不自动接话。回复同样端到端加密。<br>' +
                  '<b style="color:#c33">⚠ 两边都开自动回复会无限互聊。</b>' +
                  '连续回满上限条就自动停，真人插话后恢复。' +
                '</p>';

            var body = document.getElementById('info-body');
            body.innerHTML = '<h4 class="sec-h">AI 自动回复</h4>' + html;
            document.getElementById('info-modal').style.display = '';

            document.getElementById('ar-save').onclick = function () {
                var v = {
                    on: document.getElementById('ar-on').checked,
                    key: document.getElementById('ar-key').value.trim(),
                    model: document.getElementById('ar-model').value,
                    scope: document.getElementById('ar-scope').value,
                    sys: document.getElementById('ar-sys').value.trim(),
                    delay: parseInt(document.getElementById('ar-delay').value, 10) || 0,
                    maxChain: parseInt(document.getElementById('ar-chain').value, 10) || 3,
                    cooldown: parseInt(document.getElementById('ar-cool').value, 10) || 0
                };
                if (v.on && !v.key) {
                    self.toast('要先填 API Key', true);
                    return;
                }
                AR.save(v);
                self.toast(v.on ? '已开启' : '已关闭');
                self.closeInfo();
                self.renderMeEntries();
            };

            document.getElementById('ar-test').onclick = async function () {
                var btn = this;
                btn.disabled = true;
                btn.textContent = '测试中…';
                var v = {
                    key: document.getElementById('ar-key').value.trim(),
                    model: document.getElementById('ar-model').value
                };
                try {
                    var r = await AR.test(v);
                    global.alert(r.text);
                } catch (e) {
                    global.alert('测试失败：' + (e.message || e));
                }
                btn.disabled = false;
                btn.textContent = '测试连接';
            };
        },

        /** 「我」页面的入口列表 */
        renderMeEntries() {
            var box = document.getElementById('me-entries');
            if (!box) return;
            var self = this;
            box.innerHTML = '';

            var AR = global.AIReply;
            var arOn = AR ? AR.ready() : false;

            var items = [
                { ico: 'chat', txt: 'AI 自动回复',
                  sub: arOn ? '已开启 · 私聊自动接话' : '收到消息自动回（私聊）',
                  fn: function () { self.openAutoReply(); } },
                { ico: 'heart', txt: '密钥备份', sub: '换设备时用它恢复',
                  fn: function () { self.openKeyModal(); } },
                { ico: 'shield', txt: '安全码', sub: '线下核对，防密钥被换',
                  fn: function () { self.openSafetyNumber(); } },
                { ico: 'moments', txt: '我的朋友圈', sub: '看自己发过的动态',
                  fn: function () { self.showMoments(); } },
                { ico: 'refresh', txt: '刷新会话列表', sub: '手动重新拉取',
                  fn: function () { self.loadConvs(); self.toast('已刷新'); } },
                { ico: 'close', txt: '退出登录', sub: '清除本机令牌', danger: true,
                  fn: function () {
                      if (global.confirm('退出登录？本机令牌会被清除（GitHub 上的数据不受影响）。')) {
                          Store.logout();
                      }
                  } }
            ];

            // 安全码入口可能不存在（旧版本），容错
            if (typeof self.openSafetyNumber !== 'function') {
                items = items.filter(function (x) { return x.txt !== '安全码'; });
            }

            items.forEach(function (it) {
                var row = document.createElement('button');
                row.className = 'me-entry' + (it.danger ? ' danger' : '');
                var ic = document.createElement('span');
                ic.className = 'me-entry-ico';
                ic.setAttribute('data-ico', it.ico);
                var tx = document.createElement('span');
                tx.className = 'me-entry-txt';
                var t1 = document.createElement('div');
                t1.className = 'me-entry-t';
                t1.textContent = it.txt;
                var t2 = document.createElement('div');
                t2.className = 'me-entry-s';
                t2.textContent = it.sub;
                tx.appendChild(t1); tx.appendChild(t2);
                var ar = document.createElement('span');
                ar.className = 'me-entry-arrow';
                ar.textContent = '›';
                row.appendChild(ic); row.appendChild(tx); row.appendChild(ar);
                row.onclick = it.fn;
                box.appendChild(row);
            });
        },

        /**
         * 绑定面板关闭按钮
         *
         * 之前每个面板各自绑一个 back 按钮，有的还没绑上，
         * 结果"没有退出按钮"。现在统一用 [data-pane] 声明，
         * 一次绑定，新增面板也不会漏。
         */
        _bindPaneCloses() {
            if (this._paneCloseBound) return;
            var self = this;
            var root = document.getElementById('content-col');
            if (!root) return;

            root.addEventListener('click', function (e) {
                var t = e.target;
                while (t && t !== root) {
                    if (t.classList && t.classList.contains('pane-close')) {
                        self.closePane();
                        return;
                    }
                    if (t.classList && t.classList.contains('pane-back')) {
                        // 主页返回发现页
                        self._hideAllPanes(document.getElementById('discover-pane'));
                        var dp = document.getElementById('discover-pane');
                        if (dp) dp.style.display = 'flex';
                        return;
                    }
                    t = t.parentNode;
                }
            });
            this._paneCloseBound = true;
        },

        /** 关闭当前面板，回到聊天区 */
        closePane() {
            this._hideAllPanes(null);
            // 高亮导航回"聊天"
            Array.prototype.forEach.call(
                document.querySelectorAll('.nav-btn'),
                function (b) {
                    b.classList.toggle('active',
                        b.getAttribute('data-tab') === 'chats');
                });
        },

        /**
         * 把滚动位置恢复到 want（带重试）
         *
         * 判定"成功"：scrollTop 已经接近 want。
         * 判定"放弃"：用户自己滚动了（userMoved）或次数用尽。
         */
        _restoreScroll(box, want) {
            var tries = 0;
            var MAX = 20;                 // 20 × 120ms ≈ 2.4s，够图片加载了
            var lastTop = -1;

            function attempt() {
                if (!box || !box.isConnected) return;
                tries++;

                // 用户自己滚了 → 立刻让位，别跟他抢
                if (lastTop >= 0 && Math.abs(box.scrollTop - lastTop) > 8 &&
                    box.scrollTop !== want) {
                    return;
                }
                lastTop = box.scrollTop;

                // 高度还不够（内容没加载完）→ 继续等
                if (box.scrollHeight < want + box.clientHeight) {
                    box.scrollTop = box.scrollHeight;   // 先顶到当前底部
                    if (tries < MAX) return setTimeout(attempt, 120);
                    return;
                }

                box.scrollTop = want;
                if (Math.abs(box.scrollTop - want) > 8 && tries < MAX) {
                    return setTimeout(attempt, 120);
                }
            }
            attempt();
        },

        /** 当前会话的滚动位置存储 key */
        _scrollKey() {
            var c = this.conv;
            if (!c) return null;
            var me = (Store.me && Store.me.login) || '';
            return 'fh:scroll:' + me + ':' + c.owner + '/' + c.name;
        },

        /** 绑定滚动保存（在 openConv 里调一次） */
        _bindScrollSave() {
            var box = document.getElementById('messages');
            if (!box || box.__scrollBound) return;
            var self = this;
            box.__scrollBound = true;
            var timer = null;
            box.addEventListener('scroll', function () {
                if (timer) return;
                timer = setTimeout(function () {
                    timer = null;
                    var k = self._scrollKey();
                    if (!k) return;
                    try {
                        // 贴底就不存了，下次直接到底（符合"有新消息"的预期）
                        var atBottom = (box.scrollHeight - box.scrollTop -
                            box.clientHeight) < 60;
                        if (atBottom) global.localStorage.removeItem(k);
                        else global.localStorage.setItem(k, String(box.scrollTop));
                    } catch (e) { /* 配额满了就算了 */ }
                }, 200);
            }, { passive: true });
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

        /**
         * 渲染 data-ico 占位为 SVG
         *
         * 图标尺寸按元素类型给默认值，也可以在 data-size 覆盖。
         * 用 innerHTML 注入的是我们自己生成的静态 SVG（不含外部输入），
         * 没有 XSS 风险。
         */
        mountIcons(root) {
            if (!global.Icons) return;
            var scope = root || document;
            Array.prototype.forEach.call(
                scope.querySelectorAll('[data-ico]'),
                function (el) {
                    var name = el.getAttribute('data-ico');
                    var fn = Icons[name];
                    if (!fn) return;
                    var size = parseInt(el.getAttribute('data-size'), 10) ||
                        (el.classList.contains('nav-ico') ? 22 : 20);
                    el.innerHTML = fn(size);
                }
            );
        },

        // ══════════════════════════════════════════════════════
        //  朋友圈
        // ══════════════════════════════════════════════════════

        _momentsPage: 1,

        /**
         * 打开朋友圈
         * 渲染在右侧内容区（#content-col），左侧导航和会话列表保持可见
         */
        async showMoments() {
            this._openPane('moments-pane');
            this._momentsPage = 1;
            var cam = document.getElementById('moments-camera');
            if (cam && !cam.__bound) {
                cam.__bound = true;
                cam.onclick = function () { App.openComposer(); };
            }
            await this.loadMoments();
        },

        hideMoments() {
            this.closePane();
        },

        async loadMoments(append) {
            var list = document.getElementById('moments-list');
            if (!list) return;
            var self = this;

            if (!append) {
                list.innerHTML = '<div class="moments-loading">加载中…</div>';
            }

            try {
                var posts = await Moments.timeline(
                    Store.me.login, Moments.PAGE * this._momentsPage);

                if (!append) list.innerHTML = '';
                if (!posts.length && !append) {
                    list.innerHTML = '<div class="moments-empty">' +
                        '<p>还没有动态</p><p class="sub">点右上角「发表」说点什么</p></div>';
                    return;
                }

                // 只渲染新增的那一段，避免整列表重绘导致闪一下
                var from = append ? list.children.length : 0;
                for (var i = from; i < posts.length; i++) {
                    list.appendChild(await this.renderMoment(posts[i]));
                }

                var more = document.getElementById('moments-more');
                if (more) {
                    more.style.display = posts.length >= Moments.PAGE * this._momentsPage ? '' : 'none';
                }
            } catch (e) {
                list.innerHTML = '<div class="moments-empty">加载失败：' +
                    (e.message || e) + '</div>';
                if (global.console) console.error('[朋友圈]', e);
            }
        },

        async renderMoment(post) {
            var self = this;
            var myLogin = Store.me.login;
            var el = document.createElement('div');
            el.className = 'moment';

            // 头像
            var av = document.createElement('img');
            av.className = 'moment-avatar';
            av.src = 'https://github.com/' + post.author + '.png?size=92';
            // 点头像进 TA 主页（可以关注 / 发消息）
            av.style.cursor = 'pointer';
            (function (who) {
                av.onclick = function () { self.showProfile(who); };
            })(post.author);
            av.onerror = function () { av.style.visibility = 'hidden'; };
            el.appendChild(av);

            var body = document.createElement('div');
            body.className = 'moment-body';

            var name = document.createElement('div');
            name.className = 'moment-name';
            name.textContent = post.author;
            body.appendChild(name);

            if (post.text) {
                var txt = document.createElement('div');
                txt.className = 'moment-text';
                txt.textContent = post.text;
                body.appendChild(txt);
            }

            // 图片：微信那种九宫格
            if (post.images && post.images.length) {
                var grid = document.createElement('div');
                grid.className = 'moment-grid n' + Math.min(post.images.length, 9);
                post.images.slice(0, 9).forEach(function (img, idx) {
                    var cell = document.createElement('div');
                    cell.className = 'moment-cell';
                    var im = document.createElement('img');
                    im.alt = img.n || '';
                    im.loading = 'lazy';
                    im.onclick = function () {
                        self.previewMoment(post, idx);
                    };
                    // 先占位，读回来再填
                    Moments._imgUrl(post.author, img).then(function (u) {
                        im.src = u;
                    }).catch(function () { im.alt = '加载失败'; });
                    cell.appendChild(im);
                    // GIF 角标
                    if (/gif/i.test(img.t || '') || /\.gif$/i.test(img.n || '')) {
                        var gb = document.createElement('span');
                        gb.className = 'att-gif-badge';
                        gb.textContent = 'GIF';
                        cell.appendChild(gb);
                    }
                    grid.appendChild(cell);
                });
                body.appendChild(grid);
            }

            // 时间 + 操作
            var meta = document.createElement('div');
            meta.className = 'moment-meta';
            var tm = document.createElement('span');
            tm.className = 'moment-time';
            tm.textContent = this.timeAgo(post.ts);
            meta.appendChild(tm);

            var acts = document.createElement('span');
            acts.className = 'moment-acts';

            var lb = document.createElement('button');
            lb.className = 'moment-act';
            lb.innerHTML = (global.Icons ? Icons.heart(13) : '♥') + ' 赞';
            var cm = document.createElement('button');
            cm.className = 'moment-act';
            cm.innerHTML = (global.Icons ? Icons.comment(13) : '💬') + ' 评论';

            var likeBox = null;
            lb.onclick = async function () {
                lb.disabled = true;
                try {
                    var liked = await Moments.like(post.author, post.id,
                        myLogin, Store.me.avatar_url);
                    lb.classList.toggle('on', liked);
                    lb.innerHTML = (global.Icons ? Icons.heart(13) : '♥') +
                        (liked ? ' 已赞' : ' 赞');
                    await self.refreshMomentLikes(post, likeBox);
                } catch (e) {
                    self.toast('操作失败：' + (e.message || e), true);
                } finally { lb.disabled = false; }
            };
            /**
             * 发评论
             *
             * ★ 之前是 prompt()，只能打字。
             *   微信的评论是能发图的，所以改成帖内展开的输入栏：
             *   文字 + 选图 + 发送，跟微信一致。
             *
             * @param {string|null} replyTo 回复谁（null = 评论帖子本身）
             */
            var doComment = function (replyTo) {
                // 已展开就收起（再点一次=取消），再点别人会切换对象
                var old = el.querySelector('.moment-cinput');
                if (old) { old.remove(); return; }

                var bar = document.createElement('div');
                bar.className = 'moment-cinput';

                var ta = document.createElement('input');
                ta.type = 'text';
                ta.className = 'moment-cinput-text';
                ta.placeholder = replyTo ? ('回复 ' + replyTo + '…') : '写评论…';
                ta.maxLength = 500;
                bar.appendChild(ta);

                var pic = document.createElement('button');
                pic.className = 'moment-cinput-pic';
                pic.title = '配图（最多 3 张）';
                pic.innerHTML = global.Icons ? Icons.image(16) : '🖼';
                bar.appendChild(pic);

                var send = document.createElement('button');
                send.className = 'moment-cinput-send';
                send.textContent = '发送';
                bar.appendChild(send);

                var picked = [];      // File[]
                var thumbs = document.createElement('div');
                thumbs.className = 'moment-cinput-thumbs';
                bar.insertBefore(thumbs, send);

                function renderThumbs() {
                    thumbs.innerHTML = '';
                    picked.forEach(function (f, i) {
                        var cell = document.createElement('div');
                        cell.className = 'moment-cthumb';
                        var im = document.createElement('img');
                        im.src = (global.URL && URL.createObjectURL)
                            ? URL.createObjectURL(f) : '';
                        cell.appendChild(im);
                        var x = document.createElement('button');
                        x.textContent = '✕';
                        x.onclick = function () { picked.splice(i, 1); renderThumbs(); };
                        cell.appendChild(x);
                        thumbs.appendChild(cell);
                    });
                }

                pic.onclick = async function () {
                    if (picked.length >= 3) {
                        return self.toast('评论最多 3 张图', true);
                    }
                    try {
                        var fs = await Attach.pick(false);
                        if (!fs || !fs.length) return;
                        var parts = Attach.partition(fs);
                        if (parts.tooBig.length) {
                            self.toast('「' + parts.tooBig[0].name + '」太大，已跳过', true);
                        }
                        var room = 3 - picked.length;
                        parts.ok.slice(0, room).forEach(function (f) { picked.push(f); });
                        if (parts.ok.length > room) {
                            self.toast('评论最多 3 张图', true);
                        }
                        renderThumbs();
                    } catch (e) {
                        self.toast('选图失败：' + (e.message || e), true);
                    }
                };

                var submit = function () {
                    var text = (ta.value || '').trim();
                    if (!text && !picked.length) {
                        return self.toast('写点什么，或配张图', true);
                    }
                    send.disabled = true;
                    send.textContent = picked.length ? '上传中…' : '发送中…';
                    Moments.comment(post.author, post.id, myLogin,
                        Store.me.avatar_url, text, replyTo, picked)
                        .then(function () {
                            self.toast(replyTo ? ('已回复 ' + replyTo) : '已评论');
                            bar.remove();
                            self.refreshMomentComments(post, cbox);
                        })
                        .catch(function (e) {
                            self.toast('评论失败：' + (e.message || e), true);
                            send.disabled = false;
                            send.textContent = '发送';
                        });
                };

                send.onclick = submit;
                ta.onkeydown = function (e) {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') bar.remove();
                };

                body.appendChild(bar);
                setTimeout(function () { ta.focus(); }, 40);
            };

            cm.onclick = function () { doComment(null); };

            acts.appendChild(lb);
            acts.appendChild(cm);

            // 自己的帖可以删
            if (String(post.author).toLowerCase() === myLogin.toLowerCase()) {
                var del = document.createElement('button');
                del.className = 'moment-act danger';
                del.textContent = '删除';
                del.onclick = async function () {
                    if (!global.confirm('删除这条动态？赞和评论也会一并删除。')) return;
                    try {
                        await Moments.remove(myLogin, post.id);
                        self.toast('已删除');
                        el.style.opacity = '0';
                        setTimeout(function () { el.remove(); }, 240);
                    } catch (e) {
                        self.toast('删除失败：' + (e.message || e), true);
                    }
                };
                acts.appendChild(del);
            }

            meta.appendChild(acts);
            body.appendChild(meta);

            // 赞 + 评论展示区
            likeBox = document.createElement('div');
            likeBox.className = 'moment-likes';
            body.appendChild(likeBox);

            var cbox = document.createElement('div');
            cbox.className = 'moment-comments';
            body.appendChild(cbox);

            el.appendChild(body);

            // 异步填充赞/评论（不阻塞列表渲染）
            this.refreshMomentLikes(post, likeBox);
            this.refreshMomentComments(post, cbox);

            // 赞按钮当前状态
            Moments.likes(post.author, post.id).then(function (ls) {
                var mine = ls.some(function (x) {
                    return String(x.login).toLowerCase() === myLogin.toLowerCase();
                });
                lb.classList.toggle('on', mine);
                lb.innerHTML = (global.Icons ? Icons.heart(13) : '♥') +
                    (mine ? ' 已赞' : ' 赞');
            }).catch(function () { /* 忽略 */ });

            return el;
        },

        async refreshMomentLikes(post, box) {
            if (!box) return;
            try {
                var ls = await Moments.likes(post.author, post.id);
                if (!ls.length) { box.style.display = 'none'; return; }
                box.style.display = '';
                box.innerHTML = '';
                var h = document.createElement('span');
                h.className = 'moment-like-ico';
                h.innerHTML = (global.Icons ? Icons.heart(12) : '♥');
                box.appendChild(h);
                var names = ls.map(function (x) { return x.login; }).join('、');
                var t = document.createElement('span');
                t.textContent = names;
                box.appendChild(t);
            } catch (e) { /* 忽略 */ }
        },

        async refreshMomentComments(post, box) {
            if (!box) return;
            try {
                var cs = await Moments.comments(post.author, post.id);
                if (!cs.length) { box.style.display = 'none'; return; }
                box.style.display = '';
                box.innerHTML = '';
                var self2 = this;
                cs.forEach(function (c) {
                    var row = document.createElement('div');
                    row.className = 'moment-comment';

                    var who = document.createElement('span');
                    who.className = 'moment-cname';
                    who.textContent = c.login;
                    row.appendChild(who);

                    // 回复链：A 回复 B 时，把 B 的名字带上
                    if (c.replyTo) {
                        var rp = document.createElement('span');
                        rp.className = 'moment-creply';
                        rp.textContent = '回复';
                        row.appendChild(rp);
                        var rn = document.createElement('span');
                        rn.className = 'moment-cname';
                        rn.textContent = c.replyTo;
                        row.appendChild(rn);
                    }

                    var tx = document.createElement('span');
                    tx.textContent = '：' + c.text;
                    row.appendChild(tx);

                    // ★ 评论配图（微信评论也能发图）
                    // 图在评论者自己的主页仓库，所以要用 c.login 取地址，
                    // 用帖子作者的 login 会 404。
                    if (c.imgs && c.imgs.length) {
                        var gal = document.createElement('div');
                        gal.className = 'moment-cimgs';
                        c.imgs.forEach(function (im, ii) {
                            var cell = document.createElement('img');
                            cell.className = 'moment-cimg skeleton';
                            cell.alt = im.n || '';
                            cell.onload = function () {
                                cell.classList.remove('skeleton');
                            };
                            // GIF 直接引原图就会动，绝不走 canvas 压缩
                            Moments._commentImgUrl(c.login, im)
                                .then(function (u) { cell.src = u; })
                                .catch(function () { cell.alt = '图片加载失败'; });
                            cell.onclick = function (e) {
                                e.stopPropagation();
                                self2.previewMomentImages(c.imgs, ii, c.login);
                            };
                            gal.appendChild(cell);
                        });
                        row.appendChild(gal);
                    }

                    // ★ 点评论 = 回复这个人
                    // 自己的评论不给自己回复（没意义）
                    var isMine = String(c.login).toLowerCase() ===
                        String((Store.me && Store.me.login) || '').toLowerCase();
                    if (!isMine) {
                        row.classList.add('tappable');
                        row.title = '回复 ' + c.login;
                        row.onclick = function () {
                            if (self2.commentOn) self2.commentOn(post, c.login, cbox);
                        };
                    }

                    box.appendChild(row);
                });
            } catch (e) { /* 忽略 */ }
        },

        /**
         * 回复某条评论（由评论行点击触发）
         * 之所以挂在 this 上：评论行是在 refreshMomentComments 里建的，
         * 拿不到闭包里的 doComment，只能通过实例方法回调。
         */
        commentOn(post, who, cbox) {
            // 复用帖子卡片里的输入栏（它在 el 内，靠 class 找）
            var bar = cbox ? cbox.parentNode.querySelector('.moment-cinput') : null;
            if (bar) { bar.remove(); }

            var self = this;
            var myLogin = Store.me.login;
            var wrap = cbox ? cbox.parentNode : null;
            if (!wrap) return;

            var input = document.createElement('div');
            input.className = 'moment-cinput';
            var ta = document.createElement('input');
            ta.type = 'text';
            ta.className = 'moment-cinput-text';
            ta.placeholder = '回复 ' + who + '…';
            ta.maxLength = 500;
            var send = document.createElement('button');
            send.className = 'moment-cinput-send';
            send.textContent = '发送';
            input.appendChild(ta);
            input.appendChild(send);

            var submit = function () {
                var text = (ta.value || '').trim();
                if (!text) return;
                send.disabled = true;
                Moments.comment(post.author, post.id, myLogin,
                    Store.me.avatar_url, text, who)
                    .then(function () {
                        self.toast('已回复 ' + who);
                        input.remove();
                        self.refreshMomentComments(post, cbox);
                    })
                    .catch(function (e) {
                        self.toast('回复失败：' + (e.message || e), true);
                        send.disabled = false;
                    });
            };
            send.onclick = submit;
            ta.onkeydown = function (e) {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') input.remove();
            };
            wrap.appendChild(input);
            setTimeout(function () { ta.focus(); }, 40);
        },

        /**
         * 预览一组图片（帖子九宫格 / 评论配图共用）
         *
         * @param {Array} imgs  [{p,n,t,s}]
         * @param {number} idx  从第几张开始
         * @param {string} owner 图片所在仓库的归属（评论图是评论者）
         */
        previewMomentImages(imgs, idx, owner) {
            if (!imgs || !imgs.length) return;
            var self = this;
            var cur = idx || 0;

            var ov = document.createElement('div');
            ov.className = 'att-overlay';
            var box = document.createElement('div');
            box.className = 'att-ov-box';

            var close = document.createElement('button');
            close.className = 'att-ov-close';
            close.textContent = '✕';
            close.onclick = function () {
                if (ov.parentNode) ov.parentNode.removeChild(ov);
            };
            box.appendChild(close);

            var img = document.createElement('img');
            img.className = 'att-ov-img';
            box.appendChild(img);

            function show(i) {
                cur = (i + imgs.length) % imgs.length;
                Moments._commentImgUrl(owner, imgs[cur])
                    .then(function (u) { img.src = u; });
            }

            if (imgs.length > 1) {
                var nav = document.createElement('div');
                nav.className = 'att-ov-nav';
                var prev = document.createElement('button');
                prev.textContent = '‹';
                prev.onclick = function (e) { e.stopPropagation(); show(cur - 1); };
                var next = document.createElement('button');
                next.textContent = '›';
                next.onclick = function (e) { e.stopPropagation(); show(cur + 1); };
                nav.appendChild(prev); nav.appendChild(next);
                box.appendChild(nav);
            }

            ov.appendChild(box);
            ov.onclick = function () {
                if (ov.parentNode) ov.parentNode.removeChild(ov);
            };
            box.onclick = function (e) { e.stopPropagation(); };
            document.body.appendChild(ov);
            show(cur);
        },

        /** 朋友圈图片全屏预览 */
        previewMoment(post, idx) {
            var self = this;
            var ov = document.createElement('div');
            ov.className = 'att-overlay';
            var box = document.createElement('div');
            box.className = 'att-ov-box';
            var close = document.createElement('button');
            close.className = 'att-ov-close';
            close.textContent = '✕';
            close.onclick = function () { document.body.removeChild(ov); };
            box.appendChild(close);

            var img = document.createElement('img');
            img.src = '';
            box.appendChild(img);
            ov.appendChild(box);
            ov.onclick = function (e) {
                if (e.target === ov) document.body.removeChild(ov);
            };
            document.body.appendChild(ov);

            var cur = idx;
            var load = function (i) {
                var im = post.images[i];
                if (!im) return;
                Moments._imgUrl(post.author, im).then(function (u) { img.src = u; });
            };
            load(cur);

            // 左右切换
            if (post.images.length > 1) {
                var prev = document.createElement('button');
                prev.className = 'att-ov-nav prev';
                prev.textContent = '‹';
                var next = document.createElement('button');
                next.className = 'att-ov-nav next';
                next.textContent = '›';
                prev.onclick = function (e) {
                    e.stopPropagation();
                    cur = (cur - 1 + post.images.length) % post.images.length;
                    load(cur);
                };
                next.onclick = function (e) {
                    e.stopPropagation();
                    cur = (cur + 1) % post.images.length;
                    load(cur);
                };
                box.appendChild(prev);
                box.appendChild(next);
            }
        },

        /** 发表朋友圈 */
        /**
         * 发朋友圈
         *
         * ★ 之前是 prompt + confirm 两连问，一点都不像微信。
         *   现在做成真正的编辑页：文字区 + 九宫格 + 底部选项，
         *   跟微信发朋友圈的布局对齐。
         */
        MAX_MOMENT_IMGS: 9,

        openComposer() {
            var self = this;
            var col = document.getElementById('content-col');
            if (!col) return;

            // 已存在就复用（避免重复打开丢草稿）
            var box = document.getElementById('composer-pane');
            if (!box) {
                box = document.createElement('section');
                box.id = 'composer-pane';
                box.className = 'pane-full composer-pane';
                col.appendChild(box);
            }

            var me = Store.me || {};
            box.innerHTML =
                '<header class="composer-head">' +
                    '<button class="composer-cancel" id="cmp-cancel">取消</button>' +
                    '<button class="composer-send" id="cmp-send">发表</button>' +
                '</header>' +
                '<div class="composer-body">' +
                    '<textarea id="cmp-text" class="composer-text" ' +
                        'placeholder="这一刻的想法…" maxlength="1000"></textarea>' +
                    '<div id="cmp-grid" class="composer-grid"></div>' +
                    '<div class="composer-rows">' +
                        '<div class="composer-row"><span>谁可以看</span>' +
                            '<span class="composer-row-v">公开</span></div>' +
                        '<div class="composer-row" id="cmp-loc-row">' +
                            '<span>所在位置</span>' +
                            '<span class="composer-row-v" id="cmp-loc">（不显示）</span></div>' +
                    '</div>' +
                '</div>';

            this._cmpImgs = [];       // {file, url(blob), name}
            this.renderComposerGrid();

            var cancel = document.getElementById('cmp-cancel');
            if (cancel) cancel.onclick = function () { self.closeComposer(); };
            var send = document.getElementById('cmp-send');
            if (send) send.onclick = function () { self.postMoment(); };

            // 位置：让用户输入，存进正文尾部（微信也是文本里带位置）
            var locRow = document.getElementById('cmp-loc-row');
            if (locRow) locRow.onclick = function () {
                var v = global.prompt('所在位置（留空则不显示）：',
                    (self._cmpLoc || ''));
                if (v === null) return;
                self._cmpLoc = v.trim();
                var el = document.getElementById('cmp-loc');
                if (el) el.textContent = self._cmpLoc || '（不显示）';
            };

            box.style.display = 'flex';
            this.mountIcons();
            setTimeout(function () {
                var t = document.getElementById('cmp-text');
                if (t) t.focus();
            }, 60);
        },

        closeComposer() {
            var box = document.getElementById('composer-pane');
            if (box) box.style.display = 'none';
            // 释放 blob URL，别占内存
            (this._cmpImgs || []).forEach(function (it) {
                if (it.url && global.URL && URL.revokeObjectURL) {
                    try { URL.revokeObjectURL(it.url); } catch (e) {}
                }
            });
            this._cmpImgs = [];
            this._cmpLoc = '';
        },

        /** 九宫格：末位是 + 按钮 */
        renderComposerGrid() {
            var grid = document.getElementById('cmp-grid');
            if (!grid) return;
            var self = this;
            grid.innerHTML = '';
            var imgs = this._cmpImgs || [];

            imgs.forEach(function (it, idx) {
                var cell = document.createElement('div');
                cell.className = 'cmp-cell';
                var im = document.createElement('img');
                im.src = it.url;
                im.alt = '';
                cell.appendChild(im);
                var del = document.createElement('button');
                del.className = 'cmp-del';
                del.textContent = '✕';
                del.onclick = function (e) {
                    e.stopPropagation();
                    if (it.url && global.URL && URL.revokeObjectURL) {
                        try { URL.revokeObjectURL(it.url); } catch (err) {}
                    }
                    self._cmpImgs.splice(idx, 1);
                    self.renderComposerGrid();
                };
                cell.appendChild(del);
                grid.appendChild(cell);
            });

            if (imgs.length < this.MAX_MOMENT_IMGS) {
                var add = document.createElement('button');
                add.className = 'cmp-add';
                add.innerHTML = '<span class="cmp-plus">+</span>' +
                    '<span class="cmp-add-n">' + imgs.length + '/' + this.MAX_MOMENT_IMGS + '</span>';
                add.onclick = function () { self.pickComposerImages(); };
                grid.appendChild(add);
            }
        },

        async pickComposerImages() {
            var self = this;
            var room = this.MAX_MOMENT_IMGS - (this._cmpImgs || []).length;
            if (room <= 0) { this.toast('最多 9 张', true); return; }

            try {
                var files = await Attach.pick(false);
                if (!files || !files.length) return;
                var parts = Attach.partition(files);
                if (parts.tooBig.length) {
                    this.toast('「' + parts.tooBig[0].name + '」超过 200MB，已跳过', true);
                }
                var ok = parts.ok.slice(0, room);
                if (parts.ok.length > room) {
                    this.toast('最多 9 张，多余的已忽略', true);
                }
                ok.forEach(function (f) {
                    var url = (global.URL && URL.createObjectURL)
                        ? URL.createObjectURL(f) : '';
                    self._cmpImgs.push({ file: f, url: url, name: f.name });
                });
                this.renderComposerGrid();
            } catch (e) {
                this.toast('选择图片失败：' + (e.message || e), true);
            }
        },

        async postMoment() {
            var self = this;
            var ta = document.getElementById('cmp-text');
            var text = ta ? ta.value.trim() : '';
            var imgs = this._cmpImgs || [];

            if (!text && !imgs.length) {
                this.toast('说点什么，或配张图', true);
                return;
            }

            // 位置附加到正文（微信也是这么展示的）
            if (this._cmpLoc) {
                text = text ? (text + '\n📍 ' + this._cmpLoc) : ('📍 ' + this._cmpLoc);
            }

            var btn = document.getElementById('cmp-send');
            if (btn) { btn.disabled = true; btn.textContent = '发表中…'; }

            try {
                var uploaded = [];
                for (var i = 0; i < imgs.length; i++) {
                    if (btn) btn.textContent = '上传 ' + (i + 1) + '/' + imgs.length;
                    uploaded.push(await Moments.uploadImage(
                        Store.me.login, imgs[i].file));
                }
                await Moments.publish(Store.me.login, text, uploaded);
                this.toast('已发表');
                this.closeComposer();
                await this.loadMoments();
            } catch (e) {
                this.toast('发表失败：' + (e.message || e), true);
                if (global.console) console.error('[发表]', e);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '发表'; }
            }
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
