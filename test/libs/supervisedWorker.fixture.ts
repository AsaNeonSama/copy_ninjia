/**
 * `superviseWorker` 测试专用的轻量 Worker 入口：支持回显消息与按指令主动崩溃。
 */

export type SupervisedWorkerFixtureCommand =
  | { type: "crash" }
  | { type: "echo"; value: string };

export interface SupervisedWorkerFixtureReply {
  type: "echo";
  value: string;
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<SupervisedWorkerFixtureCommand>) => {
  if (event.data.type === "crash") {
    throw new Error("planned supervised Worker crash");
  }
  self.postMessage({
    type: "echo",
    value: event.data.value,
  } satisfies SupervisedWorkerFixtureReply);
};
