import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotSettings, LogEntry } from '../shared/types.ts';
import { mergeDefaults } from '../shared/defaults.ts';

export interface SecretCodec {
  /** Electron safeStorage：Windows 上走 DPAPI，密钥文件离开这台机器就解不开 */
  available: boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface SettingsStoreDeps {
  dir: () => string;
  codec: SecretCodec;
  log: (level: LogEntry['level'], text: string) => void;
}

const ENC_PREFIX = 'v1:';
const FILE = 'settings.json';

function fileOf(dir: string): string {
  return join(dir, FILE);
}

/**
 * 配置持久化。
 *
 * 只加密模型 API 密钥：其余配置要在多台设备/多次手改之间保持可读。
 * 解密失败（换机器、降级到无 safeStorage）时把密钥当未配置，而不是带着错密钥去打下游。
 */
export class SettingsStore {
  constructor(private readonly deps: SettingsStoreDeps) {}

  load(): BotSettings {
    const path = fileOf(this.deps.dir());
    if (!existsSync(path)) return mergeDefaults(null);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      this.deps.log('error', `读取配置失败：${String(err)}`);
      return mergeDefaults(null);
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return this.decodeSecrets(mergeDefaults(parsed as Partial<BotSettings>));
    } catch {
      const backup = join(this.deps.dir(), 'settings.corrupt.json');
      try {
        renameSync(path, backup);
        this.deps.log('error', `配置文件已损坏，原文件保留在 ${backup}，本次使用默认配置`);
      } catch (err) {
        this.deps.log('error', `配置文件已损坏且无法备份：${String(err)}`);
      }
      return mergeDefaults(null);
    }
  }

  save(settings: BotSettings): void {
    const dir = this.deps.dir();
    mkdirSync(dir, { recursive: true });
    const path = fileOf(dir);
    const tmp = `${path}.tmp`;
    const text = JSON.stringify(this.encodeSecrets(settings), null, 2);
    try {
      // 先写临时文件再改名，断电也不会留下半个 JSON
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, path);
    } catch (err) {
      this.deps.log('error', `保存配置失败：${String(err)}`);
    }
  }

  private encodeSecrets(settings: BotSettings): BotSettings {
    return {
      ...settings,
      providers: settings.providers.map((p) => ({
        ...p,
        apiKey: this.encode(p.apiKey),
      })),
    };
  }

  private decodeSecrets(settings: BotSettings): BotSettings {
    return {
      ...settings,
      providers: settings.providers.map((p) => ({
        ...p,
        apiKey: this.decode(p.apiKey),
      })),
    };
  }

  private encode(value: string): string {
    if (value.length === 0) return '';
    if (!this.deps.codec.available) return value;
    return `${ENC_PREFIX}${this.deps.codec.encrypt(value)}`;
  }

  private decode(value: string): string {
    if (!value.startsWith(ENC_PREFIX)) return value;
    if (!this.deps.codec.available) {
      this.deps.log('warn', '系统钥匙串不可用，已忽略加密保存的模型密钥，请重新填写');
      return '';
    }
    try {
      return this.deps.codec.decrypt(value.slice(ENC_PREFIX.length));
    } catch {
      this.deps.log('warn', '模型密钥解密失败（可能换过机器），请重新填写');
      return '';
    }
  }
}
