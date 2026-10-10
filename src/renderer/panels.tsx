import { useEffect, useState } from 'react';
import type { AppStatus, PluginSearchResult, ProviderView } from '../shared/ipc.ts';
import type { FeedMessage, LogEntry } from '../shared/types.ts';
import type { NsbPlugin } from '../main/plugins/registry.ts';
import type { Draft, Notice } from './App.tsx';

type Patch = (patch: Partial<Draft>) => void;

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function time(text: number): string {
  return clock.format(new Date(text));
}

function TextField(props: {
  label: string;
  value: string;
  hint?: string;
  placeholder?: string;
  password?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <input
        type={props.password === true ? 'password' : 'text'}
        value={props.value}
        placeholder={props.placeholder ?? ''}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint !== undefined && <small className="hint">{props.hint}</small>}
    </label>
  );
}

function NumberField(props: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; hint?: string }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <input
        type="number"
        value={text}
        min={props.min}
        max={props.max}
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (Number.isFinite(next) && next >= props.min && next <= props.max) props.onChange(next);
        }}
      />
      {props.hint !== undefined && <small className="hint">{props.hint}</small>}
    </label>
  );
}

function Toggle(props: { label: string; value: boolean; onChange: (value: boolean) => void; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.value} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
      {props.hint !== undefined && <small className="hint">{props.hint}</small>}
    </label>
  );
}

function SectionTitle(props: { title: string; note?: string }) {
  return (
    <div className="section-title">
      <h2>{props.title}</h2>
      {props.note !== undefined && <p>{props.note}</p>}
    </div>
  );
}

// ---------------- 接入 ----------------

export function ConnectPanel(props: {
  draft: Draft;
  status: AppStatus;
  patch: Patch;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onResetSessions: () => void;
}) {
  const { onebot } = props.draft;
  const [kind, setKind] = useState<'group' | 'private'>('group');
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState('');

  return (
    <div className="stack">
      <SectionTitle
        title="协议端接入"
        note="桌面端在本机监听，NapCat / LLOneBot 作为客户端连进来，不需要公网地址。"
      />
      <div className="grid">
        <label className="field">
          <span className="label">接入方式</span>
          <select value={onebot.mode} onChange={(e) => props.patch({ onebot: { ...onebot, mode: e.target.value === 'forward' ? 'forward' : 'reverse' } })}>
            <option value="reverse">反向（协议端连入本机，推荐）</option>
            <option value="forward">正向（本机连出到协议端）</option>
          </select>
        </label>
        {onebot.mode === 'reverse' ? (
          <>
            <TextField label="监听地址" value={onebot.listenHost} onChange={(v) => props.patch({ onebot: { ...onebot, listenHost: v } })} hint="只监听本机最安全；填 0.0.0.0 会暴露到局域网" />
            <NumberField label="监听端口" value={onebot.listenPort} min={1024} max={65535} onChange={(v) => props.patch({ onebot: { ...onebot, listenPort: v } })} />
          </>
        ) : (
          <TextField label="协议端 WS 地址" value={onebot.forwardUrl} placeholder="ws://127.0.0.1:3000" onChange={(v) => props.patch({ onebot: { ...onebot, forwardUrl: v } })} />
        )}
        <TextField
          label="access_token"
          value={onebot.accessToken}
          password
          onChange={(v) => props.patch({ onebot: { ...onebot, accessToken: v } })}
          hint="与 NapCat 里的令牌保持一致；留空表示不校验（仅本机可用）"
        />
        <TextField label="HTTP API 基址（可选）" value={onebot.httpApiBase} placeholder="http://127.0.0.1:3000" onChange={(v) => props.patch({ onebot: { ...onebot, httpApiBase: v } })} hint="WS 不支持某个动作时才走 HTTP 兜底" />
        <NumberField label="动作超时(ms)" value={onebot.actionTimeoutMs} min={1000} max={120000} onChange={(v) => props.patch({ onebot: { ...onebot, actionTimeoutMs: v } })} />
      </div>

      <div className="row">
        <button type="button" className="primary" onClick={props.onConnect} disabled={props.busy}>
          启动接入
        </button>
        <button type="button" onClick={props.onDisconnect} disabled={props.busy}>
          停止接入
        </button>
        <button type="button" onClick={props.onResetSessions}>
          清空会话历史
        </button>
        <span className="muted">
          当前：{props.status.onebot} · 监听 {String(props.status.listenPort)} · QQ {props.status.selfId > 0 ? String(props.status.selfId) : '未识别'}
        </span>
      </div>

      <SectionTitle title="手动发一条（验证链路）" note="不经过模型，直接把文本发给指定群或用户，用来确认协议端能收消息。" />
      <div className="grid">
        <label className="field">
          <span className="label">目标类型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value === 'group' ? 'group' : 'private')}>
            <option value="group">群</option>
            <option value="private">私聊</option>
          </select>
        </label>
        <TextField label="群号 / QQ 号" value={target} onChange={setTarget} />
      </div>
      <textarea className="editor" rows={3} value={text} placeholder="测试内容" onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button
          type="button"
          disabled={text.trim().length === 0 || target.trim().length === 0}
          onClick={() => {
            void window.qqbot.send({ kind, targetId: Number(target), text }).then((r) => {
              setResult(r.ok ? '已发送' : `失败：${r.error}`);
            });
          }}
        >
          发送
        </button>
        {result.length > 0 && <span className="muted">{result}</span>}
      </div>
    </div>
  );
}

// ---------------- 模型 ----------------

function emptyProvider(index: number): ProviderView {
  return {
    id: `model-${String(index + 1)}`,
    label: '新模型',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 800,
    contextWindow: 128_000,
    supportsVision: false,
    pathStyle: 'openai',
    enabled: true,
    apiKeySet: false,
    apiKeyMasked: '',
  };
}

export function ModelsPanel(props: { draft: Draft; patch: Patch; onTest: (providerId: string) => void }) {
  const update = (index: number, patch: Partial<ProviderView>) => {
    props.patch({ providers: props.draft.providers.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  };

  return (
    <div className="stack">
      <SectionTitle title="自定义大模型" note="任何 OpenAI 兼容端点都能接：DeepSeek、Kimi、智谱、vLLM、Ollama、OneAPI 等。密钥只存在主进程。" />
      {props.draft.providers.map((p, index) => (
        <div className="card" key={p.id}>
          <div className="card-head">
            <strong>{p.label}</strong>
            <span className="muted">{p.apiKeySet ? `密钥已保存 ${p.apiKeyMasked}` : '未配置密钥'}</span>
            <button type="button" onClick={() => props.onTest(p.id)}>
              试跑
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => props.patch({ providers: props.draft.providers.filter((_, i) => i !== index) })}
              disabled={props.draft.providers.length <= 1}
            >
              删除
            </button>
          </div>
          <div className="grid">
            <TextField label="ID" value={p.id} onChange={(v) => update(index, { id: v })} hint="小写字母/数字/短横线，会话路由用它" />
            <TextField label="显示名" value={p.label} onChange={(v) => update(index, { label: v })} />
            <TextField label="API 基址" value={p.baseUrl} placeholder="https://api.deepseek.com/v1" onChange={(v) => update(index, { baseUrl: v })} />
            <label className="field">
              <span className="label">路径风格</span>
              <select value={p.pathStyle} onChange={(e) => update(index, { pathStyle: e.target.value === 'bare' ? 'bare' : 'openai' })}>
                <option value="openai">基址含 /v1（标准）</option>
                <option value="bare">基址直接接 /chat/completions</option>
              </select>
            </label>
            <TextField label="模型名" value={p.model} onChange={(v) => update(index, { model: v })} />
            <TextField
              label="API 密钥"
              value={p.apiKeyInput}
              password
              placeholder={p.apiKeySet ? '留空表示不修改' : 'sk-…'}
              onChange={(v) => props.patch({ providers: props.draft.providers.map((x, i) => (i === index ? { ...x, apiKeyInput: v } : x)) })}
            />
            <NumberField label="最大输出 token" value={p.maxTokens} min={16} max={32000} onChange={(v) => update(index, { maxTokens: v })} />
            <NumberField label="上下文窗口" value={p.contextWindow} min={1024} max={10000000} onChange={(v) => update(index, { contextWindow: v })} hint="装配历史时按它裁剪" />
            <NumberField label="温度" value={p.temperature} min={0} max={2} onChange={(v) => update(index, { temperature: v })} />
            <Toggle label="支持图片输入" value={p.supportsVision} onChange={(v) => update(index, { supportsVision: v })} hint="关掉后收到图片会明确告知无法识别" />
            <Toggle label="启用" value={p.enabled} onChange={(v) => update(index, { enabled: v })} />
          </div>
        </div>
      ))}
      <div className="row">
        <button
          type="button"
          onClick={() =>
            props.patch({ providers: [...props.draft.providers, { ...emptyProvider(props.draft.providers.length), apiKeyInput: '' }] })
          }
        >
          添加模型
        </button>
        <label className="field inline">
          <span className="label">默认模型</span>
          <select value={props.draft.defaultProviderId} onChange={(e) => props.patch({ defaultProviderId: e.target.value })}>
            {props.draft.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

// ---------------- 提示词 ----------------

export function PromptPanel(props: { draft: Draft; patch: Patch }) {
  const { prompt } = props.draft;
  const [group, setGroup] = useState('');
  const entries = Object.entries(props.draft.groupProviderOverrides);

  return (
    <div className="stack">
      <SectionTitle title="人设与触发" note="群里默认只有被 @ 才回；私聊始终回。这段描述会进系统提示，请写清能力边界以减少幻觉。" />
      <div className="grid">
        <TextField label="机器人昵称" value={prompt.personaName} onChange={(v) => props.patch({ prompt: { ...prompt, personaName: v } })} />
        <NumberField label="历史轮数" value={prompt.historyTurns} min={0} max={50} onChange={(v) => props.patch({ prompt: { ...prompt, historyTurns: v } })} hint="越大越费 token" />
        <Toggle label="群里需要 @ 才响应" value={prompt.requireAtInGroup} onChange={(v) => props.patch({ prompt: { ...prompt, requireAtInGroup: v } })} />
        <TextField
          label="额外触发词（逗号分隔）"
          value={prompt.triggerWords.join('，')}
          onChange={(v) =>
            props.patch({ prompt: { ...prompt, triggerWords: v.split(/[,，]/).map((w) => w.trim()).filter((w) => w.length > 0) } })
          }
        />
        <NumberField label="静默重置(秒)" value={Math.round(prompt.idleResetMs / 1000)} min={10} max={86400} onChange={(v) => props.patch({ prompt: { ...prompt, idleResetMs: v * 1000 } })} hint="超过这段时间没消息就丢掉上下文" />
        <NumberField label="最长输入(字)" value={prompt.maxInputChars} min={50} max={200000} onChange={(v) => props.patch({ prompt: { ...prompt, maxInputChars: v } })} />
        <NumberField label="最长输出(字)" value={prompt.maxOutputChars} min={20} max={20000} onChange={(v) => props.patch({ prompt: { ...prompt, maxOutputChars: v } })} />
        <NumberField label="分段发送长度" value={prompt.chunkSize} min={50} max={4000} onChange={(v) => props.patch({ prompt: { ...prompt, chunkSize: v } })} hint="QQ 没有折叠，长答案按此长度拆多条" />
      </div>
      <label className="field">
        <span className="label">人设描述</span>
        <textarea
          className="editor tall"
          value={prompt.personaDescription}
          onChange={(e) => props.patch({ prompt: { ...prompt, personaDescription: e.target.value } })}
        />
      </label>

      <SectionTitle title="指定群用不同模型" note="管理群用强模型、水群用便宜模型，是省钱的正规做法。" />
      {entries.length === 0 && <p className="muted">还没有群级路由。</p>}
      {entries.map(([groupId, providerId]) => (
        <div className="row" key={groupId}>
          <code className="mono">{groupId}</code>
          <select
            value={providerId}
            onChange={(e) =>
              props.patch({ groupProviderOverrides: { ...props.draft.groupProviderOverrides, [groupId]: e.target.value } })
            }
          >
            {props.draft.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="danger"
            onClick={() => {
              const next = { ...props.draft.groupProviderOverrides };
              delete next[groupId];
              props.patch({ groupProviderOverrides: next });
            }}
          >
            移除
          </button>
        </div>
      ))}
      <div className="row">
        <input value={group} placeholder="群号" onChange={(e) => setGroup(e.target.value.trim())} />
        <button
          type="button"
          disabled={!/^\d{5,20}$/.test(group) || props.draft.providers.length === 0}
          onClick={() => {
            const first = props.draft.providers[0] as ProviderView;
            props.patch({ groupProviderOverrides: { ...props.draft.groupProviderOverrides, [group]: first.id } });
            setGroup('');
          }}
        >
          添加群路由
        </button>
      </div>
    </div>
  );
}

// ---------------- 插件市场 ----------------

export function PluginsPanel(props: {
  draft: Draft;
  status: AppStatus;
  patch: Patch;
  notify: (notice: Notice) => void;
  onSidecar: (action: 'start' | 'stop' | 'restart') => void;
  onChanged: () => void;
}) {
  const [env, setEnv] = useState({ ok: false, detail: '检查中…' });
  const [installed, setInstalled] = useState<string[]>([]);
  const [search, setSearch] = useState<PluginSearchResult | null>(null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [type, setType] = useState<'all' | 'application' | 'library'>('all');
  const [onebotOnly, setOnebotOnly] = useState(true);
  const [hideInvalid, setHideInvalid] = useState(true);
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);

  const refreshInstalled = () => {
    void window.qqbot.installedPlugins().then((info) => {
      setInstalled(info.modules);
      setEnv(info.env);
    });
  };

  useEffect(refreshInstalled, []);

  const runSearch = () => {
    setLoading(true);
    void window.qqbot
      .searchPlugins({ query, tag, type, onebotOnly, hideInvalid, limit: 24, offset: 0 })
      .then((result) => {
        setSearch(result);
        if (!result.ok) props.notify({ kind: 'error', text: result.error });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // 打字时不要每敲一个字符就发一次检索请求
    const timer = setTimeout(runSearch, 400);
    return () => clearTimeout(timer);
    // 只在这些筛选条件变化时重新检索；loading/search 结果变化不该再触发
  }, [query, tag, type, onebotOnly, hideInvalid]);

  const { sidecar } = props.draft;
  const sidecarSettings = (patch: Partial<typeof sidecar>) => props.patch({ sidecar: { ...sidecar, ...patch } });

  return (
    <div className="stack">
      <SectionTitle title="NoneBot2 侧车" note="市场插件跑在独立 Python 进程里，由主进程用 OneBot v11 反向 WS 把事件喂给它，插件无需改一行代码。" />
      <div className="grid">
        <TextField label="Python 解释器" value={sidecar.pythonPath} placeholder="C:\\Python312\\python.exe" onChange={(v) => sidecarSettings({ pythonPath: v })} hint="建虚拟环境用，留空则自动找 PATH 上的 python" />
        <TextField label="虚拟环境目录" value={sidecar.venvPath} onChange={(v) => sidecarSettings({ venvPath: v })} hint="插件只装进这个独立环境，不会动系统的 Python" />
        <NumberField label="侧车端口" value={sidecar.port} min={1024} max={65535} onChange={(v) => sidecarSettings({ port: v })} />
        <NumberField label="AI 网关端口" value={sidecar.gatewayPort} min={1024} max={65535} onChange={(v) => sidecarSettings({ gatewayPort: v })} />
        <TextField label="侧车令牌" value={sidecar.accessToken} password hint="主进程连侧车用，留空表示不校验" onChange={(v) => sidecarSettings({ accessToken: v })} />
        <Toggle label="随程序启动侧车" value={sidecar.autostart} onChange={(v) => sidecarSettings({ autostart: v })} />
      </div>
      <div className="card">
        <div className="card-head">
          <strong>侧车状态</strong>
          <span className="muted">
            {props.status.sidecar.state} · 桥 {props.status.sidecar.bridge} · PID {props.status.sidecar.pid > 0 ? String(props.status.sidecar.pid) : '—'}
          </span>
        </div>
        <p className="muted mono">插件调用模型走：http://127.0.0.1:{String(props.status.gateway.port)}/v1</p>
        {props.status.sidecar.error.length > 0 && <p className="error-text">{props.status.sidecar.error}</p>}
        <div className="row">
          <button type="button" className="primary" onClick={() => props.onSidecar('start')}>
            启动
          </button>
          <button type="button" onClick={() => props.onSidecar('restart')}>
            重启
          </button>
          <button type="button" onClick={() => props.onSidecar('stop')}>
            停止
          </button>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void window.qqbot.prepareEnv().then((r) => {
                setSteps(r.steps);
                setLoading(false);
                refreshInstalled();
                props.notify(r.ok ? { kind: 'ok', text: '环境已就绪' } : { kind: 'error', text: r.steps.join(' / ') });
              });
            }}
          >
            创建 venv 并装依赖
          </button>
          <span className="muted">{env.detail}</span>
        </div>
        {steps.length > 0 && <pre className="steps">{steps.join('\n')}</pre>}
      </div>

      <SectionTitle title="已启用插件" note="清单写在 sidecar/plugins.json，改完要重启侧车才生效。" />
      {installed.length === 0 && <p className="muted">还没有插件。</p>}
      {installed.map((module) => (
        <div className="row" key={module}>
          <code className="mono">{module}</code>
          <button
            type="button"
            className="danger"
            onClick={() => {
              void window.qqbot.uninstallPlugin(module).then((r) => {
                setSteps(r.steps);
                refreshInstalled();
                props.notify(r.ok ? { kind: 'ok', text: `已移除 ${module}` } : { kind: 'error', text: r.steps.join(' / ') });
              });
            }}
          >
            停用
          </button>
        </div>
      ))}

      <SectionTitle title="插件市场" note="数据来自 NoneBot 官方索引；默认只显示声明支持 OneBot v11 且索引端测试通过的插件。" />
      <div className="grid">
        <TextField label="搜索" value={query} placeholder="天气、订阅、群管、图片…" onChange={setQuery} />
        <TextField label="标签" value={tag} onChange={setTag} />
        <label className="field">
          <span className="label">类型</span>
          <select value={type} onChange={(e) => setType(e.target.value === 'library' ? 'library' : e.target.value === 'application' ? 'application' : 'all')}>
            <option value="all">全部</option>
            <option value="application">功能插件</option>
            <option value="library">工具库</option>
          </select>
        </label>
        <Toggle label="仅 OneBot v11 可用" value={onebotOnly} onChange={setOnebotOnly} />
        <Toggle label="隐藏兼容性测试未通过" value={hideInvalid} onChange={setHideInvalid} />
      </div>
      {search !== null && search.tags.length > 0 && (
        <div className="tags">
          {search.tags.map((t) => (
            <button key={t.label} type="button" className={`tag ${tag === t.label ? 'active' : ''}`} onClick={() => setTag(t.label === tag ? '' : t.label)}>
              {t.label} {String(t.count)}
            </button>
          ))}
        </div>
      )}
      <p className="muted">
        {loading ? '检索中…' : `共 ${String(search?.total ?? 0)} 个可用插件`}
        {search !== null && !search.ok ? `（${search.error.slice(0, 120)}）` : ''}
      </p>
      {(search?.items ?? []).map((p) => (
        <MarketRow
          key={p.project_link}
          plugin={p}
          installed={installed.includes(p.module_name.replace(/-/g, '_'))}
          busy={loading}
          notify={props.notify}
          onDone={() => {
            refreshInstalled();
            props.onChanged();
          }}
          onSteps={setSteps}
        />
      ))}
    </div>
  );
}

function MarketRow(props: {
  plugin: NsbPlugin;
  installed: boolean;
  busy: boolean;
  notify: (notice: Notice) => void;
  onDone: () => void;
  onSteps: (steps: string[]) => void;
}) {
  const [working, setWorking] = useState(false);
  const p = props.plugin;
  return (
    <div className="card market">
      <div className="card-head">
        <strong>{p.name}</strong>
        {p.is_official && <span className="badge">官方</span>}
        {!p.valid && <span className="badge warn">索引测试未通过</span>}
        <span className="muted mono">
          {p.module_name} @ {p.version}
        </span>
      </div>
      <p className="desc">{p.desc}</p>
      <div className="row">
        <button
          type="button"
          disabled={props.installed || working}
          onClick={() => {
            setWorking(true);
            void window.qqbot
              .installPlugin({ module_name: p.module_name, project_link: p.project_link, version: p.version })
              .then((r) => {
                props.onSteps(r.steps);
                props.notify(r.ok ? { kind: 'ok', text: `${p.name} 已安装，重启侧车后生效` } : { kind: 'error', text: r.steps.join(' / ') });
                props.onDone();
              })
              .finally(() => setWorking(false));
          }}
        >
          {props.installed ? '已在清单' : working ? '安装中…' : '安装'}
        </button>
        <span className="muted">{p.author}</span>
      </div>
    </div>
  );
}

// ---------------- 日志与消息流 ----------------

const LEVELS: Array<LogEntry['level'] | 'all'> = ['all', 'error', 'warn', 'info', 'debug'];

export function LogsPanel({ logs }: { logs: LogEntry[] }) {
  const [level, setLevel] = useState<LogEntry['level'] | 'all'>('all');
  const [source, setSource] = useState<string>('all');
  const shown = logs
    .filter((l) => (level === 'all' ? true : l.level === level))
    .filter((l) => (source === 'all' ? true : l.source === source))
    .slice(-400)
    .reverse();

  return (
    <div className="stack">
      <SectionTitle title="运行日志" note="排查接入问题先看这里；侧车输出也并进来了。" />
      <div className="row">
        <select value={level} onChange={(e) => setLevel(e.target.value === 'all' ? 'all' : (e.target.value as LogEntry['level']))}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {['all', 'onebot', 'gateway', 'sidecar', 'plugin', 'prompt'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="muted">{String(shown.length)} 条</span>
      </div>
      <div className="logbox">
        {shown.map((l, i) => (
          <div className={`logline ${l.level}`} key={`${String(l.time)}-${String(i)}`}>
            <span className="mono">{time(l.time)}</span>
            <span className="src">{l.source}</span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FeedPanel({ feed }: { feed: FeedMessage[] }) {
  return (
    <div className="stack">
      <SectionTitle title="消息流" note="左边是收到的，右边是机器人发出去的。" />
      <div className="feed">
        {feed.length === 0 && <p className="muted">还没有消息。</p>}
        {feed
          .slice(-80)
          .reverse()
          .map((m) => (
            <div className={`bubble ${m.direction}`} key={m.id}>
              <div className="bubble-head">
                <span>{m.speaker}</span>
                <span className="mono">{time(m.time)}</span>
                {m.aiHandled && <span className="badge">AI</span>}
                {m.kind === 'group' && <span className="muted mono">群{String(m.groupId)}</span>}
              </div>
              <p>{m.text}</p>
              {m.note !== undefined && <small className="muted">{m.note}</small>}
            </div>
          ))}
      </div>
    </div>
  );
}
