# News Reading

News is an independent reading view, not a chat space, and it has no dedicated chat box. The bottom 「News」 entry opens recommended and all-article timelines. The server reuses the existing information processing and model runtime internally; it does not add a separate recommendation engine.

## Reading and Filtering {#reading}

- The reading page has one top row for 「Recommended／All」, saved articles, sources, and fetching. It opens on Recommended and shows articles immediately below the row. Open 「Sources」 to see fetch time, analysis progress, and failure counts.
- 「Recommended」 contains only articles explicitly selected by a completed structured model run, with a short reason for each article. Articles not selected by the model remain readable under 「All」.
- 「All」 is ordered newest first by publication time. When publication time is invalid, the server uses the first acceptance time. The saved filter only filters the list and does not change ordering.
- Opening an article shows safe text cleaned by the server. Original links allow only credential-free HTTP(S) URLs. External titles, content, and links are untrusted data.
- Accepted articles, recommendations, feedback, and saves are restored from the server after a restart.

## Managing RSS Sources {#sources}

1. Tap the 「Sources」 icon at the top of the news reading page, then add the public HTTP(S) URL of an RSS2 source. You can also set a display title.
2. The server fetches and validates the XML when the source is added. URLs containing embedded credentials are rejected.
3. The Sources page shows fetch time, pending analysis, and analysis failures. Each source shows its latest fetch time and controlled error. If one source is malformed or temporarily unavailable, other sources and existing articles remain usable.
4. Deleting a source stops future collection only. Accepted articles, comments, reactions, and saves are retained.

The server collects every 30 minutes by default; background collection only fetches new items and does not automatically requeue articles already known to have failed. Manual refresh completes RSS collection and returns the number of new articles; article analysis continues in the background. Refresh does not wait for the complete model run and does not automatically resend an unknown result. If an item lacks a title or readable body, the whole source records a controlled parse error instead of being silently treated as empty.

## Feedback and Recommendations {#feedback}

- Like and dislike are mutually exclusive and can be cleared.
- Saved is independent of like/dislike.
- Comments are stored per article and support add and delete. Blank comments are rejected, and each comment is limited to 4,000 characters.
- Feedback does not immediately invoke the model. The next background analysis reads recent articles, feedback, comments, and saves as local evidence; saves are a weaker signal.
- Explicit preferences are saved by the user. Learned notes are a summary updated by the server from feedback. They are stored separately, and learned notes never overwrite explicit preferences, space rules, or the global user profile.
- For newly initialized internal news spaces, the default rules require recommendation reasons and learned notes in concise Simplified Chinese. RSS titles and content remain in their original language and are not translated.

News V1 may omit an explicit preference editor in the client. If the current client does not show that entry, the server still preserves existing preferences rather than rewriting or discarding them.

## Refresh and Failures {#refresh}

- The refresh icon in the reading toolbar starts one manual fetch. If reading the article list fails, a separate 「Retry list」 action rereads the list and status without fetching again. A manual fetch returns a conflict when one is already running; fetches are neither queued nor run concurrently.
- When the outcome of a fetch write is unknown, reread and check the status before explicitly unlocking it. The client does not resend automatically.
- Collection failures appear as controlled errors in news status or the source list. A malformed source is not silently treated as empty.
- When model analysis fails, the all-articles timeline remains readable. The recommended view contains only confirmed successful results.
- Another manual refresh can requeue articles already known to have failed. A running batch is not reordered.
- While the news page is in the foreground and status says processing, it may briefly reread status and lists, then stop at a terminal state. News adds no new SSE or global polling.

## Boundaries {#boundaries}

News V1 does not fetch full web pages, provide search or vector recommendations, send system notifications, support OPML, expose a news tool in the main chat, or carry an article into chat. The internal news space does not appear in the ordinary space list and cannot be operated through chat, space reset, or space deletion.
