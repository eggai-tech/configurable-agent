Let's define an interface for integrating with tools.
We must discuss back and forth to design a good approach. Ask plenty of questions, do websearch to evaluate the state of the art.

This repository should actually have no tools whatsoever.
Tools should live in other repositories but still be configured for this agent through the config file.

Tools should support authentication/authorisation and this will be done through "on behalf of" tokens. Cf. POC here: /home/nherment/workspace/eai/zero-trust-demo

I would prefer for tools to not have to be deployed as a standalone service (pod or remote MCP server). However standalone tools should remain an option, if not for all tools, for some tools.