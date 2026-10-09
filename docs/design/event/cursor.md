# Cursor

_Resolution: settled_
_Built: yes_
_Authority: agent-provisional_
_Authored by: unknown_

An opaque ordered position in a Workspace's Event or push stream. Catching up
from a cursor prevents skipping or duplicating records after reconnect. It is
not an offset, a page number or a periodic full-state refresh.

Push updates are filtered to the client's authenticated boundary. A client that
reconnects resumes from its cursor.
