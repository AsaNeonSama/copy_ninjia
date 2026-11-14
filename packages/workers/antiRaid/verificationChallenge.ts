/**
 * 入群验证算术题的生成。纯函数：不读写缓存、不发请求；由 verificationReminders.ts 在首次登记
 * 真人成员的提醒投递时调用，结果挂在验证运行态条目上（见 types/antiRaid/internal.ts 的
 * VerificationEntry.challenge）。
 */

import {
  VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD,
  VERIFICATION_CHALLENGE_OPERAND_MAX,
  VERIFICATION_CHALLENGE_OPERAND_MIN,
  VERIFICATION_CHALLENGE_OPERATORS,
  VERIFICATION_CHALLENGE_OPTION_COUNT,
} from "../../consts/antiRaid/verification";
import type { VerificationChallenge, VerificationChallengeOperator } from "../../types/antiRaid/verification";

/**
 * 在闭区间内均匀抽取一个整数。
 * @param min 下限（含）。
 * @param max 上限（含），不小于 min。
 * @param random 返回 [0, 1) 的随机数函数。
 * @returns 抽中的整数。
 */
function randomIntInclusive(min: number, max: number, random: () => number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Fisher–Yates 原地均匀打乱。
 * @param items 待打乱的数组。
 * @param random 返回 [0, 1) 的随机数函数。
 */
function shuffleInPlace(items: number[], random: () => number): void {
  for (let index: number = items.length - 1; index > 0; index--) {
    const swapIndex: number = randomIntInclusive(0, index, random);
    const current: number | undefined = items[index];
    const swapped: number | undefined = items[swapIndex];
    if (current === undefined || swapped === undefined) continue;
    items[index] = swapped;
    items[swapIndex] = current;
  }
}

/** 一道题的题面与答案。 */
interface ChallengeEquation {
  readonly question: string;
  readonly answer: number;
}

/**
 * 按运算符出题。两个操作数都落在 [VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX]：
 * 减法的减数不大于被减数，结果非负；除法先抽除数与商，被除数取二者乘积且不超过上限，结果为整数。
 * @param operator 本题运算符。
 * @param random 返回 [0, 1) 的随机数函数。
 * @returns 题面与正确答案。
 */
function equationOf(operator: VerificationChallengeOperator, random: () => number): ChallengeEquation {
  switch (operator) {
    case "+": {
      const left: number = randomIntInclusive(VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX, random);
      const right: number = randomIntInclusive(VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX, random);
      return { question: `${left} + ${right}`, answer: left + right };
    }
    case "-": {
      const left: number = randomIntInclusive(VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX, random);
      const right: number = randomIntInclusive(VERIFICATION_CHALLENGE_OPERAND_MIN, left, random);
      return { question: `${left} - ${right}`, answer: left - right };
    }
    case "×": {
      const left: number = randomIntInclusive(VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX, random);
      const right: number = randomIntInclusive(VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX, random);
      return { question: `${left} × ${right}`, answer: left * right };
    }
    case "÷": {
      const divisor: number = randomIntInclusive(VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX, random);
      const quotient: number = randomIntInclusive(
        VERIFICATION_CHALLENGE_OPERAND_MIN,
        Math.floor(VERIFICATION_CHALLENGE_OPERAND_MAX / divisor),
        random
      );
      return { question: `${divisor * quotient} ÷ ${divisor}`, answer: quotient };
    }
    default: {
      const unhandledOperator: never = operator;
      throw new Error(`Unsupported verification challenge operator: ${String(unhandledOperator)}`);
    }
  }
}

/**
 * 用部分 Fisher–Yates 对 `items` 的前 `count` 个位置做无放回等概率抽样并原地交换就位。
 *
 * @param items 可变候选整数数组；前 `count` 项即为抽样结果。
 * @param count 需要抽取的前缀长度（`0 <= count <= items.length`）。
 * @param random 返回 `[0, 1)` 的随机数函数。
 */
function partialShufflePrefix(items: number[], count: number, random: () => number): void {
  for (let index: number = 0; index < count; index++) {
    const swapIndex: number = randomIntInclusive(index, items.length - 1, random);
    const current: number = items[index]!;
    items[index] = items[swapIndex]!;
    items[swapIndex] = current;
  }
}

/**
 * 生成一道入群验证算术题：等概率抽运算符出题，再定答案在选项里的数值名次（比它小的干扰项个数），
 * 名次在可行范围内均匀抽取。下方干扰项取自 `answer - VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD…answer - 1`
 * 中不小于 0 的整数，上方取自 `answer + 1…answer + VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD`，
 * 两侧各自用部分 Fisher–Yates 均匀抽满名次与剩余干扰位；最后与正确答案一起打乱成 VERIFICATION_CHALLENGE_OPTION_COUNT 个按钮选项。
 * 答案小于 VERIFICATION_CHALLENGE_OPTION_COUNT - 1 时下方候选不足，名次上限随之收窄（答案为 0 时只能最小）。
 * @param random 返回 [0, 1) 的随机数函数，默认 Math.random。
 * @returns 新生成的算术题。
 */
export function createVerificationChallenge(random: () => number = Math.random): VerificationChallenge {
  const operator: VerificationChallengeOperator | undefined = VERIFICATION_CHALLENGE_OPERATORS[
    randomIntInclusive(0, VERIFICATION_CHALLENGE_OPERATORS.length - 1, random)
  ];
  if (operator === undefined) throw new Error("Verification challenge operator table is empty.");
  const { question, answer }: ChallengeEquation = equationOf(operator, random);
  const lower: number[] = [];
  const upper: number[] = [];
  for (let offset: number = 1; offset <= VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD; offset++) {
    upper.push(answer + offset);
    if (answer - offset >= 0) lower.push(answer - offset);
  }
  const distractorCount: number = VERIFICATION_CHALLENGE_OPTION_COUNT - 1;
  const rank: number = randomIntInclusive(
    Math.max(0, distractorCount - upper.length),
    Math.min(lower.length, distractorCount),
    random
  );
  partialShufflePrefix(lower, rank, random);
  partialShufflePrefix(upper, distractorCount - rank, random);
  const options: number[] = [];
  for (let index: number = 0; index < rank; index++) options.push(lower[index]!);
  for (let index: number = 0; index < distractorCount - rank; index++) options.push(upper[index]!);
  options.push(answer);
  shuffleInPlace(options, random);
  return { question, answer, options };
}
