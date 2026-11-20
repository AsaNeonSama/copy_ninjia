import { describe, expect, test } from "bun:test";
import { cleanReply, isEmojiOnly } from "../../../../packages/workers/aiChat/ai/utils/replyText";

describe("isEmojiOnly", () => {
  test("含数字/井号/星号的正常回复不是纯表情", () => {
    // \p{Emoji_Component} 按 Unicode 定义包含 ASCII 0-9、#、*，这里验证它们
    // 不会被当成「允许出现的附属码点」而被误判成纯表情。
    for (const text of ["🎉2026", "🎂 30", "👍 #1", "😂233", "2026🎉年", "🎉abc"]) {
      expect(isEmojiOnly(text)).toBeFalse();
    }
  });

  test("纯 emoji（含肤色、ZWJ 组合、变体选择符、keycap）仍判为纯表情", () => {
    for (const text of ["👍", "👍🏻", "👨‍👩‍👦", "❤️", "😂😂😂", "👍 👍", "1️⃣", "1️⃣2️⃣"]) {
      expect(isEmojiOnly(text)).toBeTrue();
    }
  });

  test("旗帜（区域指示符）也算 emoji 本体", () => {
    // 区域指示符既不是 Extended_Pictographic、也不在附属码点里，需要单独判定。
    for (const text of ["🇯🇵", "👍🇯🇵", "🇯🇵🇺🇸", "🇯🇵 👍"]) {
      expect(isEmojiOnly(text)).toBeTrue();
    }
    // 旗帜混在正文里仍然不是纯表情。
    for (const text of ["日本🇯🇵", "🇯🇵 加油"]) {
      expect(isEmojiOnly(text)).toBeFalse();
    }
  });

  test("没有任何图形 emoji 的文本不是纯表情", () => {
    for (const text of ["", "   ", "abc", "1", "#", "233"]) {
      expect(isEmojiOnly(text)).toBeFalse();
    }
  });
});

describe("cleanReply 的引号剥离", () => {
  test("首尾引号分属两对时不剥：那会把正文两头各啃掉一个字", () => {
    // 剥完的字符串就是最终发进群里的正文。
    expect(cleanReply("「早安」和「晚安」")).toBe("「早安」和「晚安」");
    expect(cleanReply('"A"和"B"')).toBe('"A"和"B"');
    expect(cleanReply("“是”还是“否”")).toBe("“是”还是“否”");
  });

  test("真被一对引号包住时照常剥掉", () => {
    expect(cleanReply("「只是一句话」")).toBe("只是一句话");
    expect(cleanReply('"quoted"')).toBe("quoted");
    expect(cleanReply("“整句都在里面”")).toBe("整句都在里面");
    // 嵌套的内层引号不影响外层判定。
    expect(cleanReply("「他说「你好」了」")).toBe("他说「你好」了");
  });

  test("引号只在一头或嵌套未闭合时不动", () => {
    expect(cleanReply("他说「你好」")).toBe("他说「你好」");
    expect(cleanReply("「开头有")).toBe("「开头有");
    expect(cleanReply("「a「b」")).toBe("「a「b」");
    expect(cleanReply("“a“b”")).toBe("“a“b”");
  });
});

describe("cleanReply 的代码围栏剥离", () => {
  test("单个外层围栏（语言标记含数字、符号或行尾空白）照常剥离，开围栏行含多个词或中日文正文时按正文保留，多个围栏不误剥", () => {
    expect(cleanReply("```python3\nprint(1)\n```")).toBe("print(1)");
    expect(cleanReply("```\nhello\n```")).toBe("hello");
    expect(cleanReply("```python \nprint(1)\n```")).toBe("print(1)");
    expect(cleanReply("```c++\nint x;\n```")).toBe("int x;");
    expect(cleanReply("```shell-session\r\n$ ls\r\n```")).toBe("$ ls");
    expect(cleanReply("```hello```")).toBe("hello");
    expect(cleanReply("```两个 词\n正文\n```")).toBe("两个 词\n正文");
    expect(cleanReply("```哈哈哈\n第二行\n```")).toBe("哈哈哈\n第二行");
    expect(cleanReply("```今天也很开心呢\n```")).toBe("今天也很开心呢");
    const multiFence: string = "```js\na\n```\n中间\n```py\nb\n```";
    expect(cleanReply(multiFence)).toBe(multiFence);
  });
});
