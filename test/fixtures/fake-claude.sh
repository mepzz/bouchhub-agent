#!/bin/sh
# A stand-in for the Claude CLI in voice tests: echoes what it was asked so the
# test can assert the argv, reads the prompt from stdin like the real CLI, and
# emits a few stream-json lines split awkwardly across writes.
PROMPT=$(cat)
echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-fake\",\"argv\":\"$*\",\"prompt\":\"$PROMPT\"}"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello '
printf 'there."}]}}\n'
echo 'this line is not json'
if [ "$FAKE_CLAUDE_HANG" = "1" ]; then sleep 30; fi
echo '{"type":"result","subtype":"success","result":"Hello there.","session_id":"sess-fake","is_error":false}'
exit ${FAKE_CLAUDE_EXIT:-0}
