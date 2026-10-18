# 04 · Lockdown Mirror and Terminal Flags

[简体中文](../cn/04-lockdown-invariants.md) · [English](../en/04-lockdown-invariants.md) · [日本語](../ja/04-lockdown-invariants.md)

[← 04 Runtime Invariants](04-invariants.md)

- **Lockdown Fingerprint & Intent Identity**:
  - The lockdown durability handshake fingerprint (`lockdownFingerprint`) consists of `phase`, `intentId`, and `announced`.
  - `phase` and `intentId` identify a specific lockdown intent.
  - `announced` controls whether crash recovery broadcasts an unlock notice and is covered by the persistence acknowledgement.
  - Emergency permission recovery checks only `phase` and `intentId` when matching a delayed result to the active intent.
  - Neither fingerprint includes `expiresAt`.

- **Countdown & Reconcile Loop**:
  - The countdown timer is tracked in the mirror's `expiresAt`, from which `remainingMs` is derived upon state adoption.
  - The persistence reconcile loop is capped at `LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS` rounds.
  - If a new event arrives while persistence is in flight, a queued-rerun flag is set.
  - If the round limit is reached, the active task logs an error, yields the current microtask, and starts a fresh task from the latest mirror snapshot without waiting for external triggers.

- **Main-Thread Emergency Takeover**:
  - If the Anti-Raid Worker gives up self-healing, the main thread's `recoverAbandonedLockdowns` directly scans the hot-read chat state cache (`chatStateCache` in `cache/main/chatState.ts`) without cloning or relying on iteration order.
  - The recovery pipeline reads each entry synchronously before any `await`; each locked chat is processed once and logged once in the takeover journal.
  - If recovery for a chat is already active with the identical `phase` and `intentId`, `startEmergencyLockdownRecovery` returns immediately. If a different intent is detected, it aborts the old recovery process and restarts anew.

- **Abandoning the Mirror When the Chat No Longer Exists**:
  - With teardown reason `gone`, the Anti-Raid Worker abandons the chat's lockdown through the `chatGone` event: it deletes the state, clears the restore and retry timers, and only reports `unlock`, without calling Telegram. The main thread clears the `lockdown` mirror on `unlock` and persists it in the background; any earlier in-flight `lockdown` report arrives first and `unlock` last, so the mirror ends up empty. If the main thread has already taken over emergency lockdown recovery for that chat, `abandonEmergencyLockdownRecovery` synchronously cancels the recovery task and clears the `lockdown` mirror.
  - Late permission-call results after the abandonment hit an empty state and do not advance it; `departed` and every other reason still take the persist-first restore path.
- **Mirror Validation & Optional Fields**:
  - Active lockdown mirrors must contain `phase` and a positive integer `intentId`. `announcementMessageId` is present if and only if `announced` is `true`.
  - Verification challenge snapshots must include `phase` and `trackedMessageTimes` (at most `ANTI_RAID_PER_MINUTE_LIMIT` entries).
  - `reminderMessageId`, `replyReminderMessageId`, and `announcementMessageId` are optional; in `kickPending`, both reminder IDs must be absent.
  - In the `pending` phase, `replyReminderRequested`, `reminderSuperseded`, and whether `welcomeAnchorMessageId` is set are all true or all false; every other phase holds an empty `trackedMessageTimes`, no `invitedBy`, `replyReminderRequested: false`, no `welcomeAnchorMessageId`, and `reminderSuperseded: true`. The `expelling` notice and confirmation flags (`successNoticeSent`, `failureNoticeSent`, `unconfirmedNoticeSent`, `removalConfirmed`) accept only absence or `true`.
  - Any other missing or unrecognized fields are rejected by strict validation and must be migrated offline; production read paths retain no backward-compatibility fallback logic.

- **Independent Terminal Notice Flags**:
  - `successNoticeSent`: Records that the success report was delivered.
  - `failureNoticeSent`: Records an unsuccessful kick attempt or missing `can_restrict_members` permission.
  - `unconfirmedNoticeSent`: Records unconfirmed chat membership or invalid chat type.
  - The main thread automatically deletes all three notice types after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
  - Each flag independently prevents duplicate notices across Worker restarts or process reboots. Flags are written through state machine events (`expelNoticeSent`, `removalConfirmed`) and apply only to an entry that is still the current terminal state once the notice `await` finishes; setting a flag issues a new revision that terminal retry loops await.

- **Kick Confirmation & Report Atomicity**:
  - **A successful kick whose success report failed to send must not be marked settled.**
  - `removalConfirmed` is written to the snapshot before backing off and retrying. When the subsequent probe reports that the user is not in the chat, the bot treats the expulsion as completed and dispatches the success report.
  - `removalConfirmed` is persisted only when sending the report fails.

- **Short-Circuiting Without Ban Rights**:
  - When `botCanRestrictIn` is `false`, the cycle exits early only if both `failureNoticeSent` and `cleanupSettled` are `true`; each such cycle sends a single membership probe, settles if the member has left, and otherwise keeps backing off.
  - Lockdown instant kicks (`kickPending`) also probe membership first when the ban permission is missing: a departed member settles and its record is released; a present member is logged and backed off without a kick request.
  - Once `cleanupSettled` is `true`, subsequent retries on the same terminal entry skip `deleteVerificationMessages` directly. While `cleanupSettled` is `false`, the disposal cycle continues: the kick is bypassed by `canRestrict`, the report is bypassed by `failureNoticeSent`, and message deletions are bypassed when `can_delete_messages` is absent. Only pending deletions that can still execute are retried.
  - `cleanupSettled` lives on the Worker runtime entry (`VerificationEntry`), while `executionStarted` lives on the terminal state object and changes only through state machine events. Both are **in-memory Worker-local idempotency gates that are never written to disk snapshots** and restart from their initial values when the entry or state is replaced.

<p align="right"><a href="04-invariants.md#quick-navigation">↑ Back to quick navigation</a></p>
