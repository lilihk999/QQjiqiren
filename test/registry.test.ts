import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRegistry,
  importPath,
  isOneBotV11Compatible,
  pipRequirement,
  queryPlugins,
  topTags,
  type NsbPlugin,
} from '../src/main/plugins/registry.ts';

function plugin(overrides: Partial<NsbPlugin> = {}): NsbPlugin {
  return {
    module_name: 'nonebot_plugin_demo',
    project_link: 'nonebot-plugin-demo',
    name: '演示插件',
    desc: '一个演示用的插件',
    author: 'tester',
    homepage: 'https://github.com/tester/nonebot-plugin-demo',
    tags: [{ label: 'tool', color: '#fff' }],
    is_official: false,
    type: 'application',
    supported_adapters: null,
    valid: true,
    version: '1.0.0',
    time: '2026-01-01T00:00:00Z',
    skip_test: false,
    ...overrides,
  };
}

test('supported_adapters 为 null 视为通用，声明列表里没有 v11 则不兼容', () => {
  assert.equal(isOneBotV11Compatible(plugin({ supported_adapters: null })), true);
  assert.equal(isOneBotV11Compatible(plugin({ supported_adapters: ['nonebot.adapters.onebot.v11'] })), true);
  assert.equal(isOneBotV11Compatible(plugin({ supported_adapters: ['nonebot.adapters.qqguild'] })), false);
  assert.equal(isOneBotV11Compatible(plugin({ supported_adapters: [] })), false);
});

test('筛选：OneBot 专用 + 隐藏未通过兼容性测试的插件', () => {
  const list = [
    plugin({ module_name: 'a', name: 'A', supported_adapters: null }),
    plugin({ module_name: 'b', name: 'B', supported_adapters: ['nonebot.adapters.qqguild'] }),
    plugin({ module_name: 'c', name: 'C', valid: false }),
  ];
  const only = queryPlugins(list, { onebotOnly: true, hideInvalid: true });
  assert.deepEqual(only.map((p) => p.module_name), ['a']);

  const showInvalid = queryPlugins(list, { onebotOnly: true, hideInvalid: false });
  assert.deepEqual(showInvalid.map((p) => p.module_name).sort(), ['a', 'c']);
});

test('搜索按名字优先于描述，官方与标签有加分', () => {
  const list = [
    plugin({ module_name: 'm_expense', name: '记账', desc: '普通的工具' }),
    plugin({ module_name: 'm_random', name: '随机数', desc: '内置了记账相关的示例说明', is_official: false }),
    plugin({ module_name: 'm_official', name: '天气', desc: '查天气', is_official: true, tags: [{ label: '记账', color: '#000' }] }),
  ];
  const r = queryPlugins(list, { onebotOnly: false, hideInvalid: false, query: '记账' });
  assert.equal(r[0]?.name, '记账', '名字命中的应排第一');
  assert.ok(r.length === 3, '描述与标签命中也要能被搜到');
});

test('空查询按更新时间倒序，且不过滤官方标记', () => {
  const list = [
    plugin({ module_name: 'old', time: '2020-01-01T00:00:00Z' }),
    plugin({ module_name: 'new', time: '2026-06-01T00:00:00Z' }),
    plugin({ module_name: 'bad-date', time: 'not-a-date' }),
  ];
  const r = queryPlugins(list, { onebotOnly: false, hideInvalid: false });
  assert.deepEqual(r.map((p) => p.module_name), ['new', 'old', 'bad-date']);
});

test('标签统计与安装参数生成', () => {
  const list = [
    plugin({ tags: [{ label: 'game', color: '#000' }, { label: 'tool', color: '#000' }] }),
    plugin({ tags: [{ label: 'game', color: '#000' }] }),
  ];
  assert.deepEqual(topTags(list), [
    { label: 'game', count: 2 },
    { label: 'tool', count: 1 },
  ]);
  assert.equal(pipRequirement(plugin({ module_name: 'haruka_bot', project_link: 'haruka-bot', version: '1.6.0' })), 'haruka-bot==1.6.0');
  assert.equal(importPath(plugin({ module_name: 'nonebot_plugin_status' })), 'nonebot_plugin_status');
  assert.equal(importPath(plugin({ module_name: 'nonebot-plugin-bad' })), 'nonebot_plugin_bad', '索引里带短横线的 module_name 要规范化成合法模块名');
});

/**
 * 直连官方索引的契约测试。数据源结构一旦变动（字段改名、分支调整），
 * 这条比任何单测都先报警，因此不允许静默跳过。
 */
test('官方插件索引可拉取且字段完整', async () => {
  const list = await fetchRegistry();
  assert.ok(list.length > 500, `索引条目异常偏少：${String(list.length)}`);
  assert.ok(list.every((p) => typeof p.module_name === 'string' && p.module_name.length > 0));

  const status = list.find((p) => p.module_name === 'nonebot_plugin_status');
  assert.ok(status !== undefined, '索引里应当存在 nonebot_plugin_status 这个官方插件');
  assert.equal(typeof status.valid, 'boolean');
  assert.ok(Array.isArray(status.tags));
  assert.equal(pipRequirement(status), `${status.project_link}==${status.version}`, 'pip 参数必须由 project_link 生成');
  assert.equal(importPath(status), 'nonebot_plugin_status', 'NoneBot 加载要用导入名');

  const compatible = queryPlugins(list, { onebotOnly: true, hideInvalid: true });
  assert.ok(compatible.length > 100, `OneBot v11 可用插件数异常：${String(compatible.length)}`);
  const incompatible = queryPlugins(list, { onebotOnly: false, hideInvalid: false, query: 'haruka' });
  assert.ok(incompatible.length >= 1, '应能搜到 B 站订阅类插件');
});
