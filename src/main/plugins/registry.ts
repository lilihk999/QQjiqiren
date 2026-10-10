/** NoneBot 官方插件索引里与 OneBot v11 接入相关的字段 */
export interface NsbPlugin {
  module_name: string;
  project_link: string;
  name: string;
  desc: string;
  author: string;
  homepage: string;
  tags: Array<{ label: string; color: string }>;
  is_official: boolean;
  type: 'application' | 'library';
  /** null 表示插件未声明适配范围，按 NoneBot 索引约定视为"通用/全部适配器" */
  supported_adapters: string[] | null;
  /** 索引端的自动化兼容性测试结果，false 说明装上不一定能跑 */
  valid: boolean;
  version: string;
  time: string;
  skip_test: boolean;
}

export const ONEBOT_V11_ADAPTER = 'nonebot.adapters.onebot.v11';

/**
 * 数据源优先级说明：本环境实测 raw.githubusercontent.com 不可达，
 * 而 api.github.com 的 contents 接口带 raw Accept 头可以取到同样内容，
 * 因此把 API 通道放首位，其余作为公网正常环境的兜底。
 */
const REGISTRY_SOURCES: readonly string[] = [
  'https://api.github.com/repos/nonebot/registry/contents/plugins.json?ref=results',
  'https://raw.githubusercontent.com/nonebot/registry/results/plugins.json',
  'https://cdn.jsdelivr.net/gh/nonebot/registry@results/plugins.json',
];

export async function fetchRegistry(signal?: AbortSignal): Promise<NsbPlugin[]> {
  const errors: string[] = [];
  for (const url of REGISTRY_SOURCES) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.github.raw+json' },
        signal: signal ?? AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        errors.push(`${url} → ${String(res.status)}`);
        continue;
      }
      const data = (await res.json()) as NsbPlugin[];
      if (!Array.isArray(data) || data.length === 0) {
        errors.push(`${url} → 内容为空`);
        continue;
      }
      return data;
    } catch (err) {
      errors.push(`${url} → ${String(err)}`);
    }
  }
  throw new Error(`插件索引全部源失败：\n${errors.join('\n')}`);
}

export function isOneBotV11Compatible(plugin: NsbPlugin): boolean {
  if (plugin.supported_adapters === null) return true;
  return plugin.supported_adapters.includes(ONEBOT_V11_ADAPTER);
}

export interface FilterOptions {
  onebotOnly: boolean;
  /** 默认隐藏索引端兼容性测试未通过的插件 */
  hideInvalid: boolean;
  type?: 'application' | 'library';
  tag?: string;
  query?: string;
}

/** 搜索命中权重：名字 > 模块名 > 描述 > 作者，避免描述里的常见词淹没真正相关的结果 */
function score(plugin: NsbPlugin, q: string): number {
  const needle = q.toLowerCase();
  let s = 0;
  if (plugin.name.toLowerCase().includes(needle)) s += 40;
  if (plugin.module_name.toLowerCase().includes(needle)) s += 30;
  if (plugin.project_link.toLowerCase().includes(needle)) s += 20;
  if (plugin.desc.toLowerCase().includes(needle)) s += 10;
  if (plugin.tags.some((t) => t.label.toLowerCase().includes(needle))) s += 15;
  if (plugin.author.toLowerCase().includes(needle)) s += 5;
  if (plugin.is_official) s += 3;
  return s;
}

export function queryPlugins(list: NsbPlugin[], opts: FilterOptions): NsbPlugin[] {
  const filtered = list.filter((p) => {
    if (opts.onebotOnly && !isOneBotV11Compatible(p)) return false;
    if (opts.hideInvalid && !p.valid) return false;
    if (opts.type !== undefined && p.type !== opts.type) return false;
    if (opts.tag !== undefined && !p.tags.some((t) => t.label === opts.tag)) return false;
    if (opts.query !== undefined && opts.query.trim().length > 0 && score(p, opts.query.trim()) === 0) return false;
    return true;
  });

  const q = opts.query?.trim();
  if (q === undefined || q.length === 0) {
    return filtered.sort((a, b) => timeOf(b) - timeOf(a));
  }
  return filtered.sort((a, b) => score(b, q) - score(a, q));
}

function timeOf(p: NsbPlugin): number {
  const t = Date.parse(p.time);
  return Number.isNaN(t) ? 0 : t;
}

export function topTags(list: NsbPlugin[], limit = 24): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of list) for (const t of p.tags) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * PyPI 分发包名在 project_link，module_name 是 Python 导入名。
 * 实测官方索引 943 条里有 872 条两者不同（nonebot_plugin_status / nonebot-plugin-status），
 * 装错字段会直接 pip install 找不到包。
 */
export type PluginRef = Pick<NsbPlugin, 'module_name' | 'project_link' | 'version'>;

export function pipRequirement(plugin: PluginRef): string {
  return `${plugin.project_link}==${plugin.version}`;
}

export function importPath(plugin: PluginRef): string {
  // 索引里少数条目的 module_name 带短横线，那不是合法的 Python 模块名
  return plugin.module_name.replace(/-/g, '_');
}

/** 从导入名反推分发包名，用于 pip uninstall */
export function distributionName(module: string): string {
  return module.replace(/_/g, '-');
}
