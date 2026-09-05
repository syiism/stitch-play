// ruleParser.js · 声明式源规则解析器
//
// 目标：给 declarativeSource（声明式通用模板）提供一套统一、可预测的字段定位规则，
// 取代旧「候选字段名数组 + 多层兜底 + transform 前缀 + _category hack」机制。
// 解析器是纯函数：输入上下文对象 + 规则，输出求值结果，无 IO、无依赖。
//
// 规则语法（config.json 的 config.mapping 中，每个 schema 字段值为一条规则）：
//
//   1) JSON 路径（"$" 开头）："$" 表示上下文根，".key" 取属性，"[n]" 取数组下标；
//      "[*]" 为通配：对数组每个元素 / 对象每个值继续求值剩余路径，命中结果合并为数组
//      （数组结果展平一层、未命中元素跳过）。常用于定位多层嵌套列表或键名动态的映射，
//      如 "$.data.tab_item[*].cell_data[0].cell_data[*].video_data"、
//         "$.video_list[*].backup_url_1"（video_list 的键是清晰度档位名）。
//      整串为合法路径时返回原始类型值（数字/布尔不会被转成字符串）。
//         "$.data.dataList"      → 上下文根下的 data.dataList
//         "$.play.decrypt_url"   → 深层嵌套字段
//         "$.list[0].title"      → 数组下标
//         "$"                    → 上下文本身
//
//   2) 模板插值（字符串中含 "$" 但整串非路径）：每个 "$路径" 片段被求值替换为字符串。
//      所有 $ 片段都取不到值时视为未命中（避免 "drama-" 这类残缺前缀被误当有效 id）。
//         "drama-$.series_id" → "drama-123"
//
//   3) 字面量（不含 "$" 的字符串）：原样作为字段值。
//         "短剧" → "短剧"（取代旧 _category_short 字面量 hack）
//
//   4) fallback 数组：依次按上述规则求值，取第一个命中结果；可嵌套。
//      命中判定：undefined / null / 空字符串视为未命中；数字 0、false 是合法命中值。
//         ["$.cover", "$.horiz_cover"]
//         ["drama-$.series_id_str", "drama-$.series_id"]
//
// 列表定位：mapping.items 规则作用于「发现页 + 搜索」响应（$ = 响应根），
// 求值结果必须是数组，用于取出元素列表；其余字段规则相对单个元素求值。
//   响应 {code:0, data:{dataList:[item1,item2,...]}} → 写 "items": "$.data.dataList"
//
// 示例 mapping：
// {
//   "items":        "$.data.dataList",
//   "videoId":      "drama-$.series_id",
//   "title":        "$.title",
//   "poster":       ["$.cover", "$.horiz_cover"],
//   "duration":     "$.duration",
//   "collectionId": ["col-$.series_id_str", "col-$.series_id"],
//   "itemId":       ["$.item_id", "$.itemId"],
//   "category":     "短剧"
// }

// 命中判定：undefined / null / 空字符串视为未命中（0 / false 合法）。
function _hit(v) {
  return v !== undefined && v !== null && v !== "";
}

// —— JSON 路径求值："$" 根 + ".key" 属性 + "[n]" 下标 + "[*]" 通配 ——
// 路径非法 / 中途缺失 → undefined；通配对数组元素续求、结果合并展平一层。
// （不提供过滤、多路径 union 等 JSONPath 扩展，保持精简。）
export function jsonPath(ctx, path) {
  const s = String(path ?? "");
  if (!s.startsWith("$")) return undefined;
  const tokens = [];
  let rest = s.slice(1);
  while (rest.length > 0) {
    // key 字符类排除 . [ ] $ —— $ 是模板片段起始符，防止 "$.a-$.b" 的 key 贪婪跨界
    let m = /^\.([\w\u4e00-\u9fa5]+)/.exec(rest);
    if (m) { tokens.push(m[1]); rest = rest.slice(m[0].length); continue; }
    m = /^\[(\d+|\*)\]/.exec(rest);
    if (m) { tokens.push(m[1] === "*" ? "*" : Number(m[1])); rest = rest.slice(m[0].length); continue; }
    return undefined;
  }
  return _get(ctx, tokens, 0);
}

// 逐 token 求值；"[*]" 对数组每个元素 / 对象每个值继续求值剩余 token，结果合并为数组
// （子结果若是数组则展平一层），未命中元素跳过。对象通配用于「键名动态」的映射结构，
// 如取流响应 video_list.video_5 按清晰度命名 → "$.video_list[*].backup_url_1"。
function _get(ctx, tokens, i) {
  if (ctx == null) return undefined;
  if (i >= tokens.length) return ctx;
  const t = tokens[i];
  if (t === "*") {
    const els = Array.isArray(ctx) ? ctx : (ctx && typeof ctx === "object" ? Object.values(ctx) : null);
    if (!els) return undefined;
    const out = [];
    for (const el of els) {
      const v = _get(el, tokens, i + 1);
      if (v === undefined) continue;
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    }
    return out;
  }
  return _get(ctx[t], tokens, i + 1);
}

// 整串是否为合法路径表达式（"$" 开头，其余全为 ".key" / "[n]" / "[*]" 序列）
function _isPathExpr(s) {
  if (!String(s).startsWith("$")) return false;
  let rest = String(s).slice(1);
  while (rest.length > 0) {
    const m = /^(\.[\w\u4e00-\u9fa5]+|\[\d+\]|\[\*\])/.exec(rest);
    if (!m) return false;
    rest = rest.slice(m[0].length);
  }
  return true;
}

// 模板中的 "$路径" 片段（$.key / [n] 可混排）
const _TPL_RE = /\$(?:\.[\w\u4e00-\u9fa5]+|\[\d+\])(?:\.[\w\u4e00-\u9fa5]+|\[\d+\])*/g;

// —— 模板插值："$路径" 片段替换为其值的字符串形式 ——
// 所有 $ 片段都未命中 → 返回 ""（交由 _hit 判定为未命中）。
function _interpolate(ctx, s) {
  let anyHit = false;
  const out = s.replace(_TPL_RE, (seg) => {
    const v = jsonPath(ctx, seg);
    if (_hit(v)) { anyHit = true; return String(v); }
    return "";
  });
  return anyHit ? out : "";
}

// —— 规则求值（核心入口）——
// rule：字符串（路径 / 模板 / 字面量）或 fallback 数组（可嵌套）。
export function resolveRule(ctx, rule) {
  if (rule == null) return undefined;
  if (Array.isArray(rule)) {
    for (const r of rule) {
      const v = resolveRule(ctx, r);
      if (_hit(v)) return v;
    }
    return undefined;
  }
  const s = String(rule);
  if (!s.includes("$")) return _hit(s) ? s : undefined; // 字面量
  const v = _isPathExpr(s) ? jsonPath(ctx, s) : _interpolate(ctx, s);
  return _hit(v) ? v : undefined; // 路径 / 模板：空结果 = 未命中
}

// —— 列表定位（mapping.items）：求值并要求数组结果，非数组返回 null ——
export function resolveList(ctx, rule) {
  if (!rule) return null;
  const v = resolveRule(ctx, rule);
  return Array.isArray(v) ? v : null;
}