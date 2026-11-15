/** `/batch_kick` 单次批次执行的各分类计数器与中断状态。 */
export interface BatchKickStats {
  /** 成功踢出（unban 解除封禁）的成员数。 */
  kicked: number;
  /** 探测或踢出时确认已不在群内的成员数。 */
  absent: number;
  /** 命中白名单保护而跳过的成员数。 */
  protected: number;
  /** 命中永久黑名单（跳过或补封成功）的成员数。 */
  blocked: number;
  /** 因缺少管理员权限或目标为群管理员而被 Telegram 拒绝的成员数。 */
  forbidden: number;
  /** 因探测/踢出/补封请求失败或未预期异常计入失败的成员数。 */
  failed: number;
  /**
   * blocked 中本命令未做任何处置、交还给黑名单流程的条数：processJoinRecord 里命中
   * 黑名单后直接返回的分支。只用来决定整批结束后是否请求一次补扫；补封成功的
   * 记录不计入。
   */
  blockedHandoffs: number;
  /** 真正进入处置的记录条数；身份策略读取失败中断时小于总条数。 */
  scanned: number;
  /** 是否因身份策略读取失败提前中断；true 时剩余记录未处理。 */
  aborted: boolean;
  /** 批次途中本群不再受管而停止；true 时不发战报。 */
  unmanaged: boolean;
}
