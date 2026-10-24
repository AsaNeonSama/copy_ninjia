/** 测试与夹具共用的外部命令执行边界：异步启动子进程，经管道收集两路输出，或经伪终端收集合并输出。 */

/** 一次外部命令的退出码与 stdout、stderr 文本。 */
export interface CapturedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** runCapturedCommand 的参数；未给出的项沿用 Bun.spawn 的缺省行为。 */
export interface CapturedCommandOptions {
  /** 待执行的命令行与参数数组。 */
  readonly cmd: readonly string[];
  /** 子进程工作目录。 */
  readonly cwd?: string;
  /** 子进程环境变量覆盖表。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 超时毫秒数；到时以 killSignal 结束子进程。 */
  readonly timeout?: number;
  /** 超时或超出缓冲区上限时发送给子进程的终止信号。 */
  readonly killSignal?: NodeJS.Signals;
  /** 子进程可输出的最大字节数；超过时以 killSignal 结束子进程。 */
  readonly maxBuffer?: number;
}

/** runCapturedTerminalCommand 的参数；在 runCapturedCommand 的参数之上增加伪终端输入。 */
export interface CapturedTerminalCommandOptions extends CapturedCommandOptions {
  /** 写入伪终端的交互输入，须以换行结尾；缺省视为空输入。 */
  readonly input?: string;
}

/** 伪终端规范模式下位于行首的 VEOF（Ctrl-D）：子进程下一次读取得到 EOF。 */
const TERMINAL_END_OF_INPUT: string = "\x04";

/**
 * 以 Bun.spawn 运行命令，先开始读取 stdout 与 stderr，再等待退出，两路输出读完后返回。
 * 被信号结束时退出码为 128 加信号值。供测试与夹具收集外部命令的退出码和完整输出；
 * 不向子进程提供 stdin。
 *
 * 使用异步 Bun.spawn，不使用 Bun.spawnSync。
 *
 * @param options 外部命令执行选项
 * @returns 包含退出码、标准输出与标准错误文本的结果对象
 */
export async function runCapturedCommand({
  cmd,
  cwd,
  env,
  timeout,
  killSignal,
  maxBuffer,
}: CapturedCommandOptions): Promise<CapturedCommandResult> {
  const subprocess: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal,
    maxBuffer,
  });
  const stdout: Promise<string> = subprocess.stdout.text();
  const stderr: Promise<string> = subprocess.stderr.text();
  const exitCode: number = await subprocess.exited;
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

/**
 * 以 Bun.spawn 原生伪终端（PTY）运行命令：子进程获得独立会话与控制终端 `/dev/tty`。
 * 启动后一次写入 input 并紧跟 VEOF 结束输入，进程退出且伪终端读到 EOF 后返回。
 * 伪终端输出按 maxBuffer 自行计数（Bun.spawn 的 maxBuffer 只约束管道），超出时以
 * killSignal 结束子进程并丢弃此后的输出。
 *
 * @param options 伪终端命令执行选项
 * @returns 退出码与伪终端合并输出；合并输出写入 stdout，stderr 恒为空串
 */
export async function runCapturedTerminalCommand({
  cmd,
  cwd,
  env,
  input = "",
  timeout,
  killSignal,
  maxBuffer,
}: CapturedTerminalCommandOptions): Promise<CapturedCommandResult> {
  const decoder: TextDecoder = new TextDecoder();
  const terminalClosed: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  let output: string = "";
  let outputBytes: number = 0;
  const subprocess: Bun.Subprocess = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env,
    timeout,
    killSignal,
    terminal: {
      data(_terminal: Bun.Terminal, data: Uint8Array<ArrayBuffer>): void {
        outputBytes += data.byteLength;
        if (maxBuffer !== undefined && outputBytes > maxBuffer) {
          subprocess.kill(killSignal);
          return;
        }
        output += decoder.decode(data, { stream: true });
      },
      exit(): void {
        terminalClosed.resolve();
      },
    },
  });
  try {
    subprocess.terminal?.write(input + TERMINAL_END_OF_INPUT);
    const exitCode: number = await subprocess.exited;
    await terminalClosed.promise;
    return { exitCode, stdout: output + decoder.decode(), stderr: "" };
  } finally {
    subprocess.terminal?.close();
  }
}
