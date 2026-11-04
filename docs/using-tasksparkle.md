# Use TaskSparkle

This guide covers daily use. It explains boards, cards, settings, phones and agent setup.

## Agent setup

Once you can sign in, giving your agent access takes a few minutes, and each person does it for their own boards.

1. Sign in.
2. Open the Settings gear.
3. Select Set Up Agent in the list.
4. Copy the short instructions into your agent. The page fills in the agents door address from your deployment's settings.
5. When your agent asks for a key, select Add a key on that page.
6. Give the key a name.
7. Copy the full key when it shows. It shows once.
8. Paste it into the secret field your agent shows you.
9. Your agent connects with that key. It reads the full directions from the API itself (`GET /api/v1/directions`) and sees only your boards.

A key is a bearer token: whoever holds it can read and change your boards, so it lives in your agent's secret store and nowhere else. The server stores only the key's hash and its last four characters; nobody can read the full key back, not even you. You can hold several named keys at once, up to ten — one per agent, say — and each is managed on its own: renaming changes a key's name and nothing else, and deleting a key stops that one key at once while the others keep working. A key can never make, rename or delete keys itself — that stays with you, in the app — so a leaked key cannot lock your other agents out.

## Sign in

Each person signs in with their own name — with a passkey, with a password, or with a passkey alone. Signing in is passkey-first: at a secure address the sign-in page opens on the passkey, and a small switch below it — "Use a password instead" — trades to the password form. The device remembers which view you last used and opens there next time. Enrolling a passkey makes the passkey that device's view. A passkey is added in Settings, then Account.

The first account is made on the setup page the copy shows while nobody has an account; that person is the administrator. On a hosted copy the setup page also asks for the one-time setup code, so a stranger who finds a brand-new copy cannot take the first account. Everyone after the first arrives by an invite link from the administrator, in Settings, then Admin. The setup page and every invite page stand the same two ways open at the start, the passkey way first — an account that starts with a passkey holds no password at all.

Passkeys need a secure address: HTTPS, or a localhost address. At an ordinary HTTP address there are no passkey acts and no switch: the password form stands, and the sign-in page says the site is not encrypted. Passkeys already made still list on the Account page at such an address, and can be removed there.

Forgot the password, or lost every passkey? The administrator sends a link from Settings, then Admin. Spending it sets a new password or enrols a new passkey, signs out every sign-in, and never removes a passkey on its own — a passkey comes off only by a named act. The full story — adding a passkey, removing a password, getting back in — is in [Passkeys and passwords](passkeys-and-passwords.md).

## One person alone

One person is on the deployment: yours is the account made on the setup page. You sign in, your two starter boards appear, and that is the whole system. Adding your agent later is the Set Up Agent page and one key.

## Two people

A couple, say, sharing one deployment: the first person makes the first account on the setup page and invites the second from Settings, then Admin. Each person signs in as themselves and gets their own boards — separate, private, with nothing shared and no way to peek. Each person can make their own agent key, and each key reaches only its own person's boards. One deployment, two fully separate sets of boards, still zero cost.

The administrator's Admin page shows each account's posture at a glance: who holds a password, who signs in Passkey only, how many passkeys each account holds, who is linked to their boards. From there the administrator can invite people, send reset and recovery links, make another person an administrator, remove a person's passkeys when they have lost their device — signing in and adding passkeys stay that person's own acts — and remove a person outright.

## Through an agent

With a key in place, an agent can do nearly everything the app does: read the whole state, create and edit cards, move them between columns and boards, run checklists, add links, leave comments and copy boards. The stale-write guard (`baseVersion`, explained in [API reference](api.md)) keeps an agent's change from landing on top of yours: if the boards moved since the agent read them, the change is refused and the agent reads again. The API stamps the work itself: a card carries the name of the key that created it, and a comment carries the name of the key that wrote it. On a card's face, a stamp names the key that made the card and no stamp marks your own work; open the card and the editor names the maker either way — Made by, with the key's name or your own. Moves, edits and ticks carry no stamp. So an agent can watch for changes and tell you about them, and the directions the API serves suggest exactly that offer. [Watching for changes](watching-for-changes.md) turns that pattern into a small runnable digest example.

## On a phone

Open this copy's address on the phone, sign in, and the browser offers to install TaskSparkle (on Android, "Install app"; on iPhone, Share, then Add to Home Screen). It opens full-screen like a native app, with the same boards. There is no offline mode: the installed app is the live board and needs the network, like the browser tab does.

## The board

### Boards and columns

- Rename a board in Settings. Add more boards there too.
- Delete a board at any time: a dialog names it and counts the cards that go with it. You can never delete the last board.
- Copy a board in Settings. A dialog names the copy.
- The copy starts with Columns, Labels and Projects ticked. Cards start unticked.
- A copy is one act. Copied cards land by column place, up to the last column.
- Archived cards never copy.
- Press and hold a board or project button to rename it there. Double-click does the same.
- A project editor also holds Delete. It names how many cards carry the project and asks once.
- Cards keep living after a project is deleted. They have no project.
- Every board starts with five columns: Inbox, Ready, Doing, Waiting and Done.
- Rename, add, remove and reorder columns for each board in Settings.
- A board keeps at least one column.
- When you remove a column with cards, choose where its cards go.
- All cards move to the end of that column, in their order. Archived cards stay archived.
- The column is removed in the same act.
- Select the plus in a column to make a card there. The name of the column does not change that rule.

### Header and display

- One header row holds the wordmark and board buttons.
- The theme button, display button and Settings gear sit at the right.
- On a phone, the header takes two rows.
- The first row holds the wordmark and the three buttons.
- The second row holds board buttons at full width. It scrolls sideways and does not wrap.
- Each column has a plus at its foot. It makes a card in that column and opens the editor.
- If a card still has no title when the editor closes, it removes itself.
- Boards, columns, labels and projects can each carry one emoji as an icon.
- Pick an icon where you edit the name. Use the picker grid, or type or paste one.
- The grid holds a few hundred emoji. Each has a name, and search matches that name.
- The app's default icons sit at the front of the grid.
- A board icon rides its board button.
- A column icon sits before its name in the header and the phone column switcher.
- A label icon sits inside its chip. A project icon sits beside its name in the filter row and on cards.
- A board with no picked icon reads one from its name. Personal uses a person, Professional uses a building and other boards use a card box.
- A column with no picked icon uses the keycap number for its place. The first five read 0, 1, 2, 3 and 4.
- Projects and labels start with no icon. They look as they did before until you pick one.
- If a value is not one emoji, the app refuses it and stores nothing.
- A header button steps through three display modes: icon and word, word alone and icon alone.
- The choice stays on the device, not on the server. It can differ on a phone and a computer.
- Card faces keep their words in every mode.

### Cards

- A card face shows its title.
- It shows a coloured chip for each label it wears.
- It shows a project pill and a due date when one is set.
- A card can wear any number of its board's labels, or none.
- In the editor, tick labels on or off. Each tick takes effect at once.
- A checklist count shows how many steps are ticked. It has a small list icon.
- When all steps are ticked, the count turns green.
- A link icon shows the count of links.
- An Important card shows a small flag in a warm colour.
- An unflagged card shows nothing for the flag. The flag never changes card order.

### Steps, links, comments

- Add a step by typing it, then press Enter or Add step.
- Tick or untick a step with its tick box.
- Rename a step, drag its grip to reorder it, or remove it.
- Step text wraps in full. A long step stays easy to read.
- Each change takes effect at once.
- Steps stay with the card through column moves, board moves, archiving and unarchiving.
- Deleting the card deletes its steps.
- A step holds text and a tick. It holds nothing else.
- Add a link with a web address and a name if you want one.
- A link row shows its name, or its address when it has no name.
- A named link shows its address under the name.
- Select a row to open the address in a new tab.
- Add a link with Add link, or press Enter in the address field. Remove a link from its row.
- Links stay with the card through column moves, board moves, archiving and unarchiving.
- Deleting the card deletes its links.
- If you type an address with no scheme, the app adds `https://`.
- If an address is not an http or https address, the editor refuses it and stores nothing.
- TaskSparkle stores addresses only. It never stores files.
- Write comments in the editor as short notes on progress or next steps.
- Comments stay in the order they were written. The card face shows the count.
- Every comment shows who made it: a person's comment wears their name, and a comment made with a key wears that key's name — the name each goes by now, so renaming yourself or a key renames it on every comment at once.
- A card made with a key wears that key's name on its face. A card made by a person wears none.
- Comments stay through archiving and board moves.
- A board copy does not copy comments.
- Deleting the card deletes its comments.

### Handing work over

- Every card names whose turn its next step is: yours, one of your agent keys, or no one.
- A card you make starts as your step. A card an agent makes starts as that agent's step.
- Open a card and use the Next step chooser to hand it over.
- Write a comment before you hand over, and it is posted with the hand-over, in the same act.
- A handed-over card waits until its new holder writes on it. That first write is the pickup.
- The editor says so in plain words: who holds the step, when it was handed over, and "not picked up" while it waits.
- A card an agent holds wears a chip on its face with the agent's name. While it waits, the chip also shows how long, like "2d".
- Your own cards wear no chip.
- The filter row under the projects can narrow the board: Everyone, Mine, or one agent's cards.
- Archiving a card clears its step to no one. Moving a card between columns never changes its step.
- When an agent needs you, it hands the step to you with a comment saying what it needs. The card then waits on you, and the chip is gone because the step is yours.

### Saving and moving

- There is no Save button. Edits save on their own.
- Title and notes settle when the field loses focus.
- Board, project and due date fields take effect when they change.
- Label ticks and the Important switch also take effect at once.
- Buttons only make things and delete things.
- Move a card with the Move buttons in its editor, or drag it.
- On a desktop, start a drag on any part of the card.
- Drop it in any column. A dashed mark shows the place.
- On a phone, start a drag from the six-dot grip in the card's corner.
- A phone drag reorders cards in the column on screen.
- Swipe sideways on the column to move to the next or past column. The column stepper does the same job.
- On a phone, use the editor's Move buttons to move a card to a new column.
- A drop is one write. Every door reads back the order it makes.

### Phone views

- Select See all columns at the right of the board row to open the overview.
- The overview shows each column as a narrow strip, side by side.
- Each strip names its column, counts its cards and lists card titles one to a line.
- Strips keep the same gaps and padding as full-size columns.
- You cannot edit in the overview.
- Tap a strip to land in that column at full size.
- The button then reads Back to one column. It returns you to the column you were in.
- Select Schedule to swap the columns for the board's schedule. Select it again to go back.
- On a wide screen, Schedule sits in the header. On a phone, it sits beside See all columns.
- The top of the page stays the same. The schedule uses the board in view and its project filter.
- The Dated tag lists dated cards soonest first, under date headings.
- Late cards come first and wear Late tags. Today and Tomorrow come next, then cards by date.
- Each row names its column.
- The Undated tag groups undated cards by column.
- If the board in scope has no dated cards, Schedule opens the Undated tag.
- Select a row to open the card editor.
- The list scrolls as one page. A back-to-top button appears at the lower right after you scroll.

### Finding cards

- Use the editor's Move board button to move a card to another board.
- The button opens a dialog that picks the board, the column and the project.
- The board starts on a board that is not the card's own.
- The column starts on that board's column with the same name as the card's column, or its first column.
- The project starts on that board's project with the same name as the card's project, or none.
- Changing the board pick aims the column and project picks again, the same way.
- Labels belong to a board. A label crosses when the board you pick carries a label with the same name, and it is worn there as that board's label.
- A label with no match stays behind, and the dialog names every one before you confirm.
- Everything else travels: the notes, the due date, the steps, the links, the comments and whose turn the next step is.
- Confirming closes the editor, and the card stands in the column you picked on the board you picked.
- Archive and delete live in the editor.
- A filter row under the header holds one button for each project on the board, plus a + Project button.
- A project filter narrows every column to that project's cards.
- Select Search in the header to slide in the search bar. It sits left of the theme button.
- Search matches card titles, notes and checklist steps across all boards.
- Select Filters to expand board, project and label lists. The lists follow the search scope.
- Archived is off at first. Turn it on to add archived cards to the results.
- Each result names its board and column. An empty result reads "No cards match."
- Select a result to open the card editor.
- Close the editor to return to the search as it stood.

### Labels, projects, themes

- Labels belong to one board. Manage them in Settings: add, rename, recolour and delete.
- Delete a label to lift it off its cards. A card's other labels stay.
- Delete a project to leave its cards with no project.
- A theme has a look and a mode.
- The eight looks are Standard, Comic, Console, Pretty, Artistic, Sunset, Forest and Midnight.
- Each look has a light palette and a dark palette, with fonts to match.
- The modes are System, Light and Dark. A mode works with every look.
- In Settings, Theme picks the look. The header button steps the mode.
- Label colours keep their own look in every theme.
- The choice stays on the device, not on the server.
- A small local copy holds only that theme choice. It holds no name and no board data.
- That copy lets the page paint in the right colours before the data lands.

Every edit paints on screen at once and sends its change behind it. Changes go one at a time in the order they were made, so a fast series of edits can never undo itself. If a change fails, a plain line says it could not save and the app fetches the server's state again.

## Settings

Settings opens as a list with one entry per thing: Account, Theme, Boards, Columns, Labels, Projects and Set Up Agent. An administrator's list ends with one more entry: Admin. Each entry opens its own page, Back returns to the list and Close leaves Settings.

The Account page holds the name the person goes by and their sign-in: their passkeys, a change of password, and a sign-out-everywhere button that ends every other sign-in at once. The same page holds Delete my boards and account: the person's own erasure act, behind a typed confirmation. It removes their boards, cards, comments and keys at once; an agent key cannot call it. On Cloudflare, copies inside the nightly backups age out within 14 days. On a home copy, a backup is a copy of the data file, kept or deleted by the person who runs the copy.

The Admin page holds the accounts on the copy, each one's sign-in posture, the invites and reset links, and the claims list when a set of boards stands waiting to be linked to its person (see the setup guides for how board sets come to wait).

The Set Up Agent page is for the person who is signed in.

It shows instructions in a copy field, addressed to that person by name. The instructions are a short bootstrap: what TaskSparkle is, the agents door address — printed from the deployment's own `AGENT_HOST` setting, so a copy of the app under other names points at its own door — how the key is made and kept, and one direction to read first. They also cover the no-key case in the app's own words: "If I have no key yet, tell me to add one in TaskSparkle under Settings, then Set Up Agent: tap Add a key, give it a name, and paste you the key it shows me."

Follow the steps in [Agent setup](#agent-setup).
