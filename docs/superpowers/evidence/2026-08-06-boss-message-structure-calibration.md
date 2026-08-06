# BOSS Message Page Structure Calibration

## Status

Offline fixture calibration completed. A live read-only calibration ran on 2026-08-06 against the user's single open `/web/geek/chat` tab. It confirmed the list and preview structures below, but the right pane showed `chat-no-data`, so no conversation was open. Company, position, and message-item calibration remains pending until the user manually opens one conversation. No tab was created, navigated, or brought to the front; no recruiter text, message text, screenshot, cookie, localStorage, or sensitive URL was saved.

## Approved fallback evidence

| Evidence | Selector / attribute | Decision |
| --- | --- | --- |
| Conversation row | `.friend-content-warp` | Live-confirmed; 41 rows present. |
| Row inner structure | `.friend-content > .friend-top > .figure/.text`, `.text > .title-box/.name-box`, `.last-msg > .last-msg-text` | Live-confirmed for recruiter label and preview text. |
| Delivered preview | `.message-status.status-delivery` | Live-confirmed; replaces the text `[送达]` fallback when present. |
| Read preview | `.message-status.status-read` | Live-confirmed; replaces the text `[已读]` fallback when present. |
| Unread marker | `.notice-badge` | Not live-confirmed (no badge class was present in the open list); approved fallback only. |
| Selected row | `.selected, .friend-top` | Live list had one `.selected` element elsewhere; row-level selected behavior must be confirmed after a conversation is opened. |
| Position name | `.chat-position-content .position-name` | Not live-confirmed; right pane was `chat-no-data`. Pending. |
| Company name | `.company-name` | Not live-confirmed; right pane was `chat-no-data`. Pending. |
| Message item | `.message-item` | Not live-confirmed; right pane was `chat-no-data`. Pending. |
| Message id | `data-mid` | Not live-confirmed; pending. |
| Stable conversation id | `data-conversation-id` or `data-encid` | Not present in the live list; rows exposed only `data-v-*` scoped attributes, so the approved fallback is a digest of normalized recruiter label plus preview text. |
| Stable recruiter id | `data-recruiter-id` or `data-geek-id` | Not present in the live list; approved label-digest fallback. |
| Voice content | `.item-voice` | Not live-confirmed; pending. |
| Image content | `.item-image` | Not live-confirmed; pending. |
| Attachment content | `.item-attachment` | Not live-confirmed; pending. |
| Text/system content | no media class | Pending until message items are visible. |

When neither stable conversation nor recruiter identifier exists, the approved fallback is a digest of the normalized recruiter label plus preview text. This key changes when the label or preview changes, so the reader fails closed instead of clicking a drifted row.

## Preview classification fallback

- `.message-status.status-delivery` or `[送达]` prefix -> `self_delivered`
- `.message-status.status-read` or `[已读]` prefix -> `self_read`
- Contains `对方已同意`, `附件简历已发送`, or `已投递成功` -> `platform_notice`
- Contains `[语音]`, `[图片]`, or `[文件]` -> `unsupported`
- Non-empty other text -> `possible_hr_reply`
- Empty -> `unknown`

## Privacy constraints

The live probe returned only tab id, title, and URL. It saved no screenshot, recruiter text, message text, cookie, localStorage, or sensitive URL. Future calibration must hash text-bearing values inside the page expression and record only selector/attribute names, presence booleans, and fallback decisions.
