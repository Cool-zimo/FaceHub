/**
 * FaceHub 端到端加密
 *
 * 目标：GitHub 只能看到密文和公钥，**永远看不到明文和私钥**。
 *
 * ── 密钥交换：ECDH（P-256）────────────────────────────
 * 难点在于两人从没"同时在线"，怎么协商出同一个密钥？
 *
 * 用椭圆曲线 Diffie-Hellman：
 *   1. A 生成密钥对，把**公钥**写进仓库（公钥泄露无所谓）
 *   2. B 接受邀请后，生成自己的密钥对，公钥也写进仓库
 *   3. B 用「自己私钥 + A 公钥」算出共享密钥
 *   4. A 下次打开，看到 B 的公钥，用「自己私钥 + B 公钥」
 *      算出**完全相同**的共享密钥
 *
 * 数学保证两个算式结果一致，而 GitHub 只看到两个公钥 ——
 * 没有私钥就算不出共享密钥。这是真正的 E2E，不是"传输加密"。
 *
 * ── 消息加密：AES-GCM ──────────────────────────────────
 * 共享密钥不能直接当 AES 密钥用（长度和随机性都不合规），
 * 先用 HKDF 派生出 256 位 AES 密钥，再用 AES-GCM 加密。
 *
 * GCM 是 AEAD：附带认证标签，密文被篡改会直接解密失败，
 * 而不是解出一堆乱码。
 *
 * 每条消息用随机 IV（12 字节），所以同一句话发两次，
 * 密文也完全不同 —— 不会泄露"这两条消息内容相同"。
 *
 * ── 私钥存哪 ───────────────────────────────────────────
 * localStorage（IndexedDB 更好，但 localStorage 够用）。
 * 后果：换浏览器/清缓存 → 旧消息解不开。
 * 这是纯前端 E2E 的固有代价，界面上必须说清楚。
 */
(function (global) {
    'use strict';

    var API = global.API;

    var Crypto = {
        /** localStorage 键前缀 */
        _sk: function (login, room) { return 'fh:sk:' + login + '/' + room; },

        // ── 密钥对 ───────────────────────────────────────────

        /**
         * 生成 ECDH 密钥对（如果还没有）
         * 私钥留本地，公钥要写进仓库给对方
         */
        async ensureKeyPair(login, room) {
            var existing = API._ls(this._sk(login, room));
            if (existing) {
                try { return JSON.parse(existing); } catch (e) { /* 坏了重建 */ }
            }

            var pair = await global.crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' },
                true,                      // 私钥可导出（要存 localStorage）
                ['deriveKey', 'deriveBits']
            );

            var privRaw = await global.crypto.subtle.exportKey('pkcs8', pair.privateKey);
            var pubRaw = await global.crypto.subtle.exportKey('raw', pair.publicKey);

            var data = {
                priv: this._b64(privRaw),
                pub: this._b64(pubRaw),
                createdAt: Date.now()
            };
            API._ls(this._sk(login, room), JSON.stringify(data));
            return data;
        },

        // ═══ 长期身份密钥 ═══════════════════════════════════
        //
        // 为什么要这套：原来的密钥是**按会话生成**的，对方必须先
        // 打开应用、把公钥写进那个会话仓库，我才能加密 —— 所以永远
        // "要等双方上线"。
        //
        // 改成：每个人有一把**长期身份密钥**，登录后自动发布到自己
        // 的公开仓库 facehub-{login}/pk.json。任何人想给我发加密消息，
        // 直接去读那个文件就行 —— 我不需要在线。
        //
        // 这就是 Signal 的 prekey / PGP 公钥服务器同一个思路：
        // 公钥放在"谁都能读"的地方。

        /** 身份密钥的本地存储键 */
        _idKey: function (login) {
            return 'fh:id:' + String(login).toLowerCase();
        },

        /**
         * 取（或生成）我的长期身份密钥
         * 与会话无关，所以只按 login 存一份
         */
        async ensureIdentity(login) {
            var k = this._idKey(login);
            var existing = API._ls(k);
            if (existing) {
                try {
                    var d = JSON.parse(existing);
                    if (d && d.priv && d.pub) return d;
                } catch (e) { /* 坏了重建 */ }
            }

            var pair = await global.crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' },
                true,
                ['deriveKey', 'deriveBits']
            );
            var privRaw = await global.crypto.subtle.exportKey('pkcs8', pair.privateKey);
            var pubRaw = await global.crypto.subtle.exportKey('raw', pair.publicKey);

            var data = {
                priv: this._b64(privRaw),
                pub: this._b64(pubRaw),
                createdAt: Date.now()
            };
            API._ls(k, JSON.stringify(data));
            return data;
        },

        /**
         * 发布身份公钥到我的公开仓库
         * 幂等：公钥没变就不重复写，省配额
         */
        async publishIdentity(login) {
            var id = await this.ensureIdentity(login);
            var repo = 'facehub-' + String(login).toLowerCase();
            var path = 'pk.json';

            var content = JSON.stringify({
                login: login,
                pub: id.pub,
                alg: 'ECDH-P256',
                kind: 'identity',
                publishedAt: new Date().toISOString()
            });

            // 读已发布的公钥，判断是否与本机一致
            var published = null;
            try {
                var d = JSON.parse(await API.readFile(login, repo, path, 'main', true));
                published = d && d.pub ? d.pub : null;
            } catch (e) { published = null; }

            if (published === id.pub) {
                return { pub: id.pub, skipped: true };
            }

            // 已存在**不同**的公钥：要么我在新设备登录，要么被别人改过。
            // 不静默覆盖 —— 先告诉上层，由 UI 决定并提示用户。
            var rotated = !!published;

            var sha = null;
            try { sha = await API.sha(login, repo, path, 'main'); } catch (e) { sha = null; }
            await API.writeFile(login, repo, path, content, '发布加密公钥（身份密钥）', sha, 'main');

            return {
                pub: id.pub, skipped: false,
                rotated: rotated,
                previousPub: published
            };
        },

        /**
         * 读某人的身份公钥（从他自己的公开仓库）
         *
         * 这是"不用等对方上线"的关键：只要对方装过一次 FaceHub，
         * 他的公钥就一直挂在 facehub-{login} 上，随时可读。
         *
         * @returns {string|null} 对方从没用过 FaceHub 则返回 null
         */
        async readIdentity(login) {
            var repo = 'facehub-' + String(login).toLowerCase();
            try {
                var txt = await API.readFile(login, repo, 'pk.json', 'main', true);
                var d = JSON.parse(txt);
                return d.pub || null;
            } catch (e) {
                return null;
            }
        },

        /**
         * 用身份密钥派生会话密钥
         *
         * @param {string} saltKey 参与 salt 的确定性字符串。
         *   私聊传仓库名 → 每个会话密钥不同（一个会话被破不影响别的）
         */
        async deriveAesKeyByIdentity(login, peerPubB64, saltKey) {
            var id = await this.ensureIdentity(login);
            return await this.deriveAesKeyWith(login, id.priv, saltKey, peerPubB64);
        },

        /** 把对方的公钥导入成 CryptoKey */
        async _importPeerPub(b64Raw) {
            return await global.crypto.subtle.importKey(
                'raw',
                this._unb64(b64Raw),
                { name: 'ECDH', namedCurve: 'P-256' },
                false,
                []
            );
        },

        async _importOwnPriv(b64Pkcs8) {
            return await global.crypto.subtle.importKey(
                'pkcs8',
                this._unb64(b64Pkcs8),
                { name: 'ECDH', namedCurve: 'P-256' },
                false,
                ['deriveBits']
            );
        },

        // ── 共享密钥 ─────────────────────────────────────────

        /**
         * 派生 AES 密钥
         *
         * 用 HKDF：把 ECDH 算出的原始比特"洗"成合规的 AES-256 密钥。
         * salt 用双方用户名排序拼接 —— 保证两人算出同一个 salt。
         */
        async deriveAesKey(login, room, peerPubB64) {
            var raw = API._ls(this._sk(login, room));
            if (!raw) {
                // 本地没有私钥：换设备、清了缓存，或浏览器隐私模式。
                // 这是 E2E 的固有代价，必须优雅降级 ——
                // 返回 null 让上层标记"无法解密"，而不是让整个页面崩掉。
                return null;
            }
            var mine;
            try { mine = JSON.parse(raw); } catch (e) { return null; }
            if (!mine || !mine.priv) return null;

            return await this.deriveAesKeyWith(login, mine.priv, room, peerPubB64);
        },

        /**
         * 用指定私钥派生 AES 密钥
         *
         * @param {string} privB64 我的私钥（pkcs8 base64）
         * @param {string} saltKey 参与 salt 计算的确定性字符串。
         *   私聊传**仓库名**，保证同一会话两人 salt 一致；
         *   群聊传仓库名，所有人一致。
         */
        async deriveAesKeyWith(login, privB64, saltKey, peerPubB64) {
            if (!privB64 || !peerPubB64) return null;

            var priv = await this._importOwnPriv(privB64);
            var pub = await this._importPeerPub(peerPubB64);

            var bits = await global.crypto.subtle.deriveBits(
                { name: 'ECDH', public: pub },
                priv,
                256
            );

            // HKDF 第一环：extract
            var ikm = await global.crypto.subtle.importKey(
                'raw', bits, 'HKDF', false, ['deriveBits']
            );
            // salt 必须双方一致 → 用确定性值
            var salt = new TextEncoder().encode('facehub:' + saltKey);

            var prk = await global.crypto.subtle.deriveBits(
                { name: 'HKDF', hash: 'SHA-256', salt: salt, info: new TextEncoder().encode('aes') },
                ikm,
                256
            );

            return await global.crypto.subtle.importKey(
                'raw', prk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
            );
        },

        // ── 加解密 ───────────────────────────────────────────

        /**
         * 加密消息
         * @returns {string} 形如 "E2E1.<iv_b64>.<cipher_b64>"
         */
        async encrypt(aesKey, text) {
            // 没有密钥就明确报错，让调用方走明文回退。
            // 不能静默传 null 给 subtle.encrypt —— 那会抛 TypeError，
            // 若不慎被吞掉，用户会以为消息加密了其实没有。
            if (!aesKey) throw new Error('没有可用的加密密钥');

            var iv = global.crypto.getRandomValues(new Uint8Array(12));
            var cipher = await global.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                aesKey,
                new TextEncoder().encode(text)
            );
            return 'E2E1.' + this._b64(iv) + '.' + this._b64(cipher);
        },

        /**
         * 解密消息
         * 非加密内容（老消息/对方没开加密）原样返回，并标记 plain=true
         */
        async decrypt(aesKey, blob) {
            if (typeof blob !== 'string' || blob.indexOf('E2E1.') !== 0) {
                return { text: blob, plain: true };
            }
            if (!aesKey) return { text: '🔒 无法解密（缺少密钥）', locked: true };

            var parts = blob.split('.');
            if (parts.length !== 3) return { text: '🔒 密文格式错误', locked: true };

            try {
                var plain = await global.crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: this._unb64(parts[1]) },
                    aesKey,
                    this._unb64(parts[2])
                );
                return { text: new TextDecoder().decode(plain), plain: false };
            } catch (e) {
                // GCM 认证失败 = 密文被改过，或密钥不对
                return { text: '🔒 解密失败（密钥不匹配或内容已被篡改）', locked: true };
            }
        },

        // ── 公钥交换（存仓库）─────────────────────────────────

        /**
         * 公钥文件路径（统一小写）
         *
         * 为什么要统一：**GitHub contents API 的路径大小写敏感**。
         * 而 room.peer 来自 peerOf()，它是从全小写的仓库名里切出来的，
         * 结果也是小写 —— 但发布时用的是 login 原始大小写（如 Cool-zimo）。
         * 于是写 Cool-zimo.json、读 cool-zimo.json → 永远 404。
         * 表现是"对方明明在线，却一直显示等待密钥交换"。
         */
        _pkPath: function (login) {
            return 'pk/' + String(login).toLowerCase() + '.json';
        },

        /**
         * 发布我的公钥到仓库
         * 路径 pk/{小写login}.json，双方各写各的，不会冲突
         */
        async publishPubKey(owner, repo, login, branch) {
            var kp = await this.ensureKeyPair(login, repo);
            var path = this._pkPath(login);
            var content = JSON.stringify({
                login: login,
                pub: kp.pub,
                alg: 'ECDH-P256',
                createdAt: kp.createdAt
            });

            var sha = null;
            try { sha = await API.sha(owner, repo, path, branch); } catch (e) { sha = null; }
            await API.writeFile(owner, repo, path, content, '发布加密公钥', sha, branch);
            return kp.pub;
        },

        /**
         * 读对方的公钥
         *
         * 大小写不敏感：先按小写路径直读（快），读不到再列目录找。
         * 列目录那步是为了兼容**历史遗留的大写文件** ——
         * 早期版本按原始大小写写入（pk/Feng-zimo.json）。
         * @returns {string|null} 对方还没发布则返回 null
         */
        async readPeerPubKey(owner, repo, peerLogin, branch) {
            var want = String(peerLogin).toLowerCase();
            var path = this._pkPath(peerLogin);

            // ① 直读（绝大多数情况走这里）
            try {
                // fresh=true：公钥是安全关键数据，绝不能读缓存
                var txt = await API.readFile(owner, repo, path, branch, true);
                var d = JSON.parse(txt);
                if (d && d.pub) return d.pub;
            } catch (e) { /* 落到 ② */ }

            // ② 用 git tree 做大小写不敏感匹配（兼容旧文件 + 用户名大小写未知）
            try {
                var t = await API.tree(owner, repo, branch);
                var hit = (t.files || []).filter(function (f) {
                    var p = String(f.path || '');
                    if (p.indexOf('pk/') !== 0) return false;
                    return p.slice(3).toLowerCase() === want + '.json';
                })[0];
                if (!hit) return null;

                var txt2 = await API.readFile(owner, repo, hit.path, branch, true);
                var d2 = JSON.parse(txt2);
                return (d2 && d2.pub) || null;
            } catch (e) {
                return null;
            }
        },

        // ── 群密钥 ───────────────────────────────────────────

        /**
         * 生成群密钥
         *
         * 私聊靠 ECDH 双方各自算出同一个密钥，但群里有 N 个人，
         * N 方 ECDH 不现实。所以用一个随机的**群密钥**加密消息，
         * 再把这个群密钥分别加密给每个成员。
         *
         * 分发方式：
         *   · 创建者生成 GK
         *   · 对每个成员：用 ECDH(创建者私钥, 成员公钥) 派生密钥加密 GK
         *   · 存到 gk/{成员小写}.json
         *   · 成员用 ECDH(自己私钥, 创建者公钥) 解出 GK
         *
         * 这样 GitHub 上只有加密过的 GK，没有明文。
         */
        async generateGroupKey() {
            var raw = global.crypto.getRandomValues(new Uint8Array(32));
            return this._b64(raw);
        },

        /**
         * 把群密钥加密给某个成员
         *
         * 用身份密钥 → 建群那一刻就能分发，不用等成员上线。
         */
        async wrapGroupKey(gkB64, myLogin, repo, memberPub) {
            var aes = await this.deriveAesKeyByIdentity(myLogin, memberPub, repo);
            if (!aes) return null;
            return await this.encrypt(aes, gkB64);
        },

        /**
         * 解出群密钥
         *
         * 必须用**分发者**的公钥，不能写死创建者 ——
         * 补发群密钥的可能不是创建者（比如创建者不在线，另一个
         * 老成员给新人分发）。所以分发时要把分发者公钥一起存下来。
         */
        async unwrapGroupKey(wrapped, myLogin, repo, wrapperPub) {
            var aes = await this.deriveAesKeyByIdentity(myLogin, wrapperPub, repo);
            if (!aes) return null;
            var r = await this.decrypt(aes, wrapped);
            return r.locked ? null : r.text;
        },

        /** 把 b64 群密钥导入成 AES CryptoKey */
        async importGroupKey(gkB64) {
            return await global.crypto.subtle.importKey(
                'raw', this._unb64(gkB64), { name: 'AES-GCM' }, false,
                ['encrypt', 'decrypt']
            );
        },

        /** 群密钥文件路径 */
        _gkPath: function (login) {
            return 'gk/' + String(login).toLowerCase() + '.json';
        },

        /**
         * 公钥指纹（短哈希，仅用于诊断）
         *
         * 为什么需要：密钥不同步时，双方各自算出的共享密钥不同，
         * 表现为"能加密但解密全失败"，而且**没有任何报错**。
         * 打印指纹后，两边一比对就知道是不是同一对公钥。
         */
        async fingerprint(pubB64) {
            if (!pubB64) return null;
            var d = await global.crypto.subtle.digest(
                'SHA-256', new TextEncoder().encode(pubB64)
            );
            return Array.prototype.reduce.call(
                new Uint8Array(d).slice(0, 3),
                function (s, b) { return s + b.toString(16).padStart(2, '0'); }, ''
            );
        },

        // ── 密钥备份 ─────────────────────────────────────────

        /**
         * 导出全部私钥备份
         *
         * 为什么必须做：私钥只存在 localStorage，换浏览器/清缓存就没了，
         * 历史消息会全部变成「无法解密」。这是纯前端 E2E 最现实的代价。
         *
         * 备份内容**不加密**（用一段口令加密会引入"忘了口令更惨"的新问题），
         * 所以界面上必须明说：这是一份明文私钥，谁拿到谁就能解密。
         */
        exportBackup() {
            var out = {
                v: 2,                       // v2：加入身份密钥
                type: 'facehub-keys',
                rooms: {},                  // 会话密钥（旧式）
                identities: {}              // 身份密钥（新式，更重要）
            };

            // 身份密钥 —— 丢了它所有会话都解不开，必须备份
            var idPrefix = 'fh:id:';
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (!k || k.indexOf(idPrefix) !== 0) continue;
                try {
                    var d = JSON.parse(localStorage.getItem(k));
                    if (d && d.priv) out.identities[k.slice(idPrefix.length)] = d;
                } catch (e) { /* 跳过坏数据 */ }
            }

            // 会话密钥（兼容旧数据）
            var prefix = 'fh:sk:';
            for (var j = 0; j < localStorage.length; j++) {
                var k2 = localStorage.key(j);
                if (!k2 || k2.indexOf(prefix) !== 0) continue;
                try {
                    var d2 = JSON.parse(localStorage.getItem(k2));
                    if (d2 && d2.priv) out.rooms[k2.slice(prefix.length)] = d2;
                } catch (e) { /* 跳过坏数据 */ }
            }

            out.exportedAt = new Date().toISOString();
            return JSON.stringify(out, null, 2);
        },

        /**
         * 导入备份
         * @param {string} json
         * @param {boolean} overwrite - 本地已有同名密钥时是否覆盖
         * @returns {{imported:number, skipped:number, error:string|null}}
         */
        importBackup(json, overwrite) {
            var data;
            try { data = JSON.parse(json); } catch (e) {
                return { imported: 0, skipped: 0, error: '不是有效的 JSON' };
            }
            if (!data || data.type !== 'facehub-keys') {
                return { imported: 0, skipped: 0, error: '不是 FaceHub 密钥备份' };
            }
            // v1 只有 rooms；v2 起有 identities。两者都要能导入。
            if (!data.rooms && !data.identities) {
                return { imported: 0, skipped: 0, error: '备份里没有任何密钥' };
            }

            var imported = 0, skipped = 0, ids = 0;

            var self = this;
            function load(map, prefix, isIdentity) {
                if (!map) return;
                for (var key in map) {
                    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
                    var d = map[key];
                    if (!d || !d.priv || !d.pub) { skipped++; continue; }

                    var lsKey = prefix + key;
                    var exists = !!localStorage.getItem(lsKey);
                    if (exists && !overwrite) { skipped++; continue; }

                    localStorage.setItem(lsKey, JSON.stringify(d));
                    imported++;
                    if (isIdentity) ids++;
                }
            }

            load(data.identities, 'fh:id:', true);
            load(data.rooms, 'fh:sk:', false);

            return {
                imported: imported, skipped: skipped,
                identities: ids, error: null
            };
        },

        /** 列出本地已有密钥（供界面展示备份了哪些） */
        listBackedUpRooms() {
            var out = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (!k) continue;
                if (k.indexOf('fh:id:') === 0) out.push('身份:' + k.slice(6));
                else if (k.indexOf('fh:sk:') === 0) out.push(k.slice(6));
            }
            return out;
        },

        // ── 安全码（防 MITM）──────────────────────────────────

        /**
         * 计算安全码（Safety Number）
         *
         * 为什么必须有这个：
         *   公钥存在共享仓库里，能写仓库的人（GitHub 官方、仓库主、
         *   任何 collaborator）都能偷偷替换它 —— 这就是 MITM。
         *   实测已验证：替换公钥后攻击者可解密双方全部消息。
         *
         *   防御手段只有一个：让双方能**线下核对**公钥是否被换过。
         *   把两个公钥一起哈希成一段短码，双方算出的应当**完全一致**。
         *   不一致 = 有人在中间。
         *
         * 关键点：两个公钥必须**排序后**再拼接，
         * 否则 A 算（我,你）和 B 算（你,我）会得到不同结果。
         *
         * @returns {string} 形如 "A3F9 2C81 7B04 5E6D"
         */
        async safetyNumber(room, myPub, peerPub) {
            // room 也必须校验：否则不同房间可能算出同一个安全码，
            // 攻击者就能拿 A 会话的码骗过 B 会话的核对。
            if (!room || !myPub || !peerPub) return null;

            // 排序保证双方算出同一个值
            var sorted = [myPub, peerPub].sort().join('|');
            var input = 'facehub-safety:' + room + ':' + sorted;

            var digest = await global.crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(input)
            );

            var bytes = new Uint8Array(digest).slice(0, 8);
            var hex = '';
            for (var i = 0; i < bytes.length; i++) {
                hex += bytes[i].toString(16).padStart(2, '0');
            }
            // 每 4 位一组，便于口头核对
            return hex.toUpperCase().match(/.{1,4}/g).join(' ');
        },

        /**
         * 公钥是否被换过
         *
         * 已验证过的会话，如果对方公钥变了 —— 要么是对方换了设备，
         * 要么是被 MITM 了。两者都必须明确警告，不能静默接受。
         */
        checkPubKeyChange(login, room, currentPeerPub) {
            var key = 'fh:verified:' + login + '/' + room;
            var raw = API._ls(key);
            if (!raw) return { verified: false, changed: false };

            var saved;
            try { saved = JSON.parse(raw); } catch (e) { return { verified: false, changed: false }; }

            var changed = saved.pub && currentPeerPub && saved.pub !== currentPeerPub;
            return {
                verified: true,
                changed: changed,
                savedAt: saved.at,
                previousPub: saved.pub
            };
        },

        /** 标记为已核对（线下比对过安全码后调用） */
        markVerified(login, room, peerPub) {
            API._ls('fh:verified:' + login + '/' + room,
                JSON.stringify({ pub: peerPub, at: Date.now() }));
        },

        clearVerified(login, room) {
            API._ls('fh:verified:' + login + '/' + room, null);
        },

        // ── Base64 工具 ───────────────────────────────────────

        _b64(buf) {
            var bytes = new Uint8Array(buf);
            var s = '';
            for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return btoa(s);
        },

        _unb64(str) {
            var bin = atob(str);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes;
        }
    };

    global.E2E = Crypto;
})(window);
