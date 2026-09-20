# ACS observed-agent support

Implement the agreed ACS plan on `nicolas/required-improvements-for-control-plane`, commit and push after validation.

Only support ACS in configurable-agent. The full control plane and dedicated ACS Guardian are built in another project; this configurable-agent is the "dumb" agent.

Treat both `ask` and `defer` as `deny`; no approval waiting or deferred execution. When a tool call or result is denied, inform the model with a generic denial and let it continue within the step limit.

Use ACS v0.1, one session per invocation, fail closed on Guardian failures, and hold generated answers until checked. Include integration coverage, public documentation, and interoperability details. Explicitly identify any backward-incompatible changes in the commit.
