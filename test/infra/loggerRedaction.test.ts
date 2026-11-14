import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { LOGGER_SENSITIVE_FIELD_NAMES } from "../../packages/consts/logger";
import { REDACTED_SECRET } from "../../packages/consts/redaction";
import {
  createLogRedactionReplacer,
  redactSensitiveFieldsInText,
} from "../../packages/infra/logger/redaction";
import type { LogRedactionReplacer } from "../../packages/types/logger";

describe("文本内嵌凭据字段的值边界", () => {
  test("引号值里的转义引号不提前结束扫描，密钥尾段不会漏出", () => {
    const text: string =
      "{\"authorization\":\"Bearer upstream-\\\"escaped-secret-1\",\"x-request-id\":\"visible-1\"}";

    const redacted: string = redactSensitiveFieldsInText(text);

    expect(redacted).toBe(`{"authorization":${REDACTED_SECRET},"x-request-id":"visible-1"}`);
    expect(redacted).not.toContain("escaped-secret-1");
  });

  test("容器值内嵌套对象与带转义引号的括号、逗号，整段替换到配平的右括号", () => {
    const text: string =
      "{\"set-cookie\":[{\"value\":\"cookie-\\\"],}secret-2\",\"attrs\":{\"path\":\"/\"}}]," +
      "\"x-request-id\":\"visible-2\"}";

    const redacted: string = redactSensitiveFieldsInText(text);

    expect(redacted).toBe(`{"set-cookie":${REDACTED_SECRET},"x-request-id":"visible-2"}`);
    expect(redacted).not.toContain("secret-2");
  });

  test("非 JSON 的裸值只替换到行尾，下一行诊断保持可读", () => {
    const secret: string = "upstream-bare-secret-3";
    const text: string =
      `upstream: Authorization: Bearer ${secret}\r\nx-request-id: visible-3\npassword=${secret}\nother: 1`;

    const redacted: string = redactSensitiveFieldsInText(text);

    expect(redacted).toBe(
      `upstream: Authorization: ${REDACTED_SECRET}\r\nx-request-id: visible-3\n` +
      `password=${REDACTED_SECRET}\nother: 1`
    );
    expect(redacted).not.toContain(secret);
  });

  test("引号或括号未闭合时脱敏到文本结尾", () => {
    expect(redactSensitiveFieldsInText("token=\"unterminated \\\" secret-4"))
      .toBe(`token=${REDACTED_SECRET}`);
    expect(redactSensitiveFieldsInText("cookie: [{\"name\":\"secret-5\"}, \"tail\""))
      .toBe(`cookie: ${REDACTED_SECRET}`);
  });

  test("isSensitiveLogField 的 switch 分支与敏感字段清单双向一致", async () => {
    const path: string = new URL("../../packages/infra/logger/redaction.ts", import.meta.url).pathname;
    const source: ts.SourceFile = ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true);
    const caseLabels: string[] = [];
    const visit = (node: ts.Node, inGuard: boolean): void => {
      const entering: boolean = inGuard ||
        (ts.isFunctionDeclaration(node) && node.name?.text === "isSensitiveLogField");
      if (entering && ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
        caseLabels.push(node.expression.text);
      }
      ts.forEachChild(node, (child: ts.Node): void => visit(child, entering));
    };
    visit(source, false);
    expect(caseLabels.length).toBeGreaterThan(0);
    expect(new Set(caseLabels).size).toBe(caseLabels.length);
    expect([...caseLabels].sort()).toEqual([...LOGGER_SENSITIVE_FIELD_NAMES].sort());
  });

  test("replacer 对全量敏感字段大小写无关脱敏", () => {
    const replacer: LogRedactionReplacer = createLogRedactionReplacer([]);
    for (const field of LOGGER_SENSITIVE_FIELD_NAMES) {
      const upper: string = field.toUpperCase();
      const mixed: string = field[0]!.toUpperCase() + field.slice(1);
      const encoded: string = JSON.stringify(
        { [field]: "v1", [upper]: "v2", [mixed]: "v3", ok: true, "x-proxy-authorization": "keep" },
        replacer
      );
      expect(JSON.parse(encoded)).toEqual({
        [field]: REDACTED_SECRET,
        [upper]: REDACTED_SECRET,
        [mixed]: REDACTED_SECRET,
        ok: true,
        "x-proxy-authorization": "keep",
      });
    }
  });
});
