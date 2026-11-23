# JP Lyrics Studio · 日语歌曲跟唱练习

由原纯前端项目 [JP Lyrics Sing（日语跟唱）](#致谢) 重构而来：**Python (FastAPI) 后端 + SQLite + 无构建步骤的静态前端（原生 ES Modules）**。
上传的音频、歌词，以及对分词 / 读音 / 罗马音 / 标记的所有修改都保存在服务端 `data/` 目录（SQLite 数据库 + 音频文件），下次打开无需重复上传和修改。

> 本文档同时面向人类与后续接手的 AI。修改代码前请先读「数据模型」「不变量」「常见修改指南」三节。

---

## 1. 快速开始

```bash
# Windows：双击 run.bat（首次会自动创建 .venv 并安装依赖）
# macOS / Linux：
./run.sh
# 或手动：
pip install -r requirements.txt
python run.py                 # http://127.0.0.1:8765 ，自动打开浏览器
python run.py --host 0.0.0.0  # 局域网 / 手机访问
python run.py --reload        # 开发模式，改后端代码自动重载
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JLS_DATA_DIR` | `./data` | 数据目录（`studio.db` 数据库 + `audio/` 音频文件） |
| `JLS_PROXY_BASE` | `https://jp-lyrics-proxy.nepqaq.workers.dev` | 原项目部署的 Cloudflare Worker（网易云 / Marumaru 代理）。设为空字符串则网易云只走直连 |
| `HTTPS_PROXY` 等 | – | httpx 会自动使用系统代理访问外部歌词源 |

依赖：Python 3.9+，`fastapi`、`uvicorn`、`python-multipart`、`httpx`；SQLite 使用标准库 `sqlite3`，无需单独安装。前端无需 npm。
测试：`pip install pytest && python -m pytest tests -q`

---

## 2. 功能一览

| 类别 | 功能 |
|---|---|
| 曲库（三个视图） | 顶栏「**曲库 / 歌词 / 单词本**」切换，刷新后恢复上次的视图。**曲库视图**参考网易云音乐：左侧**歌单**（全部歌曲、未归入歌单、我的歌单——「我的歌单」可展开 / 收起，＋ 新建，右键或 ⋯ 重命名 / 删除），右侧当前歌单的**歌曲列表**（序号 / 当前歌曲动画、封面、歌名、徽章、歌手、专辑、本设备缓存、时长、⋯ 菜单），搜索框筛选；点歌曲打开并切到歌词视图。一首歌可属于多个歌单：把歌拖到左侧歌单上、⋯ 菜单勾选，或在歌单页点「＋ 添加歌曲」。**拖动排序**（存服务端，所有设备一致；在歌单里拖动只调整该歌单内的相对顺序）|
| 快速选歌 | 播放条左下角显示当前歌曲（封面 + 歌名），点击在「歌词」↔「曲库」之间切换；播放条上的歌单按钮（L）在歌词 / 单词本视图里从**左侧**展开快速选歌栏并**一直停靠**（切歌不关闭，再点按钮或 × 才关闭；宽屏下记住开关状态，曲库视图里不显示）：歌直接放在各个歌单里，歌单可展开 / 收起（记住展开状态，首次打开展开当前歌曲所在的歌单），也可直接搜索全部歌曲。窄屏时为浮层，选歌后自动关闭 |
| 封面 | 上传 / 更换音频时自动提取内嵌封面（MP3 ID3 APIC、FLAC PICTURE、M4A covr、OGG METADATA_BLOCK_PICTURE）；NCM 由 Worker 取出内嵌封面一起上传；歌曲信息里可手动上传、「联网查找」（网易云专辑图 → iTunes）或移除；手动设置的封面不会被换音频覆盖；没有封面时显示按歌名生成的色块 |
| 多设备 / 本设备缓存 | 音频存在服务器上，每台设备**按需下载**到浏览器缓存（IndexedDB，局域网 http 也可用），曲库每首歌显示本设备是否已缓存、可单独或「全部下载」，带进度条；打开未缓存的歌时**不弹提示**，等真正要播放（播放键 / 行内 ▶ / 空格）时才提示「下载到本设备 / 在线播放」，选好后从刚才要播的位置开始（选下载则下载完自动开始播）；可设为每次询问 / 直接在线播放 / 自动下载；服务器上音频更新后本地缓存会提示「有更新」 |
| 单词本 | 从歌词自动整理单词（跟随你对分词 / 读音的编辑，自动去掉词尾助词）；显示平假名、片假名、罗马音、动词形容词原形、例句（点击跳回歌词）；释义自动机器翻译、可手动修改（手动的不会被覆盖）；收藏、搜索、排序、导出 CSV；当前歌曲 / 全部歌曲 / 收藏三种范围 |
| 本地导入 | **一次选择 / 拖入多个文件**，按扩展名 → MIME → 文件头 / 文本内容自动识别「歌曲」与「歌词」（识别错可手动改）；多首歌一起导入时按文件名自动配对；NCM 在浏览器 Web Worker 中还原并读取歌名/歌手；歌名优先级：NCM 元数据 > LRC `[ti]/[ar]` > 文件名 `歌手 - 歌名`；无歌词时导入后自动打开联网搜索 |
| 联网歌词 | 网易云（Worker 代理优先，失败回落官方接口直连，含翻译 / 逐字 yrc）、LRCLIB（同步 / 纯文本）、曲库内搜索；结果可「新建到曲库」或「**绑定到当前歌曲**（保留已上传音频）」；同来源同 ID 去重 |
| 自动补充 | **逐字时间轴**（网易云 yrc 优先，PetitLyrics 兜底，本地导入的歌也会自动获取一次）；Marumaru 注音（演唱读法）+ 中文；MyMemory 机器翻译补全中文 |
| 播放 | 本地音频 / 计时器（配合外部播放器）两种音源；**全局倍速** 0.5–1.5×（变速保持音高，可关）；歌词偏移 ±0.1s 微调与**一键「对齐」**（A）；每行 ▶ 的行为由播放条上的「**单句 / 连续**」按钮（M）切换：单句 = 只播这一句后停下（再点停止），连续 = 从这句开始正常往下播；**单句循环**（起止按逐字时间或音拍估算，不会切进下一句）；上/下一句；逐字 KTV 进度（无逐字数据时按音拍加权）；当前句自动居中 |
| 打轴 | 纯文本歌词边听边按 `T` 给每句打时间，完成后时间轴变为「同步」 |
| 分词显示 | kuromoji 分词后按「文节」组合成单词（`風に`、`触った`、`中で`）；单词样式：边框 / 交替底色 / 下划线 / 无，可「仅长句启用」；布局：分行（原文 / 罗马音 / 中文）或**逐词对照**（每个词竖排：注音-汉字-罗马音）；悬停原文词 ↔ 罗马音词互相高亮 |
| 关注难句 | 每行的 ⚑ 按钮（或 F 键标记当前句）把难句设为「关注」，橙色高亮显示；练熟后再点一次取消。存服务端（`line.focus`），不进修改历史 |
| 缩略图 | 占满歌词区右侧的 CodeGlance 式缩略图（宽度 `--mm-w`）：每句一根横条（位置与实际排版对应），橙 = 关注、蓝点 = 手动改过、实色 = 当前句、深色 = 已唱过；半透明框为当前可见范围，可拖动、点击跳转，悬停显示该句原文。窄屏（≤720px）隐藏 |
| 悬浮按钮 | 位于歌词与右侧缩略图之间（靠缩略图一侧）的圆形按钮，快速切换：注音（平假名 → 片假名 → 隐藏）、罗马音、中文、字号（与设置面板同步） |
| 编辑 | **编辑模式（E）**：点选单词，Shift 多选 → 合并 / 拆分 / 5 色高亮 / 边框 / 连读 / 停顿 / 备注 / 声调；**行编辑器**（双击行或 ✎；打开时自动暂停播放，关闭后不自动继续）：原文、时间、字间切分、逐词假名（平/片假名）、逐词罗马音、整行罗马音、中文——**不需要日语输入法**：读音框直接打罗马音自动转假名（大写→片假名），改罗马音会同步读音，整行罗马音与各词双向同步，原文框可开「罗马音输入」；**全文编辑**（LRC）；编辑可同步到本曲相同歌词（副歌） |
| 持久化 | 所有修改写入服务端；**修改历史**可逐条撤销（同一次操作同步的多行作为一组撤销；全文编辑前自动快照）；**我的词典**：自定义词与读音，自动分词时整体识别，对所有歌曲生效 |
| 其它 | 导出 TXT（原文/分词/假名/罗马音/中文任意组合）与 LRC；浅色/深色/跟随系统；字号缩放；移动端适配；快捷键 |

快捷键：`空格` 播放/暂停 · `←/→` 上/下一句 · `[ / ]` 降速/升速 · `R` 单句循环 · `M` 单句/连续切换 · `F` 关注/取消关注当前句 · `L` 打开/关闭左侧快速选歌栏（曲库视图里按 L 会切到歌词并打开）· `A` 对齐（在某句刚开始唱时按）· `E` 编辑模式 · `T` 打点（打轴中）· `Esc` 取消选中 · 行编辑器 `Ctrl+Enter` 保存。

---

## 3. 目录结构

```
jp-lyrics-studio/
├── run.py / run.bat / run.sh     启动入口
├── requirements.txt
├── server/
│   ├── app.py        FastAPI 路由（静态文件、曲库、歌词行、历史、联网转发）
│   ├── storage.py    SQLite 存储（表结构见第 5 节）、旧版 JSON 数据自动迁移
│   ├── lrc.py        LRC 解析 / 生成，行结构工厂 make_line()
│   ├── online.py     网易云 / LRCLIB / Marumaru / PetitLyrics / 翻译 / 联网封面 的服务端请求
│   ├── cover.py      从音频文件提取内嵌封面（纯 Python，无依赖）
│   └── vocab.py      单词本：从 line.words 整理单词、去词尾助词、合并计数
├── static/
│   ├── index.html    单页：顶栏（视图切换）、歌单侧栏、歌曲列表、歌词区（缩略图、悬浮按钮）、单词本、快速选歌栏、播放条（左下角当前歌曲）、所有 <dialog>
│   ├── css/app.css   全部样式（:root 颜色 token，深色模式只改 token）
│   ├── js/           前端模块（见第 6 节）
│   ├── workers/ncm-worker.js   NCM 还原 + 元数据解密（Web Worker）
│   ├── lib/          kuromoji.js（分词）、aes-js（NCM）
│   └── dict/         kuromoji IPADIC 词典（17MB，长缓存）
├── tests/test_backend.py
└── data/             运行时生成，已在 .gitignore 中忽略（不要提交）
    ├── studio.db     SQLite 数据库（WAL 模式，旁边的 -wal / -shm 是正常的）
    ├── audio/        上传的音频 <song_id>.<ext>
    └── covers/       封面图片 <song_id>.<jpg|png|webp|gif>
```

---

## 4. 架构与数据流

```
浏览器                                                     Python 后端 (FastAPI)
┌───────────────────────────────────────────┐            ┌────────────────────────────┐
│ main.js 启动 → GET /api/settings, /songs   │──────────▶ │ storage: data/studio.db     │
│ song.js openSong → GET /api/songs/{id}     │            │                            │
│   ├ render.js 渲染（words 为空的行先显示原文）│            │                            │
│   └ analyzeSong: kuromoji 分词(浏览器内)     │            │                            │
│        → PUT /lines {record:false} 回写缓存  │──────────▶ │ 行局部更新（不记历史）        │
│ 用户编辑 editor.js saveLine                │            │                            │
│        → PUT /lines {record:true, kind}     │──────────▶ │ 行更新 + history 表          │
│ 联网 search.js → /api/online/*             │──────────▶ │ online.py → 网易云/LRCLIB…   │
│ 音频 <audio src=/api/songs/{id}/audio>     │◀────────── │ FileResponse（支持 Range）   │
└───────────────────────────────────────────┘            └────────────────────────────┘
```

**为什么分词在浏览器做？** 复用原项目的 kuromoji.js + 词典，无需 Python 端安装 MeCab 等重依赖。分词结果一次性回写到服务端，之后打开歌曲直接使用缓存的 `words`，不再重复分析。

---

## 5. 数据模型（最重要）

### 5.0 存储方式：SQLite（`data/studio.db`）

| 表 | 内容 |
|---|---|
| `settings` | `key` → JSON 值。键与默认值见 `storage.DEFAULT_SETTINGS`（新增设置必须先加在那里，否则后端会丢弃） |
| `dictionary` | 我的词典：`surface`（词面）、`kana`、`romaji`、`fixed`（分词时作为独立整体） |
| `songs` | 歌曲元数据（下文 5.1 的字段，`offset` 列名为 `offset_sec`；`audio` / `sync_info` / `lyric_source` 为 JSON 文本） |
| `lines` | 歌词行，主键 `(song_id, id)`，`pos` 为顺序；`words` / `word_timing` 为 JSON 文本，`end` 列名为 `end_time` |
| `history` | 编辑历史：`before` / `after` 为整行 JSON 快照，`grp` 为同一次操作的分组，`snapshot` 指向 `snapshots.id` |
| `snapshots` | 全文编辑 / 整首撤销前的整首歌词快照 |
| `categories` | 歌单（界面上叫「歌单」，代码 / 接口里叫 categories）：`id`、`name`、`sort_order` |
| `song_categories` | 歌曲 ↔ 歌单（多对多），删除歌曲或歌单时级联删除关联（删歌单不删歌） |
| `vocab_notes` | 单词本释义 / 备注 / 收藏，按词面跨歌曲共享；`source = auto`（机翻）/ `user`（手动，不会被机翻覆盖） |

* `songs.sort_order`：曲库手动排序（小的在前），新歌放最上面；v1 数据库启动时自动加列（`_upgrade_schema`），初始顺序 = 原来的最近打开顺序。
* `songs.cover`（JSON：`{file, mime, size, source: embedded|ncm|user|netease|itunes, updatedAt}`）+ `songs.cover_checked`（是否已尝试过从音频提取，避免每次启动重复扫描）；`lines.focus`（关注难句，0/1）。这三列由 v3 迁移（`SCHEMA_VERSION = 3`）自动添加，旧库启动时会给已有音频补提一次内嵌封面（`backfill_covers`）。

* 删除歌曲时 `lines` / `history` / `snapshots` / `song_categories` 通过外键级联删除，音频和封面文件同时删除。
* 音频不放进数据库：体积大，且 `<audio>` 拖动进度需要 HTTP Range，直接存 `data/audio/<song_id>.<ext>` 最简单。
* `storage.py` 对外仍以「整首歌一个 dict」读写（`get_song` / `save_song`），下面 5.1–5.3 描述的就是这个 dict 与前端收到的 JSON；`app.py` 不直接写 SQL。
* **旧数据迁移**：启动时若发现旧版 JSON 存储（`data/songs/<id>/song.json`、`settings.json`、`dictionary.json`），会自动导入数据库，音频移到 `data/audio/`，旧文件移到 `data/_legacy_json_backup/`（不删除，确认无误后可手动删掉）。
* 备份：关闭服务后复制整个 `data/` 目录即可；查看数据可用任意 SQLite 工具（如 DB Browser for SQLite）。

### 5.1 Song（`GET /api/songs/{id}` 返回的歌曲对象）

```jsonc
{
  "id": "261112-a1b2c3",
  "title": "夜に駆ける", "artist": "YOASOBI", "album": "",
  "source": "local|netease|lrclib|marumaru",  "sourceId": "",   // 联网导入时用于去重
  "lyricSource": {"source": "...", "sourceId": "..."},          // 「绑定联网歌词」时记录（可选）
  "audio": {"file": "261112-a1b2c3.mp3", "mime": "audio/mpeg", "size": 123, "name": "原文件名", "uploadedAt": 0} | null,
                                          // 文件在 data/audio/；版本号 audioVersion = "大小-上传时间"，浏览器缓存据此判断是否过期
  "cover": null | {"file": "….jpg", "mime": "image/jpeg", "size": 1, "source": "embedded|ncm|user|netease|itunes", "updatedAt": 0},
                                          // 曲库列表另给 coverVersion（缓存用）、categories（所属歌单 id 数组）、duration（秒，播放时记录）
  "timeline": "synced|synthetic|none",   // synthetic = 纯文本按 4 秒估算，可打轴
  "offset": 0.0,                          // 歌词偏移（秒），音频时间 = 歌词时间 + offset
  "syncInfo": null | {"status": "ok|none|cleared", "source": "网易云|PetitLyrics", "matched": 30, "total": 33, "median": 0.3},
                                          // 逐字时间轴获取结果；非 null 时不再自动尝试（替换歌词会重置为 null）
  "lines": [ Line, ... ],                 // 按 time 升序
  "createdAt": 0, "updatedAt": 0, "lastOpenedAt": 0
}
```

### 5.2 Line（行）

```jsonc
{
  "id": "l_1a2b3c4d",       // 稳定 ID：编辑历史、全文编辑保留修改都依赖它
  "time": 12.34,            // 开始时间（秒）
  "end": 15.0 | null,       // 结束时间（默认 = 下一行 time，由 lrc.recompute_ends 维护）
  "text": "風に触った中で",   // 日语原文
  "zh": "",                 // 中文
  "words": [Word] | null,   // null = 尚未分析（前端会自动分析并回写）
  "wordsEdited": false,     // 用户手动改过分词/读音/标记 → 自动重新分析时跳过
  "romaji": null | "...",   // 整行罗马音手动覆盖；null = 由 words[].r 拼接
  "ruby": null | "<ruby>…", // 外部注音 HTML（Marumaru），分析时用于覆盖 kuromoji 读音
  "wordTiming": null | [{"starttime": ms, "endtime": ms, "text": "風"}],  // 逐字时间轴
  "focus": false            // 关注难句（高亮 + 缩略图橙色）；全文编辑时随原文相同的行保留
}
```

### 5.3 Word（单词）

```jsonc
{ "t": "触った", "k": "さわった", "r": "sawatta",
  "p": 1,                         // 可选：标点/空白（不加框、无罗马音）
  "m": {                          // 可选：用户标记
    "hl": "y|g|b|p|o",            // 荧光笔颜色
    "box": true,                  // 强调边框
    "note": "备注",
    "tone": 1,                    // 1-4 声调提示（给中文母语者）
    "link": true,                 // 与下一个词连读（罗马音显示 ‿）
    "brk": true                   // 词后停顿（罗马音显示 /）
  } }
```

### 5.4 历史记录与词典（API 返回形式）

* 历史：`{id, ts, lineId, kind, summary, before, after, group?, snapshot?}`。`group` 相同的条目是同一次操作（如同步到副歌），撤销时一起恢复；`kind=lyrics` 的条目通过 `snapshot` 指向整首快照。
* 词典：`{ "風に触った": {"k": "かぜにさわった", "r": "kaze ni sawatta", "fixed": true} }`。

### 5.5 不变量（修改代码时务必保持）

1. `line.words.map(w => w.t).join('') === line.text`。行编辑器按字符位置切分依赖它；`analyzer.wordsMatchText()` 检测到不一致会触发重新分析。
2. 行 `id` 一经生成不变；全文编辑时原文相同的行会继承旧 `id` 和修改（`app.replace_lyrics`）。
3. 自动分析回写一律 `record:false`；用户操作一律 `record:true`（进历史）。
4. `wordsEdited=true` 的行不会被「重新分析」「Marumaru 补充」覆盖。
5. 前端运行时字段以下划线开头（如 `line._el`），提交后端前用 `state.cleanLine()` 剔除或只发送指定字段。

---

## 6. 前端模块地图（`static/js/`）

| 模块 | 职责 | 主要导出 |
|---|---|---|
| `main.js` | 启动、设置面板、顶栏命令（`data-cmd`）、歌词区事件委托（行 ▶ 单句/连续、⚑ 关注、✎ 编辑）、悬浮按钮、键盘快捷键、视图切换 `setAppMode('list'|'lyrics'|'vocab')`（`state.appMode`，localStorage `jls-app`） | – |
| `state.js` | 全局状态 `state`（settings / song / songs / editing / activeIdx） | `state`, `lineById`, `sameTextLines`, `cleanLine` |
| `api.js` | 所有后端请求（含上传进度） | `api` |
| `util.js` | `$`、`h()` 建元素、toast、状态栏、事件总线 `bus` | – |
| `kana.js` | 纯函数：平/片假名互转、假名→罗马音（Hepburn）、**罗马音→假名** `romajiToKana` / `wordRomajiToKana`、**注音对齐** `alignRuby`、按切点拆读音 `splitReading` | – |
| `analyzer.js` | kuromoji 加载、**文节式分组** `attaches()`、罗马音分段、词典预切分、Marumaru 注音覆盖 | `analyzeText`, `ensureTokenizer`, `lineRomaji` |
| `render.js` | 行/单词 HTML（分行 & 逐词对照）、显示设置 → body class | `renderSong`, `renderLineContent`, `applyDisplayClasses` |
| `player.js` | 音源、倍速、同步高亮、KTV 逐字进度、单句播放/循环、偏移微调与对齐、打轴 | `player`, `setRate`, `playLine`, `seekLyric`, `calibrateOffset` … |
| `timing.js` | **时间轴计算**：句子实际起止（逐字 / 音拍估算）、粗粒度逐字数据修复、每拍秒数、单句区间、KTV 加权进度 | `lineStart`, `sungEnd`, `segmentRange`, `karaokeProgress`, `effectiveTiming` |
| `editor.js` | 单词工具条、行编辑器、全文编辑、修改历史、我的词典；`saveLine()` 是所有用户编辑的唯一出口 | `saveLine`, `openLineEditor`, `mergeWords`, `splitWord` |
| `song.js` | 打开/重载歌曲、后台分析回写、逐字时间轴获取与匹配（`matchTiming`）、Marumaru/翻译补充 | `openSong`, `analyzeSong`, `fetchWordTiming`, `autoEnrich` |
| `library.js` | 曲库视图：歌单侧栏 `renderSidebar`、歌曲列表 `renderSongList`（本设备缓存状态 / 下载进度、Pointer Events 拖拽排序 / 拖到歌单）；左侧停靠的快速选歌栏 `renderDrawer` / `toggleDrawer`（localStorage `jls-drawer`）；播放条当前歌曲 `renderNowPlaying`；歌单与歌曲菜单；多文件导入（类型识别 `classify` / 配对 `pairFiles`）、NCM 还原（含封面）、歌曲信息（封面、所属歌单）。`renderLibrary()` 统一重绘以上所有部分 | `refreshLibrary`, `openImport`, `toggleDrawer`, `toggleSidebar` |
| `cache.js` | 本设备音频缓存（IndexedDB）：带进度下载、版本校验、删除；本设备音频策略（localStorage `jls-audio-mode`） | `downloadAudio`, `getCached`, `cacheIndex` |
| `vocab.js` | 单词本界面：加载 `/api/vocab`、原形补充、释义编辑与自动翻译、跳回歌词、导出 CSV | `openVocab` |
| `ime.js` | 罗马音 → 假名「边打边转」输入（无需日语输入法），给读音框 / 原文框使用 | `attachRomajiIME` |
| `search.js` | 联网搜索对话框、导入或绑定歌词、Marumaru 候选 | `openSearch` |
| `minimap.js` | 歌词缩略图：按 `line._el.offsetTop` 等比画横条、视口框拖动、悬停提示；ResizeObserver 监听行高变化后重绘 | `renderMinimap`, `initMinimap` |
| `export.js` | 导出 TXT / LRC | – |

主要 `bus` 事件：`song:opened`、`song:reload {keepPosition}`、`song:changed`、`song:reanalyze`、`song:closed`、`settings:patch`、`search:open {q, bind}`、`library:refresh`、`library:rendered`、`minimap:render`、`word:click`、`line:active`。

### 分词规则（`analyzer.js`）

* token 并入前一个词的条件见 `attaches()`：助词、助动词、非自立/接尾动词与形容词、接尾名词、`の/ん`、接头词后的词、サ変名词 + する。
* 标点/空白单独成「词」（`p:1`），英文单词单独成词。
* 罗马音：词内在独立助词（非接续助词）、非自立动词、名词后的 です/だ 前加空格 → `kaze ni`、`sawatte ita`、`kirei desu`；助词 は/へ/を → wa/e/o。长音按拼写展开（`kyou`、`koohii`）。
* 词典：`DEFAULT_READINGS`（原项目的常见误读表）+ 用户词典，最长匹配预切分后作为伪 token 参与分组。

### 同步机制（`timing.js` + `song.js`）

LRC 只有「每句开始时间」。原实现把「下一句开始」当成本句结束、在整段区间里线性推进 KTV 进度，所以句后有间奏时进度被拉长，单句播放也会切进下一句。现在的处理：

1. **逐字时间轴优先**：打开有同步时间轴、但没有逐字数据的歌曲时（设置「自动获取逐字时间轴」，默认开），后台按「歌名 歌手」搜索网易云，取前 3 个候选的 yrc 逐字歌词；不够好再试 PetitLyrics（原项目使用的逐字同步歌词站）。
   `matchTiming()` 按原文 + 时间就近把外部行匹配到本曲各行，用**时间差中位数**判断是不是同一版本（> 5 秒视为不同版本放弃），偏离中位数 1.5 秒以上的个别匹配丢弃。匹配上的行：句子起止 = 第一个字开始 / 最后一个字结束，KTV 逐字推进。
2. **无逐字数据时按音拍估算句尾**：整首统计「每拍秒数」（相邻句间隔 ÷ 假名拍数，取 35% 分位，排除带间奏的句子），句尾 = 开始 + 拍数 × 每拍秒数 × 1.25 + 0.6 秒，且不超过下一句开始；LRC 里的空白时间标签（显式句尾）优先。KTV 进度按每个字的拍数加权（汉字按读音拍数，小写假名 0 拍）。
   **注意粗粒度数据**：PetitLyrics 的部分歌曲虽然标为逐字（Type 3），实际上一整段的每个字时间几乎相同、`endtime == starttime`（只有分段起点是准的）。直接使用会在 0.2 秒内把整句高亮「一下全跳完」。`timing.isCoarseTiming()` 识别这种数据，`effectiveTiming()` 只保留分段起点（相邻字时间跳变 ≥ 250ms），段内再按音拍重新分配每个字的时间；原始数据不改写，顶栏显示「分段同步」。
3. **单句区间** = [开始 − 提前开始, min(句尾 + 余量, 下一句开始 − 提前结束)]，两个余量在设置里可调（默认 0.15 / 0.2 秒），且不会早于上一句唱完的时间。
4. **整体偏移**：`song.offset`（音频时间 = 歌词时间 + offset），播放条上 ±0.1 秒微调；「对齐」按钮（A）在听到某句刚开始唱时按下，自动取最近的一句计算偏移（已扣除约 0.18 秒反应时间）。
5. 原始 `line.time` 不会被逐字数据改写（导出 LRC 不变）；行编辑器显示/修改的是实际开始时间，改动时逐字时间整体平移。

---

## 7. 后端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/settings` | 读取 / 局部更新设置 |
| GET/PUT | `/api/dictionary` | 词典；PUT `{entries:{词:{k,r,fixed}}, remove:[词]}` |
| GET | `/api/songs` | 曲库摘要列表（按 sort_order；含 `audioVersion` / `audioSize` 供缓存判断） |
| PUT | `/api/songs/order` | 拖拽排序 `{ids:[...]}` |
| GET/POST | `/api/categories` | 歌单列表（含 `count`）/ 新建 `{name}` |
| PUT | `/api/categories/order` | 歌单排序 `{ids:[...]}` |
| PATCH/DELETE | `/api/categories/{cid}` | 重命名 `{name}` / 删除（不删歌） |
| POST | `/api/categories/{cid}/songs` | 加入歌单 `{songIds:[...]}` |
| DELETE | `/api/categories/{cid}/songs/{song_id}` | 移出歌单 |
| PUT | `/api/songs/{id}/categories` | 设置某首歌所属歌单 `{ids:[...]}` |
| GET/PUT/DELETE | `/api/songs/{id}/cover` | 封面图片；PUT multipart `image` + `source=user\|ncm` |
| POST | `/api/songs/{id}/cover/fetch` | 联网查找封面（网易云 → iTunes） |
| GET | `/api/vocab?song=<id>\|all` | 单词本条目 `{t, k, r, count, forms, songs, examples, meaning, meaningSource, starred, edited}` |
| PUT | `/api/vocab/notes` | 保存释义 / 备注 / 收藏 `{items:[{surface, meaning?, source?, note?, starred?}]}` |
| POST | `/api/songs` | multipart：`title, artist, album, lrc, audio(file), lrcFile(file)` 新建本地歌曲 |
| POST | `/api/songs/import` | JSON：联网歌词入库 `{source, sourceId, title, artist, lines, timeline}`（同来源去重） |
| GET/PATCH/DELETE | `/api/songs/{id}` | 读取（同时更新 lastOpenedAt）/ 改元数据（title, artist, album, offset, timeline）/ 删除 |
| GET/PUT/DELETE | `/api/songs/{id}/audio` | 音频（GET 支持 Range） |
| PUT | `/api/songs/{id}/lines` | 按行 ID 局部更新 `{lines:[{id,...}], record, kind, note}`；改了 time 会重排并返回整首 |
| POST | `/api/songs/{id}/lyrics` | 整体替换歌词 `{lrc | lines, timeline?, keepEdits=true, note, source?, sourceId?}`，自动快照 |
| GET | `/api/songs/{id}/history` | 修改历史（新→旧） |
| POST | `/api/songs/{id}/history/{hid}/revert` | 撤销到该记录修改前（组 / 快照） |
| GET | `/api/songs/{id}/export.lrc?zh=1` | 下载 LRC |
| POST | `/api/lrc/parse` | 解析 LRC 文本 → 行 |
| GET | `/api/online/netease/search?q=` · `/netease/lyric?id=` | 网易云 |
| GET | `/api/online/lrclib/search?q=` | LRCLIB |
| GET | `/api/online/marumaru/search?title=&artist=` · `/marumaru/lyric?url=` | Marumaru（经 Worker） |
| GET | `/api/online/petit?title=&artist=` | PetitLyrics 逐字时间轴 |
| POST | `/api/online/translate` | `{texts:[...]}` → `{results:[...]}` |

---

## 8. 常见修改指南

* **新增一个显示设置**：① `storage.DEFAULT_SETTINGS` 加键；② `index.html` 的 `#settings` 里加控件并写 `data-set="键名"`（checkbox / radio / range / number 自动绑定）；③ 在 `render.applyDisplayClasses()` 映射到 body class 或 CSS 变量；需要重新渲染行时把键加入 `main.js` 的 `RERENDER` 集合。
* **新增一种单词标记**：在 `Word.m` 里加字段 → `render.js` 的 `wordClasses()` / `romajiWordHTML()` 输出 class → `app.css` 写样式 → `index.html` 的 `#word-toolbar` 加按钮并在 `editor.js initToolbar()` 里用 `setMark(words, '字段', 值)` 绑定（行编辑器的 `wordRow()` 也可加对应控件）。
* **调整分词粒度**：只改 `analyzer.js` 的 `attaches()`；已缓存的歌曲需在「更多 → 重新分析未编辑的行」生效（手动编辑过的行不受影响）。
* **改罗马音风格（如长音符 ō）**：改 `kana.kanaToRomaji()`；注意它也用于用户改读音后的自动罗马音。
* **新增联网歌词源**：`online.py` 写请求函数 → `app.py` 加 `/api/online/xxx` 路由 → `api.js` 加方法 → `search.js` 里加一个 `sr-tab`/`sr-pane` 和 `loadXxx()`，最终调用 `commitLyrics()` 落库。
* **改表结构**：在 `storage.SCHEMA` 中修改，并把 `SCHEMA_VERSION` 加 1、在 `init()` 里按 `meta.schema_version` 写迁移（`ALTER TABLE …`）；`_SONG_COLS` 维护歌曲对象键 ↔ 列名的映射，行对象映射在 `_row_to_line` / `_line_params`。

---

## 9. 已知限制

* 分词依赖 kuromoji/IPADIC，歌词中的特殊读法（当て字）常需手动修正——这正是编辑功能的用途；修正后可加入「我的词典」复用。
* 自动获取逐字时间轴依赖网易云 / PetitLyrics 能搜到同一版本；搜不到时只能按音拍估算，可用「对齐」与 ±0.1 秒微调，或在行编辑器里逐句改时间。
* 拆分多字汉字词（如把 `一緒` 拆成 `一|緒`）时读音无法精确分配，会对各部分重新查词典，可在行编辑器中手改。
* Marumaru 依赖原项目的 Worker（`JLS_PROXY_BASE`）；Worker 不可用时该功能失效，网易云会回落到官方接口直连。
* 变速播放依赖浏览器 `playbackRate`；计时器音源的倍速只影响计时速度（外部播放器需自行同步）。
* 联网查找封面按「歌名 + 歌手」搜索，可能找到同名的其它版本，不对可手动上传。
* 单用户本地应用，没有登录/鉴权；如需对外网开放请自行加反向代理与认证。

## 10. 第三方

kuromoji.js（Apache-2.0）及 IPADIC 词典；aes-js（MIT）；NCM 解析改编自 ncmdump-js，许可见 `static/lib/NCM-LICENSES.txt`。歌词与注音来自网易云音乐、LRCLIB、Marumaru、PetitLyrics，版权归各自所有，仅供个人学习使用。

---

## 致谢

本项目基于 **JP Lyrics Sing（日语跟唱）** 重构，衷心感谢原作者 **μ'sic forever**（GitHub：[nepqaq](https://github.com/nepqaq)）。

原项目奠定了这个工具几乎所有的核心能力与思路，本项目在此基础上改为 Python 服务端存储并做功能扩展：

* 日语假名 / 罗马音生成方案（kuromoji + 本地词典，国内可用）与常见误读修正表；
* 网易云歌词代理 Worker（yrc 逐字时间轴、人工翻译、罗马音）与 Marumaru 注音、LRCLIB 搜索；
* PetitLyrics 逐字时间轴的接入，以及「整句时间估算导致不同步」问题的定位思路；
* NCM 本机还原、计时模式、逐句练习、罗马音声调 / 连读 / 停顿标记、多音色日语朗读等功能设计。

本项目仍默认使用原作者部署的歌词代理 Worker（`JLS_PROXY_BASE`），请合理使用、勿高频请求。
