In this repository I want us to implement a configurable agentic system.  
                                                                                                                                                                                  
This agentic system should:                                                                                                                                                     
- Be configurable by yaml file
- Be deployable to kubernetes with the configuration coming from configmaps

Some things I can think of:
- The agentic implementation should be a loop with tool calls
- Max loop count is configurable, defaults to 10
- Configuration should dictate whether the LLM returns a structured answer or not
- The implementation should include basic tool calls (bash and websearch)
- The system prompt should be configurable
- The input should be a list of messages (past conversation)
- The API with the agent is HTTP/Server-Sent-Events
- Tool calls, reasoning, etc. should be events in the HTTP/SSE api, with a final event for the final result
- Built with NodeJS/typescript
- Input API is type checked at runtime
- Model and providers should be configurable. Look for a well known and well regarded library to connect to many LLM providers
