# 04 · ロックダウンミラーと終端フラグ

[简体中文](../cn/04-lockdown-invariants.md) · [English](../en/04-lockdown-invariants.md) · [日本語](../ja/04-lockdown-invariants.md)

[← 04 実行時の正式な不変条件](04-invariants.md)

- **ロックダウン指紋と意図（Intent）の同一性**：
  - ロックダウンの永続化ハンドシェイクで使用する指紋（`lockdownFingerprint`）は、`phase`、`intentId`、`announced` で構成されます。
  - `phase` と `intentId` は特定のロックダウン意図の同一性を識別します。
  - `announced` はクラッシュ復旧後に解除アナウンスを送信するかを決定し、永続化の ACK はこのフィールドをカバーします。
  - 遅延して届いた結果が現在の意図に属するかを緊急権限復旧が判定する際は、`phase` と `intentId` のみを照合します。
  - いずれの指紋にも `expiresAt` を含めてはなりません。

- **カウントダウンと照合ループ**：
  - カウントダウンタイマーはミラーの `expiresAt` に保持され、状態の引き継ぎ（adopt）時にそこから `remainingMs` が算出されます。
  - 永続化の照合ループは最大 `LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS` 周回までに制限されます。
  - 永続化の実行中に新たなイベントが到着した場合は再実行待ちフラグがセットされます。
  - 周回上限に達した場合、実行中のタスクはエラーログを出力してマイクロタスクを一度譲渡し、その後に最新ミラーから自動的に新規タスクを開始します（外部イベントを待ちません）。

- **メインスレッドによる緊急引き継ぎ**：
  - Anti-Raid Worker が自己修復を断念した場合、メインスレッドの `recoverAbandonedLockdowns` はスナップショットのクローンを行わず、チャット状態のインメモリキャッシュ（`cache/main/chatState.ts` の `chatStateCache`）を直接走査します（特定の走査順序には依存しません）。
  - 復旧パイプラインは最初の `await` より前に各グループのエントリを同期的に読み取ります。ロックダウン中のグループは 1 回のみ処理され、引き継ぎジャーナルにも 1 回のみ記録されます。
  - 同一グループの復旧タスクがすでに登録済みであり、かつ `phase` と `intentId` が一致している場合、`startEmergencyLockdownRecovery` は即座に復帰します。異なる意図が検知された場合は、古い復旧処理を破棄した上で新規に開始します。

- **グループが既に存在しない場合のミラー放棄**：
  - teardown 理由が `gone` のとき、Anti-Raid Worker は `chatGone` イベントで該当グループの非公開モードを放棄します。状態を削除し、復元タイマーと再試行タイマーを解除し、Telegram を呼ばずに `unlock` のみを報告します。メインスレッドは `unlock` を受けて `lockdown` ミラーを消去し、バックグラウンドで永続化します。それ以前に処理中だった `lockdown` 報告が先に、`unlock` が後に届くため、ミラーは最終的に空になります。メインスレッドがすでに該当グループの緊急復旧を引き継いでいる場合は、`abandonEmergencyLockdownRecovery` が同期的に復旧タスクを破棄して `lockdown` ミラーを消去します。
  - 放棄後に遅れて届いた権限呼び出しの結果は空の状態に当たり、状態を進めません。`departed` を含むほかの理由では、引き続き永続化優先の復元経路を通ります。
- **ミラー検証と省略可能フィールド**：
  - 有効なロックダウンミラーには `phase` と正の整数 `intentId` が必須です。`announcementMessageId` は `announced` が `true` のときに限り、かつ必ず存在します。
  - 参加認証のスナップショットには `phase` と `trackedMessageTimes`（最大 `ANTI_RAID_PER_MINUTE_LIMIT` 件）が必須です。
  - `reminderMessageId`、`replyReminderMessageId`、`announcementMessageId` は任意（optional）であり、`kickPending` では両リマインダー ID は存在してはなりません。
  - `pending` フェーズでは `replyReminderRequested`、`reminderSuperseded`、`welcomeAnchorMessageId` の有無がすべて真かすべて偽で、それ以外のフェーズは空の `trackedMessageTimes`、`invitedBy` なし、`replyReminderRequested: false`、`welcomeAnchorMessageId` なし、`reminderSuperseded: true` でなければなりません。`expelling` の通知・確認フラグ（`successNoticeSent`、`failureNoticeSent`、`unconfirmedNoticeSent`、`removalConfirmed`）は省略か `true` のみを受け付けます。
  - それ以外の未定義フィールドや形式不一致は厳格なデコードで拒否されます。旧バージョンのデータはオフラインで手動マイグレーションする必要があり、本番の読み込みパスに後方互換用フォールバックロジックを残してはなりません。

- **終端通知の独立した永続化フラグ**：
  - `successNoticeSent`：キックおよび処置の成功報告が配信済みであることを記録。
  - `failureNoticeSent`：キックの失敗または `can_restrict_members` 権限の不足を記録。
  - `unconfirmedNoticeSent`：メンバーの在籍またはチャット種別が確認不能であったことを記録。
  - いずれの通知も、メインスレッドが送信成功後に `COMMAND_MESSAGE_AUTO_DELETE_MS` で自動削除します。
  - 各フラグは、Worker 再起動やプロセス再起動を挟んだ場合でも同一通知が重複送信されるのを防止します。フラグはステートマシンのイベント（`expelNoticeSent`、`removalConfirmed`）で書き込み、通知の `await` が終わった時点でまだ現在の終端状態であるエントリにのみ適用します。フラグの更新は新しい revision を発行し、終端のリトライループはその永続化完了を待機します。

- **キック確認と処置報告のアトミック性**：
  - **キック自体は成功したものの処置報告の送信に失敗した場合、その処理を完了扱いにしてはなりません。**
  - スナップショットに `removalConfirmed` を記録した上でバックオフを挟んでリトライします。次回のメンバー確認でグループ不在が返された際、このフラグに基づき Bot 自身がキックを完了させたと判定し、処置報告の再送を継続します。
  - `removalConfirmed` は処置報告の送信に失敗したときのみ永続化されます。

- **BAN 権限不足時の短絡（ショートサーキット）**：
  - `botCanRestrictIn` が `false` の場合、`failureNoticeSent` と `cleanupSettled` の両方が `true` のときにのみ短絡します。このときも各サイクルで在室照会を 1 回送り、退出済みなら精算し、在室ならバックオフを続けます。
  - 私密モードの即時キック（`kickPending`）も BAN 権限がない場合はまず在室を照会します。退出済みなら精算してその記録を解放し、在室ならログを残してキック要求を送らずにバックオフします。
  - `cleanupSettled` が `false` の間は、処置サイクル全体を通常通り実行します（キックは `canRestrict` により、処置報告は `failureNoticeSent` により、メッセージ削除は `can_delete_messages` 不足時にスキップされ、実行可能で再試行が必要な削除タスクのみがリクエストを発行します）。
  - `cleanupSettled` は Worker の実行時エントリー（`VerificationEntry`）に、`executionStarted` は終端状態オブジェクトに置かれ、後者は状態機械のイベントでのみ書き換えます。どちらも **Worker ローカルのインメモリ冪等ゲートであり、ディスクスナップショットには永続化せず**、エントリーや状態が入れ替わると初期値から始まります。

<p align="right"><a href="04-invariants.md#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

