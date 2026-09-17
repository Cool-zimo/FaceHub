/**
 * 附件模块
 *
 * 设计要点：
 *
 * ① 存哪 —— 会话自己的私有仓库 files/ 目录。
 *    会话本来就是私仓，附件放里面天然继承权限，不用另开仓库。
 *
 * ② 消息里怎么带 —— 一个信封 JSON：
 *      FHATT1:{"n":"猫.jpg","t":"image/jpeg","s":12345,"p":"files/xxx.jpg"}
 *    外面照常加密，所以 GitHub 上连文件名都看不到。
 *
 * ③ 路径为什么不用原始文件名 —— 中文/空格/emoji 在 API 路径里
 *    容易出编码问题。路径用 ASCII 安全名，真实名字放信封的 n 字段。
 *
 * ④ 图片为什么必须压缩 —— 原图动辄几 MB，base64 后更大，
 *    写 GitHub 很慢且吃限流。压到 1600px / JPEG 0.85 通常能到 1/10。
 */
(function (global) {

var Attach = {

    // 图片压缩阈值：小于这个就不折腾了，直接传
    COMPRESS_OVER: 200 * 1024,
    MAX_EDGE: 1600,
    JPEG_QUALITY: 0.85,

    /**
     * 单片大小 2MB
     *
     * 实测 contents API 的可用上限（不是官方说的 100MB）：
     *   1MB ✓ 7.8s   10MB ✓ 9.3s   15MB ✓ 11.3s   25MB ✓ 12.8s
     *   40MB ✗ 422 "file is too large to be processed"
     * 所以单次 PUT 的安全线在 30MB 左右。
     *
     * 但分片的价值不只是"突破上限"：
     *   10MB 一次请求要 9.3 秒，中途网络抖一下全废；
     *   切成 2MB 五片，每片约 2 秒，失败只重传那一片。
     * 单片太大 = 重试代价太高，所以取 2MB（base64 后 2.7MB，很稳）。
     */
    CHUNK: 2 * 1024 * 1024,

    /** 超过这个大小才分片（小文件不值得多花几个 commit） */
    SPLIT_AT: 4 * 1024 * 1024,

    /** 并发路数。内容创建限流 80/分钟，开太大会 403 */
    CONCURRENCY: 3,

    /**
     * 总大小上限 200MB
     *
     * 不是技术限制，是耐心限制：2MB 一片要 100 片，
     * 按每片 2 秒、3 路并发算也要一分多钟。
     */
    MAX_SIZE: 200 * 1024 * 1024,

    // ── 选择 ─────────────────────────────────────────────
    pick(multiple) {
        var self = this;
        return new Promise(function (resolve) {
            var inp = document.createElement('input');
            inp.type = 'file';
            if (multiple) inp.multiple = true;
            inp.style.display = 'none';
            inp.onchange = function () {
                var list = inp.files ? Array.prototype.slice.call(inp.files) : [];
                document.body.removeChild(inp);
                resolve(list);
            };
            // 取消选择时 onchange 不触发，靠页面重新聚焦兜底
            document.body.appendChild(inp);
            inp.click();
        });
    },

    /** 超过上限的文件单独挑出来，别让一个超标文件卡住整批 */
    partition(files) {
        var ok = [], tooBig = [];
        files.forEach(function (f) {
            (f.size > Attach.MAX_SIZE ? tooBig : ok).push(f);
        });
        return { ok: ok, tooBig: tooBig };
    },

    // ── 图片压缩 ─────────────────────────────────────────
    /**
     * 压缩图片
     * PNG 带透明通道的保持 PNG（转 JPEG 会变黑底），其余转 JPEG。
     * 压缩失败一律回退原文件 —— 宁可慢，也不能传坏图。
     */
    async compressImage(file) {
        if (!/^image\//.test(file.type)) return file;
        if (file.size <= this.COMPRESS_OVER) return file;
        if (file.type === 'image/gif') return file;   // GIF 可能是动图，别压

        try {
            var dataUrl = await this._readAsDataURL(file);
            var img = await this._loadImage(dataUrl);
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) return file;

            var scale = Math.min(1, this.MAX_EDGE / Math.max(w, h));
            var nw = Math.round(w * scale), nh = Math.round(h * scale);
            if (nw === w && nh === h && file.size <= this.COMPRESS_OVER * 3) return file;

            var cv = document.createElement('canvas');
            cv.width = nw; cv.height = nh;
            var ctx = cv.getContext('2d');
            // 透明 PNG 填白底再转 JPEG，否则透明区变黑
            var keepAlpha = file.type === 'image/png';
            if (!keepAlpha) {
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, nw, nh);
            }
            ctx.drawImage(img, 0, 0, nw, nh);

            var outType = keepAlpha ? 'image/png' : 'image/jpeg';
            var blob = await new Promise(function (res) {
                cv.toBlob(function (b) { res(b); }, outType,
                    keepAlpha ? undefined : this.JPEG_QUALITY);
            }.bind(this));
            if (!blob || blob.size >= file.size) return file;   // 压了反而更大

            var out = new File([blob], file.name, { type: outType });
            out.__compressed = true;
            out.__origSize = file.size;
            return out;
        } catch (e) {
            return file;
        }
    },

    _readAsDataURL(file) {
        return new Promise(function (res, rej) {
            var r = new FileReader();
            r.onload = function () { res(r.result); };
            r.onerror = function () { rej(new Error('读取失败')); };
            r.readAsDataURL(file);
        });
    },

    _loadImage(src) {
        return new Promise(function (res, rej) {
            var i = new Image();
            i.onload = function () { res(i); };
            i.onerror = function () { rej(new Error('解码失败')); };
            i.src = src;
        });
    },

    // ── 上传 ─────────────────────────────────────────────
    /** 生成 API 安全的存储路径（不含原始名，避免编码问题） */
    _path(file) {
        var ext = (file.name || '').split('.').pop() || 'bin';
        ext = ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'bin';
        var d = new Date();
        var ts = d.getFullYear() +
            String(d.getMonth() + 1).padStart(2, '0') +
            String(d.getDate()).padStart(2, '0') + '-' +
            String(d.getHours()).padStart(2, '0') +
            String(d.getMinutes()).padStart(2, '0') +
            String(d.getSeconds()).padStart(2, '0');
        var rnd = Math.random().toString(36).slice(2, 8);
        return 'files/' + ts + '-' + rnd + '.' + ext;
    },

    /**
     * 上传到会话仓库
     * @returns {Promise<{name,type,size,path,dataUrl}>}
     *          dataUrl 用于本地立即预览（乐观上屏，不用等回读）
     */
    async upload(owner, repo, file, onProgress) {
        var self = this;
        var ready = await this.compressImage(file);

        if (onProgress) onProgress('uploading', 0);

        // 大文件走分片，小文件单片直传
        if (ready.size > this.SPLIT_AT) {
            return await this._uploadChunked(owner, repo, ready, file, onProgress);
        }

        var dataUrl = await this._readAsDataURL(ready);
        var b64 = dataUrl.split(',')[1] || '';

        var path = this._path(ready);
        try {
            await global.API.writeFile(owner, repo, path, b64,
                '附件：' + (file.name || 'file'), null, 'main', true);
        } catch (e) {
            throw new Error('上传失败：' + (e.message || e));
        }
        if (onProgress) onProgress('done', 1);

        return {
            name: file.name || '附件',
            type: ready.type || file.type || 'application/octet-stream',
            size: ready.size,
            path: path,
            chunks: 1,
            dataUrl: dataUrl,
            compressed: !!ready.__compressed,
            origSize: ready.__origSize || ready.size
        };
    },

    // ── 分片上传 ─────────────────────────────────────────

    /**
     * 分片上传
     *
     * 借鉴 github_drive 的做法：切成固定大小的片，每片独立 PUT。
     * 但有两点不同：
     *   1. drive 把分片信息存 chunks[] 数组，FaceHub 只存「目录 + 片数」
     *      —— 信封要塞进 issue 评论（上限 65536 字符），
     *      100 个分片的路径数组会撑爆它。路径可推导，不存。
     *   2. drive 对 >1MB 的片走 Git Blob API（三步），这里统一 base64
     *      —— 既然都切到 2MB 了，一步到位的 contents API 更不容易出错。
     */
    async _uploadChunked(owner, repo, ready, file, onProgress) {
        var self = this;
        var total = ready.size;
        var totalChunks = Math.ceil(total / this.CHUNK);

        // 片存在「目录/」下，片文件名就是序号
        var dir = this._path(ready) + '/';
        var uploaded = [];

        if (onProgress) onProgress('uploading', 0, totalChunks);

        var done = 0;
        var failed = null;

        // 读一次全量 buffer，之后按偏移切片（避免反复读文件）
        var buf = await ready.arrayBuffer();
        var all = new Uint8Array(buf);

        /**
         * 串行上传 —— 这里不能并发。
         *
         * ★ 踩过的坑：一开始写成了并发池，结果第 3 片直接失败：
         *     "is at 486a… but expected 2f23…"
         *   因为 contents API 每次提交都基于当前 HEAD，并发时
         *   前一片刚把 HEAD 改了，后一片的 parent 就对不上了。
         *   Git 的提交模型决定了同一个仓库只能串行写。
         *
         *   （github_drive 的分片也是串行的 for 循环，我改并发是改错了方向。）
         *
         * 单次失败会重试一次：偶发的 HEAD 冲突、网络抖动能自愈。
         */
        for (var i = 0; i < totalChunks; i++) {
            var start = i * self.CHUNK;
            var end = Math.min(start + self.CHUNK, total);
            var piece = all.subarray(start, end);
            var b64 = self._u8ToB64(piece);
            var piecePath = dir + i;

            var lastErr = null;
            for (var attempt = 0; attempt < 2; attempt++) {
                try {
                    await global.API.writeFile(owner, repo, piecePath, b64,
                        '附件分片 ' + (i + 1) + '/' + totalChunks + '：' + (file.name || 'file'),
                        null, 'main', true);
                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                    // 重试前稍等，给 GitHub 一点收敛时间
                    await new Promise(function (r) { setTimeout(r, 600); });
                }
            }

            if (lastErr) {
                await this._cleanupChunks(owner, repo, uploaded);
                throw new Error('上传失败（第 ' + (i + 1) + '/' + totalChunks +
                    ' 片）：' + (lastErr.message || lastErr));
            }

            uploaded.push(piecePath);
            done++;
            if (onProgress) onProgress('uploading', done / totalChunks, totalChunks);
        }

        if (onProgress) onProgress('done', 1, totalChunks);

        return {
            name: file.name || '附件',
            type: ready.type || file.type || 'application/octet-stream',
            size: total,
            path: dir,              // 多片时 path 是目录，片 = dir + 序号
            chunks: totalChunks,
            compressed: !!ready.__compressed,
            origSize: ready.__origSize || total
        };
    },

    /** 清理上传失败的分片（best effort，单个失败不影响其他） */
    async _cleanupChunks(owner, repo, paths) {
        for (var i = 0; i < paths.length; i++) {
            try {
                var sha = await global.API.sha(owner, repo, paths[i], 'main');
                if (!sha) continue;
                await global.API.req(
                    '/repos/' + owner + '/' + repo + '/contents/' + paths[i],
                    { method: 'DELETE', body: { message: '清理失败的分片', sha: sha, branch: 'main' } });
            } catch (e) { /* 忽略 */ }
        }
    },

    /** Uint8Array → base64（分块处理，避免 apply 参数上限爆栈） */
    _u8ToB64(u8) {
        var CH = 8192;
        var bin = '';
        for (var i = 0; i < u8.length; i += CH) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        }
        return global.btoa(bin);
    },

    /** base64 → Uint8Array */
    _b64ToU8(b64) {
        var bin = global.atob(b64);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    },

    /**
     * 读取附件字节（自动处理单片 / 多片）
     * 多片按序拼接 —— 序号就是顺序，不能乱序并发后直接拼
     */
    async readBytes(att, ctx) {
        var owner = ctx.owner, repo = ctx.repo;
        var n = att.c || 1;

        // 单片：优先 contents API（能拿 ETag，二次免费）；
        // 返回空说明文件 >1MB（contents 不给 content），退 Git Blob API
        if (n <= 1) {
            var one = await global.API.readFile(owner, repo, att.p, 'main', false, true);
            if (one) return this._b64ToU8(one);
            var big = await global.API.readLargeFileB64(owner, repo, att.p, 'main');
            return this._b64ToU8(big);
        }

        var self = this;
        var parts = new Array(n);

        /**
         * 并发拉取但按序号归位 —— 拼的时候才不会错乱。
         * （上传必须串行，因为写同一个 Git 仓库会撞 HEAD；
         *   读取没有这个限制，可以并发。）
         */
        var cursor = 0;
        async function worker() {
            while (true) {
                var i = cursor++;
                if (i >= n) return;
                // 分片固定 2MB，contents API 读不了，走 Git Blob API
                var b = await global.API.readLargeFileB64(owner, repo, att.p + i, 'main');
                parts[i] = self._b64ToU8(b);
            }
        }
        var ws = [];
        var wn = Math.min(this.CONCURRENCY, n);
        for (var w = 0; w < wn; w++) ws.push(worker());
        await Promise.all(ws);

        var len = 0;
        for (var i = 0; i < n; i++) len += parts[i].length;
        var out = new Uint8Array(len);
        var off = 0;
        for (var j = 0; j < n; j++) { out.set(parts[j], off); off += parts[j].length; }
        return out;
    },

    // ── 信封 ─────────────────────────────────────────────
    PREFIX: 'FHATT1:',

    /**
     * 编码成信封
     *
     * c = 分片数。不存 chunks[] 数组 —— 信封要塞进 issue 评论
     * （上限 65536 字符），几十上百个路径会撑爆它。
     * 路径可推导（p + 序号），所以只存数量。
     */
    encode(att) {
        var o = { n: att.name, t: att.type, s: att.size, p: att.path };
        if (att.chunks && att.chunks > 1) o.c = att.chunks;
        return this.PREFIX + JSON.stringify(o);
    },

    /** 解析附件消息；不是附件返回 null */
    parse(text) {
        if (!text) return null;
        // trim：GitHub 返回的内容前后可能带空白/换行，
        // 不 trim 会导致 indexOf !== 0 而漏判 → 界面露出裸协议串
        var t = String(text).trim();
        if (t.indexOf(this.PREFIX) !== 0) return null;
        try {
            var d = JSON.parse(t.slice(this.PREFIX.length));
            if (!d || !d.p) return null;
            return d;
        } catch (e) {
            return null;
        }
    },

    /**
     * 看起来像附件串吗？（哪怕解析失败）
     *
     * 作用：兜底防护。解析失败时也不要把 FHATT1:{...} 这种内部
     * 协议串直接甩给用户 —— 那是"漏源码"，看着像坏了。
     */
    looksLikeAttachment(text) {
        if (!text) return false;
        return String(text).trim().indexOf(this.PREFIX) === 0;
    },

    kind(att) {
        var t = (att.t || att.type || '').toLowerCase();
        if (t.indexOf('image/') === 0) return 'image';
        if (t.indexOf('video/') === 0) return 'video';
        if (t.indexOf('audio/') === 0) return 'audio';
        return 'file';
    },

    /**
     * 文件图标
     *
     * 有 Icons 就用 SVG（单色，跟界面一致），没有就退回 emoji。
     * 返回值直接进 innerHTML，所以只可能是这两种来源，不含用户输入。
     */
    icon(att) {
        if (global.Icons && Icons.forType) {
            return Icons.forType(this.kind(att), att.n || att.name, 18);
        }
        var k = this.kind(att);
        if (k === 'image') return '🖼️';
        if (k === 'video') return '🎬';
        if (k === 'audio') return '🎵';
        return '📎';
    },

    size: function (b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1048576).toFixed(1) + ' MB';
    },

    // ── 读取附件内容 ─────────────────────────────────────
    /**
     * 取可显示地址（懒加载用，带内存缓存避免重复请求）
     *
     * @param {object|string} att 附件信封；传字符串则视为单片（兼容老调用）
     *
     * 单片 → data: URL（小文件，省事）
     * 多片 → 组装成 Blob 再 createObjectURL。
     *   多片时必须组装，不能用 raw CDN 直链 —— 那是多个文件，
     *   不是一个。而且大文件用 Blob URL 比 base64 字符串省内存。
     */
    async dataUrl(owner, repo, att) {
        if (typeof att === 'string') att = { p: att, c: 1 };

        var n = att.c || 1;
        var ck = 'fh:att:' + owner + '/' + repo + '/' + att.p + '#' + n;
        if (this._mem && this._mem[ck]) return this._mem[ck];

        var url;
        if (n > 1) {
            var u8 = await this.readBytes(att, { owner: owner, repo: repo });
            var blob = new global.Blob([u8], {
                type: att.t || 'application/octet-stream'
            });
            url = global.URL.createObjectURL(blob);
        } else {
            var b64 = await global.API.readFile(owner, repo, att.p, 'main', false, true);
            if (!b64) throw new Error('附件内容为空');
            // 已经带 data: 前缀就直接用
            url = (b64.indexOf('data:') === 0)
                ? b64
                : 'data:' + (att.t || 'application/octet-stream') + ';base64,' + b64;
        }

        if (!this._mem) this._mem = {};
        this._mem[ck] = url;
        return url;
    },

    // ── 转存到 GitHub Drive ──────────────────────────────
    /**
     * 转存到 Drive
     *
     * Drive 用 drive-storage-* 仓库存文件，所以直接写进去就行，
     * 不依赖 Drive 那边的接收逻辑 —— 写完跳过去就能看到。
     *
     * 找不到 storage 仓库就返回 null，由上层提示用户先去 Drive 建一个。
     */
    async saveToDrive(att) {
        var me = global.Store && global.Store.me ? global.Store.me.login : null;
        if (!me) throw new Error('未登录');

        var repo = await this.findDriveRepo(me);
        if (!repo) return { ok: false, reason: 'no-drive' };

        // ★ 信封格式里路径字段是 p，不是 path。
        // 写死 att.path 会让"收到的附件"转存时拿到 undefined → 404。
        var rel = att.p || att.path;
        if (!rel) throw new Error('附件缺少路径信息');

        var b64 = null;
        if (att.dataUrl) {
            b64 = att.dataUrl.split(',')[1] || null;
        }
        if (!b64) {
            // 多片要先组装。Drive 自己也会分片，但那是它内部的事，
            // 我们这边只需要把完整内容交给它。
            var n = att.c || 1;
            if (n > 1) {
                var u8 = await this.readBytes(att, { owner: att.owner, repo: att.repo });
                b64 = this._u8ToB64(u8);
            } else {
                b64 = await global.API.readFile(att.owner, att.repo, rel, 'main', false, true);
            }
        }
        if (!b64) throw new Error('附件内容为空');

        // 加时间戳前缀，避免同名覆盖（同一个文件转存两次不该丢）
        var safe = this._stampName(this._safeName(att.n || att.name || 'file'));

        await global.API.writeFile(me, repo, safe, b64,
            '从 FaceHub 转存：' + (att.n || safe), null, 'main', true);

        return { ok: true, repo: repo, path: safe };
    },

    /** 给文件名加日期前缀，避免同名覆盖 */
    _stampName(name) {
        var d = new Date();
        var p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
            '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
            '-' + name;
    },

    _safeName(name) {
        return String(name || 'file')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/^\.+/, '')
            .slice(0, 80) || 'file';
    },

    /** 找用户的 drive-storage 仓库 */
    async findDriveRepo(login) {
        var r = await global.API.req('/user/repos?per_page=100&sort=updated&affiliation=owner');
        var list = (r.data || []).filter(function (x) {
            return /^drive-storage-/.test(x.name) && x.owner.login === login;
        });
        if (!list.length) return null;
        return list[0].name;
    },

    // ── 渲染 ─────────────────────────────────────────────
    /**
     * 渲染附件气泡
     *
     * 图片：自动加载（压缩后通常不大）
     * 视频/音频：显示卡片，点击才加载 —— 避免打开会话就下一堆媒体
     * 其他：文件卡片，点击可下载
     */
    render(box, att, ctx) {
        var self = this;
        var kind = this.kind(att);
        var el = document.createElement('div');
        el.className = 'att att-' + kind;

        // 每个附件气泡都挂一条操作栏：转存 / 下载
        // 之前只有点开全屏预览才有转存按钮，收到附件想存还得先点开，
        // 多两步；现在直接点就行。
        var actions = null;

        // 刚发的本地消息有 dataUrl，直接用，不用等回读
        if (kind === 'image') {
            // GIF 不压缩（见 compressImage），所以直接 <img> 就会动，
            // 不需要任何额外处理 —— 千万别走 canvas，一动图就变静止。
            var isGif = /gif/i.test(att.t || '') || /\.gif$/i.test(att.n || '');

            var wrap = document.createElement('div');
            wrap.className = 'att-img-wrap';

            var img = document.createElement('img');
            img.className = 'att-img';
            img.alt = att.n || '';
            if (att.dataUrl) {
                img.src = att.dataUrl;
            } else {
                // 先占位骨架，图片到位后淡入 —— 避免布局跳动
                img.classList.add('skeleton');
                var self0 = this;
                img.onload = function () { img.classList.remove('skeleton'); };
                this._lazyLoad(img, att, ctx);
            }
            wrap.appendChild(img);
            wrap.onclick = function () { self.preview(att, ctx); };

            if (isGif) {
                var gb = document.createElement('span');
                gb.className = 'att-gif-badge';
                gb.textContent = 'GIF';
                wrap.appendChild(gb);
            }
            el.appendChild(wrap);
            actions = self._actionBar(att, ctx);
            el.appendChild(actions);
            box.appendChild(el);
            return el;
        }
            img.onclick = function () { self.preview(att, ctx); };

        if (kind === 'video' || kind === 'audio') {
            var cover = document.createElement('div');
            cover.className = 'att-media';
            var playIco = (global.Icons)
                ? (kind === 'video' ? Icons.play(16) : Icons.music(16))
                : (kind === 'video' ? '▶' : '♪');
            cover.innerHTML = '<span class="att-play">' + playIco + '</span>';
            var info = document.createElement('div');
            info.className = 'att-info';
            info.innerHTML = '<div class="att-name"></div>' +
                '<div class="att-sub"></div>';
            info.querySelector('.att-name').textContent = att.n || '媒体';
            info.querySelector('.att-sub').textContent =
                this.icon(att) + ' ' + this.size(att.s) + ' · 点击' +
                (kind === 'video' ? '播放' : '收听');
            cover.appendChild(info);
            cover.onclick = function () {
                self.playMedia(el, att, ctx, cover);
            };
            el.appendChild(cover);
            actions = self._actionBar(att, ctx);
            el.appendChild(actions);
            box.appendChild(el);
            return el;
        }

        // 普通文件
        var card = document.createElement('div');
        card.className = 'att-file';
        var ic = document.createElement('span');
        ic.className = 'att-icon';
        ic.innerHTML = this.icon(att);
        var nm = document.createElement('span');
        nm.className = 'att-name';
        nm.textContent = att.n || '文件';
        var sz = document.createElement('span');
        sz.className = 'att-sub';
        sz.textContent = this.size(att.s);
        card.appendChild(ic);
        card.appendChild(nm);
        card.appendChild(sz);
        card.onclick = function () { self.download(att, ctx); };
        el.appendChild(card);
        actions = self._actionBar(att, ctx);
        el.appendChild(actions);
        box.appendChild(el);
        return el;
    },

    /**
     * 附件操作栏：转存到 Drive / 下载
     *
     * 转存是异步的且要读一次仓库，所以按钮要显示进度；
     * 完成后变成"已存 ✓"并禁用，避免手抖点两次存出两份。
     */
    _actionBar(att, ctx) {
        var self = this;
        var bar = document.createElement('div');
        bar.className = 'att-actions';

        var save = document.createElement('button');
        save.className = 'att-act';
        save.textContent = '转存到 Drive';
        save.onclick = function (e) {
            e.stopPropagation();
            self.doSave(att, ctx, save, true);
        };
        bar.appendChild(save);

        var dl = document.createElement('button');
        dl.className = 'att-act';
        dl.textContent = '下载';
        dl.onclick = function (e) {
            e.stopPropagation();
            self.download(att, ctx);
        };
        bar.appendChild(dl);

        return bar;
    },

    _lazyLoad(img, att, ctx) {
        var self = this;
        this.dataUrl(ctx.owner, ctx.repo, att).then(function (url) {
            img.src = url;
        }).catch(function () {
            img.alt = '加载失败';
        });
    },

    /** 点击后原地替换成播放器 */
    async playMedia(el, att, ctx, cover) {
        var kind = this.kind(att);
        try {
            cover.querySelector('.att-sub').textContent = '加载中…';
            var url = att.dataUrl || await this.dataUrl(ctx.owner, ctx.repo, att);
            el.innerHTML = '';
            var m = document.createElement(kind === 'video' ? 'video' : 'audio');
            m.className = 'att-player';
            m.src = url;
            m.controls = true;
            if (kind === 'video') {
                m.preload = 'metadata';
                m.style.maxWidth = '100%';
                m.style.maxHeight = '320px';
            }
            el.appendChild(m);
            m.play().catch(function () { /* 自动播放被拦截没关系 */ });
        } catch (e) {
            cover.querySelector('.att-sub').textContent = '加载失败';
        }
    },

    /** 全屏预览（图片放大 / 视频大屏） */
    preview(att, ctx) {
        var self = this;
        var ov = document.createElement('div');
        ov.className = 'att-overlay';
        ov.innerHTML = '<div class="att-ov-box"></div>';
        var box = ov.querySelector('.att-ov-box');

        var close = document.createElement('button');
        close.className = 'att-ov-close';
        close.textContent = '✕';
        close.onclick = function () { document.body.removeChild(ov); };
        box.appendChild(close);

        var load = (att.dataUrl
            ? Promise.resolve(att.dataUrl)
            : this.dataUrl(ctx.owner, ctx.repo, att));

        load.then(function (url) {
            var kind = self.kind(att);
            if (kind === 'image') {
                var i = document.createElement('img');
                i.src = url;
                box.appendChild(i);
            } else if (kind === 'video') {
                var v = document.createElement('video');
                v.src = url; v.controls = true; v.autoplay = true;
                box.appendChild(v);
            } else if (kind === 'audio') {
                var a = document.createElement('audio');
                a.src = url; a.controls = true; a.autoplay = true;
                box.appendChild(a);
            }
            var bar = document.createElement('div');
            bar.className = 'att-ov-bar';
            var nm = document.createElement('span');
            nm.textContent = att.n || '';
            var save = document.createElement('button');
            save.textContent = '转存到 Drive';
            save.onclick = function () { self.doSave(att, ctx, save); };
            var dl = document.createElement('button');
            dl.textContent = '下载';
            dl.onclick = function () { self.download(att, ctx, url); };
            bar.appendChild(nm);
            bar.appendChild(save);
            bar.appendChild(dl);
            box.appendChild(bar);
        }).catch(function () {
            box.innerHTML = '<div class="att-ov-err">加载失败</div>';
        });

        ov.onclick = function (e) {
            if (e.target === ov) document.body.removeChild(ov);
        };
        document.body.appendChild(ov);
    },

    /** 下载到本地 */
    async download(att, ctx, knownUrl) {
        try {
            var url = knownUrl ||
                att.dataUrl ||
                await this.dataUrl(ctx.owner, ctx.repo, att);
            var a = document.createElement('a');
            a.href = url;
            a.download = att.n || 'file';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (e) {
            if (global.App) App.toast('下载失败：' + e.message, true);
        }
    },

    /** 转存按钮的实际动作（供气泡和预览共用） */
    /**
     * 转存按钮的实际动作（气泡和预览共用）
     *
     * @param {boolean} stayHere true = 不跳转。
     *   气泡上转存时聊天不该被打断，只提示；
     *   全屏预览里转存则顺带跳过去看结果。
     */
    async doSave(att, ctx, btn, stayHere) {
        var full = Object.assign({}, att, { owner: ctx.owner, repo: ctx.repo });
        var label = '转存到 Drive';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="act-spinner"></i>转存中…';
        }
        try {
            var r = await this.saveToDrive(full);
            if (!r.ok) {
                if (r.reason === 'no-drive' && global.App) {
                    App.toast('没找到 Drive 存储仓库，请先去 GitHub Drive 创建', true);
                }
                if (btn) { btn.disabled = false; btn.textContent = label; }
                return;
            }
            if (global.App) App.toast('已转存到 Drive：' + r.path);
            if (btn) btn.innerHTML = (global.Icons ? Icons.check(12) : '') + '已存 ✓';

            // 气泡模式：留在聊天里，但给个可点的跳转入口
            if (stayHere) {
                if (btn && global.Bridge && Bridge.go) {
                    btn.textContent = '去 Drive 看看';
                    btn.disabled = false;
                    btn.onclick = function (e) {
                        e.stopPropagation();
                        try { Bridge.go({ from: 'facehub', focus: r.path }); }
                        catch (err) { /* 忽略 */ }
                    };
                }
                return;
            }

            if (global.Bridge && Bridge.go) {
                try { Bridge.go({ from: 'facehub', focus: r.path }); }
                catch (e) { /* 跳转失败不影响已转存 */ }
            }
        } catch (e) {
            if (global.App) App.toast('转存失败：' + (e.message || e), true);
            if (btn) { btn.disabled = false; btn.textContent = label; }
        }
    }
};

    global.Attach = Attach;
})(typeof window !== 'undefined' ? window : this);
