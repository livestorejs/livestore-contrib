# Experiment 0003 — DFX fatal Gateway close codes

Date: 2026-08-23

## Question

Does DFX stop reconnecting when Discord declares that reconnect is forbidden?

## Oracle

For close codes 4004, 4010, 4011, 4012, 4013, and 4014, one connection attempt
must end in a terminal typed failure. A retry loop is a failure.

## Result

FAIL. Against a fake WebSocket and virtual clock, each code caused three
connection attempts within two virtual seconds. DFX currently converts every
close into an error and then unconditionally catches and repeats the socket
effect. Its committed test suite contains no lifecycle coverage beyond a
placeholder assertion.

## Conclusion

Unpatched DFX does not meet the production Gateway acceptance bar. The preferred
remediation is upstream-first: classify Discord close codes before the repeat
loop, expose a typed terminal error for non-reconnectable codes, preserve
backoff for reconnectable closes, and cover the classifier and lifecycle with
protocol tests. A temporary exact commit pin is acceptable while awaiting a
release; a permanent contrib fork is not the default.
