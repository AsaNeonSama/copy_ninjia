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
  - When teardown runs with reason `gone`, the Anti-Raid Worker abandons the chat's private-mode lockdown via `chatGone`: it deletes the state, cancels the restore and retry timers, and reports `unlock` without calling Telegram.
  - On receiving `unlock`, the main thread clears the `lockdown` mirror and persists the removal in the background; any earlier in-flight `lockdown` report arrives before `unlock`, leaving the mirror empty.
  - If the main thread has already taken over emergency lockdown recovery for that chat, `abandonEmergencyLockdownRecovery` synchronously cancels the recovery task and clears the `lockdown` mirror.
  - Late permission-call results arriving after abandonment hit an empty state and do not advance it. Every other teardown reason (including `departed`) still follows the persist-first restore path.

- **Mirror Validation & Optional Fields**:
  - Active lockdown mirrors must contain `phase` and a positive integer `intentId`; `announcementMessageId` is present if and only if `announced === true`.
  - Verification challenge snapshots must include `phase` and `trackedMessageTimes` (at most `ANTI_RAID_PER_MINUTE_LIMIT` entries). Optional `reminderMessageId`, `replyReminderMessageId`, and `announcementMessageId` simply indicate whether each message has been sent or observed; in `kickPending`, both reminder IDs must be absent.
  - Reply-reminder fields are cross-checked against `phase`:
    - In `pending`, `replyReminderRequested`, `reminderSuperseded`, and the presence of `welcomeAnchorMessageId` must be either all `true` or all `false`.
    - In every other phase, `trackedMessageTimes` must be empty, `invitedBy` and `welcomeAnchorMessageId` must be absent, `replyReminderRequested` must be `false`, and `reminderSuperseded` must be `true`.
    - In `expelling`, `expelReason` accepts only `timeout`, `flood`, or `wrongAnswer`, and the four notice/confirmation flags (`successNoticeSent`, `failureNoticeSent`, `unconfirmedNoticeSent`, `removalConfirmed`) accept only absence or `true`.
  - Any other missing or unrecognized fields fail strict startup decoding and must be repaired offline; production read paths retain no backward-compatibility fallbacks.

- **Independent Terminal Notice Flags**:
  - Three terminal notice flags are persisted independently:
    - `successNoticeSent`: Kick and disposal report delivered.
    - `failureNoticeSent`: Kick failed or `can_restrict_members` permission missing.
    - `unconfirmedNoticeSent`: Chat membership or chat type could not be confirmed.
  - Once sent, all three notice types are scheduled for automatic deletion after `COMMAND_MESSAGE_AUTO_DELETE_MS` by the main thread.
  - Each flag independently suppresses duplicate notices across Worker rebuilds or process restarts. Flags are written via state machine events (`expelNoticeSent`, `removalConfirmed`), apply only if the entry is still the active terminal state after the notice `await` resolves, and issue a new revision that terminal retry loops await.

- **Kick Confirmation & Report Atomicity**:
  - **A successful kick whose report failed to send must never be marked settled.**
  - `removalConfirmed` is persisted to the snapshot before backing off and retrying. When the next membership probe confirms the user has left the chat, the bot attributes the removal to itself and retries sending the success report.
  - `removalConfirmed` is persisted only when sending the report fails.

- **Short-Circuiting Without Ban Rights (`cleanupSettled`)**:
  - When `botCanRestrictIn === false`, early short-circuiting requires `failureNoticeSent === true`, `cleanupSettled === true`, and unconfirmed removal (`removalConfirmed !== true`). Even then, each cycle sends a single membership probe — settling once the member leaves, or continuing to back off while present. Entries with `removalConfirmed === true` take the regular terminal path, also probing membership once and sending the pending success report once the member is gone.
  - Lockdown instant kicks (`kickPending`) likewise probe membership first when ban rights are missing: departed members settle and release their record, whereas present members log and back off without issuing a kick request.
  - Once `cleanupSettled === true`, subsequent retries on the same terminal entry skip `deleteVerificationMessages`. While `cleanupSettled === false`, the disposal cycle continues so all remaining executable deletions still run (with the kick gated by `canRestrict`, the report gated by `failureNoticeSent`, and message deletions gated by `can_delete_messages`).
  - `cleanupSettled` lives on the Worker runtime entry (`VerificationEntry`), while `executionStarted` lives on the terminal state object and mutates only via state machine events. Both are **Worker-local in-memory idempotency flags that are never persisted to disk snapshots** and reset whenever the entry or state is replaced.

<p align="right"><a href="04-invariants.md#quick-navigation">↑ Back to quick navigation</a></p>
