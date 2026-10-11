import { afterAll, beforeEach } from "bun:test";
import { adoptTimeZone, getTimeZone } from "../../packages/config/time";
import { TOKYO_TIME_ZONE } from "../../packages/consts/time";

/**
 * 夹具时刻写成 `…+09:00`、按东京日界断言的用例文件在顶层调用一次：每条用例前接管
 * TOKYO_TIME_ZONE，文件结束后换回 preload 接管的部署时区。东京没有夏令时，`+09:00` 恒等于
 * 该时区的偏移，断言因此不随 config_example 的 time_zone 改动；用例中途切到别的时区也不用自行复位。
 */
export function installTokyoFixtureTimeZone(): void {
  const preloaded: string = getTimeZone();
  beforeEach((): void => {
    adoptTimeZone(TOKYO_TIME_ZONE);
  });
  afterAll((): void => {
    adoptTimeZone(preloaded);
  });
}
