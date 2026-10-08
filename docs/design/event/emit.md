# Emit

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

The publish operation for deliberate non-graph communication, or for an
explicitly attached Port publication. A natural runtime response is recorded in
its NodeExecution Context without automatically routing downstream.

Direct `emit` and `request` remain valid non-graph communication.

An Event that expects a reply says so in its metadata (`response.expected`);
nothing holds a runtime call open waiting. `request(actor, work)` creates one
durable dependency: the requested Actor completes normally, and the Bus owns the
return path and resumes the requester with the result or a terminal failure.
