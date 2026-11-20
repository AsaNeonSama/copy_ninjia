import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { LOGGER_HTTP_URL_PATTERN, LOGGER_SENSITIVE_FIELD_NAMES } from "../../packages/consts/logger";
import { REDACTED_SECRET } from "../../packages/consts/redaction";
import {
  createLogRedactionReplacer,
  redactSensitiveFieldsInText,
} from "../../packages/infra/logger/redaction";
import { redactUrlForLog } from "../../packages/libs/redaction";
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

  test("无分隔符干净日志原样返回，无冒号纯等号与等号先于冒号、密集冒号与 URL 均准确脱敏", () => {
    const clean: string = "plain log message without separators 12345";
    expect(redactSensitiveFieldsInText(clean)).toBe(clean);

    const equalsOnlySafe: string = "count=12&status=ok&mode=fast";
    expect(redactSensitiveFieldsInText(equalsOnlySafe)).toBe(equalsOnlySafe);
    expect(redactSensitiveFieldsInText("mode=fast\npassword=top-secret-1\nnext=ok"))
      .toBe(`mode=fast\npassword=${REDACTED_SECRET}\nnext=ok`);

    // 等号先于冒号（含敏感等号后接带凭据 URL 与敏感冒号）
    const equalsBeforeColon: string =
      "ok=1 password=secret-a\nfetch https://alice:pass@cdn.example/a.png?sig=xyz#frag\ntoken: \"secret-b\"";
    expect(redactSensitiveFieldsInText(equalsBeforeColon)).toBe(
      `ok=1 password=${REDACTED_SECRET}\nfetch https://cdn.example/a.png\ntoken: ${REDACTED_SECRET}`
    );

    // 密集 JSON 冒号（大量非敏感键夹杂少量敏感键与带查询串 URL）
    const denseParts: string[] = [];
    for (let index: number = 0; index < 80; index += 1) {
      denseParts.push(`"field_${index}":${index}`);
    }
    denseParts.splice(25, 0, "\"api_key\":\"dense-secret-1\"");
    denseParts.splice(60, 0, "\"endpoint\":\"https://u:p@api.example/v1?key=leak\"");
    denseParts.push("\"refresh-token\":[\"dense-secret-2\",\"dense-secret-3\"]");
    const denseJson: string = `{${denseParts.join(",")}}`;
    const redactedDense: string = redactSensitiveFieldsInText(denseJson);
    expect(redactedDense).not.toContain("dense-secret-1");
    expect(redactedDense).not.toContain("dense-secret-2");
    expect(redactedDense).not.toContain("dense-secret-3");
    expect(redactedDense).not.toContain("key=leak");
    expect(redactedDense).toContain(`"api_key":${REDACTED_SECRET}`);
    expect(redactedDense).toContain("\"endpoint\":\"https://api.example/v1\"");
    expect(redactedDense).toContain(`"refresh-token":${REDACTED_SECRET}`);

    // 尾部只有空白的敏感字段分隔符与内嵌 URL 被整段脱敏
    expect(redactSensitiveFieldsInText("password:   ")).toBe("password:   ");
    expect(redactSensitiveFieldsInText("token=https://user:pass@host.example/p?q=1"))
      .toBe(`token=${REDACTED_SECRET}`);
  });

  test("双游标 indexOf 与逐字符扫描在随机结构化日志样本上逐字一致", () => {
    const keys: readonly string[] = [
      "id", "status", "message", "endpoint", "token", "password", "api_key", "set-cookie", "authorization", "x-request-id",
    ];
    const values: readonly string[] = [
      "\"plain\"",
      "\"with:colon=and\\\"quote\\\"\"",
      "12345",
      "{\"nested\":\"v:1=2\",\"k\":\"x\"}",
      "[\"a:b\",\"c=d\"]",
      "bare-secret-val",
      "\"https://u:p@example.com/path?a=1#h\"",
    ];
    const sensitive: ReadonlySet<string> = new Set<string>(LOGGER_SENSITIVE_FIELD_NAMES);
    const isName = (c: number): boolean =>
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x2d || c === 0x5f || (c >= 0x61 && c <= 0x7a);
    const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
    const reference = (text: string): string => {
      let i: number = 0;
      let copyFrom: number = 0;
      let out: string = "";
      let changed: boolean = false;
      while (i < text.length) {
        const c: number = text.charCodeAt(i);
        if (c !== 0x3a && c !== 0x3d) {
          i += 1;
          continue;
        }
        const sep: number = i;
        i += 1;
        let end: number = sep;
        while (end > 0 && isWs(text.charCodeAt(end - 1))) end -= 1;
        if (end > 0 && (text.charCodeAt(end - 1) === 0x22 || text.charCodeAt(end - 1) === 0x27)) end -= 1;
        let start: number = end;
        while (start > 0 && isName(text.charCodeAt(start - 1))) start -= 1;
        if (!sensitive.has(text.slice(start, end).toLowerCase())) continue;
        let vStart: number = i;
        while (vStart < text.length && isWs(text.charCodeAt(vStart))) vStart += 1;
        if (vStart >= text.length) break;
        let vEnd: number = vStart;
        const open: number = text.charCodeAt(vStart);
        if (open === 0x22 || open === 0x27) {
          let esc: boolean = false;
          vEnd = text.length;
          for (let j: number = vStart + 1; j < text.length; j += 1) {
            const ch: number = text.charCodeAt(j);
            if (esc) esc = false;
            else if (ch === 0x5c) esc = true;
            else if (ch === open) { vEnd = j + 1; break; }
          }
        } else if (open === 0x5b || open === 0x7b) {
          let sq: number = 0;
          let ob: number = 0;
          let q: number = 0;
          let esc: boolean = false;
          vEnd = text.length;
          for (let j: number = vStart; j < text.length; j += 1) {
            const ch: number = text.charCodeAt(j);
            if (q !== 0) {
              if (esc) esc = false;
              else if (ch === 0x5c) esc = true;
              else if (ch === q) q = 0;
              continue;
            }
            if (ch === 0x22 || ch === 0x27) q = ch;
            else if (ch === 0x5b) sq += 1;
            else if (ch === 0x5d) sq -= 1;
            else if (ch === 0x7b) ob += 1;
            else if (ch === 0x7d) ob -= 1;
            if (sq === 0 && ob === 0) { vEnd = j + 1; break; }
          }
        } else {
          while (vEnd < text.length && text.charCodeAt(vEnd) !== 0x0a && text.charCodeAt(vEnd) !== 0x0d) vEnd += 1;
        }
        out += text.slice(copyFrom, vStart) + REDACTED_SECRET;
        changed = true;
        copyFrom = vEnd;
        i = vEnd;
      }
      const sanitized: string = changed ? out + text.slice(copyFrom) : text;
      return sanitized.includes("://") && (sanitized.includes("?") || sanitized.includes("#") || sanitized.includes("@"))
        ? sanitized.replace(LOGGER_HTTP_URL_PATTERN, redactUrlForLog)
        : sanitized;
    };

    let seed: number = 0x1234_5678;
    const nextInt = (max: number): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % max;
    };
    for (let sample: number = 0; sample < 200; sample += 1) {
      const mode: number = sample % 4;
      const parts: string[] = [];
      const count: number = 1 + nextInt(8);
      for (let idx: number = 0; idx < count; idx += 1) {
        if (mode === 0) {
          parts.push(`word_${nextInt(100)}`);
        } else {
          const key: string = keys[nextInt(keys.length)]!;
          const sep: string = mode === 1 ? "=" : mode === 2 ? ":" : nextInt(2) === 0 ? ":" : "=";
          const val: string = values[nextInt(values.length)]!;
          const quote: string = sep === ":" && nextInt(2) === 0 ? "\"" : "";
          parts.push(`${quote}${key}${quote}${sep}${nextInt(2) === 0 ? " " : ""}${val}`);
        }
      }
      const text: string = parts.join(mode === 0 ? " " : nextInt(2) === 0 ? "\n" : ", ");
      expect(redactSensitiveFieldsInText(text)).toBe(reference(text));
    }
  });
});
