/**
 * FaceHub 主控制器
 *
 * 三边同源：FaceHub 与 github_drive / 仓鼠 同在 cool-zimo.github.io，
 * localStorage 共享，所以登录一次三个应用通用。
 */
(function (global) {
    'use strict';

    var API = global.API;
    var Store = global.Store;
    var Timeline = global.Timeline;
    var Chat = global.Chat;

    // 与 drive / 仓鼠 共用的令牌存储位置（三边令牌互认）
    var TOKEN_KEYS = ['facehub.token', 'github_drive_token', 'cangshu.token'];
    var USER_KEYS = ['facehub.user', 'github_drive_user', 'cangshu.user'];

    var App = {
        view: 'timeline',

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
        },

        /** 其他应用已登录 → 显示"沿用账号" */
        showBridgeHint() {
            var user = this.getSavedUser();
            var box = document.getElementById('bridge-box');
            if (!box || !user) return;
            document.getElementById('bridge-info').innerHTML =
                '<strong>' + this.esc(user.login) + '</strong>' +
                '<span class="bridge-note">令牌只在你本机浏览器里，不会上传</span>';
            box.style.display = '';
            var self = this;
            document.getElementById('bridge-btn').onclick = function () {
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
                this._me = await API.me();
                this.saveSession(token, this._me);
            } catch (e) {
                if (btn) { btn.disabled = false; btn.textContent = '登录'; }
                this.toast('登录失败：' + e.message, true);
                return;
            }

            document.getElementById('login').style.display = 'none';
            document.getElementById('app').style.display = '';
            this.toast('正在准备你的主页…');

            try {
                await Store.init(this._me);
            } catch (e) {
                this.toast('初始化主页失败：' + e.message, true);
                return;
            }

            this.bindApp();
            this.renderMe();
            this.renderFollowing();
            this.switchView('timeline');
        },

        // ── 绑定 ───────────────────────────────────────────────
        bindApp() {
            var self = this;

            // 顶栏 tab + 左栏菜单，同一套 data-view
            document.querySelectorAll('.tab, .side-item').forEach(function (b) {
                b.onclick = function () { self.switchView(b.getAttribute('data-view')); };
            });

            document.getElementById('logout-btn').onclick = function () { self.logout(); };
            document.getElementById('me-chip').onclick = function () { self.switchView('profile'); };

            var composer = document.getElementById('composer');
            var counter = document.getElementById('char-count');
            composer.oninput = function () {
                counter.textContent = composer.value.length + ' / 500';
                composer.style.height = 'auto';
                composer.style.height = Math.max(40, composer.scrollHeight) + 'px';
            };

            document.getElementById('publish-btn').onclick = function () { self.publish(); };
            document.getElementById('follow-btn').onclick = function () { self.addFollow(); };
            document.getElementById('follow-input').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') self.addFollow();
            });

            // ── 私聊 ──
            document.getElementById('new-chat-btn').onclick = function () {
                var box = document.getElementById('chat-new');
                box.style.display = box.style.display === 'none' ? '' : 'none';
                if (box.style.display === '') document.getElementById('chat-peer').focus();
            };
            document.getElementById('chat-start-btn').onclick = function () { self.startChat(); };
            document.getElementById('chat-peer').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') self.startChat();
            });
            document.getElementById('chat-send-btn').onclick = function () { self.sendChat(); };
            document.getElementById('chat-input').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') self.sendChat();
            });
        },

        renderMe() {
            var me = Store.me;
            document.getElementById('me-name').textContent = me.login;
            var av = me.avatar_url || '';
            document.getElementById('me-avatar').src = av;
            document.getElementById('composer-avatar').src = av;
            this.updateQuota();
        },

        updateQuota() {
            var el = document.getElementById('quota');
            if (el) el.textContent = 'API ' + API.stats.billed + ' · 免费 ' + API.stats.free;
        },

        // ── 视图 ───────────────────────────────────────────────
        switchView(view) {
            this.view = view;
            document.querySelectorAll('.tab, .side-item').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-view') === view);
            });

            var isChat = (view === 'chats');

            // 私聊是全宽两栏，和常规三栏互斥。
            // 注意 col-right 也要隐藏，否则右栏会挤在私聊视图旁边。
            var layout = document.querySelector('.layout');
            layout.classList.toggle('chat-mode', isChat);

            document.getElementById('chats-view').style.display = isChat ? '' : 'none';
            document.querySelector('.col-left').style.display = isChat ? 'none' : '';
            document.querySelector('.col-right').style.display = isChat ? 'none' : '';
            document.querySelector('.col-main').style.display = isChat ? 'none' : '';
            document.getElementById('composer-box').style.display =
                (!isChat && (view === 'timeline' || view === 'profile')) ? '' : 'none';

            if (isChat) { this.loadChats(); return; }

            if (view === 'timeline') this.loadTimeline();
            else if (view === 'profile') this.loadProfile();
            else if (view === 'discover') this.loadDiscover();
            else this.loadAbout();
        },

        // ── 私聊 ───────────────────────────────────────────────

        currentRoom: null,

        async loadChats() {
            var self = this;
            var list = document.getElementById('room-list');
            var inviteBox = document.getElementById('invite-box');
            list.innerHTML = '<div class="empty-hint" style="padding:14px">载入中…</div>';

            // 待接受邀请（对方发起的会话）
            try {
                var invs = await Chat.invitations();
                if (invs.length) {
                    inviteBox.style.display = '';
                    inviteBox.innerHTML = '<h4>🔔 有人想和你私聊</h4>';
                    invs.forEach(function (inv) {
                        inviteBox.appendChild(self.inviteEl(inv));
                    });
                    this.setBadge(invs.length);
                } else {
                    inviteBox.style.display = 'none';
                    this.setBadge(0);
                }
            } catch (e) {
                inviteBox.style.display = 'none';
            }

            try {
                var rooms = await Chat.listRooms();
                list.innerHTML = '';
                if (!rooms.length) {
                    list.innerHTML = '<div class="empty-hint" style="padding:14px">' +
                        '还没有会话。点上面「+ 新会话」找人聊聊。</div>';
                    return;
                }
                rooms.forEach(function (r) { list.appendChild(self.roomEl(r)); });
            } catch (e) {
                list.innerHTML = '<div class="empty-hint" style="padding:14px;color:#cf222e">' +
                    '载入失败：' + self.esc(e.message) + '</div>';
            }
            this.updateQuota();
        },

        inviteEl(inv) {
            var self = this;
            var row = document.createElement('div');
            row.className = 'invite-row';
            var img = document.createElement('img');
            img.src = 'https://github.com/' + inv.peer + '.png?size=60';
            img.alt = '';
            var who = document.createElement('span');
            who.className = 'who';
            who.textContent = inv.peer;

            var acc = document.createElement('button');
            acc.className = 'inv-accept';
            acc.textContent = '接受';
            acc.onclick = async function () {
                acc.disabled = true;
                acc.textContent = '接受中…';
                try {
                    var res = await Chat.accept(inv.id, inv.name);
                    if (res.verified) {
                        self.toast('已接受 ' + inv.peer + ' 的私聊' +
                            (res.tried > 1 ? '（尝试了 ' + res.tried + ' 条邀请才生效）' : ''));
                        await self.loadChats();
                        var rooms = await Chat.listRooms();
                        var hit = rooms.filter(function (r) { return r.name === inv.name; })[0];
                        if (hit) self.openRoom(hit);
                    } else {
                        // 接受返回成功但实际没生效 —— 幽灵邀请
                        self.toast('邀请已失效（仓库可能被删除重建过）。' +
                            '请让 ' + inv.peer + ' 重新发起会话。', true);
                        await self.loadChats();
                    }
                } catch (e) {
                    self.toast('接受失败：' + e.message, true);
                    acc.disabled = false;
                    acc.textContent = '接受';
                }
            };

            var dec = document.createElement('button');
            dec.className = 'inv-decline';
            dec.textContent = '忽略';
            dec.onclick = async function () {
                try {
                    await Chat.decline(inv.id);
                    await self.loadChats();
                } catch (e) { self.toast(e.message, true); }
            };

            row.appendChild(img);
            row.appendChild(who);
            row.appendChild(acc);
            row.appendChild(dec);
            return row;
        },

        roomEl(room) {
            var self = this;
            var row = document.createElement('button');
            row.className = 'room-row';
            if (this.currentRoom && this.currentRoom.name === room.name) row.classList.add('active');
            row.innerHTML =
                '<img src="https://github.com/' + this.esc(room.peer) + '.png?size=92" alt="">' +
                '<div class="info"><div class="nm">' + this.esc(room.peer) + '</div>' +
                '<div class="sub">' + this.timeAgo(new Date(room.updatedAt).getTime()) +
                (room.private ? ' · 🔒 私密' : '') + '</div></div>';
            row.onclick = function () { self.openRoom(room); };
            return row;
        },

        async openRoom(room) {
            this.currentRoom = room;
            this.e2eState = null;
            document.querySelectorAll('.room-row').forEach(function (r) {
                r.classList.toggle('active', r.querySelector('.nm').textContent === room.peer);
            });
            document.getElementById('chats-view').classList.add('show-chat');

            document.getElementById('chat-head').style.display = '';
            document.getElementById('chat-peer-name').textContent = room.peer;
            document.getElementById('chat-peer-avatar').src =
                'https://github.com/' + room.peer + '.png?size=80';
            document.getElementById('chat-peer-sub').textContent =
                room.private ? '🔒 私密仓库 · ' + room.name : room.name;

            document.getElementById('chat-input-box').style.display = '';

            var box = document.getElementById('chat-messages');
            box.innerHTML = '<div class="empty-hint" style="padding:40px;text-align:center">正在建立加密…</div>';

            // ① 先做密钥交换（发布我的公钥 + 读对方公钥）
            var e2e = null;
            try {
                e2e = await Chat.setupE2E(
                    room.owner, room.name,
                    Store.me.login, room.peer, Store.branch
                );
                this.e2eState = e2e;
                this.renderE2EStatus(e2e, room);
            } catch (e) {
                this.e2eState = { ready: false, reason: e.message };
            }

            // ② 再读消息（带上解密所需的对方公钥）
            try {
                var self = this;
                var msgs = await Chat.messages(room.owner, room.name, true, {
                    myLogin: Store.me.login,
                    peerPub: e2e && e2e.peerPub
                });
                this.renderMessages(msgs);
            } catch (e) {
                box.innerHTML = '<div class="empty-hint" style="padding:40px;text-align:center;color:#cf222e">' +
                    '载入失败：' + this.esc(e.message) + '</div>';
            }
            this.updateQuota();
        },

        /** 「核对安全码」按钮 */
        bindVerify(room, e2e) {
            var self = this;
            var btn = document.getElementById('verify-btn');
            if (!btn) return;
            btn.onclick = function () {
                if (!global.confirm(
                    '你和 ' + room.peer + ' 屏幕上的安全码一致吗？\n\n' +
                    '   ' + (e2e.safetyNumber || '') + '\n\n' +
                    '只有当另一个人当面/电话告诉你同样的号码时，才点「确定」。\n' +
                    '不一致 = 可能有人在中间窃听，不要点确定。'
                )) return;
                global.E2E.markVerified(Store.me.login, room.name, e2e.peerPub);
                e2e.verified = true;
                self.renderE2EStatus(e2e, room);
                self.toast('已标记为核对通过');
            };
        },

        /** 公钥变更后的「重新核对」 */
        bindReverify(room, e2e) {
            var self = this;
            var btn = document.getElementById('reverify-btn');
            if (!btn) return;
            btn.onclick = function () {
                if (!global.confirm(
                    '对方密钥已变更。\n\n' +
                    '如果你知道 ' + room.peer + ' 刚换了设备/清了缓存，' +
                    '可以重新核对新密钥：\n\n   ' + (e2e.safetyNumber || '') + '\n\n' +
                    '确认无误后点「确定」。'
                )) return;
                global.E2E.markVerified(Store.me.login, room.name, e2e.peerPub);
                e2e.verified = true;
                e2e.pubKeyChanged = false;
                self.renderE2EStatus(e2e, room);
                self.toast('已重新核对');
            };
        },

        /** 顶部的加密状态条 */
        renderE2EStatus(e2e, room) {
            var bar = document.getElementById('e2e-bar');
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'e2e-bar';
                bar.className = 'e2e-bar';
                var input = document.getElementById('chat-input-box');
                input.parentNode.insertBefore(bar, input);
            }
            if (e2e && e2e.pubKeyChanged) {
                // 已核对过的会话，公钥却变了 —— 最高优先级警告
                bar.className = 'e2e-bar danger';
                bar.innerHTML = '🚨 <b>安全警告：对方的密钥被更换了</b> · ' +
                    '如果你确认 ' + this.esc(room.peer) + ' 没有换设备，' +
                    '可能有人正在中间窃听。' +
                    '<button id="reverify-btn" class="e2e-btn">重新核对</button>';
                this.bindReverify(room, e2e);
            } else if (e2e && e2e.ready) {
                bar.className = 'e2e-bar ok';
                var sn = e2e.safetyNumber ? '<code class="safety-num">' + e2e.safetyNumber + '</code>' : '';
                if (e2e.verified) {
                    bar.innerHTML = '🔒 <b>端到端加密 · 已核对</b> ' + sn +
                        ' · GitHub 只能看到密文';
                } else {
                    bar.innerHTML = '🔒 <b>端到端加密已启用</b> ' + sn +
                        '<button id="verify-btn" class="e2e-btn">核对安全码</button>' +
                        '<div class="e2e-tip">和 ' + this.esc(room.peer) +
                        ' 线下（见面/电话）比对这串码是否一致。一致才算真的没有中间人。</div>';
                    this.bindVerify(room, e2e);
                }
            } else if (e2e && e2e.peerPubVanished) {
                bar.className = 'e2e-bar danger';
                bar.innerHTML = '🚨 <b>安全警告：对方的密钥消失了</b> · ' +
                    '之前有，现在没了。可能是被删除以强制明文发送。' +
                    '本会话将<b>明文</b>发送，请注意。';
            } else if (e2e && e2e.peerReady === false) {
                bar.className = 'e2e-bar warn';
                bar.innerHTML = '🔑 <b>等待对方上线交换密钥</b> · ' +
                    '你已发布公钥。' + this.esc(room.peer) + ' 打开一次会话后即可加密。' +
                    '当前消息将<b>明文</b>发送。';
            } else {
                bar.className = 'e2e-bar warn';
                bar.innerHTML = '⚠️ <b>加密不可用</b> · ' +
                    this.esc((e2e && (e2e.reason || e2e.error)) || '未知原因') +
                    '。消息将明文发送。';
            }
        },

        renderMessages(msgs) {
            var box = document.getElementById('chat-messages');
            var myLogin = Store.me.login;
            box.innerHTML = '';
            if (!msgs.length) {
                box.innerHTML = '<div class="empty-hint" style="padding:40px;text-align:center">' +
                    '还没有消息。说第一句话吧。</div>';
                return;
            }
            var self = this;
            msgs.forEach(function (m) {
                var mine = m.from.toLowerCase() === myLogin.toLowerCase();
                var row = document.createElement('div');
                row.className = 'bubble-row' + (mine ? ' mine' : '');

                var img = document.createElement('img');
                img.src = m.avatar || ('https://github.com/' + m.from + '.png?size=56');
                img.alt = '';
                row.appendChild(img);

                var b = document.createElement('div');
                b.className = 'bubble' +
                    (m.encrypted ? ' encrypted' : '') +
                    (m.locked ? ' locked' : '');
                b.textContent = m.text;
                if (m.encrypted) b.title = '端到端加密 · GitHub 只存了密文';
                row.appendChild(b);
                box.appendChild(row);

                var meta = document.createElement('div');
                meta.className = 'bubble-meta';
                meta.textContent = (mine ? '你' : m.from) + ' · ' + self.timeAgo(m.ts);
                box.appendChild(meta);
            });
            box.scrollTop = box.scrollHeight;
        },

        async startChat() {
            var input = document.getElementById('chat-peer');
            var peer = (input.value || '').trim();
            if (!peer) return;
            var btn = document.getElementById('chat-start-btn');
            btn.disabled = true;
            btn.textContent = '…';
            try {
                var room = await Chat.start(peer);
                input.value = '';
                document.getElementById('chat-new').style.display = 'none';
                this.toast(room.existed ? '已有会话' : '会话已创建，已邀请 ' + peer);
                await this.loadChats();
                this.openRoom(room);
            } catch (e) {
                this.toast(e.message, true);
            }
            btn.disabled = false;
            btn.textContent = '开始';
            this.updateQuota();
        },

        async sendChat() {
            var input = document.getElementById('chat-input');
            var room = this.currentRoom;
            if (!room) return;
            var text = (input.value || '').trim();
            if (!text) return;
            var btn = document.getElementById('chat-send-btn');
            btn.disabled = true;
            input.value = '';
            try {
                var e2e = this.e2eState || {};
                var r = await Chat.send(room.owner, room.name, text, {
                    myLogin: Store.me.login,
                    peerPub: e2e.peerPub
                });
                if (r && r.__encrypted === false && e2e.peerReady === false) {
                    this.toast('⚠️ 对方还没上线，本条明文发送');
                }
                var msgs = await Chat.messages(room.owner, room.name, true, {
                    myLogin: Store.me.login,
                    peerPub: e2e.peerPub
                });
                this.renderMessages(msgs);
                await this.loadChats();
            } catch (e) {
                this.toast('发送失败：' + e.message, true);
                input.value = text;
            }
            btn.disabled = false;
            this.updateQuota();
        },

        setBadge(n) {
            ['chat-badge', 'chat-badge2'].forEach(function (id) {
                var el = document.getElementById(id);
                if (!el) return;
                el.textContent = n;
                el.style.display = n > 0 ? '' : 'none';
            });
        },

        async loadTimeline() {
            var self = this;
            var feed = document.getElementById('feed');
            var status = document.getElementById('feed-status');
            feed.innerHTML = '';
            status.style.display = '';
            status.textContent = '正在载入…';

            try {
                var posts = await Timeline.load(30, function (done, total) {
                    status.textContent = '正在载入… ' + done + '/' + total;
                });
                self.renderPosts(posts, status, '还没有内容。关注几个人，或者自己发一条。');
            } catch (e) {
                status.textContent = '载入失败：' + e.message;
            }
            this.updateQuota();
        },

        async loadProfile() {
            var feed = document.getElementById('feed');
            var status = document.getElementById('feed-status');
            feed.innerHTML = '';
            status.style.display = '';
            status.textContent = '正在载入…';
            try {
                var posts = await Timeline.loadUser(Store.me.login, 30);
                this.renderPosts(posts, status, '你还没有发过内容。在上面写点什么吧。');
            } catch (e) {
                status.textContent = '载入失败：' + e.message;
            }
            this.updateQuota();
        },

        async loadDiscover() {
            var self = this;
            var feed = document.getElementById('feed');
            var status = document.getElementById('feed-status');
            feed.innerHTML = '';
            status.style.display = '';
            status.innerHTML =
                '<div class="note">⚠️ 搜索有 5~30 分钟索引延迟 —— 刚创建的主页不会立刻出现在下面。' +
                '发现功能只用来找陌生人，看关注的人请回时间线（那里是实时的）。</div>' +
                '<div class="discover-form">' +
                '<input id="discover-input" placeholder="搜索关键词，如 facehub">' +
                '<button id="discover-btn" class="btn-primary btn-sm">搜索</button></div>';

            document.getElementById('discover-btn').onclick = function () { self.doDiscover(); };
            document.getElementById('discover-input').addEventListener('keydown', function (e) {
                if (e.key === 'Enter') self.doDiscover();
            });
            document.getElementById('discover-input').focus();
        },

        async doDiscover() {
            var self = this;
            var input = document.getElementById('discover-input');
            var q = (input.value || '').trim() || 'facehub';
            var feed = document.getElementById('feed');
            feed.innerHTML = '<div class="feed-status">搜索中…</div>';

            try {
                var items = await API.searchRepos(q + ' in:name', 20);
                feed.innerHTML = '';
                var found = 0;
                items.forEach(function (r) {
                    if (!/^facehub-/i.test(r.name)) return;
                    found++;
                    var login = r.name.replace(/^facehub-/i, '');
                    var el = document.createElement('div');
                    el.className = 'post';
                    var head = document.createElement('div');
                    head.className = 'post-head';
                    head.innerHTML =
                        '<img class="post-avatar" src="' + self.esc(r.owner.avatar_url) + '" alt="">' +
                        '<div class="post-who"><div class="post-name">' + self.esc(r.owner.login) + '</div>' +
                        '<div class="post-meta">' + self.esc(r.name) +
                        (r.description ? ' · ' + self.esc(r.description) : '') + '</div></div>';
                    var btn = document.createElement('button');
                    btn.className = 'btn-primary btn-sm';
                    btn.textContent = '关注';
                    btn.onclick = function () {
                        btn.disabled = true;
                        self.addFollow(r.owner.login).catch(function () { btn.disabled = false; });
                    };
                    head.appendChild(btn);
                    el.appendChild(head);
                    feed.appendChild(el);
                });
                if (!found) feed.innerHTML = '<div class="feed-status">没有找到 facehub- 开头的主页</div>';
            } catch (e) {
                feed.innerHTML = '<div class="feed-status">搜索失败：' + self.esc(e.message) + '</div>';
            }
            this.updateQuota();
        },

        loadAbout() {
            var feed = document.getElementById('feed');
            var status = document.getElementById('feed-status');
            status.style.display = 'none';
            feed.innerHTML =
                '<div class="post" style="padding:18px">' +
                '<h3 style="margin-bottom:10px;font-size:17px">FaceHub · 面膜</h3>' +
                '<p style="font-size:15px;color:var(--fb-secondary);line-height:1.5">' +
                '把 GitHub 当作社交网络的后端。每个用户一个 <code>facehub-用户名</code> 仓库，' +
                '一帖就是仓库里的一个 JSON 文件。</p>' +
                '<h3 style="margin:20px 0 10px;font-size:17px">为什么不是"每帖一个仓库"</h3>' +
                '<p style="font-size:15px;color:var(--fb-secondary);line-height:1.5">' +
                '每帖建仓要 3 次内容创建请求（建仓 + 写文件），而内容创建限流是 80/分钟、500/小时，' +
                '很快就撞墙；而且新仓库要 5~30 分钟才进搜索索引，发完自己都搜不到。' +
                '写成自己仓库的一个文件：1 次请求，立即可见。</p>' +
                '<h3 style="margin:20px 0 10px;font-size:17px">配额优化</h3>' +
                '<ul class="principles" style="font-size:14.5px">' +
                '<li>内容存本地缓存，二次打开 <b>零请求</b></li>' +
                '<li>读取带 If-None-Match，没变化返回 304，<b>不计费</b></li>' +
                '<li>列目录同样走 ETag，没有新帖也不计费</li>' +
                '<li>不维护索引文件，用递归 tree 代替，省掉一半写请求</li>' +
                '<li>每人只取最新 5 帖，请求数只与关注人数有关，与总帖数无关</li>' +
                '</ul>' +
                '<h3 style="margin:20px 0 10px;font-size:17px">为什么不用 raw CDN</h3>' +
                '<p style="font-size:15px;color:var(--fb-secondary);line-height:1.5">' +
                '最初设计是"读内容走 raw.githubusercontent.com，完全不占配额"。' +
                '实测发现 raw 对新仓库有严重冷启动延迟 —— 首次访问要数十秒，' +
                '初始化一次跑了 75 秒。改成走 API + 条件请求后，' +
                '首次约 500ms、二次 304 同样不计费，初始化降到 1.1 秒。</p>' +
                '</div>';
        },

        // ── 发帖 ───────────────────────────────────────────────
        async publish() {
            var composer = document.getElementById('composer');
            var btn = document.getElementById('publish-btn');
            var text = (composer.value || '').trim();
            if (!text) return this.toast('说点什么吧', true);

            btn.disabled = true;
            btn.textContent = '发布中…';
            try {
                await Store.publish(text);
                composer.value = '';
                composer.style.height = 'auto';
                document.getElementById('char-count').textContent = '0 / 500';
                this.toast('已发布');
                if (this.view === 'profile') this.loadProfile();
                else this.loadTimeline();
            } catch (e) {
                this.toast('发布失败：' + e.message, true);
            }
            btn.disabled = false;
            btn.textContent = '发布';
            this.updateQuota();
        },

        // ── 关注 ───────────────────────────────────────────────
        async addFollow(login) {
            login = login || (document.getElementById('follow-input').value || '').trim();
            if (!login) return;
            if (login === Store.me.login) return this.toast('不能关注自己', true);
            try {
                await Store.follow(login);
                Timeline.invalidate(login);
                document.getElementById('follow-input').value = '';
                this.renderFollowing();
                this.toast('已关注 ' + login);
                if (this.view === 'timeline') this.loadTimeline();
            } catch (e) {
                this.toast(e.message, true);
                throw e;
            }
            this.updateQuota();
        },

        async removeFollow(login) {
            try {
                await Store.unfollow(login);
                Timeline.invalidate(login);
                this.renderFollowing();
                this.toast('已取关 ' + login);
                if (this.view === 'timeline') this.loadTimeline();
            } catch (e) {
                this.toast(e.message, true);
            }
        },

        renderFollowing() {
            var box = document.getElementById('following-list');
            box.innerHTML = '';
            if (!Store.following.length) {
                box.innerHTML = '<div class="empty-hint">还没有关注任何人</div>';
                return;
            }
            var self = this;
            Store.following.forEach(function (u) {
                var row = document.createElement('div');
                row.className = 'follow-row';
                var img = document.createElement('img');
                img.src = 'https://github.com/' + u + '.png?size=64';
                img.alt = '';
                var who = document.createElement('span');
                who.className = 'who';
                who.textContent = u;
                var x = document.createElement('button');
                x.className = 'follow-x';
                x.textContent = '×';
                x.title = '取关';
                x.onclick = function () { self.removeFollow(u); };
                row.appendChild(img);
                row.appendChild(who);
                row.appendChild(x);
                box.appendChild(row);
            });
        },

        // ── 渲染 ───────────────────────────────────────────────
        renderPosts(posts, status, emptyText) {
            var feed = document.getElementById('feed');
            feed.innerHTML = '';
            if (!posts.length) {
                status.style.display = '';
                status.textContent = emptyText;
                return;
            }
            status.style.display = 'none';
            var self = this;
            posts.forEach(function (p) { feed.appendChild(self.postEl(p)); });
        },

        /** 从 <template> 克隆图标，避免手写 SVG 字符串 */
        icon: function (id) {
            var t = document.getElementById(id);
            return t ? t.content.cloneNode(true) : document.createTextNode('');
        },

        postEl(p) {
            var self = this;
            var el = document.createElement('div');
            el.className = 'post';

            // 头部
            var head = document.createElement('div');
            head.className = 'post-head';
            var av = document.createElement('img');
            av.className = 'post-avatar';
            var login = p.author || p.login;
            av.src = p.avatar || (login ? 'https://github.com/' + login + '.png?size=80' : '');
            av.alt = '';
            head.appendChild(av);

            var who = document.createElement('div');
            who.className = 'post-who';
            var nm = document.createElement('div');
            nm.className = 'post-name';
            nm.textContent = p.name || login;
            var meta = document.createElement('div');
            meta.className = 'post-meta';
            meta.textContent = '@' + login + ' · ' + this.timeAgo(p.ts);
            who.appendChild(nm);
            who.appendChild(meta);
            head.appendChild(who);
            el.appendChild(head);

            // 正文
            var body = document.createElement('div');
            body.className = 'post-text';
            body.textContent = p.text || '';
            el.appendChild(body);

            // 操作栏：赞 / 评论 / 分享
            var bar = document.createElement('div');
            bar.className = 'post-actions';

            var likeKey = 'fh:like:' + (p.id || (login + '/' + p.name));
            var liked = this.ls(likeKey) === '1';

            var likeBtn = document.createElement('button');
            likeBtn.className = 'act' + (liked ? ' liked' : '');
            likeBtn.appendChild(this.icon('tpl-like'));
            var likeLabel = document.createElement('span');
            likeLabel.textContent = liked ? '已赞' : '赞';
            likeBtn.appendChild(likeLabel);
            likeBtn.onclick = function () {
                var now = self.ls(likeKey) === '1';
                self.ls(likeKey, now ? null : '1');
                likeBtn.classList.toggle('liked', !now);
                likeLabel.textContent = now ? '赞' : '已赞';
            };

            var cmtBtn = document.createElement('button');
            cmtBtn.className = 'act';
            cmtBtn.appendChild(this.icon('tpl-comment'));
            var cmtLabel = document.createElement('span');
            cmtLabel.textContent = '评论';
            cmtBtn.appendChild(cmtLabel);
            cmtBtn.onclick = function () { self.toast('评论功能在第二版，会和私聊一起做'); };

            var shareBtn = document.createElement('button');
            shareBtn.className = 'act';
            shareBtn.appendChild(this.icon('tpl-share'));
            var shareLabel = document.createElement('span');
            shareLabel.textContent = '分享';
            shareBtn.appendChild(shareLabel);
            shareBtn.onclick = function () {
                var url = 'https://github.com/' + login + '/' + Store.repoOf(login);
                if (global.navigator.clipboard) {
                    global.navigator.clipboard.writeText(url).then(
                        function () { self.toast('已复制主页链接'); },
                        function () { self.toast(url); }
                    );
                } else {
                    self.toast(url);
                }
            };

            bar.appendChild(likeBtn);
            bar.appendChild(cmtBtn);
            bar.appendChild(shareBtn);
            el.appendChild(bar);

            return el;
        },

        timeAgo(ts) {
            if (!ts) return '';
            var d = Math.floor((Date.now() - ts) / 1000);
            if (d < 60) return '刚刚';
            if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
            if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
            if (d < 2592000) return Math.floor(d / 86400) + ' 天前';
            return new Date(ts).toLocaleDateString('zh-CN');
        },

        // ── 工具 ───────────────────────────────────────────────
        esc: function (s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },

        toast(msg, isErr) {
            var t = document.getElementById('toast');
            t.textContent = msg;
            t.className = 'toast' + (isErr ? ' error' : '');
            t.style.display = '';
            clearTimeout(this._tt);
            this._tt = setTimeout(function () { t.style.display = 'none'; }, isErr ? 4500 : 2400);
        }
    };

    API.onStats = function () { App.updateQuota(); };

    global.App = App;
    document.addEventListener('DOMContentLoaded', function () { App.boot(); });
})(window);
