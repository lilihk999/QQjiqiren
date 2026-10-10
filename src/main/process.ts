import { spawn } from 'node:child_process';
import type { ChildLike } from './sidecar/manager.ts';
import type { RunResult } from './plugins/installer.ts';

/**
 * 进程调用统一从这里出，方便在测试里换成假实现，也保证子进程拿不到额外的 shell 能力。
 *
 * 一律使用 args 数组而不是 shell 字符串：Windows 上 `cmd /c "pip install x"` 会把用户
 * 填的插件名当成命令拼接面，数组形式不存在这个问题。
 */

const RUN_TIMEOUT_MS = 300_000;

export function makeSpawner(): (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildLike {
  return (command, args, options) =>
    spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildLike;
}

export function makeRunner(timeoutMs = RUN_TIMEOUT_MS): (command: string, args: string[], options: { cwd: string }) => Promise<RunResult> {
  return (command, args, options) =>
    new Promise<RunResult>((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${command} 执行超过 ${String(timeoutMs)}ms`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 400_000) stdout = stdout.slice(-200_000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}
