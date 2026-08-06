# BOSS Message Page Structure Calibration

## Status

Offline fixture calibration completed. Live read-only calibration ran on 2026-08-06 against the user's single open `/web/geek/chat` tab. The first pass confirmed the list and preview structures; after the user manually opened one conversation, the second pass confirmed the selected row, position, message items, and `data-mid`. No tab was created, navigated, or brought to the front; no recruiter text, message text, screenshot, cookie, localStorage, or sensitive URL was saved.

## Approved fallback evidence

| Evidence | Selector / attribute | Decision |
| --- | --- | --- |
| Conversation row | `.friend-content-warp` | Live-confirmed; 41 rows present. |
| Row title / recruiter label | `.title-box` inside the row | Live-confirmed. The first `innerText` line is time, not recruiter, so title-box is required. |
| Row preview | `.last-msg-text` | Live-confirmed. |
| Row inner structure | `.friend-content > .friend-top > .figure/.text`, `.text > .title-box/.name-box`, `.last-msg > .last-msg-text` | Live-confirmed. |
| Delivered preview | `.message-status.status-delivery` | Live-confirmed; replaces the text `[送达]` fallback when present. |
| Read preview | `.message-status.status-read` | Live-confirmed; replaces the text `[已读]` fallback when present. |
| Unread marker | `.notice-badge` | Not live-confirmed (no badge class was present in the open list); approved fallback only. |
| Selected row | `.selected, .friend-top` | Live list had one `.selected` element elsewhere; row-level selected behavior must be confirmed after a conversation is opened. |
| Position name | `.chat-position-content .position-name` | Live-confirmed after a conversation was opened. |
| Company name | `.base-info > span:not(.base-title)` | Live-confirmed after the user pointed out the grey text beside the recruiter name. The header `.base-info` contains an unclassed span with the company name, followed by a `.base-title` span with the recruiter role. |
| Message item | `.message-item` | Live-confirmed; 7 items visible in the opened conversation. |
| Message id | `data-mid` | Live-confirmed; values are 15 digits. |
| Stable conversation id | `data-conversation-id` or `data-encid` | Not present in the live list; rows exposed only `data-v-*` scoped attributes, so the approved fallback is a digest of normalized recruiter label plus preview text. |
| Stable recruiter id | `data-recruiter-id` or `data-geek-id` | Not present in the live list; approved label-digest fallback. |
| Voice content | `.item-voice` | Not observed in the calibrated conversation; fallback only. |
| Image content | `.item-image` | Not observed in the calibrated conversation; fallback only. |
| Attachment content | `.item-attachment` | Not observed in the calibrated conversation; fallback only. |
| Text/system content | `.item-friend`, `.item-myself`, `.item-system` | Live-confirmed as message-item direction classes; text fallback remains. |

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
