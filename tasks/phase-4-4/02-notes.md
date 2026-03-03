I'm thinking backfill should basically go thorugh its scan that basically
  sorts through live and finished sessions. THen for ALL finished sessions,
  upload the transcripts and trigger processing.
  This should basically look like every main session transcript and subagent
  transcript being parsed and stored as normal. Then retroactively going to
  every session with subagent_count > 0 and checking for TeamCreate tool calls.
  Counting number of those to get num_teams we're looking for and using hte
  inforamtion in the attached file to stitch the teammate event sequences
  together. As well as their relationship with all of the sessions's subagent
  transcripts. But the team structure will really only be noticeable in teh
  database. the transcripts themsleves wont be stored in soem special way or
  whatever. its basically an acknowledgemnet of a bunch fo subagents sending
  messages that trigger new subagents. and stitching together all the
  references.

  I think in step with this is a refactor of the session lifecycle and parse
  lifecycle:
  ```
    Abstraction 2: Explicit TRANSCRIPT_READY state (from State Machine agent)

  Replace the implicit "ended AND transcript_s3_key IS NOT NULL" gate with an
  explicit lifecycle state:

  DETECTED -> ENDED -> TRANSCRIPT_READY -> PARSED -> SUMMARIZED -> COMPLETE
       |         |            |               |           |
       +-------->+----------->+-------------->+---------->+-> FAILED

  The transition ENDED -> TRANSCRIPT_READY IS the pipeline trigger. It happens
  in exactly ONE place. Optimistic locking prevents double-triggering:

  // In transcript upload handler (ONLY place that triggers pipeline):
  const result = await transitionSession(sql, sessionId,
    ["ENDED"],  // also accept "DETECTED" for out-of-order arrival
    "TRANSCRIPT_READY"
  );
  if (result.success) {
    enqueueReconcile(sessionId);
  }

  Merge parse_status into this -- TRANSCRIPT_READY means "ready for parsing",
  PARSED means "parsing complete". No more split-brain.
  ```
  unify them as described.
  DETECTED -> ENDED -> TRANSCRIPT_READY -> PARSED -> SUMMARIZED -> COMPLETE

  for a live session detected is triggered by SessionStart hook. ended by
  SessiuonEnd hook. SessionEnd should trigger basically getting the transcript
  and all subagent transcripts from
  $HOME/.claude/projects/<proj-dir>/<session-id>.jsonl and
  .../<proj-dir>/<session-id>/subagents/...
  these get uploaded to s3. then the lifecycle gets advances to
  TRANCRIPT_READY. which should then on teh SERVER side trigger parsing. which
  will go as described above. downloading and parsing all the files, getting
  everything into postgres as described. we should parse a session, whcih means
  going through its main transcript loading in every
  message/content-block/line from that jsonl. into trnascript_messages and
  content_blcoks table. doing the same for each subagent transcript for that
  session. that subagent_id column in transcript_messages is key for
  differentiating contexts (ie do events belong to main cotnext or just a
  subagent?). THEN doing a search for TeamCreate/TeamDelete tool calls in the
  lead session transcript and if so populating the new team-related
  table/schemas.

  Once this is all done successfully the session is moved to parsed. Then we
  generate the summary of the session using the stitched together sequence of
  events from teh lead session, and doing the same for each subagent's context
  and teammate's context. If there is a team structure over some of the
  subagents taht should take precedence, you summarize the teammate context not
  the subagent. the TUI will display the teammate activity feed stitched
  together from its component subagents.

  So then once every session/subagent/teammate has its summary, teh session is
  moved to summarized. Then complete.

  The TUI should reflect the overchaing teammate activity feed BUT ALSO
  refreence each individual subagent in its displaying of each message so the
  fuel-code user understands what's really happening. And so then when it does
  its session list for the sessions command, subagents AND teammates should
  appears nested under their parent session/lead session in the SAME way, just
  with a different label. And then in teh TUI if they click on a subagent, it
  should display the message feed for the subagent pulling from the
  transcript_messages table to do that. If they click on a teammate, it sould
  stitch back together hte teammate's messages, maintining references in each
  message's display to the agent id of the subagent that actually sent emitted
  that message. (message in the broader sense, not the SendMessage tool).
