// _sourceLib.mjs · 调试 CLI 共享库：sources.d/ 扫描与源参数解析
// 扫描语义与 tools/server.py _scan_sources_dir 保持一致：
// 文件名排序；真实文件覆盖同名 *.example.json 模板；要求根对象含有效 id。

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCES_DIR = join(ROOT, "sources.d");

/** 扫描 sources.d/ → [{ file, def }]（文件名排序，真实文件覆盖同名 example） */
export function scanSourcesDir() {
  let chosen = {};
  try {
    for (const fn of readdirSync(SOURCES_DIR).sort()) {
      if (!fn.endsWith(".json")) continue;
      const isExample = fn.endsWith(".example.json");
      const base = isExample ? fn.slice(0, -".example.json".length) : fn.slice(0, -".json".length);
      if (!(base in chosen) || !isExample) chosen[base] = join(SOURCES_DIR, fn);
    }
  } catch {
    return []; // 目录缺失
  }
  const out = [];
  for (const p of Object.values(chosen)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf-8"));
      if (s && typeof s === "object" && typeof s.id === "string" && s.id) out.push({ file: p, def: s });
    } catch { /* 解析失败的文件跳过，与 server 行为一致 */ }
  }
  return out;
}

/** 解析「源 id 或 JSON 文件路径」→ { file, def }；找不到时 process.exit(2) */
export function resolveSourceArg(arg, usage) {
  if (arg.includes("/") || arg.endsWith(".json")) {
    const file = resolve(arg);
    let def;
    try { def = JSON.parse(readFileSync(file, "utf-8")); }
    catch (e) { usage(`读取源定义 ${file} 失败：${e.message}`); }
    if (!def || typeof def !== "object" || typeof def.id !== "string" || !def.id) {
      usage(`源定义 ${file} 缺少有效 id 字段`);
    }
    return { file, def };
  }
  const hit = scanSourcesDir().find((s) => s.def.id === arg);
  if (!hit) usage(`未找到源「${arg}」：可先运行 list 查看可用源（或直接传源 JSON 文件路径）`);
  return hit;
}
