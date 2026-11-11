import { describe, expect, test } from "bun:test";
import { AD_REFERENCE_WARNING_WINDOW_MS } from "../../packages/consts/antiRaid/adDetect";
import {
  cancelsReferencedAdWarning,
  commitReferencedAdWarning,
  referencedAdWarningWindow,
} from "../../packages/states/adReferenceWarning";
import type { ReferencedAdWarningState } from "../../packages/types/states/adReferenceWarning";

describe("引用类广告警告状态纯归约", () => {
  test("commitReferencedAdWarning 仅在同代 sending 时提交为 warned，其余情形原样返回原引用", () => {
    const sendingGen3: ReferencedAdWarningState = { phase: "sending", generation: 3 };
    const committed: ReferencedAdWarningState | undefined = commitReferencedAdWarning(
      sendingGen3,
      3,
      10_000
    );
    expect(committed).toEqual({
      phase: "warned",
      generation: 3,
      warnedAt: 10_000,
      expiresAt: 10_000 + AD_REFERENCE_WARNING_WINDOW_MS,
    });

    // 代次不匹配、无条目或已处于 warned 时原样返回原引用
    expect(commitReferencedAdWarning(sendingGen3, 2, 10_000)).toBe(sendingGen3);
    expect(commitReferencedAdWarning(undefined, 3, 10_000)).toBeUndefined();
    expect(commitReferencedAdWarning(committed, 3, 20_000)).toBe(committed);
  });

  test("cancelsReferencedAdWarning 仅命中同代 sending", () => {
    const sendingGen5: ReferencedAdWarningState = { phase: "sending", generation: 5 };
    const warnedGen5: ReferencedAdWarningState = {
      phase: "warned",
      generation: 5,
      warnedAt: 1_000,
      expiresAt: 1_000 + AD_REFERENCE_WARNING_WINDOW_MS,
    };

    expect(cancelsReferencedAdWarning(sendingGen5, 5)).toBeTrue();
    expect(cancelsReferencedAdWarning(sendingGen5, 4)).toBeFalse();
    expect(cancelsReferencedAdWarning(warnedGen5, 5)).toBeFalse();
    expect(cancelsReferencedAdWarning(undefined, 5)).toBeFalse();
  });

  test("referencedAdWarningWindow 区分非警告态、有效窗口内、到期边界与墙钟回拨", () => {
    const warned: ReferencedAdWarningState = {
      phase: "warned",
      generation: 1,
      warnedAt: 5_000,
      expiresAt: 5_000 + AD_REFERENCE_WARNING_WINDOW_MS,
    };
    const sending: ReferencedAdWarningState = { phase: "sending", generation: 1 };

    // 非 warned 状态返回 none
    expect(referencedAdWarningWindow(undefined, 5_000)).toBe("none");
    expect(referencedAdWarningWindow(sending, 5_000)).toBe("none");

    // 窗口起点与上界前一毫秒处于 active
    expect(referencedAdWarningWindow(warned, 5_000)).toBe("active");
    expect(
      referencedAdWarningWindow(warned, 5_000 + AD_REFERENCE_WARNING_WINDOW_MS - 1)
    ).toBe("active");

    // 到期边界（at === expiresAt）与超时均为 stale
    expect(
      referencedAdWarningWindow(warned, 5_000 + AD_REFERENCE_WARNING_WINDOW_MS)
    ).toBe("stale");
    expect(
      referencedAdWarningWindow(warned, 5_000 + AD_REFERENCE_WARNING_WINDOW_MS + 1)
    ).toBe("stale");

    // 墙钟回拨（at < warnedAt）同样视为 stale
    expect(referencedAdWarningWindow(warned, 4_999)).toBe("stale");
  });
});
