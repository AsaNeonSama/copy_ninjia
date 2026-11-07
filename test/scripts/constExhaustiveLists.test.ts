import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type ts from "typescript";
import {
  collectConstExhaustiveListProblems,
  PARTIAL_LITERAL_TABLES,
} from "../../scripts/conventions/constExhaustiveLists";
import { exportedConstDeclarations } from "../../scripts/conventions/constsProgram";
import { MINI_APP_FRONTEND_CONSTS_ROOT } from "../../scripts/conventions/miniAppFrontend";
import { CONSTS_ROOT_PREFIXES } from "../../scripts/conventions/moduleBoundaries";
import { createTypeCheckProgram } from "../../scripts/conventions/sourceAnalysis";
import type { ExportedConstDeclaration } from "../../scripts/conventions/constsProgram";

const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");
const REACTIONS: string = join(PROJECT_ROOT, "packages", "consts", "aiChat", "reactions.ts");
const AGENT: string = join(PROJECT_ROOT, "packages", "consts", "agent.ts");
const BLOCKLIST: string = join(PROJECT_ROOT, "packages", "consts", "antiRaid", "blocklist.ts");
const FIXTURE_DIR: string = mkdtempSync(join(tmpdir(), "const-exhaustive-lists-"));
const FIXTURE: string = join(FIXTURE_DIR, "fixture.ts");
await Bun.write(FIXTURE, [
  `import { exhaustiveList } from ${JSON.stringify(join(PROJECT_ROOT, "packages", "consts", "exhaustiveList"))};`,
  "type Fruit = \"apple\" | \"pear\" | \"plum\";",
  "const PLUM: Fruit = \"plum\";",
  "export const COMPLETE: readonly Fruit[] = exhaustiveList<Fruit>()([\"apple\", \"pear\", \"plum\"]);",
  "export const NARROWED: readonly Fruit[] = exhaustiveList<\"apple\" | \"pear\">()([\"apple\", \"pear\"]);",
  "export const SPREAD: readonly Fruit[] = exhaustiveList<Fruit>()([...([\"apple\", \"pear\", \"plum\"] as const)]);",
  "export const ASSERTED: readonly Fruit[] = exhaustiveList<Fruit>()([\"apple\", \"pear\", \"plum\" as Fruit]);",
  "export const VARIABLE: readonly Fruit[] = exhaustiveList<Fruit>()([\"apple\", \"pear\", PLUM]);",
  "export const TUPLE: readonly [Fruit, Fruit] = [\"apple\", \"pear\"];",
  "",
].join("\n"));
const FILES: readonly string[] = [REACTIONS, AGENT, BLOCKLIST, FIXTURE];
const PROGRAM: ts.Program = createTypeCheckProgram(PROJECT_ROOT, FILES);

afterAll((): void => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function problemsWith(files: readonly string[], partialTables: ReadonlyMap<string, string>): string[] {
  return collectConstExhaustiveListProblems({
    projectRoot: PROJECT_ROOT,
    checker: PROGRAM.getTypeChecker(),
    declarations: exportedConstDeclarations(PROGRAM, files),
    partialTables,
  });
}

describe("字面量联合的全集表必须经 exhaustiveList 构造", () => {
  test("现有登记下这几份 consts 没有问题：经 exhaustiveList 的表通过，单字面量元素的元组不报", () => {
    expect(problemsWith([REACTIONS, AGENT, BLOCKLIST], PARTIAL_LITERAL_TABLES)).toEqual([]);
  });

  test("未登记的子集表逐个报出", () => {
    const problems: string[] = problemsWith([REACTIONS, AGENT, BLOCKLIST], new Map<string, string>());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("AI_REACTION_EMOJIS lists members of a literal union");
  });

  test("登记了却已不是待豁免的表时报废弃登记；登记按路径区分同名表", () => {
    const agentKey: string = `${relative(PROJECT_ROOT, AGENT)}#AGENT_PROVIDERS`;
    const otherFileKey: string = `${relative(PROJECT_ROOT, AGENT)}#AI_REACTION_EMOJIS`;
    const problems: string[] = problemsWith([REACTIONS, AGENT, BLOCKLIST], new Map<string, string>([
      ...PARTIAL_LITERAL_TABLES,
      [agentKey, "已经经 exhaustiveList 构造"],
      [otherFileKey, "别的文件里没有这张表"],
    ]));
    const roots: string = CONSTS_ROOT_PREFIXES.join(" or ");
    expect(problems).toEqual([
      `PARTIAL_LITERAL_TABLES registers ${agentKey}, which is no longer a literal-union table listed without exhaustiveList in ${roots}; remove the entry`,
      `PARTIAL_LITERAL_TABLES registers ${otherFileKey}, which is no longer a literal-union table listed without exhaustiveList in ${roots}; remove the entry`,
    ]);
  });

  test("类型实参与声明的元素类型不一致、实参含展开、类型断言或变量时都不算经 exhaustiveList 构造；元组不在范围内", () => {
    const problems: string[] = problemsWith([FIXTURE], new Map<string, string>());
    const flagged: string[] = ["COMPLETE", "NARROWED", "SPREAD", "ASSERTED", "VARIABLE", "TUPLE"]
      .filter((name: string): boolean => problems.some((problem: string): boolean => problem.includes(` ${name} lists`)));
    expect(flagged).toEqual(["NARROWED", "SPREAD", "ASSERTED", "VARIABLE"]);
  });

  test("前端常量目录里的字面量联合表违规时提示导入 packages/mini-app-frontend/consts/exhaustiveList.ts", () => {
    const narrowDecl: ExportedConstDeclaration = exportedConstDeclarations(
      PROGRAM,
      [FIXTURE]
    ).find(
      ({ name }: ExportedConstDeclaration): boolean => name === "NARROWED"
    )!;
    const frontendPath: string = join(PROJECT_ROOT, MINI_APP_FRONTEND_CONSTS_ROOT, "miniApp.ts");
    const problems: string[] = collectConstExhaustiveListProblems({
      projectRoot: PROJECT_ROOT,
      checker: PROGRAM.getTypeChecker(),
      declarations: [{ ...narrowDecl, path: frontendPath }],
      partialTables: new Map<string, string>(),
    });
    expect(problems).toEqual([
      expect.stringContaining(
        `${MINI_APP_FRONTEND_CONSTS_ROOT}miniApp.ts: NARROWED lists members of a literal union; build it with ` +
        `exhaustiveList<U>()([...]) from ${MINI_APP_FRONTEND_CONSTS_ROOT}exhaustiveList.ts`
      ),
    ]);
  });
});
