# MUS-SPEC-01: Chat and composer

A chat is one conversation with an agent about one folder or worktree. The composer is where the user writes to it.

What the user can do:
- start a chat in a folder, a new worktree or a Project; name, rename, pin, archive, delete, fork and export it;
- write a message with attachments (files, images, sketches), mentions and slash commands, and pick the model, reasoning effort and access mode;
- search chats, move back and forward through them, and import conversations from other tools.

Boundaries:
- How a turn runs once sent is clause [02](02-turns-streaming-and-queue.md). Model choice is clause [03](03-providers-models-and-accounts.md). Access modes are clause [05](05-access-modes-and-approvals.md).
- The composer never loses a draft: a failed send, a restart or switching chats keeps it.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-01-599A](01-chat-and-composer.md#mus-spec-01-599a) | In a reply, single newlines in prose, list items and quotes become line breaks; blank lines still split paragraphs; bold is kept; an explicit break is not doubled; code blocks and table rows get no breaks. Both when animated and not. | [`a single newline in assistant prose, lists and quotes shows as a line break`](../../../packages/agent-app/tests/markdown-breaks-dom.tsx) |
| [MUS-SPEC-01-599B](01-chat-and-composer.md#mus-spec-01-599b) | A streamed reply that adds lines one at a time keeps a break for each and fades in only the new lines. | [`streamed text that arrives on a new line still fades in with its line break`](../../../packages/agent-app/tests/markdown-breaks-dom.tsx) |

### Line breaks in replies

A reply is written the way the model wrote it: one new line in the text is one new line on screen.

<a id="mus-spec-01-599a"></a>
#### MUS-SPEC-01-599A: A single newline in a reply shows as a line break

- Precondition: An assistant reply has three lines with no blank line between them (with bold and inline code), a list item that continues on the next line, a two-line quote, a line that ends with an explicit Markdown break, a fenced code block, an indented code block and a two-row table.
- Action: Render the reply, once plain and once with the streaming fade turned on.
- Expected result: The first paragraph holds 2 line breaks and keeps its bold text. A blank line still starts a new paragraph. The list item and the quote each hold 1 line break. The explicit break gives 1 line break, not 2. Both code blocks keep their text with the newline inside, no break element appears in code or the table, and the table still has its two rows.
- Test: `packages/agent-app/tests/markdown-breaks-dom.tsx::a single newline in assistant prose, lists and quotes shows as a line break`
- Environment: Real MessageBody in a DOM suite (linkedom); no network.
- Known gaps: Checks the break elements in the DOM, not how the text is laid out on screen. The code and table assertions already hold on main (they guard against over-fixing). The same suite also checks that a Markdown file opened as a document keeps soft breaks as spaces; that check passes on main too, so it carries no case.
- Evidence: UNVERIFIED

<a id="mus-spec-01-599b"></a>
#### MUS-SPEC-01-599B: Streamed lines keep their break and still fade in

- Precondition: A reply is streaming and has one line of text.
- Action: A second, then a third line arrive, one at a time.
- Expected result: The new lines ("Line two arrives" and "Line three") fade in, the first line does not, and the reply holds 2 line breaks.
- Test: `packages/agent-app/tests/markdown-breaks-dom.tsx::streamed text that arrives on a new line still fades in with its line break`
- Environment: Real MessageBody in a DOM suite (linkedom); no network.
- Known gaps: Does not run a real stream; the test sends the growing text itself. The fade is checked by its class, not by looking at it.
- Evidence: UNVERIFIED
