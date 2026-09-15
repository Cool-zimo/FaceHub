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

    // 单文件上限。GitHub 理论 100MB，但 base64 上传体验和限流都撑不住。
    MAX_SIZE: 10 * 1024 * 1024,
    // 图片压缩阈值：小于这个就不折腾了，直接传
    COMPRESS_OVER: 200 * 1024,
    MAX_EDGE: 1600,
    JPEG_QUALITY: 0.85,

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
            dataUrl: dataUrl,
            compressed: !!ready.__compressed,
            origSize: ready.__origSize || ready.size
        };
    },

    // ── 信封 ─────────────────────────────────────────────
    PREFIX: 'FHATT1:',

    encode(att) {
        return this.PREFIX + JSON.stringify({
            n: att.name,
            t: att.type,
            s: att.size,
            p: att.path
        });
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

    icon(att) {
        var k = this.kind(att);
        if (k === 'image') return '🖼️';
        if (k === 'video') return '🎬';
        if (k === 'audio') return '🎵';
        var n = (att.n || '').toLowerCase();
        if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return '🗜️';
        if (/\.(pdf)$/.test(n)) return '📕';
        if (/\.(doc|docx)$/.test(n)) return '📘';
        if (/\.(xls|xlsx|csv)$/.test(n)) return '📗';
        if (/\.(txt|md|json|log)$/.test(n)) return '📄';
        return '📎';
    },

    size: function (b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1048576).toFixed(1) + ' MB';
    },

    // ── 读取附件内容 ─────────────────────────────────────
    /** 从仓库读回 base64（懒加载用，带内存缓存避免重复请求） */
    async dataUrl(owner, repo, path) {
        var ck = 'fh:att:' + owner + '/' + repo + '/' + path;
        var hit = this._mem && this._mem[ck];
        if (hit) return hit;

        var b64 = await global.API.readFile(owner, repo, path, 'main', false, true);
        // 已经带 data: 前缀就直接用
        var url = (b64.indexOf('data:') === 0)
            ? b64
            : 'data:application/octet-stream;base64,' + b64;
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

        var b64 = (att.dataUrl && att.dataUrl.split(',')[1]) ||
            await global.API.readFile(att.owner, att.repo, att.path, 'main', false, true);

        // 保留日期前缀，避免同名覆盖
        var safe = this._safeName(att.n || att.name || 'file');
        var path = safe;

        await global.API.writeFile(me, repo, path, b64,
            '从 FaceHub 转存：' + safe, null, 'main', true);

        return { ok: true, repo: repo, path: path };
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

        // 刚发的本地消息有 dataUrl，直接用，不用等回读
        if (kind === 'image') {
            var img = document.createElement('img');
            img.className = 'att-img';
            img.alt = att.n || '';
            if (att.dataUrl) {
                img.src = att.dataUrl;
            } else {
                img.dataset.src = '1';
                this._lazyLoad(img, att, ctx);
            }
            img.onclick = function () { self.preview(att, ctx); };
            el.appendChild(img);
            box.appendChild(el);
            return el;
        }

        if (kind === 'video' || kind === 'audio') {
            var cover = document.createElement('div');
            cover.className = 'att-media';
            cover.innerHTML = '<span class="att-play">' +
                (kind === 'video' ? '▶' : '♪') + '</span>';
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
            box.appendChild(el);
            return el;
        }

        // 普通文件
        var card = document.createElement('div');
        card.className = 'att-file';
        var ic = document.createElement('span');
        ic.className = 'att-icon';
        ic.textContent = this.icon(att);
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
        box.appendChild(el);
        return el;
    },

    _lazyLoad(img, att, ctx) {
        var self = this;
        this.dataUrl(ctx.owner, ctx.repo, att.p).then(function (url) {
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
            var url = att.dataUrl || await this.dataUrl(ctx.owner, ctx.repo, att.p);
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
            : this.dataUrl(ctx.owner, ctx.repo, att.p));

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
                await this.dataUrl(ctx.owner, ctx.repo, att.p);
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
    async doSave(att, ctx, btn) {
        var full = Object.assign({}, att, { owner: ctx.owner, repo: ctx.repo });
        if (btn) { btn.disabled = true; btn.textContent = '转存中…'; }
        try {
            var r = await this.saveToDrive(full);
            if (!r.ok) {
                if (r.reason === 'no-drive') {
                    if (global.App) {
                        App.toast('没找到 Drive 存储仓库，请先去 GitHub Drive 创建', true);
                    }
                }
                if (btn) { btn.disabled = false; btn.textContent = '转存到 Drive'; }
                return;
            }
            if (global.App) App.toast('已转存到 Drive：' + r.path);
            if (btn) btn.textContent = '已转存 ✓';

            // 有桥接就顺带跳过去
            if (global.Bridge && Bridge.go) {
                try {
                    Bridge.go({ from: 'facehub', focus: r.path });
                } catch (e) { /* 跳转失败不影响已转存 */ }
            }
        } catch (e) {
            if (global.App) App.toast('转存失败：' + (e.message || e), true);
            if (btn) { btn.disabled = false; btn.textContent = '转存到 Drive'; }
        }
    }
};

    global.Attach = Attach;
})(typeof window !== 'undefined' ? window : this);
