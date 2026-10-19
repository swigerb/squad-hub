'use strict';
/**
 * The independently runnable scenarios of test/browser-e2e-unit.js.
 *
 * The browser suite is one long, ordered journey: later checks lean on the
 * device, the sessions and the page state that earlier ones created. Running
 * it whole costs about two minutes, so a caller that only needs one journey
 * (the mutation harness replaying a single mutation, a developer chasing one
 * failure) should be able to run just that journey, in a fresh process, and
 * still get honest results.
 *
 * A scenario is therefore a JOURNEY, never a single assertion cut out of an
 * ordered one:
 *   - `titles`    the assertions the scenario OWNS. Every check title in the
 *                 suite is owned by exactly one scenario, so a title always
 *                 maps to one place. These are the real RESULT titles.
 *   - `alsoRuns`  other assertions that run in this scenario because it
 *                 needs the state they build (the device, a session, a
 *                 loaded page) or because they judge the whole journey (the
 *                 enforced-CSP check). They run in file order, in the same
 *                 process, with their ordinary RESULT lines. Another
 *                 scenario owns them, which is why they are not `titles`.
 *
 * This module is metadata and pure functions only. Requiring it never
 * launches a browser, listens on a port, mints a credential or runs a check.
 * test/mutate.js reads `SCENARIOS` and `scenarioForTest`.
 */

const SCENARIOS = [
  {
    id: 'empty-state-no-device',
    summary: 'A signed-in hub with no device says what to do, and its connect and copy controls work.',
    titles: [
      'the app loads and signs in with a token in the URL',
      'no script or stylesheet failed to load',
      'with no device, the page says what to do instead of failing',
      'the local-devices pitch copies its start command (#172)',
      '+ New with no device opens the connect dialog, not a broken form',
      'empty Local and Cloud tabs explain how to connect, and their Connect buttons work',
      'the Connect dialog carries the Local or Cloud choice into its command, and a generic open carries none',
      'a token response that lands after the dialog was reopened never renders a command for the old intent',
  'the Connect dialog turns each file-access and track-all box into its own flag',
    ],
    alsoRuns: [
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'device-session-approval',
    summary: 'Mint a device token in the UI, attach a real daemon, start a session from the browser, and approve its tool call.',
    titles: [
      'the UI mints a DEVICE token, not the user credential',
      'that token really is limited to being a device',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'refresh-and-avatar',
    summary: 'The manual refresh feedback and the account avatar fallbacks.',
    titles: [
      'a manual refresh gives visible feedback where the data is',
      'the account menu shows an avatar, or an initial',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'connection-backoff',
    summary: 'A disposable hub that goes away: the connection state backs off instead of strobing.',
    titles: [
      'the connection state backs off instead of strobing',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'look-and-feel',
    summary: 'Design tokens, theme toggle, filter bar rows and top bar, as computed in a real browser.',
    titles: [
      'the palette comes from tokens that are actually applied',
      'the theme toggle cycles system, dark and light, and sticks',
      'an explicit theme really repaints the page',
      '"system" follows prefers-color-scheme rather than freezing',
      'the filter bar and the toolbar are separate rows',
      'every list control is labelled, and none is a bare boxed select',
      'a labelled control no longer repeats its label in every option',
      'the top bar carries the theme toggle, the bell and the avatar',
      'the empty state offers a cloud AND a local session',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'list-controls',
    summary: 'The custom dropdowns and list controls, driven by mouse and keyboard against live sessions.',
    titles: [
      'a dropdown opens on click and lists exactly the VISIBLE options its select holds',
      'the status options hidden until data exists start out hidden',
      'choosing an option drives the underlying select AND the app state',
      'a filter actually filters, rather than only recording itself',
      '"Action needed" (#169) narrows to blocked and awaiting-reply sessions, without a server round trip for a status no session has',
      'a status pill is a fact about the session, never a button (#169)',
      'the star, the title\'s first line and the status pill share one 22px line (#169)',
      'Escape closes the list without choosing',
      'the keyboard opens, moves and chooses without a mouse',
      'only one dropdown is open at a time',
      'clicking away closes an open dropdown',
      'grouping reshapes the list it claims to',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'new-menu',
    summary: 'The New split button, the ACA dialog GitHub fallback and the local composer.',
    titles: [
      'the New split button offers both kinds, and refuses the one it cannot start',
      'the New ACA job dialog falls back to GitHub when this hub has no GitHub App (issue #178, #233)',
      'the local half of the New menu opens the composer on a local device',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'tidy-and-forget',
    summary: 'The tidy menu, ended-session removal reaching the device, and the forget sweep Undo window.',
    titles: [
      'the tidy menu offers three scopes and says what it will not touch',
      'REMOVING ENDED SESSIONS REACHES THE DEVICE AND LEAVES LIVE WORK ALONE',
      'a forget sweep offers an Undo toast and waits out the window before telling the device anything',
      'clicking Undo on a forget sweep cancels it -- the device is never told',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'device-removal',
    summary: 'A throwaway device is minted, attached, removal cancelled and then confirmed.',
    titles: [
      'a second, disposable device can be minted and attached for the removal checks below',
      'clicking Undo on a device removal cancels it -- the device keeps its token',
      'removing a device offers an Undo toast and waits out the window before revoking its token',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'bell-and-account-menu',
    summary: 'Theme persistence, bell permission prompts, the push toggle without VAPID keys and the account menu.',
    titles: [
      'the theme toggle cycles, applies and remembers',
      'the bell asks for permission when it has not been decided',
      'a permission already decided is not asked for again',
      'with no VAPID keys configured, the bell inbox shows the push toggle disabled, not hidden',
      'the account menu opens and offers sign out',
      "the hub's own version sits quietly in the rail and the account menu at 1280, 900 and 390, dark and light (#271)",
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'rail-and-aca-card',
    summary: 'The device rail sections, summary line and the Not connected Squad on ACA card.',
    titles: [
      'the device rail collapses, and comes back',
      'devices group into sections, and the attached device lands under Local machines (#172)',
      'the rail summary line reports how many devices and sessions are live (#172)',
      'the "Squad on ACA" status card shows Not connected with no GitHub App configured (#180)',
      'a collapsed section stays collapsed across a reload (#172)',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'keyword-and-keyboard',
    summary: 'The keyword filter, the live indicator and keyboard reach of list controls.',
    titles: [
      'the keyword box filters, and clearing it restores',
      'the live indicator is a dot when connected and words when not',
      'no list control is left opening the operating system popup',
      'every list control can be reached by keyboard',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'shell-offline-cache',
    summary: 'The service worker, the offline shell, cache rules and the icons.',
    titles: [
      'the service worker registers and takes control',
      'the shell survives the hub going away entirely',
      'offline, the app says the network failed — not that you are signed out',
      'an API response is NEVER served from the cache',
      'a token in the URL is never written into the cache',
      'the worker asks the network first, so a fix is never stuck behind a cache',
      'the tab icon is a vector that actually decodes',
      'the header mark decodes too, and is the same file as the tab icon',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'squad-document-and-output',
    summary: 'A Squad document renders as text and long tool output stays reachable.',
    titles: [
      'a Squad document renders as TEXT, and its markup does nothing',
      'long tool output is reachable, and does not trap the scroll',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'session-detail-navigation',
    summary: 'Opening a session is a real navigation: Back, Forward, deep link, sidebar and the header pin.',
    titles: [
      'opening a session is a real navigation: the URL changes and Back restores the list',
      'Forward re-opens the same session after Back',
      'a cold load of a deep link opens that session directly, with no extra history entry',
      'the sidebar lists other sessions, filters by text, and clicking one navigates to it',
      'the header star pins the session, and the pin is reflected in the sidebar',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'a Squad document renders as TEXT, and its markup does nothing',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'prefs-sync',
    summary: 'Pins and renames sync to a second client and a remote unpin or clear is adopted.',
    titles: [
      'a pin set on one client is still there for a second client signed in as the same person (#170)',
      'an unpin made on a second client reaches a first client that still has it cached locally, instead of being resurrected by that stale cache (PR #236 cache-vs-edits review)',
      'a rename made on one client is still there after a reload, and for a second client (#170)',
      'a name CLEARED on a second client reaches a first client that still has it cached locally, instead of being resurrected by that stale cache (PR #236 cache-vs-edits review)',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'a Squad document renders as TEXT, and its markup does nothing',
      'opening a session is a real navigation: the URL changes and Back restores the list',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'row-menu-and-sync',
    summary: 'The row and header menus, rename pencil and the guarded Sync session action.',
    titles: [
      'the row ⋯ menu is fully keyboard-operable: Enter opens it, arrows move focus, Esc closes it (#170)',
      'the detail header rename pencil updates the header, the detail sidebar and the list row through one shared rename path (#181 part 2)',
      'the detail header ⋯ opens the shared row menu, not a second popup, and only adds Sync session conditionally (#181 part 2)',
      'a live-snapshot refresh arriving mid-verification does not leave "Checking control…" stuck forever (#243 Scout review fix for 53e6a18)',
      'Sync session guards one in-flight resync per target; a reopened menu shows it disabled until it resolves, with no extra request (#243 Scout review fix for 53e6a18)',
      'a real browser Back/Forward away from a session with its shared Sync menu open closes the stale menu, with no outside click and no resync for the wrong target (#243 Scout review of ab5ef90, PR comment 6091670737)',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'a Squad document renders as TEXT, and its markup does nothing',
      'opening a session is a real navigation: the URL changes and Back restores the list',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'detail-header-layout',
    summary: 'The session header geometry, retained filters and the cleanup actions at 1280, 900 and 390px.',
    titles: [
      'the header items share one vertical line box at 1280, 900 and 390px',
      'at 390px, the detail header title and right-side actions stay inside the viewport, unclipped and on one line (#243)',
      'the detail header menu survives overview refresh with focus intact, and Open does not duplicate history',
      'removing the open ended session returns to the list without stale detail controls',
      'an open detail session survives leaving the active list filter',
      'after the active filter drops an ended open session, its header ⋯ still opens and Copy link, Rename, Pin and Remove act on exactly that session (#181 review)',
      'a live detail session that leaves a search filter keeps a header ⋯ that can Open its pull request, Sync and Stop on its own device (#181 review)',
      'a retained header keeps one line box and an on-screen ⋯ menu at 1280, 900 and 390px, in dark and light (#181 review)',
      'at 390px, every first-row header control (back/star/title/pencil/pill) stays inside the viewport, unclipped and on one line',
      'at 390px, the detail header controls do not spatially overlap the metadata line underneath them',
      'at 390px, unreachable-session cleanup actions remain in bounds without overlapping metadata',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'a Squad document renders as TEXT, and its markup does nothing',
      'opening a session is a real navigation: the URL changes and Back restores the list',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'detail-header-fit',
    summary: 'The header fits every action and a long title, and the tab bar draws no scrollbar of its own.',
    titles: [
      'the session header fits Run on ACA…, Forget, Stop and More, a long title and the status pill at 1280, 900 and 390px, light and dark (#182)',
      'the tab bar draws no scrollbar of its own and keeps its whole underline when the browser shows classic scrollbars, at 1280, 900, 390 and 200px, light and dark (#182)',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'a Squad document renders as TEXT, and its markup does nothing',
      'opening a session is a real navigation: the URL changes and Back restores the list',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'detail-tabs-approval-card',
    summary: 'Detail tabs, the inline approval card answered for real, and the Info history.',
    titles: [
      'the session detail has Chat, Squad and Info tabs that each show only their own pane, and a disabled Files tab (#182)',
      'moving between tabs keeps a half-typed message and the transcript, because the composer sits outside every pane (#182)',
      'a pending request shows as an inline card on the Chat tab, and the pop-up and the bell still raise it (#182)',
      'the card survives tab switches and live refreshes without being rebuilt, and the Chat dot stays (#182)',
      'the tabs, the card and its buttons keep their sizes and stay inside the page at 1280, 900 and 390px (#182)',
      'the card waits for the hub: nothing goes while the answer is in flight, and a refused answer leaves the request answerable (#182)',
      'answering Allow once from the inline card ACTUALLY runs the tool, clears the card and lands in the Info history (#182)',
      'the Info tab, its history rows and the space above the composer stay aligned and inside the page at 1280, 900 and 390px (#182)',
      'the Squad tab shows the existing Squad panel, with its members and documents, above the composer (#182)',
      'a very long working directory wraps in the session header and in Info instead of pushing the page sideways at 1280, 900 and 390px (#182)',
      'the session header still fits, with the tabs, while a permission request waits, at 1280, 900 and 390px, light and dark (#182)',
      'denying from the inline card runs nothing, and the history records the denial (#182)',
      'a session opened from the sidebar starts on the Chat tab, not on the tab the previous session left open (#182)',
      'a request answered at the terminal, and one that expired, show in the history with who, what and where (#182)',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'a Squad document renders as TEXT, and its markup does nothing',
      'opening a session is a real navigation: the URL changes and Back restores the list',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'detail-capture-and-phone',
    summary: 'The session detail page at desktop and phone widths.',
    titles: [
      'the session detail page renders and is captured at desktop and phone widths, dark and light',
      'under 900px, the sidebar is hidden and the phone back arrow takes its place',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the UI mints a DEVICE token, not the user credential',
      'a device attaches with the minted token and appears in the UI',
      'a session started from the browser really runs on the device',
      'the running session is visible in the UI',
      'approving in the browser ACTUALLY runs the tool',
      'the approval card closes once it is answered',
      'a Squad document renders as TEXT, and its markup does nothing',
      'opening a session is a real navigation: the URL changes and Back restores the list',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'sign-out',
    summary: 'Signing out returns to a usable sign-in page.',
    titles: [
      'signing out returns to a usable sign-in page',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
  },
  {
    id: 'oauth-pages',
    summary: 'The OAuth completion and failure pages under the enforced CSP.',
    titles: [
      'the OAuth completion page stores the token and signs in, with the CSP enforced',
      'the OAuth failure page renders its message and its styled logo, with the CSP enforced',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'aca-dispatch-rail',
    summary: 'A dispatched ACA job: Queued row, Starting pulse, two dispatches, failures and attach matching.',
    titles: [
      'a dispatched ACA job shows a Queued-on-ACA row, follows its run to a confirmed execution, and drops out when that execution\'s device attaches (#178)',
      'a dispatched ACA job pulses a Starting dot in the rail, uncounted, until its own device replaces the row (#172, #178)',
      'two dispatches on one repository are two rail rows, and each job device removes only its own row (#172, #178)',
      'a failed or unknown ACA dispatch stops pulsing in the rail, says why, and Check again re-reads it (#172, #178)',
      'an unprovable dispatch is an unknown outcome in the rail, not a failure, and never pulses (#172, #178)',
      'two dispatches on the SAME repository attach only to their own jobs, never to a lookalike or each other (#178)',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'aca-dispatch-failures',
    summary: 'Dispatch failures: upstream error, failure after creating an issue, and an Existing issue.',
    titles: [
      'a dispatch that fails upstream shows the error and adds no pending row (#178)',
      'a dispatch that fails after creating an issue switches to Existing issue and retries on it without a second issue (#253 F4)',
      'a dispatch that fails on an Existing issue creates nothing and does not claim a creation (#253 F4)',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'aca-workflow-inputs',
    summary: 'Workflows that declare no, some or all dispatch inputs receive the dialog choices.',
    titles: [
      'a legacy workflow that declares neither option is dispatched from the untouched dialog, and an explicit unsupported choice is refused (#251 F3)',
      'a workflow declaring only publish_pr honors the Publish PR checkbox and the note speaks only of watch_only (#251 F3)',
      'a workflow that declares Publish PR and Watch-only receives the dialog\'s changed choices (#251 F3)',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'aca-dialog-selectors',
    summary: 'The ACA dialog dropdowns, branch and issue search, repository switching and the New session lists.',
    titles: [
      'Model and Reviewer are dropdowns of what the repository reports, at desktop and 390px, with no text box to type an override (#257)',
      'Base branch searches the repository past the first page and is chosen by keyboard, and unchosen text is never dispatched (#257)',
      'Enter during a new search cannot select an option from the previous query',
      'Existing issue is searched in the repository and chosen by number, not typed (#257)',
      'switching repository clears what belonged to the old one and a late reply for it cannot overwrite the new one (#257)',
      'loading, empty, default-only and error states are each said, and nothing is invented to fill them (#257)',
      'New session Agent and Model are closed lists of the selected device, and a device that reported none offers only the default (#257)',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'aca-attach-races',
    summary: 'Overlapping refreshes, stale overview replies and live-push attach never duplicate or lose a row.',
    titles: [
      'two overlapping refreshes while the job attaches never duplicate or lose a row (#178)',
      'a slow, older /api/overview reply can never put an attached job back to Queued on ACA (#178)',
      'a held overview GET cannot erase an ACA session attached through the live push (#178)',
      'the job\'s session replaces the pending row from the live push alone, with no refresh or poll (#178)',
      'a repository whose workflow cannot prove its run stays "Unknown outcome" and never guesses an aca- device (#178)',
      'a run that finishes without the job attaching shows Dispatch failed with its reason, and Check again follows a rerun (#178)',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'aca-fallbacks',
    summary: 'Existing issue survives the no-App fallback and the /squad-aca preview survives a denied clipboard.',
    titles: [
      'existing-issue mode survives the no-GitHub-App fallback, and opens that exact issue (#178)',
      'the /squad-aca command preview is visible and live, and survives a denied clipboard (#178)',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'aca-status-card',
    summary: 'The Squad on ACA card: Checking, Connected with zero devices, and real-shaped watcher and Ralph services.',
    titles: [
      'the status card runs through Checking, then settles on Connected (#180)',
      'the status card tells the truth about a real-shaped watcher and Ralph device (#180, #233)',
    ],
    alsoRuns: [
    ],
  },
  {
    id: 'review-ready-rows',
    summary: 'Ready for review rows, filters, deep links, health badges and detail page against a real device.',
    titles: [
      'a Ready for review fixture starts: a hub, a device, and sessions in every state that matters',
      'an ended session with a pull request reads "Ready for review": a violet 22px pill, a violet row, an Open PR link (#179)',
      '"ended" includes a run that failed, so a failed run with a pull request is ready for review too (#179)',
      'a session still going, one awaiting your reply, one with no pull request and one with an unusable one are NOT ready (#179)',
      'following Open PR opens the pull request in a new tab and does NOT open the session (#179)',
      'the Status filter offers "Ready for review" once a session is ready, and choosing it keeps exactly those sessions (#179)',
      'the review filter also holds against a live push, which the hub sends unfiltered (#179)',
      'the ready-for-review filter is a deep link, and the raw Done filter still lists a ready session, in the rows on screen (#179)',
      'a Squad session row shows "● healthy" or "● health: N failing", with the failing check ids in its tooltip (#179)',
      'the health badge is an indicator, not a pill or a button, and it reads red when failing and green when healthy (#179)',
      'the detail page shows the violet pill, the Open PR link and the per-check health list in the Squad panel (#179)',
      'the detail page follows the session live: health recovers, and a lost pull request takes the link away (#179)',
      'every sidebar row on the detail page carries the same pill as the list (#179)',
    ],
    alsoRuns: [
      'the Ready for review page ran without a console error or a CSP violation, the 409s all from the device it disconnected (#179)',
    ],
  },
  {
    id: 'review-layout',
    summary: 'The Ready for review states fit every width and theme, and are captured.',
    titles: [
      'at 1280, 900 and 390px, dark and light, the Ready for review row and detail page fit: nothing overflows, wraps, misaligns or loses contrast (#179)',
      'the session list fits every width from 390 to 1280px, and the filter bar wraps rather than pushing the page sideways (#179)',
      'the Ready for review states are captured at 1280, 900 and 390px, dark and light, when a folder is given (#179)',
    ],
    alsoRuns: [
      'a Ready for review fixture starts: a hub, a device, and sessions in every state that matters',
      'the Ready for review page ran without a console error or a CSP violation, the 409s all from the device it disconnected (#179)',
    ],
  },
  {
    id: 'review-priority',
    summary: 'Approval and unreachable device outrank Ready for review; a stale session keeps its actions.',
    titles: [
      'a pending approval outranks Ready for review: the row stays amber, reads "Needs approval" and offers no link (#179)',
      'an unreachable device outranks everything: its live session reads Unreachable, an ended one stays Ready for review (#179)',
      'a stale session shows every header action at once and still fits a phone, because the actions take their own line (#179)',
    ],
    alsoRuns: [
      'a Ready for review fixture starts: a hub, a device, and sessions in every state that matters',
      'the Ready for review page ran without a console error or a CSP violation, the 409s all from the device it disconnected (#179)',
    ],
  },
  {
    id: 'review-filters-live',
    summary: 'Keyword, status and device filters hold through live pushes and late answers.',
    titles: [
      'two more devices start, with sessions that say which filter each should survive (#179)',
      'a keyword filter keeps the list to the prompt, folder or id it matches, in any case, through a live push (#179)',
      'a keyword and a status together keep exactly the sessions with both, through a live push (#179)',
      'a device filter keeps one device, and the other still reads as empty, through a live push (#179)',
      'a filtered answer that lands after the live push cannot put the other sessions back (#179)',
      'a chosen Status stays on the control while no session qualifies for it, and leaves it once cleared (#179)',
      'clearing the keyword, the status and the device brings every session back (#179)',
    ],
    alsoRuns: [
      'a Ready for review fixture starts: a hub, a device, and sessions in every state that matters',
      'the Ready for review page ran without a console error or a CSP violation, the 409s all from the device it disconnected (#179)',
    ],
  },
  {
    id: 'review-console-clean',
    summary: 'The Ready for review page ran without a console error or a CSP violation.',
    titles: [
      'the Ready for review page ran without a console error or a CSP violation, the 409s all from the device it disconnected (#179)',
    ],
    alsoRuns: [
      'a Ready for review fixture starts: a hub, a device, and sessions in every state that matters',
    ],
  },
  {
    id: 'csp-enforced',
    summary: 'The enforced CSP saw no securitypolicyviolation event on the main page.',
    titles: [
      'the whole suite ran under the enforced CSP with zero securitypolicyviolation events',
    ],
    alsoRuns: [
      'the app loads and signs in with a token in the URL',
    ],
  },
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
deepFreeze(SCENARIOS);

/**
 * The one scenario in `scenarios` that owns the assertion titled `mustFail`.
 * Null when none does, or when more than one does: a title that cannot be
 * placed must not be guessed at.
 */
function scenarioForTestIn(scenarios, mustFail) {
  if (typeof mustFail !== 'string' || !mustFail) return null;
  const owners = scenarios.filter((s) => s.titles.includes(mustFail));
  return owners.length === 1 ? owners[0] : null;
}

/** The scenario of this suite that owns the assertion titled `mustFail`, or null. */
function scenarioForTest(mustFail) {
  return scenarioForTestIn(SCENARIOS, mustFail);
}
/** The scenario with this exact id, or null. */
function scenarioById(id) {
  if (typeof id !== 'string') return null;
  const found = SCENARIOS.filter((s) => s.id === id);
  return found.length === 1 ? found[0] : null;
}

/** Every title a run of `scenario` executes: owned first, then the ones it also runs. */
function titlesToRun(scenario) {
  return [...scenario.titles, ...scenario.alsoRuns.filter((t) => !scenario.titles.includes(t))];
}

/**
 * Read the scenario selector out of a child suite's arguments.
 *
 *   (none)                  { scenario: null }       the whole suite
 *   --scenario <id>         { scenario }             one journey
 *   --scenario=<id>         { scenario }
 *   --list-scenarios        { list: true }
 *   anything else           { error }                never a silent full run
 *
 * An unknown, empty, repeated or valueless selector is an error rather than
 * "run nothing" or "run everything": either would read as a pass.
 */
function parseSelection(argv = []) {
  let id = null;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value;
    if (arg === '--scenario') {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--scenario needs a scenario id' };
      i += 1;
    } else if (arg.startsWith('--scenario=')) {
      value = arg.slice('--scenario='.length);
    } else if (arg === '--list-scenarios') {
      list = true;
      continue;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
    if (!value) return { error: '--scenario needs a scenario id' };
    if (id !== null) return { error: `--scenario was given more than once (${id}, ${value})` };
    id = value;
  }
  if (list && id !== null) return { error: '--list-scenarios cannot be combined with --scenario' };
  if (list) return { list: true };
  if (id === null) return { scenario: null };
  const scenario = scenarioById(id);
  if (!scenario) return { error: `unknown scenario: ${id}. Known: ${SCENARIOS.map((s) => s.id).join(', ')}` };
  return { scenario };
}

module.exports = { SCENARIOS, scenarioForTest, scenarioForTestIn, scenarioById, titlesToRun, parseSelection };
