/**
 * 入群验证算术题生成：四种运算都可能出现，操作数不越界，减法非负、除法整除，按钮选项互不相同、
 * 非负且恰好包含一次正确答案，所有选项都能通过主线程 callback_data 的选项数值校验。
 */

import { expect, test } from "bun:test";
import {
  VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD,
  VERIFICATION_CHALLENGE_OPERAND_MAX,
  VERIFICATION_CHALLENGE_OPERAND_MIN,
  VERIFICATION_CHALLENGE_OPERATORS,
  VERIFICATION_CHALLENGE_OPTION_COUNT,
  VERIFY_ANSWER_ARG_PATTERN,
} from "../../../packages/consts/antiRaid/verification";
import { createVerificationChallenge } from "../../../packages/workers/antiRaid/verificationChallenge";
import type { VerificationChallenge, VerificationChallengeOperator } from "../../../packages/types/antiRaid/verification";

const QUESTION_PATTERN: RegExp = /^(\d+) ([+\-×÷]) (\d+)$/;
const SAMPLE_COUNT: number = 10_000;

/** 固定种子的线性同余随机数，返回 [0, 1)。 */
function seededRandom(seed: number): () => number {
  let state: number = seed;
  return (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** 高位混合的 32 位伪随机源，避免模幂相关影响偏移卡方检验。 */
function splitMix32Random(seed: number): () => number {
  let state: number = seed >>> 0;
  return (): number => {
    state = (state + 0x9e37_79b9) >>> 0;
    let mixed: number = state ^ (state >>> 16);
    mixed = Math.imul(mixed, 0x21f0_aaad);
    mixed = mixed ^ (mixed >>> 15);
    mixed = Math.imul(mixed, 0x735a_2d97);
    return ((mixed ^ (mixed >>> 15)) >>> 0) / 4_294_967_296;
  };
}

/** 按题面重新计算答案，并返回运算符与两个操作数。 */
function evaluate(question: string): { operator: VerificationChallengeOperator; left: number; right: number; value: number } {
  const match: RegExpExecArray | null = QUESTION_PATTERN.exec(question);
  if (match === null) throw new Error(`unexpected question: ${question}`);
  const left: number = Number(match[1]);
  const operator: VerificationChallengeOperator = match[2] as VerificationChallengeOperator;
  const right: number = Number(match[3]);
  switch (operator) {
    case "+": return { operator, left, right, value: left + right };
    case "-": return { operator, left, right, value: left - right };
    case "×": return { operator, left, right, value: left * right };
    case "÷": return { operator, left, right, value: left / right };
  }
}

test("干扰项候选范围足以在答案为 0 时凑满选项", () => {
  expect(VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD).toBeGreaterThanOrEqual(VERIFICATION_CHALLENGE_OPTION_COUNT - 1);
});

/**
 * 列出一道题违反的不变量；全部满足时返回空数组。
 * @param challenge 待检查的算术题。
 * @returns 违反项的说明列表。
 */
function challengeViolations(challenge: VerificationChallenge): string[] {
  const violations: string[] = [];
  const { operator, left, right, value } = evaluate(challenge.question);
  if (value !== challenge.answer) violations.push("answer does not match question");
  if (!Number.isInteger(challenge.answer) || challenge.answer < 0) violations.push("answer is not a non-negative integer");
  for (const operand of [left, right]) {
    if (operand < VERIFICATION_CHALLENGE_OPERAND_MIN || operand > VERIFICATION_CHALLENGE_OPERAND_MAX) {
      violations.push(`operand ${operand} out of range for ${operator}`);
    }
  }
  if (challenge.options.length !== VERIFICATION_CHALLENGE_OPTION_COUNT) violations.push("wrong option count");
  if (new Set(challenge.options).size !== challenge.options.length) violations.push("duplicate options");
  if (challenge.options.filter((option: number): boolean => option === challenge.answer).length !== 1) {
    violations.push("answer is not listed exactly once");
  }
  for (const option of challenge.options) {
    if (!Number.isInteger(option) || option < 0) violations.push(`option ${option} is not a non-negative integer`);
    if (Math.abs(option - challenge.answer) > VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD) violations.push(`option ${option} too far from answer`);
    if (!VERIFY_ANSWER_ARG_PATTERN.test(String(option))) violations.push(`option ${option} rejected by callback pattern`);
  }
  return violations;
}

test("大量抽样下题面、答案与选项都满足不变量，四种运算与各答案位置都会出现", () => {
  const random: () => number = seededRandom(20_261_106);
  const seenOperators = new Set<VerificationChallengeOperator>();
  const answerPositions = new Set<number>();
  const violations: string[] = [];
  for (let index: number = 0; index < SAMPLE_COUNT; index++) {
    const challenge: VerificationChallenge = createVerificationChallenge(random);
    for (const violation of challengeViolations(challenge)) violations.push(`${challenge.question}: ${violation}`);
    seenOperators.add(evaluate(challenge.question).operator);
    answerPositions.add(challenge.options.indexOf(challenge.answer));
  }
  expect(violations).toEqual([]);
  expect([...seenOperators].sort()).toEqual([...VERIFICATION_CHALLENGE_OPERATORS].sort());
  expect(answerPositions.size).toBe(VERIFICATION_CHALLENGE_OPTION_COUNT);
});

test("答案的数值名次在可行名次里均匀抽取：下方候选不足时名次上限收窄，答案为 0 时恒为最小", () => {
  const random: () => number = seededRandom(20_261_107);
  const offsetRandom: () => number = splitMix32Random(20_261_107);
  const ranksByAnswer = new Map<number, number[]>();
  const lowerOffsets = new Map<number, number>();
  const upperOffsets = new Map<number, number>();
  const offsetSampleRounds: number = SAMPLE_COUNT * 4;
  for (let index: number = 0; index < offsetSampleRounds; index++) {
    if (index < SAMPLE_COUNT) {
      const challenge: VerificationChallenge = createVerificationChallenge(random);
      const rank: number = challenge.options.filter((option: number): boolean => option < challenge.answer).length;
      const key: number = Math.min(challenge.answer, VERIFICATION_CHALLENGE_OPTION_COUNT - 1);
      const counts: number[] = ranksByAnswer.get(key) ?? new Array<number>(VERIFICATION_CHALLENGE_OPTION_COUNT).fill(0);
      counts[rank] = (counts[rank] ?? 0) + 1;
      ranksByAnswer.set(key, counts);
    }
    const offsetChallenge: VerificationChallenge = createVerificationChallenge(offsetRandom);
    if (offsetChallenge.answer >= VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD) {
      for (const option of offsetChallenge.options) {
        if (option < offsetChallenge.answer) {
          const offset: number = offsetChallenge.answer - option;
          lowerOffsets.set(offset, (lowerOffsets.get(offset) ?? 0) + 1);
        } else if (option > offsetChallenge.answer) {
          const offset: number = option - offsetChallenge.answer;
          upperOffsets.set(offset, (upperOffsets.get(offset) ?? 0) + 1);
        }
      }
    }
  }
  for (const [answerKey, counts] of ranksByAnswer) {
    const total: number = counts.reduce((sum: number, count: number): number => sum + count, 0);
    const feasibleRanks: number = answerKey + 1;
    for (let rank: number = 0; rank < VERIFICATION_CHALLENGE_OPTION_COUNT; rank++) {
      const share: number = (counts[rank] ?? 0) / total;
      if (rank >= feasibleRanks) {
        expect(share).toBe(0);
      } else {
        expect(share).toBeGreaterThan(1 / feasibleRanks - 0.05);
        expect(share).toBeLessThan(1 / feasibleRanks + 0.05);
      }
    }
  }
  expect([...ranksByAnswer.keys()].sort()).toEqual(
    Array.from({ length: VERIFICATION_CHALLENGE_OPTION_COUNT }, (_: unknown, rank: number): number => rank)
  );
  const degreesOfFreedom: number = VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD - 1;
  const chiSquareCriticalBound: number =
    degreesOfFreedom *
    (1 - 2 / (9 * degreesOfFreedom) + 3.29 * Math.sqrt(2 / (9 * degreesOfFreedom))) ** 3;
  for (const offsetCounts of [lowerOffsets, upperOffsets]) {
    let total: number = 0;
    for (let offset: number = 1; offset <= VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD; offset++) {
      total += offsetCounts.get(offset) ?? 0;
    }
    expect(total).toBeGreaterThan(SAMPLE_COUNT);
    const expected: number = total / VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD;
    let chiSquare: number = 0;
    for (let offset: number = 1; offset <= VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD; offset++) {
      const diff: number = (offsetCounts.get(offset) ?? 0) - expected;
      chiSquare += (diff * diff) / expected;
    }
    expect(chiSquare).toBeLessThan(chiSquareCriticalBound);
  }
});

test("默认使用 Math.random，每次生成新的题目对象", () => {
  const first: VerificationChallenge = createVerificationChallenge();
  const second: VerificationChallenge = createVerificationChallenge();
  expect(first).not.toBe(second);
  expect(QUESTION_PATTERN.test(first.question)).toBeTrue();
});
