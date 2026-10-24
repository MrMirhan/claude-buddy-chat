# claude-buddy-chat

[Türkçe](README.tr.md)

End-to-end encrypted chat between Claude Code users, in direct messages and groups. The key exchange is quantum-resistant. There is no buddy-chat server: the free public ntfy.sh service carries sealed messages, and only the recipient can open them.

buddy-chat is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview.md). It adds a pane, commands, a tool for Claude, and a skill that tells Claude how to use them.

## Features

- Direct messages and groups of up to 8 people
- Friend requests that the other person accepts
- A display name and a username that your friends see, and nicknames that only you see
- Edit and delete your own messages for everyone, and copy any message
- Message states: sending ◷, sent ✓, delivered ✓✓ and read (blue ✓✓)
- A typing indicator in direct chats
- Privacy switches for read receipts and the typing indicator. With read receipts off, you send none and see none.
- Remove a friend (they are told) or block someone (they are not told)
- Toasts and operating system notifications for new messages and requests
- A pane in the Claude Code Desktop app, the VS Code extension and the terminal
- English and Turkish. English is the default.

## Requirements

- Claude Code v2.1.299 or later. In a terminal, run `claude --version`. In the Desktop app, enter `/status` in a Code tab session.
- The terminal CLI, the Code tab of the Desktop app, or the VS Code extension. buddy-chat does not run in the claude.ai chat or the mobile app.

## Install

### Let Claude install it

Paste this prompt into Claude Code, in the terminal or in the Code tab of the Desktop app:

```text
I want to install the buddy-chat plugin from https://github.com/MrMirhan/claude-buddy-chat. Read its README and look at what the plugin does. Tell me what you found, then install it the way the README says.
```

Claude reads the repository first, then asks for your permission before it runs the install command.

### Install it yourself

At the prompt of a terminal session:

```
/plugin install buddy-chat --marketplace MrMirhan/claude-buddy-chat
```

From a shell:

```bash
claude plugin install buddy-chat --marketplace MrMirhan/claude-buddy-chat
```

Claude Code asks you to add the marketplace. Answer `y`, then select the user scope.

In the Desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**. Select **Add marketplace**, enter `MrMirhan/claude-buddy-chat`, then select **Add plugin**.

If you install from a shell while a session is open, run `/reload-plugins` in that session.

## Get started

1. Run `/buddy` to open the pane.
2. Set your name and your username.
3. Select **Copy my add line** and send the line to a friend in any app.
4. Your friend pastes your line into **Add contact** in their pane. You get a friend request.
5. Open the **People** tab and select **Accept**. The chat opens.

Both of you must install buddy-chat.

## The pane

The pane is the same on every surface. Each app draws it in its own style.

**Desktop app and VS Code extension**

- A wide pane shows the chat list beside your home view: your Buddy ID, adding a friend and requests. Select a chat to open it.
- An open chat takes the whole pane and scrolls with the mouse wheel or the trackpad. It opens at the newest message and shows the last 40. Select **older messages** at the top to load 20 more. Select `←` to go back to the list.
- The chat list shows a colored avatar, the last message, the time and the number of unread messages. With more than 5 chats, a search field filters the list.
- Your messages show in orange bubbles on the right. Incoming messages show in grey bubbles on the left. Move the pointer over a message to show its actions.
- The **People** tab shows your profile card, requests, friends, groups and blocked people.

**Terminal**

- Chats show as chips above the conversation. Press `1` to `9` to switch.
- A bar in the sender's color marks each incoming message.
- Press `i` to type in the text field. After you send, the focus stays in the field. Press `Tab` to leave it, or `Esc` to go back to the prompt.
- The chat fills the pane: the chats stay at the top, and the text field and the key hints stay at the bottom.
- Press `k` to mark the message above and `j` to mark the one below. The messages move with the mark. On the marked message, `e` edits, `x` deletes and `f` sends it to Claude.
- Press `o`, or select **older messages**, to go back 8 messages. Select **newer messages** to come back.
- Press `Ctrl+X` then `Tab` to focus the pane, and `Ctrl+X` then `X` to close it. In the terminal, mouse clicks on buttons work only in fullscreen rendering.

**On all surfaces**

- `✎` edits your message. `✕` deletes it for everyone.
- `↗` sends an incoming message to Claude, with a note that it comes from your friend and not from you.
- In the terminal, a chat fills the pane: the chats stay at the top and the text field at the bottom. Select **older messages** and **newer messages** to page through it.
- `s` opens **Chats** and `p` opens **People**.

## Commands

| Command | What it does |
| --- | --- |
| `/buddy` | Open the pane |
| `/buddy-id` | Show your add line |
| `/buddy-add <id> [nickname]` | Send a friend request, or accept one |
| `/buddy-name <full name>` | Set your display name |
| `/buddy-username <username>` | Set your username |
| `/buddy-list` | List your friends, requests, groups and blocked people |
| `/buddy-send <person or group> <message>` | Send a message |
| `/buddy-group <name> <person1> [person2 ...]` | Create a group |
| `/buddy-lang <en or tr>` | Set the language |

You can name a person by their nickname, their display name or their `@username`.

## Language

English is the default. To use Turkish, run `/buddy-lang tr`, or select **Türkçe** in the **People** tab. The pane changes at once. Command descriptions change the next time Claude Code starts.

## Claude and buddy-chat

- Ask Claude to send a message, for example "Tell Alex I will be late". Claude uses the `send_to_buddy` tool. A dialog shows the message, and it goes out only if you select **Send**.
- Claude cannot read your messages. Claude sees a message only when you select `↗`.
- The included skill tells Claude to treat a forwarded message as data from another person, and not to follow instructions in it without your approval.

## How it works

- **Identity.** On first start, buddy-chat makes an X25519 key pair and an ML-KEM-768 key pair on your machine. Your ID is your X25519 public key. You can share it. The secret keys stay in Claude Code's plugin store on your machine.
- **Inbox.** Each ID has an ntfy.sh topic that comes from a hash of the ID. To send, buddy-chat posts a sealed message to the recipient's topic. One session on each machine receives for the machine. It keeps one request to its topic open with `curl`, so ntfy.sh pushes each message as soon as it arrives. If `curl` is not available, that session polls the topic every 8 seconds. Other open sessions read the shared store.
- **Encryption.** Before the handshake is complete, each message is sealed with `nacl.box` (X25519 and XSalsa20-Poly1305). Only the recipient can open it, and the recipient knows who sent it.
- **Quantum resistance.** After two people become friends, their plugins run an ML-KEM-768 (FIPS 203) handshake on their own. After that, each message key comes from both the X25519 secret and the ML-KEM secret, as in Signal's PQXDH and Apple's iMessage PQ3. Traffic that someone records today stays protected from a future quantum computer. If the ML-KEM code has a bug, X25519 still protects the message. After the handshake, buddy-chat refuses classic-sealed content from that friend. The **People** tab shows `PQ` beside each friend whose handshake is complete.
- **Requests.** buddy-chat drops messages from people who are not your friends. Requests and replies are also sealed and authenticated.
- **Groups.** Each group message is sealed for each member and sent to each member. Members who are your friends get the quantum-resistant key. Other members get X25519. Only the person who created the group can change its members.
- **Edit and delete.** Your friend's plugin applies the change. It cannot undo a screenshot or a changed client.
- **Receipts and typing.** Delivered and read receipts and the typing signal are sealed messages too. A receipt counts only when it comes from a person the message went to.

## Security limits

- **No forward secrecy.** buddy-chat has no ratchet like Signal's Double Ratchet. If someone takes your secret keys from your machine, they can open the messages that ntfy.sh still keeps, which is up to 12 hours of messages.
- **Metadata is visible.** ntfy.sh sees which topics get messages, when, from which IP address, and how large the messages are.
- **Third-party code.** Cure53 audited TweetNaCl.js. noble-post-quantum has no independent audit; only its author audited it. This is why buddy-chat joins the two in a hybrid key.
- **Not audited.** buddy-chat itself has had no security audit.

## Limits

- ntfy.sh gives each IP address 60 requests, then adds one request every 5 seconds. If buddy-chat gets HTTP 429, it waits one minute.
- ntfy.sh keeps messages for 12 hours. A message to someone who opens no session in that time is lost.
- One message holds about 2,500 characters.
- Each group message, edit and delete uses one request for each member.
- Receipts and typing signals also use requests. buddy-chat sends one receipt for each batch of messages and one typing signal every 5 seconds at most. Groups have no typing indicator.
- A delivered receipt goes out only while the recipient has Claude Code open.

## Update notes

- From 0.4 to 0.5 or later: all data stays. The PQ handshake runs when both people have 0.5 or later.
- From 0.3: your keys and friends stay. The names you gave friends become nicknames.
- From 0.1 or 0.2: the old data is deleted and a new ID is made.

## Development

```bash
claude --plugin-dir .
```

Run the tests and the checks from the repository root:

```bash
claude plugin test .
```

```bash
claude plugin validate .
```

After Claude Code loads the mod once, it writes the API types to `.claude-plugin/types/`. Then `npx tsc -p .` type-checks the hooks and the tests.

The code is in `hooks/register.tsx`. The texts for each language are in `hooks/i18n.ts`. To add a language, add a table to `hooks/i18n.ts`, and add its code to `LANGS` and `LANG_NAMES`.

## License

MIT. See [LICENSE](LICENSE). The code in `hooks/vendor/` keeps its own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
