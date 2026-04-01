# An Open Letter to Anthropic

## On Efficiency, Freedom, and the Power of Collaboration

Dear Anthropic team,

We built this toolkit because we genuinely believe Claude's models are the best available for coding. We're not saying that lightly — we've used GPT-4, Gemini, DeepSeek, and others extensively. Claude consistently produces better code, holds context more reliably, and reasons through complex problems with a depth that nothing else matches. We're paying Max subscribers, and we're happy to pay because the quality is real.

So why did we build an alternative client?

### The Efficiency Gap

Claude Code CLI consumes roughly **10x more tokens** than opencode for equivalent coding tasks. We've observed this consistently — same prompts, same complexity, dramatically different token usage. A task that takes 50K tokens in opencode can burn through 500K in the official CLI. When you're on a subscription with usage limits, this isn't an abstract concern. It's real money, real productivity lost, and real frustration when you hit your daily limit halfway through a workday.

We understand that Claude Code CLI does more than just relay messages — it has tools, context management, and features that add overhead. But the magnitude of the gap suggests there's room for significant optimization. Every unnecessary token spent is a token that could have gone toward actual work.

### The Vibe Coding Philosophy

We're living in an era where the philosophy is simple: **build what you want, with the tools you choose**. The entire developer ecosystem thrives on this freedom — VS Code plugins, terminal multiplexers, custom shells, alternative clients. Developers have always combined tools in ways their creators never anticipated, and that's how the best workflows emerge.

We respect Anthropic's right to build their CLI exactly as they see fit. But we also believe that developers who pay for access to these models should have the freedom to interact with them through the tools that work best for their workflow. This isn't about circumventing anything — it's about efficiency and choice.

### We Understand the Tension

We're not naive about this. We know that using Claude's top models via a subscription through third-party coding tools isn't exactly what Anthropic designed the pricing model around. We get the business considerations. We understand why this might create friction.

But here's the thing — we're paying customers who want to use what we're paying for. When the official client wastes tokens, it doesn't make us want to use it more. It makes us look for alternatives. That's not a customer behavior problem; it's a product efficiency problem.

### There's Power in Collaboration

Here's what we really want to say: **there's enormous untapped potential in collaboration between strong models and strong developers**.

Anthropic builds the best models. Developers build the best tools. When these forces work together instead of against each other, everyone wins. The models get used more. The tools get better. The developers ship faster. The ecosystem grows.

What we'd love to see:

- **An official SDK or API tier for Max/Pro subscribers** — a clean, documented way to use Claude models in custom tools. This would eliminate the need for projects like ours and give Anthropic full control over the developer experience.
- **Token efficiency improvements in Claude Code CLI** — we'd happily contribute profiling data, benchmarks, or even code if it would help close the gap.
- **A partnership model for tool builders** — we're a team that ships real products, fast. If there's a way to collaborate officially, we're ready.

### What This Toolkit Is (and Isn't)

This toolkit is:
- An alternative client for developers who prefer opencode, Cursor, or other OpenAI-compatible tools
- Built for paying Max/Pro subscribers using their own credentials
- Respectful of Anthropic's infrastructure — we implement proper retry logic, rate limit handling, and caching
- Open source (the proxy) with a compiled SDK — transparent about what it does

This toolkit is **not**:
- A way to get free access to Claude models
- A credential sharing or redistribution tool
- A security bypass of any kind
- A replacement for Claude Code CLI — it's a complement for a different workflow

### An Invitation

We're a small team at [LifeAITools](https://lifeaitools.com) that builds AI tools for developers. We ship fast, we care about quality, and we use Claude every single day. Our entire development workflow runs on Claude models — this very toolkit was built with Claude.

If anyone at Anthropic reads this and sees an opportunity rather than a problem, we'd love to talk. Whether it's improving token efficiency, building an official SDK together, exploring a partnership, or simply having a conversation about how developers actually use these models in the wild — we're here.

Strong models deserve strong tools around them. And the strongest tools come from collaboration between strong people and strong companies.

With genuine respect and appreciation,

**The LifeAITools Team**
[lifeaitools.com](https://lifeaitools.com) | [GitHub](https://github.com/LifeAITools)

---

*This letter is part of the [opencode-claude-toolkit](https://github.com/LifeAITools/opencode-claude-toolkit) project — an open-source toolkit for using Claude Max/Pro subscriptions in opencode and other OpenAI-compatible clients.*
