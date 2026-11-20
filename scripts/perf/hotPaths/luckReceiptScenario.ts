import type { MessageEntity } from "grammy/types";
import { confirmLuckDraw } from "../../../packages/commands/luckChallenge/receipt";
import type { Scenario } from "./types";

/** 运势回执快路径场景复用的空实体列表常量。 */
const LUCK_RECEIPT_EMPTY_ENTITIES: readonly MessageEntity[] = [];

/** 运势回执快路径场景复用的非空非链接实体列表常量。 */
const LUCK_RECEIPT_NON_EMPTY_ENTITIES: readonly MessageEntity[] = [
  { type: "bold", offset: 0, length: 4 },
];

/** 混合文本形态与实体列表的运势回执快路径样本（覆盖缺实体短路与有实体文本解析）。 */
interface LuckReceiptFastPathInput {
  readonly text: string;
  readonly entities: readonly MessageEntity[] | undefined;
}

/** 普通消息回执快路径输入；轮换无实体、空实体与携带普通实体的多行文本。 */
const LUCK_RECEIPT_FAST_PATH_INPUTS: readonly LuckReceiptFastPathInput[] = [
  { text: "ordinary message", entities: undefined },
  { text: "普通聊天消息", entities: LUCK_RECEIPT_EMPTY_ENTITIES },
  { text: "first line\nsecond ordinary line", entities: LUCK_RECEIPT_NON_EMPTY_ENTITIES },
  { text: "short", entities: LUCK_RECEIPT_NON_EMPTY_ENTITIES },
];

/**
 * 每条带正文 update 都会经过的运势回执同步拒绝路径（兼顾缺实体短路与携带实体时的行扫描）。
 *
 * @returns 运势回执快路径拒绝场景定义
 */
export function createLuckReceiptFastPathScenario(): Scenario {
  return {
    iterations: 2_000_000,
    run: (iterations: number): number => {
      let checksum: number = 0;
      const length: number = LUCK_RECEIPT_FAST_PATH_INPUTS.length;
      for (let index: number = 0; index < iterations; index += 1) {
        const entry: LuckReceiptFastPathInput = LUCK_RECEIPT_FAST_PATH_INPUTS[index % length]!;
        const confirmation: Promise<void> | undefined = confirmLuckDraw(
          entry.text,
          entry.entities
        );
        if (confirmation !== undefined) checksum += 1;
        checksum += entry.text.length;
      }
      return checksum;
    },
    probes: { confirmLuckDraw },
  };
}
