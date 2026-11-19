# Herdr live Windows walkthrough

November 10, 2026. Herdr Desktop 0.1.15 and connected Core 0.1.20, as shown in the native Settings window. This supplements the earlier static research and coverage inventory.

## Terminal lifecycle verified

| Test | Observed result |
| --- | --- |
| Create a fixture terminal | A new space and PowerShell pane ran in the disposable `ui-fixture` directory. The pane printed terminal ID `t2`, PID `65332`, and in-memory value `BFE-110`. |
| Observe | A second Herdr tab used the installed Core CLI to attach to `t2` in observe mode. It displayed the original history. Pressing a test key produced no input at the target prompt. |
| Detach | Ctrl+backslash returned to the second shell and printed `[detached from t2]`. |
| Reattach and send input | The second tab reattached in writable mode. A new command returned the same terminal ID, PID and in-memory value. |
| Test input ownership | The original Desktop pane accepted a command while the second viewer was still attached. The command output appeared in both views. The tested writable attach permits shared input. |
| Continue while the second viewer is detached | A 12-tick PowerShell job ran in `t2`. The writable viewer detached after tick 3. A fresh observer saw tick 5 and subsequent output. The original pane showed tick 12 and the returned prompt with the same PID. |
| Inspect status and jump to work | One synthetic blocked status reached the terminal header, tab, sidebar, status count, toast and Go to picker. Clicking the original sidebar row selected the correct tab. A nested attached terminal also reported the status, creating two Needs you rows from one fixture. The duplicate remained visible after detach until cleanup. |

In the split layout, nested attach and detach produced overlapping old terminal text and a stray visible escape fragment. Later tick lines and the completion prompt were readable. This was observed in the tested nested Windows setup. An independent external terminal client may behave differently.

## Native interface coverage

| Surface | Walkthrough |
| --- | --- |
| Welcome | Read the background-runtime introduction, machine setup, panel choices and final shortcut page. Skipped remote setup. Opened a local space. |
| Workspace | Created a space, opened a second tab with the keyboard, switched tabs, split a pane and closed the test shells. The sidebar picked up the fixture working directory as the space name. |
| Command palette and Go to | Opened the palette by keyboard and used it to reopen Welcome. Opened Go to, filtered by workspace name, and verified both tabs and their attention status were listed. |
| Files | Enabled the panel temporarily, opened the fixture README from the tree, and saw its line-numbered preview. |
| Changes | Opened a synthetic Git diff. Herdr showed one added file and two added lines, with a commit field at the bottom. |
| Settings | Inspected all five Windows categories. Look showed the built-in layouts, appearance, light/dark themes, zoom, and terminal and interface fonts. Machines showed the connected local Core and remote setup entry. Alerts showed the sound toggle and preview controls. Updates showed both versions. Privacy showed usage sharing enabled and a disclosure entry. |
| Accessibility exposure | Windows accessibility inspection returned the window frame and system buttons. Screenshot-based input was needed for the app's custom controls. The tested palette and dialog routes accepted keyboard shortcuts. This is limited UI Automation evidence, not a screen reader conformance result. |

The walkthrough used the installed Core CLI from a second Desktop tab for terminal attach and detach. Full app quit and restart, separate-machine SSH, mobile clients, third-party mods, update execution and destructive or account-changing commands were outside the run. The fixture shells exited, the Files and Changes choices returned to their prior state, and the app showed zero agents afterward.

## Flag Design decisions supported by the test

1. **Separate View and Take control.** Open the drawer in observation mode. If BFE promises exclusive input, enforce it with an ownership grant and display the current owner and a Release control action. Herdr's writable attach test showed shared input.
2. **Give Detach and Stop different controls.** Detach closes the view. Reattach restores the same terminal and clearly states whether the process is live, finished, or unavailable. Show a reconnect error with a retry path.
3. **Deduplicate Needs you by task or source terminal.** Viewer panes should link to the original attention item. Show which condition triggered it, when it was received, and whether it is still current.
4. **Make the inspector collapse independently.** Files and Changes each worked in the same region. With two terminals and an inspector open, the test window left narrow terminal columns. Give the task or terminal an easy route to reclaim width.
5. **Expose controls to keyboard and assistive technology.** Give the drawer and ownership controls accessible names and visible focus. Use text as well as color for connection and attention states.

The Flag Design mockup can use these observed behaviors and the proposed BFE ownership rules as separate requirements. This walkthrough did not change the mockup.
