/**
 * AI 自动回复
 *
 * 开启后，收到对方消息会自动调智谱生成回复并**加密**发回去。
 *
 * ★ 设计上最容易出事的地方是「重复回复」，所以模块里
 *   一半的代码都在防这个：
 *
 *   ① 已处理 id 持久化到 localStorage（刷新/换标签页也不会重来一遍）
 *   ② 并发锁（轮询 5 秒一次，AI 可能要好几秒才回，不锁就会并发打 API）
 *   ③ 基线时间戳（首次开启时把当前最新一条记为基线，
 *      否则一开就把几年历史全部回一遍，瞬间刷爆）
 *   ④ 同一条消息失败次数上限（避免网络一坏就无限重试刷屏）
 *   ⑤ 只回别人发的、解开了的、有内容的
 *
 * 页面关掉就不生效了 —— 没有服务端，纯前端轮询，这是必然的。
 */
(function (global) {
    'use strict';

    var CK = 'fh:autoReply';        // 配置
    var DK = 'fh:autoReplyDone';    // 已处理的消息 id
    var MAX_DONE = 500;             // 上限，超出丢最老的（FIFO）
    var MAX_TRY = 2;                // 同一条最多试几次

    var DEF = {
        on: false,
        key: '',
        model: 'glm-4-flash-250414',
        base: 'https://open.bigmodel.cn/api/paas/v4',
        sys: '你是在 FaceHub 里聊天的助手。回答简洁自然，像真人发消息，别用 Markdown，别分点列清单。',
        scope: 'all',               // all=所有私聊  current=仅当前打开的会话
        delay: 0,                   // 回复前装模作样等一下（毫秒）
        maxLen: 500                 // 回复截断长度
    };

    var AIReply = {

        MODELS: [
            { id: 'glm-4-flash-250414', name: 'GLM-4 Flash（免费）', free: true },
            { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash（免费）', free: true },
            { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash（免费）', free: true },
            { id: 'glm-4-plus', name: 'GLM-4 Plus（付费）', free: false },
            { id: 'glm-4-0520', name: 'GLM-4（付费）', free: false }
        ],

        // ── 配置 ──────────────────────────────────────────────
        cfg: function () {
            try {
                var s = global.localStorage.getItem(CK);
                if (!s) return Object.assign({}, DEF);
                return Object.assign({}, DEF, JSON.parse(s));
            } catch (e) {
                return Object.assign({}, DEF);
            }
        },

        save: function (c) {
            global.localStorage.setItem(CK, JSON.stringify(Object.assign({}, this.cfg(), c)));
        },

        ready: function () {
            var c = this.cfg();
            return !!(c.on && c.key);
        },

        // ── 已处理记录（FIFO，防止无限膨胀）────────────────────
        _done: function () {
            try {
                var s = global.localStorage.getItem(DK);
                return s ? JSON.parse(s) : {};
            } catch (e) { return {}; }
        },

        _markDone: function (id, tries) {
            var d = this._done();
            d[id] = { t: Date.now(), n: tries || 1 };
            var keys = Object.keys(d);
            if (keys.length > MAX_DONE) {
                // 按时间排序，删掉最老的那批
                keys.sort(function (a, b) { return (d[a].t || 0) - (d[b].t || 0); });
                for (var i = 0; i < keys.length - MAX_DONE; i++) delete d[keys[i]];
            }
            global.localStorage.setItem(DK, JSON.stringify(d));
        },

        _tries: function (id) {
            var d = this._done();
            return d[id] ? (d[id].n || 1) : 0;
        },

        /**
         * 设定基线：把当前最新一条消息的 ts 记下来。
         * 之后的自动回复只处理 ts 比它更新的消息 ——
         * 否则刚开启就会把全部历史消息回一遍。
         */
        setBaseline: function (convKey, ts) {
            var k = 'fh:autoReplyBase';
            var b = {};
            try { b = JSON.parse(global.localStorage.getItem(k) || '{}'); } catch (e) { }
            if (!b[convKey] || ts > b[convKey]) {
                b[convKey] = ts;
                global.localStorage.setItem(k, JSON.stringify(b));
            }
        },

        baseline: function (convKey) {
            var k = 'fh:autoReplyBase';
            try {
                var b = JSON.parse(global.localStorage.getItem(k) || '{}');
                return b[convKey] || 0;
            } catch (e) { return 0; }
        },

        // ══════════════════════════════════════════════════════
        //  主入口
        // ══════════════════════════════════════════════════════
        /**
         * 在轮询拿到新消息后调用
         * @param conv  当前会话 {owner,name,type,title}
         * @param msgs  消息列表（已解密）
         * @param opts  {myLogin, peerPub, send: function(text)}
         */
        _busy: false,

        async maybeReply(conv, msgs, opts) {
            opts = opts || {};
            if (!this.ready()) return;
            if (this._busy) return;                  // ② 并发锁
            if (!conv || !msgs || !msgs.length) return;

            var c = this.cfg();
            var convKey = conv.owner + '/' + conv.name;

            // 首次见到这个会话 → 先立基线，本次不回
            if (!this.baseline(convKey)) {
                var newest = msgs[msgs.length - 1];
                this.setBaseline(convKey, (newest && newest.ts) || Date.now());
                return;
            }

            // 找最后一条"该回"的消息
            var target = null;
            var base = this.baseline(convKey);
            var me = String(opts.myLogin || '').toLowerCase();

            for (var i = msgs.length - 1; i >= 0; i--) {
                var m = msgs[i];
                if (!m || !m.id) continue;
                if (m.ts <= base) break;                     // ③ 基线之前的，到此为止
                if (String(m.from).toLowerCase() === me) continue;  // ⑤ 不是我发的
                if (m.locked) continue;                      // 解不开的不回
                if (!(m.text || '').trim()) continue;
                var t = this._tries(m.id);
                if (t >= MAX_TRY) continue;                  // ④ 试过太多次
                if (t > 0 && t < MAX_TRY) {
                    target = m; break;                       // 上次失败，重试
                }
                target = m; break;
            }

            if (!target) return;

            // 作用域：scope=current 时只回当前打开的会话
            if (c.scope === 'current') {
                var cur = opts.currentConv;
                if (!cur || (cur.owner + '/' + cur.name) !== convKey) return;
            }

            this._busy = true;
            try {
                var reply = await this.ask(target.text, c);
                if (!reply) return;

                if (c.delay > 0) {
                    await new Promise(function (r) { setTimeout(r, c.delay); });
                }
                await opts.send(reply);

                this._markDone(target.id, MAX_TRY);
                // 回完把基线推到这条之后，避免下次又扫到它
                this.setBaseline(convKey, target.ts);
            } catch (e) {
                // 失败记一次，下次轮询会重试（最多 MAX_TRY 次）
                this._markDone(target.id, this._tries(target.id) + 1);
                if (global.console) console.warn('[AI自动回复]', e.message || e);
            } finally {
                this._busy = false;
            }
        },

        // ══════════════════════════════════════════════════════
        //  调智谱
        // ══════════════════════════════════════════════════════
        /**
         * 非流式就够了 —— 自动回复不需要逐字吐出来，
         * 少一层 SSE 解析就少一类 bug。
         */
        async ask(text, cfg) {
            cfg = cfg || this.cfg();
            var base = String(cfg.base || DEF.base).replace(/\/+$/, '');
            var url = base + '/chat/completions';

            var body = {
                model: cfg.model || DEF.model,
                messages: [
                    { role: 'system', content: cfg.sys || DEF.sys },
                    { role: 'user', content: String(text).slice(0, 2000) }
                ],
                stream: false,
                temperature: 0.7
            };

            var r;
            try {
                // ★ 走 global.fetch 而不是裸 fetch：
                //   裸 fetch 在非浏览器环境里解析不到 window 上的 mock，
                //   测试就没法拦住它（会真的发出网络请求）
                r = await global.fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + cfg.key
                    },
                    body: JSON.stringify(body)
                });
            } catch (e) {
                // ★ fetch 抛错分不清是断网还是跨域，别乱下结论
                throw new Error('请求发不出去（网络或跨域）：' + (e.message || ''));
            }

            var txt = await r.text();
            var d = null;
            try { d = JSON.parse(txt); } catch (e) { d = null; }

            if (!r.ok) {
                var msg = (d && d.error && d.error.message) || txt.slice(0, 120);
                if (r.status === 401) throw new Error('API Key 无效：' + msg);
                if (r.status === 429) throw new Error('被限流了：' + msg);
                throw new Error('HTTP ' + r.status + ' ' + msg);
            }

            var out = d && d.choices && d.choices[0] &&
                d.choices[0].message && d.choices[0].message.content;
            if (!out) throw new Error('模型没返回内容');

            out = String(out).trim();
            var max = cfg.maxLen || DEF.maxLen;
            if (out.length > max) out = out.slice(0, max) + '…';
            return out;
        },

        /** 测试连接，跟小程序里那个一个思路 */
        async test(cfg) {
            cfg = Object.assign({}, this.cfg(), cfg || {});
            if (!cfg.key) return { ok: false, text: '还没填 API Key' };
            var t0 = Date.now();
            try {
                var out = await this.ask('只回复两个字：收到', cfg);
                return {
                    ok: true,
                    text: '✓ 通了（' + (Date.now() - t0) + 'ms）\n模型：' +
                        (cfg.model || DEF.model) + '\n回复：' + out.slice(0, 60)
                };
            } catch (e) {
                return { ok: false, text: '✗ ' + e.message };
            }
        }
    };

    global.AIReply = AIReply;
})(window);
