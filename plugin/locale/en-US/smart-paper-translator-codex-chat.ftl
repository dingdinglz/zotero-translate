smart-paper-translator-codex-chat-pane-header =
    .label = Agents
smart-paper-translator-codex-chat-pane-sidenav =
    .tooltiptext = Agents
smart-paper-translator-codex-mermaid-rendering = Rendering Mermaid diagram…
smart-paper-translator-codex-mermaid-source = View Mermaid source
smart-paper-translator-codex-mermaid-error = Mermaid rendering failed. The source is preserved below.
smart-paper-translator-codex-mermaid-image =
    .alt = Mermaid diagram

smart-paper-translator-agents-selector = Agent
smart-paper-translator-agents-access = Access
smart-paper-translator-agents-approval = Approval mode
smart-paper-translator-agents-full = Full Access
smart-paper-translator-agents-full-hint = Full Access allows files outside the workspace and network access for this Codex session.
smart-paper-translator-agents-pi-access = Pi executes tools using its local configuration. Codex approval modes do not apply. Requests from Pi extensions still require a response.
smart-paper-translator-agents-pi-title = Local Pi (ACP)
smart-paper-translator-agents-pi-thinking = Thinking levels depend on the model. Supported models include max. Inspect Pi again after updating the plugin to refresh the options.
smart-paper-translator-agents-pi-setup = Uses local Pi authentication, models and extensions, with the shared Node / npx runtime above. Configure Pi in a terminal, then prepare pi-acp 0.0.33.
smart-paper-translator-agents-browse = Choose…
smart-paper-translator-agents-default-model = Default model for new sessions
smart-paper-translator-agents-default-thinking = Default thinking level for new sessions
smart-paper-translator-agents-detect = Detect local paths
smart-paper-translator-agents-inspect = Inspect again
smart-paper-translator-agents-pi-prepare = Prepare and inspect pi-acp 0.0.33
smart-paper-translator-agents-runtime = Local runtime
smart-paper-translator-agents-catalog = Model catalog
smart-paper-translator-agents-status = Status
smart-paper-translator-agents-pi-offline = Only Prepare can download pi-acp. Inspection creates an empty session without a prompt. Chat starts using prepared software and Pi offline startup settings. Requires Pi 0.85.1 or later.
smart-paper-translator-agents-inherit = Use current { $agent } value ({ $value })
smart-paper-translator-agents-options-unavailable = Prepare or inspect ACP to load options
smart-paper-translator-agents-ready = Ready
smart-paper-translator-agents-pi-needs-setup = Configure Pi and prepare the adapter
smart-paper-translator-agents-working = Inspecting…
smart-paper-translator-agents-not-prepared = { $adapter } { $version } is not prepared. Choose Prepare and inspect in plugin settings.
smart-paper-translator-agents-generating = { $agent } is generating…
smart-paper-translator-agents-connecting = Connecting to local { $agent }…
smart-paper-translator-agents-thinking = { $agent } is thinking…
smart-paper-translator-agents-model = Model
smart-paper-translator-agents-thinking-label = Thinking
smart-paper-translator-agents-input =
    .placeholder = Ask local { $agent } about this PDF…

smart-paper-translator-agents-overview = The Reader Agents sidebar uses local agent authentication and configuration, separately from the translation API. Opening a PDF or the sidebar does not start ACP, download dependencies, or request model output.

smart-paper-translator-agents-default-mode = Default mode

smart-paper-translator-agents-codex-mode-info = New Codex sessions use approval mode. Choose Full Access in Agents for the current session to allow files outside its workspace and network access.

smart-paper-translator-agents-privacy = Agents sends a PDF copy to the selected agent with the first prompt, then sends questions and explicitly attached selections or screenshots. Codex and Pi keep separate local histories and media. The plugin does not automatically modify Zotero items or import attachments. Full Access and Pi can access files outside the workspace and use the network; their dedicated workspaces are not sandboxes.

smart-paper-translator-agents-developer-checkbox =
    .label = Show Copy log in the Agents sidebar
smart-paper-translator-agents-settings-title = Agents (ACP)
smart-paper-translator-agents-shared-runtime = Shared runtime
smart-paper-translator-agents-shared-runtime-help = Codex and Pi use the Node and npx selected here. Configure each agent in its tab below. Pi requires Node 22.19.0 or later.
smart-paper-translator-agents-shared-detect = Refresh paths
smart-paper-translator-agents-shared-inspect = Check Node / npx
smart-paper-translator-agents-settings-tabs =
    .aria-label = Agent settings
smart-paper-translator-agents-codex-title = Local Codex (ACP)
smart-paper-translator-agents-codex-detect = Refresh paths
smart-paper-translator-agents-pi-detect = Refresh paths
smart-paper-translator-agents-runtime-unchecked = Not checked
smart-paper-translator-agents-shared-checked = Selected Node / npx checked. Check agent requirements in each tab.
smart-paper-translator-agents-shared-needs-inspect = Select or find paths, then check Node / npx.
smart-paper-translator-agents-path-candidates =
    .aria-label = { $name } path candidates
smart-paper-translator-agents-path-manual = Enter a path or browse…
smart-paper-translator-agents-path-help = Lists installations from PATH, NVM and standard locations. Choose a detected path, edit it, or browse for a file. Refreshing neither runs programs nor changes your selection.
smart-paper-translator-agents-paths-scanning = Finding local installations…
smart-paper-translator-agents-paths-found = Found { $count } path candidates. Current selections retained.
smart-paper-translator-agents-paths-empty = No installations found. Enter a path or browse for a file.
smart-paper-translator-agents-paths-error = Could not read path candidates. You can still enter a path or browse.
smart-paper-translator-agents-path-option =
    { $source ->
        [configured] Configured · { $path }
        [nvm] NVM { $version } · { $path }
        [path] PATH · { $path }
        [node] Selected Node · { $path }
       *[standard] Standard location · { $path }
    }
