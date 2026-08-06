# BOSS Message Page Structure Calibration

## Status

Offline fixture calibration completed. Live DOM calibration was attempted but not completed: the portable Edge CDP endpoint was reachable, yet only the fixed `BOSS-SEARCH` tab was present and no `/web/geek/chat` message tab was open. No tab was created, navigated, or brought to the front. The fixture selectors below are the approved fallback until a live calibration can run against the user's existing `BOSS-COMMUNICATION` tab.

## Approved fallback evidence

| Evidence | Selector / attribute | Decision |
| --- | --- | --- |
| Conversation row | `.friend-content-warp` | Required to build the row list. |
| Unread marker | `.notice-badge` | Unread boolean; also drives the guarded click precondition. |
| Selected row | `.selected, .friend-top` | Post-click identity check. |
| Header | `.top-info-content` | Recruiter/header label fallback. |
| Position name | `.chat-position-content .position-name` | Used for candidate association. |
| Company name | `.company-name` | Used for company-aware association; no second stable selector observed, so this is the fallback. |
| Salary / city | `.salary`, `.city` | Read-only context. |
| Message item | `.message-item` | Message list. |
| Message id | `data-mid` | Must match `/^\d{15}$/` or the snapshot fails closed. |
| Stable conversation id | `data-conversation-id` or `data-encid` | Preferred stable conversation key input. |
| Stable recruiter id | `data-recruiter-id` or `data-geek-id` | Preferred recruiter key input. |
| Voice content | `.item-voice` | `contentKind: "voice"`. |
| Image content | `.item-image` | `contentKind: "image"`. |
| Attachment content | `.item-attachment` | `contentKind: "attachment"`. |
| Text/system content | no media class | `contentKind: "text"`. |

When neither stable conversation nor recruiter identifier exists, the approved fallback is a digest of the normalized recruiter label. This key changes when the label changes, so the reader fails closed instead of clicking a drifted row.

## Preview classification fallback

- `[送达]` prefix -> `self_delivered`
- `[已读]` prefix -> `self_read`
- Contains `对方已同意`, `附件简历已发送`, or `已投递成功` -> `platform_notice`
- Contains `[语音]`, `[图片]`, or `[文件]` -> `unsupported`
- Non-empty other text -> `possible_hr_reply`
- Empty -> `unknown`

## Privacy constraints

The live probe returned only tab id, title, and URL. It saved no screenshot, recruiter text, message text, cookie, localStorage, or sensitive URL. Future calibration must hash text-bearing values inside the page expression and record only selector/attribute names, presence booleans, and fallback decisions.
