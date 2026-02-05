# Commands Reference

LettaBot responds to these slash commands in Telegram.

## Available Commands

### `/start` or `/help`

Shows the welcome message and list of available commands.

```
🤖 LettaBot - AI assistant with persistent memory

Commands:
/new - Start a new conversation (keeps memory)
/reset - Create a new agent (fresh memory)
/status - Show current agent ID
/help - Show this message

Just send me a message to get started!
```

### `/new`

Starts a new conversation while keeping the same agent and memory.

Use this when you want to change topics but keep your agent's memory of who you are and past interactions.

**Example:**
```
You: /new
Bot: Started a new conversation. Your agent still remembers you!
You: Let's talk about something different now.
```

### `/reset`

Creates a completely fresh agent with no memory.

Use this if you want to start over from scratch, as if you've never talked to the bot before.

**Warning:** This permanently deletes your agent's memory of past conversations.

**Example:**
```
You: /reset
Bot: Created a fresh agent with no memory. Send a message to begin!
```

### `/status`

Shows your current agent ID.

Useful for debugging or if you need to reference your agent in other tools.

**Example:**
```
You: /status
Bot: Current agent: agent-a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

## Sending Messages

Just type any message to chat with your agent. The agent has:

- **Persistent memory** - Remembers your conversations over time
- **Tool access** - Can search files, browse the web, and more
- **Streaming responses** - You'll see the response appear in real-time

**Tips:**
- Be specific in your requests
- The agent remembers context, so you can refer back to previous conversations
- For long tasks, the "typing..." indicator will stay active

## Formatting

The bot supports markdown formatting in responses:

- **Bold** text
- *Italic* text
- `Inline code`
- ```Code blocks```
- [Links](https://example.com)

## Future Commands

These commands are planned for future releases:

- `/model <name>` - Switch the LLM model
- `/verbose` - Toggle tool output visibility
- `/context` - Show memory summary
