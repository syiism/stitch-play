// rulesUi.js · 规则工坊（声明式源规则教程 + 演练场 + 源配置生成器 + 源调试器）
//
// 数据流：教程示例/生成器 → 演练场 → ruleParser.resolveRule/resolveList 真引擎求值 → 只读展示。
// 求值语义与 declarativeSource._get 对齐：顶层含 data 键的信封自动剥离后再求值。
// 源调试器：本页独立构建源注册表（loadConfig + initSources，本机自定义源自动并入），
// 实发请求走 declarativeSource.debugProbe（与线上同拼装、只读不写缓存），求值走 debugEvaluate。

import { resolveRule, resolveList } from "./sources/ruleParser.js";
import { listCustomSources, saveCustomSource, removeCustomSource } from "./sourcePrefs.js";
import { loadConfig } from "./runtimeConfig.js";
import { initSources, registry, getBaseUrl, getProxy, setSourceBase, DeclarativeSource } from "./sources/index.js";

// —— 内置样例（结构裁剪自沐凡/兔兔真实响应，地址已脱敏）——
const SAMPLES = {
  "mufan-discover": {
    label: "沐凡 · 发现页（{code,data} 信封）",
    json: {
      code: 0,
      data: {
        book_info: [
          { series_id: 710301, title: "闪婚老公是豪门", cover: "", horiz_cover: "https://cdn.example.com/h1.jpg", vid: "" },
          { series_id: 710302, title: "重生之都市修仙", cover: "https://cdn.example.com/c2.jpg", horiz_cover: "", vid: "" }
        ]
      }
    }
  },
  "tutu-discover": {
    label: "兔兔 · 发现页（tab_item 嵌套通配）",
    json: {
      code: 0,
      data: {
        tab_item: [
          { tab_type: 24, cell_data: [{ cell_data: [
            { video_data: { series_id: 7670171074478230553, title: "开局签到荒古圣体", cover: "https://cdn.example.com/t1.jpg", vid: 7670175156643302400, video_detail: null } },
            { video_data: { series_id: 7670171074478230554, title: "", cover: "", vid: 0, video_detail: { series_title: "万古神王", series_cover: "https://cdn.example.com/t2.jpg", first_vid: 7670175156643302500 } } }
          ] }] },
          { tab_type: 16, cell_data: [{ cell_data: [
            { video_data: { series_id: 7664521309044345000, title: "", cover: "", vid: "", video_detail: { series_title: "彩运照人心", series_cover: "https://cdn.example.com/s1.jpg", first_vid: 7664527481893833000 } } }
          ] }] }
        ]
      }
    }
  },
  "tutu-directory": {
    label: "兔兔 · 目录（item_data_list）",
    json: {
      code: 0,
      data: {
        item_data_list: [
          { item_id: 7664527481893833000, title: "第1集 彩运当头" },
          { item_id: 7664528200000000000, title: "第2集 祸从天降" }
        ]
      }
    }
  },
  "tutu1-directory": {
    label: "兔兔1 · 目录（chapterListWithVolume 分卷嵌套）",
    json: {
      code: 0,
      data: {
        allItemIds: ["7664634311907232793", "7664634419394661401"],
        chapterListWithVolume: [
          [
            { itemId: "7664634311907232793", title: "第101集", realChapterOrder: "1" },
            { itemId: "7664634419394661401", title: "第102集", realChapterOrder: "2" }
          ]
        ]
      }
    }
  },
  "tutu-resolve": {
    label: "兔兔 · 取流（双层信封 + video_list 对象通配）",
    json: {
      code: 0,
      message: "ok",
      video_info: {
        code: 0,
        data: {
          video_list: {
            video_5:  { definition: "540P",  main_url: "", backup_url_1: "http://localhost:8080/src/video_a.mp4" },
            video_10: { definition: "1080P", main_url: "", backup_url_1: "http://localhost:8080/src/video_b.mp4" }
          }
        }
      }
    }
  }
};

// —— 与 declarativeSource._get 一致的信封剥离 ——
function envelopeStrip(json) {
  if (json && typeof json === "object" && !Array.isArray(json) && json.data !== undefined) return json.data;
  return json;
}

const $ = (id) => document.getElementById(id);

// —— Tab 切换（教程 / 演练场 / 生成器 / 调试器；模块级供各区块互相跳转）——
const TABS = [
  ["tabDoc", "docContent"], ["tabPlay", "playContent"],
  ["tabGen", "genContent"], ["tabDbg", "dbgContent"],
];
function switchTab(on) {
  for (const [tab, pane] of TABS) {
    $(tab).classList.toggle("on", tab === on);
    $(pane).hidden = tab !== on;
  }
}

// ============================================================
// 教程内容
// ============================================================
function tryBtn(rule, sampleKey) {
  const attr = String(rule).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<button class="try" data-rule="${attr}" data-sample="${sampleKey || ""}">试 →</button>`;
}

const CHAPTERS = [
  {
    title: "1 · 规则是什么",
    open: true,
    html: `
      <p>每个声明式源是 <code>sources.d/</code> 下一个 JSON 文件，其中 <code>config.mapping</code> 的每个字段值就是一条<b>规则</b>。适配器用规则从接口响应里提取字段，把原始数据归一化成规范元素 <code>QueueItem</code>。</p>
      <table class="rules">
        <tr><th>类型</th><th>写法</th><th>示例</th></tr>
        <tr><td>$ 路径</td><td>$ 开头，.key / [n] / [*]</td><td>$.data.dataList · $.list[0].title</td></tr>
        <tr><td>模板插值</td><td>字符串含 $ 片段，拼接输出</td><td>drama-$.series_id → "drama-123"</td></tr>
        <tr><td>字面量</td><td>不含 $ 的字符串</td><td>"短剧"</td></tr>
        <tr><td>fallback 数组</td><td>依次求值取首个命中，可嵌套</td><td>["$.cover","$.horiz_cover"]</td></tr>
      </table>
      <div class="note"><b>信封剥离</b>：顶层是 <code>{code, msg, data}</code> 信封时，适配器先剥掉外层、取 <code>data</code> 作为求值上下文（右侧演练场同样自动剥离，右上角会提示当前上下文）。顶层<b>没有</b> data 键的响应（如兔兔取流）原样作为上下文。</div>
      <div class="note warn">命中判定：<code>undefined / null / 空字符串</code> 视为未命中；<code>0 / false</code> 是合法命中值。路径非法或中途缺失也是未命中，不会抛错。</div>`
  },
  {
    title: "2 · $ 路径与 [*] 通配",
    html: `
      <h4>基础取值</h4>
      <p><code>$.book_info</code> 取 data 根下的列表${tryBtn("$.book_info", "mufan-discover")}；<code>$.list[0].title</code> 数组下标；<code>$</code> 即上下文本身。</p>
      <h4>数组通配 [*]</h4>
      <p>兔兔发现页元素藏在多层嵌套里，分组数量不定，用 <code>[*]</code> 对数组每个元素续求剩余路径、结果合并展平：</p>
      <p><code>$.tab_item[*].cell_data[0].cell_data[*].video_data</code>${tryBtn("$.tab_item[*].cell_data[0].cell_data[*].video_data", "tutu-discover")}</p>
      <h4>对象通配 [*]</h4>
      <p><code>[*]</code> 对<b>对象</b>同样生效（对每个键值续求）。兔兔取流响应的 <code>video_list</code> 键名是清晰度档位（video_5 / video_10…），逐个枚举不现实：</p>
      <p><code>$.video_info.data.video_list[*].backup_url_1</code>${tryBtn("$.video_info.data.video_list[*].backup_url_1", "tutu-resolve")}</p>
      <div class="note">通配结果永远是数组；映射成 src 时适配器取第一个字符串命中。整串为合法路径时返回原始类型（数字/布尔不转字符串）。</div>`
  },
  {
    title: "3 · 模板插值与字面量",
    html: `
      <p>字符串含 <code>$</code> 片段但整串不是纯路径时，做<b>模板插值</b>：每个 <code>$路径</code> 片段求值后拼进字符串。这是构造 <b>id 体系</b>的关键——</p>
      <p><code>"drama-$.series_id"</code> → <code>"drama-710301"</code>${tryBtn("drama-$.series_id", "mufan-discover")}</p>
      <p><code>"col-$.series_id"</code> → 合集 id；分集 id <code>ep-{item_id}</code> 由适配器按目录构造。</p>
      <div class="note warn">所有 $ 片段都取不到值时整条规则视为未命中（避免产生 "drama-" 这类残缺 id）。</div>
      <p><b>字面量</b>：不含 $ 的字符串原样输出，用于固定值，如 <code>category: "短剧"</code>${tryBtn("短剧", "mufan-discover")}。</p>`
  },
  {
    title: "4 · fallback 数组",
    html: `
      <p>字段在响应里位置不定（如封面可能在 <code>cover</code> 或 <code>horiz_cover</code>），用数组依次尝试：</p>
      <p><code>["$.cover", "$.horiz_cover"]</code>${tryBtn('["$.cover","$.horiz_cover"]', "mufan-discover")}</p>
      <p>兔兔卡片 title 有顶层直出与 video_detail 两种结构，同样用 fallback 兼容：</p>
      <p><code>["$.title", "$.video_detail.series_title"]</code>${tryBtn('["$.title","$.video_detail.series_title"]', "tutu-discover")}</p>
      <div class="note">数组可嵌套；判定顺序 = 书写顺序，首个命中生效。</div>`
  },
  {
    title: "5 · mapping 字段速查",
    html: `
      <table class="rules">
        <tr><th>字段</th><th>作用</th><th>求值上下文</th></tr>
        <tr><td>items</td><td>元素列表定位（<b>必须数组</b>），发现页/搜索共用</td><td>响应（剥信封后）</td></tr>
        <tr><td>videoId</td><td>主队列卡 id，通常 <code>drama-$.series_id</code></td><td>单个元素</td></tr>
        <tr><td>title / poster</td><td>标题 / 封面</td><td>单个元素</td></tr>
        <tr><td>collectionId</td><td>所属合集，通常 <code>col-$.series_id</code></td><td>单个元素</td></tr>
        <tr><td>category</td><td>分类字面量（短剧/漫剧标签）</td><td>单个元素</td></tr>
        <tr><td>src</td><td>可选，取流响应中的播放地址</td><td>取流响应（信封剥离规则同上）</td></tr>
        <tr><td>itemId</td><td>可选，目录分集 id（缺省 <code>["$.item_id","$.itemId"]</code>，蛇形/驼峰通吃）</td><td>目录分集元素</td></tr>
        <tr><td>episodeTitle</td><td>可选，目录分集标题（缺省 <code>ep.title</code>，兜底按索引「第N集」）</td><td>目录分集元素</td></tr>
      </table>
      <p class="tag">items 之外的字段都相对「列表里的单个元素」求值；itemId / episodeTitle 相对「目录分集元素」求值。</p>`
  },
  {
    title: "6 · endpoints / params / 路径占位符",
    html: `
      <p><code>endpoints</code> 声明四个接口路径，<code>params</code> 声明固定参数（合并进请求）。两种风格：</p>
      <h4>query 式（沐凡）</h4>
      <pre class="code">"directory": "/api/directory"   <span class="c">// 参数走 query</span>
"video":     "/api/video"
params.video = { "type": "json", "proxy": 1 }   <span class="c">// item_id/book_id 自动追加为 query</span></pre>
      <h4>路径占位符式（兔兔）</h4>
      <pre class="code">"directory": "/api/v1/books/{book_id}/directory"
"video":     "/api/v1/videos/{item_id}"</pre>
      <p><code>{book_id}</code> / <code>{item_id}</code> 由适配器运行时替换进路径，<b>不再重复进 query</b>；无占位符时自动回落 query 语义（兼容沐凡）。搜索关键词用 <code>{keyword}</code> 占位：写在 <code>params.search</code> 值或端点路径里，查询字段名随接口自定义（如 <code>{"kw": "{keyword}"}</code>），未声明占位时回落传统 <code>key=</code>。</p>
      <p><code>collectionItemsPath</code> 定位目录响应中的分集数组：支持 <code>$</code> 规则——扁平目录如 <code>$.item_data_list</code>${tryBtn("$.item_data_list", "tutu-directory")}，分卷嵌套目录用 <code>[*]</code> 展平，如 <code>$.chapterListWithVolume[*]</code>${tryBtn("$.chapterListWithVolume[*]", "tutu1-directory")}；旧式点号路径（<code>item_data_list</code>）同样兼容。分集 id 由 <code>mapping.itemId</code> 规则提取，标题走 <code>mapping.episodeTitle</code>（见第 5 节速查）。</p>`
  },
  {
    title: "7 · mapping.src 取流规则",
    html: `
      <p>适配器点播时请求 <code>endpoints.video</code>，再用 <code>mapping.src</code> 从响应中提取可播地址；未配置时回落 <code>data.url ?? data.video_url</code>（沐凡式）。</p>
      <p>兔兔取流是双层信封（顶层无 data 键）+ 清晰度对象，规则：</p>
      <p><code>$.video_info.data.video_list[*].backup_url_1</code>${tryBtn("$.video_info.data.video_list[*].backup_url_1", "tutu-resolve")}</p>
      <div class="note"><code>main_url</code> 是空串（视为未命中），<code>backup_url_1</code> 是解密后的本地 mp4——<code>[*]</code> 通配跳过未命中档位、命中结果合并，适配器取首个。</div>`
  },
  {
    title: "8 · 完整源配置对照",
    html: `
      <h4>沐凡 · 短剧（query 式）</h4>
      <pre class="code">{
  <span class="k">"id"</span>: "mufan-short",  <span class="k">"label"</span>: "沐凡 · 短剧",
  <span class="k">"category"</span>: "short",  <span class="k">"mode"</span>: "declarative",
  <span class="k">"base"</span>: "",                    <span class="c">// 一律留空，地址运行时注入</span>
  <span class="k">"config"</span>: {
    <span class="k">"endpoints"</span>: { <span class="k">"discover"</span>: "/api/bookmall/cell/change", <span class="k">"search"</span>: "/api/search",
                   <span class="k">"directory"</span>: "/api/directory", <span class="k">"video"</span>: "/api/video" },
    <span class="k">"params"</span>: { <span class="k">"discover"</span>: { "genre_tab": 4, "algo_type": 101 },
                <span class="k">"search"</span>: { "tab_type": 11 }, <span class="k">"directory"</span>: {}, <span class="k">"video"</span>: { "type": "json", "proxy": 1 } },
    <span class="k">"mapping"</span>: {
      <span class="k">"items"</span>:        "$.book_info",
      <span class="k">"videoId"</span>:      "drama-$.series_id",
      <span class="k">"title"</span>:        "$.title",
      <span class="k">"poster"</span>:       ["$.cover", "$.horiz_cover"],
      <span class="k">"collectionId"</span>: "col-$.series_id",
      <span class="k">"category"</span>:     "短剧"
    },
    <span class="k">"collectionItemsPath"</span>: "item_data_list"
  }
}</pre>
      <h4>兔兔 · 短剧（路径占位符式）</h4>
      <pre class="code">{
  <span class="k">"id"</span>: "tutu-short",  <span class="k">"label"</span>: "兔兔 · 短剧",
  <span class="k">"category"</span>: "short", <span class="k">"mode"</span>: "declarative",
  <span class="k">"base"</span>: "",
  <span class="k">"config"</span>: {
    <span class="k">"endpoints"</span>: { <span class="k">"discover"</span>: "/api/v1/recommend/homepage",
                   <span class="k">"directory"</span>: "/api/v1/books/{book_id}/directory",
                   <span class="k">"video"</span>: "/api/v1/videos/{item_id}" },
    <span class="k">"params"</span>: { <span class="k">"discover"</span>: { "tab_type": 16, "offset": 0 }, <span class="k">"directory"</span>: {}, <span class="k">"video"</span>: {} },
    <span class="k">"mapping"</span>: {
      <span class="k">"items"</span>:        "$.tab_item[*].cell_data[0].cell_data[*].video_data",
      <span class="k">"videoId"</span>:      "drama-$.series_id",
      <span class="k">"title"</span>:        ["$.title", "$.video_detail.series_title"],
      <span class="k">"poster"</span>:       ["$.cover", "$.video_detail.series_cover"],
      <span class="k">"collectionId"</span>: "col-$.series_id",
      <span class="k">"category"</span>:     "短剧",
      <span class="k">"src"</span>:          "$.video_info.data.video_list[*].backup_url_1"
    },
    <span class="k">"collectionItemsPath"</span>: "item_data_list"
  }
}</pre>
      <h4>兔兔1 · 短剧（$ 规则目录 + 自定义搜索字段）</h4>
      <pre class="code">{
  <span class="k">"id"</span>: "tutu1-short",  <span class="k">"label"</span>: "兔兔1 · 短剧",
  <span class="k">"category"</span>: "short", <span class="k">"mode"</span>: "declarative",
  <span class="k">"base"</span>: "",
  <span class="k">"config"</span>: {
    <span class="k">"endpoints"</span>: { <span class="k">"discover"</span>: "/api/v1/recommend/homepage", <span class="k">"search"</span>: "/api/v1/search",
                   <span class="k">"directory"</span>: "/api/v1/books/{book_id}/toc", <span class="k">"video"</span>: "/api/v1/media/video" },
    <span class="k">"params"</span>: { <span class="k">"discover"</span>: { "tab_type": 16, "offset": 0, "filter": "none" },
                <span class="k">"search"</span>: { "kw": "{keyword}", "tab_type": 16 } },
    <span class="k">"mapping"</span>: {
      <span class="k">"items"</span>:        "$.tab_item[*].cell_data[0].cell_data[*].video_data",
      <span class="k">"videoId"</span>:      "drama-$.series_id",
      <span class="k">"title"</span>:        ["$.title", "$.video_detail.series_title"],
      <span class="k">"poster"</span>:       ["$.cover", "$.video_detail.series_cover"],
      <span class="k">"collectionId"</span>: "col-$.series_id",
      <span class="k">"category"</span>:     "短剧",
      <span class="k">"src"</span>:          "$.play.decrypt_url"
    },
    <span class="k">"collectionItemsPath"</span>: "$.chapterListWithVolume[*]"   <span class="c">// [*] 把分卷嵌套展平为扁平分集</span>
  }
}</pre>
      <div class="note">目录分集是驼峰 <code>itemId</code>——缺省规则 <code>["$.item_id","$.itemId"]</code> 直接命中，无需声明；蛇形目录同理。<code>search</code> 为示意：关键词经 <code>{keyword}</code> 占位注入 <code>kw</code> 字段，请求只带声明的参数、不再多带 <code>key=</code>。</div>
      <p class="tag">写好后用「源配置生成器」<b>保存到本机</b>（存 localStorage，刷新播放器即注入内存生效）或导出 JSON 放入 sources.d/（文件名排序 = 加载顺序，首个为默认源，适合分发）。</p>`
  }
];

// ============================================================
// 演练场
// ============================================================
function initPlayground() {
  const sampleSel = $("sampleSel");
  for (const [key, s] of Object.entries(SAMPLES)) {
    const opt = document.createElement("option");
    opt.value = key; opt.textContent = s.label;
    sampleSel.appendChild(opt);
  }

  const jsonArea = $("jsonArea"), ruleInput = $("ruleInput");
  const resultBox = $("resultBox"), ctxNote = $("ctxNote"), listChk = $("listChk");

  function loadSample(key) {
    if (!SAMPLES[key]) return;
    sampleSel.value = key;
    jsonArea.value = JSON.stringify(SAMPLES[key].json, null, 2);
    evaluate();
  }
  sampleSel.addEventListener("change", () => loadSample(sampleSel.value));
  $("fmtBtn").addEventListener("click", () => {
    try { jsonArea.value = JSON.stringify(JSON.parse(jsonArea.value), null, 2); evaluate(); }
    catch (e) { show("err", `JSON 格式错误：${e.message}`); }
  });
  ruleInput.addEventListener("input", evaluate);
  listChk.addEventListener("change", evaluate);
  $("runBtn").addEventListener("click", evaluate);

  function show(kind, text) {
    resultBox.className = kind === "ok" ? "ok" : kind === "err" ? "err" : "mini";
    resultBox.textContent = text;
  }

  function evaluate() {
    let resp;
    try { resp = JSON.parse(jsonArea.value); }
    catch (e) { return show("err", `响应 JSON 解析失败：${e.message}`); }

    const ctx = envelopeStrip(resp);
    const stripped = ctx !== resp;
    ctxNote.textContent = stripped
      ? "上下文 = 信封的 data 层（已自动剥离 {code,…} 外层）"
      : "上下文 = 完整响应（顶层无 data 键，未剥离）";

    let rule = ruleInput.value.trim();
    if (!rule) return show("", "输入规则后实时显示命中结果。");
    if (rule.startsWith("[")) {
      try { rule = JSON.parse(rule); }
      catch (e) { return show("err", `fallback 数组解析失败：${e.message}（应为合法 JSON 数组，如 ["$.cover","$.horiz_cover"]）`); }
    }

    let v;
    if (listChk.checked) {
      v = resolveList(ctx, rule);
      if (v === null) return show("err", "未命中列表：mapping.items 的求值结果必须是数组（检查是否多了/少了信封层级、[*] 通配是否遗漏）。");
      return show("ok",
        `✓ items 命中数组，长度 ${v.length}\n\n` +
        v.slice(0, 3).map((el, i) => `[${i}] ${JSON.stringify(el, null, 2)}`).join("\n---\n") +
        (v.length > 3 ? `\n… 共 ${v.length} 条` : ""));
    }

    try { v = resolveRule(ctx, rule); }
    catch (e) { return show("err", `求值异常：${e.message}`); }
    if (v === undefined) return show("err", "✗ 未命中（undefined / null / 空字符串均视为未命中）");
    const type = Array.isArray(v) ? `array(${v.length})` : typeof v;
    show("ok", `✓ 命中 [${type}]\n\n${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v, null, 2)}`);
  }

  // 教程「试 →」按钮：委托（切到演练场 tab 求值）
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button.try");
    if (!btn) return;
    if (btn.dataset.sample) loadSample(btn.dataset.sample);
    ruleInput.value = btn.dataset.rule;
    evaluate();
    switchTab("tabPlay");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // 常用规则 chips
  const CHIPS = [
    ["$.book_info", "mufan-discover"],
    ["$.tab_item[*].cell_data[0].cell_data[*].video_data", "tutu-discover"],
    ["drama-$.series_id", "mufan-discover"],
    ["col-$.series_id", "mufan-discover"],
    ['["$.cover","$.horiz_cover"]', "mufan-discover"],
    ["$.item_data_list", "tutu-directory"],
    ["$.video_info.data.video_list[*].backup_url_1", "tutu-resolve"],
    ["短剧", "mufan-discover"],
  ];
  const chips = $("chips");
  for (const [rule, sample] of CHIPS) {
    const b = document.createElement("button");
    b.textContent = rule;
    b.addEventListener("click", () => { loadSample(sample); ruleInput.value = rule; evaluate(); });
    chips.appendChild(b);
  }

  loadSample("mufan-discover");
  ruleInput.value = "$.book_info";
  evaluate();
}

// ============================================================
// 源配置生成器（导出 sources.d JSON）
// ============================================================
function initGenerator() {
  let fields = null; // 表单引用在 DOM 注入后绑定（见 _bindForm）

  // 规则输入框值 → JSON 值：[ 开头按 fallback 数组解析，其余为字符串
  function ruleVal(input, optional) {
    const s = input.value.trim();
    if (!s) return optional ? undefined : "";
    if (s.startsWith("[")) { try { return JSON.parse(s); } catch { return s; } }
    return s;
  }
  function paramsVal(input) {
    const s = input.value.trim();
    if (!s) return {};
    try { return JSON.parse(s); } catch { return { __invalid: s }; }
  }

  function build() {
    const mapping = {};
    if (fields.mItems.value.trim()) mapping.items = ruleVal(fields.mItems);
    if (fields.mVideoId.value.trim()) mapping.videoId = ruleVal(fields.mVideoId);
    if (fields.mTitle.value.trim()) mapping.title = ruleVal(fields.mTitle, true);
    if (fields.mPoster.value.trim()) mapping.poster = ruleVal(fields.mPoster, true);
    if (fields.mCollectionId.value.trim()) mapping.collectionId = ruleVal(fields.mCollectionId);
    if (fields.mCategory.value.trim()) mapping.category = ruleVal(fields.mCategory);
    const src = ruleVal(fields.mSrc, true);
    if (src !== undefined) mapping.src = src;

    const endpoints = {};
    for (const [key, el] of [["discover", fields.epDiscover], ["search", fields.epSearch],
                             ["directory", fields.epDirectory], ["video", fields.epVideo]]) {
      if (el.value.trim()) endpoints[key] = el.value.trim();
    }
    const params = {};
    for (const [key, el] of [["discover", fields.pDiscover], ["search", fields.pSearch],
                             ["directory", fields.pDirectory], ["video", fields.pVideo]]) {
      const v = paramsVal(el);
      if (Object.keys(v).length) params[key] = v;
    }

    const cfg = {
      id: fields.id.value.trim() || "my-source",
      label: fields.label.value.trim() || "我的源",
      category: fields.category.value,
      mode: "declarative",
      base: fields.base.value.trim().replace(/\/+$/, ""),
      config: { endpoints, params, mapping },
    };
    if (fields.collPath.value.trim()) cfg.config.collectionItemsPath = fields.collPath.value.trim();
    return cfg;
  }

  let lastJson = "";
  function refresh() {
    const cfg = build();
    lastJson = JSON.stringify(cfg, null, 2) + "\n";
    preview.innerHTML = lastJson
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
      .replace(/: "(.*?)"/g, ': <span class="s">"$1"</span>');
  }
  function loadTemplate(kind) {
    const T = {
      mufan: {
        id: "mufan-short", label: "沐凡 · 短剧", category: "short", fileName: "01-mufan-short.example.json", base: "",
        epDiscover: "/api/bookmall/cell/change", epSearch: "/api/search", epDirectory: "/api/directory", epVideo: "/api/video",
        pDiscover: '{ "genre_tab": 4, "algo_type": 101 }', pSearch: '{ "tab_type": 11 }', pDirectory: "", pVideo: '{ "type": "json", "proxy": 1 }',
        mItems: "$.book_info", mVideoId: "drama-$.series_id", mTitle: "$.title",
        mPoster: '["$.cover","$.horiz_cover"]', mCollectionId: "col-$.series_id", mCategory: "短剧", mSrc: "",
        collPath: "item_data_list",
      },
      tutu: {
        id: "tutu-short", label: "兔兔 · 短剧", category: "short", fileName: "03-tutu-short.json", base: "",
        epDiscover: "/api/v1/recommend/homepage", epSearch: "", epDirectory: "/api/v1/books/{book_id}/directory", epVideo: "/api/v1/videos/{item_id}",
        pDiscover: '{ "tab_type": 16, "offset": 0 }', pSearch: "", pDirectory: "", pVideo: "",
        mItems: "$.tab_item[*].cell_data[0].cell_data[*].video_data", mVideoId: "drama-$.series_id",
        mTitle: '["$.title","$.video_detail.series_title"]', mPoster: '["$.cover","$.video_detail.series_cover"]',
        mCollectionId: "col-$.series_id", mCategory: "短剧", mSrc: "$.video_info.data.video_list[*].backup_url_1",
        collPath: "item_data_list",
      },
    }[kind];
    for (const [k, v] of Object.entries(T)) if (fields[k]) fields[k].value = v;
    refresh();
  }

  // 表单 DOM 注入
  $("genContent").innerHTML = `
    <div class="note">填写后实时预览。<b>「保存到本机」</b>存入 localStorage（<code>player.custom.sources.v1</code>），刷新播放器页面即注入内存直接可用，<b>无需落 <code>sources.d/</code>、无需重启 server</b>——base 可直接填写上游地址（只存本机、不进仓库）；「下载 JSON」则导出文件放入 <code>sources.d/</code> 目录供分发（文件名建议 <code>NN-id.json</code> 序号前缀控制加载顺序，首个为默认源），<b>分发版 base 请留空</b>（上游地址不进仓库，运行时由前端源地址栏注入）。</div>
    <div class="chips" style="margin:10px 0">
      <button id="g_loadMufan">载入沐凡模板</button>
      <button id="g_loadTutu">载入兔兔模板</button>
    </div>
    <div class="form-grid">
      <label>源 id（registry 标识）<input id="g_id" class="fi" placeholder="my-source"/></label>
      <label>显示名（下拉框 label）<input id="g_label" class="fi" placeholder="我的源"/></label>
      <label>分类 category
        <select id="g_category" class="fi"><option value="short">short（短剧）</option><option value="manju">manju（漫剧）</option></select></label>
      <label>base 上游地址（可空）<input id="g_base" class="fi" placeholder="https://…（留空 = 同源根路径）"/></label>
      <label>导出文件名<input id="g_file" class="fi" placeholder="03-my-source.json"/></label>
      <label>discover 端点<input id="g_ep_discover" class="fi" placeholder="/api/..."/></label>
      <label>search 端点（可空）<input id="g_ep_search" class="fi" placeholder="/api/search 或 /api/v1/search/{keyword}"/></label>
      <label>directory 端点<input id="g_ep_directory" class="fi" placeholder="/api/directory 或 /api/v1/books/{book_id}/directory"/></label>
      <label>video 端点<input id="g_ep_video" class="fi" placeholder="/api/video 或 /api/v1/videos/{item_id}"/></label>
      <label>params.discover（JSON）<textarea id="g_p_discover" class="fi" placeholder='{}'></textarea></label>
      <label>params.search（JSON，可空）<textarea id="g_p_search" class="fi" placeholder='{ "kw": "{keyword}", "tab_type": 11 }'></textarea></label>
      <label>params.directory（JSON）<textarea id="g_p_directory" class="fi"></textarea></label>
      <label>params.video（JSON）<textarea id="g_p_video" class="fi"></textarea></label>
      <label class="full">mapping.items（列表定位，必须数组）<input id="g_m_items" class="fi" placeholder="$.data.dataList"/></label>
      <label>mapping.videoId<input id="g_m_videoId" class="fi" value="drama-$.series_id"/></label>
      <label>mapping.collectionId<input id="g_m_collectionId" class="fi" value="col-$.series_id"/></label>
      <label>mapping.title（可 fallback）<input id="g_m_title" class="fi" placeholder="$.title"/></label>
      <label>mapping.poster（可 fallback）<input id="g_m_poster" class="fi" placeholder='["$.cover","$.horiz_cover"]'/></label>
      <label>mapping.category（字面量）<input id="g_m_category" class="fi" placeholder="短剧"/></label>
      <label>mapping.src（取流规则，可空）<input id="g_m_src" class="fi" placeholder="$.video_info.data.video_list[*].backup_url_1"/></label>
      <label>collectionItemsPath（目录分集数组，$ 规则或点号路径）<input id="g_collPath" class="fi" placeholder="item_data_list 或 $.chapterListWithVolume[*]"/></label>
    </div>
    <div id="genPreviewWrap">
      <div class="ph"><span>sources.d/ 预览</span>
        <span><button id="g_paste" class="btn" style="padding:2px 10px;font-size:12px">粘贴</button>
        <button id="g_copy" class="btn" style="padding:2px 10px;font-size:12px">复制</button>
        <button id="g_save" class="btn primary" style="padding:2px 10px;font-size:12px">保存到本机</button>
        <button id="g_download" class="btn" style="padding:2px 10px;font-size:12px">下载 JSON</button></span></div>
      <pre id="genPreview" class="code"></pre>
    </div>
    <div class="chips" id="g_local" style="margin-top:8px"></div>`;
  // 表单引用绑定（innerHTML 注入后 DOM 已就绪）
  const F = (id) => $(id);
  const preview = $("genPreview");
  fields = {
    id: F("g_id"), label: F("g_label"), category: F("g_category"), base: F("g_base"), fileName: F("g_file"),
    epDiscover: F("g_ep_discover"), epSearch: F("g_ep_search"), epDirectory: F("g_ep_directory"), epVideo: F("g_ep_video"),
    pDiscover: F("g_p_discover"), pSearch: F("g_p_search"), pDirectory: F("g_p_directory"), pVideo: F("g_p_video"),
    mItems: F("g_m_items"), mVideoId: F("g_m_videoId"), mTitle: F("g_m_title"), mPoster: F("g_m_poster"),
    mCollectionId: F("g_m_collectionId"), mCategory: F("g_m_category"), mSrc: F("g_m_src"), collPath: F("g_collPath"),
  };
  for (const el of Object.values(fields)) el.addEventListener("input", refresh);
  $("g_copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lastJson); $("g_copy").textContent = "已复制 ✓"; setTimeout(() => ($("g_copy").textContent = "复制"), 1200); }
    catch { $("g_copy").textContent = "复制失败"; setTimeout(() => ($("g_copy").textContent = "复制"), 1200); }
  });
  // —— 粘贴：读剪贴板源配置 JSON，反向回填表单（便于基于现有源改动） ——
  $("g_paste").addEventListener("click", async () => {
    if (!navigator.clipboard?.readText) {
      alert("当前环境不支持剪贴板读取（页面须为 https / localhost）");
      return;
    }
    let text;
    try { text = await navigator.clipboard.readText(); }
    catch { alert("剪贴板读取被拒绝：请授权剪贴板权限后重试"); return; }
    let cfg;
    try { cfg = JSON.parse(text); }
    catch (e) { alert(`剪贴板内容不是合法 JSON：${e.message}`); return; }
    const ruleStr = (v) => v == null ? "" : (typeof v === "string" ? v : JSON.stringify(v));
    const paramsStr = (v) => (v && typeof v === "object" && Object.keys(v).length) ? JSON.stringify(v, null, 2) : "";
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || !cfg.id || !cfg.config) {
      alert("不是源配置 JSON：缺少 id 或 config 字段（应为生成器导出的 sources.d 源定义）");
      return;
    }
    const c = cfg.config, ep = c.endpoints || {}, pp = c.params || {}, m = c.mapping || {};
    fields.id.value = String(cfg.id);
    fields.label.value = String(cfg.label || "");
    fields.category.value = cfg.category === "manju" ? "manju" : "short";
    fields.base.value = String(cfg.base || "");
    fields.epDiscover.value = String(ep.discover || "");
    fields.epSearch.value = String(ep.search || "");
    fields.epDirectory.value = String(ep.directory || "");
    fields.epVideo.value = String(ep.video || "");
    fields.pDiscover.value = paramsStr(pp.discover);
    fields.pSearch.value = paramsStr(pp.search);
    fields.pDirectory.value = paramsStr(pp.directory);
    fields.pVideo.value = paramsStr(pp.video);
    fields.mItems.value = ruleStr(m.items);
    fields.mVideoId.value = ruleStr(m.videoId);
    fields.mTitle.value = ruleStr(m.title);
    fields.mPoster.value = ruleStr(m.poster);
    fields.mCollectionId.value = ruleStr(m.collectionId);
    fields.mCategory.value = ruleStr(m.category);
    fields.mSrc.value = ruleStr(m.src);
    fields.collPath.value = String(c.collectionItemsPath || "");
    refresh();
    $("g_paste").textContent = "已回填 ✓";
    setTimeout(() => ($("g_paste").textContent = "粘贴"), 1200);
  });
  $("g_download").addEventListener("click", () => {
    const name = (fields.fileName.value.trim() || `${build().id}.json`).replace(/\.json$/, "") + ".json";
    const blob = new Blob([lastJson], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  });
  // —— 保存到本机（localStorage 注入运行时）：按 id upsert，删除后刷新即回退 ——
  function renderLocal() {
    const list = listCustomSources();
    $("g_local").innerHTML = list.length
      ? `<span class="mini">本机源（刷新播放器生效）：</span>` + list.map((s) =>
          `<button data-del="${s.id}" title="删除本机源 ${s.id}">${s.id} · ${s.label || ""} ✕</button>`).join("")
      : `<span class="mini">本机暂无自定义源 —— 「保存到本机」后刷新播放器即可直接使用（无需放 sources.d/）</span>`;
  }
  $("g_save").addEventListener("click", () => {
    saveCustomSource(build());
    renderLocal();
    $("g_save").textContent = "已存本机 ✓";
    setTimeout(() => ($("g_save").textContent = "保存到本机"), 1200);
  });
  $("g_local").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-del]");
    if (!b) return;
    removeCustomSource(b.dataset.del);
    renderLocal();
  });
  renderLocal();
  $("g_loadTutu").addEventListener("click", () => loadTemplate("tutu"));
  $("g_loadMufan").addEventListener("click", () => loadTemplate("mufan"));
  loadTemplate("mufan");
}

// ============================================================
// 源调试器（实发请求 + 映射求值 + 适配器实跑 + 改规则重求值）
// ============================================================
function initDebugger() {
  let cfgSources = []; // config.json 下发的源定义（registry 同 id 对应的声明）
  let lastResp = null; // 最近一次成功探测：{ sourceId, kind, raw, data, url, status, ms }
  const logs = [];     // 请求日志（最多 20 条，新事件在前）

  $("dbgContent").innerHTML = `
    <div class="note">对已注册源<b>实发请求</b>，同时展示原始响应与映射求值结果。请求拼装与线上完全一致
    （<code>{item_id}/{book_id}/{keyword}</code> 占位、<code>?proxy_upstream=</code> 同源代理），但求值
    <b>只读、不写适配器缓存、不影响播放器</b>。连接设置与播放器共用同一份偏好（localStorage）。</div>
    <div class="form-grid">
      <label>视频源<select id="d_src" class="fi"></select></label>
      <label>base 上游地址（留空 = 源定义 base / 同源根路径）<input id="d_base" class="fi" placeholder="https://…"/></label>
      <label>连接<span class="opts" style="margin:0">
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="d_proxy"/> 启用代理</label>
        <button id="d_save" class="btn primary" style="padding:4px 12px;font-size:12px">保存连接</button></span></label>
    </div>
    <div class="mini" id="d_conn"></div>
    <div class="mini" id="d_srcinfo" style="margin:4px 0"></div>
    <div class="chips" style="margin:8px 0">
      <button id="d_reload" title="重建本页注册表（config.json + 本机自定义源）">↻ 重载源列表</button>
    </div>

    <div class="rule-row" style="margin:14px 0 6px">
      <label>动作</label>
      <select id="d_act" class="fi" style="flex:none;width:auto">
        <option value="discover">发现流 discover</option>
        <option value="search">搜索 search</option>
        <option value="directory">合集目录 directory</option>
        <option value="video">取流 video</option>
      </select>
      <button id="d_run" class="btn primary">发送并求值</button>
      <button id="d_e2e" class="btn" title="直调适配器公共方法（listMainQueue / listCollection / search / resolveSrc），含缓存与去重语义，结果会写缓存">适配器实跑</button>
    </div>
    <div class="form-grid" id="d_ctx">
      <label data-act="search">关键词（{keyword} 占位注入）<input id="d_kw" class="fi" placeholder="如 闪婚"/></label>
      <label data-act="directory">collectionId / book_id<input id="d_book" class="fi" placeholder="col-123 或 123（自动剥 col- 前缀）"/></label>
      <label data-act="video">item_id / 分集 videoId<input id="d_item" class="fi" placeholder="ep-456 或 456"/></label>
      <label data-act="video">book_id（可选，端点含 {book_id} 占位或 query 需要时填）<input id="d_vbook" class="fi" placeholder="col-123 或 123"/></label>
    </div>

    <div id="d_req" class="mini" style="font-family:var(--mono);word-break:break-all;margin:8px 0">尚未发送请求。</div>
    <div id="d_eval"></div>
    <div class="chips" style="margin:8px 0"><button id="d_toPlay">原始响应 → 演练场</button></div>
    <details class="chapter"><summary>原始响应（未剥信封）</summary>
      <div class="ch-body"><pre id="d_raw" class="code" style="max-height:320px;overflow:auto">（尚未发送请求）</pre></div>
    </details>
    <details class="chapter"><summary>改规则重求值（编辑 config 后对最近响应重算，不发请求）</summary>
      <div class="ch-body">
        <div class="mini" style="margin-bottom:6px">求值目标 = 最近一次探测的响应，适合反复调 mapping.items / collectionItemsPath / mapping.src 而不重复打上游。</div>
        <textarea id="d_cfg" class="fi" style="min-height:200px" spellcheck="false"></textarea>
        <button id="d_reeval" class="btn" style="margin-top:6px">用此配置重求值</button>
      </div>
    </details>
    <details class="chapter"><summary>源定义 JSON（config）</summary>
      <div class="ch-body"><pre id="d_def" class="code" style="max-height:320px;overflow:auto"></pre></div>
    </details>
    <div class="mini" style="margin:12px 0 4px">请求日志（最近 20 条，点击回看）：</div>
    <div class="chips" id="d_log"></div>`;

  const srcSel = $("d_src"), baseIn = $("d_base"), proxyChk = $("d_proxy");
  const actSel = $("d_act"), kwIn = $("d_kw"), bookIn = $("d_book"), itemIn = $("d_item"), vbookIn = $("d_vbook");
  const reqBox = $("d_req"), evalBox = $("d_eval"), rawPre = $("d_raw"), connNote = $("d_conn"), srcInfo = $("d_srcinfo");

  const ACT_LABELS = { discover: "发现流 discover", search: "搜索 search", directory: "合集目录 directory", video: "取流 video" };
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 本机自定义源同 id 覆盖 config 源，查找顺序与 initSources 注册顺序一致
  const findDef = (id) => listCustomSources().find((s) => s.id === id) || cfgSources.find((s) => s.id === id) || null;

  function populate() {
    const customIds = new Set(listCustomSources().map((s) => s.id));
    srcSel.innerHTML = "";
    registry.list().forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.label || s.id} · ${s.id}${customIds.has(s.id) ? " · 本机" : ""}${i === 0 ? " · 默认" : ""}`;
      srcSel.appendChild(opt);
    });
  }

  function syncConn() {
    const id = srcSel.value, a = registry.get(id);
    if (!a) return;
    baseIn.value = getBaseUrl(id) || "";
    proxyChk.checked = getProxy(id);
    connNote.innerHTML = `生效基址 <code>${esc(a.baseUrl || "（同源根路径）")}</code>` +
      (a.proxyUpstream ? ` · 代理转发 → <code>${esc(a.proxyUpstream)}</code>` : " · 直连");
  }

  function syncActions() {
    const eps = findDef(srcSel.value)?.config?.endpoints || {};
    srcInfo.textContent = "端点：" + Object.keys(ACT_LABELS).map((k) => `${k}${eps[k] ? "✓" : "✗"}`).join("　");
    for (const opt of actSel.options) {
      opt.disabled = !eps[opt.value];
      opt.textContent = ACT_LABELS[opt.value] + (opt.disabled ? "（端点未声明）" : "");
    }
    if (actSel.selectedOptions[0]?.disabled) actSel.value = "discover";
    syncCtx();
  }

  function syncCtx() {
    for (const lab of $("d_ctx").querySelectorAll("label[data-act]")) {
      lab.style.display = lab.dataset.act === actSel.value ? "" : "none";
    }
  }

  function syncDef() {
    const json = JSON.stringify(findDef(srcSel.value)?.config ?? {}, null, 2);
    $("d_def").textContent = json;
    $("d_cfg").value = json;
  }

  function onSourceChange() { syncConn(); syncActions(); syncDef(); }

  async function boot() {
    try {
      const cfg = await loadConfig();
      cfgSources = cfg?.sources || [];
      await initSources(cfg); // 本页独立注册表；本机自定义源自动并入
    } catch (e) {
      connNote.innerHTML = `<span style="color:var(--err)">源注册表初始化失败：${esc(e.message)}</span>`;
    }
    populate();
    if (srcSel.value) onSourceChange();
  }

  // —— 探测请求 ——
  function probeCtx(kind) {
    const ctx = {};
    if (kind === "search") ctx.keyword = kwIn.value;
    if (kind === "directory") ctx.book_id = bookIn.value;
    if (kind === "video") { ctx.item_id = itemIn.value; if (vbookIn.value.trim()) ctx.book_id = vbookIn.value; }
    return ctx;
  }

  async function runProbe() {
    const id = srcSel.value, a = registry.get(id);
    if (!a) return;
    const kind = actSel.value;
    const btn = $("d_run");
    btn.disabled = true; btn.textContent = "请求中…";
    let r;
    try { r = await a.debugProbe(kind, probeCtx(kind)); }
    finally { btn.disabled = false; btn.textContent = "发送并求值"; }
    pushLog(id, kind, r);
    renderResp(id, kind, a, r, "实发请求");
  }

  function renderResp(id, kind, a, r, tagline) {
    lastResp = r.ok ? { sourceId: id, kind, raw: r.raw, data: envelopeStrip(r.raw), url: r.url, status: r.status, ms: r.ms } : null;
    reqBox.innerHTML = r.ok
      ? `<span style="color:var(--ok)">✓ ${r.status}</span> · ${r.ms}ms · ${esc(tagline)}<br>${esc(r.url)}`
      : `<span style="color:var(--err)">✗ ${esc(r.error || "请求失败")}</span>${r.status && !String(r.error).includes("http-") ? ` · http-${r.status}` : ""}${r.ms != null ? ` · ${r.ms}ms` : ""}<br>${esc(r.url || "")}`;
    rawPre.textContent = r.ok ? JSON.stringify(r.raw, null, 2) : `（请求失败：${r.error}）`;
    if (!r.ok) { evalBox.innerHTML = ""; return; }
    renderEval(kind, a.debugEvaluate(kind, envelopeStrip(r.raw)), "");
  }

  function renderEval(kind, res, note) {
    const noteHtml = note ? `<div class="mini" style="margin:4px 0">${esc(note)}</div>` : "";
    if (res.error) { evalBox.innerHTML = noteHtml + `<div style="color:var(--err)">${esc(res.error)}</div>`; return; }

    if (kind === "discover" || kind === "search") {
      if (!res.listHit) {
        evalBox.innerHTML = noteHtml + `<div style="color:var(--err)">✗ mapping.items 未命中数组（检查信封层级与 [*] 通配，可点「原始响应 → 演练场」逐条调规则）</div>`;
        return;
      }
      const FIELDS = ["videoId", "title", "poster", "collectionId", "category"];
      const miss = Object.fromEntries(FIELDS.map((f) => [f, 0]));
      for (const it of res.items) for (const f of FIELDS) {
        const v = it.fields[f];
        if (v == null || v === "") miss[f]++;
      }
      const rows = res.items.slice(0, 20).map((it, i) =>
        `<tr><td>${i}</td>` + FIELDS.map((f) => {
          const s = it.fields[f] == null ? "" : String(it.fields[f]);
          return `<td${s ? "" : ' class="miss"'} title="${esc(s)}">${esc(s) || "—"}</td>`;
        }).join("") + "</tr>").join("");
      const missLine = FIELDS.filter((f) => miss[f] > 0)
        .map((f) => `${f} ×${miss[f]}`).join(" · ");
      evalBox.innerHTML = noteHtml +
        `<div style="color:var(--ok)">✓ items 命中，共 ${res.count} 条</div>` +
        (missLine ? `<div class="mini">字段未命中：${esc(missLine)}</div>` : "") +
        (miss.videoId === res.count && res.count > 0
          ? `<div style="color:var(--err)">videoId 全部未命中：检查 videoId 规则（通常 drama-$.series_id）</div>` : "") +
        `<table class="dbg-table"><tr><th>#</th>${FIELDS.map((f) => `<th>${f}</th>`).join("")}</tr>${rows}</table>` +
        (res.count > 20 ? `<div class="mini">… 其余 ${res.count - 20} 条略</div>` : "");
      return;
    }

    if (kind === "directory") {
      const rows = res.items.slice(0, 30).map((ep) =>
        `<tr><td>${ep.index}</td><td${ep.itemId ? "" : ' class="miss"'}>${esc(ep.itemId) || "—"}</td><td>${esc(ep.title)}</td></tr>`).join("");
      evalBox.innerHTML = noteHtml +
        (res.count > 0
          ? `<div style="color:var(--ok)">✓ collectionItemsPath 命中，共 ${res.count} 集</div>` +
            `<table class="dbg-table"><tr><th>#</th><th>itemId</th><th>标题</th></tr>${rows}</table>` +
            (res.count > 30 ? `<div class="mini">… 其余 ${res.count - 30} 集略</div>` : "")
          : `<div style="color:var(--err)">✗ 目录为空：检查 collectionItemsPath（$ 规则 / 点号路径）与响应结构</div>`);
      return;
    }

    if (kind === "video") {
      evalBox.innerHTML = noteHtml +
        (res.src
          ? `<div style="color:var(--ok)">✓ src 命中</div>
             <div style="font-family:var(--mono);font-size:12px;word-break:break-all">${esc(res.proxied || res.src)}</div>` +
            (res.proxied && res.proxied !== res.src ? `<div class="mini">已代理改写（原地址：${esc(res.src)}）</div>` : "")
          : `<div style="color:var(--err)">✗ 未取到播放地址：检查 mapping.src 规则（或缺省回落 data.url / data.video_url）</div>`);
      return;
    }
    evalBox.innerHTML = noteHtml;
  }

  // —— 适配器实跑（端到端，含缓存/去重/id 前缀语义；会写适配器缓存）——
  function itemsTable(items, label) {
    const head = label ? `<div class="mini">${esc(label)} → ${items.length} 条</div>` : "";
    const rows = items.slice(0, 10).map((it, i) =>
      `<tr><td>${i}</td><td>${esc(it.videoId)}</td><td>${esc(it.title)}</td><td>${esc(it.collectionId || "")}</td></tr>`).join("");
    return head + `<table class="dbg-table"><tr><th>#</th><th>videoId</th><th>title</th><th>collectionId</th></tr>${rows}</table>` +
      (items.length > 10 ? `<div class="mini">… 其余 ${items.length - 10} 条略</div>` : "");
  }

  async function runE2E() {
    const id = srcSel.value, a = registry.get(id);
    if (!a) return;
    const kind = actSel.value;
    const btn = $("d_e2e");
    btn.disabled = true; btn.textContent = "运行中…";
    let html = "";
    try {
      if (kind === "discover") {
        html = itemsTable(await a.listMainQueue(), "listMainQueue()");
      } else if (kind === "search") {
        const kw = kwIn.value.trim();
        const items = await a.search(kw);
        html = itemsTable(items, `search("${kw}")`) +
          `<div class="mini">search 内部吞错（失败返回 []），原因见控制台 console.warn。</div>`;
      } else if (kind === "directory") {
        const r = await a.listCollection(bookIn.value.trim());
        html = `<div style="color:var(--ok)">✓ 「${esc(r.title)}」 ${r.items.length} 集（startPointer=${r.startPointer}）</div>` +
          itemsTable(r.items.slice(0, 10), null);
      } else if (kind === "video") {
        const vid = itemIn.value.trim();
        const url = await a.resolveSrc(vid);
        html = url
          ? `<div style="color:var(--ok)">✓ resolveSrc("${esc(vid)}")</div>
             <div style="font-family:var(--mono);font-size:12px;word-break:break-all">${esc(url)}</div>`
          : `<div style="color:var(--err)">✗ resolveSrc("${esc(vid)}") → null（原因见控制台 console.warn）</div>`;
      }
    } catch (e) {
      html = `<div style="color:var(--err)">✗ ${esc(e.message)}</div>`;
    } finally { btn.disabled = false; btn.textContent = "适配器实跑"; }
    evalBox.innerHTML = html;
  }

  // —— 请求日志 ——
  function pushLog(id, kind, r) {
    logs.unshift({ time: new Date().toLocaleTimeString(), id, kind, ok: !!r.ok,
                   status: r.status ?? 0, ms: r.ms, url: r.url || "", raw: r.raw ?? null, error: r.error || "" });
    if (logs.length > 20) logs.pop();
    renderLog();
  }

  function renderLog() {
    const logBox = $("d_log");
    logBox.innerHTML = "";
    logs.forEach((e) => {
      const KIND = { discover: "发现", search: "搜索", directory: "目录", video: "取流" };
      const b = document.createElement("button");
      b.textContent = `${e.time} ${KIND[e.kind]} ${e.ok ? e.status : "ERR"} ${e.ms ?? "?"}ms`;
      if (!e.ok) b.style.color = "var(--err)";
      b.title = e.url || e.error;
      b.addEventListener("click", () => {
        const a = registry.get(e.id);
        const r = e.ok ? { ok: true, status: e.status, ms: e.ms, url: e.url, raw: e.raw }
                       : { ok: false, status: e.status, ms: e.ms, url: e.url, error: e.error };
        if (a) renderResp(e.id, e.kind, a, r, `日志回放 ${e.time}`);
      });
      logBox.appendChild(b);
    });
  }

  // —— 事件 ——
  srcSel.addEventListener("change", onSourceChange);
  actSel.addEventListener("change", syncCtx);
  $("d_reload").addEventListener("click", boot);
  $("d_save").addEventListener("click", () => {
    setSourceBase(srcSel.value, baseIn.value, proxyChk.checked); // 持久化 + 立即应用（与播放器共用偏好）
    syncConn();
    $("d_save").textContent = "已保存 ✓";
    setTimeout(() => ($("d_save").textContent = "保存连接"), 1200);
  });
  $("d_run").addEventListener("click", runProbe);
  $("d_e2e").addEventListener("click", runE2E);
  $("d_toPlay").addEventListener("click", () => {
    if (!lastResp) { alert("尚无原始响应：请先「发送并求值」一次"); return; }
    $("jsonArea").value = JSON.stringify(lastResp.raw, null, 2);
    switchTab("tabPlay");
    window.scrollTo({ top: 0, behavior: "smooth" });
    $("runBtn").click();
  });
  $("d_reeval").addEventListener("click", () => {
    if (!lastResp) { alert("尚无响应：请先「发送并求值」一次"); return; }
    let cfgObj;
    try { cfgObj = JSON.parse($("d_cfg").value); }
    catch (e) { alert(`config JSON 解析失败：${e.message}`); return; }
    if (!cfgObj || typeof cfgObj !== "object" || Array.isArray(cfgObj)) { alert("config 应为对象（源定义的 config 字段）"); return; }
    const a = registry.get(lastResp.sourceId);
    const scratch = new DeclarativeSource({
      id: lastResp.sourceId,
      baseUrl: a ? a.baseUrl : "",
      proxyUpstream: a ? a.proxyUpstream : null,
      config: cfgObj,
    });
    renderEval(lastResp.kind, scratch.debugEvaluate(lastResp.kind, lastResp.data),
      "scratch 配置求值（未发请求，仅对最近响应重算）");
  });

  syncCtx();
  boot();
}

// ============================================================
// Tab 切换 + 教程渲染
// ============================================================
function init() {
  const doc = $("docContent");
  doc.innerHTML = CHAPTERS.map((c, i) => `
    <details class="chapter" ${c.open ? "open" : ""}>
      <summary>${c.title}</summary>
      <div class="ch-body">${c.html}</div>
    </details>`).join("");

  for (const [tab] of TABS) $(tab).addEventListener("click", () => switchTab(tab));

  initPlayground();
  initGenerator();
  initDebugger();
}

init();
