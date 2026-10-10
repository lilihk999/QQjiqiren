import { useCallback, useEffect, useState } from 'react';
import type { AppStatus, ProviderEdit, SettingsEdit, SettingsView } from '../shared/ipc.ts';
import type { FeedMessage, LogEntry } from '../shared/types.ts';
import { ConnectPanel, FeedPanel, LogsPanel, ModelsPanel, PluginsPanel, PromptPanel } from './panels.tsx';

export type ProviderDraft = SettingsView['providers'][number] & { apiKeyInput: string };

export interface Draft {
  onebot: SettingsView['onebot'];
  providers: ProviderDraft[];
  defaultProviderId: string;
  groupProviderOverrides: SettingsView['groupProviderOverrides'];
  prompt: SettingsView['prompt'];
  sidecar: SettingsView['sidecar'];
}

export interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

export type Tab = 'connect' | 'models' | 'prompt' | 'plugins' | 'logs';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'connect', label: '接入' },
  { id: 'models', label: '模型' },
  { id: 'prompt', label: '提示词' },
  { id: 'plugins', label: '插件市场' },
  { id: 'logs', label: '日志' },
];

function toDraft(view: SettingsView): Draft {
  return {
    onebot: view.onebot,
    providers: view.providers.map((p) => ({ ...p, apiKeyInput: '' })),
    defaultProviderId: view.defaultProviderId,
    groupProviderOverrides: view.groupProviderOverrides,
    prompt: view.prompt,
    sidecar: view.sidecar,
  };
}

/** 密钥框留空表示"不改"，主进程里存的值不会被界面上的空串覆盖 */
function toEdit(draft: Draft): SettingsEdit {
  const providers: ProviderEdit[] = draft.providers.map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    contextWindow: p.contextWindow,
    supportsVision: p.supportsVision,
    pathStyle: p.pathStyle,
    enabled: p.enabled,
    apiKey: p.apiKeyInput.length > 0 ? p.apiKeyInput : null,
  }));
  return {
    onebot: draft.onebot,
    providers,
    defaultProviderId: draft.defaultProviderId,
    groupProviderOverrides: draft.groupProviderOverrides,
    prompt: draft.prompt,
    sidecar: draft.sidecar,
  };
}

export function App() {
  const [tab, setTab] = useState<Tab>('connect');
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [feed, setFeed] = useState<FeedMessage[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [nextStatus, view, recentLogs, recentFeed] = await Promise.all([
        window.qqbot.getStatus(),
        window.qqbot.getSettings(),
        window.qqbot.recentLogs(),
        window.qqbot.recentFeed(),
      ]);
      if (!alive) return;
      setStatus(nextStatus);
      setDraft(toDraft(view));
      setLogs(recentLogs.slice(-200));
      setFeed(recentFeed);
    })();

    const offStatus = window.qqbot.onStatus((next) => setStatus(next));
    const offFeed = window.qqbot.onFeed((message) => setFeed((prev) => [...prev.slice(-199), message]));
    const offLog = window.qqbot.onLog((entry) => setLogs((prev) => [...prev.slice(-499), entry]));
    return () => {
      alive = false;
      offStatus();
      offFeed();
      offLog();
    };
  }, []);

  const notify = useCallback((next: Notice) => {
    setNotice(next);
    setTimeout(() => setNotice(null), 4_000);
  }, []);

  const save = useCallback(async () => {
    if (draft === null) return;
    setBusy(true);
    const result = await window.qqbot.saveSettings(toEdit(draft));
    setBusy(false);
    notify(result.ok ? { kind: 'ok', text: '已保存' } : { kind: 'error', text: result.error });
    if (result.ok) setStatus(await window.qqbot.getStatus());
  }, [draft, notify]);

  const patchDraft = useCallback((patch: Partial<Draft>) => {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }, []);

  const act = useCallback(
    async (label: string, run: () => Promise<{ ok: boolean; error: string }>) => {
      setBusy(true);
      const result = await run();
      setBusy(false);
      notify(result.ok ? { kind: 'ok', text: label } : { kind: 'error', text: `${label}失败：${result.error}` });
      setStatus(await window.qqbot.getStatus());
    },
    [notify],
  );

  if (draft === null || status === null) {
    return <div className="boot">正在启动本地服务…</div>;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">Q</span>
          <div>
            <h1>QQ 机器人桌面端</h1>
            <p className="muted">OneBot v11 · NoneBot2 插件市场 · 自定义大模型</p>
          </div>
        </div>
        <div className="chips">
          <span className={`chip ${status.onebot === 'connected' ? 'ok' : 'idle'}`}>
            协议端 {status.onebot}
          </span>
          <span className="chip">{status.selfId > 0 ? `QQ ${String(status.selfId)}` : '未登录'}</span>
          <span className={`chip ${status.sidecar.state === 'running' ? 'ok' : 'idle'}`}>
            侧车 {status.sidecar.state}
          </span>
          <span className="chip">网关 {String(status.gateway.port)}</span>
          <span className="chip">调用 {String(status.gateway.calls)}</span>
        </div>
        <div className="topbar-actions">
          <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
            保存配置
          </button>
        </div>
      </header>

      {notice !== null && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'tab active' : 'tab'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="content">
        <section className="panel">
          {tab === 'connect' && (
            <ConnectPanel
              draft={draft}
              status={status}
              patch={patchDraft}
              busy={busy}
              onConnect={() => void act('已启动接入', () => window.qqbot.connect())}
              onDisconnect={() => void act('已停止接入', () => window.qqbot.disconnect())}
              onResetSessions={() => void act('已清空会话', () => window.qqbot.resetSessions())}
            />
          )}
          {tab === 'models' && (
            <ModelsPanel draft={draft} patch={patchDraft} onTest={(id) => void testModel(id, notify)} />
          )}
          {tab === 'prompt' && <PromptPanel draft={draft} patch={patchDraft} />}
          {tab === 'plugins' && (
            <PluginsPanel
              draft={draft}
              status={status}
              patch={patchDraft}
              notify={notify}
              onSidecar={(action) => void sidecar(action, setStatus, notify)}
              onChanged={() => void refreshStatus(setStatus)}
            />
          )}
          {tab === 'logs' && <LogsPanel logs={logs} />}
        </section>
        <aside className="side">
          <FeedPanel feed={feed} />
        </aside>
      </main>
    </div>
  );
}

async function testModel(providerId: string, notify: (n: Notice) => void): Promise<void> {
  const result = await window.qqbot.testModel({ providerId, prompt: '用一句话介绍你自己' });
  notify(
    result.ok
      ? { kind: 'ok', text: `${result.ms}ms 回复：${result.reply.slice(0, 60)}` }
      : { kind: 'error', text: `调用失败：${result.error}` },
  );
}

async function sidecar(
  action: 'start' | 'stop' | 'restart',
  setStatus: (s: AppStatus) => void,
  notify: (n: Notice) => void,
): Promise<void> {
  const next = await window.qqbot.sidecarAction(action);
  setStatus(next);
  notify(
    next.sidecar.error.length > 0
      ? { kind: 'error', text: next.sidecar.error }
      : { kind: 'ok', text: `侧车：${next.sidecar.state}` },
  );
}

async function refreshStatus(setStatus: (s: AppStatus) => void): Promise<void> {
  setStatus(await window.qqbot.getStatus());
}

