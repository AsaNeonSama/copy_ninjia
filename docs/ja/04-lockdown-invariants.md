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
  - teardown 理由が `gone` のとき、Anti-Raid Worker は `chatGone` イベントで該当グループの非公開モードを放棄します（状態を削除し、復元・再試行タイマーを解除し、Telegram を呼ばずに `unlock` のみを報告）。
  - メインスレッドは `unlock` を受けて `lockdown` ミラーを消去し、バックグラウンドで永続化します。先行する処理中の `lockdown` 報告が先に、`unlock` が後に届くため、ミラーは最終的に空になります。
  - メインスレッドがすでに該当グループの緊急復旧を引き継いでいる場合は、`abandonEmergencyLockdownRecovery` が同期的に復旧タスクを破棄して `lockdown` ミラーを消去します。
  - 放棄後に遅れて届いた権限呼び出し結果は空の状態に当たり、状態を進めません。`departed` を含むそれ以外の理由では、永続化優先の復元経路を通ります。

- **ミラー検証と省略可能フィールド**：
  - 有効なロックダウンミラーには `phase` と正の整数 `intentId` が必須であり、`announcementMessageId` は `announced === true` のときに限り、かつ必ず存在します。
  - 参加認証スナップショットには `phase` と `trackedMessageTimes`（最大 `ANTI_RAID_PER_MINUTE_LIMIT` 件）が必須です。省略可能な `reminderMessageId`、`replyReminderMessageId`、`announcementMessageId` は送信・観測済みかを表すのみで、`kickPending` フェーズでは両リマインダー ID を含めてはなりません。
  - 返信リマインダー関連フィールドは `phase` と交差検証されます：
    - `pending` フェーズでは、`replyReminderRequested`、`reminderSuperseded`、`welcomeAnchorMessageId` の有無がすべて真またはすべて偽で一致している必要があります。
    - それ以外のフェーズでは、`trackedMessageTimes` は空、`invitedBy` と `welcomeAnchorMessageId` はなし、`replyReminderRequested: false`、`reminderSuperseded: true` でなければなりません。
    - `expelling` の `expelReason` は `timeout`、`flood`、`wrongAnswer` のみを受け付け、4 つの通知・確認フラグ（`successNoticeSent`、`failureNoticeSent`、`unconfirmedNoticeSent`、`removalConfirmed`）は省略または `true` のみを受け付けます。
  - 上記以外の未定義フィールドや形式不一致は起動時の厳格デコードで拒否されます。旧形式データは停止中にオフラインで移行する必要があり、本番の読み込みパスに後方互換フォールバックは一切残しません。

- **終端通知の独立した永続化フラグ**：
  - 終端通知の 3 つの状態フラグはそれぞれ独立して永続化されます：
    - `successNoticeSent`：キックおよび処置の成功報告が送信済み。
    - `failureNoticeSent`：キック失敗または `can_restrict_members` 権限不足を記録。
    - `unconfirmedNoticeSent`：メンバーの在籍状態またはチャット種別が確認不能。
  - いずれの通知も、送信成功後にメインスレッドが `COMMAND_MESSAGE_AUTO_DELETE_MS` の自動削除タイマーを設定します。
  - 各フラグは Worker 再構築やプロセス再起動をまたいでも同一通知の重複送信を個別に防ぎます。フラグはステートマシンのイベント（`expelNoticeSent`、`removalConfirmed`）経由で記録され、通知の `await` 完了時点で現在の終端状態のままであるエントリにのみ適用され、新しい revision を発行して永続化 ACK を待ちます。

- **キック確認と処置報告のアトミック性**：
  - **キック自体は成功したものの処置報告の送信に失敗した場合、その処理を完了扱いにしてはなりません。**
  - スナップショットに `removalConfirmed` を記録してバックオフ再試行に入り、次回の在室照会でグループ不在が確認された際、Bot 自身がキックを完了させたと判定して成功報告を再送します。
  - `removalConfirmed` は処置報告の送信に失敗したときのみ永続化されます。

- **BAN 権限不足時の短絡ゲート（`cleanupSettled`）**：
  - `botCanRestrictIn === false` の場合、`failureNoticeSent === true` かつ `cleanupSettled === true` であり、まだキック未確認（`removalConfirmed !== true`）のときにのみ早期短絡します。この短絡時も各サイクルで在室照会を 1 回行い、退出済みなら精算し、在室中ならバックオフを継続します。`removalConfirmed === true` のエントリは通常の終端経路を取り、同様に 1 回の在室照会で退出を確認次第、未送信の成功報告を補送します。
  - 非公開モードの即時キック（`kickPending`）も BAN 権限がない場合は先に在室照会を行い、退出済みなら精算・解放し、在室中ならキック要求を送らずログを記録してバックオフします。
  - `cleanupSettled === true` になった後は、同一終端エントリの後続リトライで `deleteVerificationMessages` を直接スキップします。`cleanupSettled === false` の間は処置サイクルを継続し、実行可能な未完了の削除処理を残さず再試行します（キックは `canRestrict`、報告は `failureNoticeSent`、メッセージ削除は `can_delete_messages` の有無で個別にスキップ）。
  - `cleanupSettled` は Worker の実行時エントリ（`VerificationEntry`）に、`executionStarted` は終端状態オブジェクトに保持され（後者はステートマシンイベントでのみ更新）、どちらも**ディスクスナップショットには書き込まれない Worker ローカルのインメモリ冪等フラグ**として、エントリや状態の入れ替わり時に初期値へ戻ります。

<p align="right"><a href="04-invariants.md#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

