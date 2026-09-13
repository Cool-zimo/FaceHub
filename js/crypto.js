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

            if (!peerPubB64) return null;

            var priv = await this._importOwnPriv(mine.priv);
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
            // salt 必须双方一致 → 用确定性值（房间名）
            var salt = new TextEncoder().encode('facehub:' + room);

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
         * 发布我的公钥到仓库
         * 路径 pk/{login}.json，双方各写各的，不会冲突
         */
        async publishPubKey(owner, repo, login, branch) {
            var kp = await this.ensureKeyPair(login, repo);
            var path = 'pk/' + login + '.json';
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
         * @returns {string|null} 对方还没发布则返回 null
         */
        async readPeerPubKey(owner, repo, peerLogin, branch) {
            var path = 'pk/' + peerLogin + '.json';
            try {
                // fresh=true：公钥是安全关键数据，绝不能读缓存。
                // 否则攻击者换掉公钥后，用户可能因为缓存一直看到旧的，
                // 换设备后才突然拿到假的 —— 检测时机被推迟，风险更高。
                var txt = await API.readFile(owner, repo, path, branch, true);
                var d = JSON.parse(txt);
                return d.pub || null;
            } catch (e) {
                return null;
            }
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
